//! `termic attach`: a real TTY on the CLI's terminal wired to a task's
//! agent PTY (or aux shell) through the control socket.
//!
//! Client half of the AttachFrame session (termic-proto): after the
//! server's `ready`, stdin runs raw and forwards keystrokes as `in`
//! frames (watching for the detach sequence), while this thread renders
//! `out` frames to stdout until the final Reply ends the session.
//! Non-resizing by default: the GUI pane owns the PTY size and resizing
//! under it is tmux's smallest-client problem; `--resize` opts in
//! (SIGWINCH on Unix, a 500ms poll on Windows -> `resize` frames). The
//! app quitting mid-attach is a socket EOF mapped to exit 8, never a
//! hang.
//!
//! Platform surface lives in `term` below: raw mode, tty detection,
//! terminal size, stdin reads and resize delivery. The session framing
//! is identical on both platforms.

use crate::client::Conn;
use crate::{CliError, Output};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use termic_proto as proto;
use termic_proto::exit_code;
use termic_proto::transport::Stream;

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

// ───────────────────────────── platform: term ────────────────────────

/// Raw mode + tty detection + terminal size + stdin reads + resize
/// delivery, per platform. Everything the session loop needs from the
/// local terminal, and nothing else.
#[cfg(unix)]
mod term {
    use super::*;

    /// Puts the controlling terminal into raw mode; Drop restores it, so
    /// every exit path (detach, EOF, error) leaves the shell usable.
    pub(super) struct RawGuard {
        fd: i32,
        saved: libc::termios,
    }

    impl RawGuard {
        pub(super) fn new() -> Result<Self, CliError> {
            let fd = 0;
            // SAFETY: termios is a plain C struct; tcgetattr fills it.
            let mut t = unsafe { std::mem::zeroed::<libc::termios>() };
            if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
                return Err(CliError::new(exit_code::ERROR, "attach needs a terminal on stdin"));
            }
            let saved = t;
            unsafe { libc::cfmakeraw(&mut t) };
            if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &t) } != 0 {
                return Err(CliError::new(
                    exit_code::ERROR,
                    "could not switch the terminal to raw mode",
                ));
            }
            Ok(RawGuard { fd, saved })
        }
    }

    impl Drop for RawGuard {
        fn drop(&mut self) {
            unsafe { libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved) };
        }
    }

    // ───────────────────────── SIGWINCH ──────────────────────────────

    static WINCH: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_winch(_: libc::c_int) {
        WINCH.store(true, Ordering::Relaxed);
    }

    /// Install the SIGWINCH handler WITHOUT SA_RESTART, so the stdin
    /// thread's blocking read returns EINTR and notices the flag promptly.
    pub(super) fn prime_resize() {
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
    pub(super) fn block_resize_here() {
        // SAFETY: standard pthread_sigmask block of one signal.
        unsafe {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGWINCH);
            libc::pthread_sigmask(libc::SIG_BLOCK, &mut set, std::ptr::null_mut());
        }
    }

    /// Consume a pending resize notification (stdin loop, each iteration).
    pub(super) fn resize_pending() -> bool {
        WINCH.swap(false, Ordering::Relaxed)
    }

    pub(super) fn is_interactive() -> bool {
        // SAFETY: isatty on the standard fds.
        unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 }
    }

    pub(super) fn win_size() -> Option<(u16, u16)> {
        // SAFETY: TIOCGWINSZ fills a winsize struct for a tty fd.
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_row > 0 {
            Some((ws.ws_row, ws.ws_col))
        } else {
            None
        }
    }

    /// Raw stdin read: >0 bytes, 0 EOF, negative on error (EINTR is
    /// reported as such by the caller's Interrupted check via
    /// last_os_error). Raw libc read so a SIGWINCH EINTR surfaces (std's
    /// helpers retry it silently and would sit on the flag until a
    /// keypress).
    pub(super) fn read_input(buf: &mut [u8]) -> isize {
        // SAFETY: reading into a stack buffer of the stated size.
        unsafe { libc::read(0, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) as isize }
    }
}

#[cfg(windows)]
mod term {
    use super::*;

