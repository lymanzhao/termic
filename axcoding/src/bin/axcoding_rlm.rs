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

use anyhow::{bail, Result};
use rig_core::client::CompletionClient;
use rig_core::providers::{anthropic, openai};
use axcoding::harness::{Harness, HarnessCfg};
use axcoding::llm_fake::ScriptedLlm;
use axcoding::llm_rig::RigLlm;
use std::path::PathBuf;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    let mut fake = false;
    let mut provider_check: Option<String> = None;
    let mut data_dir = axcoding::default_data_dir();
    let mut task: Option<String> = None;
    let mut context_file: Option<String> = None;
    let mut model: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--fake" => fake = true,
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
            dispatch(Arc::new(llm), task, context_file, data_dir).await
        }
        axcoding::auth::Provider::OpenAi => {
            let mut b = openai::Client::builder().api_key(auth.key.clone());
            if let Some(u) = &auth.base_url {
                b = b.base_url(u.clone());
            }
            let llm = RigLlm::new(b.build()?
                .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6)));
            dispatch(Arc::new(llm), task, context_file, data_dir).await
        }
    }
}

async fn dispatch<L: axcoding::Llm>(
    llm: Arc<L>,
    task: Option<String>,
    context_file: Option<String>,
    data_dir: PathBuf,
) -> Result<()> {
    match task {
        Some(t) => run_real(llm, &t, context_file, data_dir).await,
        None => {
            // One RLM run per stdin line — the PTY-host interaction model.
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
                if let Err(e) = run_real(Arc::clone(&llm), task, context_file.clone(), data_dir.clone()).await {
                    eprintln!("error: {e}");
                }
            }
        }
    }
}

/// One real run: task + (big) context file -> harness -> trace.
async fn run_real<L: axcoding::Llm>(
    llm: Arc<L>,
    task: &str,
    context_file: Option<String>,
    data_dir: PathBuf,
) -> Result<()> {
    let context = match &context_file {
        Some(p) => std::fs::read_to_string(p)?,
        None => String::new(),
    };
    if context.is_empty() {
        eprintln!("warn: empty context; pass --context-file for a real RLM run");
    }
    let harness = Harness::new(llm, HarnessCfg { data_dir, ..HarnessCfg::default() });
    let trace = harness.run(task, &context).await?;
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
