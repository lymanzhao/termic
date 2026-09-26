//! Windows: the file agent hooks write their OSC reports to.
//!
//! On unix a hook reports agent state by writing an OSC sequence to the PTY
//! slave, `$TERMIC_PTY` (`pty_slave_path`), and the bytes arrive in the
//! terminal's output like anything the agent prints. ConPTY has no slave
//! device, and neither of the console routes works from a hook: `CONOUT$`
//! needs a console the agent may not give it (`windowsHide`), and Git Bash's
//! `/dev/tty` does not exist in a spawned hook (both measured,
//! docs/ideas/windows.md, M1).
//!
//! So on Windows `$TERMIC_PTY` names a named pipe the app serves, one per
//! PTY, and whatever a hook writes into it is fed into that PTY's output
//! stream, exactly where the reader thread puts the agent's own bytes.
//!
//! The scripts cannot write to it directly: Git Bash's `>` cannot open a
//! named pipe, and Node's append mode is refused by one (measured, same
//! probe). So on Windows their final write goes through the bundled CLI,
//! `printf ... | "$TERMIC_CLI" hook-emit "$TERMIC_PTY"` (agent_hooks.rs,
//! `bound_emits`), which opens the pipe for writing the ordinary way.
//!
//! This grants nothing new, as on unix: the agent can already write anything
//! to its own terminal. The pipe's name is unguessable, remote clients are
//! refused, and the default pipe DACL lets only this user (and SYSTEM /
//! Administrators) write, so another account cannot inject into a pane.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_INBOUND,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

/// One hook report is a few OSC sequences. Anything past this from a single
/// connection is not a hook, and is dropped rather than buffered.
const MAX_REPORT: usize = 64 * 1024;

/// A PTY's hook pipe, created BEFORE the agent is spawned, so a hook that
/// fires at startup (claude's SessionStart) finds it listening.
pub struct HookPipe {
    name: String,
    first: HANDLE,
}

// SAFETY: a pipe HANDLE is a kernel handle, usable from any thread.
unsafe impl Send for HookPipe {}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn new_instance(name: &str, first: bool) -> HANDLE {
    let path = wide(&format!(r"\\.\pipe\{name}"));
    let mode = PIPE_ACCESS_INBOUND | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
    // SAFETY: a plain CreateNamedPipeW with a valid, NUL-terminated name.
    unsafe {
        CreateNamedPipeW(
            path.as_ptr(),
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            0,
            MAX_REPORT as u32,
            0,
            std::ptr::null(),
        )
    }
}

impl HookPipe {
    pub fn create() -> Option<HookPipe> {
        let name = format!("termic-hook-{}", uuid::Uuid::new_v4().simple());
        let first = new_instance(&name, true);
        if first == INVALID_HANDLE_VALUE {
            return None;
        }
        Some(HookPipe { name, first })
    }

    /// The value for `TERMIC_PTY`: the pipe as a path both Git Bash and Node
    /// open for writing.
    pub fn env_path(&self) -> String {
        env_path_for(&self.name)
    }

    /// Serve until `done` is set, handing each connection's bytes to `sink`
    /// whole. One thread waits for the next client; each client is read on
    /// its own thread, so two hooks firing together do not wait on each
    /// other. Call `wake` after setting `done` so the waiting thread returns.
    pub fn serve(self, done: Arc<AtomicBool>, sink: Arc<dyn Fn(&[u8]) + Send + Sync>) {
        let HookPipe { name, first } = self;
        // Carried across the thread boundary as an integer: a HANDLE is a raw
        // pointer type, which is not Send even though the kernel handle is.
        let first = first as usize;
        std::thread::spawn(move || {
            let mut next = first as HANDLE;
            loop {
                // SAFETY: `next` is a pipe instance we created and own.
                //
                // A client that connected, wrote and closed BEFORE this call
                // (a fast hook, landing between two instances) makes it return
                // ERROR_NO_DATA, not success: the report is still buffered and
                // has to be read, or it is lost. ERROR_PIPE_CONNECTED is the
                // same race with the client still open.
                let connected = unsafe { ConnectNamedPipe(next, std::ptr::null_mut()) } != 0
                    || matches!(unsafe { GetLastError() }, ERROR_PIPE_CONNECTED | ERROR_NO_DATA);
                if done.load(Ordering::Acquire) {
                    unsafe { CloseHandle(next) };
                    return;
                }
                let current = next;
                next = new_instance(&name, false);
                if connected {
                    let sink = sink.clone();
                    let h = current as usize;
                    std::thread::spawn(move || {
                        let bytes = read_all(h as HANDLE);
                        unsafe { CloseHandle(h as HANDLE) };
                        if !bytes.is_empty() {
                            sink(&bytes);
                        }
                    });
                } else {
                    unsafe { CloseHandle(current) };
                }
                if next == INVALID_HANDLE_VALUE {
                    return;
                }
            }
        });
    }
}

