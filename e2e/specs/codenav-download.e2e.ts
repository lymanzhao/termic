import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  archiveTask, ensureActiveTask, openTask, requireTermicApi, waitForAppShell, waitVisible, waitGone,
} from "../helpers";

// The pinned-download path (GH #174), driven through the app's own commands
// against the real internet.
//
// **Opt-in**: it fetches tens of MB from GitHub and HashiCorp, so it is skipped unless
// `E2E_LSP_DOWNLOADS=1` is set. `make e2e` and CI do not run it; a maintainer
// runs it after touching the manifest, or to check that upstream has not moved
// out from under it.
//
//   E2E_LSP_DOWNLOADS=1 npm run test:e2e -- --spec e2e/specs/codenav-download.e2e.ts
//
// What it proves that a unit test cannot: the release API still names the
// asset the manifest expects, the bytes still match the digest that release
// advertises, the archive still holds the executable where the manifest says,
// the binary runs on this machine (no quarantine prompt, no missing sibling
// files) and the server it becomes answers about real code.

const ENABLED = process.env.E2E_LSP_DOWNLOADS === "1";

const install = async (language: string) =>
  await browser.execute(async (lang) => {
    try {
      return { ok: true, value: String(await window.__termic!.invoke("lsp_install", { language: lang })) };
    } catch (e) {
      return { ok: false, value: String(e) };
    }
  }, language) as { ok: boolean; value: string };

const offer = async (root: string, language: string) =>
  await browser.execute(
    async (r, lang) => await window.__termic!.invoke("lsp_offer", { root: r, language: lang }),
    root, language,
  ) as { exe: string | null; installLabel: string | null; installBytes: number | null };

const taskPath = (taskId: string) =>
  browser.execute(
    (id) => window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id)?.path as string,
    taskId,
  ) as Promise<string>;

const openFile = (taskId: string, rel: string) =>
  browser.execute((id, p) => {
    window.__termic!.useApp.getState().openPreviewTab(id, { type: "edit", path: p, title: p });
  }, taskId, rel);


/**
 * Upstream's latest TypeScript release tag, or null when the release API did
 * not answer usefully.
 *
 * Deliberately the same conditions `lsp_resolve_asset` applies in `lib.rs`: a
 * tag, an asset named for THIS platform, and a 64-char sha256 digest on it. A
 * probe that accepted less would report "the API answered" for a release the
 * app is right to fall back to the pin on, and the case below would then blame
 * termic for upstream's change.
 */
