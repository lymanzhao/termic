//! `axcoding-rlm` — the Self-Improving RLM harness CLI.
//!
//! Task sources, in order of explicitness:
//! - `--task TEXT`  one run, then exit
//! - stdin          one run PER LINE (what a PTY host like termic drives);
//!                  EOF or `--exit` quits
//! - `--fake`       the scripted demo (no network), ignoring the above
//!
//! Auth is the same chain as axcoding-agent (env keys → switcher tokens →
//! auth.json); the playbook lives at `~/.axcoding/playbook.json` across
//! runs, which is the self-improvement.

use anyhow::{bail, Context as _, Result};
use rig_core::client::CompletionClient;
use rig_core::providers::{anthropic, openai};
use axcoding::harness::{Harness, HarnessCfg};
use axcoding::llm_fake::ScriptedLlm;
use axcoding::llm_rig::RigLlm;
use axcoding::tui::{Tui, TuiSession};
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    let mut fake = false;
    let mut no_tui = std::env::var("AXCODING_NO_TUI")
        .map(|v| v == "1")
        .unwrap_or(false);
    let mut provider_check: Option<String> = None;
    let mut data_dir = axcoding::default_data_dir();
    let mut task: Option<String> = None;
    let mut context_file: Option<String> = None;
    let mut model: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--fake" => fake = true,
            "--no-tui" => no_tui = true,
            "--provider" => provider_check = Some(args.next().expect("--provider needs a value")),
            "--model" => model = Some(args.next().expect("--model needs a value")),
            "--data" => {
                data_dir = PathBuf::from(args.next().expect("--data needs a value"));
            }
            "--task" => {
                task = Some(args.next().expect("--task needs a value"));
            }
            "--context-file" => {
                context_file = Some(args.next().expect("--context-file needs a value"));
            }
            other => {
                eprintln!("unknown flag {other}");
                bail!(
                    "usage: axcoding-rlm [--fake] [--provider anthropic|openai] [--model NAME] \
                     [--data DIR] [--task TEXT] [--context-file PATH]"
                );
            }
        }
    }

    if fake {
        return run_fake(
            &task.unwrap_or_else(|| {
                "Find the needle, say what surrounds it, and how deep into the hay it was."
                    .to_string()
            }),
            data_dir,
        )
        .await;
    }

    let auth = axcoding::auth::resolve_from_process().map_err(|e| anyhow::anyhow!("{e}"))?;
    if let Some(want_name) = &provider_check {
        let want = match want_name.as_str() {
            "anthropic" => axcoding::auth::Provider::Anthropic,
            "openai" => axcoding::auth::Provider::OpenAi,
            other => bail!("unknown provider {other:?} (anthropic | openai)"),
        };
        if auth.provider != want {
            bail!(
                "--provider {want_name} but the resolved credential is {}; \
                 unset the other credential or drop --provider",
                if auth.provider == axcoding::auth::Provider::Anthropic {
                    "anthropic"
                } else {
                    "openai"
                }
            );
        }
    }
    // --model wins over the auth file's model, which wins over the default.
    let model = model.or_else(|| auth.model.clone());

    match auth.provider {
        axcoding::auth::Provider::Anthropic => {
            let mut b = anthropic::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let llm = RigLlm::new(b.build()?.completion_model(
                model.as_deref().unwrap_or(anthropic::completion::CLAUDE_SONNET_4_6),
            ));
            let use_tui = interactive_tty(no_tui);
            dispatch(Arc::new(llm), task, context_file, data_dir, use_tui).await
        }
        axcoding::auth::Provider::OpenAi => {
            let mut b = openai::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let llm = RigLlm::new(b.build()?
                .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6)));
            let use_tui = interactive_tty(no_tui);
            dispatch(Arc::new(llm), task, context_file, data_dir, use_tui).await
        }
    }
}

fn interactive_tty(no_tui: bool) -> bool {
    !no_tui
        && std::io::IsTerminal::is_terminal(&std::io::stdin())
        && std::io::IsTerminal::is_terminal(&std::io::stdout())
}

