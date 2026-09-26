//! `termic attach`: a real TTY on the CLI's terminal wired to a task's
//! agent PTY (or aux shell) through the control socket.
//!
//! Client half of the AttachFrame session (termic-proto): after the
//! server's `ready`, stdin runs raw and forwards keystrokes as `in`
//! frames (watching for the detach sequence), while this thread renders
//! `out` frames to stdout until the final Reply ends the session.
//! Non-resizing by default: the GUI pane owns the PTY size and resizing
//! under it is tmux's smallest-client problem; `--resize` opts in
//! (SIGWINCH -> `resize` frames). The app quitting mid-attach is a
//! socket EOF mapped to exit 8, never a hang.

use crate::client::Conn;
use crate::{CliError, Output};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use termic_proto as proto;
use termic_proto::exit_code;

// ───────────────────────────── detach keys ───────────────────────────

/// Parse a Docker-grammar detach sequence ("ctrl-\\", "ctrl-p,ctrl-q",
/// plain single characters) into the byte sequence to watch for.
pub fn parse_detach_keys(s: &str) -> Result<Vec<u8>, CliError> {
    let bad = || {
        CliError::new(
            exit_code::ERROR,
            format!("invalid --detach-keys \"{s}\" (use e.g. ctrl-\\ or ctrl-p,ctrl-q)"),
        )
    };
    let mut out = Vec::new();
    for tok in s.split(',') {
        let tok = tok.trim();
        if let Some(k) = tok.strip_prefix("ctrl-") {
            let mut chars = k.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return Err(bad()) };
            out.push(match c {
                'a'..='z' => c as u8 - b'a' + 1,
                '@' => 0,
                '[' => 27,
                '\\' => 28,
                ']' => 29,
                '^' => 30,
                '_' => 31,
                _ => return Err(bad()),
            });
        } else {
            let mut chars = tok.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return Err(bad()) };
            if !c.is_ascii() || c.is_ascii_control() {
                return Err(bad());
            }
            out.push(c as u8);
        }
    }
    if out.is_empty() {
        return Err(bad());
    }
    Ok(out)
}

/// Incremental detach-sequence matcher. Bytes are WITHHELD while they
/// extend a partial match and flushed on a mismatch (Docker's behavior:
/// pressing the first key of a multi-key sequence must not leak it to
/// the agent until the next key decides).
pub struct DetachMatcher {
    seq: Vec<u8>,
    matched: usize,
}

impl DetachMatcher {
    pub fn new(seq: Vec<u8>) -> Self {
        DetachMatcher { seq, matched: 0 }
    }

    /// Feed one byte: (bytes to forward now, sequence completed?).
    pub fn feed(&mut self, b: u8) -> (Vec<u8>, bool) {
        if b == self.seq[self.matched] {
            self.matched += 1;
            if self.matched == self.seq.len() {
                self.matched = 0;
                return (Vec::new(), true);
            }
            return (Vec::new(), false);
        }
        // Mismatch: the withheld prefix plus this byte may END with a
        // shorter run-up of the sequence (KMP-style fallback; a naive
        // restart misses e.g. ctrl-p,ctrl-p,ctrl-q fed p p p q). Keep
        // the longest such suffix withheld, flush everything before it.
        let mut held: Vec<u8> = self.seq[..self.matched].to_vec();
        held.push(b);
        let keep = (0..held.len())
            .map(|start| held.len() - start)
            .find(|&len| held[held.len() - len..] == self.seq[..len])
            .unwrap_or(0);
        self.matched = keep;
        (held[..held.len() - keep].to_vec(), false)
    }
}

// ───────────────────────── terminal plumbing ─────────────────────────

/// Unix: termios raw mode, SIGWINCH for resize, a raw `read(0)` so the
/// EINTR a SIGWINCH causes surfaces instead of being retried away.
#[cfg(unix)]
mod sys {
    use super::*;

    /// Puts the controlling terminal into raw mode; Drop restores it, so
    /// every exit path (detach, EOF, error) leaves the shell usable.
    pub struct RawGuard {
        fd: i32,
        saved: libc::termios,
    }

