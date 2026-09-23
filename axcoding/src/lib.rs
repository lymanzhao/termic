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

pub mod auth;
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

/// Where the playbook lives by default: `$AXCODING_HOME` or `$HOME/.axcoding/`,
/// shared across tasks and runs, so the self-improvement actually
/// accumulates. Same relocation the auth file honors, which is what makes
/// the dir a real login store. `--data` overrides. Falls back to CWD when
/// `$HOME` is unset (should not happen on macOS/Linux, but a hardcoded
/// panic would be worse).
pub fn default_data_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").ok();
    auth::axcoding_home(home.as_deref())
}

