//! The RLM harness: one explicit loop, pi-style. The root model gets the
//! task and the REPL surface, never the long context. After every run a
//! reflection step proposes playbook updates; the code applies them under
//! deterministic caps and persists them for the next run.

use anyhow::{anyhow, Context as _, Result};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

use crate::ctx::ContextStore;
use crate::playbook::{Playbook, Proposal};
use crate::repl::{Repl, ReplCfg, ReplUsage, REPL_DOCS};
use crate::{ChatMessage, Llm, LlmTurn, ToolSpec};

pub const SUB_SYSTEM: &str = "\
You are a focused sub-agent inside a larger harness. You receive exactly one \
prompt and, if present, a verbatim context slice; nothing else exists. Answer \
only from what you are given, be concise, and say so plainly if the slice is \
insufficient for the question.";

pub const ROOT_PREAMBLE: &str = "\
You are a task-solving agent. The context you need is potentially far too large \
to read whole, so it is NOT in this conversation: it lives in an external store \
addressed by character offset, reachable only through the `eval` tool.

`eval` runs a short script (the Rhai language, C-like syntax) and returns its \
printed output. Strategy that works: `ctx_find` to map the terrain, `ctx_slice` \
the regions that matter, `note` what you learn, and fan out `llm_ctx` sub-calls \
over slices; a sub-call sees nothing but its own prompt and slice. Finish by \
calling `submit(answer)` with your final answer.

Budgets (evals, sub-calls, slice sizes) are enforced. Errors come back as text: \
read them and adapt instead of retrying the same thing.";

