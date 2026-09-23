//! One agent turn, driven against the append-only transcript, with every
//! observable step emitted as a `UiEvent`. The renderer (plain stderr in
//! non-tty mode, the inline TUI otherwise) is just a sink; the loop and
//! the transcript ownership live HERE so both front-ends stay thin.

use std::sync::Arc;

use crate::tools;
use crate::{ChatMessage, Llm, StreamEvent, ToolSpec};

/// Everything a front-end may want to show while a task runs. Owned strings
/// throughout — events cross into renderers that may outlive the borrow.
#[derive(Debug, Clone, PartialEq)]
pub enum UiEvent {
    /// Streaming text delta for the current assistant turn.
    StreamDelta(String),
    /// Mid-loop narration: this turn produced text AND tool calls.
    AssistantText { turn: u32, text: String },
    ToolStart { name: String, args_summary: String },
    ToolEnd { output: String },
    /// The turn produced no tool calls: this is the final answer.
    FinalAnswer(String),
}

/// Drive ONE task to completion against `transcript` (the user message is
/// appended here), emitting events to `sink`. `transcript` persists across
/// calls, which is what makes a multi-turn session: just call again.
pub async fn drive_turn<L, S>(
    llm: &Arc<L>,
    system: &str,
    specs: &[ToolSpec],
    transcript: &mut Vec<ChatMessage>,
    task: &str,
    max_turns: u32,
    mut sink: S,
) -> anyhow::Result<()>
where
    L: Llm,
    S: FnMut(UiEvent),
{
    transcript.push(ChatMessage::user(task));
    let mut turns = 0u32;
    loop {
        turns += 1;
        if turns > max_turns {
            anyhow::bail!("turn cap {max_turns} reached without a final answer");
        }
        let mut stream = llm.stream_turn(system, transcript, specs).await?;
        let mut text = String::new();
        let mut calls: Vec<crate::ToolCall> = Vec::new();
        {
            use futures::StreamExt;
            while let Some(ev) = stream.next().await {
                match ev? {
                    StreamEvent::Text(delta) => {
                        text.push_str(&delta);
                        sink(UiEvent::StreamDelta(delta));
                    }
                    StreamEvent::ToolCall(c) => calls.push(c),
                }
            }
        }

        if calls.is_empty() {
            // Plain text IS the final answer (pi: "the loop just loops"
            // — it ends when the agent stops calling tools).
            transcript.push(ChatMessage::assistant_text(text.clone()));
            sink(UiEvent::FinalAnswer(text));
            return Ok(());
        }

        if !text.trim().is_empty() {
            sink(UiEvent::AssistantText { turn: turns, text: text.clone() });
        }
        transcript.push(ChatMessage::assistant_calls(text, calls.clone()));
        for call in calls {
            let args =
                serde_json::from_str(&call.args_json).unwrap_or(serde_json::Value::Null);
            sink(UiEvent::ToolStart {
                name: call.name.clone(),
                args_summary: crate::clip(&call.args_json, 200),
            });
            let out = tools::execute_tool(&call.name, args).await;
            sink(UiEvent::ToolEnd { output: crate::clip(&out, 400) });
            transcript.push(ChatMessage::tool_result(call.id.clone(), call.name, out));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_fake::ScriptedLlm;
    use crate::ToolSpec;

    fn one_tool() -> Vec<ToolSpec> {
        vec![ToolSpec { name: "bash", description: "t".into(), parameters: serde_json::json!({}) }]
    }

    #[tokio::test]
    async fn multi_turn_session_shares_transcript() {
        // Task A: two tool turns then a tool-less final answer. Task B's
        // FIRST request must already contain task A's messages — the whole
        // point of a session.
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn(
            "looking",
            vec![ScriptedLlm::tool("c1", "bash", r#"{"command":"pwd"}"#)],
        );
        llm.push_tool_turn(
            "answering",
            vec![ScriptedLlm::tool("c2", "bash", r#"{"command":"ls"}"#)],
        );
        llm.push_text("all done");
        let llm = Arc::new(llm);
        let mut transcript = Vec::new();
        let mut events = Vec::new();
        {
            let mut sink = |ev: UiEvent| events.push(ev);
            drive_turn(&llm, "sys", &one_tool(), &mut transcript, "task one", 5, &mut sink)
                .await
                .unwrap();
        }
        let seen = format!("{:?}", llm.recorded()[1].messages);
        assert!(seen.contains("pwd"), "tool result must be in transcript: {seen}");

        // Task two: its first request already contains task one's history.
        drive_turn(&llm, "sys", &one_tool(), &mut transcript, "task two", 5, &mut |_| {})
            .await
            .unwrap();
        let calls = llm.recorded();
        let req = calls.last().unwrap();
        let req_all = format!("{:?}", req.messages);
        assert!(req_all.contains("task one"), "session history must carry over");
        assert!(req_all.contains("task two"));
        assert!(events.iter().any(|e| matches!(e, UiEvent::FinalAnswer(t) if t == "all done")));
    }

    #[tokio::test]
    async fn stream_deltas_and_tool_events_are_emitted() {
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn(
            "hi ",
            vec![ScriptedLlm::tool("c1", "bash", r#"{"command":"pwd"}"#)],
        );
        let llm = Arc::new(llm);
        let mut transcript = Vec::new();
        let mut events = Vec::new();
        drive_turn(&llm, "sys", &one_tool(), &mut transcript, "t", 5, &mut |e| {
            events.push(e)
        })
        .await
        .unwrap();
        assert!(events.contains(&UiEvent::StreamDelta("hi ".into())));
        assert!(events.iter().any(
            |e| matches!(e, UiEvent::ToolStart { name, .. } if name == "bash")
        ));
        assert!(events.iter().any(|e| matches!(e, UiEvent::ToolEnd { .. })));
    }

    #[tokio::test]
    async fn turn_cap_errors_loudly() {
        // Two queued tool turns, cap 2: the third model call would be turn
        // 3, which is past the cap. (A tool-LESS reply would end the turn
        // as a final answer — the cap only binds a loop that keeps calling
        // tools.)
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn("a", vec![ScriptedLlm::tool("c1", "bash", r#"{"command":"x"}"#)]);
        llm.push_tool_turn("b", vec![ScriptedLlm::tool("c2", "bash", r#"{"command":"y"}"#)]);
        let llm = Arc::new(llm);
        let mut transcript = Vec::new();
        let r = drive_turn(&llm, "sys", &one_tool(), &mut transcript, "t", 2, &mut |_| {}).await;
        assert!(r.is_err());
        assert!(format!("{r:?}").contains("turn cap 2"));
    }
}