    impl RawGuard {
        pub fn new() -> Result<Self, CliError> {
            let fd = 0;
            // SAFETY: termios is a plain C struct; tcgetattr fills it.
            let mut t = unsafe { std::mem::zeroed::<libc::termios>() };
            if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
                return Err(CliError::new(exit_code::ERROR, "attach needs a terminal on stdin"));
            }
            let saved = t;
            unsafe { libc::cfmakeraw(&mut t) };
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &t) } != 0 {
                return Err(CliError::new(exit_code::ERROR, "could not switch the terminal to raw mode"));
            }
            Ok(RawGuard { fd, saved })
        }
    }

    impl Drop for RawGuard {
        fn drop(&mut self) {
            unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved) };
        }
    }

    pub static WINCH: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_winch(_: libc::c_int) {
        WINCH.store(true, Ordering::Relaxed);
    }

    /// Install the SIGWINCH handler WITHOUT SA_RESTART, so the stdin
    /// thread's blocking read returns EINTR and notices the flag promptly.
    pub fn install_resize(_writer: &Arc<Mutex<proto::local::Stream>>) {
        // SAFETY: standard sigaction setup; the handler only stores a flag.
        unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_winch as *const () as usize;
            libc::sigemptyset(&mut sa.sa_mask);
            sa.sa_flags = 0;
            libc::sigaction(libc::SIGWINCH, &sa, std::ptr::null_mut());
        }
    }

    /// Block SIGWINCH on the CALLING thread. Run on the socket-read thread
    /// after the stdin thread spawns, so delivery lands where the EINTR is
    /// useful (the stdin read loop).
    pub fn block_resize_here() {
        // SAFETY: standard pthread_sigmask block of one signal.
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGWINCH);
            libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        }
    }

    /// Called by the stdin loop before each read: a pending SIGWINCH
    /// becomes a `resize` frame.
    pub fn poll_resize(writer: &Arc<Mutex<proto::local::Stream>>) {
        if WINCH.swap(false, Ordering::Relaxed) {
            if let Some((rows, cols)) = win_size() {
                let _ = write_frame(writer, &proto::AttachFrame::resize(rows, cols));
            }
        }
    }

    pub fn win_size() -> Option<(u16, u16)> {
        // SAFETY: TIOCGWINSZ fills a winsize struct for a tty fd.
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_row > 0 {
            Some((ws.ws_row, ws.ws_col))
        } else {
            None
        }
    }

    pub enum Read {
        Data(usize),
        Eof,
        Interrupted,
        Failed,
    }

    pub fn read_stdin(buf: &mut [u8]) -> Read {
        // Raw libc read so a SIGWINCH EINTR surfaces (std's helpers
        // retry it silently and would sit on the flag until a keypress).
        // SAFETY: reading into a buffer of the stated size.
        let n = unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n == 0 {
            Read::Eof
        } else if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                Read::Interrupted
            } else {
                Read::Failed
            }
        } else {
            Read::Data(n as usize)
        }
    }
}

/// Windows: console modes instead of termios. VT input mode makes the
/// console hand us the same escape sequences a unix tty would, with
/// processed input off so Ctrl+C arrives as 0x03 for the agent. There
/// is no SIGWINCH, so under --resize a small thread polls the window
/// size and sends a `resize` frame when it changes.
#[cfg(windows)]
mod sys {
    use super::*;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::Console::{
        GetConsoleCP, GetConsoleMode, GetConsoleOutputCP, GetConsoleScreenBufferInfo, GetStdHandle,
        SetConsoleCP, SetConsoleMode, SetConsoleOutputCP, CONSOLE_MODE, CONSOLE_SCREEN_BUFFER_INFO,
        DISABLE_NEWLINE_AUTO_RETURN, ENABLE_ECHO_INPUT, ENABLE_EXTENDED_FLAGS, ENABLE_LINE_INPUT,
        ENABLE_PROCESSED_INPUT, ENABLE_QUICK_EDIT_MODE, ENABLE_VIRTUAL_TERMINAL_INPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    pub struct RawGuard {
        input: HANDLE,
        output: HANDLE,
        in_mode: CONSOLE_MODE,
        out_mode: CONSOLE_MODE,
        in_cp: u32,
        out_cp: u32,
    }

    impl RawGuard {
        pub fn new() -> Result<Self, CliError> {
            // SAFETY: plain console API calls on the process's std handles.
            unsafe {
                let input = GetStdHandle(STD_INPUT_HANDLE);
                let output = GetStdHandle(STD_OUTPUT_HANDLE);
                let mut in_mode: CONSOLE_MODE = 0;
                let mut out_mode: CONSOLE_MODE = 0;
                if GetConsoleMode(input, &mut in_mode) == 0 || GetConsoleMode(output, &mut out_mode) == 0 {
                    return Err(CliError::new(exit_code::ERROR, "attach needs a console on stdin and stdout"));
                }
                let guard = RawGuard {
                    input,
                    output,
                    in_mode,
                    out_mode,
                    in_cp: GetConsoleCP(),
                    out_cp: GetConsoleOutputCP(),
                };
                let raw_in = (in_mode
                    & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_QUICK_EDIT_MODE))
                    | ENABLE_VIRTUAL_TERMINAL_INPUT
                    | ENABLE_EXTENDED_FLAGS;
                let raw_out = out_mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN;
                if SetConsoleMode(input, raw_in) == 0 || SetConsoleMode(output, raw_out) == 0 {
                    return Err(CliError::new(
                        exit_code::ERROR,
                        "could not switch the console to raw mode (needs Windows 10 1809 or newer)",
                    ));
                }
                SetConsoleCP(65001);
                SetConsoleOutputCP(65001);
                Ok(guard)
            }
        }
    }