const latestTypescriptRelease = async (): Promise<string | null> => {
  const asset = process.arch === "arm64"
    ? "typescript-darwin-arm64.tgz"
    : "typescript-darwin-x64.tgz";
  try {
    const resp = await fetch("https://api.github.com/repos/microsoft/typescript/releases/latest", {
      // GitHub rejects an API request with no User-Agent, exactly as the app's
      // own client sets one.
      headers: { "User-Agent": "termic-e2e" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string; digest?: string }[];
    };
    const tag = (body.tag_name ?? "").replace(/^v/, "");
    const a = (body.assets ?? []).find(x => x.name === asset);
    const digest = a?.digest?.replace(/^sha256:/, "") ?? "";
    if (!tag || !a?.browser_download_url || digest.length !== 64) return null;
    return tag;
  } catch {
    return null;
  }
};

/** Arm one checkout for one server, through the key EditorPane reads. */
const armGrant = (root: string, taskId: string, server: string) =>
  browser.execute((r, id, sv) => {
    const { useCodeIntel, grantKey } = (window as any).__termic.codeIntel;
    useCodeIntel.getState().arm(grantKey(r, sv), id);
  }, root, taskId, server);

describe("code intelligence: server downloads", function () {
  // Two of these are 14 MB over the network, then unpacked.
  this.timeout(300_000);

  let taskId = "";
  let root = "";

  before(async function () {
    if (!ENABLED) this.skip();
    await waitForAppShell();
    await requireTermicApi();
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setCodeIntelligence(true);
      // The point of this file is real diagnostics from a real server, and
      // type checking ships OFF. Without this the two squiggle cases wait
      // two minutes for something the pref is suppressing.
      window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(true);
    });
    taskId = await openTask("lsp-download");
    root = await taskPath(taskId);
    await ensureActiveTask(taskId);
  });

  after(async () => {
    if (!ENABLED) return;
    // Same guard as codenav.e2e.ts: `after()` runs even when `before()` threw,
    // and an empty `root` turns every sweep below into a path relative to the
    // wdio process cwd, which is this repo.
    if (!root) return;
    // The fixture repo is shared with every other spec file, and a dirty tree
    // fails git.e2e's "clean working tree" plus two layout specs.
    for (const rel of ["broken.ts", "download.tf"]) rmSync(path.join(root, rel), { force: true });
    rmSync(path.join(root, "pysrc"), { recursive: true, force: true, maxRetries: 10 });
    await browser.execute(() => window.__termic!.useCodeIntel.setState({ grants: {} }));
    await browser.execute(async () => {
      const servers: any[] = await window.__termic!.invoke("lsp_list");
      for (const s of servers) await window.__termic!.invoke("lsp_stop", { id: s.id });
    });
    // Back to the app's DEFAULT, which is on. Restoring `false` persisted a
    // non-default into the shared profile's localStorage, so every later spec
    // file and every later run started with the chip suppressed.
    await browser.execute(() => {
      window.__termic!.usePrefs.getState().setCodeIntelligence(true);
      window.__termic!.usePrefs.getState().setCodeIntelDiagnostics(false);
    });
    if (taskId) await archiveTask(taskId);
  });

  it("requires confirmation before downloading Terraform", async function () {
    const before = await offer(root, "terraform");
    // This is the first-install path. A developer who already installed it
    // must not have their server removed just to test the prompt again.
    if (before.exe) { this.skip(); return; }
    writeFileSync(path.join(root, "download.tf"), 'output "broken" {\n  value = var.missing_name\n}\n');
    await openFile(taskId, "download.tf");
    await browser.waitUntil(async () => await browser.execute(() =>
      document.querySelector('[data-testid="code-intel-chip"]')?.textContent?.includes("Install terraform-ls")),
    { timeout: 15_000, timeoutMsg: "Terraform install button never appeared" });
    expect((await offer(root, "terraform")).exe).toBeNull();
    await browser.execute(() => (document.querySelector('[data-testid="code-intel-chip"]') as HTMLElement).click());
    await waitVisible('[data-testid="confirm-ok"]');
    const message = await browser.execute(() =>
      document.querySelector('[data-testid="confirm-ok"]')?.closest('[role="dialog"]')?.textContent);
    expect(message).toContain("terraform-ls");
    expect(message).toMatch(/\d+ MB/);
    await browser.execute(() => (document.querySelector('[data-testid="confirm-cancel"]') as HTMLElement).click());
    await waitGone('[data-testid="confirm-ok"]');
    expect((await offer(root, "terraform")).exe).toBeNull();
  });

  for (const language of ["typescript", "python", "rust", "terraform"]) {
    it(`downloads and verifies the ${language} server`, async () => {
      const res = await install(language);
      // The error carries the reason: a renamed asset, an unreachable API, or
      // bytes that do not match the digest the release advertises. All three
      // are things to fix, so the message has to reach whoever ran this.
      if (!res.ok) throw new Error(`install ${language} failed: ${res.value}`);
      expect(existsSync(res.value)).toBe(true);
      // Installed under termic's own directory, never on the user's PATH.
      expect(res.value).toContain("/servers/");
      expect(res.value).toContain(language);

      // Idempotent: a second call is free rather than a second download.
      const again = await install(language);
      expect(again.value).toBe(res.value);
    });
  }

  it("resolves the downloaded server for a checkout with no toolchain", async () => {
    const o = await offer(root, "typescript");
    // Nothing about TypeScript is installed in the e2e fixture repo, so the
    // one termic downloaded is what a task would drive.
    expect(o.exe).toBeTruthy();
    expect(o.exe).toContain("/servers/typescript/");
  });

  it("reports what is installed and what upstream has", async () => {
    const row = await browser.execute(async () =>
      await window.__termic!.invoke("lsp_check_update", { language: "typescript" }),
    ) as { installed: string | null; latest: string | null; upgradable: boolean; label: string };
    expect(row.label).toContain("TypeScript");
    // Installed by the case above, so this half is known whatever the network
    // did. `.staging` is termic's own bookkeeping and lived in this directory
    // as the newest entry, which used to be read back here as the installed
    // version: see rule 20 in docs/lsp.md.
    expect(row.installed).toBeTruthy();
    expect(row.installed!.startsWith(".")).toBe(false);

    // Whatever the network did, this one holds, and it is the one that matters
    // most: we installed the latest a moment ago, and an app that cannot reach
    // the API must claim no upgrade rather than offer the user a DOWNGRADE to
    // whatever constant this build was compiled with.
    expect(row.upgradable).toBe(false);
    if (row.latest) expect(row.installed).toBe(row.latest);

    // The other half is upstream's, and asking for it costs one unauthenticated
    // GitHub API call. That budget is 60/hour PER IP, and a macOS Actions
    // runner shares its IP with every other job on the fleet, so a nightly that
    // asserts "the API answered" is asserting something termic does not
    // control: this file already spends four calls of that budget itself, and
    // the run that proved the point flipped from answered to rate-limited 37
    // minutes apart with no code change in between.
    //
    // So probe the same endpoint from here and let the probe decide which
    // assertion is honest. Same IP, same minute, same rate limiter.
    const upstream = await latestTypescriptRelease();

    if (!upstream) {
      // Out of API budget, or upstream is down. Not termic, and the invariants
      // above already ran. Loud rather than a silent skip, because a quiet one
      // is how this nightly would stop catching what it exists to catch.
      console.warn(
        "[lsp-download] the GitHub release API did not answer (rate limit or outage), so the " +
        `installed-vs-latest comparison was not exercised. Installed: ${row.installed}.`,
      );
      return;
    }

    if (!row.latest) {
      // The API answers us but not the app. Usually that IS a termic bug (a
      // renamed asset, a release that stopped publishing a digest, a resolver
      // that gave up early), and it is the single most valuable thing this
      // file can catch. The one innocent explanation is the budget hitting
      // zero in the gap between the app's call and ours, so re-probe: if the
      // API has stopped answering us too, that is what happened.
      if (!(await latestTypescriptRelease())) {
        console.warn(
          "[lsp-download] the release API stopped answering between the app's call and this " +
          "one, so which of the two was rate-limited is not decidable. Not exercised.",
        );
        return;
      }
      throw new Error(
        `the release API resolves ${upstream} from this process, but lsp_check_update reported ` +
        "no latest version. Check that the manifest's asset name still exists on the release " +
        "and that it still carries a sha256 digest.",
      );
    }

    // Both answered, so the comparison is real.
    expect(row.latest).toBe(upstream);
    expect(row.installed).toBe(upstream);
  });

  it("drives the downloaded TypeScript server against a real error", async () => {
    // A deliberate type error, so the end of the pipe is observable: real
    // server, real diagnostics, real squiggle.
    writeFileSync(path.join(root, "broken.ts"), 'export const n: number = "not a number";\n');
    await openFile(taskId, "broken.ts");
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    // `grantKey(root, server)`, not the bare root. EditorPane reads
    // `grants[grantKey(navRoot, navServer)]`, so arming the bare path put the
    // grant in a slot nothing reads: no client was ever acquired and the
    // 120s wait below could only ever time out. Nobody noticed because this
    // file is E2E_LSP_DOWNLOADS-gated and skipped by `make e2e`.
    await armGrant(root, taskId, "typescript");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 120_000);
    const server = (await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[]).find(s => s.language === "typescript");
    expect(server).toBeTruthy();
    expect(server.root).toBe(root);
  });

  it("drives the downloaded Python server against a real error", async () => {
    rmSync(path.join(root, "broken.ts"), { force: true });
    mkdirSync(path.join(root, "pysrc"), { recursive: true });
    writeFileSync(path.join(root, "pysrc", "broken.py"), "def f(x: int) -> int:\n    return \"nope\"\n");
    await openFile(taskId, "pysrc/broken.py");
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    // Python is its own grant: agreeing to TypeScript above says nothing about
    // starting a second process for a second language.
    await armGrant(root, taskId, "python");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 120_000);
    const server = (await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[]).find(s => s.language === "python");
    expect(server).toBeTruthy();
  });

  it("drives the downloaded Terraform server against a real error", async () => {
    writeFileSync(path.join(root, "download.tf"), 'output "broken" {\n  value = var.missing_name\n}\n');
    await openFile(taskId, "download.tf");
    await waitVisible(`[data-task-id="${taskId}"] .cm-editor`);
    await armGrant(root, taskId, "terraform");
    await waitVisible(`[data-task-id="${taskId}"] .cm-lintRange`, 60_000);
    const server = (await browser.execute(async () =>
      await window.__termic!.invoke("lsp_list")) as any[]).find(s => s.language === "terraform");
    expect(server?.command).toContain("/servers/terraform/");
    expect(server?.root).toBe(root);
  });
});