async fn dispatch<L: axcoding::Llm>(
    llm: Arc<L>,
    task: Option<String>,
    context_file: Option<String>,
    data_dir: PathBuf,
    use_tui: bool,
) -> Result<()> {
    // The context, resolved ONCE for the session: an explicit file, or -
    // by default, and this is the termic case - the task's own directory
    // (cwd), which for a worktree task is exactly the long context the
    // RLM was built to work over. The note is returned for the caller to
    // display (stderr in plain mode, a committed line under the TUI -
    // stderr writes while an inline viewport is active would corrupt its
    // rows).
    let (context, note) = match &context_file {
        Some(p) => {
            let c = std::fs::read_to_string(p)
                .with_context(|| format!("read context file {p}"))?;
            let note = format!("context: {} chars from {}", c.chars().count(), p);
            (c, note)
        }
        None => {
            let (c, s) = axcoding::ctxbuild::build_from_dir(
                std::path::Path::new("."),
                200_000,
                2_000_000,
            );
            let note = format!(
                "context: {} files, {} chars from cwd (skipped: {} oversize, {} binary)",
                s.files, s.chars, s.skipped_oversize, s.skipped_binary
            );
            (c, note)
        }
    };

    match task {
        Some(t) => {
            eprintln!("{note}");
            run_real(llm, &t, &context, data_dir).await
        }
        None if use_tui => interactive_tui(llm, &context, &note, data_dir).await,
        None => {
            eprintln!("{note}");
            interactive_plain(llm, &context, data_dir).await
        }
    }
}

async fn interactive_tui<L: axcoding::Llm>(
    llm: Arc<L>,
    context: &str,
    note: &str,
    data_dir: PathBuf,
) -> Result<()> {
    // A terminal that cannot host the inline viewport degrades to plain.
    let Ok(mut sess) = TuiSession::new() else {
        eprintln!("(terminal does not support the inline TUI; falling back to plain mode)");
        return interactive_plain(llm, context, data_dir).await;
    };
    sess.tui.commit(note);

    loop {
        let Some(line) = sess.prompt().await else {
            return Ok(()); // Ctrl-D / Ctrl-C on empty
        };
        if line == "--exit" {
            return Ok(());
        }

        let (tx, mut rx) = TuiSession::event_channel::<axcoding::harness::HarnessEvent>();

        let outcome = {
            let llm = Arc::clone(&llm);
            let ctx = context.to_string();
            let dd = data_dir.clone();
            let line = line.clone();
            let fut = async move {
                let harness = Harness::new(llm, HarnessCfg { data_dir: dd, ..HarnessCfg::default() });
                let mut sink = |ev: axcoding::harness::HarnessEvent| {
                    let _ = tx.send(ev);
                };
                harness
                    .run_with_events(&line, &ctx, &mut sink)
                    .await
            };
            tokio::pin!(fut);
            let apply = |tui: &mut Tui, ev: axcoding::harness::HarnessEvent| match ev {
                axcoding::harness::HarnessEvent::UserTask(t) => tui.commit(&format!("> {t}")),
                axcoding::harness::HarnessEvent::Turn { text, .. } => tui.commit(&text),
                axcoding::harness::HarnessEvent::Eval { code, .. } => {
                    tui.commit(&format!("$ {code}"))
                }
                axcoding::harness::HarnessEvent::EvalOut { out } => {
                    tui.commit(&format!("  {out}"))
                }
                axcoding::harness::HarnessEvent::Answer(a) => tui.commit(&a),
            };
            sess.run_busy(fut, &mut rx, apply).await?
        };
        match outcome {
            axcoding::tui::BusyOutcome::Done(trace) => sess.tui.commit(&format!(
                "({} turns · {} evals · {} sub-calls · {} of {} chars touched)",
                trace.turns,
                trace.usage.evals,
                trace.usage.sub_calls,
                trace.usage.chars_touched,
                trace.ctx_chars
            )),
            axcoding::tui::BusyOutcome::Failed(_) => {}
            axcoding::tui::BusyOutcome::Cancelled => sess.tui.commit("(cancelled)"),
        }
    }
}

