fn main() {
    // A closed stdout pipe (`termic ... | head`) must end the process
    // the standard unix way (SIGPIPE, shells report 141), not as a
    // Rust panic with exit 101: the runtime ignores SIGPIPE by default
    // and println! panics on EPIPE. 141 is outside, and compatible
    // with, the 0-10 exit contract.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    // `termic hook-emit <target>`: an agent hook's report, from the app's
    // own generated scripts, never typed by a person. Handled before clap
    // and before any socket: a hook runs on every turn, so it has to be
    // fast, and it talks to its terminal, not to the control plane.
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|a| a == "hook-emit") {
        std::process::exit(termic_cli::hook_emit(args.get(2).map(std::path::Path::new)));
    }
    std::process::exit(termic_cli::run());
}
