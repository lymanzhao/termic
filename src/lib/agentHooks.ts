// The OSC sequence termic's agent hook writes, and the pieces needed to reason
// about it on this side of the PTY.
//
// The hook itself is generated in Rust (`src-tauri/src/agent_hooks.rs`), which
// is where the file actually gets written. This module exists because the BODY
// text is load-bearing on the TypeScript side too: it has to survive
// `notificationWantsAttention`, and if it ever starts matching
// `BUILTIN_NOTIFY_IGNORE.claude` the whole feature dies silently, with the hook
// firing correctly and termic dropping it on the floor.
//
// KEEP IN SYNC with `agent_hooks::script_body()`. Both sides pin the literal in
// their own test, because a string cannot be shared across the language
// boundary; `agentHooks.test.ts` and the Rust
// `the_script_gates_on_both_env_vars_and_always_exits_zero` are the two halves.

/** OSC 777's `notify` title field. Identifies the sender, not the message. */
export const HOOK_OSC_TITLE = "termic";

/** The body `TerminalPane`'s OSC 777 handler ends up passing to
 *  `notificationWantsAttention`. Deliberately does NOT contain "is waiting for
 *  your input", which is claude's ignore pattern for its own 60s idle nudge. */
export const HOOK_OSC_BODY = "agent needs your input";

/** Body of the READY signal (`Signal::Ready`, claude's `SessionStart`). Shares
 *  the OSC id and the trusted-sender title with the attention body above and is
 *  told apart by this string alone, so the two must never be prefixes of each
 *  other: `TerminalPane`'s handler routes on an exact match and would otherwise
 *  badge a ready session as needing you.
 *
 *  It reports the one thing the terminal cannot express. A blocking startup
 *  dialog (claude's "do you trust this folder?", whose highlighted default is
 *  `No, exit`) paints and then goes quiet, which is byte-for-byte what a
 *  waiting input box looks like, so every quiet-based heuristic calls it ready
 *  and types into it. KEEP IN SYNC with `Signal::Ready`'s payload in Rust. */
export const HOOK_OSC_READY_BODY = "agent ready for input";

/** Prefix of the body that reports the agent's OWN session id, so termic can
 *  resume that exact session later.
 *
 *  It exists for codex, which is the one agent that can resume a session by id
 *  but cannot be TOLD an id at launch: its TUI has no `--session-id`, and
 *  `codex resume <fresh-uuid>` errors ("no rollout found for thread id") rather
 *  than minting like pi's does. So the id has to come back FROM the agent, and
 *  its `SessionStart` payload carries one at the earliest possible moment.
 *
 *  claude uses it too, for the opposite reason: it IS told an id at launch,
 *  but `/clear` and `/resume` move the conversation to another id inside the
 *  running process. Its hook reports only those moves (GH #306).
 *
 *  Delivered as a second OSC from the same hook rather than folded into the
 *  ready body, because ready is routed on an EXACT match and that is
 *  load-bearing (see `HOOK_OSC_READY_BODY`). A prefix match here, an exact
 *  match there, and neither can be mistaken for the other.
 *
 *  KEEP IN SYNC with `SESSION_BODY_PREFIX` in `agent_hooks.rs`. */
export const HOOK_OSC_SESSION_PREFIX = "session ";

/** termic's hooks saying a turn started / is over. These used to be raw OSC
 *  `133;C` / `133;D`, which agents also emit themselves (pi marks every
 *  message block on each repaint; claude's shell integration marks prompts),
 *  so a hooked tab could not tell termic's signal from the agent's own. With
 *  these, a tab whose agent has termic hooks ignores raw 133 entirely.
 *  Routed on an EXACT match, like ready. KEEP IN SYNC with `WORKING_BODY` /
 *  `DONE_BODY` in `agent_hooks.rs`. */
export const HOOK_OSC_WORKING_BODY = "agent working";
export const HOOK_OSC_DONE_BODY = "agent done";

