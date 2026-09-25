// Context window: how full the agent's CURRENT conversation is.
//
// A different number from subscription usage (lib/agentUsage.ts), and keyed
// differently for that reason. Usage is a fact about an ACCOUNT, shared by
// every task on one login. Context is a fact about one SESSION: two claude tabs
// on the same login can sit at 8% and 91%, and the second one is about to
// compact.
//
// Every agent that reports it does so through the same OSC body, whatever its
// transport (claude and grok through their status line, codex from its
// `Stop` hook, opencode and pi from their in-process plugin). One wire
// format, so the terminal side has one parser and no per-agent branch.
//
// KEEP IN SYNC with `agent_hooks::CONTEXT_BODY_PREFIX`. Both sides pin the
// literal in their own test.

/** Prefix of the body that reports the context window. Must never be a prefix
 *  of, or prefixed by, the usage/ready/session bodies on the same channel. */
export const CONTEXT_BODY_PREFIX = "ctx ";

export interface ContextReading {
  /** Tokens the conversation occupies right now. */
  usedTokens: number;
  /** The model's window, in tokens. */
  windowTokens: number;
  /** 0-100. The AGENT's own figure where it sends one, because agents do not
   *  agree on the formula (codex reserves a 12k baseline, so its 50% is not
   *  tokens/window) and the number that matters is the one the agent itself
   *  compacts on. Otherwise tokens/window, which is claude's formula. */
  usedPercent: number;
}

/** A bare non-negative number, or null. Strict for the same reason the usage
 *  parser is: `Number("")` is 0, and a confident 0% over a missing field reads
 *  as an empty conversation. */
function num(raw: string | undefined): number | null {
  if (!raw || raw === "-") return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a trusted `ctx …` body, or null when it is not one.
 *
 *     ctx <used tokens> <window tokens> [<used percent>]
 *
 * The percent is optional and appended, so a script that cannot compute one
 * sends two fields. A window of 0 or a missing token count is no reading at
 * all rather than a 0%: an agent that has not learned its model's window yet
 * has nothing honest to say.
 */
export function parseContextBody(body: string): ContextReading | null {
  if (!body.startsWith(CONTEXT_BODY_PREFIX)) return null;
  const [u, w, p] = body.slice(CONTEXT_BODY_PREFIX.length).trim().split(/\s+/);
  const used = num(u);
  const win = num(w);
  if (used === null || win === null || win <= 0) return null;
  const pct = num(p) ?? (used / win) * 100;
  return {
    usedTokens: Math.round(used),
    windowTokens: Math.round(win),
    usedPercent: Math.min(100, Math.max(0, pct)),
  };
}

export function sameContext(a: ContextReading | undefined, b: ContextReading | undefined): boolean {
  if (!a || !b) return a === b;
  return a.usedTokens === b.usedTokens && a.windowTokens === b.windowTokens
    && a.usedPercent === b.usedPercent;
}

/** `84k` / `1.2M` / `950`. The popover's token counts; the chip only ever
 *  shows the percentage, which does not reflow as tokens tick. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Where a context percentage starts to matter. Later than the usage
 *  thresholds on purpose: a context filling up is the normal life of a
 *  session, and claude auto-compacts in the low 90s, so 80 is "this will
 *  compact soon" and 90 is "it is about to". */
export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_CRITICAL_PERCENT = 90;

export function contextLevel(usedPercent: number): "normal" | "warn" | "critical" {
  if (usedPercent >= CONTEXT_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= CONTEXT_WARN_PERCENT) return "warn";
  return "normal";
}

/** Where one footer readout comes from.
 *
 *  `hooks`: it only arrives once termic's hooks are installed for the agent,
 *  because the thing that sends it is part of that install (a status line,
 *  a turn-end hook, a plugin, or devin's read that a turn-end hook triggers).
 *  An agent without hooks will never report it, so the chip offers the
 *  install.
 *
 *  `pull`: termic asks for it in the background (codex's app-server, devin's
 *  API, copilot's cache), hooks or not.
 *
 *  `null`: no source was found for this agent (see docs/adding-an-agent.md
 *  for what was measured). */
export type FooterSource = "hooks" | "pull" | null;

export interface FooterSources {
  usage: FooterSource;
  context: FooterSource;
}

/** Per built-in base id. KEEP IN STEP with docs/adding-an-agent.md "Footer
 *  readouts" and docs/agent-hooks.md "The context window, per agent": a new
 *  agent gets a row here in the same change that gives it a source. */
const SOURCES: Record<string, FooterSources> = {
  claude:   { usage: "hooks", context: "hooks" }, // status line, both
  codex:    { usage: "pull",  context: "hooks" }, // app-server RPC; Stop hook reads the rollout
  agy:      { usage: "hooks", context: "hooks" }, // status line, both
  copilot:  { usage: "pull",  context: "hooks" }, // its own quota cache; status line
  devin:    { usage: "pull",  context: "hooks" }, // Connect API; session store read on the Stop hook's done
  grok:     { usage: null,    context: "hooks" }, // status line (no quota in it)
  opencode: { usage: null,    context: "hooks" }, // plugin
  pi:       { usage: null,    context: "hooks" }, // extension
  // muse: context and quota exist only over `muse serve`, never to a TUI tab.
};

export function footerSources(baseId: string): FooterSources {
  return SOURCES[baseId] ?? { usage: null, context: null };
}

/** Which footer readouts an agent has ANY source for. Drives the Settings
 *  hints. */
export function footerReports(baseId: string): { usage: boolean; context: boolean } {
  const s = footerSources(baseId);
  return { usage: s.usage !== null, context: s.context !== null };
}

/** Does anything the footer would show for this agent need the hooks
 *  install? Only the readouts the user has left ON count: hiding context on
 *  codex leaves nothing that needs hooks, since its usage is pulled. */
export function footerNeedsHooks(s: FooterSources, show: { usage: boolean; context: boolean }): boolean {
  return (show.usage && s.usage === "hooks") || (show.context && s.context === "hooks");
}
