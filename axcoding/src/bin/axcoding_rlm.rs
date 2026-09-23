//! `axcoding-rlm` — the Self-Improving RLM harness CLI.
//!
//! `--fake` runs the whole loop against a scripted backend (no network):
//! find the needle, sub-call a slice, submit, reflect. Real providers wire
//! in through the rig backend in `../llm_rig.rs` (`--provider`).

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
    let mut mode = "fake".to_string();
    let mut data_dir = axcoding::default_data_dir();
    let mut task =
        "Find the needle, say what surrounds it, and how deep into the hay it was.".to_string();
    let mut context_file: Option<String> = None;
    let mut model: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--fake" => mode = "fake".to_string(),
            "--provider" => mode = args.next().unwrap_or_else(|| "anthropic".to_string()),
            "--model" => model = Some(args.next().expect("--model needs a value")),
            "--data" => {
                data_dir = PathBuf::from(args.next().expect("--data needs a value"));
            }
            "--task" => {
                task = args.next().expect("--task needs a value");
            }
            "--context-file" => {
                context_file = Some(args.next().expect("--context-file needs a value"));
            }
            other => {
                eprintln!("unknown flag {other}");
                bail!(
                    "usage: axcoding-rlm [--fake|--provider anthropic|openai] [--model NAME] \
                     [--data DIR] [--task TEXT] [--context-file PATH]"
                );
            }
        }
    }

    match mode.as_str() {
        "fake" => run_fake(&task, data_dir).await,
        "anthropic" | "openai" => {
            // Same auth chain as axcoding-agent: env keys, switcher tokens
            // (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL), then auth.json.
            let auth = axcoding::auth::resolve_from_process().map_err(|e| anyhow::anyhow!("{e}"))?;
            let want = if mode == "anthropic" {
                axcoding::auth::Provider::Anthropic
            } else {
                axcoding::auth::Provider::OpenAi
            };
            if auth.provider != want {
                bail!(
                    "--provider {mode} but the resolved credential is {}; \
                     unset the other credential or drop --provider",
                    if auth.provider == axcoding::auth::Provider::Anthropic { "anthropic" } else { "openai" }
                );
            }
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
                    run_real(Arc::new(llm), &task, context_file, data_dir).await
                }
                axcoding::auth::Provider::OpenAi => {
                    let mut b = openai::Client::builder().api_key(auth.key.clone());
                    if let Some(u) = &auth.base_url {
                        b = b.base_url(u.clone());
                    }
                    let llm = RigLlm::new(b.build()?
                        .completion_model(model.as_deref().unwrap_or(openai::completion::GPT_5_6)));
                    run_real(Arc::new(llm), &task, context_file, data_dir).await
                }
            }
        }
        other => bail!("unknown provider {other:?} (anthropic | openai); --fake also exists"),
    }
}

/// One real run: task + (big) context file -> harness -> trace.
/// Playbook lives in `data_dir`, so running twice shows the improvement.
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
    println!(
        "touched:    {} chars",
        trace.usage.chars_touched
    );
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