async fn interactive_plain<L: axcoding::Llm>(
    llm: Arc<L>,
    context: &str,
    data_dir: PathBuf,
) -> Result<()> {
    eprintln!("axcoding-rlm: one task per line; Ctrl-D or --exit to quit.");
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
        if let Err(e) = run_real(Arc::clone(&llm), task, context, data_dir.clone()).await {
            eprintln!("error: {e}");
        }
    }
}

/// One real run: task + context -> harness -> trace.
async fn run_real<L: axcoding::Llm>(
    llm: Arc<L>,
    task: &str,
    context: &str,
    data_dir: PathBuf,
) -> Result<()> {
    let harness = Harness::new(llm, HarnessCfg { data_dir, ..HarnessCfg::default() });
    let trace = harness.run(task, context).await?;
    println!("answer:     {:?}", trace.answer);
    println!("turns:      {}", trace.turns);
    println!("evals:      {}", trace.usage.evals);
    println!("sub_calls:  {}", trace.usage.sub_calls);
    println!("ctx chars:  {}", trace.ctx_chars);
    println!("touched:    {} chars", trace.usage.chars_touched);
    println!(
        "notes:      {}",
        if trace.notes.is_empty() { "(none)".to_string() } else { axcoding::clip(&trace.notes, 500) }
    );
    println!("playbook:   {:?}", trace.playbook_log);
    Ok(())
}

/// One full run against a scripted model: map, slice, sub-call, submit,
/// then a reflection pass that leaves one playbook entry for next time.
async fn run_fake(task: &str, data_dir: PathBuf) -> Result<()> {
    let mut llm = ScriptedLlm::new();
    llm.push_tool_turn(
        "Mapping the haystack.",
        vec![ScriptedLlm::tool(
            "c1",
            "eval",
            r#"{"code":"print(ctx_len()); print(ctx_find(\"NEEDLE\", 0, 10))"}"#,
        )],
    );
    llm.push_tool_turn(
        "Reading the region around the hit.",
        vec![ScriptedLlm::tool(
            "c2",
            "eval",
            r#"{"code":"let s = ctx_slice(2490, 120); print(llm_ctx(\"What surrounds the needle? One sentence.\", s)); note(\"found at 2500\")"}"#,
        )],
    );
    llm.push_tool_turn(
        "Done.",
        vec![ScriptedLlm::tool(
            "c3",
            "submit",
            r#"{"answer":"One golden needle, buried ~2500 chars deep in straw, flanked by ordinary hay lines."}"#,
        )],
    );
    llm.push_sub_text("One sentence about hay.");
    llm.push_sub_text(
        r#"{"add":[{"when":"needle in a haystack","strategy":"ctx_find to locate, then llm_ctx a ~600-char window around the hit"}],"update":[],"drop":[]}"#,
    );
    let harness = Harness::new(
        Arc::new(llm),
        HarnessCfg { data_dir, ..HarnessCfg::default() },
    );

    // ~10k chars of straw with exactly one needle, byte offset 2500.
    let mut ctx = String::new();
    for i in 0..260 {
        ctx.push_str(&format!("hay line {i}: straw straw straw straw straw straw straw\n"));
    }
    ctx.insert_str(2500, "NEEDLE: the golden needle lies here\n");
    for i in 260..390 {
        ctx.push_str(&format!("hay line {i}: straw straw straw straw straw straw straw\n"));
    }

    let trace = harness.run(task, &ctx).await?;
    println!("answer:     {:?}", trace.answer);
    println!("turns:      {}", trace.turns);
    println!("evals:      {}", trace.usage.evals);
    println!("sub_calls:  {}", trace.usage.sub_calls);
    println!("ctx chars:  {}", trace.ctx_chars);
    println!(
        "touched:    {} chars ({:.1}% of context)",
        trace.usage.chars_touched,
        100.0 * trace.usage.chars_touched as f64 / trace.ctx_chars as f64
    );
    println!("playbook:   {:?}", trace.playbook_log);
    Ok(())
}