    // Console FFI. Kept raw (windows-sys) to match termic-proto's
    // transport; only four calls: mode get/set on in+out, size query,
    // blocking stdin read.
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    use windows_sys::Win32::System::Console::{
        GetConsoleMode, GetConsoleScreenBufferInfo, GetStdHandle, SetConsoleMode,
        CONSOLE_SCREEN_BUFFER_INFO, ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT,
        ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT,
        STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    fn std_handle(which: u32) -> Option<HANDLE> {
        // SAFETY: GetStdHandle returns the process's standard handle or
        // NULL when none; both are handled.
        let h = unsafe { GetStdHandle(which) };
        if h.is_null() || h == -1isize as HANDLE {
            None
        } else {
            Some(h)
        }
    }

    /// Puts the terminal into raw mode; Drop restores it, so every exit
    /// path (detach, EOF, error) leaves the shell usable.
    ///
    /// Input: drop line/echo/processed/window input (no line editing, no
    /// echo, no Ctrl+C interception, resize comes from the poller), keep
    /// VT input so arrows/functional keys arrive as the same escape
    /// sequences the Unix pty would deliver. Output: request VT
    /// processing so the pty's escape stream renders (Windows Terminal
    /// usually has it on already; the legacy conhost does not).
    pub(super) struct RawGuard {
        h_in: HANDLE,
        saved_in: u32,
        h_out: HANDLE,
        saved_out: u32,
    }

    impl RawGuard {
        pub(super) fn new() -> Result<Self, CliError> {
            let Some(h_in) = std_handle(STD_INPUT_HANDLE) else {
                return Err(CliError::new(exit_code::ERROR, "attach needs a terminal on stdin"));
            };
            let Some(h_out) = std_handle(STD_OUTPUT_HANDLE) else {
                return Err(CliError::new(exit_code::ERROR, "attach needs a terminal on stdout"));
            };
            // SAFETY: live console handles; out-params are plain u32s.
            let (mut saved_in, mut saved_out) = (0u32, 0u32);
            unsafe {
                if GetConsoleMode(h_in, &mut saved_in) == 0 || GetConsoleMode(h_out, &mut saved_out) == 0 {
                    return Err(CliError::new(
                        exit_code::ERROR,
                        "attach needs a terminal on stdin and stdout",
                    ));
                }
                let raw_in = (saved_in
                    & !(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT | ENABLE_WINDOW_INPUT))
                    | ENABLE_VIRTUAL_TERMINAL_INPUT;
                let raw_out = saved_out | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
                if SetConsoleMode(h_in, raw_in) == 0 || SetConsoleMode(h_out, raw_out) == 0 {
                    return Err(CliError::new(
                        exit_code::ERROR,
                        "could not switch the terminal to raw mode",
                    ));
                }
            }
            Ok(RawGuard { h_in, saved_in, h_out, saved_out })
        }
    }

    impl Drop for RawGuard {
        fn drop(&mut self) {
            // SAFETY: the same live handles, restoring the saved modes.
            unsafe {
                SetConsoleMode(self.h_in, self.saved_in);
                SetConsoleMode(self.h_out, self.saved_out);
            }
        }
    }

    /// No resize signal exists on Windows; `prime_resize` on this
    /// platform spawns a poller that posts the frames itself, so there is
    /// nothing to install or block here. Kept for interface parity with
    /// the Unix module; never called.
    #[allow(dead_code)]
    pub(super) fn prime_resize() {}
    pub(super) fn block_resize_here() {}

    /// The poller owns resize delivery: no in-loop flag to consume.
    pub(super) fn resize_pending() -> bool {
        false
    }

    pub(super) fn is_interactive() -> bool {
        // SAFETY: mode queries on live standard handles; a non-console
        // handle (pipe/file) fails the query.
        unsafe {
            match (std_handle(STD_INPUT_HANDLE), std_handle(STD_OUTPUT_HANDLE)) {
                (Some(i), Some(o)) => {
                    let mut mode = 0u32;
                    GetConsoleMode(i, &mut mode) != 0 && GetConsoleMode(o, &mut mode) != 0
                }
                _ => false,
            }
        }
    }

    pub(super) fn win_size() -> Option<(u16, u16)> {
        let h_out = std_handle(STD_OUTPUT_HANDLE)?;
        // SAFETY: live console handle; the struct is a plain C record.
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        if unsafe { GetConsoleScreenBufferInfo(h_out, &mut info) } == 0 {
            return None;
        }
        let w = info.srWindow;
        let (cols, rows) = ((w.Right - w.Left + 1) as u16, (w.Bottom - w.Top + 1) as u16);
        (rows > 0).then_some((rows, cols))
    }

    /// Spawn the resize poller: posts a `resize` frame on every visible
    /// window size change (SIGWINCH's stand-in). Owns a writer clone; the
    /// frame write failing (app gone) ends the poller quietly.
    pub(super) fn spawn_resize_poller(writer: &Arc<Mutex<Stream>>) {
        let writer = writer.clone();
        std::thread::spawn(move || {
            let mut last: Option<(u16, u16)> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Some(size) = win_size() {
                    if last != Some(size) {
                        last = Some(size);
                        if write_frame(&writer, &proto::AttachFrame::resize(size.0, size.1)).is_err()
                        {
                            return;
                        }
                    }
                }
            }
        });
    }

