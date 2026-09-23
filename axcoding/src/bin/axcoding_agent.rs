//! `axcoding-agent` — a minimal coding agent on rig-core, with pi's philosophy.
//!
//! What "pi's ideas" concretely means here (verified against
//! earendil-works/pi and mariozechner.at):
//! - ONE explicit loop over an append-only transcript; the loop lives in
//!   this file, visible end to end. rig is plumbing, not a framework.
//! - Four tools: read/write/edit/bash, pi's default set. Nothing else.
//! - A sub-1000-token system prompt.
//! - No hidden state: every event (assistant text, tool call, tool result)
//!   is printed as it happens. The transcript Vec IS the agent's state.
//!
//! One deliberate deviation: `--max-turns` (default 50) exists because a
//! demo binary that can loop forever spends real money; pi itself has no
//! such knob ("the loop just loops"). Pass a huge N to get pi semantics.

use anyhow::{bail, Result};
use rig_core::client::{CompletionClient, ProviderClient};
use rig_core::providers::{anthropic, openai};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

use axcoding::llm_rig::RigLlm;
use axcoding::{ChatMessage, Llm, ToolSpec};

const SYSTEM: &str = "\
You are a minimal coding agent working in the user's current directory. \
You solve tasks with four tools: read (file, with line numbers), write \
(whole file), edit (one unique string replacement), bash (shell). \
Use bash for listing, searching (rg), git, and anything composite; prefer \
edit over write for small changes. Be concise. When the task is done, \
reply with a short summary and stop calling tools.";

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

fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "read",
            description: "Read a text file; returns lines numbered like `cat -n`."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        },
        ToolSpec {
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
        ToolSpec {
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
        ToolSpec {
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

async fn tool_read(path: &str) -> String {
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

async fn tool_write(path: &str, content: &str) -> String {
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

async fn tool_edit(path: &str, old: &str, new: &str) -> String {
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

async fn tool_bash(command: &str) -> String {
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
                axcoding::clip(&s, 20_000)
            }
        }
    }
}

async fn execute_tool(name: &str, args: serde_json::Value) -> String {
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

/// THE loop. Everything the agent is, in one function.
async fn run<L: Llm>(llm: Arc<L>, task: &str, max_turns: u32) -> Result<()> {
    let specs = tool_specs();
    // The transcript is the only state.
    let mut transcript = vec![ChatMessage::user(task)];

    for turn_no in 1..=max_turns {
        let turn = llm.complete(SYSTEM, &transcript, &specs).await?;
        if !turn.text.trim().is_empty() {
            eprintln!("──────── assistant (turn {turn_no}) ────────\n{}", turn.text);
        }
        if turn.tool_calls.is_empty() {
            println!("{}", turn.text);
            return Ok(());
        }
        transcript.push(ChatMessage::assistant_calls(turn.text, turn.tool_calls.clone()));
        for call in &turn.tool_calls {
            let args = serde_json::from_str(&call.args_json)
                .unwrap_or(serde_json::Value::Null);
            eprintln!(
                "· tool {} {}", call.name,
                axcoding::clip(&call.args_json, 200)
            );
            let out = execute_tool(&call.name, args).await;
            eprintln!("  → {}", axcoding::clip(&out, 400));
            transcript.push(ChatMessage::tool_result(
                call.id.clone(),
                call.name.clone(),
                out,
            ));
        }
    }
    bail!("turn cap {max_turns} reached without a final answer")
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut provider = "anthropic".to_string();
    let mut model: Option<String> = None;
    let mut max_turns: u32 = 50;
    let mut check_auth = false;
    let mut task: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--provider" => provider = args.next().unwrap_or_else(|| "anthropic".into()),
            "--model" => model = Some(args.next().expect("--model needs a value")),
            "--max-turns" => {
                max_turns = args.next().expect("--max-turns needs a value").parse()?;
            }
            "--check-auth" => check_auth = true,
            other => task.push(other.to_string()),
        }
    }

    if check_auth {
        let (ok, msg) = axcoding::auth_status(
            std::env::var("ANTHROPIC_API_KEY").ok().as_deref(),
            std::env::var("OPENAI_API_KEY").ok().as_deref(),
        );
        println!("{msg}");
        std::process::exit(if ok { 0 } else { 1 });
    }

    // One task on argv, or interactive: one task per stdin line. The
    // interactive mode is what a PTY host (termic) drives.
    let mode = if task.is_empty() {
        Mode::Interactive
    } else {
        Mode::Run(task.join(" "))
    };

    match provider.as_str() {
        "anthropic" => {
            let client = <anthropic::Client as ProviderClient>::from_env()?;
            let llm = Arc::new(RigLlm::new(client.completion_model(
                model.as_deref().unwrap_or(anthropic::completion::CLAUDE_SONNET_4_6),
            )));
            dispatch(llm, mode, max_turns).await
        }
        "openai" => {
            let client = <openai::Client as ProviderClient>::from_env()?;
            let llm = Arc::new(RigLlm::new(client
                .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6))));
            dispatch(llm, mode, max_turns).await
        }
        other => bail!("unknown provider {other:?} (anthropic | openai)"),
    }
}

enum Mode {
    Run(String),
    Interactive,
}

async fn dispatch<L: Llm>(llm: Arc<L>, mode: Mode, max_turns: u32) -> Result<()> {
    match mode {
        Mode::Run(task) => run(llm, &task, max_turns).await,
        Mode::Interactive => {
            eprintln!("axcoding-agent: one task per line; Ctrl-D or --exit to quit.");
            let mut line = String::new();
            loop {
                line.clear();
                match std::io::stdin().read_line(&mut line) {
                    Ok(0) => return Ok(()), // EOF
                    Ok(_) => {}
                    Err(e) => return Err(e.into()),
                }
                let task = line.trim();
                if task.is_empty() {
                    continue;
                }
                if task == "--exit" {
                    return Ok(());
                }
                if let Err(e) = run(Arc::clone(&llm), task, max_turns).await {
                    eprintln!("error: {e}");
                }
            }
        }
    }
}
