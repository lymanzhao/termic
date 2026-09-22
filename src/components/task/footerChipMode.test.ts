import { describe, it, expect } from "vitest";
import { footerChipMode, moreMarkerClass } from "@/components/task/footerChipMode";

// The task footer holds one chip per agent, and a task runs as many agents as
// it has tabs. Reported with five in one task, where the old rule (hide a
// secondary chip below 780px, a width measured for TWO agents) never fired and
// the chips ran off the end of the bar and under the right panel.
//
// Two invariants, and they are the whole contract: the agent whose tab is on
// screen is NEVER hidden, and the bar sheds from the tail, so a chip that
// survives at one width still survives at every wider one.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `agent${i}`);

// NOTE: nothing in this file may spell out a container-query class, not even
// inside a comment or a regex. Tailwind v4 scans test files too, and a
// class-shaped string with a placeholder where the number goes is compiled
// into a real rule: it broke the production build with "Invalid media query"
// while `npm test` and `tsc` both stayed green. See docs/gotchas.md.

/** The pixel threshold encoded in a hide class, or NaN if there is none. */
const px = (cls: string | undefined | null) => Number(/\[(\d+)px\]/.exec(cls ?? "")?.[1] ?? NaN);

describe("footerChipMode", () => {
  it("never hides a single-agent task's chip", () => {
    expect(footerChipMode(["claude"], "claude", "claude")).toEqual({ secondary: false, hideClass: undefined });
  });

  it("never hides the agent whose tab is on screen, however many there are", () => {
    for (const n of [2, 3, 5, 12]) {
      const all = ids(n);
      const active = all[Math.min(2, n - 1)]!;
      expect(footerChipMode(all, active, active)).toEqual({ secondary: false, hideClass: undefined });
    }
  });

  it("gives every other agent a hide breakpoint", () => {
    const all = ids(4);
    for (const id of all.filter(x => x !== all[0])) {
      const { secondary, hideClass } = footerChipMode(all, all[0], id);
      expect(secondary).toBe(true);
      expect(px(hideClass)).toBeGreaterThan(0);
      expect(hideClass?.endsWith(":hidden")).toBe(true);
    }
  });

  it("sheds from the tail: each further chip needs a wider bar than the one before", () => {
    const all = ids(6);
    const widths = all.filter(id => id !== all[0]).map(id => px(footerChipMode(all, all[0], id).hideClass));
    expect(widths.every(w => Number.isFinite(w))).toBe(true);
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });

  it("clamps rather than running off the end of the breakpoint table", () => {
    const all = ids(40);
    const widths = all.filter(id => id !== all[0]).map(id => px(footerChipMode(all, all[0], id).hideClass));
    expect(widths.every(w => Number.isFinite(w))).toBe(true);
    // Non-decreasing to the end: the tail shares the last breakpoint and drops
    // together, which beats inventing widths no window will ever reach.
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]!);
  });

  it("shows a chip whose agent is not in the list rather than guessing", () => {
    // Possible for a render between a tab closing and the list settling. A
    // stale chip for one frame beats a flicker in the ones beside it.
    const all = ids(3);
    expect(footerChipMode(all, all[0], "ghost")).toEqual({ secondary: true, hideClass: undefined });
  });
});

describe("moreMarkerClass", () => {
  it("is absent when nothing can ever be hidden", () => {
    expect(moreMarkerClass(["claude"], "claude")).toBeNull();
    expect(moreMarkerClass([], undefined)).toBeNull();
  });

  it("appears exactly where the last chip stops fitting", () => {
    // Its @min must match the last chip's @max. Off by one either way and the
    // bar either claims hidden agents while showing them all, or hides one
    // silently, which is the thing this marker exists to prevent.
    for (const n of [2, 3, 6]) {
      const all = ids(n);
      const others = all.filter(id => id !== all[0]);
      const last = px(footerChipMode(all, all[0], others[others.length - 1]!).hideClass);
      expect(px(moreMarkerClass(all, all[0]))).toBe(last);
    }
  });

  it("needs a wider bar to disappear as the task gains agents", () => {
    const widths = [2, 3, 4, 5].map(n => px(moreMarkerClass(ids(n), "agent0")));
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
  });
});
