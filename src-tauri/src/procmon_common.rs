//! OS-agnostic pieces of the Activity monitor's process sampler: the row
//! shapes every platform reports, and the pure logic (subtree walking, CPU
//! ratio math, workload labeling, the signal whitelist) that has no
//! syscalls in it and so needs writing only once. `procmon.rs` (macOS,
//! libproc/mach FFI) and `procmon_linux.rs` (/proc) both build on this;
//! `procmon_other.rs` (every other OS) uses only the row shapes.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

/// One thing we want a row for. Built by lib.rs from the live PTY map
/// (which already knows each PTY's task, tab and kind) plus our own
/// process.
#[derive(Clone, Debug)]
pub struct Root {
    /// Stable identity across samples, so history/sparklines line up.
    pub key: String,
    pub kind: String,
    pub pty_id: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<String>,
    pub pid: u32,
    /// Cumulative PTY output bytes, used for the bytes/sec column. `None`
    /// for rows that are not a PTY.
    pub out_bytes: Option<u64>,
    /// `--name` of the Docker container this row's PTY is attached to, if
    /// it is a Docker-sandboxed agent. The host pid walk every platform's
    /// `sample()` does is close to meaningless for these rows (the real
    /// work happens inside the daemon's VM, invisible to the host process
    /// table), so `docker::merge_stats` uses this to overwrite the row
    /// with a `docker stats` query instead. `None` for every other row.
    pub docker_container: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ChildRow {
    pub pid: u32,
    pub label: String,
    pub cpu_pct: Option<f64>,
    pub mem_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcRow {
    pub key: String,
    pub kind: String,
    pub pty_id: Option<String>,
    pub task_id: Option<String>,
    pub tab_id: Option<String>,
    pub pid: u32,
    /// Process name of the real workload (`sandbox-exec` wrappers are
    /// skipped, or every caged agent would be named "sandbox-exec").
    pub label: String,
    /// None on the first sample after `start` - there is no previous
    /// snapshot to diff against yet.
    pub cpu_pct: Option<f64>,
    pub mem_bytes: u64,
    pub rss_bytes: u64,
    pub proc_count: u32,
    pub threads: u32,
    pub cpu_ms: u64,
    pub uptime_ms: u64,
    /// PTY output bytes/sec, the "who is repainting the screen" signal.
    /// None for non-PTY rows and on the first sample.
    pub out_bps: Option<f64>,
    pub alive: bool,
    /// cpu_pct over the session, oldest first, for the sparkline.
    pub cpu_history: Vec<f64>,
    /// The subtree's own processes, heaviest first, capped.
    pub children: Vec<ChildRow>,
    /// True once `docker::merge_stats` has overwritten this row's numbers
    /// with a `docker stats` query. The frontend uses it to badge the row
    /// and to explain why `children` is empty: a container's real process
    /// tree lives in the daemon's VM, not under the host pid we sampled.
    pub is_docker: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session: u64,
    pub unix_ms: f64,
    pub rows: Vec<ProcRow>,
    /// Wall-clock cost of producing this snapshot. Surfaced in the UI so
    /// the monitor's own overhead is visible instead of assumed.
    pub sample_ms: f64,
    /// macOS only: true when WebKit sidecars exist on the machine but none
    /// could be proved ours. Always false elsewhere - there is nothing to
    /// fail to prove because no platform but macOS attempts sidecar
    /// attribution at all (see procmon_linux.rs's module doc).
    pub webkit_unavailable: bool,
}

pub static EMPTY_SET: std::sync::LazyLock<HashSet<u32>> = std::sync::LazyLock::new(HashSet::new);

/// Invert pid->ppid into ppid->children.
pub fn build_child_map(ppid: &HashMap<u32, u32>) -> HashMap<u32, Vec<u32>> {
    let mut out: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &parent) in ppid {
        if pid == parent {
            continue; // defensive: a self-parent would loop the DFS
        }
        out.entry(parent).or_default().push(pid);
    }
    for kids in out.values_mut() {
        kids.sort_unstable();
    }
    out
}

/// Every pid in `root`'s subtree, including `root`. `stop` names pids
/// that belong to a DIFFERENT row: the walk does not enter them, so the
/// Termic row excludes agents even though agents are our children.
pub fn collect_subtree(
    root: u32,
    children: &HashMap<u32, Vec<u32>>,
    stop: &HashSet<u32>,
) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue; // a bad read must not hang us, whatever the platform
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            for &k in kids {
                if k != root && !stop.contains(&k) {
                    stack.push(k);
                }
            }
        }
    }
    out.sort_unstable();
    out
}

/// CPU busy percentage of one core-second, i.e. 100.0 means one core
/// saturated and 800.0 means eight. Unit-agnostic: both inputs just need
/// to share a unit (mach ticks on macOS, clock ticks converted to ms on
/// Linux - see each platform's `sample`).
pub fn cpu_ratio(cpu_delta: u64, wall_delta: u64) -> f64 {
    if wall_delta == 0 {
        return 0.0;
    }
    let pct = (cpu_delta as f64 / wall_delta as f64) * 100.0;
    if pct.is_finite() && pct > 0.0 {
        pct
    } else {
        0.0
    }
}

