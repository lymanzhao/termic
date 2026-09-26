// Precedence + preset invariants for the configurable preview browser (GH #245).
// The precedence table is the part a reader gets wrong, because "empty" means
// two different things depending on which level it is on.

import { describe, it, expect } from "vitest";
import {
  resolveBrowserCommand, browserPresets, WINDOWS_BROWSER_PRESETS,
  MAC_BROWSER_PRESETS, LINUX_BROWSER_PRESETS,
} from "@/lib/previewBrowser";

describe("resolveBrowserCommand", () => {
  it("uses the global setting when the project has no opinion", () => {
    expect(resolveBrowserCommand("open -a Safari", undefined)).toBe("open -a Safari");
  });

  it("lets a project override the global setting", () => {
    expect(resolveBrowserCommand("open -a Safari", "firefox")).toBe("firefox");
  });

  it("lets a project force the system default despite a global browser", () => {
    // The reason Project.preview_browser is optional rather than a plain
    // string: "" is a real choice here, distinct from "inherit".
    expect(resolveBrowserCommand("open -a Safari", "")).toBe("");
  });

  it("is the system default when nothing is configured anywhere", () => {
    expect(resolveBrowserCommand(undefined, undefined)).toBe("");
    expect(resolveBrowserCommand("", undefined)).toBe("");
  });

  it("does not treat an inheriting project as a system-default choice", () => {
    // Regression guard for the easy bug: `projectCmd || globalCmd` would
    // collapse "" into "inherit" and make the override unreachable.
    expect(resolveBrowserCommand("firefox", undefined)).toBe("firefox");
    expect(resolveBrowserCommand("firefox", "")).toBe("");
  });
});

describe("browser presets", () => {
  it("offers the system default first on both platforms", () => {
    // The first entry is what an untouched install shows, and it must be the
    // no-op, or opening Settings once would change behaviour.
    expect(MAC_BROWSER_PRESETS[0].command).toBe("");
    expect(LINUX_BROWSER_PRESETS[0].command).toBe("");
  });

  it("picks the list by platform", () => {
    expect(browserPresets("MacIntel")).toBe(MAC_BROWSER_PRESETS);
    expect(browserPresets("Linux x86_64")).toBe(LINUX_BROWSER_PRESETS);
    expect(browserPresets("Win32")).toBe(WINDOWS_BROWSER_PRESETS);
    // Windows presets name a quoted absolute path: the browsers are not on
    // PATH there, and the path has spaces.
    for (const p of WINDOWS_BROWSER_PRESETS.filter(p => p.command)) {
      expect(p.command).toMatch(/^"C:\\Program Files[^"]*\.exe"/);
    }
  });

  it("never ships a profile preset naming a profile that usually does not exist", () => {
    // A fresh Chrome/Edge/Brave has exactly ONE profile directory and it is
    // called `Default`. Shipping `Profile 1` (the tempting guess) would fail
    // for most users as a link that silently does nothing, which is the exact
    // complaint this feature exists to fix.
    const all = [...MAC_BROWSER_PRESETS, ...LINUX_BROWSER_PRESETS];
    for (const p of all) {
      expect(p.command).not.toMatch(/--profile-directory=(?!Default\b)/);
    }
    expect(all.some(p => p.command.includes("--profile-directory=Default"))).toBe(true);
  });

  it("uses -n for macOS profile presets, which profile switching needs", () => {
    // `open -a` hands the URL to an already-running instance, which ignores
    // --profile-directory. Only a new instance honours it.
    for (const p of MAC_BROWSER_PRESETS) {
      if (p.command.includes("--profile-directory") || p.command.includes("--incognito")
          || p.command.includes("--inprivate") || p.command.includes("-private-window")) {
        expect(p.command).toMatch(/open -na /);
        expect(p.command).toContain("--args");
      }
    }
  });

  it("puts every macOS browser flag after --args", () => {
    // `man open`: only what follows --args reaches the browser's own argv.
    // A flag before it would be eaten by `open` and silently do nothing.
    for (const p of MAC_BROWSER_PRESETS) {
      const flagAt = p.command.search(/\s--(?:profile-directory|incognito|inprivate)\b|\s-private-window\b/);
      if (flagAt < 0) continue;
      const argsAt = p.command.indexOf("--args");
      expect(argsAt).toBeGreaterThan(-1);
      expect(flagAt).toBeGreaterThan(argsAt);
    }
  });

  it("gives the profile presets a hint saying where to find the name", () => {
    // Without it the user has to guess the profile directory name, and a
    // wrong guess is a dead link.
    for (const p of [...MAC_BROWSER_PRESETS, ...LINUX_BROWSER_PRESETS]) {
      if (p.command.includes("--profile-directory")) {
        expect(p.hint).toBeTruthy();
        expect(p.hint).toMatch(/version/);
      }
    }
  });

  it("has unique labels so the dropdown keys are stable", () => {
    for (const list of [MAC_BROWSER_PRESETS, LINUX_BROWSER_PRESETS]) {
      expect(new Set(list.map(p => p.label)).size).toBe(list.length);
    }
  });
});
