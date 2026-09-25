# Agent-driven orchestration (research)

**Status: research, not a build order.** The question is not whether
agents can drive other tasks. They can, and they are already told how.
The question is whether the telling actually lands, and how much
orchestration shape termic should have an opinion about.

The plumbing exists and is complete. `termic new` creates a task and
starts its agent with a prompt, with `--wait`. `termic wait` blocks on a
work state. `termic send` pushes a message into a running task.
`termic result`, `termic logs`, `termic status`, `termic archive` close
the loop, all with `--output-format json`. Composed, that already
expresses "start B when A finishes", which is the primitive everyone is
racing to ship.

The telling exists too. Every spawned agent gets `TERMIC_CLI`,
`TERMIC_CLI_TOKEN`, `TERMIC_TASK_ID` and `TERMIC_CLI_HELP` in its
environment (`src-tauri/src/lib.rs`), and the help string is a real
tutorial: spawn with `--sandbox enforce --wait`, drop findings in
`RESULT.md`, prompt an existing task with `send --wait`, branch on exit
codes (0 done, 3 needs input, 7 timeout, 9 prompt not delivered), rename
your own task once you know what it is really about.

So the gap is narrower and more specific than "agents cannot
orchestrate". Two things:

1. **Env vars are passive.** `TERMIC_CLI_HELP` is only read if the agent
   happens to look at its environment. Nothing puts it in context. Xirp
   puts the equivalent text in the system prompt, where it is in context
   on turn one whether the agent goes looking or not.
2. **termic has no opinion about shape.** Nothing suggests fanning out,
   queueing, or a supervisor pattern. The surface is there, the intent
   is entirely the user's. That is a defensible position, and it is also
   possibly just an unmade decision.

## Prior art: how Xirp does it

Spotify's Xirp solves the same problem, and close to the way termic
already does: a control CLI, handed to the agent, plus worktree-per-task
underneath. The difference is the delivery, which is why it is worth
reading here rather than as trivia. Inspiration, not a spec.