pub const REFLECT_SYSTEM: &str = "\
You are the reflection module of an agent harness. You get a digest of one run \
(task, playbook that was available, how the agent spent its budget, what it \
produced). Output ONLY a JSON object of this exact shape:
{\"add\":[{\"when\":\"...\",\"strategy\":\"...\"}],\"update\":[{\"id\":\"...\",\"verdict\":\"win\"|\"miss\",\"revision\":\"...\"}],\"drop\":[\"...\"]}
Rules: propose at most 2 adds; only durable, reusable strategies, never \
task-specific trivia. Reference playbook ids exactly as given. A verdict says \
whether that strategy actually helped this run. If nothing generalizes, output \
{\"add\":[],\"update\":[],\"drop\":[]} and nothing else.";

#[derive(Debug, Clone)]
pub struct HarnessCfg {
    pub max_turns: u32,
    pub repl: ReplCfg,
    /// Where playbook.json lives.
    pub data_dir: PathBuf,
    pub reflect: bool,
}

impl Default for HarnessCfg {
    fn default() -> Self {
        Self {
            max_turns: 24,
            repl: ReplCfg::default(),
            data_dir: PathBuf::from(".rlm-data"),
            reflect: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct RunTrace {
    pub answer: Option<String>,
    pub turns: u32,
    pub usage: ReplUsage,
    pub ctx_chars: usize,
    pub notes: String,
    pub playbook_log: Option<String>,
}

pub struct Harness<L: Llm> {
    llm: Arc<L>,
    cfg: HarnessCfg,
}

impl<L: Llm> Harness<L> {
    pub fn new(llm: Arc<L>, cfg: HarnessCfg) -> Self {
        Self { llm, cfg }
    }

    fn tools() -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "eval",
                description: "Run a short script against the context store. \
                              The function surface is listed in the preamble."
                    .to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "code": { "type": "string" } },
                    "required": ["code"]
                }),
            },
            ToolSpec {
                name: "submit",
                description: "Finish the run with the final answer.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "answer": { "type": "string" } },
                    "required": ["answer"]
                }),
            },
        ]
    }

    pub async fn run(&self, task: &str, context: &str) -> Result<RunTrace> {
        let pb_path = self.cfg.data_dir.join("playbook.json");
        let mut playbook = Playbook::load(&pb_path);
        let ctx = Arc::new(ContextStore::new(context));
        let mut repl = Repl::new(
            Arc::clone(&ctx),
            Arc::clone(&self.llm),
            SUB_SYSTEM.to_string(),
            self.cfg.repl,
        );

        let preamble = match playbook.render() {
            p if p.is_empty() => format!("{ROOT_PREAMBLE}\n\nScript surface:\n{REPL_DOCS}"),
            p => format!("{ROOT_PREAMBLE}\n\n{p}\n\nScript surface:\n{REPL_DOCS}"),
        };
        let first_user = format!(
            "TASK: {}\n\nThe context is {} characters and is not shown to you. \
             Explore it with eval(); finish with submit(answer).",
            task,
            repl.ctx_len_chars(),
        );
        let mut messages = vec![ChatMessage::user(first_user)];
        let mut eval_log: Vec<String> = Vec::new();
        let mut used_nudge = false;
        let mut answer: Option<String> = None;
        let mut turns_used = 0u32;

        'outer: for _ in 0..self.cfg.max_turns {
            turns_used += 1;
            let turn: LlmTurn = self.llm.complete(&preamble, &messages, &Self::tools()).await?;

            if turn.tool_calls.is_empty() {
                if !used_nudge {
                    used_nudge = true;
                    messages.push(ChatMessage::assistant_text(turn.text.clone()));
                    messages.push(ChatMessage::user(
                        "Do not answer in plain text. Call eval(...) to keep working, \
                         or submit(answer) to finish.",
                    ));
                    continue;
                }
                // Second plain reply: accept the prose as the answer.
                answer = Some(turn.text);
                break;
            }

            messages.push(ChatMessage::assistant_calls(turn.text.clone(), turn.tool_calls.clone()));
            for call in turn.tool_calls.clone() {
                match call.name.as_str() {
                    "eval" => {
                        let code = arg_str(&call.args_json, "code").unwrap_or_default();
                        let out = if code.trim().is_empty() {
                            "ERROR: eval needs a \"code\" argument".to_string()
                        } else {
                            let o = repl.eval(&code);
                            eval_log.push(format!(
                                "$ {}\n  -> {}",
                                crate::clip(&code, 160),
                                crate::clip(&o, 200)
                            ));
                            o
                        };
                        messages.push(ChatMessage::tool_result(&call.id, call.name.clone(), out));
                    }
                    "submit" => match arg_str(&call.args_json, "answer") {
                        Some(a) if !a.trim().is_empty() => {
                            answer = Some(a);
                            messages.push(ChatMessage::tool_result(&call.id, call.name.clone(), "accepted"));
                            break 'outer;
                        }
                        _ => {
                            messages.push(ChatMessage::tool_result(
                                &call.id,
                                call.name.clone(),
                                "ERROR: submit needs a non-empty \"answer\"",
                            ));
                        }
                    },
                    other => {
                        messages.push(ChatMessage::tool_result(
                            &call.id,
                            call.name.clone(),
                            format!("ERROR: unknown tool {other:?}"),
                        ));
                    }
                }
            }
        }

        let mut playbook_log = None;
        if self.cfg.reflect {
            let usage = repl.usage();
            let digest = build_digest(
                task,
                answer.as_deref(),
                turns_used,
                usage,
                repl.ctx_len_chars(),
                &repl.notes(),
                &playbook.render(),
                &eval_log,
            );
            match self.llm.complete(REFLECT_SYSTEM, &[ChatMessage::user(digest)], &[]).await {
                Ok(t) => match parse_proposal(&t.text) {
                    Ok(p) => {
                        let log = playbook.apply(&p);
                        playbook_log = Some(log.clone());
                        let outcome = match &answer {
                            Some(a) => format!("submitted: {}", crate::clip(a, 200)),
                            None => "no answer".to_string(),
                        };
                        playbook.record_refinement("auto", vec![log], &outcome);
                        playbook.save(&pb_path).with_context(|| format!(
                            "save playbook to {}",
                            pb_path.display()
                        ))?;
                    }
                    Err(e) => {
                        eprintln!("warn: reflection unparseable ({e}): {}", crate::clip(&t.text, 300));
                    }
                },
                Err(e) => eprintln!("warn: reflection call failed: {e}"),
            }
        }

        Ok(RunTrace {
            answer,
            turns: turns_used,
            usage: repl.usage(),
            ctx_chars: repl.ctx_len_chars(),
            notes: repl.notes(),
            playbook_log,
        })
    }
}