    impl Drop for RawGuard {
        fn drop(&mut self) {
            // SAFETY: restoring the modes and code pages saved in new().
            unsafe {
                SetConsoleMode(self.input, self.in_mode);
                SetConsoleMode(self.output, self.out_mode);
                SetConsoleCP(self.in_cp);
                SetConsoleOutputCP(self.out_cp);
            }
        }
    }

    pub fn win_size() -> Option<(u16, u16)> {
        // SAFETY: fills a plain struct for the stdout console handle.
        unsafe {
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
            if GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) == 0 {
                return None;
            }
            // The visible window, not the scrollback buffer.
            let rows = (info.srWindow.Bottom - info.srWindow.Top + 1).max(0) as u16;
            let cols = (info.srWindow.Right - info.srWindow.Left + 1).max(0) as u16;
            (rows > 0 && cols > 0).then_some((rows, cols))
        }
    }

    /// Poll the window size every 250ms and forward changes. Exits when
    /// a write fails (the session is over).
    pub fn install_resize(writer: &Arc<Mutex<proto::local::Stream>>) {
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut last = win_size();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let now = win_size();
                if now != last {
                    last = now;
                    if let Some((rows, cols)) = now {
                        if write_frame(&writer, &proto::AttachFrame::resize(rows, cols)).is_err() {
                            return;
                        }
                    }
                }
            }
        });
    }

    pub fn block_resize_here() {}

    pub fn poll_resize(_writer: &Arc<Mutex<proto::local::Stream>>) {}

    pub enum Read {
        Data(usize),
        Eof,
        #[allow(dead_code)]
        Interrupted,
        Failed,
    }

    pub fn read_stdin(buf: &mut [u8]) -> Read {
        use std::io::Read as _;
        match std::io::stdin().lock().read(buf) {
            Ok(0) => Read::Eof,
            Ok(n) => Read::Data(n),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => Read::Interrupted,
            Err(_) => Read::Failed,
        }
    }
}

// ───────────────────────────── session ───────────────────────────────

fn write_frame(writer: &Arc<Mutex<proto::local::Stream>>, frame: &proto::AttachFrame) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap_or_else(|p| p.into_inner());
    proto::write_msg(&mut *w, frame)
}

