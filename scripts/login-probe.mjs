#!/usr/bin/env node
// Does each agent's login STILL follow the variable we think it does?
//
// The account switcher (GH #278) rests on one table: `agent_dirs::login_store`
// says which environment variable relocates each agent's credential. That
// table is a set of MEASUREMENTS of other people's software, so it goes stale
// silently when an agent ships a change: the switcher keeps "working", every
// unit test keeps passing, and two accounts quietly share one login.
//
// This is the check that catches it. For each installed agent it points the
// measured variable at an EMPTY directory and asserts the CLI reports itself
// signed out. A CLI that still answers is one whose login no longer follows
// that variable.
//
// Local only, never CI, exactly like `make lsp-smoke`: it needs the real CLIs
// installed and really logged in, which no runner has. Run it when an agent
// updates, or when the switcher starts behaving oddly for one agent.
//
// NOTHING HERE READS A CREDENTIAL. It only observes whether the agent thinks
// it has one.
//
// WHAT THIS CANNOT SEE. An agent that keeps its token in an OS keyring under a
// FIXED service name will report itself signed out when its config dir moves
// (its settings went with it) while the credential stays shared. "It said
// signed out" is therefore necessary but not sufficient. That is why copilot
// and muse are listed with no check rather than a passing one, and why gemini
// is probed WITH the companion variable that pins it to file storage.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Mirrors `agent_dirs::login_store`. Kept in step by
 *  `the_probe_covers_every_agent_with_a_measured_store` in agent_dirs.rs,
 *  which fails when an agent gains a store and is not listed here. */
const AGENTS = [
  { id: "claude",   env: "CLAUDE_CONFIG_DIR", probe: ["auth", "status"],                   signedOut: /(?:"loggedIn":\s*false|not (?:signed|logged) in)/i },
  { id: "codex",    env: "CODEX_HOME",        probe: ["login", "status"],                  signedOut: /not (?:signed|logged) in|no credentials/i },
  // NOT probed, and not a gap: copilot keeps its credential in the OS keyring
  // under a FIXED service name, so COPILOT_HOME cannot isolate it and termic
  // does not offer it a second account (agent_dirs::login_unsupported_reason).
  { id: "copilot",  env: "COPILOT_HOME",      probe: ["--version"],                        signedOut: null, note: "no second account: its keyring service name is fixed" },
  // gemini needs its COMPANION variable to isolate for real: without it the
  // relocation moves settings.json (so it complains about a missing auth
  // method) while the OAuth token stays in a fixed keyring slot. Probing WITH
  // the companion is the only honest check, since that is how termic spawns it.
  { id: "gemini",   env: "GEMINI_CLI_HOME",   probe: ["-p", "say OK"],                     signedOut: /auth|sign|login|credential/i, also: { GEMINI_FORCE_FILE_STORAGE: "true" } },
  { id: "grok",     env: "GROK_HOME",         probe: ["-p", "say OK"],                     signedOut: /not signed in|grok login/i },
  // opencode PRINTS the store it resolved plus a count, so the count is the
  // signal: "0 credentials" under a relocated root means the login followed.
  { id: "opencode", env: "XDG_DATA_HOME",     probe: ["auth", "list"],                     signedOut: /\b0 credentials\b|no (?:credentials|providers)/i },
  { id: "pi",       env: "HOME",              probe: ["auth", "check", "--provider", "openai-codex", "--json"], signedOut: /credentials_not_configured|not_ready/i },
  // Same reason as copilot, plus a caveat this probe cannot see: muse reports
  // itself signed out when its metadata INDEX moves, while the credential may
  // still sit in one shared keychain item. Left here as a note rather than a
  // check, because a passing probe would be misleading.
  { id: "muse",     env: "XDG_CONFIG_HOME",   probe: ["exec", "say OK"],                   signedOut: null, note: "no second account: keychain keying unresolved" },
  // `devin auth status` prints "Not logged in" and the credentials.toml path
  // it resolved, so an empty relocated root showing both means the login
  // followed. Measured on 3000.10.21.
  { id: "devin",    env: "XDG_DATA_HOME",     probe: ["auth", "status"],                   signedOut: /not logged in/i },
];