fn arg_str(args_json: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(args_json)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

#[allow(clippy::too_many_arguments)]
fn build_digest(
    task: &str,
    answer: Option<&str>,
    turns: u32,
    usage: ReplUsage,
    ctx_chars: usize,
    notes: &str,
    playbook_rendered: &str,
    eval_log: &[String],
) -> String {
    let touched = usage.chars_touched;
    let ratio = if ctx_chars > 0 {
        format!("{:.1}%", 100.0 * touched as f64 / ctx_chars as f64)
    } else {
        "n/a".to_string()
    };
    let mut d = String::new();
    d.push_str(&format!("TASK: {}\n\n", crate::clip(task, 300)));
    if playbook_rendered.is_empty() {
        d.push_str("PLAYBOOK AT RUN TIME: (empty)\n\n");
    } else {
        d.push_str(&format!("PLAYBOOK AT RUN TIME:\n{playbook_rendered}\n\n"));
    }
    d.push_str(&format!(
        "RUN: turns={turns} evals={} sub_calls={} ctx_chars={ctx_chars} \
         chars_touched={touched} ({ratio})\n\n",
        usage.evals, usage.sub_calls
    ));
    if eval_log.is_empty() {
        d.push_str("EVALS: (none)\n\n");
    } else {
        d.push_str("EVALS:\n");
        for line in eval_log.iter().rev().take(12).collect::<Vec<_>>().iter().rev() {
            d.push_str(line);
            d.push('\n');
        }
        d.push('\n');
    }
    if notes.trim().is_empty() {
        d.push_str("NOTES: (none)\n\n");
    } else {
        d.push_str(&format!("NOTES:\n{}\n\n", crate::clip(notes, 500)));
    }
    d.push_str(&format!(
        "OUTCOME: {}",
        match answer {
            Some(a) => format!("submitted: {}", crate::clip(a, 800)),
            None => "no answer (budget exhausted before submit)".to_string(),
        }
    ));
    d
}

fn parse_proposal(text: &str) -> Result<Proposal> {
    let mut s = text.trim();
    if s.starts_with("```") {
        s = s.trim_start_matches("```");
        if let Some(end) = s.rfind("```") {
            s = &s[..end];
        }
        s = s.trim();
        if let Some(rest) = s.strip_prefix("json") {
            s = rest.trim();
        }
    }
    let start = s.find('{').ok_or_else(|| anyhow!("no JSON object in reflection"))?;
    let end = s.rfind('}').ok_or_else(|| anyhow!("no closing brace in reflection"))?;
    Ok(serde_json::from_str(&s[start..=end])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_fake::ScriptedLlm;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("axcoding-harness-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        d
    }

    fn cfg(dir: &std::path::Path) -> HarnessCfg {
        HarnessCfg { data_dir: dir.to_path_buf(), ..HarnessCfg::default() }
    }

    const CTX: &str = "alpha\nfind me here\nbeta\nfind me again\n";

    #[tokio::test(flavor = "multi_thread")]
    async fn eval_then_submit_happy_path_with_reflection() {
        let dir = tmp_dir("happy");
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn(
            "looking around",
            vec![ScriptedLlm::tool("c1", "eval", r#"{"code":"print(ctx_find(\"find\", 0, 5)); note(\"two hits\")"}"#)],
        );
        llm.push_tool_turn(
            "done",
            vec![ScriptedLlm::tool("c2", "submit", r#"{"answer":"the answer"}"#)],
        );
        llm.push_sub_text(r#"```json
            {"add":[{"when":"needle hunt","strategy":"ctx_find before ctx_slice"}],"update":[],"drop":[]}
            ```"#);
        let llm = Arc::new(llm);

        let trace = Harness::new(Arc::clone(&llm), cfg(&dir)).run("find things", CTX).await.unwrap();
        assert_eq!(trace.answer.as_deref(), Some("the answer"));
        assert_eq!(trace.turns, 2);
        assert_eq!(trace.usage.evals, 1);
        assert_eq!(trace.usage.sub_calls, 0);
        assert!(trace.playbook_log.as_deref().unwrap().contains("added p1"));

        let pb = Playbook::load(&dir.join("playbook.json"));
        assert_eq!(pb.entries.len(), 1);
        assert_eq!(pb.entries[0].when, "needle hunt");

        // The reflection call must have seen the eval the agent made.
        let calls = llm.recorded();
        let reflect = calls.last().unwrap();
        assert_eq!(reflect.system, REFLECT_SYSTEM);
        assert!(reflect.last_user_content.contains("ctx_find"));
        assert!(reflect.last_user_content.contains("two hits"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn plain_text_gets_one_nudge_then_prose_is_accepted() {
        let dir = tmp_dir("nudge");
        let mut llm = ScriptedLlm::new();
        llm.push_text("I think it is 42");
        llm.push_tool_turn("ok", vec![ScriptedLlm::tool("s", "submit", r#"{"answer":"42 via tool"}"#)]);
        let llm = Arc::new(llm);

        let trace = Harness::new(Arc::clone(&llm), cfg(&dir)).run("n", CTX).await.unwrap();
        assert_eq!(trace.answer.as_deref(), Some("42 via tool"));
        // Second call must contain the nudge.
        let calls = llm.recorded();
        assert!(calls[1].last_user_content.contains("submit(answer)"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_plain_texts_fall_back_to_prose_answer() {
        let dir = tmp_dir("prose");
        let mut llm = ScriptedLlm::new();
        llm.push_text("first thought");
        llm.push_text("final prose answer");
        let llm = Arc::new(llm);

        let trace = Harness::new(llm, cfg(&dir)).run("n", CTX).await.unwrap();
        assert_eq!(trace.answer.as_deref(), Some("final prose answer"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_tool_and_bad_submit_keep_the_loop_alive() {
        let dir = tmp_dir("badtool");
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn("?", vec![
            ScriptedLlm::tool("c1", "explode", "{}"),
            ScriptedLlm::tool("c2", "submit", r#"{"answer":""}"#),
        ]);
        llm.push_tool_turn("ok", vec![ScriptedLlm::tool("c3", "submit", r#"{"answer":"recovered"}"#)]);
        let llm = Arc::new(llm);

        let trace = Harness::new(Arc::clone(&llm), cfg(&dir)).run("n", CTX).await.unwrap();
        assert_eq!(trace.answer.as_deref(), Some("recovered"));
        let calls = llm.recorded();
        // Both tool results from the bad turn must be in the transcript.
        let transcript = format!("{:?}", calls[1].messages);
        assert!(transcript.contains("unknown tool"));
        assert!(transcript.contains("needs a non-empty"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sub_call_budget_reaches_the_model_as_text() {
        let dir = tmp_dir("sub");
        let mut llm = ScriptedLlm::new();
        llm.push_tool_turn(
            "fan out",
            vec![ScriptedLlm::tool(
                "c1",
                "eval",
                r#"{"code":"print(llm_ctx(\"a\", ctx_slice(0, 5))); print(llm_ctx(\"b\", ctx_slice(0, 5)))"}"#,
            )],
        );
        llm.push_tool_turn("done", vec![ScriptedLlm::tool("c2", "submit", r#"{"answer":"x"}"#)]);
        let llm = Arc::new(llm);

        let repl_cfg = ReplCfg { max_sub_calls: 1, ..ReplCfg::default() };
        let harness_cfg = HarnessCfg { repl: repl_cfg, ..cfg(&dir) };
        let trace = Harness::new(llm, harness_cfg).run("n", CTX).await.unwrap();
        assert_eq!(trace.usage.sub_calls, 1, "budget must hold at 1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_proposal_handles_fences_and_prose() {
        let p = parse_proposal(r#"```json
            {"add":[],"update":[],"drop":[]}
            ```"#).unwrap();
        assert!(p.add.is_empty());
        let p = parse_proposal(r#"Sure! Here it is: {"add":[{"when":"w","strategy":"s"}],"update":[],"drop":[]} hope that helps"#).unwrap();
        assert_eq!(p.add.len(), 1);
        assert!(parse_proposal("no json here").is_err());
    }

    #[test]
    fn digest_marks_empty_playbook_and_missing_answer() {
        let d = build_digest("t", None, 3, ReplUsage::default(), 100, "", "", &[]);
        assert!(d.contains("PLAYBOOK AT RUN TIME: (empty)"));
        assert!(d.contains("no answer"));
    }
}
