//! Scripted backend: every `complete()` pops the next queued turn and
//! records what it was asked. Lets the whole harness run in tests with
//! zero network and deterministic behavior.

use crate::{ChatMessage, Llm, LlmTurn, ToolCall, ToolSpec};
use anyhow::Result;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Debug, Clone)]
pub struct RecordedCall {
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub n_tools: usize,
    /// Content of the last User message, for asserting what the model saw.
    pub last_user_content: String,
}

#[derive(Default)]
pub struct ScriptedLlm {
    /// Turns for root-model calls (calls that were offered tools).
    root_turns: Mutex<VecDeque<LlmTurn>>,
    /// Texts for sub/reflection calls (no tools offered).
    sub_texts: Mutex<VecDeque<String>>,
    calls: Mutex<Vec<RecordedCall>>,
}

impl ScriptedLlm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a root-model turn that replies with plain text.
    pub fn push_text(&mut self, text: &str) {
        self.root_turns.lock().unwrap().push_back(LlmTurn {
            text: text.to_string(),
            tool_calls: vec![],
        });
    }

    /// Queue a root-model turn that issues tool calls.
    pub fn push_tool_turn(&mut self, text: &str, calls: Vec<ToolCall>) {
        self.root_turns.lock().unwrap().push_back(LlmTurn {
            text: text.to_string(),
            tool_calls: calls,
        });
    }

    /// Queue a reply for a tool-less call (REPL sub-calls, reflection).
    pub fn push_sub_text(&mut self, text: &str) {
        self.sub_texts.lock().unwrap().push_back(text.to_string());
    }

    pub fn tool(id: &str, name: &str, args_json: &str) -> ToolCall {
        ToolCall { id: id.to_string(), name: name.to_string(), args_json: args_json.to_string() }
    }

    pub fn recorded(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }
}

impl Llm for ScriptedLlm {
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<LlmTurn> {
        let last_user_content = messages
            .iter()
            .rev()
            .find(|m| m.role == crate::Role::User)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        self.calls.lock().unwrap().push(RecordedCall {
            system: system.to_string(),
            messages: messages.to_vec(),
            n_tools: tools.len(),
            last_user_content,
        });
        if tools.is_empty() {
            return Ok(LlmTurn {
                text: self
                    .sub_texts
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| "(scripted default: sub queue empty)".to_string()),
                tool_calls: vec![],
            });
        }
        Ok(self
            .root_turns
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(LlmTurn {
                text: "(scripted default: root queue empty)".to_string(),
                tool_calls: vec![],
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StreamEvent;

    fn one_tool() -> [ToolSpec; 1] {
        [ToolSpec { name: "eval", description: "t".into(), parameters: serde_json::json!({}) }]
    }

    #[tokio::test]
    async fn stream_turn_synthesizes_events_from_complete() {
        // The scripted backend takes the trait's DEFAULT stream_turn (it has
        // no real deltas), which proves the default wrapper works for any
        // backend that only implements complete().
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn(
            "thinking",
            vec![ScriptedLlm::tool("t1", "eval", r#"{"code":"1"}"#)],
        );
        use futures::StreamExt;
        let mut s = llm
            .stream_turn("sys", &[ChatMessage::user("hi")], &one_tool())
            .await
            .unwrap();
        let mut events = Vec::new();
        while let Some(ev) = s.next().await {
            events.push(ev.unwrap());
        }
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], StreamEvent::Text(t) if t == "thinking"));
        assert!(matches!(&events[1], StreamEvent::ToolCall(c) if c.name == "eval"));
    }

    #[tokio::test]
    async fn stream_turn_omits_empty_text_event() {
        let mut llm = ScriptedLlm::new();
        llm.push_text("");
        use futures::StreamExt;
        let mut s = llm.stream_turn("sys", &[], &one_tool()).await.unwrap();
        assert!(s.next().await.is_none());
    }

    #[tokio::test]
    async fn pops_turns_in_order_then_defaults() {
        let mut llm = ScriptedLlm::new();
        llm.push_text("one");
        llm.push_tool_turn("two", vec![ScriptedLlm::tool("t1", "eval", r#"{"code":"1"}"#)]);
        llm.push_sub_text("sub reply");
        let tools = [ToolSpec {
            name: "eval",
            description: "test tool".to_string(),
            parameters: serde_json::json!({}),
        }];
        let t1 = llm.complete("sys", &[ChatMessage::user("hi")], &tools).await.unwrap();
        assert_eq!(t1.text, "one");
        let t2 = llm.complete("sys", &[], &tools).await.unwrap();
        assert_eq!(t2.tool_calls[0].name, "eval");
        // No tools offered -> sub queue.
        let t3 = llm.complete("sys", &[], &[]).await.unwrap();
        assert_eq!(t3.text, "sub reply");
        let t4 = llm.complete("sys", &[], &tools).await.unwrap();
        assert!(t4.text.contains("root queue empty"));
        assert_eq!(llm.recorded().len(), 4);
    }
}
