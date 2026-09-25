//! `axcoding-agent` — a minimal coding agent on rig-core, with pi's philosophy.
//!
//! What "pi's ideas" concretely means here (verified against
//! earendil-works/pi and mariozechner.at):
//! - ONE explicit loop over an append-only transcript; the loop lives in
//!   `session::drive_turn` and this file, visible end to end. rig is
//!   plumbing, not a framework.
//! - Four tools: read/write/edit/bash, pi's default set. Nothing else.
//! - A sub-1000-token system prompt.
//!
//! Front-ends: an inline TUI (ratatui `Viewport::Inline`, finished content
//! flows into scrollback) when stdin/stdout are both a tty; a plain line
//! loop otherwise; one-shot when a task is given on argv. `--no-tui` (or
//! AXCODING_NO_TUI=1) forces the plain loop.
//!
//! Sessions: `--session-id <id>` (create-or-resume - one flag mints and
//! resumes, pi-style, which is what termic's mint shape expects) and
//! `--continue` (newest session in this directory). Persisted as JSONL at
//! `~/.axcoding/sessions/<id>.jsonl`, rewritten atomically after each
//! settled turn. Work state rides on native OSC 777 (`axcoding::osc`):
//! `agent working` / `agent done` per turn, `agent ready for input` +
//! `session <id>` at startup - termic routes these with no per-agent
//! tables on its side.
//!
//! One deliberate deviation from pi: `--max-turns` (default 50) exists
//! because an agent that can loop forever spends real money.

use anyhow::{bail, Context as _, Result};
use rig_core::client::CompletionClient;
use rig_core::providers::{anthropic, openai};
use std::sync::Arc;

use axcoding::auth::Provider;
use axcoding::llm_rig::RigLlm;
use axcoding::osc;
use axcoding::session::{drive_turn, UiEvent};
use axcoding::sessions::Session;
use axcoding::tui::{Tui, TuiSession};
use axcoding::Llm;

const SYSTEM: &str = "\
You are a minimal coding agent working in the user's current directory. \
You solve tasks with four tools: read (file, with line numbers), write \
(whole file), edit (one unique string replacement), bash (shell). \
Use bash for listing, searching (rg), git, and anything composite; prefer \
edit over write for small changes. Be concise. When the task is done, \
reply with a short summary and stop calling tools.";

enum Mode {
    /// One task from argv: transcript starts and ends with it.
    Run(String),
    /// Interactive. `tui` selects the inline TUI; the plain loop otherwise.
    Interactive { tui: bool },
}

fn plain_sink(ev: UiEvent) {
    match ev {
        // The tty already echoed the typed line; pipes stay clean.
        UiEvent::UserTask(_) => {}
        UiEvent::StreamDelta(_) => {}
        UiEvent::AssistantText { turn, text } => {
            eprintln!("──────── assistant (turn {turn}) ────────\n{text}");
        }
        UiEvent::ToolStart { name, args_summary } => {
            eprintln!("· tool {name} {args_summary}");
        }
        UiEvent::ToolEnd { output } => {
            eprintln!("  → {output}");
        }
        UiEvent::FinalAnswer(text) => println!("{text}"),
    }
}

/// Turn boundary, shared by all three modes. The TUI cannot wrap
/// `drive_turn` itself (the future is pinned and dropped on cancel, and the
/// CALLER truncates the transcript), so post-outcome work lives here,
/// outside the future.
fn turn_begin() {
    osc::emit(osc::WORKING);
}

/// Persist the settled transcript, then close the turn. Called on EVERY
/// outcome - Done, Failed, Cancelled - because once termic has seen the
/// working edge it owns the turn and must not be left "working" on a
/// failure. Cancelled arrives here already truncated, which is exactly the
/// rewrite-at-the-truncation-mark semantics the atomic full-rewrite gives.
fn turn_settle(
    session: &Option<Session>,
    transcript: &[axcoding::ChatMessage],
) -> Result<()> {
    let r = match session {
        Some(s) => s.save(transcript),
        None => Ok(()),
    };
    osc::emit(osc::DONE);
    r
}

fn cleared_note(session: &Option<Session>) -> &'static str {
    if session.is_some() {
        "(transcript cleared; the session file rewrites on the next task)"
    } else {
        "(transcript cleared)"
    }
}

async fn interactive_plain<L: Llm>(
    llm: Arc<L>,
    max_turns: u32,
    session: Option<Session>,
    mut transcript: Vec<axcoding::ChatMessage>,
) -> Result<()> {
    eprintln!("axcoding-agent: one task per line; Ctrl-D or --exit to quit.");
    osc::emit(osc::READY);
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
        match task {
            "--exit" => return Ok(()),
            "/clear" => {
                transcript.clear();
                eprintln!("{}", cleared_note(&session));
                continue;
            }
            _ => {}
        }
        turn_begin();
        // A failed turn does NOT kill the loop: termic classifies a fast
        // non-zero exit after a resume-shaped spawn as a FAILED RESUME and
        // respawns with a picker, and the transcript up to the failure is
        // real history (the TUI has kept it since the beginning).
        if let Err(e) = drive_turn(
            &llm,
            SYSTEM,
            &axcoding::tools::tool_specs(),
            &mut transcript,
            task,
            max_turns,
            plain_sink,
        )
        .await
        {
            eprintln!("error: {e}");
        }
        if let Err(e) = turn_settle(&session, &transcript) {
            eprintln!("error: session save failed: {e}");
        }
    }
}

