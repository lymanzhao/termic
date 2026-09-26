fn main() {
    // A closed stdout pipe (`termic ... | head`) must end the process
    // the standard unix way (SIGPIPE, shells report 141), not as a
    // Rust panic with exit 101: the runtime ignores SIGPIPE by default
    // and println! panics on EPIPE. 141 is outside, and compatible
    // with, the 0-10 exit contract. Windows has no SIGPIPE (a closed
    // pipe read/write fails with ERROR_BROKEN_PIPE, which io maps to a
    // clean error), so there is nothing to restore there.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    std::process::exit(termic_cli::run());
}
