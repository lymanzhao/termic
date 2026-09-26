import { afterEach, describe, it, expect } from "vitest";
import { setSeatbeltAvailableForTests } from "@/lib/platform";
import { projectSandboxDefault, projectYoloDefault, yoloForCreate, mergeLists } from "./projectSandboxDefault";
import type { Project } from "@/lib/types";

const proj = (over: Partial<Project> = {}) => ({ id: "p", name: "p", ...over }) as Project;

describe("projectSandboxDefault", () => {
  it("is off for a project that has never been configured", () => {
    expect(projectSandboxDefault(proj())).toBe("off");
    expect(projectSandboxDefault(undefined)).toBe("off");
    expect(projectSandboxDefault(null)).toBe("off");
  });

  it("reads the precise mode when there is one", () => {
    expect(projectSandboxDefault(proj({ default_sandbox_mode: "monitor" }))).toBe("monitor");
    expect(projectSandboxDefault(proj({ default_sandbox_mode: "enforce-fs" }))).toBe("enforce-fs");
  });

  it("treats the legacy boolean as Enforce, which is what it always meant", () => {
    expect(projectSandboxDefault(proj({ default_sandbox: true }))).toBe("enforce");
  });

  it("prefers the precise mode over the boolean", () => {
    expect(projectSandboxDefault(proj({ default_sandbox: true, default_sandbox_mode: "monitor" })))
      .toBe("monitor");
  });

  it("lets Docker win, since the two engines are exclusive in effect", () => {
    // Both can be set on the record at once; a reader that answered "enforce"
    // here would disagree with the task that actually gets created.
    expect(projectSandboxDefault(proj({ default_docker: true }))).toBe("docker");
    expect(projectSandboxDefault(proj({ default_docker: true, default_sandbox: true }))).toBe("docker");
    expect(projectSandboxDefault(proj({ default_docker: true, default_sandbox_mode: "enforce" })))
      .toBe("docker");
  });
});

describe("projectYoloDefault", () => {
  it("follows the app-wide default when the project has no opinion", () => {
    // `null` is what Rust's `None` serializes to; undefined is a record from
    // before the field existed. Both inherit.
    for (const p of [proj(), proj({ default_yolo: null }), undefined, null]) {
      expect(projectYoloDefault(p, false)).toBe(false);
      expect(projectYoloDefault(p, true)).toBe(true);
    }
  });

  it("lets the project's own answer win in both directions", () => {
    expect(projectYoloDefault(proj({ default_yolo: true }), false)).toBe(true);
    // The case the override exists for: YOLO everywhere except this repo.
    expect(projectYoloDefault(proj({ default_yolo: false }), true)).toBe(false);
  });
});

describe("yoloForCreate", () => {
  it("sends the choice for an agent in an uncaged task", () => {
    expect(yoloForCreate(true, "off", true)).toBe(true);
    expect(yoloForCreate(false, "off", true)).toBe(false);
  });

  it("treats Monitoring as uncaged, since it blocks nothing", () => {
    expect(yoloForCreate(true, "monitor", true)).toBe(true);
  });

  it("stores nothing for a caged task, where spawn turns YOLO on anyway", () => {
    for (const sel of ["enforce", "enforce-fs", "docker"] as const) {
      expect(yoloForCreate(true, sel, true)).toBe(false);
    }
  });

  it("stores nothing when the default tab is not an agent", () => {
    expect(yoloForCreate(true, "off", false)).toBe(false);
  });
});

describe("mergeLists", () => {
  it("unions in order, first occurrence winning", () => {
    expect(mergeLists(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("drops blanks and handles absent sides", () => {
    expect(mergeLists(undefined, ["a", "", "a"])).toEqual(["a"]);
    expect(mergeLists()).toEqual([]);
  });
});

describe("projectSandboxDefault off macOS", () => {
  afterEach(() => setSeatbeltAvailableForTests(true));

  it("drops a Seatbelt default (say, a Mac teammate's) to off but keeps Docker", () => {
    setSeatbeltAvailableForTests(false);
    expect(projectSandboxDefault({ default_sandbox_mode: "enforce" } as Project)).toBe("off");
    expect(projectSandboxDefault({ default_sandbox: true } as Project)).toBe("off");
    expect(projectSandboxDefault({ default_docker: true } as Project)).toBe("docker");
  });
});