const TIMEOUT_MS = 45_000;

function have(bin) {
  try { execFileSync("command", ["-v", bin], { shell: true, stdio: "pipe" }); return true; }
  catch { return false; }
}

function run(bin, args, env) {
  try {
    return execFileSync(bin, args, {
      env: { ...process.env, ...env },
      timeout: TIMEOUT_MS, stdio: "pipe", encoding: "utf8",
    });
  } catch (e) {
    // A signed-out CLI usually exits non-zero and says so on stderr, which is
    // the answer rather than a failure to report.
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

const only = process.argv[2];
let checked = 0, drifted = 0, skipped = 0;

for (const a of AGENTS) {
  if (only && a.id !== only) continue;
  if (!have(a.id)) { console.log(`  –  ${a.id.padEnd(9)} not installed`); skipped++; continue; }
  if (!a.signedOut) { console.log(`  –  ${a.id.padEnd(9)} ${a.note}`); skipped++; continue; }

  const dir = mkdtempSync(join(tmpdir(), `termic-login-probe-${a.id}-`));
  try {
    const out = run(a.id, a.probe, { [a.env]: dir, ...(a.also ?? {}) });
    if (a.signedOut.test(out)) {
      // The fast path, and the common one: relocating the variable took the
      // login away, so the table is still true. ONE run, which matters
      // because several of these probes are real prompts.
      checked++;
      console.log(`  ok ${a.id.padEnd(9)} login follows ${a.env}`);
      continue;
    }

    // It answered as though still signed in. That is either real drift or a
    // stale pattern in the row below, and those need different fixes, so
    // disambiguate with a CONTROL run. Done lazily, only on this path, so the
    // passing case never pays for it.
    const control = run(a.id, a.probe, { ...(a.also ?? {}) });
    checked++;
    // THE DISCRIMINATOR IS WHETHER THE VARIABLE CHANGED ANYTHING, not whether
    // the pattern matched. Using the pattern here was wrong and was caught by
    // mutating this file: a pattern that can never match makes BOTH runs
    // "not signed out", which reported a perfectly correct table as drift.
    //
    // Same output with and without the variable means the variable did
    // nothing, which is drift whatever the text says. Different output means
    // it DID something and only the pattern failed to recognise it.
    const norm = (t) => t.replaceAll(dir, "<store>").trim();
    if (norm(out) === norm(control)) {
      drifted++;
      console.log(`  DRIFT ${a.id.padEnd(6)} produced IDENTICAL output with and without ${a.env}.`);
      console.log(`         Its login no longer follows that variable, so agent_dirs::login_store`);
      console.log(`         is stale and two "accounts" would silently share one credential.`);
      console.log(`         Re-measure (docs/adding-an-agent.md §1b) and fix the row. Output:`);
      console.log(out.split("\n").slice(0, 4).map(l => `           ${l}`).join("\n"));
    } else {
      // The variable DID change the output, so the login almost certainly
      // still follows it; what failed is this file's `signedOut` pattern.
      // Saying that beats sending someone to re-measure a correct table.
      skipped++;
      console.log(`  ?  ${a.id.padEnd(9)} cannot tell. ${a.env} DID change the output, so the`);
      console.log(`         login still follows it, but the \`signedOut\` pattern in this file no`);
      console.log(`         longer recognises what signed-out looks like. Update the pattern.`);
      console.log(`         With ${a.env}:`);
      console.log(norm(out).split("\n").slice(0, 3).map(l => `           ${l}`).join("\n"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${checked} probed, ${drifted} drifted, ${skipped} skipped.`);
if (skipped > 0 && drifted === 0) {
  console.log("A skip is not a pass: it means the probe could not tell, so that row is unverified.");
}
process.exit(drifted === 0 ? 0 : 1);
