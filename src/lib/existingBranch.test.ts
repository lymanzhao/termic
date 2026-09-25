import { describe, it, expect } from "vitest";
import {
  BRANCH_CHOICES_MAX, branchChoices, checkoutTaskName, isKnownBranch, remoteNames,
} from "./existingBranch";
import type { BranchContext } from "./types";

const ctx = (over: Partial<BranchContext> = {}): BranchContext => ({
  head: "main",
  local: ["main", "alice/fix"],
  remote: ["origin/main", "origin/alice/fix", "origin/bob/feat", "upstream/release"],
  ...over,
});

describe("remoteNames", () => {
  it("lists each remote once, in the order its refs appear", () => {
    expect(remoteNames(ctx())).toEqual(["origin", "upstream"]);
    expect(remoteNames(ctx({ remote: [] }))).toEqual([]);
  });
});

describe("branchChoices", () => {
  it("lists local branches first, then remote ones not already local", () => {
    const { choices, truncated } = branchChoices(ctx(), "");
    expect(choices).toEqual([
      { ref: "main", source: "local" },
      { ref: "alice/fix", source: "local" },
      { ref: "origin/bob/feat", source: "origin" },
      { ref: "upstream/release", source: "upstream" },
    ]);
    expect(truncated).toBe(false);
  });

  it("filters by a case-insensitive substring of the ref", () => {
    const refs = branchChoices(ctx(), "  FE ").choices.map(c => c.ref);
    expect(refs).toEqual(["origin/bob/feat"]);
    expect(branchChoices(ctx(), "origin/").choices.map(c => c.ref)).toEqual(["origin/bob/feat"]);
    expect(branchChoices(ctx(), "nothing-like-it").choices).toEqual([]);
  });

  it("caps the rows and says it did", () => {
    const remote = Array.from({ length: BRANCH_CHOICES_MAX + 5 }, (_, i) => `origin/b${i}`);
    const { choices, truncated } = branchChoices(ctx({ local: [], remote }), "");
    expect(choices).toHaveLength(BRANCH_CHOICES_MAX);
    expect(truncated).toBe(true);
    // Narrowing below the cap clears the flag.
    expect(branchChoices(ctx({ local: [], remote }), "b10").truncated).toBe(false);
  });
});

describe("isKnownBranch", () => {
  it("knows a local branch, a remote ref, and a bare name under a remote", () => {
    expect(isKnownBranch(ctx(), "alice/fix")).toBe(true);
    expect(isKnownBranch(ctx(), "origin/bob/feat")).toBe(true);
    expect(isKnownBranch(ctx(), "bob/feat")).toBe(true);
    expect(isKnownBranch(ctx(), "release")).toBe(true);
  });

  it("does not know a branch this repo has never fetched, or nothing at all", () => {
    expect(isKnownBranch(ctx(), "carol/new-work")).toBe(false);
    expect(isKnownBranch(ctx(), "   ")).toBe(false);
  });
});

describe("checkoutTaskName", () => {
  it("drops a known remote so both spellings name the same task", () => {
    expect(checkoutTaskName("origin/alice/fix", ["origin"])).toBe("alice/fix");
    expect(checkoutTaskName(" alice/fix ", ["origin"])).toBe("alice/fix");
  });

  it("keeps a first segment that is not a remote, and a bare remote name", () => {
    expect(checkoutTaskName("feature/x", ["origin"])).toBe("feature/x");
    expect(checkoutTaskName("origin/", ["origin"])).toBe("origin/");
  });
});
