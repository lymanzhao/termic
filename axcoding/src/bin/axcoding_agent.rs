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
//! One deliberate deviation from pi: `--max-turns` (default 50) exists
//! because an agent that can loop forever spends real money.

use anyhow::{bail, Context as _, Result};
use crossterm::event::{KeyCode, KeyModifiers};
use rig_core::client::CompletionClient;
use rig_core::providers::{anthropic, openai};
use std::sync::Arc;

use axcoding::auth::Provider;
use axcoding::llm_rig::RigLlm;
use axcoding::session::{drive_turn, UiEvent};
use axcoding::tui::{Tui, TuiEvent};
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

async fn interactive_plain<L: Llm>(llm: Arc<L>, max_turns: u32) -> Result<()> {
    eprintln!("axcoding-agent: one task per line; Ctrl-D or --exit to quit.");
    let mut transcript = Vec::new();
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
                eprintln!("(transcript cleared)");
                continue;
            }
            _ => {}
        }
        drive_turn(
            &llm,
            SYSTEM,
            &axcoding::tools::tool_specs(),
            &mut transcript,
            task,
            max_turns,
            plain_sink,
        )
        .await?;
    }
}

async fn interactive_tui<L: Llm>(llm: Arc<L>, max_turns: u32) -> Result<()> {
    // A terminal that cannot host the inline viewport (dumb pty, DSR
    // unanswered) degrades to the plain loop instead of dying.
    let Ok(mut tui) = Tui::new() else {
        eprintln!("(terminal does not support the inline TUI; falling back to plain mode)");
        return interactive_plain(llm, max_turns).await;
    };
    tui.draw();

    // Blocking crossterm reader on its own thread; the async side selects
    // on the channel so Ctrl-C can cancel an in-flight task.
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<TuiEvent>();
    std::thread::spawn(move || loop {
        match Tui::read_event() {
            Ok(ev) => {
                if ev_tx.send(ev).is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    });

    let specs = axcoding::tools::tool_specs();
    let mut transcript: Vec<axcoding::ChatMessage> = Vec::new();

    loop {
        // ── prompt phase ──────────────────────────────────────────────
        tui.set_busy(false);
        let line = loop {
            tokio::select! {
                ev = ev_rx.recv() => match ev {
                    Some(TuiEvent::Key(k)) => {
                        if let Some(line) = tui.prompt_key(k) {
                            if line.is_empty() {
                                return Ok(()); // Ctrl-D / Ctrl-C on empty
                            }
                            break line;
                        }
                    }
                    Some(TuiEvent::Resize) => tui.draw(),
                    Some(_) => {}
                    None => return Ok(()),
                },
                _ = tokio::time::sleep(std::time::Duration::from_millis(120)) => {
                    tui.tick();
                }
            }
        };

        // Session commands.
        if line == "/clear" {
            transcript.clear();
            tui.commit("(transcript cleared)");
            continue;
        }

        // ── busy phase ────────────────────────────────────────────────
        tui.set_busy(true);
        let mark = transcript.len();
        let outcome = {
            // The sink forwards into a channel so nothing here borrows
            // `tui` while the drive future is alive: the select below
            // needs `tui` free for its tick arm. Events are applied on
            // the same tick that repaints, which also BATCHES streaming
            // deltas into one draw — painting per-delta positioned every
            // wide char with its own cursor move, and terminals render
            // that as separate glyph runs: visibly wider CJK spacing.
            let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel::<UiEvent>();
            let mut sink = |ev: UiEvent| {
                let _ = ui_tx.send(ev);
            };
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
            let outcome = loop {
                tokio::select! {
                    r = &mut drive => {
                        // Drain whatever the finished task still queued so
                        // the final answer paints before the status flips.
                        while let Ok(ev) = ui_rx.try_recv() {
                            apply(&mut tui, ev);
                        }
                        break Some(r);
                    }
                    ev = ui_rx.recv() => match ev {
                        Some(ev) => apply(&mut tui, ev),
                        None => {}
                    },
                    // The tick repaints batched deltas.
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        tui.tick();
                    }
                    ev = ev_rx.recv() => {
                        // Only Ctrl-C acts while busy; everything else
                        // (typed-ahead or stray mouse input) is dropped.
                        if let Some(TuiEvent::Key(k)) = ev {
                            if k.kind != crossterm::event::KeyEventKind::Release
                                && k.modifiers.contains(KeyModifiers::CONTROL)
                                && k.code == KeyCode::Char('c')
                            {
                                break None;
                            }
                        }
                    }
                }
            };
            outcome
        };
        tui.set_busy(false);
        match outcome {
            Some(Ok(())) => {}
            Some(Err(e)) => tui.commit(&format!("error: {e}")),
            // Cancelled mid-flight: rewind the transcript to before the
            // task so a half-finished assistant tool_calls message can't
            // poison the next request (providers 400 on dangling calls).
            None => {
                transcript.truncate(mark);
                tui.commit("(cancelled)");
            }
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
            other => task.push(other.to_string()),
        }
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
            run(llm, mode, max_turns).await
        }
        Provider::OpenAi => {
            let mut b = openai::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let client = b.build()?;
            let llm = Arc::new(RigLlm::new(client
                .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6))));
            run(llm, mode, max_turns).await
        }
    }
}

async fn run<L: Llm>(llm: Arc<L>, mode: Mode, max_turns: u32) -> Result<()> {
    match mode {
        Mode::Run(task) => {
            let mut transcript = Vec::new();
            drive_turn(
                &llm,
                SYSTEM,
                &axcoding::tools::tool_specs(),
                &mut transcript,
                &task,
                max_turns,
                plain_sink,
            )
            .await
        }
        Mode::Interactive { tui: true } => interactive_tui(llm, max_turns).await,
        Mode::Interactive { tui: false } => interactive_plain(llm, max_turns).await,
    }
}
