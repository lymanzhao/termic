//! The four agent tools (pi's default set: read/write/edit/bash) and the
//! schema specs handed to the model. Pure mechanics; policy (the system
//! prompt) lives in the binary.

use serde::Deserialize;
use serde_json::json;

const READ_MAX_CHARS: usize = 40_000;
const BASH_TIMEOUT_SECS: u64 = 120;

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old: String,
    new: String,
}

#[derive(Deserialize)]
struct BashArgs {
    command: String,
}

pub fn tool_specs() -> Vec<crate::ToolSpec> {
    vec![
        crate::ToolSpec {
            name: "read",
            description: "Read a text file; returns lines numbered like `cat -n`."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        },
        crate::ToolSpec {
            name: "write",
            description: "Create or overwrite a file with the given content.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        },
        crate::ToolSpec {
            name: "edit",
            description: "Replace `old` with `new` in a file. `old` must occur \
                          exactly once."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old": { "type": "string" },
                    "new": { "type": "string" }
                },
                "required": ["path", "old", "new"]
            }),
        },
        crate::ToolSpec {
            name: "bash",
            description: "Run a shell command (`sh -c`), 120s timeout; stdout+stderr."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "command": { "type": "string" } },
                "required": ["command"]
            }),
        },
    ]
}

pub async fn tool_read(path: &str) -> String {
    match std::fs::read(path) {
        Err(e) => format!("ERROR: {e}"),
        Ok(bytes) => match String::from_utf8(bytes) {
            Err(_) => "ERROR: not valid UTF-8".to_string(),
            Ok(s) => {
                let mut out = String::new();
                for (i, line) in s.lines().enumerate() {
                    out.push_str(&format!("{i:>6}\t{line}\n"));
                    if out.len() > READ_MAX_CHARS {
                        out.push_str(&format!(
                            "…[truncated at {READ_MAX_CHARS} bytes; use rg via bash]"
                        ));
                        break;
                    }
                }
                if out.is_empty() {
                    "(empty file)".to_string()
                } else {
                    out
                }
            }
        },
    }
}

pub async fn tool_write(path: &str, content: &str) -> String {
    if let Some(dir) = std::path::Path::new(path).parent() {
        if !dir.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    match std::fs::write(path, content) {
        Err(e) => format!("ERROR: {e}"),
        Ok(()) => format!("wrote {} bytes to {path}", content.len()),
    }
}

pub async fn tool_edit(path: &str, old: &str, new: &str) -> String {
    let s = match std::fs::read_to_string(path) {
        Err(e) => return format!("ERROR: {e}"),
        Ok(s) => s,
    };
    let first = s.find(old);
    let Some(at) = first else {
        return "ERROR: `old` not found in file".to_string();
    };
    if s[at + old.len()..].contains(old) {
        return "ERROR: `old` occurs more than once; add surrounding context to make it unique"
            .to_string();
    }
    match std::fs::write(path, s.replacen(old, new, 1)) {
        Err(e) => format!("ERROR: {e}"),
        Ok(()) => "edited".to_string(),
    }
}

pub async fn tool_bash(command: &str) -> String {
    let fut = tokio::process::Command::new("sh").arg("-c").arg(command).output();
    match tokio::time::timeout(std::time::Duration::from_secs(BASH_TIMEOUT_SECS), fut).await {
        Err(_) => format!("ERROR: timed out after {BASH_TIMEOUT_SECS}s"),
        Ok(Err(e)) => format!("ERROR: spawn failed: {e}"),
        Ok(Ok(out)) => {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            let err = String::from_utf8_lossy(&out.stderr);
            if !err.trim().is_empty() {
                s.push('\n');
                s.push_str(&err);
            }
            if s.trim().is_empty() {
                format!("(no output, exit status {:?})", out.status.code())
            } else {
                crate::clip(&s, 20_000)
            }
        }
    }
}

pub async fn execute_tool(name: &str, args: serde_json::Value) -> String {
    match name {
        "read" => match serde_json::from_value::<ReadArgs>(args) {
            Ok(a) => tool_read(&a.path).await,
            Err(e) => format!("ERROR: bad args: {e}"),
        },
        "write" => match serde_json::from_value::<WriteArgs>(args) {
            Ok(a) => tool_write(&a.path, &a.content).await,
            Err(e) => format!("ERROR: bad args: {e}"),
        },
        "edit" => match serde_json::from_value::<EditArgs>(args) {
            Ok(a) => tool_edit(&a.path, &a.old, &a.new).await,
            Err(e) => format!("ERROR: bad args: {e}"),
        },
        "bash" => match serde_json::from_value::<BashArgs>(args) {
            Ok(a) => tool_bash(&a.command).await,
            Err(e) => format!("ERROR: bad args: {e}"),
        },
        other => format!("ERROR: unknown tool {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn edit_enforces_unique_match() {
        let dir = std::env::temp_dir().join(format!("axcoding-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.txt");
        std::fs::write(&p, "alpha beta alpha\n").unwrap();
        // Two occurrences of "alpha": refused.
        let out = tool_edit(p.to_str().unwrap(), "alpha", "gamma").await;
        assert!(out.starts_with("ERROR: `old` occurs more than once"), "{out}");
        // Unique context: applied.
        let out = tool_edit(p.to_str().unwrap(), "beta alpha", "beta gamma").await;
        assert_eq!(out, "edited");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "alpha beta gamma\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_numbers_lines_and_handles_errors() {
        let dir = std::env::temp_dir().join(format!("axcoding-tools2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("g.txt");
        std::fs::write(&p, "one\ntwo\n").unwrap();
        let out = tool_read(p.to_str().unwrap()).await;
        assert!(out.contains("     0\tone"));
        assert!(out.contains("     1\ttwo"));
        let out = tool_read(p.with_extension("missing").to_str().unwrap()).await;
        assert!(out.starts_with("ERROR:"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
