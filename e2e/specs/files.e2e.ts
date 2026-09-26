import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, dismissOverlays, ensureActiveTask, openTask, requireTermicApi, snap, waitForAppShell } from "../helpers";

// The seeded fixture repo every spec in this file works against.
const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");

declare global {
  interface Window {
    /** Installed by the drag spec so its guard and its drag aim at one pixel. */
    __dropPoint?: (host: HTMLElement) => { x: number; y: number };
  }
}

// P2: dragging a file row onto a terminal types its path at the prompt (GH
// #136) — the in-app twin of dragging a file in from Finder. Cases: a drag
// onto the terminal sends the task-relative path to the PTY and does NOT open
// the file; a drag released outside any terminal types nothing; a plain click
// (no movement) still opens the file.
//
// The gesture is pointer-based, not HTML5 DnD (WKWebView's native drag is
// unreliable and Tauri intercepts it for file drops), so the spec can drive it
// with synthetic pointer events through the app's real handlers.
describe("drag a file onto a terminal", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  const outputAt = () =>
    browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const tabs = s.tabs[id] ?? [];
      const tab = tabs.find((t: any) => t.id === s.activeTab[id]) ?? tabs[0];
      return (tab?.lastOutputAt ?? 0) as number;
    }, taskId);

  const editorTabs = () =>
    browser.execute(
      (id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? [])
          .filter((t: any) => t.type === "edit")
          .map((t: any) => t.path as string),
      taskId,
    );

  // "ok" when the terminal is the topmost element at the drop point; otherwise
  // the class/tag of whatever is covering it (a dialog backdrop or row).
  const topOfTerminal = () =>
    browser.execute(() => {
      const host = document.querySelector("[data-terminal-host]") as HTMLElement | null;
      if (!host) return "no terminal";
      const p = window.__dropPoint!(host);
      const hit = document.elementFromPoint(p.x, p.y) as HTMLElement | null;
      if (!hit) return "nothing";
      return hit.closest("[data-terminal-host]") ? "ok" : hit.className || hit.tagName;
    });

  // Drop near the terminal's bottom-RIGHT, not its center: dialogs are
  // centered, and a palette left open by another spec (specs can share the
  // window) would sit exactly over the middle and eat the drop. Installed on
  // `window` so the guard above and the drag below aim at the same pixel.
  const installDropPoint = () =>
    browser.execute(() => {
      window.__dropPoint = (host: HTMLElement) => {
        const r = host.getBoundingClientRect();
        return { x: r.right - 60, y: r.bottom - 60 };
      };
    });

  // Press the row, move to (x, y), release there. `to` picks the release
  // point from the terminal's own rect so the drop hit test is real.
  const dragRowTo = (row: string, to: "terminal" | "sidebar") =>
    browser.execute(
      (sel, where) => {
        const el = document.querySelector(sel) as HTMLElement;
        const host = document.querySelector("[data-terminal-host]") as HTMLElement;
        const from = el.getBoundingClientRect();
        const target =
          where === "terminal"
            ? window.__dropPoint!(host)
            : { x: from.left + 4, y: from.top + from.height + 60 };
        const at = (type: string, x: number, y: number, node: EventTarget) =>
          node.dispatchEvent(
            new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }),
          );
        at("pointerdown", from.left + 20, from.top + 10, el);
        // Two moves: the first crosses the drag threshold, the second lands.
        at("pointermove", from.left + 60, from.top + 10, window);
        at("pointermove", target.x, target.y, window);
        const highlighted = !!document.querySelector(".termic-drop-target");
        const ghost = !!document.querySelector(".termic-drag-ghost");
        at("pointerup", target.x, target.y, window);
        return {
          highlighted,
          ghost,
          clearedAfterDrop: !document.querySelector(".termic-drop-target"),
          ghostGone: !document.querySelector(".termic-drag-ghost"),
        };
      },
      `[data-path="${row}"]`,
      to,
    );

  it("sends the task-relative path to the terminal", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-drop");

    // The row to drag, and a live terminal to drop it on.
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            !!document.querySelector('[data-path="README.md"]') &&
            !!document.querySelector("[data-terminal-host]"),
        ),
      { timeout: 15_000, timeoutMsg: "tree row + terminal never both appeared" },
    );
    // The window is reused across spec files: an earlier one may have left a
    // dialog backdrop over the terminal, or switched to another task.
    await dismissOverlays();
    await ensureActiveTask(taskId);
    await installDropPoint();
    // The drop is hit-tested with elementFromPoint, so the terminal must be
    // the topmost thing at the release point — a dialog backdrop would eat it.
    // (This describe runs FIRST in the file for that reason: on an occluded
    // window a closing Radix overlay can linger, see the e2e skill.) Dismiss
    // whatever might be up, then wait for the hit test to actually resolve.
    await browser
      .waitUntil(async () => (await topOfTerminal()) === "ok", { timeout: 8_000 })
      .catch(async () => {
        throw new Error(`something is covering the terminal: ${await topOfTerminal()}`);
      });
    // The PTY must be up, or the drop is a no-op by design.
    await browser.waitUntil(async () => (await outputAt()) > 0, {
      timeout: 15_000,
      timeoutMsg: "the agent PTY never produced output",
    });
    const before = await outputAt();

    const drag = await dragRowTo("README.md", "terminal");
    // Mid-drag the gesture is visible: ghost on the cursor, target outlined.
    expect(drag.ghost).toBe(true);
    expect(drag.highlighted).toBe(true);
    // ...and both are gone once it lands.
    expect(drag.clearedAfterDrop).toBe(true);
    expect(drag.ghostGone).toBe(true);

    // The path reached the PTY: the agent echoes what was typed, so fresh
    // output is the observable proof (terminal text lives on a WebGL canvas,
    // never in the DOM).
    await browser.waitUntil(async () => (await outputAt()) > before, {
      timeout: 10_000,
      timeoutMsg: "the dropped path never reached the PTY",
    });
    // A drag is not a click: the file must NOT have opened in an editor tab.
    expect(await editorTabs()).not.toContain("README.md");
    await snap("file-drop-terminal.png");
  });

  it("types nothing when released outside a terminal", async () => {
    const before = await outputAt();
    const drag = await dragRowTo("README.md", "sidebar");
    expect(drag.highlighted).toBe(false);
    expect(await outputAt()).toBe(before);
    expect(await editorTabs()).not.toContain("README.md");
  });

  it("still opens the file on a plain click", async () => {
    await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      '[data-path="README.md"]',
    );
    await browser.waitUntil(async () => (await editorTabs()).includes("README.md"), {
      timeout: 8_000,
      timeoutMsg: "clicking the row no longer opens the file",
    });
  });
});

