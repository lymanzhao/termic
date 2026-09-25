//! Persisted session FILES: one JSONL per session at
//! `<axcoding_home(HOME)>/sessions/<id>.jsonl`. Line 1 is a metadata header,
//! lines 2.. are `ChatMessage`. (`session.rs` is one turn; this file is the
//! files.) The whole file is rewritten atomically after each settled turn, so
//! a cancelled turn - which truncates the in-memory transcript - can never
//! leave the file diverged from memory.

use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use crate::ChatMessage;

/// Session ids reach a filename AND termic's `session <id>` OSC body, whose
/// consumer (`hookOscSessionId` in termic's agentHooks.ts) accepts a UUID or
/// devin's slug rule: first byte alphanumeric, then only `[0-9a-zA-Z_-]`,
/// 1..=128. Validated here too so nothing reaches either place that the
/// other side would drop.
pub const ID_MAX_LEN: usize = 128;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX_LEN
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id.chars().skip(1).all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn sessions_dir_for(home: Option<&str>) -> PathBuf {
    crate::auth::axcoding_home(home).join("sessions")
}

pub fn sessions_dir() -> PathBuf {
    sessions_dir_for(std::env::var("HOME").ok().as_deref())
}

/// Line 1 of every session file. Keyed `"axcoding"` because a `ChatMessage`
/// always has a `role`, so the two can never be confused when peeking.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Header {
    pub axcoding: u32,
    pub id: String,
    /// Absolute directory the session ran in; `--continue` resumes the
    /// newest file whose cwd matches the current one (termic's legacy
    /// cwd-resume premise: the agent's most recent session in THIS
    /// directory IS this task's session).
    pub cwd: String,
}

#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub path: PathBuf,
    pub cwd: String,
    /// True when the file already existed at `open` (a real resume).
    pub resumed: bool,
}

impl Session {
    /// Create-or-resume in the default dir with the process cwd.
    pub fn open(id: &str) -> Result<Self> {
        let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
        Self::open_in(&sessions_dir(), &cwd, id)
    }

    pub fn open_in(dir: &Path, cwd: &str, id: &str) -> Result<Self> {
        if !valid_id(id) {
            bail!(
                "invalid session id {id:?}: alphanumeric, then [0-9a-zA-Z_-], \
                 1..={ID_MAX_LEN} chars (UUIDs pass)"
            );
        }
        let path = dir.join(format!("{id}.jsonl"));
        Ok(Self {
            id: id.to_string(),
            resumed: path.exists(),
            path,
            cwd: cwd.to_string(),
        })
    }

    /// The persisted transcript; empty when the session is new.
    pub fn transcript(&self) -> Result<Vec<ChatMessage>> {
        transcript_from_path(&self.path)
    }

