import { describe, it, expect } from "vitest";
import { normalizePath, matchesSuffix, resolvePathClick, expandTilde, tildePath, resolveAbsoluteClick } from "./pathMatch";

describe("normalizePath", () => {
  it("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });
  it("strips all leading ./ and / segments", () => {
    expect(normalizePath(".//src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("././src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("/./src/a.ts")).toBe("src/a.ts");
  });
  it("strips a leading absolute slash", () => {
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
  });
  it("leaves ../ alone (parent traversal is meaningful)", () => {
    expect(normalizePath("../src/a.ts")).toBe("../src/a.ts");
  });
  it("leaves an already-bare path untouched", () => {
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("matchesSuffix", () => {
  it("matches an identical path", () => {
    expect(matchesSuffix("src/file.ts", "src/file.ts")).toBe(true);
  });
  it("matches a segment-boundary suffix", () => {
    expect(matchesSuffix("foo/src/file.ts", "src/file.ts")).toBe(true);
  });
  it("matches a bare filename against a deeper path", () => {
    expect(matchesSuffix("foo/src/file.ts", "file.ts")).toBe(true);
  });
  it("rejects a different leading segment", () => {
    expect(matchesSuffix("abc/file.ts", "src/file.ts")).toBe(false);
  });
  it("rejects a raw (non-segment-boundary) suffix", () => {
    expect(matchesSuffix("foo/barfile.ts", "file.ts")).toBe(false);
  });
  it("normalizes both sides before comparing", () => {
    expect(matchesSuffix("/foo/src/file.ts", "./src/file.ts")).toBe(true);
  });
  it("does not match when the candidate is shorter than the query", () => {
    expect(matchesSuffix("file.ts", "src/file.ts")).toBe(false);
  });
});

describe("resolvePathClick", () => {
  const files = ["src/app/dup.ts", "src/lib/dup.ts", "src/main.ts", "README.md"];

  it("returns a single match (handler opens it directly)", () => {
    expect(resolvePathClick(files, "main.ts")).toEqual(["src/main.ts"]);
  });
  it("returns every duplicate-basename match (handler shows the picker)", () => {
    expect(resolvePathClick(files, "dup.ts")).toEqual(["src/app/dup.ts", "src/lib/dup.ts"]);
  });
  it("disambiguates a duplicate down to one when the click is dir-qualified", () => {
    expect(resolvePathClick(files, "app/dup.ts")).toEqual(["src/app/dup.ts"]);
  });
  it("returns nothing for an unknown path (handler shows the no-matches row)", () => {
    expect(resolvePathClick(files, "nope.ts")).toEqual([]);
  });
});

describe("expandTilde", () => {
  it("expands a leading ~/", () => {
    expect(expandTilde("~/notes/todo.md", "/Users/me")).toBe("/Users/me/notes/todo.md");
  });
  it("expands a bare ~", () => {
    expect(expandTilde("~", "/Users/me")).toBe("/Users/me");
  });
  it("leaves a non-tilde path alone", () => {
    expect(expandTilde("/etc/hosts", "/Users/me")).toBe("/etc/hosts");
    expect(expandTilde("src/a.ts", "/Users/me")).toBe("src/a.ts");
  });
  it("does not expand ~user (not ours to resolve)", () => {
    expect(expandTilde("~other/a.ts", "/Users/me")).toBe("~other/a.ts");
  });
  it("returns the input unchanged when home is unknown", () => {
    // Must not build "/notes/todo.md" out of an empty home — that would be a
    // real path pointing somewhere the user never named.
    expect(expandTilde("~/notes/todo.md", "")).toBe("~/notes/todo.md");
  });
});

describe("resolveAbsoluteClick", () => {
  const task = { path: "/w/task", prefix: "" };

  it("maps a path under the task root to a task-relative one", () => {
    expect(resolveAbsoluteClick("/w/task/src/a.ts", [task]))
      .toEqual({ kind: "inside", rel: "src/a.ts" });
  });
  it("reports a path outside every root as outside", () => {
    expect(resolveAbsoluteClick("/other/repo/src/a.ts", [task]))
      .toEqual({ kind: "outside", abs: "/other/repo/src/a.ts" });
  });
  it("never falls back to suffix matching (GH #240 wrong-file fix)", () => {
    // The task HAS a src/a.ts; an absolute path naming a different one must
    // still resolve outside rather than opening the task's copy.
    expect(resolveAbsoluteClick("/somewhere/else/src/a.ts", [task]).kind).toBe("outside");
  });
  it("respects segment boundaries", () => {
    // "/w/task-old" must not resolve against a root of "/w/task".
    expect(resolveAbsoluteClick("/w/task-old/src/a.ts", [task]).kind).toBe("outside");
  });
  it("prefixes a composition member with its dir_name", () => {
    const roots = [task, { path: "/elsewhere/api", prefix: "api" }];
    expect(resolveAbsoluteClick("/elsewhere/api/src/a.ts", roots))
      .toEqual({ kind: "inside", rel: "api/src/a.ts" });
  });
  it("prefers a member nested under the task root over the root itself", () => {
    // Longest root wins, or the member's files resolve to the wrapper and get
    // read out of the wrong repo.
    const roots = [task, { path: "/w/task/api", prefix: "api" }];
    expect(resolveAbsoluteClick("/w/task/api/src/a.ts", roots))
      .toEqual({ kind: "inside", rel: "api/src/a.ts" });
  });
  it("treats the task root itself as outside (nothing to open)", () => {
    expect(resolveAbsoluteClick("/w/task", [task]))
      .toEqual({ kind: "outside", abs: "/w/task" });
  });
  it("tolerates a trailing slash on a root", () => {
    expect(resolveAbsoluteClick("/w/task/src/a.ts", [{ path: "/w/task/", prefix: "" }]))
      .toEqual({ kind: "inside", rel: "src/a.ts" });
  });
  it("ignores empty roots", () => {
    expect(resolveAbsoluteClick("/w/task/src/a.ts", [{ path: "", prefix: "" }, task]))
      .toEqual({ kind: "inside", rel: "src/a.ts" });
  });
});

describe("tildePath", () => {
  it("shortens a path under home and leaves the rest alone", () => {
    expect(tildePath("/Users/u/.codex/hooks.json", "/Users/u")).toBe("~/.codex/hooks.json");
    expect(tildePath("/Users/u", "/Users/u")).toBe("~");
    expect(tildePath("/etc/hosts", "/Users/u")).toBe("/etc/hosts");
  });

  it("does not shorten a sibling that merely starts with the same letters", () => {
    // `/Users/under` is not inside `/Users/u`, and a prefix test without the
    // separator would turn it into `~nder`.
    expect(tildePath("/Users/under/x", "/Users/u")).toBe("/Users/under/x");
  });

  it("returns the path unchanged when home is unknown", () => {
    expect(tildePath("/Users/u/x", "")).toBe("/Users/u/x");
  });
});
