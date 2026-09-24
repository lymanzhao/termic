# axcoding

Two research prototypes in one crate, developed in this repo and shipped
as termic task CLIs.

1. **`axcoding-agent`** — a minimal coding agent on rig-core, built with pi's
   (Mario Zechner, earendil-works) philosophy.
2. **`axcoding-rlm`** — a Self-Improving RLM (Recursive Language Model) harness in
   Rust, a study of Prime Intellect's prime-agent
   (arXiv:2608.23552, "Prime Agent: A Self-Improving RLM Harness") rebuilt
   around the ideas that matter. Research notes: `NOTES-prime-agent.md`.

The two share one seam: the `Llm` trait (`src/lib.rs`) — one completion,
no loop. Backends: `llm_fake::ScriptedLlm` (tests, zero network) and
`llm_rig::RigLlm` (rig-core 0.42 provider plumbing, verified against the
crate source, not docs).

## Install (for use outside this repo, e.g. as a termic agent)

```sh
cargo install --path .   # puts axcoding-agent + axcoding-rlm on PATH
```

Auth resolves in order: env ANTHROPIC_API_KEY, env ANTHROPIC_AUTH_TOKEN (relay tokens, honored with ANTHROPIC_BASE_URL - what cc-switch writes), then `~/.axcoding/auth.json` (`AXCODING_HOME` relocates it), then env OPENAI_API_KEY. Same-provider env beats the file (session override); the file beats OTHER providers' env noise (a stray launchd OPENAI key must not hijack an imported GLM config). `--check-auth` reports what resolved. `auth import` copies the provider config from ~/.claude/settings.json (where cc-switch persists it) into the auth file (0600); re-run with `--force` after switching providers.

Interactive mode (no task argument) runs an inline TUI when stdin+stdout are a terminal: streaming output, one session across lines (follow-up questions share context), `/clear` resets the session, Ctrl-D exits, Ctrl-C cancels the in-flight task. Under a PTY host (termic) it just works; finished content flows into scrollback. Non-tty (pipes, scripts) or `--no-tui` / `AXCODING_NO_TUI=1` falls back to the plain one-task-per-line loop. `--max-turns` caps a task's model calls (default 50); `AXCODING_MAX_TOKENS` overrides the output budget (default 8192). The RLM playbook lives at ~/.axcoding/playbook.json across runs.

`axcoding-rlm` (no flags) also runs one task per stdin line - each line is a
full RLM run (map/slice/sub-call/submit + reflection), playbook shared across
runs. The context defaults to the CURRENT DIRECTORY, walked automatically
(skips .git/node_modules/target and binary extensions; 200k per-file,
2M total char caps) - in a termic task that is the worktree, which is the
point. `--context-file big.txt` overrides. Both binaries appear as task CLIs
in termic (axcoding, axcoding-rlm).

## Run

```sh
cargo test                                   # 46 tests, no network
cargo run --bin axcoding-rlm -- --fake                # full loop against a scripted model
cargo run --bin axcoding-rlm -- --provider anthropic --context-file big.txt --task "..." --data .axcoding-data
cargo run --bin axcoding-agent -- --provider anthropic "list the rust files here and count their lines"
```

Real runs resolve auth through the chain above (the auth file works
after `auth import`). Run `axcoding-rlm --task "..."` twice against the
same `--data` dir to see the playbook survive and shape the second run.

## What axcoding-agent shows (pi's ideas, concretely)

- ONE explicit loop over an append-only transcript; the loop is ~40 lines
  in `src/bin/axcoding_agent.rs`, readable end to end. rig is plumbing, not a
  framework (his words: the loop "just loops"; no hidden server state).
- pi's default four tools: read / write / edit / bash. Nothing else.
- Sub-1000-token system prompt.
- No hidden state: every event prints as it happens; the transcript Vec
  is the agent's entire state.
- One documented deviation: `--max-turns` (default 50) because a demo
  binary that can loop forever spends real money.

## What the RLM harness does

The root model never sees the long context. It gets the task and ONE tool
(`eval`) that runs a short Rhai script against the context store:

```
ctx_len() / ctx_slice(start, len) / ctx_find(pattern, after, max)
note(text) / notes()
llm(prompt)            sub-model call, no context
llm_ctx(prompt, ctx)   sub-model call, sees ONLY prompt+context
print(x) / submit(answer)
```

Loop: explicit (same shape as axcoding-agent). When the run ends, a reflection
call proposes JSON edits to the playbook; code applies them under
deterministic caps; the playbook persists and is rendered into every
future run's preamble. So the harness improves across runs.

`--fake` proves the whole chain: find the needle at offset 2500 of a
21k-char haystack, sub-call a 120-char slice, submit, reflect - and the
trace reports only 0.9% of the context was ever touched.

## What was adopted from prime-agent vs simplified

Adopted: immutable base preamble; persisted editable store the model only
touches via structured proposals; deterministic capped application
(caps, dedupe, version bumps); append-only refinement event log; empty
edits always allowed; digest into context; sub-calls see only their slice.

Simplified (deliberate, a prototype): one entry kind (`strategy`) instead
of four (prompt/memory/skill/subagent); no local/global scope split;
reflection after every run instead of an LLM review gate + cooldown;
in-process Rhai REPL instead of a persistent Python kernel subprocess (so
no shell, no filesystem - budgets instead of a sandbox); no compaction,
steering queue, or rollback replay. prime-agent is ~12.7M lines of TS;
this is ~1100 lines of Rust.

## Layout

```
src/lib.rs        shared types, Llm trait (the seam)
src/ctx.rs        context store: char-offset slice + regex find
src/repl.rs       Rhai REPL host, budgets, submit unwinding
src/playbook.rs   the self-improvement store + refinement log
src/harness.rs    the root loop + reflection pass
src/llm_fake.rs   scripted backend (tests/demo)
src/llm_rig.rs    rig-core 0.42 adapter
src/bin/axcoding_agent.rs the pi-style minimal agent
src/bin/axcoding_rlm.rs  the harness CLI
```