// P1: the file finder (⌘P). Cases: opens and lists the repo's files; selecting
// a result opens an editor tab for that file.
describe("file finder", () => {
  let taskId!: string;
  // The focus cases need a plain (non-markdown) file, and this spec has to
  // bring its own: a name another spec happens to leave behind is there on a
  // second local run and missing on CI's fresh checkout, which is exactly how
  // these cases passed here and failed there. Stamped so a leftover from an
  // earlier run cannot satisfy them either, and removed in `after`.
  const PLAIN = `finder-focus-${Date.now()}.txt`;
  after(async () => {
    await browser.execute(() =>
      window.__termic!.useUI.getState().closeFileFinder(),
    );
    rmSync(path.join(fixture, PLAIN), { force: true });
    if (taskId) await archiveTask(taskId);
  });

  it("opens and lists the repo's files", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-finder");
    writeFileSync(path.join(fixture, PLAIN), "focus probe\n");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFileFinder(id),
      taskId,
    );
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          [...document.querySelectorAll("[data-row]")].some((r) =>
            r.textContent?.includes("README"),
          ),
        ),
      { timeout: 8_000, timeoutMsg: "file finder never listed README" },
    );
  });

  it("selecting a result opens an editor tab", async () => {
    await browser.execute(() => {
      const row = [...document.querySelectorAll("[data-row]")].find((r) =>
        r.textContent?.includes("README"),
      );
      if (!row) throw new Error("README row not found");
      (row as HTMLElement).click();
    });
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "README.md",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "selecting a file did not open an editor tab" },
    );
    await snap("file-finder.png");
  });

  // ⌘P then ⌘F: the file you just picked is where your keys go. Picking used
  // to leave focus on whatever had it before the dialog (the agent's
  // terminal), so the next ⌘F opened find-in-terminal instead of the file's.
  // Driven with the terminal focused first, since that is the real starting
  // point and the one Radix hands focus back to on close.
  const pickWithEnter = async (name: string) => {
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFileFinder(id),
      taskId,
    );
    const input = 'input[placeholder]';
    await browser.waitUntil(
      () => browser.execute((n) =>
        [...document.querySelectorAll("[data-row]")].some((r) => r.textContent?.includes(n)), name),
      { timeout: 8_000, timeoutMsg: `file finder never listed ${name}` },
    );
    await browser.execute((sel, n) => {
      const el = [...document.querySelectorAll<HTMLInputElement>(sel)]
        .find((i) => i.closest('[role="dialog"]'))!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, n);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, input, name);
    await browser.waitUntil(
      () => browser.execute((n) =>
        document.querySelector('[role="dialog"] [data-row]')?.textContent?.includes(n) ?? false, name),
      { timeout: 8_000, timeoutMsg: `${name} never became the top result` },
    );
    await browser.execute(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].pop() as HTMLElement;
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
  };

  const focusTerminal = () =>
    browser.execute((id) => {
      const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`[data-task-id="${id}"] .xterm-helper-textarea`)]
        .find((el) => (el.closest(".xterm") ?? el).getBoundingClientRect().width > 0);
      if (!ta) throw new Error("no visible terminal to start from");
      ta.focus();
      return document.activeElement === ta;
    }, taskId);

  const editorFocusedFor = (path: string) =>
    browser.execute((id, p) => {
      const tab = (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.type === "edit" && t.path === p) as any;
      if (!tab) return "no tab";
      const ae = document.activeElement;
      if (!ae?.closest(`[data-main-tab-id="${tab.id}"]`)) return `focus is on ${ae?.className || ae?.tagName}`;
      return ae.classList.contains("cm-content") ? "editor" : `inside the tab, on ${ae.className || ae.tagName}`;
    }, taskId, path);

  it("focuses the editor of the file it opens, from a terminal", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      if (agent) s.setActiveTabId(id, agent.id);
    }, taskId);
    await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

    await pickWithEnter(PLAIN);
    await browser.waitUntil(async () => (await editorFocusedFor(PLAIN)) === "editor", {
      timeout: 8_000,
      timeoutMsg: "the picked file's editor did not get focus",
    }).catch(async (e) => { throw new Error(`${e.message}: ${await editorFocusedFor(PLAIN)}`); });
  });

  // A markdown file opens in MarkdownPane, which mounts the editor itself and
  // used to pass it no `active` at all, so neither half could take focus.
  for (const mode of ["source", "preview"] as const) {
    it(`focuses a markdown file opened in ${mode} view`, async () => {
      const before = await browser.execute(() => window.__termic!.usePrefs.getState().markdownDefaultView);
      try {
        await browser.execute((id, m) => {
          const s = window.__termic!.useApp.getState();
          const open = (s.tabs[id] ?? []).find((t: any) => t.type === "edit" && t.path === "README.md") as any;
          if (open) s.closeTab(id, open.id);
          window.__termic!.usePrefs.getState().setMarkdownDefaultView(m);
          const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
          if (agent) s.setActiveTabId(id, agent.id);
        }, taskId, mode);
        await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

        await pickWithEnter("README.md");
        const where = () => browser.execute((id) => {
          const tab = (window.__termic!.useApp.getState().tabs[id] ?? [])
            .find((t: any) => t.type === "edit" && t.path === "README.md") as any;
          const ae = document.activeElement;
          if (!tab || !ae?.closest(`[data-main-tab-id="${tab.id}"]`)) return `outside: ${ae?.tagName}`;
          if (ae.classList.contains("cm-content")) return "editor";
          return ae.closest('[data-testid="source-preview-shell"] > div:last-child > div:last-child') ? "preview" : `tab: ${ae.tagName}`;
        }, taskId);
        const want = mode === "source" ? "editor" : "preview";
        await browser.waitUntil(async () => (await where()) === want, { timeout: 8_000, timeoutMsg: `focus did not land in the ${want}` })
          .catch(async (e) => { throw new Error(`${e.message}: ${await where()}`); });
      } finally {
        await browser.execute((v) => window.__termic!.usePrefs.getState().setMarkdownDefaultView(v), before);
      }
    });
  }

  it("focuses an already-open file's editor too", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      const agent = (s.tabs[id] ?? []).find((t: any) => t.type === "terminal");
      if (agent) s.setActiveTabId(id, agent.id);
    }, taskId);
    await browser.waitUntil(focusTerminal, { timeout: 20_000, timeoutMsg: "the terminal never took focus" });

    await pickWithEnter(PLAIN);
    await browser.waitUntil(async () => (await editorFocusedFor(PLAIN)) === "editor", {
      timeout: 8_000,
      timeoutMsg: "re-picking an open file did not focus its editor",
    }).catch(async (e) => { throw new Error(`${e.message}: ${await editorFocusedFor(PLAIN)}`); });
  });
});

