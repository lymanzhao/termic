# prime-agent research notes

Source: https://github.com/PrimeIntellect-ai/prime-agent, read from `main`
(2026-09-23 snapshot, ~4,850 commits, MIT). Paper: "Prime Agent:
A Self-Improving RLM Harness" (arXiv:2608.23552), Alex L. Zhang is second
author. Everything below was verified against repo source, not the README.

## What it is

A TypeScript CLI/TUI coding-and-research agent built ON TOP of Mario
Zechner's `pi` agent framework (so "pi's philosophy" and prime-agent are the
same lineage: pi = minimal loop, prime-agent = what you build on it).
Packages: `pi-agent-core` (loop), `pi-ai` (providers), `coding-agent`
(AgentSession, 15k lines), `tui`, and a Python runtime installed into a
per-agent uv venv that hosts the REPL kernel.

## RLM meaning

Recursive Language Model, the MIT concept (Zhang, Kraska, Khattab; blog Oct
2025, arXiv:2512.24601): context is a *variable* in a persistent REPL
("prompt-as-a-variable"), tools and recursive sub-agents are *function calls*
in that REPL. prime-agent operationalizes it: one `ipython` tool; the model
writes Python; `rlm.spawn(prompt)` creates real recursive child agent
sessions (max depth 2 by default) that reply via files or messaging.

## The loop (agent-loop.ts, simplified)

```
messages += prompts
while true:
    while more tool calls or pending steering:
        msg = stream(model, {system: getSystemPrompt(), messages, tools})
        results = execute(tool_calls)          # parallel unless sequential tool
        messages += results
    pending = followUpMessages() or continuationMessages() or break
```

Details worth stealing:
- the system prompt is re-fetched fresh on EVERY stream call, so state
  changes apply mid-session without any swap machinery;
- three input queues: steering (mid-turn, user), follow-up (daemon),
  continuation (goals/heartbeats) - all consumed at safe boundaries;
- background `bash()` returns a handle immediately; a "finished" steering
  notice wakes the agent at the next boundary (nonblocking control loop).

## One-tool architecture

Exactly one native tool: `ipython` ("Execute Python code in a persistent
Python REPL... Run shell commands with bash('cmd')"). Sequential execution
mode. Files, edits, shell, skills, subagents, MCP, compaction - all Python
functions pre-imported in the kernel. Credentials/persistence/scheduling
stay OUT of the kernel behind a typed host bridge (`rlm.host_request`).

## The self-improving mechanism ("Continual Harness", /refine)

Base system prompt is IMMUTABLE. Improvement lives in a persisted store of
four entry kinds: `prompt` (supplemental notes), `memory` (durable
facts/failures/preferences), `skill` (Python call contracts), `subagent`
(reusable delegation specs). Entry shape:
`{id, kind, title, content, path, scope: local|global, reference, arguments,
metadata, source, created_at, updated_at, version}`. Stores: session-local
`<session>/harness/harness_state.json` + global
`~/.prime/agent/harness/harness_state.json` + append-only
`refinements.jsonl`. Kernel access via `rlm.harness.*`; writes re-read from
disk on mtime change (kernel and host don't clobber each other); atomic
tmp+rename saves; corrupt file degrades to empty.

Refinement pass (one LLM call, same model by default):
- input: conversation serialized, suffix kept via binary search to fit
  context; four tagged sections: `<current_harness_state>` (overview, up to
  40 entries), `<refinement_history>` (last 20), `<conversation>`,
  `<scope_policy>`, optional `<user_refine_instructions>`.
- output: JSON only: `{summary, rationale, expectedOutcome, edits:
  [{action: create|update|delete, kind, id, title, content, ...}]}`.
- system prompt rules (verbatim, condensed): "improve the editable
  continual harness state from the current trajectory... instead of
  summarizing you emit precise Create, Update, or Delete edits to reusable
  state... The base system prompt is immutable and MUST NOT be rewritten...
  Prefer small evidence-backed edits... If no useful edit is justified,
  return an empty edits array with a rationale."
- guards: `id == "base_system_prompt"` rejected; create-on-existing and
  update-on-missing fail per-edit without killing the batch; per-entry
  before/after snapshots; whole edit rejected if the entry changed on disk
  since planning.

Triggers: `/refine` (user), `await refine.run()` (self; queued, applied at
turn END, never mid-cell), auto gate: an LLM review ("Decide whether this
checkpoint should run /refine... Reject one-off noise") after every 25
assistant turns and at compaction boundaries, 20-minute cooldown.

How improvements reach the model (NOT via prompt rewrite):
1. harness digest rendered from the store, injected as a durable message at
   "cold boundaries" only (first turn, post-compaction, resume) and only
   when a sha256 render-fingerprint changed, so provider prefix caches
   survive; fresh digest REPLACES older ones; per-kind relevance ranking by
   weighted term overlap with IDF, CJK bigrams, stable tie-break.
2. refinement notice message: "[auto-refinement]\n<summary>\n- create
   memory [local:id] ..." so the model sees exactly what changed in place.

Rollback: `/refine --rollback <id>` replays inverse edits from before/after
snapshots. Evals: Short SWE slices of SWE-bench + swarm_fanout scored from
on-disk artifacts, never from the agent's claims.

## What axcoding adopts vs deliberately simplifies

Adopted: immutable base preamble; editable JSON store the LLM can only
touch via structured proposals; deterministic, capped application; empty
edits always allowed; refinement event log; versioned entries; digest
rendered into context; sub-calls see only their slice.

Simplified (fine for a prototype, listed so nobody mistakes them for
design conclusions): one entry kind (`strategy`) instead of four; no
local/global scope split; reflection after every run instead of an LLM
review gate + cooldown; Rhai in-process REPL instead of a persistent Python
kernel subprocess (no shell, no filesystem, budgets instead of sandbox);
no compaction, no steering queue, no rollback replay.
