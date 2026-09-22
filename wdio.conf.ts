import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// End-to-end config for the termic app. WebdriverIO drives the REAL macOS
// WKWebView window via @wdio/tauri-service's embedded WebDriver provider
// (tauri-plugin-wdio-webdriver, compiled in only by `--features e2e`). Build
// the app first with `npm run e2e:build`, then run `npm run test:e2e`.
//
// SERIAL by design. Parallel (maxInstances > 1) is NOT usable with this stack:
// the tauri-service spawns each app from the launcher with the launcher's env,
// differing only by WebDriver port — so per-worker TERMIC_DATA_DIR (isolated
// profiles for the fixture-mutating specs) can't be injected without an
// invasive, flake-prone app-side port→datadir mapping. Stability wins.

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(repoRoot, "src-tauri", "target", "debug", "termic");
/** Exported so specs that need the control socket agree with the launcher. */
export const dataDir = path.join(repoRoot, ".e2e", "profile");
/** Where `TERMIC_E2E_TIMING=1` writes per-test durations. */
const timingLog = path.join(repoRoot, ".e2e", "timings.txt");
const artifactsDir = path.join(repoRoot, ".e2e", "artifacts");

export const config: WebdriverIO.Config = {
  runner: "local",
  tsConfigPath: path.join(repoRoot, "e2e", "tsconfig.json"),

  specs: [path.join(repoRoot, "e2e", "specs", "**", "*.e2e.ts")],
  maxInstances: 1,

  // `tauri:options` is a VENDOR capability extension that the embedded
  // WebDriver reads, and WebdriverIO's capability type does not know it. The
  // cast is the whole reason this file was never typechecked cleanly, so it is
  // narrowed to the one entry rather than loosening the config's type.
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appBinary },
    } as WebdriverIO.Capabilities,
  ],

  services: [
    ["@wdio/tauri-service", { appBinaryPath: appBinary, driverProvider: "embedded" }],
  ],

  framework: "mocha",
  reporters: ["spec"],
  // "silent" silences the wdio LOGGER only (the spec reporter's ✓/✗ + summary
  // is unaffected). Kills two streams of noise this stack emits and we can't
  // otherwise disable: the false "tauri-driver not found" diagnostic (we use
  // the embedded provider) and the afterSession "Failed to clear mock store"
  // stack trace (we don't use the mock plugin; restoreAllMocks runs anyway).
  logLevel: "silent",
  mochaOpts: { ui: "bdd", timeout: 60_000 },

  // Poll conditions every 100ms (default 500) so browser.waitUntil-based waits
  // fire the instant the condition is met. NOTE: we deliberately do NOT use
  // WebdriverIO's native element visibility (waitForDisplayed/isDisplayed): on
  // this offscreen WKWebView it triggers Tauri window-state calls that time out
  // 5s each. The waitVisible()/clickWhenVisible() helpers do a fast client-side
  // check instead.
  waitforTimeout: 15_000,
  waitforInterval: 100,

  onPrepare() {
    mkdirSync(artifactsDir, { recursive: true });
    // The app is launched as a child of this process and inherits env, so
    // point it at the throwaway profile (seeded by scripts/e2e-seed.mjs).
    process.env.TERMIC_DATA_DIR = dataDir;
    // Agent-hook installs write into an agent's own config dir. Point that at
    // the throwaway profile so a run can exercise install/remove without
    // touching the developer's real ~/.claude/settings.json. Honoured only by
    // the `e2e`-feature binary (agent_hooks::host_config_dir).
    process.env.TERMIC_E2E_AGENT_HOME = dataDir;
    // Touch ID for sudo offer: `perl` stands in for sudo, eligibility is
    // forced and the enable script is a stub (sudo_touchid.rs). Honoured only
    // by the `e2e`-feature binary.
    process.env.TERMIC_E2E_FAKE_SUDO = "1";
    // Purge accumulated tasks so every run starts lean (specs create their own;
    // archived tasks otherwise pile up across runs and bloat loadAll/sidebar).
    try {
      for (const f of readdirSync(path.join(dataDir, "tasks"))) {
        if (f.endsWith(".json"))
          rmSync(path.join(dataDir, "tasks", f), { force: true });
      }
    } catch {
      /* no tasks dir yet */
    }
    // Scratchpads (GH #244) live in the SAME profile, keyed by task id. The
    // task records above are being purged, so their pads are orphaned by
    // definition; leaving them behind means specs eventually start seeing
    // each other's notes in a strip they expected to be empty.
    rmSync(path.join(dataDir, "scratch"), { recursive: true, force: true });
    seedArchive();
    if (process.env.TERMIC_E2E_TIMING) rmSync(timingLog, { force: true });
  },

  /** Per-test durations, opt-in with `TERMIC_E2E_TIMING=1`.
   *
   *  The spec reporter prints pass/fail and a per-FILE total, which is
   *  enough to know a file is slow and useless for knowing why. Guessing
   *  which case costs the minutes is how you end up optimising a 300ms
   *  sleep in a seven minute file. Off by default: it writes a file and
   *  nobody needs it on a normal run. */
  afterTest(test, _context, result) {
    if (!process.env.TERMIC_E2E_TIMING) return;
    const ms = (result as { duration?: number }).duration ?? 0;
    appendFileSync(timingLog, `${String(ms).padStart(7)}  ${test.parent} > ${test.title}\n`);
  },
};

/** Archived task records, written straight to disk before the run.
 *
 *  `app.e2e.ts` needs a History list taller than its own pane, and it used to
 *  build one by creating and archiving tasks through the app, one IPC round
 *  trip each, roughly twenty of them. On a freshly seeded profile that is
 *  minutes of a window sitting on the History screen doing nothing visible,
 *  and it only ever looked fast because runs used to inherit the archive the
 *  previous run left behind: with enough of those the loop created nothing
 *  and the case asserted nothing.
 *
 *  Records, not worktrees. An archived task has no working directory by
 *  definition (archiving deletes it), so a JSON file is the whole truth and
 *  `path` points at something that is allowed not to exist. Only the fields
 *  without a serde default are required; everything else is Task::default.
 *
 *  Written here rather than in `scripts/e2e-seed.mjs` because the sweep above
 *  runs on every `test:e2e`, including the ones that skip the seed script,
 *  and would delete them.
 */
function seedArchive() {
  const projects = path.join(dataDir, "projects.json");
  let projectId = "";
  try {
    const list = JSON.parse(readFileSync(projects, "utf8")) as { id: string; name: string }[];
    projectId = list.find(p => p.name === "fixture-repo")?.id ?? "";
  } catch { /* no profile yet: the seed script has not run, nothing to attach to */ }
  if (!projectId) return;
  const when = new Date("2026-01-01T00:00:00Z").toISOString();
  for (let i = 0; i < 30; i++) {
    const n = String(i).padStart(2, "0");
    const id = `aaaaaaaa-0000-4000-8000-${n.padStart(12, "0")}`;
    writeFileSync(path.join(dataDir, "tasks", `${id}.json`), JSON.stringify({
      id,
      project_id: projectId,
      name: `seeded archive ${n}`,
      branch: `seeded/archive-${n}`,
      base_branch: "origin/main",
      // Archived, so this directory is gone by construction.
      path: path.join(dataDir, "tasks", "gone", `archive-${n}`),
      cli: "fakeagent",
      port: 60000 + i,
      created: when,
      archived: true,
      archived_at: when,
      is_main_checkout: false,
    }, null, 2));
  }
}