/// stdin -> socket: raw keystrokes as `in` frames, the detach sequence
/// ends the session, SIGWINCH (under --resize) becomes `resize` frames.
///
/// Exit discipline: this thread must NEVER die silently, or the socket
/// loop blocks on a session nobody can end (raw mode with dead detach
/// keys). A clean detach flags `detach_sent` and puts a deadline on the
/// socket read so the final Reply cannot hang the exit; every other
/// exit (stdin EOF, a write failure from a stalled server) shuts the
/// socket down so the reader unblocks into "connection lost".
fn stdin_loop(
    writer: Arc<Mutex<proto::local::Stream>>,
    detach_seq: Vec<u8>,
    resize: bool,
    detach_sent: Arc<AtomicBool>,
) {
    let mut matcher = DetachMatcher::new(detach_seq);
    let mut buf = [0u8; 4096];
    let mut clean_detach = false;
    loop {
        if resize {
            sys::poll_resize(&writer);
        }
        let n = match sys::read_stdin(&mut buf) {
            sys::Read::Data(n) => n,
            sys::Read::Eof => break, // stdin EOF (terminal gone)
            sys::Read::Interrupted => continue, // EINTR: recheck the resize flag
            sys::Read::Failed => break,
        };
        let mut forward: Vec<u8> = Vec::new();
        let mut detach = false;
        for &b in &buf[..n] {
            let (flush, done) = matcher.feed(b);
            forward.extend(flush);
            if done {
                detach = true;
                break;
            }
        }
        if !forward.is_empty()
            && write_frame(&writer, &proto::AttachFrame::input(&forward)).is_err()
        {
            break;
        }
        if detach {
            detach_sent.store(true, Ordering::Release);
            let _ = write_frame(&writer, &proto::AttachFrame::detach("detached"));
            clean_detach = true;
            break;
        }
    }
    let stream = writer.lock().unwrap_or_else(|p| p.into_inner());
    if clean_detach {
        // Give the server's final Reply a deadline instead of trusting
        // it forever; the socket loop maps a timeout after a sent
        // detach to a clean exit.
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    } else {
        // Abnormal end: unblock the socket loop NOW (its read has no
        // timeout) so the session cannot outlive its keyboard.
        detach_sent.store(false, Ordering::Release);
        let _ = stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Run the attach session on an already-authenticated connection. Takes
/// the connection over entirely; returns the exit outcome.
pub fn run_attach(
    mut conn: Conn,
    token: &str,
    cmd: proto::Command,
    detach_seq: Vec<u8>,
    detach_hint: &str,
    resize: bool,
) -> Result<Output, CliError> {
    use std::io::IsTerminal as _;
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err(CliError::new(
            exit_code::ERROR,
            "attach needs a terminal on stdin and stdout (it is interactive; use logs for output)",
        ));
    }
    conn.send_request(cmd, token)?;
    // Await acceptance: the ready frame, or an ordinary error Reply.
    loop {
        let line = match proto::read_line(conn.reader_mut()) {
            Ok(Some(l)) => l,
            _ => {
                return Err(CliError::new(
                    exit_code::CONNECTION_LOST,
                    "connection to Termic lost before the attach started",
                ));
            }
        };
        match proto::parse_attach_line(&line) {
            Ok(proto::AttachLine::Frame(f)) if f.kind == "ready" => break,
            Ok(proto::AttachLine::Frame(_)) => {}
            Ok(proto::AttachLine::Done(reply)) => {
                let err = reply
                    .error
                    .map(|e| CliError::new(e.code.exit_code(), e.message))
                    .unwrap_or_else(|| {
                        CliError::new(exit_code::ERROR, "unexpected reply to attach")
                    });
                return Err(err);
            }
            Err(e) => {
                return Err(CliError::new(
                    exit_code::CONNECTION_LOST,
                    format!("garbled attach stream ({e})"),
                ));
            }
        }
    }
    // The hint prints while the terminal is still cooked (docker/tmux
    // convention: say how to get out BEFORE taking the keyboard).
    eprintln!("termic: attached; detach with {detach_hint} (the task keeps running)");

    conn.clear_read_timeout();
    let (mut reader, writer) = conn.into_split();
    let writer = Arc::new(Mutex::new(writer));
    let raw = sys::RawGuard::new()?;
    if resize {
        sys::install_resize(&writer);
        if let Some((rows, cols)) = sys::win_size() {
            let _ = write_frame(&writer, &proto::AttachFrame::resize(rows, cols));
        }
    }
    let detach_sent = Arc::new(AtomicBool::new(false));
    {
        let writer = writer.clone();
        let detach_sent = detach_sent.clone();
        std::thread::spawn(move || stdin_loop(writer, detach_seq, resize, detach_sent));
    }
    // Deliver SIGWINCH to the stdin thread (where the EINTR matters),
    // not here.
    sys::block_resize_here();

    let (code, message) = loop {
        match proto::read_line(&mut reader) {
            Ok(Some(line)) => match proto::parse_attach_line(&line) {
                // Anything else (the in-band detach frame, unknown
                // kinds) is skipped: the final Reply carries the reason.
                Ok(proto::AttachLine::Frame(f)) => {
                    if f.kind == "out" {
                        if let Some(bytes) = f.data_bytes() {
                            let mut out = std::io::stdout();
                            let _ = out.write_all(&bytes);
                            let _ = out.flush();
                        }
                    }
                }
                Ok(proto::AttachLine::Done(reply)) => {
                    if let Some(err) = reply.error {
                        break (err.code.exit_code(), err.message);
                    }
                    let reason = match reply.data {
                        Some(proto::ReplyData::Attach(a)) => a.reason,
                        _ => "detached".into(),
                    };
                    break match reason.as_str() {
                        "detached" => {
                            (exit_code::OK, "detached (the task keeps running in Termic)".into())
                        }
                        "archived" => (exit_code::ATTACH_CLOSED, "the task was archived".into()),
                        "closed" => (exit_code::ATTACH_CLOSED, "this tab was closed".into()),
                        "lagged" => (
                            exit_code::ATTACH_CLOSED,
                            "this session fell too far behind the output stream and was disconnected; reattach for the live screen".into(),
                        ),
                        _ => (exit_code::ATTACH_CLOSED, "the agent terminal closed".into()),
                    };
                }
                Err(_) => {} // garbled line mid-session: skip it
            },
            // EOF or a read error. After a SENT detach this is just the
            // final Reply missing its 5s deadline (or the server closing
            // first): the user asked to leave, honor it as a clean
            // detach. Anywhere else it is the app quitting under us
            // (exit 8, the reserved code; never a hang).
            _ if detach_sent.load(Ordering::Acquire) => {
                break (exit_code::OK, "detached (the task keeps running in Termic)".into());
            }
            _ => break (exit_code::CONNECTION_LOST, "connection to Termic lost".into()),
        }
    };
    // Restore the terminal BEFORE printing the outcome, and start a
    // fresh line: raw mode leaves the cursor wherever the TUI put it.
    drop(raw);
    eprintln!();
    eprintln!("termic: {message}");
    Ok(Output { stdout: String::new(), code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detach_keys_grammar() {
        assert_eq!(parse_detach_keys("ctrl-\\").unwrap(), vec![28]);
        assert_eq!(parse_detach_keys("ctrl-p,ctrl-q").unwrap(), vec![16, 17]);
        assert_eq!(parse_detach_keys("ctrl-a").unwrap(), vec![1]);
        assert_eq!(parse_detach_keys("ctrl-[").unwrap(), vec![27]);
        assert_eq!(parse_detach_keys("q").unwrap(), vec![b'q']);
        assert_eq!(parse_detach_keys("a,b").unwrap(), vec![b'a', b'b']);
        for bad in ["", " ", "ctrl-", "ctrl-aa", "ctrl-1", "ab", "\u{9}", "é"] {
            assert!(parse_detach_keys(bad).is_err(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn detach_matcher_single_key() {
        let mut m = DetachMatcher::new(vec![28]);
        assert_eq!(m.feed(b'a'), (vec![b'a'], false));
        assert_eq!(m.feed(28), (vec![], true));
        // Reusable after a match.
        assert_eq!(m.feed(b'x'), (vec![b'x'], false));
        assert_eq!(m.feed(28), (vec![], true));
    }

    #[test]
    fn detach_matcher_withholds_partial_matches() {
        let mut m = DetachMatcher::new(vec![16, 17]); // ctrl-p,ctrl-q
        // First key withheld until the next byte decides.
        assert_eq!(m.feed(16), (vec![], false));
        assert_eq!(m.feed(17), (vec![], true));
        // Mismatch flushes the withheld prefix plus the new byte.
        assert_eq!(m.feed(16), (vec![], false));
        assert_eq!(m.feed(b'x'), (vec![16, b'x'], false));
        // A mismatch that itself restarts the sequence keeps matching.
        assert_eq!(m.feed(16), (vec![], false));
        assert_eq!(m.feed(16), (vec![16], false));
        assert_eq!(m.feed(17), (vec![], true));
    }

    #[test]
    fn detach_matcher_handles_self_overlapping_sequences() {
        // ctrl-p,ctrl-p,ctrl-q typed as p p p q: the third p must fall
        // back to a TWO-byte run-up (naive restart resumes at one and
        // misses the detach entirely).
        let mut m = DetachMatcher::new(vec![16, 16, 17]);
        assert_eq!(m.feed(16), (vec![], false));
        assert_eq!(m.feed(16), (vec![], false));
        assert_eq!(m.feed(16), (vec![16], false));
        assert_eq!(m.feed(17), (vec![], true));
        // a,b,a,b,c typed as a b a b a b c: overlap of length 3.
        let mut m = DetachMatcher::new(vec![b'a', b'b', b'a', b'b', b'c']);
        for b in *b"abab" {
            assert_eq!(m.feed(b), (vec![], false));
        }
        assert_eq!(m.feed(b'a'), (vec![b'a', b'b'], false));
        assert_eq!(m.feed(b'b'), (vec![], false));
        assert_eq!(m.feed(b'c'), (vec![], true));
    }
}