async fn interactive_tui<L: Llm>(
    llm: Arc<L>,
    max_turns: u32,
    session: Option<Session>,
    mut transcript: Vec<axcoding::ChatMessage>,
) -> Result<()> {
    // A terminal that cannot host the inline viewport (dumb pty, DSR
    // unanswered) degrades to the plain loop instead of dying.
    let Ok(mut sess) = TuiSession::new() else {
        eprintln!("(terminal does not support the inline TUI; falling back to plain mode)");
        return interactive_plain(llm, max_turns, session, transcript).await;
    };
    osc::emit(osc::READY);

    let specs = axcoding::tools::tool_specs();

    loop {
        let Some(line) = sess.prompt().await else {
            return Ok(()); // Ctrl-D / Ctrl-C on empty
        };

        if line == "/clear" {
            transcript.clear();
            sess.tui.commit(cleared_note(&session));
            continue;
        }

        let (ui_tx, mut ui_rx) = TuiSession::event_channel::<UiEvent>();
        let mut sink = |ev: UiEvent| {
            let _ = ui_tx.send(ev);
        };
        // Mark BEFORE driving: a cancel rewinds to it (dropping the future
        // mid-flight can leave a dangling assistant tool_calls message,
        // which would 400 the next request). The block scope is what drops
        // the pinned future (and its transcript borrow) before the
        // post-processing below can truncate.
        let mark = transcript.len();
        turn_begin();
        let outcome = {
            let drive = drive_turn(
                &llm,
                SYSTEM,
                &specs,
                &mut transcript,
                &line,
                max_turns,
                &mut sink,
            );
            tokio::pin!(drive);
            let apply = |tui: &mut Tui, ev: UiEvent| match ev {
                // Echo the question into scrollback, above the reply.
                UiEvent::UserTask(task) => tui.commit(&format!("> {task}")),
                UiEvent::StreamDelta(d) => tui.push_live(&d),
                UiEvent::AssistantText { .. } => {}
                UiEvent::ToolStart { name, args_summary } => {
                    tui.commit(&format!("· tool {name} {args_summary}"));
                }
                UiEvent::ToolEnd { output } => {
                    tui.commit(&format!("  → {output}"));
                }
                UiEvent::FinalAnswer(text) => tui.commit(&text),
            };
            sess.run_busy(drive, &mut ui_rx, apply).await?
        };
        match outcome {
            axcoding::tui::BusyOutcome::Done(()) => {}
            axcoding::tui::BusyOutcome::Failed(_) => {
                // The error line is already committed by run_busy; the
                // transcript up to the failure is real history and stays.
            }
            axcoding::tui::BusyOutcome::Cancelled => {
                transcript.truncate(mark);
                sess.tui.commit("(cancelled)");
            }
        }
        // Cancelled lands here already truncated: the settle rewrites the
        // file at the truncation mark. A save failure is a committed note,
        // not a loop exit - a long-running session must survive a full disk.
        if let Err(e) = turn_settle(&session, &transcript) {
            sess.tui.commit(&format!("(session save failed: {e})"));
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut model: Option<String> = None;
    let mut max_turns: u32 = 50;
    let mut check_auth = false;
    let mut no_tui = std::env::var("AXCODING_NO_TUI")
        .map(|v| v == "1")
        .unwrap_or(false);
    let mut import_force = false;
    let mut session_id: Option<String> = None;
    let mut continue_latest = false;
    let mut task: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--model" => model = Some(args.next().expect("--model needs a value")),
            "--max-turns" => {
                max_turns = args.next().expect("--max-turns needs a value").parse()?;
            }
            "--check-auth" => check_auth = true,
            "--no-tui" => no_tui = true,
            "--force" => import_force = true,
            "--session-id" => session_id = Some(args.next().expect("--session-id needs a value")),
            "--continue" => continue_latest = true,
            other => task.push(other.to_string()),
        }
    }
    if session_id.is_some() && continue_latest {
        bail!("--session-id and --continue are mutually exclusive");
    }

    if check_auth {
        return match axcoding::auth::resolve_from_process() {
            Ok(a) => {
                let kind = match a.kind {
                    axcoding::auth::AuthKind::ApiKey => "api-key",
                    axcoding::auth::AuthKind::AuthToken => "bearer",
                };
                print!(
                    "authenticated: {} via {} ({kind})",
                    match a.provider {
                        Provider::Anthropic => "anthropic",
                        Provider::OpenAi => "openai",
                    },
                    a.source,
                );
                if let Some(u) = &a.base_url {
                    print!(" -> {u}");
                }
                if let Some(m) = &a.model {
                    print!(" model={m}");
                }
                println!();
                Ok(())
            }
            Err(e) => {
                println!("{e}");
                std::process::exit(1);
            }
        };
    }

    // `auth import` copies the provider config from Claude Code's
    // settings.json env block (where cc-switch and friends write) into
    // the axcoding auth file.
    if task.first().map(String::as_str) == Some("auth") {
        if task.get(1).map(String::as_str) != Some("import") {
            bail!("usage: axcoding-agent auth import [--force]");
        }
        let claude =
            std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
                .join(".claude/settings.json");
        let settings = std::fs::read_to_string(&claude)
            .with_context(|| format!("read {}", claude.display()))?;
        let out = axcoding::auth::auth_file_path();
        let s = axcoding::auth::import_from_claude_settings(&settings, &out, import_force)?;
        println!("wrote {} (0600)", s.wrote.display());
        println!("  auth_token: {}, api_key: {}", s.auth_token, s.api_key);
        if let Some(u) = &s.base_url {
            println!("  base_url:   {u}");
        }
        if let Some(m) = &s.model {
            println!("  model:      {m}");
        }
        println!("note: a later provider switch in cc-switch does not update this copy; re-run with --force when you switch.");
        return Ok(());
    }

    // Auth is resolved once, up front, so a spawn with no credentials
    // fails LOUDLY here instead of mid-conversation.
    let auth = axcoding::auth::resolve_from_process().map_err(|e| anyhow::anyhow!("{e}"))?;
    // --model wins over the auth file's model, which wins over the default.
    let model = model.or_else(|| auth.model.clone());

    // Session resolution: `--session-id <id>` creates OR resumes (one flag
    // mints and resumes, which is byte-identical behavior for termic's mint
    // spawn and every later resume); `--continue` takes the newest session
    // in this directory. The `session <id>` report goes out at startup in
    // BOTH cases so termic binds the id actually in use. Notes go to stderr
    // BEFORE the TUI viewport exists - stderr writes inside an active
    // inline viewport corrupt its rows.
    let mut session: Option<Session> = None;
    let mut transcript: Vec<axcoding::ChatMessage> = Vec::new();
    if let Some(id) = &session_id {
        let s = Session::open(id)?;
        if s.resumed {
            transcript = s.transcript()?;
            eprintln!("(resumed session {id}, {} messages)", transcript.len());
        }
        osc::emit(&osc::session_body(id));
        session = Some(s);
    } else if continue_latest {
        match Session::latest()? {
            Some(s) => {
                transcript = s.transcript()?;
                eprintln!("(resumed session {}, {} messages)", s.id, transcript.len());
                osc::emit(&osc::session_body(&s.id));
                session = Some(s);
            }
            None => {
                eprintln!("(no previous session in this directory; starting fresh)");
            }
        }
    }

    let mode = if task.is_empty() {
        let tty = std::io::IsTerminal::is_terminal(&std::io::stdin())
            && std::io::IsTerminal::is_terminal(&std::io::stdout());
        Mode::Interactive { tui: tty && !no_tui }
    } else {
        Mode::Run(task.join(" "))
    };

    match auth.provider {
        Provider::Anthropic => {
            // One construction path for both credential kinds. Measured on
            // the bigmodel relay (2026-09-23): it accepts the token via
            // x-api-key AND via Authorization Bearer, so an
            // ANTHROPIC_AUTH_TOKEN from a switcher rides the same builder
            // as a plain API key. If a future relay rejects x-api-key,
            // that is the moment to add a Bearer path (rig's BearerAuth
            // cannot pass the anthropic builder's build(), which pins
            // Key == AnthropicKey; it needs a custom http_client).
            let mut b = anthropic::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let client = b.build()?;
            let llm = Arc::new(RigLlm::new(client.completion_model(
                model.as_deref().unwrap_or(anthropic::completion::CLAUDE_SONNET_4_6),
            )));
            run(llm, mode, max_turns, session, transcript).await
        }
        Provider::OpenAi => {
            let mut b = openai::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let client = b.build()?;
            let llm = Arc::new(RigLlm::new(client
                .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6))));
            run(llm, mode, max_turns, session, transcript).await
        }
    }
}

async fn run<L: Llm>(
    llm: Arc<L>,
    mode: Mode,
    max_turns: u32,
    session: Option<Session>,
    transcript: Vec<axcoding::ChatMessage>,
) -> Result<()> {
    match mode {
        Mode::Run(task) => {
            let mut transcript = transcript;
            turn_begin();
            let r = drive_turn(
                &llm,
                SYSTEM,
                &axcoding::tools::tool_specs(),
                &mut transcript,
                &task,
                max_turns,
                plain_sink,
            )
            .await;
            // The one-shot path PROPAGATES a save failure: its exit code
            // feeds termic's run-tab failed pill, and there is no loop to
            // keep alive.
            turn_settle(&session, &transcript)?;
            r
        }
        Mode::Interactive { tui: true } => {
            interactive_tui(llm, max_turns, session, transcript).await
        }
        Mode::Interactive { tui: false } => {
            interactive_plain(llm, max_turns, session, transcript).await
        }
    }
}
