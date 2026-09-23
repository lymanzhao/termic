//! rig-core adapter: the only module that speaks rig's message dialect.
//!
//! We use rig for provider plumbing only (HTTP, auth, request/response
//! serialization). The agent loops live in `harness` and `bin/axcoding_agent.rs`,
//! explicit and inspectable, pi-style. API shapes below were verified
//! against rig-core 0.42.0 source, not docs.

use anyhow::{anyhow, Result};
use rig_core::completion::{CompletionModel, CompletionResponse, ToolDefinition};
use rig_core::message::{AssistantContent, Message};
use rig_core::streaming::StreamedAssistantContent;

use crate::{ChatMessage, EventStream, Llm, LlmTurn, Role, StreamEvent, ToolSpec};

/// Output budget sent with every request. The Anthropic endpoint REQUIRES
/// max_tokens, and rig only defaults it for model names it recognizes
/// (claude-*) - a relay model like `glm-5.3-flash[1M]` from the auth file
/// would hard-error without this. Override at runtime with
/// AXCODING_MAX_TOKENS.
pub const DEFAULT_MAX_TOKENS: u64 = 8192;

fn parse_max_tokens(raw: Option<&str>) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&t| t > 0)
        .unwrap_or(DEFAULT_MAX_TOKENS)
}

fn max_tokens_from_env() -> u64 {
    parse_max_tokens(std::env::var("AXCODING_MAX_TOKENS").ok().as_deref())
}

/// Wraps any provider model into our `Llm` trait.
pub struct RigLlm<M: CompletionModel> {
    model: M,
}

impl<M> RigLlm<M>
where
    M: CompletionModel + Clone + Send + Sync + 'static,
{
    pub fn new(model: M) -> Self {
        Self { model }
    }
}

/// Our transcript dialect -> rig's. Tool results ride as User messages
/// carrying a ToolResult part (rig's canonical shape); assistant messages
/// with tool calls carry Text + ToolCall parts.
fn to_rig(m: &ChatMessage) -> Message {
    match m.role {
        Role::User => Message::user(m.content.clone()),
        Role::Assistant => {
            if m.tool_calls.is_empty() {
                return Message::assistant(m.content.clone());
            }
            let mut content = Vec::new();
            if !m.content.is_empty() {
                content.push(AssistantContent::text(m.content.clone()));
            }
            for tc in &m.tool_calls {
                content.push(AssistantContent::tool_call(
                    tc.id.clone(),
                    tc.name.clone(),
                    serde_json::from_str(&tc.args_json)
                        .unwrap_or(serde_json::Value::Null),
                ));
            }
            Message::Assistant { id: None, content }
        }
        Role::Tool => Message::tool_result(
            m.tool_call_id.clone().unwrap_or_default(),
            m.tool_name.clone().unwrap_or_else(|| "tool".to_string()),
            m.content.clone(),
        ),
    }
}

fn to_tool_def(t: &ToolSpec) -> ToolDefinition {
    ToolDefinition {
        name: t.name.to_string(),
        description: t.description.clone(),
        parameters: t.parameters.clone(),
    }
}