/// Name the workload, not the wrapper. A sandboxed agent's root pid is
/// `sandbox-exec`, whose only child is the agent - reporting the wrapper
/// would label every caged task identically. Descends only through
/// single-child wrappers, so it is stable across samples.
pub fn label_for(
    root: u32,
    children: &HashMap<u32, Vec<u32>>,
    comm: &HashMap<u32, String>,
) -> String {
    const WRAPPERS: [&str; 2] = ["sandbox-exec", "login"];
    let mut pid = root;
    for _ in 0..4 {
        let name = comm.get(&pid).map(String::as_str).unwrap_or("");
        if !WRAPPERS.contains(&name) {
            break;
        }
        match children.get(&pid).map(|k| k.as_slice()) {
            Some([only]) => pid = *only,
            _ => break,
        }
    }
    comm.get(&pid).cloned().unwrap_or_else(|| "?".into())
}

/// Signals the monitor is allowed to send. Deliberately small: this is a
/// process manager for OUR agents, not a general-purpose `kill`.
pub fn signal_from_name(name: &str) -> Option<libc::c_int> {
    // KILL/STOP/CONT have no Windows libc constant; the only consumer of
    // these numbers is the real procmon (macOS/Linux), so on other OSes
    // the names resolve to "unsupported" rather than a made-up number.
    match name {
        "TERM" => Some(libc::SIGTERM),
        "INT" => Some(libc::SIGINT),
        #[cfg(unix)]
        "KILL" => Some(libc::SIGKILL),
        #[cfg(unix)]
        "STOP" => Some(libc::SIGSTOP),
        #[cfg(unix)]
        "CONT" => Some(libc::SIGCONT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(pairs: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
        build_child_map(&pairs.iter().copied().collect())
    }

    #[test]
    fn subtree_collects_descendants() {
        // 1 -> 10 -> {100, 101}, 10 -> 11
        let t = tree(&[(10, 1), (11, 1), (100, 10), (101, 10)]);
        assert_eq!(collect_subtree(10, &t, &HashSet::new()), vec![10, 100, 101]);
        assert_eq!(collect_subtree(100, &t, &HashSet::new()), vec![100]);
    }

    #[test]
    fn subtree_stops_at_other_roots() {
        // The app row must not swallow the PTY rows hanging off it.
        let t = tree(&[(10, 1), (20, 1), (11, 10), (21, 20)]);
        let stop: HashSet<u32> = [20].into_iter().collect();
        assert_eq!(collect_subtree(1, &t, &stop), vec![1, 10, 11]);
    }

    #[test]
    fn subtree_survives_a_cycle() {
        // Cannot happen for real; must not hang if a racy read implies it.
        let mut t: HashMap<u32, Vec<u32>> = HashMap::new();
        t.insert(1, vec![2]);
        t.insert(2, vec![3]);
        t.insert(3, vec![1]);
        let got = collect_subtree(1, &t, &HashSet::new());
        assert_eq!(got, vec![1, 2, 3]);
    }

    #[test]
    fn self_parented_pid_is_dropped() {
        let t = tree(&[(1, 1), (2, 1)]);
        assert_eq!(collect_subtree(1, &t, &HashSet::new()), vec![1, 2]);
    }

    #[test]
    fn cpu_ratio_is_unitless() {
        // Half the window on one core.
        assert_eq!(cpu_ratio(50, 100), 50.0);
        // Two cores saturated for the whole window.
        assert_eq!(cpu_ratio(200, 100), 200.0);
        // No baseline yet / clock did not move.
        assert_eq!(cpu_ratio(10, 0), 0.0);
        assert_eq!(cpu_ratio(0, 100), 0.0);
    }

    #[test]
    fn label_skips_sandbox_wrapper() {
        let t = tree(&[(200, 100)]);
        let comm: HashMap<u32, String> = [(100, "sandbox-exec".into()), (200, "claude".into())]
            .into_iter()
            .collect();
        assert_eq!(label_for(100, &t, &comm), "claude");
    }

    #[test]
    fn label_keeps_wrapper_when_it_forked_twice() {
        // Two children means we cannot say which one IS the workload, so
        // naming the wrapper is the honest answer.
        let t = tree(&[(200, 100), (201, 100)]);
        let comm: HashMap<u32, String> = [
            (100, "sandbox-exec".into()),
            (200, "claude".into()),
            (201, "rg".into()),
        ]
        .into_iter()
        .collect();
        assert_eq!(label_for(100, &t, &comm), "sandbox-exec");
    }

    #[test]
    fn label_falls_back_when_process_vanished() {
        assert_eq!(label_for(42, &HashMap::new(), &HashMap::new()), "?");
    }

    #[test]
    fn only_known_signals_are_allowed() {
        assert_eq!(signal_from_name("TERM"), Some(libc::SIGTERM));
        #[cfg(unix)]
        assert_eq!(signal_from_name("CONT"), Some(libc::SIGCONT));
        assert_eq!(signal_from_name("SIGKILL"), None);
        assert_eq!(signal_from_name("9"), None);
        assert_eq!(signal_from_name(""), None);
    }
}
