//! Local transport for the CLI <-> app control socket.
//!
//! One abstraction, two backends:
//! - Unix: `UnixStream` / `UnixListener` at `<data_dir>/termic.sock`
//!   (mode 0600). A thin delegation layer; every timeout and peer check
//!   is the kernel's, exactly as before the abstraction existed.
//! - Windows: a named pipe (`\\.\pipe\termic\<hex of the socket path>`)
//!   in byte mode with the default DACL, which only grants the creating
//!   user, SYSTEM and Administrators - the same same-user boundary the
//!   Unix socket's 0600 + getpeereid check provides. Overlapped IO on
//!   every operation: a named pipe handle opened without
//!   FILE_FLAG_OVERLAPPED cannot time out at all, and the CLI's "never
//!   hang a script" contract (30s default reply ceiling, 330s slow
//!   verbs) is load-bearing.
//!
//! Both backends implement the full operation set the protocol needs:
//! connect / bind / accept / try_clone / read+write timeouts / local
//! shutdown / peer same-user check. NDJSON framing in `lib.rs` sits on
//! plain `Read`/`Write` and is unchanged.
//!
//! Platform semantics that deliberately match Unix:
//! - `try_clone` shares timeout state with the original (a dup'd fd
//!   shares its file description's timeouts; here the clones share one
//!   `Arc<Shared>`).
//! - `shutdown` aborts THIS side: every pending and future IO on any
//!   clone fails (socket Shutdown::Both). It is not a wire-level FIN:
//!   the peer learns of the abort when the process exits and the kernel
//!   closes the pipe end, which for the single-shot CLI is immediate.
//! - A read on a closed peer is EOF (`Ok(0)`), not an error, so the
//!   framing layer's `Ok(None)` handling needs no platform branches.

