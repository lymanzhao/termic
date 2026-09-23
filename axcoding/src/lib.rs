//! axcoding: research prototypes, not product code.
//!
//! Two things live here:
//! - `harness` / `repl` / `ctx` / `playbook`: a Self-Improving RLM harness.
//!   The root model never sees the long context; it explores it through a
//!   scripting REPL and may spend sub-model calls on slices it chooses.
//!   After each run a reflection step updates a persistent playbook.
//! - `bin/axcoding_agent.rs`: the same ideas stripped to pi's philosophy:
//!   an explicit loop over an append-only transcript, few tools, no magic.
//!
//! The `Llm` trait is the seam: real backends are thin adapters (rig),
//! tests drive everything through `llm_fake::ScriptedLlm` with no network.

pub mod ctx;
pub mod harness;
pub mod llm_fake;
pub mod llm_rig;
pub mod playbook;
pub mod repl;

use std::future::Future;

/// One tool invocation as the model produced it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON-encoded arguments, verbatim from the model.
    pub args_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

/// Minimal append-only transcript entry. Deliberately dumber than rig's
/// message model: the harness owns the loop, so it only needs this.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// For `Role::Tool`: which tool call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// For `Role::Tool`: the executed tool's name (providers want it on
    /// the result part).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            tool_calls: vec![],
            tool_call_id: None,
            tool_name: None,
        }
    }
    pub fn assistant_text(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls: vec![],
            tool_call_id: None,
            tool_name: None,
        }
    }
    pub fn assistant_calls(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
            tool_name: None,
        }
    }
    pub fn tool_result(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_calls: vec![],
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
        }
    }
}

/// What we tell the model a tool looks like. JSON Schema by convention.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// The model's side of one turn.
#[derive(Debug, Clone, Default)]
pub struct LlmTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// The only thing a backend must do: one completion, no loop.
/// The loop lives in `harness` (and in `bin/axcoding_agent.rs`) so it stays visible.
pub trait Llm: Send + Sync + 'static {
    fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> impl Future<Output = anyhow::Result<LlmTurn>> + Send;
}

/// Truncate for display without splitting a char.
pub fn clip(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let cut: String = s.chars().take(max_chars).collect();
    format!("{cut}…[+{} chars]", s.chars().count() - max_chars)
}

/// Where the playbook lives by default: `$HOME/.axcoding/`, shared across
/// tasks and runs, so the self-improvement actually accumulates. `--data`
/// overrides. Falls back to CWD when `$HOME` is unset (should not happen
/// on macOS/Linux, but a hardcoded panic would be worse).
pub fn default_data_dir() -> std::path::PathBuf {
    match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => std::path::PathBuf::from(h).join(".axcoding"),
        _ => std::path::PathBuf::from(".axcoding"),
    }
}

/// Pure so tests can run without touching process env.
/// Returns (authenticated, one-line status).
pub fn auth_status(anthropic: Option<&str>, openai: Option<&str>) -> (bool, String) {
    match (anthropic.filter(|k| !k.trim().is_empty()), openai.filter(|k| !k.trim().is_empty())) {
        (Some(_), Some(_)) => (true, "authenticated: ANTHROPIC_API_KEY + OPENAI_API_KEY".into()),
        (Some(_), None) => (true, "authenticated: ANTHROPIC_API_KEY".into()),
        (None, Some(_)) => (true, "authenticated: OPENAI_API_KEY".into()),
        (None, None) => (
            false,
            "not authenticated: set ANTHROPIC_API_KEY or OPENAI_API_KEY".into(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_status_reports_each_key_combination() {
        let (ok, msg) = auth_status(Some("k"), Some("k"));
        assert!(ok && msg.contains("ANTHROPIC") && msg.contains("OPENAI"));
        let (ok, msg) = auth_status(Some("k"), None);
        assert!(ok && msg.contains("ANTHROPIC"));
        let (ok, msg) = auth_status(None, Some("k"));
        assert!(ok && msg.contains("OPENAI"));
        let (ok, msg) = auth_status(None, None);
        assert!(!ok && msg.contains("not authenticated"));
        // Blank keys count as absent.
        let (ok, _) = auth_status(Some("  "), None);
        assert!(!ok);
    }

    #[test]
    fn default_data_dir_is_home_scoped() {
        // Only meaningful when HOME is set, which is the normal case.
        if std::env::var("HOME").map(|h| !h.is_empty()).unwrap_or(false) {
            let d = default_data_dir();
            assert!(d.ends_with(".axcoding"), "{d:?}");
        }
    }
}