Measured from a real install of Xirp 0.12.0 in August 2026. The full
teardown is at the [end of this doc](#appendix-xirp-0120-teardown); this
is the orchestration part.

Every session is launched with `--append-system-prompt` carrying a
tutorial for their own CLI. Paraphrased from the injected text:

- `chirp session new --goal "<task>" --name "<3-5 words>"` creates a
  session in the background, no view switch.
- `--new-branch <name>` names the worktree branch.
- `--depends-on [id]` queues the new session as a child that starts
  after the current one completes. With no id it uses the caller's own
  session id, which is available as `CHIRP_SESSION_ID` in the env.
- `--project <ref>` targets a different project by name, path or UUID.
- `--json` returns `{id, name, branch, worktreePath}`.

The injected prompt also carries trigger examples: "refactor the auth
module, and in parallel update the tests" spawns two sessions, "after
you're done with this, deploy to staging" spawns one with
`--depends-on`.

So their orchestration surface is not a UI. It is natural language, and
the API is the system prompt. Fan-out happens because the user asked for
two things in one sentence.

Worth noting: their own daemon log shows `chirp --help` failing with
`command not found` in the external build, so whether the injected
tutorial resolves end to end outside Spotify is unverified.

## Why this is interesting

The design bet is that nobody adopts a DAG editor. Given a canvas with
boxes and arrows, engineers will keep typing prompts instead. Putting
the orchestration in the prompt means the feature ships with no UI at
all, and the discovery problem is solved by the model rather than by
documentation.

The cost is that the graph stays implicit. You cannot see the shape
before it exists, you cannot replay it, and the agent decides how wide
to fan out. The trust question moves from "is this code correct" to
"did it fan out the way I meant".

Part of that is answered now: a task an agent creates joins the agent's
sidebar task group automatically (docs/ui.md "Task groups"), so the
fan-out is visible once it has happened. Seeing it before, replaying it,
and bounding its width are still open.

## Questions this research has to answer

1. **Does injection actually work?** Put termic's CLI surface into
   `--append-system-prompt` (or the equivalent for each agent) and see
   whether agents reach for it unprompted, at the right moments, without
   being nagged. Measure false starts too: an agent that spawns three
   tasks when the user wanted one is worse than an agent that spawns
   none.
2. **What is the minimum prompt?** Every token of injected tutorial is
   paid on every turn of every session. Xirp's is roughly 200 words.
   Find the shortest text that produces correct behaviour, or decide
   this belongs in MCP tool definitions instead, where the schema is the
   documentation (see [mcp.md](mcp.md)).
3. **Prompt injection or MCP?** These are alternatives, not a sequence.
   The prompt route works today for every agent that accepts a system
   prompt append, costs context on every turn, and gives no argument
   validation. The MCP route is typed, discoverable and per-task
   scoped, but it only reaches MCP-capable clients and is still in
   design.
4. **Is a canonical session IR worth building?** Xirp's handoff proves
   the shape works: an agent-neutral entry list plus a per-harness
   codec, writing the target's own native session file and resuming
   into it. termic has no cross-harness handoff at all today. That is a
   bigger feature than orchestration and it is now a known-solvable
   problem rather than a marketing claim.
5. **Does `--depends-on` need to exist?** `termic wait <task> && termic
   send ...` already composes it. A dedicated flag is one call instead of
   two, and it survives the caller's own session ending. Decide whether
   that is worth a new surface.
6. **How much shape do we bake in?** Fan out, queue behind, supervisor
   and workers. Today termic bakes in none: the user asks, the tool
   obeys. That is a defensible position and it is also possibly just
   indecision. Xirp picked "the model decides, in English". A third
   option is to make the intended shape visible before it runs, without
   drawing a graph.
7. **Opt-in or default?** An agent that can spawn agents is a cost
   multiplier and a blast-radius multiplier. If injection ships, it
   almost certainly ships behind a toggle, and possibly with a cap on
   depth or on total spawned tasks.

## The sandbox constraint

Caged agents get no CLI at all. `sandbox.rs` denies the data dir and the
control socket, and [../plans/cli.md](../plans/cli.md) settles that
deliberately: granting an agent the CLI is granting terminal access.

So injecting a CLI tutorial into a sandboxed session teaches it to reach
for something it cannot have, which is worse than silence. Either
injection is skipped for caged tasks, or orchestration for caged agents
rides the per-task bearer token described in
[mcp.md](mcp.md), which was designed for exactly this.

## What termic already has

For reference, so the research does not rebuild it:

| Need | Command |
|---|---|
| Create a task, start the agent, inject a prompt | `termic new` |
| Adopt an existing worktree instead of creating one | `termic new --from <path>` |
| Resume a specific agent session | `termic new --resume <session-id>` |
| Block until a task reaches a work state | `termic wait` |
| Push a message into a running task | `termic send` |
| Read a task's outcome / logs | `termic result`, `termic logs` |
| Inspect state, diff, path | `termic status`, `termic diff`, `termic path` |
| Clean up | `termic archive` |

All of it is JSON-capable via `--output-format json`, which matters if
an agent is the caller.

## Prior art: Spotify's published practice (Honk, Fleet Management)

Xirp is the small public half. Spotify has been writing about the big
private half for a year, and those posts are more useful than the app,
because they are about making unsupervised agents produce correct work
rather than about arranging terminals.

**Honk** is their background coding agent: Claude Agent SDK, running in
Kubernetes, driven by **Fleetshift** (their Fleet Management
orchestrator) which picks target repos, schedules, opens PRs and tracks
them. Kicked off from Slack, GitHub Enterprise or an IDE. 1,500+ merged
PRs by Nov 2025; 240 PRs in one dataset migration saving an estimated 10
engineering weeks; a Java migration across backend services in three
days; 60 to 90% time savings versus manual for migrations. Fleet
Management overall has merged **2.5 million** automated maintenance PRs,
most auto-merged without human review.

Their stated org-level numbers: 99% of engineers use AI coding tools
weekly, 94% report increased productivity, **76% more pull requests**.
Note the 99% is about AI tools generally, not about Xirp; the Xirp
launch claims 1,300+ engineers and 36,000+ sessions.

Four things from those posts are directly useful here.

**1. Verifiers as tools, auto-selected by the repo.** Verification is
exposed to the agent as MCP tools that activate based on what is in the
codebase (a `pom.xml` turns on the Maven verifier). Their line: "the
agent doesn't know what the verification does and how, it just knows
that it can (and in certain cases must) call it." Output is regex-parsed
so the agent sees only the relevant errors instead of a build log.

**2. Verification is gated on the Stop hook.** All relevant verifiers
run before a PR is created, via Claude Code's `Stop` hook, and a failing
verifier blocks the PR. This is the counterpoint to
[agent-hooks.md](../agent-hooks.md), which rules out blocking hooks for
termic. Their use case justifies blocking because the hook is a quality
gate on unsupervised work; ours would be observation only. Worth being
explicit that the two uses are different rather than assuming hooks are
observational by nature.

**3. "The Judge."** A separate LLM reviews the proposed diff against the
original prompt before the PR is opened. It **vetoes about 25%** of
thousands of sessions, and course correction succeeds roughly half of
those times. The most common trigger is scope creep: the agent
refactoring beyond what was asked. That is a cheap, measurable,
model-agnostic guardrail, and it maps onto a real termic feature: run a
judge over `termic diff` before the human ever looks.

**4. Containment is deliberate.** The agent may view code, edit files
and run verifiers. Pushing, talking to users and prompt authoring happen
outside it. It runs in "heavily sandboxed containers with minimal
permissions and restricted system access", and they explicitly traded
flexibility for predictability and security. They also deliberately
**withhold** code search and documentation tools, because dynamic
tool-fetching reduced predictability, and ask users to condense context
into the prompt up front so prompts stay testable and version
controllable.

That last point is Spotify's own engineering blog arguing termic's
sandbox thesis, at a scale nobody can dismiss.

Their prompting rules, worth stealing wholesale for termic's docs:
describe the end state rather than the steps (for Claude specifically),
state preconditions for when *not* to act because "agents are eager to
act on your prompt, to a fault", use concrete code examples, define a
verifiable goal rather than "improve this", one change per prompt, and
ask the agent afterwards what was missing from the prompt.

Sources: [Honk part 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1),
[part 2, context engineering](https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2),
[part 3, feedback loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3),
[part 4, dataset migrations](https://engineering.atspotify.com/2026/4/background-coding-agents-dataset-migrations-honk-part-4),
[Coding is no longer the constraint](https://engineering.atspotify.com/2026/6/code-with-claude-coding-is-no-longer-the-constraint).

## Appendix: Xirp 0.12.0 teardown

Kept here because the orchestration choice above only makes sense
alongside the rest of the architecture. Spotify opened Xirp to public
beta on 2026-08-10.

**Provenance.** Public site and docs, their published release manifest,
installing Xirp 0.12.0 on a Mac and using it, extracting `app.asar` and
reading the bundled daemon, dashboard and drizzle migrations, the log the
app writes to
`~/Library/Application Support/Xirp/xirp-external/xirp.log`, and reading
the shipped JavaScript and TypeScript declaration files under
`/Applications/Xirp.app/Contents/Resources/`. The
`.d.ts` files carry their internal design rationale verbatim, including
dated decision references, so most of the "why" below is theirs, not
inferred. Reviewed 2026-08-11.

### What it is

| | |
|---|---|
| Version measured | 0.12.0, released 2026-08-10 |
| Platforms | macOS only (arm64 + x64). Windows and Linux are a waitlist |
| License | Closed. No public repo, no license file |
| Price | App free in beta. Portal is a per-developer annual subscription, quoted by sales |
| Account | Spotify account required at first launch, via Auth0 |
| Agents | Claude Code, Codex, Gemini. No documented BYO path |
| Claimed scale | 1,300+ Spotify engineers, 36,000+ sessions, 100+ internal contributors |

### Distribution

`https://xirp.spotify.com/install.sh` pulls from
`https://reckless-finch.spotifycdn.com/external/`, reading
`latest-mac.yml`. That file is **electron-builder's** auto-update
manifest, which is the first confirmation of the runtime.

Published artifact sizes for 0.12.0:

| Artifact | Size |
|---|---|
| `Xirp-0.12.0-arm64-external.dmg` | 183 MB |
| `Xirp-0.12.0-x64-external.dmg` | 193 MB |
| `Xirp-0.12.0-arm64-external.zip` | 177 MB |

For comparison, termic 0.25.3 ships a 20 MB universal `.dmg`.

### Runtime architecture

**Electron.** `~/Library/Application Support/Xirp/` contains the
standard Chromium profile furniture: `blob_storage`, `Code Cache`,
`GPUCache`, `DawnWebGPUCache`, `Local Storage`, `Trust Tokens`,
`SingletonLock`.

**A separate daemon.** The Electron process connects as a client to a
second process listening on a loopback TCP port. The port is handed to
every session as `CHIRP_DAEMON_PORT`.

**tmux.** Sessions are not PTYs Xirp owns. Each one is:

```
tmux new-session -d -s xirp-<uuid> -e <env...> -c <worktree> -x 120 -y 30 \
  '<launcher> --launch-claude --session-id <uuid> --append-system-prompt "..."' \
  ';' set-option -t xirp-<uuid> remain-on-exit on
```

That is how "sessions survive closing the app" works. tmux does it.
Geometry is fixed at 120x30 at creation.

**A Node launcher.** The agent is not spawned directly. It goes through
`app.asar.unpacked/node_modules/@chirp/squab/dist/cli.js --launch-claude`.

**Environment pinned per session:** `DISABLE_UPDATE_PROMPT=true`,
`DISABLE_AUTO_UPDATE=true`, `FORCE_COLOR=3`, `COLORTERM=truecolor`,
`LANG=C.UTF-8`, `BROWSER=/usr/bin/open`, `CLAUDE_CODE_NO_FLICKER=1`,
`CLAUDE_CODE_SCROLL_SPEED=3`, plus `CHIRP_SESSION_ID`,
`CHIRP_PROJECT_ID`, `CHIRP_NOTIFICATION_ID`, `CHIRP_DAEMON_PORT`,
`CHIRP_EDITION=external`.

### Cross-harness handoff: an agent-neutral session IR

The headline claim ("switch harness mid-project without losing context")
is real, and better engineered than the marketing describes. This is the
most valuable thing in the teardown.

`dist/session/canonical.d.ts` defines a **canonical session format**: an
agent-neutral entry list used as the interchange between per-agent
adapters. Entry types:

```
user_message | assistant_message | tool_use | tool_result
| image | system_note | path | handoff_marker
```

`tool_use` and `tool_result` stay linked through `id` / `toolUseId`, so
a receiving agent can still pair them. Consecutive assistant `text`
blocks are concatenated, because the block structure is Claude-internal
and meaningless cross-agent.

Each harness has an adapter under `dist/session/adapters/` implementing
`readNative`, `writeNative`, `resumeArgs`, `sessionRoot`,
`findBySessionId`, `locateLatest`, optional `sanitize`,
`writeNoticeSeed`, and `onSessionMovedIn` / `onSessionMovedOut`.

The handoff (`dist/session/handoff.js`, `performHandoff`) runs:

1. Locate the source session file by session id, falling back to the
   most recent one in that cwd.
2. `readNative` it into canonical entries.
3. Append a `handoff_marker` carrying from, to, reason, timestamp and
   permission mode.
4. The **target** adapter's `writeNative` writes the receiving
   harness's own native session file.
5. Launch the target with its `resumeArgs`, so it resumes into a
   session that was manufactured for it.
6. Update a manifest, notify both adapters that the session moved, and
   delete the source file.

So the model receives the actual prior conversation, not a summary.

Details worth stealing:

- **Lossy by declaration.** Their comment states what does not survive:
  thinking blocks with model signatures, attachment metadata,
  planning-mode state. Anything no other harness understands is dropped
  rather than faked.
- **Freshness guard.** `HandoffStaleSourceError` refuses to seed from a
  session file older than the orchestrator's boot, so a handoff cannot
  silently graft an unrelated old transcript onto a new session.
- **Empty source** produces a notice seed ("Your previous session was
  empty, so I've started a fresh session") instead of an error.
- **A human-facing summary, kept out of the model's turn.** Claude and
  Codex TUIs load a resumed JSONL silently, so their adapters emit a
  *native* summary record (`summary` for Claude, `compacted` for Codex)
  at the top of the seed file, rendering the last 3 user/assistant
  exchanges truncated to 500 chars each. Their comment is explicit that
  this is NOT a fabricated user message, because that "would pollute the
  LLM's first turn with a fabricated user input". That distinction is
  the kind of thing that is obvious only after you get it wrong once.

### Two harnesses nobody has reported: snipe and honk

`dist/session/adapters/` ships five adapters: `claude`, `codex`,
`gemini`, **`snipe`** and **`honk`**. Neither of the last two appears in
any launch material.

**snipe** is a coding agent of Spotify's own, not a router as the
settings file suggested. Its adapter documents "snipe 1.x, session
version 4", sessions at `~/.snipe/sessions/--<slug(cwd)>--/<uuid>.jsonl`,
its own JSONL vocabulary (`session`, `model_change`,
`thinking_level_change`, `message`), and its own skills directory
convention (`.snipe/skills/`, alongside `.claude/skills/` and
`.agents/skills/`). Their own `settings.json` carries snipe defaults
including `auto_route` and `classification_method`.

**honk** is a hosted service. Quoting the adapter comment: "Honk is the
remote Claude Code service that snipe wraps via `snipe --honk`. Sessions
live on Honk's server, identified by server-side numeric ids; nothing is
written to the local filesystem." The adapter is deliberately degenerate:
registered so the launcher knows about it, with every canonical-pipeline
slot returning null or throwing.

Read that against the "vendor-neutral" positioning. They are
commoditizing the agent layer and shipping both an agent and a hosted
backend for it at the same time.

### The internal name is Chirp

The daemon logs under `name: "chirp"`, every session env var is
`CHIRP_*`, the launcher is an npm package under the `@chirp` scope, and
the build is tagged `edition: "external"`. Xirp is the external rebrand
of an internal tool called Chirp.

### Orchestration by system prompt

The most interesting thing in the product, and it is in none of the
launch material.

Every session is launched with `--append-system-prompt` carrying a
tutorial for their own CLI. From the log, the injected text teaches:

```
chirp session new --goal "task" [--name "short name"] [--new-branch <name>]
                  [--depends-on] [--project <ref>] [--json]
```

with these semantics, quoted from the injected prompt:

- `--goal <text>` task for the new session (required)
- `--name <text>` short display name, 3 to 5 words, "ALWAYS provide this"
- `--new-branch <name>` names the worktree branch, default an
  auto-generated `session/cli-*`
- `--depends-on [id]` "Queue as child of this session (starts after this
  session completes). Omit id to use the current session."
- `--project <ref>` target another project by name, path or UUID
- `--json` returns `{id, name, branch, worktreePath}`

It also ships trigger examples, so the model knows when to reach for it:

- "Refactor the auth module, and in parallel update the tests" spawns two
  sessions
- "After you're done with this, deploy to staging" spawns one with
  `--depends-on`
- "Fix the flaky test in the backend repo" spawns with `--project backend`

Sessions are created in the background with no view switch. The
fan-out is user-triggered in natural language, not autonomous, and not a
UI.

**Caveat.** Their own daemon log shows `chirp --help` failing with
`/bin/sh: chirp: command not found`. Whether the injected tutorial
resolves end to end in the external build is unverified.

### Work state, and what happens without hooks

Onboarding step 3 offers "session hooks": "Installs lightweight hooks
into coding agents so Xirp can tell when a session is working, idle, or
waiting for your input, essential for the minimap status badges and
notifications. Installed agents: Claude, Codex." Gemini is absent from
that list despite being a supported agent.

It also states the failure mode plainly: "Without hooks, Xirp can't tell
when Claude is idle or needs input, so minimap badges and sounds won't
work."

Measured with hooks declined (`~/.claude/settings.json` was never
touched, mtime predates the install):

- The session badge latched to **working** and stayed there for 20+
  minutes, across both a cancelled turn and a normally completed one,
  with the Stop control still armed, while the agent sat idle at a
  prompt.
- The per-session **context meter kept working**, reporting a live
  percentage. So token counts do not come from hooks.

Two conclusions. Their work-state feature is a hard dependency on
mutating the user's agent config, and declining it degrades to a
confident wrong answer rather than to nothing. And the context
percentage is read from the agent's own transcript, which means that
particular feature needs no hooks at all.

### Titles from the transcript

The log shows `readClaudeTitleForSession(<uuid>): cwd=... cliId=null`,
scanning `~/.claude/projects/<slug>/`. Session auto-naming is done by
reading Claude's own JSONL transcript, not by a hook.

### A fourth agent: `snipe`

`xirp-external/settings.json` carries `coding_agent_defaults` for
`claude`, `codex`, `gemini` and **`snipe`**. The first three hold the
expected per-agent flags (`dangerously_skip_permissions`,
`approval_policy`, `sandbox_mode`, `yolo`). `snipe` holds:

```
provider, thinking, permission_mode, sandbox, yolo,
auto_route, classification_method
```

`auto_route` plus `classification_method` reads as a model router:
classify the task, send it to a provider. That is almost certainly the
machinery behind the "route every job to the best available price
performance" line in the launch material. Not exposed in the UI at the
time of writing.

### Architecture map

```
┌─ Xirp.app (Electron, 183 MB) ──────────────────────────────────┐
│  dist/main.js  22 KB  window, updater, daemon lifecycle        │
│                                                                │
│  dashboard/   React + Vite + Tailwind + xterm.js + Encore      │
│               service worker + PWA manifest  (32 MB)           │
└───────────────────────────┬────────────────────────────────────┘
                            │ websocket, one connection
┌───────────────────────────▼────────────────────────────────────┐
│  @chirp/daemon   separate process, loopback TCP                │
│                                                                │
│  sessions  worktrees  git  github  prs  epics  todos  titles   │
│  cost  telemetry  notifications  session-search  skills  rules │
│  files  browser-proxy  perf  update  auth0  portal  licenses   │
│                                                                │
│  store: PGlite (Postgres+pgvector in wasm) via drizzle         │
│  17 tables, 57 migrations                                      │
│                                                                │
│  oneshot: Claude Agent SDK, maxTurns 1, budget $0.05           │
│           titles + PR review, billed to YOUR claude auth       │
└───────┬──────────────────────────────┬─────────────────────────┘
        │ node-pty                     │ https
        ▼                              ▼
   tmux attach ──► tmux server    backstage-api.spotify.com
        │          (persistence)   /portal/v1/xirp/telemetry
        ▼                          /…/associate-domain
   node @chirp/squab                    {installation_id, email_domain}
        │  harness adapters:
        │  claude · codex · gemini · snipe · honk
        │  canonical session IR, handoff, fork, hook-script gen
        ▼ node-pty
   the actual agent CLI
        │
        └─ hooks POST ──► daemon   (bearer token, ~/.chirp/hook-auth.token)

  Portal (paid, optional) ──► MCP server at /api/mcp-actions/v1
                              + "call workspace.get-project-context first"
```

### Tech stack

**Desktop shell** (`@chirp/electron` 0.12.0, `author: Spotify`,
`chirpEdition: external`, `chirpBuild: a4d33eb`): Electron,
`electron-updater`, `pino` for logs, `semver`. `dist/main.js` is 22 KB.
That is the entire desktop app.

**Daemon** (`@chirp/daemon`, 195 modules):

| Concern | Choice |
|---|---|
| Store | `@electric-sql/pglite` 0.4.5 (Postgres in wasm) + `pglite-socket`, with `pglite-old` 0.2.17 kept for migration |
| ORM | `drizzle-orm` 0.45, 57 migrations |
| Transport | `ws` 8.19, one websocket, ~330 message types |
| Terminals | `node-pty` 1.1.0 |
| Agents | `@anthropic-ai/claude-agent-sdk` ^0.2.20, `@modelcontextprotocol/sdk` ^1.27 |
| Cloud | `@google-cloud/pubsub` 5.2.4, `google-gax`, `firebase` ^12.15 |
| Auth | `jose` (JWT), Auth0 |
| Validation | `zod` 4 |
| Config parsing | `smol-toml` (Codex `config.toml`), `gray-matter` (skills frontmatter) |
| Queueing | `p-queue`, `p-retry` |

**Dashboard** (399 asset files, 32 MB): React, Vite, Tailwind,
`zustand`, **xterm.js**, `shiki` for syntax highlighting, `mermaid` for
diagrams, `katex` for maths, some Monaco, Spotify's **Encore** design
system (`class="encore-layout-themes encore-xirp-dark-theme"`). Ships a
service worker and a PWA manifest. Bundles JetBrains Mono Nerd Font and
Inter as woff2, and still `preconnect`s to `fonts.googleapis.com`, so
the UI reaches out to Google on load.

The dashboard being a PWA served to a browser, with the daemon holding
the state and the PTYs, is what makes "locally or remotely" possible.

### How a terminal actually reaches the screen

Four layers, and worth spelling out because termic has one.

```
dashboard (React + xterm.js in a webview or browser)
        │  websocket, ~330 message types
        ▼
daemon (node)  terminal/bridge.js
        │  node-pty 1.1.0, cols/rows, output ring buffer
        ▼
tmux attach-session -t xirp-<uuid>          ← persistence lives here
        │
        ▼
tmux server, session created detached with remain-on-exit on
        │
        ▼
node  @chirp/squab/dist/cli.js --launch-claude --session-id <uuid>
        │  its own PTY supervisor, also node-pty
        ▼
claude / codex / gemini / snipe
```

`attachToTmux` spawns `tmux attach-session` inside a node-pty and keeps
an `outputBuffer` with a byte cap so a reconnecting client can be
replayed. Squab's own `pty/supervisor` sizes the inner PTY to the
parent, forwards SIGWINCH, and tears down with an escalation ladder:
polite `/exit\r`, then SIGINT, then SIGTERM, then SIGKILL, each with a
bounded timeout. Both PTY layers are node-pty; `SQUAB_FORCE_NO_PTY=1`
disables the inner one.

For comparison, termic is one hop: Rust `portable-pty` to the agent,
bytes to xterm.js in the same process.

### The daemon is a full backend

`app.asar` unpacks to ~4,700 files. The Electron main process is 22 KB;
everything real lives in `@chirp/daemon` (195 JS modules) and a
`dashboard/` web app that ships with a service worker and a PWA
manifest, which is how "locally or remotely" is meant to work.

Notable dependencies bundled:

- **`@anthropic-ai/claude-agent-sdk`** (11.6 MB, with its own vendored
  `ripgrep` binary and tree-sitter wasm). They ship the SDK as well as
  driving the CLIs.
- **PGlite** (Postgres compiled to wasm, 8.7 MB) with **pgvector**, plus
  `drizzle-orm`. Their local store is a real Postgres.

### Their data model

57 drizzle migrations. Tables: `projects`, `sessions`, `worktrees`,
`messages`, `decisions`, `digests`, `todos`, `snapshots`, `settings`,
`cost_records`, `epics`, `chunks`, `plan_reviews`, `monitored_prs`,
`pr_events`, `pr_reviews`.

`messages` and `decisions` both carry `embedding vector(1536)`, so the
schema is built for semantic recall over past sessions and over captured
architectural decisions. `digests` is a daily rollup: summary, sessions
completed, total cost in USD, decision count, per-project stats.

The interesting pair is `epics` and `chunks`:

```
epics:  slug, title, goal, goal_context, base_branch, model,
        status (planned|...), proposal jsonb
chunks: epic_id, ordinal, title, body, estimate, rationale,
        depends_on jsonb, branch, status, pr_number, pr_url,
        repo_name, session_id, attempts, last_error, kind
```

That is a goal-to-pull-requests pipeline: propose a plan, decompose it
into chunks with a `depends_on` dependency graph, give each chunk a
branch and a session, open a PR per chunk, count attempts, record the
last error. Migration `0019_multi_parent_epic_chunks` widened the graph
to multiple parents. None of this appears in the launch material or the
public docs.

### The websocket API

Roughly 330 message types over a single websocket. Beyond the obvious
session/worktree/git verbs, the ones worth knowing about:

| Group | Types |
|---|---|
| Harness management | `harness:install`, `harness:update`, `harness:uninstall`, `harness:ensureNpmRegistry`, `harness:swapped` |
| Cost | `cost:calculateUsage`, `cost:processTurnCosts`, `cost:reportedFields` |
| Search | `session-search:search` |
| Epics | `epic:attachSessionToEpic`, `epic:getChunkInfo` |
| PR watching | `pr:watchSession`, `pr:refreshMonitoredRepos`, `pr:pubsubStatus`, `chirp:prWatcherPrompt`, `chirp:prWatcherRules` |
| Permissions | `permission:request`, `permission:respond`, `permission:resolved` |
| Worktrees | `worktree:recycle`, `worktree:runScript`, `worktree:teardownStarted` |
| Sessions | `session:fork`, `session:stopRemote`, `session:acknowledge` |
| Misc | `db:query`, `browser-proxy:start`, `transcript:uploadToGateway`, `workspace:scan`, `workspace:import` |

They install and update the agent CLIs for the user over npm, which is a
support burden termic has so far avoided and a convenience termic does
not offer.

### Telemetry: what actually leaves the machine

Endpoint `https://backstage-api.spotify.com/portal/v1/xirp/telemetry`,
plus `.../telemetry/associate-domain`.

**On by default.** `getUsageTelemetryPreference` treats undefined as
enabled. Opt out in settings or with `CHIRP_TELEMETRY=0`.

The event envelope is `{event, params, installation_id, run_id,
event_id, client_timestamp_ms, app_version, platform}`, zod-validated
and `.strict()`. The event enum is closed:

```
daemon_started, harness_created, session_status_transition,
session_lifetime, session_first_activity, session_active_concurrency,
ui_view_opened, ui_tab_changed, portal_connected, portal_disconnected,
portal_transcript_uploaded, session_portal_origin, onboarding_started,
onboarding_step_viewed, onboarding_step_action, onboarding_completed,
ws_message
```

Harness names are bucketed to `claude | codex | gemini | snipe | other`,
counts are clamped, params are scalars only. No code, no paths, no
project names, no prompts. As telemetry goes it is careful and it is
worth copying the shape if termic ever ships its opt-in analytics.

The one to notice is **`associate-domain`**, which posts
`{installation_id, email_domain}`. Once you sign in, your anonymous
install is linked to your employer's email domain. That is the Backstage
playbook mechanised: give away the tool, learn which companies adopt it,
sell them Portal.

Tracked UI tabs also leak the roadmap: `overview, git, prs, files,
memory, rules, skills, ideas`. There are `memory` and `ideas` surfaces
that the public docs do not mention.

### How Portal context is actually delivered

`modules/portal/agent-config.js`. Not a magic context layer: Portal is
an **MCP server** at `{portalOrigin}/api/mcp-actions/v1`, injected into
the session's MCP config, plus a system prompt that says, in effect,
"before doing any other work you MUST call `workspace.get-project-context`
with this project id, even if you do not think you need it".

Auth is neat. Instead of baking a token into the MCP config they set a
`headersHelper`, a `node -e` one-liner that reads the access token from
`~/.chirp/portal-auth.json` and prints
`{"Authorization":"Bearer ..."}`. The token never sits in the config
file. They also validate that the referrer origin matches the Portal
origin (or localhost) before injecting anything.

### The oneshot path

`oneshot/` runs the bundled Claude Agent SDK CLI with `maxTurns: 1`,
`tools: []`, `persistSession: false` and `maxBudgetUsd: 0.05`, against
`ANTHROPIC_API_KEY` or whatever `claude` on PATH is already signed in
with. Their own error string: "No Anthropic credentials found. Set
ANTHROPIC_API_KEY or sign in to Claude Code to enable title generation
and PR review."

So on the free edition their AI features bill to *your* subscription.
There is also an `ai-gateway:anthropicEnv` capability, so the Portal
edition can inject gateway env and route the same calls through
Spotify's AI gateway.

Title generation is a two-step: prefer the title Claude already wrote in
its own transcript, and only if that is missing call
`claude-haiku-4-5-20251001` with this system prompt (verbatim):

> You are a title generator. The user will give you context from a
> coding session: an optional goal, early messages, and recent messages.
> Reply with ONLY a 3-5 word title that captures the high-level goal and
> outcome of the session. Use sentence case (only capitalize the first
> word and proper nouns). No quotes, no punctuation, no explanation, no
> conversation. Just the title. Do not include git or GitHub
> nomenclature (branch names, PR references).

They guard it with an `isCustomName` flag so a user rename is never
overwritten, and re-check that flag after the async call returns.

### Session search is keyword, not vectors

Despite the `vector(1536)` columns, the external edition's
`session-search` is SQL `ILIKE` over session metadata plus a **streaming
scan of the agents' own transcript files on disk**: Claude's
`~/.claude/projects/**/<uuid>.jsonl` and Codex's `rollout-*` files, read
line by line with an abort signal, matching all query words and
extracting a snippet.

That is the most directly stealable thing in the whole bundle. "Search
everything any agent ever did in this repo" needs no index, no
embeddings, no server and no upload. termic already knows which task
produced which session.

### Data directory

`~/Library/Application Support/Xirp/xirp-external/`:

| Path | What |
|---|---|
| `settings.json` | agent defaults, onboarding flag, git defaults |
| `auth0-auth.json` | Auth0 tokens for the Spotify account |
| `db/` | app state |
| `backups/` | dated snapshots, including a pre-migration one |
| `installation.json`, `revocation-cache.json` | install identity, revocation |
| `xirp.log` | very chatty daemon log, source of most of the above |

### From the public docs

- Session states: Working, Idle, Waiting, Finished, Failed.
- Grid view of multiple terminals (`Cmd+G`), session minimap with
  configurable position, `Cmd+K` universal search, `Cmd+Shift+K` recent.
- Project tabs: Overview, Git, Files, **Skills**, **Rules**.
- Projects can be git repos, non-git folders, or a parent folder holding
  several repos, where "git controls are limited".
- Session creation box: "What should we build? Type a goal or paste a
  ticket URL".
- Transcripts can be uploaded to a Portal Workspace to share. Their FAQ:
  Xirp "does not scrub or redact credentials, personal data, or
  sensitive content before upload".
- Settings docs state Xirp "does not translate permission or sandbox
  settings between coding agents", and it adds no isolation of its own.
- Portal integration supplies catalog, ownership and dependency context
  at session start, and transcripts flow back into Portal.

### What they have that termic does not

Worth keeping honest, roughly in order of how much I would want it:

1. **Local transcript search.** A streaming keyword scan over the
   agents' own JSONL transcripts, no index and no embeddings needed.
   The cheapest large feature in the bundle and the one to copy first.
2. **Cross-harness handoff that actually works.** The canonical session
   IR plus per-harness codecs described above. termic has nothing like
   it, and nobody else ships it either.
3. **Organizational context.** Portal's catalog, ownership and
   dependency graph at session start, delivered as an MCP server plus a
   "call this first" instruction. termic has no equivalent.
4. **Context-window meter per session**, readable from the transcript
   without hooks.
5. **Auto-named sessions**, from the same transcript, with a
   custom-name guard so a user rename is never clobbered.
6. **A goal-to-PRs pipeline.** Epics decomposed into chunks with a
   dependency graph, one branch, session and PR per chunk, attempts and
   last error recorded. termic has no planning layer at all.
7. **Cost tracking per turn**, plus a daily digest rolling up sessions
   completed, total USD and decisions captured.
8. **Orchestration the agent can see.** termic ships the same
   capability through `TERMIC_CLI_HELP` in the environment, which is
   passive: nothing puts it in the model's context.
9. **A grid of live terminals across sessions.** termic splits inside a
   task only. Also the workload where Electron should hurt most, so
   benchmark before copying.
10. **Harness install and update over npm**, from inside the app.
11. **Session fork** and worktree recycling.

### What termic has that they do not

1. Open source, AGPL, no account, no backend.
2. A real sandbox: per-task Seatbelt cage plus a network allowlist,
   pinned at creation.
3. Native, 20 MB against 183 MB of Electron.
4. Seven agents plus any PTY command as an eighth.
5. Real multi-repo composition, with a port per member.
6. macOS and Linux builds.
7. Work-state detection that needs no config and degrades to nothing
   rather than to a wrong answer.

### Sources

- <https://xirp.spotify.com/> and `/join-beta`
- <https://backstage.spotify.com/docs/xirp> (docs, FAQ, sessions,
  projects, settings)
- <https://portal.spotify.com/blog/introducing-xirp>
- <https://reckless-finch.spotifycdn.com/external/latest-mac.yml>
- A local install of Xirp 0.12.0 and its own log