// P1: find-in-files (⇧⌘F) streams results from ripgrep, or git grep where rg
// isn't installed (GH #181). Cases: opens with an input; the dialog names the
// backend that actually ran and offers the install hint only on the fallback;
// a query that matches the fixture README returns a result row with the match
// highlighted; the regexp toggle switches literal → pattern; Aa drops the
// case folding.
describe("find in files", () => {
  let taskId!: string;
  after(async () => {
    await browser.execute(() => {
      window.__termic!.useUI.getState().closeFindInFiles();
      // The e2e profile is shared across spec files: leave the prefs off.
      window.__termic!.usePrefs.getState().setFindInFilesRegex(false);
      window.__termic!.usePrefs.getState().setFindInFilesMatchCase(false);
    });
    if (taskId) await archiveTask(taskId);
  });

  const inputSel = 'input[placeholder^="Find in"]';

  const type = (text: string) =>
    browser.execute((s, v) => {
      const input = document.querySelector(s) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, inputSel, text);

  // Scoped to THIS dialog's list. The file finder, command palette, project
  // picker and prompt palette all render `data-row` too, and a closed Radix
  // dialog's content stays in the DOM (the file finder's README row survives
  // `closeFileFinder()`), so a document-wide count silently satisfies the
  // positive cases and defeats the negative ones.
  const readmeRows = () =>
    browser.execute(() =>
      [...document.querySelectorAll('[data-testid="fif-results"] [data-row]')].filter((r) =>
        r.textContent?.toLowerCase().includes("readme"),
      ).length,
    );

  const clickToggle = (testId: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-testid="${testId}"]`,
    );

  it("opens with a query input", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-fif");
    await browser.execute(
      (id) => window.__termic!.useUI.getState().openFindInFiles(id),
      taskId,
    );
    await browser.waitUntil(
      () => browser.execute((s) => !!document.querySelector(s), inputSel),
      { timeout: 8_000, timeoutMsg: "find-in-files never opened" },
    );
  });

  // Which backend runs depends on the machine (CI runners and dev Macs
  // differ), and it's fixed for the life of the process, so the invariant
  // worth pinning is agreement: the dialog must describe the backend that
  // actually ran, and the "install rg" nudge must never appear to someone
  // who already has it.
  it("names the backend it searched with", async () => {
    const backend = await browser.execute(async () => {
      const info = (await window.__termic!.invoke("task_find_backend")) as {
        backend: string;
        settled: boolean;
      };
      return info.backend;
    });
    expect(["ripgrep", "git-grep"]).toContain(backend);

    const wanted = backend === "ripgrep" ? "ripgrep" : "git grep";
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('[data-testid="fif-status"]')?.textContent ?? "",
        )).includes(wanted),
      { timeout: 10_000, timeoutMsg: `status line never named ${wanted}` },
    );

    const hasHint = await browser.execute(
      () => !!document.querySelector('[data-testid="fif-rg-hint"]'),
    );
    expect(hasHint).toBe(backend === "git-grep");
  });

  it("returns a match for a query present in the repo", async () => {
    // "fixture" is in the committed README ("# e2e fixture").
    await type("fixture");

    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "no result row for the query",
    });
    await snap("find-in-files.png");
  });

  // The match ranges come from ripgrep itself and from a JS re-match on the
  // git grep fallback. Either way the row has to paint the hit, so this
  // guards the seam without caring which side produced it.
  it("highlights the matched text inside the row", async () => {
    const marks = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="fif-results"] [data-row] b')]
        .map((b) => b.textContent?.toLowerCase() ?? ""),
    );
    expect(marks).toContain("fixture");
  });

  // "^# e2e" only matches the committed README as a pattern; as a literal
  // string (the default -F mode) it matches nothing.
  it("finds nothing for a pattern while the regexp toggle is off", async () => {
    await type("^# e2e");
    await browser.waitUntil(async () => (await readmeRows()) === 0, {
      timeout: 10_000,
      timeoutMsg: "the literal search matched a pattern it should not",
    });
  });

  it("matches the pattern once the regexp toggle is on", async () => {
    await clickToggle("fif-regex");
    expect(
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().findInFilesRegex,
      ),
    ).toBe(true);

    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "no result row for the pattern in regexp mode",
    });
    await snap("find-in-files-regex.png");
  });

  // The README holds "# e2e fixture" in lower case, so "Fixture" is the
  // query that separates the two case modes.
  it("matches a differently-cased query while Aa is off", async () => {
    await clickToggle("fif-regex");
    await type("Fixture");
    await browser.waitUntil(async () => (await readmeRows()) > 0, {
      timeout: 10_000,
      timeoutMsg: "case-insensitive search missed a differently-cased query",
    });
  });

  it("drops the match once Aa is on", async () => {
    await clickToggle("fif-case");
    expect(
      await browser.execute(() =>
        window.__termic!.usePrefs.getState().findInFilesMatchCase,
      ),
    ).toBe(true);

    await browser.waitUntil(async () => (await readmeRows()) === 0, {
      timeout: 10_000,
      timeoutMsg: "case-sensitive search still matched the wrong case",
    });
    await snap("find-in-files-case.png");
  });
});

// P1: the file tree. Guards expanding/collapsing a folder. Creates a throwaway
// nested file so there's a folder to toggle, then git-cleans it away.

describe("file tree", () => {
  let taskId!: string;
  after(async () => {
    if (taskId) await archiveTask(taskId);
    execSync(`git -C "${fixture}" clean -fd`);
  });

  const rowExists = (p: string) =>
    browser.execute((sel) => !!document.querySelector(sel), `[data-path="${p}"]`);
  const clickRow = (p: string) =>
    browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      `[data-path="${p}"]`,
    );

  it("expands and collapses a folder", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask("e2e-tree");

    // Create a nested file on disk → a folder appears in the tree; force a
    // re-read (taskFileWrite doesn't mkdir -p, so write it directly).
    mkdirSync(path.join(fixture, "e2e-subdir"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-subdir", "note.txt"), "hi\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );

    await browser.waitUntil(() => rowExists("e2e-subdir"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // Expand → the child file becomes visible.
    await clickRow("e2e-subdir");
    await browser.waitUntil(() => rowExists("e2e-subdir/note.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its child",
    });

    // Collapse → the child is hidden again.
    await clickRow("e2e-subdir");
    await browser.waitUntil(
      async () => (await rowExists("e2e-subdir/note.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );
    await snap("file-tree.png");
  });

  // Re-expanding an already-opened folder must re-read it from disk, so a file
  // created while it was collapsed shows up on reopen WITHOUT any global tree
  // reload (bumpFsRevision). Guards the on-demand per-dir refresh: before it,
  // a re-expand served the stale cache and the new file stayed hidden.
  it("re-expanding a folder re-reads only that dir from disk", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    // A fresh folder with a single child, surfaced via a one-time root reload.
    mkdirSync(path.join(fixture, "e2e-refresh"), { recursive: true });
    writeFileSync(path.join(fixture, "e2e-refresh", "one.txt"), "1\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-refresh"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    // First expand caches + shows the initial child.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/one.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its first child",
    });
    // Collapse (the children cache is kept).
    await clickRow("e2e-refresh");
    await browser.waitUntil(
      async () => (await rowExists("e2e-refresh/one.txt")) === false,
      { timeout: 8_000, timeoutMsg: "collapsing the folder did not hide its child" },
    );

    // Add a SECOND file on disk — deliberately with NO bumpFsRevision, so the
    // ONLY thing that can surface it is the re-expand re-reading this dir.
    writeFileSync(path.join(fixture, "e2e-refresh", "two.txt"), "2\n");

    // Re-expand → the on-demand refresh picks up the new file.
    await clickRow("e2e-refresh");
    await browser.waitUntil(() => rowExists("e2e-refresh/two.txt"), {
      timeout: 8_000,
      timeoutMsg: "re-expanding the folder did not re-read it from disk",
    });
    // The original child is still there too (a refresh, not a replace).
    expect(await rowExists("e2e-refresh/one.txt")).toBe(true);
  });

  // GH #159: a directory read that fails must not leave the row showing
  // "Loading…" forever. Two halves of the same invariant, both driven by
  // chmod 000 (read_dir fails with EACCES, deterministically):
  //   - a failure on a settle reload keeps the listing the tree already had,
  //     instead of dropping the key and rendering a spinner with nothing coming,
  //   - a failure on first expand says so and offers a retry.
  /**
   * Make a leftover chmod-000 directory writable again, then remove it.
   *
   * These two cases restore the mode in a `finally`, which covers a failed
   * assertion but NOT a killed process: interrupt a run here and the fixture
   * repo keeps a directory nobody can read or delete. Every later run then
   * fails somewhere else entirely, in another spec's teardown, on
   * `git clean -fd: permission denied` — a leftover that costs half an hour to
   * connect back to this test.
   */
  const resetUnreadable = (dir: string) => {
    if (!existsSync(dir)) return;
    try { execSync(`chmod -R u+rwx "${dir}"`); } catch { /* already readable */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  };

  it("keeps a folder's contents when a settle reload cannot read it", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const dir = path.join(fixture, "e2e-unreadable");
    resetUnreadable(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "kid.txt"), "k\n");
    await browser.execute(
      (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
      taskId,
    );
    await browser.waitUntil(() => rowExists("e2e-unreadable"), {
      timeout: 10_000,
      timeoutMsg: "the new folder never appeared in the tree",
    });

    await clickRow("e2e-unreadable");
    await browser.waitUntil(() => rowExists("e2e-unreadable/kid.txt"), {
      timeout: 8_000,
      timeoutMsg: "expanding the folder did not reveal its child",
    });

    // The folder becomes unreadable, then an agent settles. Before the fix the
    // reload dropped the failed key from the whole-map replace and the row
    // went to a permanent "Loading…". The sibling file is what makes this bite:
    // the reload skips the whole update when nothing it re-read changed, so the
    // root listing has to differ for the merge to be exercised at all.
    execSync(`chmod 000 "${dir}"`);
    writeFileSync(path.join(fixture, "e2e-unreadable-sibling.txt"), "s\n");
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      // The sibling landing proves the reload ran and updated the tree.
      await browser.waitUntil(() => rowExists("e2e-unreadable-sibling.txt"), {
        timeout: 10_000,
        timeoutMsg: "the settle reload never landed",
      });
      // The unreadable folder kept the listing it already had.
      expect(await rowExists("e2e-unreadable/kid.txt")).toBe(true);
    } finally {
      execSync(`chmod 755 "${dir}"`);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    rmSync(path.join(fixture, "e2e-unreadable-sibling.txt"), { force: true });
  });

  // `chmod 000` does not make a folder unreadable on Windows.
  (process.platform === "win32" ? it.skip : it)("offers a retry when a folder cannot be read at all", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const dir = path.join(fixture, "e2e-denied");
    resetUnreadable(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "kid.txt"), "k\n");
    execSync(`chmod 000 "${dir}"`);
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      await browser.waitUntil(() => rowExists("e2e-denied"), {
        timeout: 10_000,
        timeoutMsg: "the new folder never appeared in the tree",
      });

      // Expand: the read fails (once, then the automatic retry), so the row
      // says so instead of spinning.
      await clickRow("e2e-denied");
      const errorRow = () =>
        browser.execute(
          () => !!document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]'),
        );
      await browser.waitUntil(errorRow, {
        timeout: 10_000,
        timeoutMsg: "an unreadable folder never showed its retry row",
      });

      // And it says WHAT failed, not just that something did (GH #250): the
      // headline names the errno and the raw message names the path.
      const reason = await browser.execute(
        () => {
          const el = document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]') as HTMLElement;
          return { short: el.dataset.reason, title: el.title };
        },
      );
      expect(reason.short).toBe("Permission denied");
      expect(reason.title).toContain("e2e-denied");
      expect(reason.title).toContain("os error 13");

      // Make it readable and click Retry: the contents arrive, no collapse
      // and re-expand needed.
      execSync(`chmod 755 "${dir}"`);
      await browser.execute(() =>
        (document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-denied"]') as HTMLElement).click(),
      );
      await browser.waitUntil(() => rowExists("e2e-denied/kid.txt"), {
        timeout: 8_000,
        timeoutMsg: "Retry did not load the folder once it was readable again",
      });
    } finally {
      execSync(`chmod 755 "${dir}"`);
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  // A folder that is a symlink OUT of the task reads as a directory but can
  // never be listed: safe_task_path canonicalizes and rejects it. Retrying is
  // hopeless, so the row has to say why (GH #250). This is also the shape a
  // permanently-stuck folder takes in a real repo (a linked vendor dir, a
  // shared cache), which is the leading suspect for that report.
  it("says a folder links outside the task instead of offering a pointless retry", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));

    const outside = path.join(fixture, "..", "e2e-outside-target");
    const link = path.join(fixture, "e2e-escaped");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "s\n");
    // From Node rather than `ln -s`: Git Bash's ln copies the folder unless
    // told otherwise, and a copy escapes nothing. A junction on Windows
    // needs no privilege, unlike a directory symlink.
    try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* none */ } }
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      await browser.execute(
        (id) => window.__termic!.useApp.getState().bumpFsRevision(id),
        taskId,
      );
      await browser.waitUntil(() => rowExists("e2e-escaped"), {
        timeout: 10_000,
        timeoutMsg: "the symlinked folder never appeared in the tree",
      });

      await clickRow("e2e-escaped");
      await browser.waitUntil(
        () =>
          browser.execute(
            () => !!document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-escaped"]'),
          ),
        { timeout: 10_000, timeoutMsg: "the escaping folder never showed its error row" },
      );
      const reason = await browser.execute(
        () => {
          const el = document.querySelector('[data-testid="dir-read-failed"][data-dir="e2e-escaped"]') as HTMLElement;
          return { short: el.dataset.reason, title: el.title };
        },
      );
      expect(reason.short).toBe("This folder links outside the task");
      expect(reason.title).toContain("path escapes task");
      expect(reason.title).toContain("e2e-outside-target");
    } finally {
      // A directory symlink is a directory to Windows: unlink refuses it
      // (EISDIR / EPERM) and rmdir removes the link without its target.
      try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* gone */ } }
      rmSync(outside, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  // Clicking an image in the tree must render the picture, not an empty pane:
  // the tab routes to PreviewPane (previewKindForPath) and the bytes arrive as
  // base64 over taskFileReadBase64. The fixture's committed shot.png is the
  // subject (scripts/e2e-seed.mjs).
  it("previews an image clicked in the tree", async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = taskId ?? (await openTask("e2e-tree"));
    await ensureActiveTask(taskId);

    await browser.waitUntil(() => rowExists("shot.png"), {
      timeout: 10_000,
      timeoutMsg: "shot.png never appeared in the tree",
    });
    await clickRow("shot.png");

    // The tab opened as an edit tab...
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "shot.png",
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "clicking the image never opened a tab" },
    );

    // ...and it renders a real, decoded image rather than an empty pane.
    await browser.waitUntil(
      async () => {
        const r = await browser.execute((id) => {
          const pane = document.querySelector(`[data-task-id="${id}"]`);
          const img = pane?.querySelector('img[src^="data:image/"]') as HTMLImageElement | null;
          if (!img) return { found: false, w: 0, h: 0 };
          return { found: true, w: img.naturalWidth, h: img.naturalHeight };
        }, taskId);
        return r.found && r.w > 0 && r.h > 0;
      },
      { timeout: 10_000, timeoutMsg: "the image preview never rendered decoded pixels" },
    );
    await snap("image-preview.png");
  });
});

// P2: the file row's right-click menu hands the file to the OS (GH #147).
// Cases: the two OS actions lead the menu in the agreed order; a binary the
// editor can't render (.blend), a text file it CAN render (.scad) and an image
// with its own in-app viewer (.png) all open externally; a folder offers no
// "Open in default app"; and double-click still PINS rather than launching.
//
// The .scad case is the one that settled the design discussion: it is plain
// text, so the editor renders it perfectly, yet the user still wants OpenSCAD.
// No "is this file renderable" heuristic can express that, which is why this
// lives on an explicit menu entry rather than a gesture.
//
// The e2e binary records opens to a log instead of running them (see
// `open_file_external` in lib.rs): the suite must not launch Blender, and the
// reveal fallback would pop a Finder window over the window under test.
describe("open a file in its default app", () => {
  let taskId!: string;
  const openedLog = path.join(process.cwd(), ".e2e", "profile", "e2e-opened.log");

  after(async () => {
    rmSync(openedLog, { force: true });
    for (const f of ["e2e-model.blend", "e2e-part.scad", "e2e-shot.png"]) {
      rmSync(path.join(fixture, f), { force: true });
    }
    rmSync(path.join(fixture, "e2e-open-dir"), { force: true, recursive: true });
    if (taskId) await archiveTask(taskId);
  });

  const opened = () => {
    try {
      return readFileSync(openedLog, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];   // not written yet — the caller is inside a waitUntil
    }
  };

  // Dispatched, not driven: a WebDriver right-click does not reach Radix's
  // onContextMenu in this WKWebView (measured), the same class of gap as its
  // double-click. A `contextmenu` MouseEvent goes through the real Radix
  // trigger, so everything from the menu opening downwards is genuinely
  // exercised — which the gesture-based version could never claim.
  const openRowMenu = async (rel: string) => {
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) throw new Error(`no row ${sel}`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, button: 2,
          clientX: r.left + 10, clientY: r.top + 10,
        }),
      );
    }, `[data-path="${rel}"]`);
    await browser.waitUntil(async () => (await menuItems()).length > 0, {
      timeout: 8_000,
      timeoutMsg: `the context menu never opened for ${rel}`,
    });
  };

  // Scoped to the menu that holds the path items, never a bare [role="menu"]:
  // menus stack, and a closing one can linger in the DOM (see the e2e skill).
  //
  // Labels come from innerText, one line per item, NOT from a [role="menuitem"]
  // query: ContextMenuItem passes role={undefined} for plain items (it only
  // sets a role for the radio variant), so the ARIA selector matches nothing.
  const menuItems = () =>
    browser.execute(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Copy path"),
      ) as HTMLElement | undefined;
      if (!menu) return [] as string[];
      return menu.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    });

  const clickMenuItem = (label: string) =>
    browser.execute((text) => {
      const menu = [...document.querySelectorAll('[role="menu"]')].find((m) =>
        (m as HTMLElement).innerText.includes("Copy path"),
      ) as HTMLElement | undefined;
      if (!menu) throw new Error("the path context menu is not open");
      // Deepest element whose own text is exactly the label, so a wrapper that
      // happens to contain it doesn't get clicked instead.
      const item = [...menu.querySelectorAll("*")]
        .reverse()
        .find((i) => (i as HTMLElement).innerText?.trim() === text) as HTMLElement | undefined;
      if (!item) throw new Error(`no menu item "${text}"`);
      item.click();
    }, label);

  const openExternally = async (rel: string) => {
    rmSync(openedLog, { force: true });
    await openRowMenu(rel);
    await clickMenuItem("Open in default app");
    await browser.waitUntil(() => opened().length > 0, {
      timeout: 8_000,
      timeoutMsg: `"Open in default app" on ${rel} never reached the backend`,
    });
    return opened();
  };

  it("leads the menu with the two OS actions, in order", async () => {
    await waitForAppShell();
    await requireTermicApi();

    // Written BEFORE the task opens, at the repo root, so the tree picks them
    // up on its initial load rather than through a mid-run refresh.
    writeFileSync(path.join(fixture, "e2e-model.blend"), Buffer.from([0x00, 0xff, 0x00]));
    writeFileSync(path.join(fixture, "e2e-part.scad"), "cube([1,1,1]);\n");
    // This describe's own folder, so the dir case does not depend on one that
    // another describe creates in a different task.
    mkdirSync(path.join(fixture, "e2e-open-dir"), { recursive: true });
    // A 1x1 PNG: the routing class with its OWN in-app viewer (previewPaths).
    writeFileSync(
      path.join(fixture, "e2e-shot.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );

    taskId = await openTask("e2e-open");
    await dismissOverlays();
    await ensureActiveTask(taskId);
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector('[data-path="e2e-model.blend"]')),
      { timeout: 15_000, timeoutMsg: "the .blend row never appeared in the tree" },
    );

    await openRowMenu("e2e-model.blend");
    const items = await menuItems();
    expect(items[0]).toBe("Open in default app");
    expect(items[1]).toMatch(/^Reveal in /);
    await snap("file-context-menu.png");
    await browser.keys(["Escape"]);
  });

  it("opens a binary the editor cannot render", async () => {
    // .blend is not valid UTF-8, so clicking it only ever gets the "it looks
    // binary" editor message. The case with no in-app answer at all.
    const paths = (await openExternally("e2e-model.blend")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-model.blend"))).toBe(true);
    // Absolute, not task-relative: the backend shells out with no task context.
    expect(/^(\/|[A-Za-z]:\/)/.test(paths[paths.length - 1])).toBe(true);
  });

  it("opens a text file the editor renders perfectly well", async () => {
    const paths = (await openExternally("e2e-part.scad")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-part.scad"))).toBe(true);
  });

  it("opens an image that has its own in-app viewer", async () => {
    // A PNG already previews in the app, so the external open is an ADDITION
    // here. "termic can show it" is not a reason to withhold the real editor.
    const paths = (await openExternally("e2e-shot.png")).map((p: string) => p.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("/e2e-shot.png"))).toBe(true);
  });

  it("offers no default-app entry for a folder", async () => {
    // `openPath` on a directory already means "open it in the file manager",
    // so a folder would otherwise show the same action twice.
    await openRowMenu("e2e-open-dir");
    const items = await menuItems();
    expect(items).not.toContain("Open in default app");
    expect(items[0]).toMatch(/^Open in /);   // the file-manager entry leads
    await browser.keys(["Escape"]);
  });

  it("keeps double-click as pin, launching nothing", async () => {
    // The convention Simion flagged: single click previews, double click keeps
    // the tab. A regression here would launch an app from a gesture that every
    // major editor uses for pinning.
    rmSync(openedLog, { force: true });
    const previewTabs = () =>
      browser.execute(
        (id) =>
          (window.__termic!.useApp.getState().tabs[id] ?? [])
            .filter((t: any) => t.type === "edit" && t.path === "e2e-part.scad").length,
        taskId,
      );
    await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLElement).click(),
      '[data-path="e2e-part.scad"]',
    );
    // Wait for the tab before the second click: onDoubleClick looks the tab up
    // in the `tabs` array from its own render, so firing both in one
    // synchronous block would hand it a stale list and pin nothing. A real
    // user's two clicks are separated by a re-render; this reproduces that.
    await browser.waitUntil(async () => (await previewTabs()) > 0, {
      timeout: 8_000,
      timeoutMsg: "the first click never opened a preview tab",
    });
    await browser.execute(
      (sel) =>
        (document.querySelector(sel) as HTMLElement).dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
        ),
      '[data-path="e2e-part.scad"]',
    );
    await browser.waitUntil(
      () =>
        browser.execute(
          (id) =>
            (window.__termic!.useApp.getState().tabs[id] ?? []).some(
              (t: any) => t.type === "edit" && t.path === "e2e-part.scad" && !t.preview,
            ),
          taskId,
        ),
      { timeout: 8_000, timeoutMsg: "double-click no longer pins the preview tab" },
    );
    expect(opened()).toEqual([]);
  });
});
