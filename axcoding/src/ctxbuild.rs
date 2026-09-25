//! Build a RLM context string from a directory: the task's worktree is the
//! natural long context when no --context-file is given. Guardrails keep a
//! runaway walk boring: ignored dir names, a binary-extention blacklist, a
//! NUL-byte check, per-file and total char caps.

use std::path::Path;

const IGNORED_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".venv",
    "__pycache__", ".e2e", ".idea", ".vscode", "DerivedData",
];

const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "ico", "icns", "pdf", "zip", "tar", "gz",
    "bin", "dylib", "so", "dll", "exe", "woff", "woff2", "ttf", "otf",
    "mp4", "mp3", "mov", "wasm", "dmg", "dsym", "svgz",
];

#[derive(Debug, Clone, Copy, Default)]
pub struct ContextSummary {
    pub files: usize,
    pub chars: usize,
    pub skipped_binary: usize,
    pub skipped_oversize: usize,
}

/// Walk `root`, concatenate text files as `===== path =====` sections.
/// Deterministic order (sorted by path). Caps are in CHARS.
pub fn build_from_dir(
    root: &Path,
    per_file_cap: usize,
    total_cap: usize,
) -> (String, ContextSummary) {
    let mut ctx = String::new();
    let mut sum = ContextSummary::default();
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    walk(root, root, 0, &mut files);

    for path in files {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // NUL byte in the first 8 KiB: binary, skip without decoding.
        if bytes.iter().take(8192).any(|&b| b == 0) {
            sum.skipped_binary += 1;
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        if text.chars().count() > per_file_cap {
            sum.skipped_oversize += 1;
            continue;
        }
        if sum.chars + text.chars().count() > total_cap {
            sum.skipped_oversize += 1;
            continue;
        }
        sum.files += 1;
        sum.chars += text.chars().count();
        ctx.push_str(&format!(
            "\n===== {} ({} chars) =====\n",
            rel,
            text.chars().count()
        ));
        ctx.push_str(&text);
        if !ctx.ends_with('\n') {
            ctx.push('\n');
        }
    }
    (ctx, sum)
}

fn walk(root: &Path, dir: &Path, depth: usize, files: &mut Vec<std::path::PathBuf>) {
    if depth > 8 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut sorted: Vec<std::fs::DirEntry> = entries.flatten().collect();
    sorted.sort_by_key(|e| e.file_name());
    for entry in sorted {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if IGNORED_DIRS.contains(&name.as_ref()) || name.starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, files);
        } else if ft.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if BINARY_EXTS.contains(&ext.as_str()) {
                continue;
            }
            files.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("axcoding-ctx-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("README.md"), "# hello\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join("node_modules/junk.js"), "ignored\n").unwrap();
        std::fs::write(dir.join("logo.png"), b"\x89PNG\r\n").unwrap();
        std::fs::write(dir.join("big.txt"), "x".repeat(5000)).unwrap();
        dir
    }

    #[test]
    fn builds_sections_skips_noise_and_respects_caps() {
        let dir = setup("a");
        let (ctx, sum) = build_from_dir(&dir, 200_000, 1_000_000);
        assert!(ctx.contains("===== README.md (8 chars) ====="));
        assert!(ctx.contains("# hello"));
        assert!(ctx.contains("===== src/main.rs (13 chars) ====="));
        assert!(ctx.contains("xxxxx"), "big.txt (5000) fits the 200k per-file cap");
        assert!(!ctx.contains("ignored"), "node_modules must be skipped");
        assert!(!ctx.contains("PNG"), "blacklisted extensions never reach the walk output");
        assert_eq!(sum.files, 3, "README + main.rs + big.txt");
        assert_eq!(sum.skipped_binary, 0, "png is ext-filtered at walk time");

        // per-file cap refuses big.txt (5000) AND main.rs (13) — both over 10.
        let (ctx2, sum2) = build_from_dir(&dir, 10, 1_000_000);
        assert!(!ctx2.contains("xxxxx"), "oversize file must be skipped");
        assert_eq!(sum2.skipped_oversize, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn total_cap_stops_accumulation() {
        let dir = setup("b");
        let (ctx, sum) = build_from_dir(&dir, 100, 20);
        assert!(sum.files < 2, "total cap 20 chars must refuse most files");
        assert!(ctx.chars().count() <= 200);
        std::fs::remove_dir_all(&dir).ok();
    }
}