use std::io;
use std::path::Path;
use std::time::Duration;

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub struct Stream(pub(super) UnixStream);
    pub struct Listener(pub(super) UnixListener);

    impl Stream {
        pub fn connect(path: &Path) -> io::Result<Self> {
            UnixStream::connect(path).map(Stream)
        }
        pub fn try_clone(&self) -> io::Result<Self> {
            self.0.try_clone().map(Stream)
        }
        pub fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(d)
        }
        pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            self.0.set_write_timeout(d)
        }
        /// True kernel-level abort: unblocks our own pending reads and
        /// makes the peer's read return EOF (attach's "the session cannot
        /// outlive its keyboard" guarantee).
        pub fn shutdown(&self) -> io::Result<()> {
            self.0.shutdown(std::net::Shutdown::Both)
        }
        pub fn peer_is_self_user(&self) -> bool {
            // Same-uid check the server does before reading a byte. peer_uid
            // and geteuid both succeed or both fail in every environment this
            // runs in (they are the same libc surface); a failed CHECK maps
            // to `false`, which the caller treats as "drop the connection" -
            // the fail-closed direction.
            peer_uid(&self.0) == Some(unsafe { libc::geteuid() })
        }
    }

    fn peer_uid(stream: &UnixStream) -> Option<u32> {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
        {
            let (mut uid, mut gid) = (0u32, 0u32);
            // SAFETY: valid fd from a live UnixStream; out-params are plain ints.
            let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
            (rc == 0).then_some(uid)
        }
        #[cfg(target_os = "linux")]
        {
            let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
            let mut len = std::mem::size_of::<libc::ucred>() as u32;
            // SAFETY: valid fd from a live UnixStream; out-params are plain ints.
            let rc = unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut cred as *mut _ as *mut libc::c_void,
                    &mut len,
                )
            };
            (rc == 0).then_some(cred.uid)
        }
        #[cfg(not(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "linux"
        )))]
        {
            let _ = stream;
            None
        }
    }

    impl Listener {
        /// Bind a fresh listener. `prepare_bind` ran first, so a stale
        /// socket file from a crashed instance is already gone.
        pub fn bind(path: &Path) -> io::Result<Self> {
            UnixListener::bind(path).map(Listener)
        }
        pub fn accept(&mut self) -> io::Result<Stream> {
            self.0.accept().map(|(s, _)| Stream(s))
        }
        /// Accept loop as an iterator, mirroring `UnixListener::incoming`
        /// (yields io::Result items, never ends on its own; the caller
        /// gives up after persistent errors).
        pub fn incoming(self) -> impl Iterator<Item = io::Result<Stream>> {
            self.0.incoming().map(|s| s.map(Stream))
        }
    }

    /// Unix needs the stale-socket unlink before bind (the standard
    /// unix-daemon dance); done once per boot from `server_main`.
    pub fn prepare_bind(path: &Path) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::{
        AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle, RawHandle,
    };
    use std::sync::{Arc, Mutex};

    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE, ERROR_IO_PENDING,
        ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, GetLastError, GENERIC_READ,
        GENERIC_WRITE, HANDLE,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, SetNamedPipeHandleState, WaitNamedPipeW,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
        PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        SetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    /// WAIT_OBJECT_0 / WAIT_OBJECT_0+1 (io event / cancel event) and
    /// WAIT_TIMEOUT, spelled locally to stay independent of which module
    /// surface the bindings place them in.
    const WAIT_OBJ_0: u32 = 0;
    /// WAIT_OBJECT_0+1: the cancel event of a two-handle wait. A separate
    /// const because match patterns cannot do const arithmetic.
    const WAIT_OBJ_1: u32 = 1;
    const WAIT_TIMEOUT_CODE: u32 = 0x0000_0102;
    const DUPLICATE_SAME_ACCESS: u32 = 2;
    const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
    /// Covers every real-world Windows SID (max 68 bytes for 15
    /// subauthorities) inside its TOKEN_USER envelope.
    const TOKEN_USER_BUF: usize = 96;

    /// State shared between a stream and its `try_clone` siblings: the
    /// effective read/write timeouts and the cancel event. On Unix these
    /// live on the socket file description and travel with `dup`; here
    /// they are explicit because every overlapped wait consumes them.
    struct Shared {
        read_timeout: Mutex<Option<Duration>>,
        write_timeout: Mutex<Option<Duration>>,
        /// Manual-reset. Set by `shutdown()`: every pending AND future IO
        /// on any clone fails, which is what socket `Shutdown::Both` does
        /// locally (attach relies on it to unblock its own blocked reader).
        cancel: HANDLE,
    }

    impl Drop for Shared {
        fn drop(&mut self) {
            // SAFETY: cancel is a live event handle this struct owns; the
            // Arc guarantees it closes exactly once.
            unsafe { CloseHandle(self.cancel) };
        }
    }

    // SAFETY: the HANDLE here is a kernel event handle, which has no
    // thread affinity: SetEvent / CloseHandle / a WaitFor* on it are all
    // legal from any thread. Send transfers the (sole) ownership the Arc
    // already tracks; Sync exposes only &self methods that duplicate or
    // signal the handle.
    unsafe impl Send for Shared {}
    unsafe impl Sync for Shared {}

    pub struct Stream {
        handle: OwnedHandle,
        shared: Arc<Shared>,
    }

    /// Wrap a raw handle from a successful Create* call, mapping the
    /// NULL / INVALID_HANDLE_VALUE sentinels to the last error.
    fn own(h: HANDLE) -> io::Result<OwnedHandle> {
        if h.is_null() || h == -1isize as HANDLE {
            return Err(io::Error::from_raw_os_error(unsafe { GetLastError() } as i32));
        }
        // SAFETY: h came from a successful Create* call; OwnedHandle takes
        // ownership and closes it exactly once.
        Ok(unsafe { OwnedHandle::from_raw_handle(h as RawHandle) })
    }

    fn shut_down() -> io::Error {
        io::Error::new(io::ErrorKind::NotConnected, "stream shut down")
    }

    fn timeout_ms(d: Option<Duration>) -> u32 {
        match d {
            None => INFINITE,
            Some(d) => d.as_millis().min((u32::MAX - 1) as u128) as u32,
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl Stream {
        pub fn connect(path: &Path) -> io::Result<Self> {
            let wide = to_wide(&pipe_name(path));
            let mut attempts = 0u32;
            loop {
                // SAFETY: wide is a NUL-terminated UTF-16 buffer; the handle
                // is immediately wrapped (or the error mapped). No security
                // attrs: opening a pipe owned by another user fails on the
                // DACL, the same boundary Unix connect hits on socket perms.
                let h = unsafe {
                    CreateFileW(
                        wide.as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_NONE,
                        std::ptr::null(),
                        OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED,
                        std::ptr::null_mut() as _,
                    )
                };
                if !h.is_null() && h != -1isize as HANDLE {
                    return Self::from_new_handle(h);
                }
                let err = unsafe { GetLastError() };
                // All instances busy with live clients: bounded wait for a
                // free one (the named-pipe analog of a full listen backlog).
                if err == ERROR_PIPE_BUSY && attempts < 50 {
                    attempts += 1;
                    // SAFETY: wide outlives the call.
                    unsafe { WaitNamedPipeW(wide.as_ptr(), 200) };
                    continue;
                }
                return Err(io::Error::from_raw_os_error(err as i32));
            }
        }

        fn from_new_handle(h: HANDLE) -> io::Result<Self> {
            let handle = own(h)?;
            // SAFETY: valid pipe handle; byte mode matches the server's
            // PIPE_TYPE_BYTE so framing sees a plain byte stream.
            unsafe {
                let mode: u32 = PIPE_READMODE_BYTE;
                SetNamedPipeHandleState(handle.as_raw_handle() as HANDLE, &mode, std::ptr::null(), std::ptr::null());
            }
            // SAFETY: auto-reset, unnamed event owned by the Shared below.
            let cancel = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
            let cancel = own(cancel)?;
            let shared = Arc::new(Shared {
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
                // SAFETY: release the OwnedHandle's ownership into the raw
                // HANDLE; Shared::drop closes it exactly once.
                cancel: cancel.into_raw_handle() as HANDLE,
            });
            Ok(Stream { handle, shared })
        }

        pub fn try_clone(&self) -> io::Result<Self> {
            // SAFETY: duplicate onto the same process; the clone shares the
            // SAME kernel pipe end and our explicit Shared, mirroring how a
            // dup'd UnixStream shares its file description's timeouts.
            let mut dup: HANDLE = std::ptr::null_mut();
            let ok = unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    self.handle.as_raw_handle() as HANDLE,
                    GetCurrentProcess(),
                    &mut dup,
                    0,
                    0,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            if ok == 0 {
                return Err(io::Error::from_raw_os_error(unsafe { GetLastError() } as i32));
            }
            Ok(Stream { handle: own(dup)?, shared: self.shared.clone() })
        }

        pub fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            *self.shared.read_timeout.lock().unwrap() = d;
            Ok(())
        }
        pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
            *self.shared.write_timeout.lock().unwrap() = d;
            Ok(())
        }

        pub fn shutdown(&self) -> io::Result<()> {
            // Local abort, not a wire-level FIN (named pipes have none that
            // unblocks the peer's read while our end stays open): sets the
            // shared cancel event, failing this stream's and every clone's
            // pending and future IO. The SERVER side of an aborted attach
            // session learns of it when our process exits and the kernel
            // closes the pipe end - the CLI is single-shot, so that is
            // milliseconds behind.
            // SAFETY: cancel is a live event handle shared by every clone.
            unsafe { SetEvent(self.shared.cancel) };
            Ok(())
        }

        pub fn peer_is_self_user(&self) -> bool {
            // Defense in depth on top of the default DACL (which already
            // restricts the pipe to creator-owner, SYSTEM and admins):
            // resolve the client PID's token user and compare SIDs with our
            // own. Any step failing means we could NOT verify; the caller
            // drops the connection (fail closed, same as Unix).
            // SAFETY: the handle is a live named-pipe server end; the out
            // PID is a plain u32.
            unsafe {
                let mut client_pid: u32 = 0;
                if GetNamedPipeClientProcessId(self.handle.as_raw_handle() as HANDLE, &mut client_pid) == 0 {
                    return false;
                }
                if client_pid == GetCurrentProcessId() {
                    return true; // our own process; the SID compare would agree
                }
                let (Some(client_user), Some(self_user)) = (
                    token_user_of_process(client_pid),
                    token_user_of_current_process(),
                ) else {
                    return false;
                };
                EqualSid(client_user.0 as *mut _, self_user.0 as *mut _) != 0
            }
        }

        /// One overlapped IO operation with a deadline and a cancel side
        /// channel. Every exit path drains the OVERLAPPED so it never
        /// outlives this stack frame.
        fn overlapped_io(&self, write: bool, buf: *mut u8, len: u32) -> io::Result<usize> {
            let timeout = {
                let cell = if write {
                    self.shared.write_timeout.lock().unwrap()
                } else {
                    self.shared.read_timeout.lock().unwrap()
                };
                *cell
            };
            // SAFETY: auto-reset, unnamed event owned by this call; closed
            // at scope end by OwnedHandle.
            let event = own(unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) })?;
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.as_raw_handle() as HANDLE;
            // SAFETY: buf/len describe a live caller buffer; ov outlives the
            // operation (drained below on every path).
            let started = unsafe {
                if write {
                    WriteFile(self.handle.as_raw_handle() as HANDLE, buf, len, std::ptr::null_mut(), &mut ov)
                } else {
                    ReadFile(self.handle.as_raw_handle() as HANDLE, buf, len, std::ptr::null_mut(), &mut ov)
                }
            };
            if started == 0 {
                let err = unsafe { GetLastError() };
                if err != ERROR_IO_PENDING {
                    return Err(io::Error::from_raw_os_error(err as i32));
                }
            }
            // SAFETY: both handles are live for this whole call; the array
            // outlives the wait.
            let handles = [ov.hEvent, self.shared.cancel];
            let waited =
                unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms(timeout)) };
            let mut n: u32 = 0;
            match waited {
                WAIT_OBJ_0 => {}
                WAIT_OBJ_1 => {
                    // shutdown() beat the IO: cancel, drain, fail.
                    // SAFETY: cancels THIS handle's operation identified by
                    // ov; the drain below reaps the completion so `ov` and
                    // `event` can drop.
                    unsafe { CancelIoEx(self.handle.as_raw_handle() as HANDLE, &mut ov) };
                    unsafe { GetOverlappedResult(self.handle.as_raw_handle() as HANDLE, &ov, &mut n, 1) };
                    return Err(shut_down());
                }
                WAIT_TIMEOUT_CODE => {
                    // Deadline: cancel the op, then wait for the completion
                    // to actually land so `ov` is safe to drop.
                    unsafe { CancelIoEx(self.handle.as_raw_handle() as HANDLE, &mut ov) };
                    unsafe { GetOverlappedResult(self.handle.as_raw_handle() as HANDLE, &ov, &mut n, 1) };
                    return Err(io::Error::new(io::ErrorKind::TimedOut, "timed out"));
                }
                _ => {
                    // WAIT_FAILED: a broken handle, which cannot happen
                    // while both are alive here; drain best-effort and
                    // report.
                    unsafe { CancelIoEx(self.handle.as_raw_handle() as HANDLE, &mut ov) };
                    unsafe { GetOverlappedResult(self.handle.as_raw_handle() as HANDLE, &ov, &mut n, 1) };
                    return Err(io::Error::from_raw_os_error(unsafe { GetLastError() } as i32));
                }
            }
            // SAFETY: bWait=FALSE: the completion already signalled, so this
            // returns the transferred count (or the operation's error).
            let got = unsafe { GetOverlappedResult(self.handle.as_raw_handle() as HANDLE, &ov, &mut n, 0) };
            if got == 0 {
                let err = unsafe { GetLastError() };
                let e = io::Error::from_raw_os_error(err as i32);
                return if write { Err(e) } else { read_err_or_eof(e) };
            }
            Ok(n as usize)
        }
    }

    /// Map "the other end is gone" to read-EOF the way a Unix stream
    /// behaves, so the framing layer's Ok(None) path needs no branches.
    fn read_err_or_eof(e: io::Error) -> io::Result<usize> {
        match e.raw_os_error() {
            Some(c) if c == ERROR_BROKEN_PIPE as i32 || c == ERROR_NO_DATA as i32 => Ok(0),
            _ => Err(e),
        }
    }

    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult};
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;

    impl io::Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            (&*self).read(buf)
        }
    }
    impl io::Read for &Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            self.overlapped_io(false, buf.as_mut_ptr(), len)
        }
    }
    impl io::Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            (&*self).write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl io::Write for &Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            self.overlapped_io(true, buf.as_ptr() as *mut u8, len)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    pub struct Listener {
        name: Vec<u16>,
        /// The pipe instance waiting for the next client. Every accepted
        /// instance is consumed and replaced before the next accept, as
        /// CreateNamedPipeW's one-instance-per-connect model requires.
        pending: Option<OwnedHandle>,
    }

    impl Listener {
        pub fn bind(path: &Path) -> io::Result<Self> {
            let name = pipe_name(path);
            let wide = to_wide(&name);
            // The first instance carries FILE_FLAG_FIRST_PIPE_INSTANCE: if
            // the name is already owned (a live server), creation fails with
            // ACCESS_DENIED - the same signal Unix bind gives on an
            // occupied socket file. A crashed server leaves nothing to
            // clean up (instances die with the process), so there is no
            // unlink dance on this platform.
            // SAFETY: wide is NUL-terminated; null security attrs = default
            // DACL (creator-owner, SYSTEM, admins), the same-user boundary.
            let h = unsafe {
                CreateNamedPipeW(
                    wide.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    std::ptr::null(),
                )
            };
            if h.is_null() || h == -1isize as HANDLE {
                let err = unsafe { GetLastError() };
                let mapped = if err == ERROR_ACCESS_DENIED {
                    io::Error::new(io::ErrorKind::AddrInUse, "control socket already in use")
                } else {
                    io::Error::from_raw_os_error(err as i32)
                };
                return Err(mapped);
            }
            Ok(Listener { name: wide, pending: Some(own(h)?) })
        }

        pub fn accept(&mut self) -> io::Result<Stream> {
            // Hand out the pending instance to THIS client; on any failure
            // it is burnt and dropped (the next call uses the replacement).
            let instance = self
                .pending
                .take()
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "listener closed"))?;
            // SAFETY: overlapped ConnectNamedPipe on an overlapped handle
            // (the docs require an OVERLAPPED there); the event outlives
            // the wait.
            let event = own(unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) })?;
            let mut ov: OVERLAPPED = unsafe { std::mem::zeroed() };
            ov.hEvent = event.as_raw_handle() as HANDLE;
            let rc = unsafe { ConnectNamedPipe(instance.as_raw_handle() as HANDLE, &mut ov) };
            if rc == 0 {
                let err = unsafe { GetLastError() };
                match err {
                    ERROR_IO_PENDING => {
                        let waited = unsafe { WaitForSingleObject(ov.hEvent, INFINITE) };
                        if waited != WAIT_OBJ_0 {
                            return Err(io::Error::from_raw_os_error(
                                unsafe { GetLastError() } as i32,
                            ));
                        }
                    }
                    ERROR_PIPE_CONNECTED => {} // client arrived before ConnectNamedPipe
                    _ => return Err(io::Error::from_raw_os_error(err as i32)),
                }
            }
            let stream = Stream::from_owned(instance)?;
            self.replenish();
            Ok(stream)
        }

        /// Accept loop as an iterator (same shape as Unix's `incoming`):
        /// yields Results forever; the caller gives up after persistent
        /// errors.
        pub fn incoming(mut self) -> impl Iterator<Item = io::Result<Stream>> {
            std::iter::from_fn(move || {
                let out = self.accept();
                if out.is_err() {
                    self.replenish();
                }
                Some(out)
            })
        }

        /// Create the replacement instance for the next client. Failure
        /// here leaves the slot empty; the next accept reports it and the
        /// accept loop's error accounting (upstream) eventually stops.
        fn replenish(&mut self) {
            if self.pending.is_some() {
                return;
            }
            // SAFETY: same shape as bind(), WITHOUT the first-instance flag
            // (our server already owns the name).
            let h = unsafe {
                CreateNamedPipeW(
                    self.name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    std::ptr::null(),
                )
            };
            if let Ok(h) = own(h) {
                self.pending = Some(h);
            }
        }
    }

    impl Stream {
        /// Wrap an already-connected instance (accept path: the handle is
        /// owned and connected; only byte-mode + the shared state are left
        /// to set up).
        fn from_owned(handle: OwnedHandle) -> io::Result<Self> {
            // SAFETY: valid connected pipe handle.
            unsafe {
                let mode: u32 = PIPE_READMODE_BYTE;
                SetNamedPipeHandleState(handle.as_raw_handle() as HANDLE, &mode, std::ptr::null(), std::ptr::null());
            }
            // SAFETY: auto-reset, unnamed event owned by the Shared below.
            let cancel = own(unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) })?;
            let shared = Arc::new(Shared {
                read_timeout: Mutex::new(None),
                write_timeout: Mutex::new(None),
                // SAFETY: ownership moves to Shared::drop.
                cancel: cancel.into_raw_handle() as HANDLE,
            });
            Ok(Stream { handle, shared })
        }
    }

    fn token_user_of_current_process() -> Option<(*const u8, Vec<u8>)> {
        // SAFETY: GetCurrentProcess returns the pseudo-handle, which
        // OpenProcessToken accepts; the token handle is closed at scope end.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let user = token_user(token);
            CloseHandle(token);
            user
        }
    }

    fn token_user_of_process(pid: u32) -> Option<(*const u8, Vec<u8>)> {
        // SAFETY: pid comes from GetNamedPipeClientProcessId on a live
        // connection. OpenProcess may fail (ACCESS_DENIED) for another
        // user's process, which maps to "drop the connection".
        unsafe {
            let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if proc.is_null() {
                return None;
            }
            let mut token: HANDLE = std::ptr::null_mut();
            let got = OpenProcessToken(proc, TOKEN_QUERY, &mut token);
            let user = if got == 0 { None } else { token_user(token) };
            if got != 0 {
                CloseHandle(token);
            }
            CloseHandle(proc);
            user
        }
    }

    /// Query a token's TokenUser into an owned buffer. Returns a pointer
    /// INTO the buffer (the SID) alongside it so the caller can EqualSid
    /// before the buffer drops.
    fn token_user(token: HANDLE) -> Option<(*const u8, Vec<u8>)> {
        let mut buf = vec![0u8; TOKEN_USER_BUF];
        let mut needed: u32 = 0;
        // SAFETY: buffer/len are a live allocation; TokenUser writes at
        // most the buffer's length.
        unsafe {
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                &mut needed,
            ) == 0
            {
                return None;
            }
        }
        let sid = buf.as_ptr();
        Some((sid, buf))
    }

    /// Filesystem-ish path -> pipe namespace name. The FULL path is
    /// hex-encoded rather than hashed: the data dir is per-user, the pipe
    /// namespace is machine-global, and a hash collision would hand
    /// another local user a squatting point on our control socket.
    fn pipe_name(path: &Path) -> String {
        let text = path.to_string_lossy();
        let mut out = String::from("\\\\.\\pipe\\termic\\");
        for b in text.as_bytes() {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }

    /// Windows needs no stale-socket cleanup: pipe instances vanish with
    /// the owning process.
    pub fn prepare_bind(_path: &Path) {}
}

pub use imp::{prepare_bind, Listener, Stream};

/// Connect to the control socket with both timeouts applied (the client's
/// standard posture: 30s reply ceiling, 10s write ceiling).
pub fn connect_with_timeouts(path: &Path, read: Duration, write: Duration) -> io::Result<Stream> {
    let s = Stream::connect(path)?;
    s.set_read_timeout(Some(read))?;
    s.set_write_timeout(Some(write))?;
    Ok(s)
}
