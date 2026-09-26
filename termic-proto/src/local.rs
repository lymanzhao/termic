//! The control plane's local transport, one type pair per platform.
//!
//! Unix: a socket file in the app's data dir (`termic.sock`). The server
//! chmods it 0600 and checks the peer uid on every connection.
//!
//! Windows: std has no stable AF_UNIX, and named pipes lack the socket
//! semantics the server and the attach session rely on (read timeouts,
//! `try_clone` into independent halves, `shutdown` to unblock the other
//! thread's read, concurrent read and write on one connection). So the
//! server listens on loopback TCP on an ephemeral port and writes
//! `127.0.0.1:<port>` into the same `termic.sock` path, which clients read
//! to find it. That file and the token file sit in the user's profile
//! (`%LOCALAPPDATA%`), whose inherited ACL admits only the user, SYSTEM
//! and Administrators, so the per-boot token (required for every verb
//! except hello, raise and open_url) stays the user's credential. What
//! is weaker than unix: there is no kernel peer-identity check, so another
//! local account can reach the three unauthenticated verbs. A named-pipe
//! transport with a SID check is the upgrade path (docs/ideas/windows.md).

use std::io;
use std::path::Path;

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};

#[cfg(windows)]
pub use std::net::{TcpListener as Listener, TcpStream as Stream};

/// Connect to the endpoint at `path`.
#[cfg(unix)]
pub fn connect(path: &Path) -> io::Result<Stream> {
    Stream::connect(path)
}

/// Connect to the endpoint whose address is recorded in `path`.
#[cfg(windows)]
pub fn connect(path: &Path) -> io::Result<Stream> {
    let addr = read_endpoint(path)?;
    let stream = Stream::connect_timeout(&addr, std::time::Duration::from_secs(2))?;
    // Attach is interactive: a keystroke must not wait on Nagle.
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Bind the endpoint at `path`. On unix the caller is responsible for
/// removing a stale socket file first (the unlink-and-rebind dance is a
/// policy decision the server owns). On Windows the endpoint file is
/// (re)written to point at the fresh ephemeral port.
#[cfg(unix)]
pub fn bind(path: &Path) -> io::Result<Listener> {
    Listener::bind(path)
}

#[cfg(windows)]
pub fn bind(path: &Path) -> io::Result<Listener> {
    let listener = Listener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    // Write-then-rename, so a client never reads a half-written address.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, addr.to_string())?;
    let _ = std::fs::remove_file(path);
    std::fs::rename(&tmp, path)?;
    Ok(listener)
}

/// Parse the endpoint file. Only a loopback address is accepted: a
/// tampered file must not be able to send the CLI's token elsewhere.
#[cfg(windows)]
fn read_endpoint(path: &Path) -> io::Result<std::net::SocketAddr> {
    let text = std::fs::read_to_string(path)?;
    parse_endpoint(&text)
}

/// Pure half of `read_endpoint`, compiled everywhere so it is tested on
/// every CI runner.
pub fn parse_endpoint(text: &str) -> io::Result<std::net::SocketAddr> {
    let addr: std::net::SocketAddr = text
        .trim()
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("bad endpoint: {e}")))?;
    if !addr.ip().is_loopback() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "endpoint is not a loopback address",
        ));
    }
    Ok(addr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_accepts_loopback_only() {
        assert_eq!(parse_endpoint("127.0.0.1:4242\n").unwrap().port(), 4242);
        assert_eq!(parse_endpoint("[::1]:9").unwrap().port(), 9);
        assert_eq!(
            parse_endpoint("10.0.0.5:4242").unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(parse_endpoint("nonsense").unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn bind_then_connect_round_trips() {
        use std::io::{Read, Write};
        let dir = std::env::temp_dir().join(format!("termic-local-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ep.sock");
        let _ = std::fs::remove_file(&path);
        let listener = bind(&path).unwrap();
        let t = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut b = [0u8; 4];
            s.read_exact(&mut b).unwrap();
            s.write_all(&b).unwrap();
        });
        let mut c = connect(&path).unwrap();
        c.write_all(b"ping").unwrap();
        let mut b = [0u8; 4];
        c.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"ping");
        t.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