    /// Raw stdin read: >0 bytes, 0 EOF, -1 error. A blocking console
    /// ReadFile returns as keys arrive in VT input mode; errors mean the
    /// console is gone, which the caller treats as EOF.
    pub(super) fn read_input(buf: &mut [u8]) -> isize {
        let Some(h_in) = std_handle(STD_INPUT_HANDLE) else { return -1 };
        let mut n: u32 = 0;
        // SAFETY: reading into a stack buffer of the stated size; the
        // bytes-written out-param is filled before the call returns.
        let ok = unsafe { ReadFile(h_in, buf.as_mut_ptr(), buf.len().min(u32::MAX as usize) as u32, &mut n, std::ptr::null_mut()) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            // A cancelled or broken console reads as EOF, not an error:
            // the session must not spin on a dead stdin.
            let _ = err;
            return if n > 0 { n as isize } else { 0 };
        }
        n as isize
    }
}

// ───────────────────────────── session ───────────────────────────────

fn write_frame(writer: &Arc<Mutex<Stream>>, frame: &proto::AttachFrame) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap_or_else(|p| p.into_inner());
    proto::write_msg(&mut *w, frame)
}

/// stdin -> socket: raw keystrokes as `in` frames, the detach sequence
/// ends the session, resize notifications (SIGWINCH / the Windows
/// poller) become `resize` frames.
///
/// Exit discipline: this thread must NEVER die silently, or the socket
/// loop blocks on a session nobody can end (raw mode with dead detach
/// keys). A clean detach flags `detach_sent` and puts a deadline on the
/// socket read so the final Reply cannot hang the exit; every other
/// exit (stdin EOF, a write failure from a stalled server) shuts the
/// socket down so the reader unblocks into "connection lost".
fn stdin_loop(
    writer: Arc<Mutex<Stream>>,
    detach_seq: Vec<u8>,
    resize: bool,
    detach_sent: Arc<AtomicBool>,
) {
    let mut matcher = DetachMatcher::new(detach_seq);
    let mut buf = [0u8; 4096];
    let mut clean_detach = false;
    loop {
        if resize && term::resize_pending() {
            if let Some((rows, cols)) = term::win_size() {
                let _ = write_frame(&writer, &proto::AttachFrame::resize(rows, cols));
            }
        }
        let n = term::read_input(&mut buf);
        if n == 0 {
            break; // stdin EOF (terminal gone)
        }
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue; // EINTR: recheck the WINCH flag
            }
            break;
        }
        let mut forward: Vec<u8> = Vec::new();
        let mut detach = false;
        for &b in &buf[..n as usize] {
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
        let _ = stream.shutdown();
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
    if !term::is_interactive() {
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
    let raw = term::RawGuard::new()?;
    if resize {
        #[cfg(unix)]
        term::prime_resize();
        #[cfg(windows)]
        term::spawn_resize_poller(&writer);
        if let Some((rows, cols)) = term::win_size() {
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
    // not here. Windows has no signal to block; the poller thread owns
    // resize delivery entirely.
    term::block_resize_here();

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
        assert_eq!(m.feed(16), (vec![], false));
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
