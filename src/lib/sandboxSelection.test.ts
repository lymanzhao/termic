import { afterEach, describe, it, expect } from "vitest";
import { selectionFor, selectionToFields, isTaskCaged, effectiveSandboxMode, type SandboxMode } from "@/lib/types";
import { setSeatbeltAvailableForTests } from "@/lib/platform";

describe("selectionFor", () => {
  it("reports docker regardless of the underlying mode when docker is enabled", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionFor(m, true)).toBe("docker");
    }
  });

  it("passes the seatbelt mode through unchanged when docker is disabled", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionFor(m, false)).toBe(m);
    }
  });
});

describe("selectionToFields", () => {
  it("maps docker to mode off + docker true", () => {
    expect(selectionToFields("docker")).toEqual({ mode: "off", docker: true });
  });

  it("maps every seatbelt selection to itself + docker false", () => {
    const modes: SandboxMode[] = ["off", "monitor", "enforce-fs", "enforce"];
    for (const m of modes) {
      expect(selectionToFields(m)).toEqual({ mode: m, docker: false });
    }
  });

  it("round-trips through selectionFor for every selection", () => {
    const selections = ["off", "monitor", "enforce-fs", "enforce", "docker"] as const;
    for (const sel of selections) {
      const { mode, docker } = selectionToFields(sel);
      expect(selectionFor(mode, docker)).toBe(sel);
    }
  });
});

describe("isTaskCaged", () => {
  it("is false for null/undefined and an uncaged task", () => {
    expect(isTaskCaged(null)).toBe(false);
    expect(isTaskCaged(undefined)).toBe(false);
    expect(isTaskCaged({ sandbox_mode: "off" })).toBe(false);
    expect(isTaskCaged({ sandbox_mode: "monitor" })).toBe(false);
  });

  it("is true for Seatbelt enforce and enforce-fs", () => {
    expect(isTaskCaged({ sandbox_mode: "enforce" })).toBe(true);
    expect(isTaskCaged({ sandbox_mode: "enforce-fs" })).toBe(true);
  });

  it("is true for Docker mode even though sandbox_mode is off", () => {
    // Docker mode always stores sandbox_mode as off (mutually exclusive
    // with Seatbelt) - this is the exact case isTaskCaged exists for: a
    // Docker-sandboxed task used to read as uncaged everywhere that only
    // checked isSandboxEnforced(effectiveSandboxMode(task)), including the
    // --dangerously-skip-permissions auto-on logic.
    expect(isTaskCaged({ sandbox_mode: "off", docker_sandbox_enabled: true })).toBe(true);
  });

  it("is true for Docker mode combined with any Seatbelt mode field (belt and suspenders)", () => {
    expect(isTaskCaged({ sandbox_mode: "monitor", docker_sandbox_enabled: true })).toBe(true);
  });
});

describe("off macOS (no Seatbelt)", () => {
  afterEach(() => setSeatbeltAvailableForTests(true));

  it("reads every stored Seatbelt mode as off, so nothing auto-enables YOLO", () => {
    setSeatbeltAvailableForTests(false);
    for (const m of ["monitor", "enforce", "enforce-fs"] as SandboxMode[]) {
      expect(effectiveSandboxMode({ sandbox_mode: m })).toBe("off");
      expect(isTaskCaged({ sandbox_mode: m })).toBe(false);
    }
    expect(isTaskCaged({ sandbox_enabled: true })).toBe(false);
  });

  it("still treats a Docker task as caged", () => {
    setSeatbeltAvailableForTests(false);
    expect(isTaskCaged({ sandbox_mode: "off", docker_sandbox_enabled: true })).toBe(true);
  });
});
