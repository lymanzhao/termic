import { describe, expect, it } from "vitest";
import {
  MEMORY_NOTE, MEMORY_SHORT, SERVABLE_LANGUAGES, SERVABLE_LANGUAGE_IDS,
  WOULD_INSTALL_IDS, serverFor,
} from "./serverNames";

// What a server is CALLED, and what it costs. Both are shown at the moment
// somebody decides whether to start a process, so a gap here is a gap in the
// consent rather than a cosmetic one.

describe("a language with nothing resolved yet", () => {
  it("still names a server, and one the cost notes know", () => {
    // The chip and the consent prompt look the memory note up BY SERVER NAME,
    // so a language that falls back to its own id ("cpp") finds nothing and
    // discloses an empty string.
    for (const language of ["typescript", "python", "rust", "go", "cpp", "swift", "ruby", "terraform"]) {
      const name = serverFor(null, language);
      expect(name, language).not.toBe(language);
      expect(MEMORY_NOTE[name], language).toBeTruthy();
      expect(MEMORY_SHORT[name], language).toBeTruthy();
    }
  });

  it("prefers the resolved binary over the guess", () => {
    // Python resolves to one of three, which is why the guess is only ever a
    // fallback: naming the wrong one also quotes the wrong memory figure.
    expect(serverFor("/x/.venv/bin/zuban", "python")).toBe("zuban");
    expect(serverFor("/x/.venv/bin/ty", "python")).toBe("ty");
    // A Debian clangd is spawned as clangd-18; the reader calls it clangd.
    expect(serverFor("/usr/bin/clangd-18", "cpp")).toBe("clangd");
    expect(serverFor("/usr/bin/sourcekit-lsp", "swift")).toBe("sourcekit-lsp");
    expect(serverFor("/repo/bin/ruby-lsp", "ruby")).toBe("ruby-lsp");
  });

  it("names a Windows server by its program, not its path or extension", () => {
    expect(serverFor("C:\\repo\\node_modules\\.bin\\tsgo.cmd", "typescript")).toBe("TypeScript 7 (tsgo)");
    expect(serverFor("C:\\repo\\.venv\\Scripts\\ty.exe", "python")).toBe("ty");
    expect(MEMORY_NOTE[serverFor("C:\\r\\tsgo.exe", "typescript")]).toBeTruthy();
  });

  it("says the binary's name rather than inventing one for a server we do not know", () => {
    expect(serverFor("/usr/local/bin/some-other-lsp", "elixir")).toBe("some-other-lsp");
  });

  it("keeps the short and long cost notes on the same keys", () => {
    // Two tables quoting different numbers for one server is the failure this
    // prevents: the row says 85 MB and the prompt says 250.
    expect(Object.keys(MEMORY_SHORT).sort()).toEqual(Object.keys(MEMORY_NOTE).sort());
  });
});

describe("the servable language list", () => {
  it("names every language termic can serve, and nothing else", () => {
    // The bug this replaces: the per-project checkboxes listed four of the
    // seven, so materialising that list (which the first untick does) dropped
    // the other three from auto start without ever showing them.
    expect([...SERVABLE_LANGUAGE_IDS].sort()).toEqual([...WOULD_INSTALL_IDS].sort());
  });

  it("gives each one a label a person would recognise", () => {
    for (const { id, label } of SERVABLE_LANGUAGES) {
      expect(label.trim(), id).not.toBe("");
      expect(label, id).not.toBe(id);
    }
  });
});
