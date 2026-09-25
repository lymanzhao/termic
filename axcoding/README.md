# axcoding

A research prototype developed in this repo and shipped as a termic
task CLI.

**`axcoding-agent`** — a minimal coding agent on rig-core, built with pi's
(Mario Zechner, earendil-works) philosophy.

The `Llm` trait (`src/lib.rs`) is the seam: one completion, no loop.
Backends: `llm_fake::ScriptedLlm` (tests, zero network) and
`llm_rig::RigLlm` (rig-core 0.42 provider plumbing, verified against the
crate source, not docs).

(A previous prototype, `axcoding-rlm` — a Self-Improving RLM harness
studying Prime Intellect's prime-agent, arXiv:2608.23552 — lived here
until 2026-09. It was removed: as a general task agent it could not
follow the user across turns, could not act on the environment, and
answered over a frozen snapshot of the directory. See git history for
the code and its research notes.)

## Install (for use outside this repo, e.g. as a termic agent)

```sh
cargo install --path .   # puts axcoding-agent on PATH
```

Auth resolves in order: env ANTHROPIC_API_KEY, env ANTHROPIC_AUTH_TOKEN (relay tokens, honored with ANTHROPIC_BASE_URL - what cc-switch writes), then `~/.axcoding/auth.json` (`AXCODING_HOME` relocates it), then env OPENAI_API_KEY. Same-provider env beats the file (session override); the file beats OTHER providers' env noise (a stray launchd OPENAI key must not hijack an imported GLM config). `--check-auth` reports what resolved. `auth import` copies the provider config from ~/.claude/settings.json (where cc-switch persists it) into the auth file (0600); re-run with `--force` after switching providers.

Interactive mode (no task argument) runs an inline TUI when stdin+stdout are a terminal: streaming output, one session across lines (follow-up questions share context), `/clear` resets the session, Ctrl-D exits, Ctrl-C cancels the in-flight task. Under a PTY host (termic) it just works; finished content flows into scrollback. Non-tty (pipes, scripts) or `--no-tui` / `AXCODING_NO_TUI=1` falls back to the plain one-task-per-line loop. `--max-turns` caps a task's model calls (default 50); `AXCODING_MAX_TOKENS` overrides the output budget (default 8192).

## Run

```sh
cargo test                                   # all tests, no network
cargo run --bin axcoding-agent -- --provider anthropic "list the rust files here and count their lines"
```

Real runs resolve auth through the chain above (the auth file works
after `auth import`).

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

## Layout

```
src/lib.rs        shared types, Llm trait (the seam)
src/llm_fake.rs   scripted backend (tests)
src/llm_rig.rs    rig-core 0.42 adapter
src/session.rs    drive_turn: the explicit tool loop
src/tools.rs      the four tool specs + execution
src/tui.rs        inline-TUI session plumbing (Viewport::Inline)
src/auth.rs       env -> auth.json credential resolution
src/bin/axcoding_agent.rs the agent CLI
```