    /// Atomic full rewrite: header + one JSON message per line, written to a
    /// sibling temp file and renamed over the target. 0600 like the auth
    /// file - a transcript can hold anything the tools read.
    pub fn save(&self, transcript: &[ChatMessage]) -> Result<()> {
        let mut out = serde_json::to_string(&Header {
            axcoding: 1,
            id: self.id.clone(),
            cwd: self.cwd.clone(),
        })?;
        out.push('\n');
        for m in transcript {
            out.push_str(&serde_json::to_string(m)?);
            out.push('\n');
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create {}", dir.display()))?;
        }
        write_atomic(&self.path, out.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Newest session in the default dir whose cwd matches the process cwd.
    pub fn latest() -> Result<Option<Self>> {
        let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
        Self::latest_in(&sessions_dir(), &cwd)
    }

    pub fn latest_in(dir: &Path, cwd: &str) -> Result<Option<Self>> {
        let mut best: Option<(std::time::SystemTime, Session)> = None;
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
        };
        for entry in entries {
            let entry = entry.with_context(|| format!("read {}", dir.display()))?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(header) = peek_header(&path) else {
                continue; // headerless or unparsable: not ours to resume
            };
            if header.cwd != cwd {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(t, _)| modified > *t) {
                best = Some((
                    modified,
                    Self {
                        id: header.id,
                        path,
                        cwd: cwd.to_string(),
                        resumed: true,
                    },
                ));
            }
        }
        Ok(best.map(|(_, s)| s))
    }
}

/// First line only: a parseable `Header` means this file is a candidate for
/// `--continue`; anything else (empty, headerless, binary) is skipped.
fn peek_header(path: &Path) -> Option<Header> {
    let first = std::fs::read_to_string(path).ok()?;
    let line = first.lines().next()?;
    serde_json::from_str(line).ok()
}

fn transcript_from_path(path: &Path) -> Result<Vec<ChatMessage>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if i == 0 {
            // Tolerate a hypothetical headerless file: line 1 parses as a
            // header -> skip it, else it is a message.
            if serde_json::from_str::<Header>(line).is_ok() {
                continue;
            }
        }
        let m: ChatMessage = serde_json::from_str(line).with_context(|| {
            format!("{} line {}: {}", path.display(), i + 1, line)
        })?;
        out.push(m);
    }
    Ok(out)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .with_context(|| format!("write {}", tmp.display()))?;
        f.write_all(bytes)?;
    }
    std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_fake::ScriptedLlm;
    use crate::session::drive_turn;
    use std::sync::Arc;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("axcoding-sessions-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        d
    }

    const UUID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn id_validation_matches_termic_slug_rule() {
        assert!(valid_id(UUID));
        assert!(valid_id("brassy-polish"));
        assert!(valid_id("a"));
        assert!(valid_id(&"a".repeat(128)));
        assert!(!valid_id(""));
        assert!(!valid_id("-lead"));
        assert!(!valid_id(".lead"));
        assert!(!valid_id(".."));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("a b"));
        assert!(!valid_id(&"a".repeat(129)));
    }

    #[test]
    fn roundtrip_preserves_every_message_shape() {
        let dir = tmp_dir("roundtrip");
        let s = Session::open_in(&dir, "/w", UUID).unwrap();
        assert!(!s.resumed);
        let msgs = vec![
            ChatMessage::user("do the thing"),
            ChatMessage::assistant_text("thinking about it"),
            ChatMessage::assistant_calls(
                "calling",
                vec![
                    ScriptedLlm::tool("c1", "bash", r#"{"command":"ls"}"#),
                    ScriptedLlm::tool("c2", "read", r#"{"path":"x"}"#),
                ],
            ),
            ChatMessage::tool_result("c1", "bash", "file one\nfile two"),
            ChatMessage::assistant_text("done"),
        ];
        s.save(&msgs).unwrap();
        let s2 = Session::open_in(&dir, "/w", UUID).unwrap();
        assert!(s2.resumed);
        assert_eq!(s2.transcript().unwrap(), msgs);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_fields_roundtrip_to_identical_transcript() {
        let dir = tmp_dir("emptyfields");
        let s = Session::open_in(&dir, "/w", "s1").unwrap();
        let msgs = vec![ChatMessage::assistant_text(""), ChatMessage::user("x")];
        s.save(&msgs).unwrap();
        assert_eq!(Session::open_in(&dir, "/w", "s1").unwrap().transcript().unwrap(), msgs);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_is_an_atomic_full_rewrite() {
        let dir = tmp_dir("rewrite");
        let s = Session::open_in(&dir, "/w", "s1").unwrap();
        s.save(&vec![
            ChatMessage::user("one"),
            ChatMessage::assistant_text("two"),
            ChatMessage::user("three"),
        ])
        .unwrap();
        s.save(&vec![ChatMessage::user("only")]).unwrap();
        let raw = std::fs::read_to_string(&s.path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2, "header + 1 message, no stale tail: {raw}");
        assert!(raw.contains("\"only\""));
        assert!(!raw.contains("\"three\""));
        assert!(!s.path.with_extension("jsonl.tmp").exists(), "no temp left behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn cancel_truncation_mark_survives_a_rewrite() {
        let dir = tmp_dir("cancel");
        let s = Session::open_in(&dir, "/w", "s1").unwrap();
        let prior = vec![ChatMessage::user("before")];
        s.save(&prior).unwrap();

        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn("working", vec![ScriptedLlm::tool("c1", "bash", r#"{"command":"ls"}"#)]);
        let mut transcript = s.transcript().unwrap();
        let mark = transcript.len();
        // REAL tool specs: the scripted backend routes tool-less calls to a
        // different queue, and this test must exercise a turn that actually
        // dangles an assistant_calls message before the truncation.
        drive_turn(
            &Arc::new(llm),
            "sys",
            &crate::tools::tool_specs(),
            &mut transcript,
            "task",
            5,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert!(transcript.len() > mark + 1, "turn must have added tool traffic");
        // What the TUI does on cancel: rewind to the mark, then settle.
        transcript.truncate(mark);
        s.save(&transcript).unwrap();
        assert_eq!(s.transcript().unwrap(), prior, "file rewound to the mark");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_picks_newest_mtime_in_cwd() {
        let dir = tmp_dir("latest");
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["s1", "s2"] {
            Session::open_in(&dir, "/w", id).unwrap().save(&[ChatMessage::user(id)]).unwrap();
        }
        // s2 must win regardless of filesystem ordering: stamp it newer.
        let newer = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
        std::fs::File::options().append(true).open(dir.join("s2.jsonl")).unwrap()
            .set_modified(newer).unwrap();
        let got = Session::latest_in(&dir, "/w").unwrap().unwrap();
        assert_eq!(got.id, "s2");
        // Other cwd, no match -> None (fresh start, never an error).
        assert!(Session::latest_in(&dir, "/other").unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn latest_ignores_headerless_files() {
        let dir = tmp_dir("headerless");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("s1.jsonl"), "{\"role\":\"user\",\"content\":\"x\"}\n").unwrap();
        assert!(Session::latest_in(&dir, "/w").unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn open_rejects_invalid_ids_loudly() {
        let dir = tmp_dir("badid");
        let e = Session::open_in(&dir, "/w", "../escape").unwrap_err();
        assert!(e.to_string().contains("invalid session id"), "{e}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The runbook's resume test (docs/adding-an-agent.md §2): history saved
    /// by one process reaches the model in the next. The second turn uses an
    /// unknown tool so the test never touches a real shell.
    #[tokio::test]
    async fn remember_a_word_survives_a_session_roundtrip() {
        let dir = tmp_dir("remember");
        let s = Session::open_in(&dir, "/w", UUID).unwrap();

        let mut llm1 = ScriptedLlm::new();
        llm1.push_text("I will remember XYZZY");
        let mut transcript = Vec::new();
        drive_turn(
            &Arc::new(llm1),
            "sys",
            &crate::tools::tool_specs(),
            &mut transcript,
            "remember this",
            5,
            &mut |_| {},
        )
        .await
        .unwrap();
        s.save(&transcript).unwrap();

        // "Another process": reopen from disk, history comes back.
        let s2 = Session::open_in(&dir, "/w", UUID).unwrap();
        assert!(s2.resumed);
        let mut history = s2.transcript().unwrap();
        assert!(history.iter().any(|m| m.content.contains("XYZZY")));

        let mut llm2 = ScriptedLlm::new();
        llm2.push_tool_turn("checking", vec![ScriptedLlm::tool("c1", "echo", "{}")]);
        llm2.push_text("XYZZY");
        let llm2 = Arc::new(llm2);
        drive_turn(&llm2, "sys", &crate::tools::tool_specs(), &mut history, "what word?", 5, &mut |_| {})
            .await
            .unwrap();

        let calls = llm2.recorded();
        let second = calls.last().unwrap();
        // The loaded turn-1 history reached the model...
        assert!(second.messages.iter().any(|m| m.content.contains("XYZZY")));
        // ...and this turn's own tool result roundtripped into the transcript
        // the model saw (role Tool, our call id).
        assert!(second.messages.iter().any(|m| {
            m.role == crate::Role::Tool && m.tool_call_id.as_deref() == Some("c1")
        }));
        std::fs::remove_dir_all(&dir).ok();
    }
}