/** Prefix of the body that reports work the agent has DELEGATED and not
 *  finished: `agent delegated: <count> <label> <ids>`. See
 *  `lib/delegatedWork.ts` for the grammar and the policy, and
 *  docs/agent-hooks.md "Delegated work" for the measurements.
 *
 *  It replaces SILENCE. A done hook that found outstanding work used to exit 0
 *  having written nothing, and nothing is exactly what a model mid-token looks
 *  like, so the tab could not tell "still thinking" from "stopped, waiting on a
 *  subagent" from "stopped, and a dev server will keep it stopped forever".
 *
 *  Prefix-matched like `HOOK_OSC_SESSION_PREFIX` rather than exact-matched like
 *  ready, and routed before `notifyAttention` for the same reason every trusted
 *  body is: an unrecognised trusted body falls through to a needs-you badge.
 *  KEEP IN SYNC with `DELEGATED_BODY_PREFIX` in `agent_hooks.rs`. */
export const HOOK_OSC_DELEGATED_PREFIX = "agent delegated: ";

/** The session id in a trusted `session <uuid>` body, or null.
 *
 *  Validated as a UUID rather than taken verbatim, and that is not politeness:
 *  the value is stored on the tab and later expanded into `resume {UUID}` on a
 *  COMMAND LINE. A body is an agent-controlled string; anything that is not
 *  plainly an id is dropped. */
export function hookOscSessionId(body: string): string | null {
  if (!body.startsWith(HOOK_OSC_SESSION_PREFIX)) return null;
  const id = body.slice(HOOK_OSC_SESSION_PREFIX.length).trim();
  // A UUID (claude, codex, agy), or devin's slug (`brassy-polish`), which is
  // exactly what `devin --resume` takes. The slug rule is the one devin's
  // hook applies before sending: first byte alphanumeric, then only
  // `[0-9a-zA-Z_-]`, so nothing reaching a command line can start a flag or
  // carry a shell metachar. The UUID-only version dropped every devin id,
  // and the body then fell through to a notification: "session brassy-polish".
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const slug = /^[0-9a-zA-Z][0-9a-zA-Z_-]{0,127}$/;
  return uuid.test(id) || slug.test(id) ? id : null;
}

/** The OSC payload without its introducer or terminator: what you would put
 *  between `ESC ]` and `BEL`. Control characters are never written as raw bytes
 *  in this file, only as escapes, so the source stays greppable and a stray
 *  literal cannot creep in unnoticed (it already did once). */
export function hookOscPayload(body: string = HOOK_OSC_BODY): string {
  return `777;notify;${HOOK_OSC_TITLE};${body}`;
}

/** What xterm hands the OSC 777 handler: the payload minus the leading `777;`,
 *  since the parser strips the id before dispatching. */
export function hookOscHandlerData(body: string = HOOK_OSC_BODY): string {
  return hookOscPayload(body).slice("777;".length);
}

/** The full sequence the hook emits, ESC and BEL included. Used by tests and
 *  the e2e spec to feed a PTY exactly what claude would write. */
export function hookOscSequence(body: string = HOOK_OSC_BODY): string {
  return `\x1b]${hookOscPayload(body)}\x07`;
}

/** Parse an OSC 777 payload the way `TerminalPane`'s handler does, so a test can
 *  assert the end-to-end chain rather than just the constant. `data` is
 *  everything after the `777;` introducer, which is what xterm hands the
 *  handler.
 *
 *  Returns null for anything that is not a `notify`, matching the handler's own
 *  early return. */
export function parseNotifyBody(data: string): string | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;
  return parts.slice(2).join(";") || parts[1] || "";
}

/** OSC ids claude's hook runtime will actually write for us. Quoted from the
 *  binary: "only OSC 0/1/2/9/99/777 and BEL are permitted, and OSC 9 bodies may
 *  not begin with a digit unless in the 9;4 progress form". Anything outside
 *  this is dropped with no error, so a future change of channel has to check. */
export const CLAUDE_TERMINAL_SEQUENCE_ALLOWLIST = [0, 1, 2, 9, 99, 777] as const;