impl<M> Llm for RigLlm<M>
where
    M: CompletionModel + Clone + Send + Sync + 'static,
{
    async fn complete(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<LlmTurn> {
        // Transcript rule: messages[0] is the conversation-opening user
        // message; rig wants it as the request prompt and everything else
        // as history (build() => [System(preamble)] + history + [prompt]).
        let (first, rest) = messages.split_first().ok_or_else(|| anyhow!("no messages"))?;
        let mut builder = self
            .model
            .completion_request(to_rig(first))
            .preamble(system.to_string())
            .max_tokens(max_tokens_from_env());
        if !rest.is_empty() {
            builder = builder.messages(rest.iter().map(to_rig));
        }
        if !tools.is_empty() {
            builder = builder.tools(tools.iter().map(to_tool_def).collect());
        }
        let resp: CompletionResponse = self
            .model
            .completion(builder.build())
            .await
            .map_err(|e| anyhow!("completion failed: {e}"))?;

        let mut text = String::new();
        let mut tool_calls = Vec::new();
        for part in &resp.choice {
            match part {
                AssistantContent::Text(t) => text.push_str(&t.text),
                AssistantContent::ToolCall(tc) => tool_calls.push(crate::ToolCall {
                    id: tc.id.as_str().to_string(),
                    name: tc.function.name.clone(),
                    args_json: tc.function.arguments.to_string(),
                }),
                _ => {}
            }
        }
        Ok(LlmTurn { text, tool_calls })
    }

    /// Real deltas. Same builder, `.stream()` instead of `.completion()`;
    /// text arrives as append-deltas, tool calls as ONE assembled event
    /// each (the incremental ToolCallDelta fragments are rig bookkeeping
    /// and are dropped here). Driven by a spawned task feeding a
    /// futures-channel, so the caller just awaits events.
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> Result<EventStream> {
        let (first, rest) = messages.split_first().ok_or_else(|| anyhow!("no messages"))?;
        let mut builder = self
            .model
            .completion_request(to_rig(first))
            .preamble(system.to_string())
            .max_tokens(max_tokens_from_env());
        if !rest.is_empty() {
            builder = builder.messages(rest.iter().map(to_rig));
        }
        if !tools.is_empty() {
            builder = builder.tools(tools.iter().map(to_tool_def).collect());
        }
        let resp = self
            .model
            .stream(builder.build())
            .await
            .map_err(|e| anyhow!("stream failed: {e}"))?;

        let (mut tx, rx) = futures::channel::mpsc::channel::<anyhow::Result<StreamEvent>>(16);
        tokio::spawn(async move {
            let mut resp = resp;
            use futures::{SinkExt, StreamExt};
            while let Some(item) = resp.next().await {
                let event = match item {
                    Ok(StreamedAssistantContent::Text(t)) => Ok(StreamEvent::Text(t.text)),
                    Ok(StreamedAssistantContent::ToolCall { tool_call, .. }) => {
                        Ok(StreamEvent::ToolCall(crate::ToolCall {
                            id: tool_call.id.as_str().to_string(),
                            name: tool_call.function.name.clone(),
                            args_json: tool_call.function.arguments.to_string(),
                        }))
                    }
                    Ok(_) => continue,
                    Err(e) => Err(anyhow!("stream error: {e}")),
                };
                if tx.send(event).await.is_err() {
                    return; // receiver went away: caller cancelled the turn
                }
            }
        });
        Ok(Box::pin(rx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rig_core::message::{ToolResult, UserContent};

    #[test]
    fn max_tokens_parsing_rejects_junk_and_zero() {
        assert_eq!(parse_max_tokens(None), DEFAULT_MAX_TOKENS);
        assert_eq!(parse_max_tokens(Some(" 4096 ")), 4096);
        assert_eq!(parse_max_tokens(Some("abc")), DEFAULT_MAX_TOKENS);
        assert_eq!(parse_max_tokens(Some("0")), DEFAULT_MAX_TOKENS);
        assert_eq!(parse_max_tokens(Some("-5")), DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn user_maps_to_user_text() {
        let m = to_rig(&ChatMessage::user("hello"));
        match m {
            Message::User { content } => {
                assert_eq!(content.len(), 1);
                assert!(matches!(content[0], UserContent::Text(_)));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn assistant_with_calls_keeps_text_and_calls() {
        let m = to_rig(&ChatMessage::assistant_calls(
            "thinking",
            vec![crate::ToolCall {
                id: "c1".into(),
                name: "eval".into(),
                args_json: r#"{"code":"1+1"}"#.into(),
            }],
        ));
        match m {
            Message::Assistant { content, .. } => {
                assert_eq!(content.len(), 2);
                assert!(matches!(content[0], AssistantContent::Text(_)));
                match &content[1] {
                    AssistantContent::ToolCall(tc) => {
                        assert_eq!(tc.function.name, "eval");
                        assert_eq!(tc.function.arguments["code"], "1+1");
                    }
                    other => panic!("wrong part: {other:?}"),
                }
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn tool_result_carries_call_id_and_name() {
        let m = to_rig(&ChatMessage::tool_result("c9", "eval", "42"));
        match m {
            Message::User { content } => match &content[0] {
                UserContent::ToolResult(ToolResult { call, name, .. }) => {
                    assert_eq!(call.as_str(), "c9");
                    assert_eq!(name, "eval");
                }
                other => panic!("wrong part: {other:?}"),
            },
            other => panic!("wrong variant: {other:?}"),
        }
    }
}

#[cfg(test)]
mod network_tests {
    use super::*;
    use crate::ChatMessage;
    use futures::StreamExt;
    use rig_core::client::CompletionClient;
    use rig_core::providers::anthropic;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "network: run with -- --ignored; uses the real relay"]
    async fn bigmodel_stream_smoke() {
        let auth = crate::auth::resolve_from_process().expect("auth");
        let mut b = anthropic::Client::builder().api_key(auth.key.clone());
        if let Some(u) = &auth.base_url {
            b = b.base_url(u.clone());
        }
        let model_name = auth.model.clone().unwrap_or_else(|| "glm-5.3-flash".into());
        let client = b.build().expect("client");
        let llm = RigLlm::new(client.completion_model(&model_name));
        let started = std::time::Instant::now();
        let mut s = llm
            .stream_turn(
                "answer in one short word",
                &[ChatMessage::user("只回答一个词：你好")],
                &[],
            )
            .await
            .expect("stream_turn");
        let mut first_at = None;
        let mut text = String::new();
        while let Some(ev) = s.next().await {
            match ev.expect("event") {
                StreamEvent::Text(d) => {
                    if first_at.is_none() {
                        first_at = Some(started.elapsed());
                        eprintln!("first delta at {first_at:?}");
                    }
                    text.push_str(&d);
                }
                StreamEvent::ToolCall(c) => eprintln!("tool call: {}", c.name),
            }
        }
        eprintln!("total {:?}, text: {text:?}", started.elapsed());
        assert!(!text.is_empty());
    }
}