/// Wake a `serve` loop blocked waiting for a client, so it sees `done`.
pub fn wake(env_path: &str) {
    let name = env_path.rsplit(['/', '\\']).next().unwrap_or_default();
    let path = wide(&format!(r"\\.\pipe\{name}"));
    // SAFETY: open-and-close a client handle; failure just means nobody waits.
    unsafe {
        let h = CreateFileW(
            path.as_ptr(),
            GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        );
        if h != INVALID_HANDLE_VALUE {
            CloseHandle(h);
        }
    }
}

fn read_all(h: HANDLE) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let mut n = 0u32;
        // SAFETY: reading into a stack buffer of the stated size.
        let ok = unsafe {
            ReadFile(h, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut())
        };
        if ok == 0 || n == 0 {
            break;
        }
        if out.len() + n as usize > MAX_REPORT {
            return Vec::new();
        }
        out.extend_from_slice(&buf[..n as usize]);
    }
    out
}

/// The path form handed to hooks, pure so it is testable. The Windows form:
/// the scripts pass it to `termic hook-emit` as an argument, where a leading
/// `//` would be rewritten by Git Bash's path conversion and `\\` is not.
pub(crate) fn env_path_for(name: &str) -> String {
    format!(r"\\.\pipe\{name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn what_a_hook_writes_reaches_the_sink_whole() {
        let pipe = HookPipe::create().expect("pipe");
        let path = pipe.env_path();
        let got: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        pipe.serve(done.clone(), Arc::new(move |b: &[u8]| g.lock().unwrap().push(b.to_vec())));

        // Two hooks, each opening the pipe as a file, the way a script does.
        // Back to back, through the same writer `termic hook-emit` uses: the
        // second one lands while the server is between instances, which is
        // the busy window write_report exists to ride out.
        for body in ["\x1b]777;notify;termic;agent working\x07", "\x1b]777;notify;termic;agent done\x07"] {
            termic_cli::write_report(std::path::Path::new(&path), body.as_bytes()).expect("write");
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while got.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        done.store(true, Ordering::Release);
        wake(&path);
        let got = got.lock().unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().any(|b| b.ends_with(b"agent done\x07")));
    }
}

/// End to end, on Windows: claude's real generated hook scripts, run by Git
/// Bash the way Claude Code runs them, report through `termic hook-emit`
/// into the pipe. Needs the sidecar that build.rs stages into `binaries/`.
#[cfg(test)]
mod script_tests {
    use super::*;
    use crate::agent_hooks::{script_body, Signal};
    use std::sync::Mutex;

    fn git_bash() -> Option<std::path::PathBuf> {
        let p = crate::shell_env::script_bash();
        (p.is_absolute() && p.is_file()).then_some(p)
    }

    fn sidecar() -> std::path::PathBuf {
        let target = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
        let env = if cfg!(target_env = "gnu") { "gnu" } else { "msvc" };
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("termic-cli-{target}-pc-windows-{env}.exe"))
    }

    fn run_hook(sig: Signal, payload: &str) -> Vec<u8> {
        let Some(bash) = git_bash() else {
            eprintln!("no Git Bash here, skipping");
            return b"SKIPPED".to_vec();
        };
        let pipe = HookPipe::create().expect("pipe");
        let path = pipe.env_path();
        let got: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let done = Arc::new(AtomicBool::new(false));
        let g = got.clone();
        pipe.serve(done.clone(), Arc::new(move |b: &[u8]| g.lock().unwrap().extend_from_slice(b)));

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hook.sh");
        std::fs::write(&script, script_body("claude", sig)).unwrap();
        let mut child = std::process::Command::new(bash)
            .arg(&script)
            .env("TERMIC_TASK_ID", "t1")
            .env("TERMIC_PTY", &path)
            .env("TERMIC_PTY_PIPE", "1")
            .env("TERMIC_CLI", sidecar())
            .env_remove("GROK_HOOK_EVENT")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .expect("spawn bash");
        {
            use std::io::Write as _;
            child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        }
        assert!(child.wait().unwrap().success(), "a hook must never exit non-zero");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while got.lock().unwrap().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        done.store(true, Ordering::Release);
        wake(&path);
        let out = got.lock().unwrap().clone();
        out
    }

    #[test]
    fn claudes_generated_hooks_report_through_the_pipe() {
        assert!(sidecar().is_file() || git_bash().is_none(), "sidecar missing: {}", sidecar().display());
        let working = run_hook(Signal::Working, r#"{"session_id":"s1","hook_event_name":"UserPromptSubmit"}"#);
        if working == b"SKIPPED" {
            return;
        }
        let text = String::from_utf8_lossy(&working);
        assert!(text.contains("\x1b]") && text.contains("agent working"), "{text:?}");

        let done = run_hook(Signal::Done, r#"{"session_id":"s1","hook_event_name":"Stop"}"#);
        let text = String::from_utf8_lossy(&done);
        assert!(text.contains("agent done"), "{text:?}");
    }
}
