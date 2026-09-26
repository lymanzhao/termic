//! Stand-in for `procmon.rs` on every OS that isn't macOS or Linux (i.e.
//! Windows, today). Neither of the real implementations' syscalls exist
//! here, so this just answers "unsupported" — see lib.rs's 3-way `mod
//! procmon` cfg split.

pub use crate::procmon_common::{ChildRow, ProcRow, Root, Snapshot};

pub fn start(_roots: Vec<Root>) -> Snapshot {
    Snapshot { session: 0, unix_ms: 0.0, rows: Vec::new(), sample_ms: 0.0, webkit_unavailable: true }
}

pub fn stop(_session: u64) {}
pub fn stop_all() {}

pub fn sample(_session: u64, _roots: Vec<Root>) -> Result<Snapshot, String> {
    Err("Activity monitor is only available on macOS and Linux".into())
}

pub fn signal(_roots: &[Root], _pid: u32, _sig_name: &str) -> Result<(), String> {
    Err("Activity monitor is only available on macOS and Linux".into())
}
