import { describe, expect, it } from "vitest";
import { spawnLinkPairs, spawnMarkParent } from "./spawnLinks";
import type { Task, TaskGroup } from "./types";

const t = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, name: id, project_id: "p", archived: false, ...extra }) as Task;
const G = (id: string): TaskGroup => ({ id });

describe("spawnMarkParent", () => {
  it("marks a child in another project, not one inside its parent's group", () => {
    const orch = t("orch", { group: G("orch") });
    const near = t("near", { group: G("orch"), spawned_by: "orch" });
    const far = t("far", { project_id: "q", spawned_by: "orch" });
    const tasks = [orch, near, far];
    expect(spawnMarkParent(near, tasks)).toBeNull();
    expect(spawnMarkParent(far, tasks)?.id).toBe("orch");
  });

  it("marks a same-project child the user dragged out of the group", () => {
    const orch = t("orch", { group: G("orch") });
    const out = t("out", { spawned_by: "orch" });
    expect(spawnMarkParent(out, [orch, out])?.id).toBe("orch");
  });

  it("marks a legacy cross-project group member drawn as a plain row", () => {
    const orch = t("orch", { group: G("orch") });
    const far = t("far", { project_id: "q", group: G("orch"), spawned_by: "orch" });
    expect(spawnMarkParent(far, [orch, far])?.id).toBe("orch");
  });

  it("draws nothing for an unlinked task or an archived parent", () => {
    const orch = t("orch", { archived: true });
    const far = t("far", { project_id: "q", spawned_by: "orch" });
    expect(spawnMarkParent(t("x"), [t("x")])).toBeNull();
    expect(spawnMarkParent(far, [orch, far])).toBeNull();
  });
});

describe("spawnLinkPairs", () => {
  const tasks = [
    t("root"),
    t("orch", { spawned_by: "root" }),
    t("w1", { spawned_by: "orch" }),
    t("w2", { project_id: "q", spawned_by: "orch" }),
    t("gone", { spawned_by: "orch", archived: true }),
    t("leaf", { spawned_by: "w1" }),
  ];

  it("links one level up and one level down, never the whole tree", () => {
    expect(spawnLinkPairs("orch", tasks)).toEqual([["root", "orch"], ["orch", "w1"], ["orch", "w2"]]);
  });

  it("is empty for an unlinked or unknown task", () => {
    expect(spawnLinkPairs("nope", tasks)).toEqual([]);
    expect(spawnLinkPairs("x", [t("x")])).toEqual([]);
  });

  it("draws no line inside one group block, where the rail says it", () => {
    const G = { id: "o" };
    const tasks = [
      t("o", { group: G }),
      t("in", { group: G, spawned_by: "o" }),
      t("out", { spawned_by: "o" }), // dragged out of the group
      t("far", { project_id: "q", group: G, spawned_by: "o" }), // legacy span
    ];
    expect(spawnLinkPairs("o", tasks)).toEqual([["o", "out"], ["o", "far"]]);
    expect(spawnLinkPairs("in", tasks)).toEqual([]);
  });

  it("skips a parent that is archived", () => {
    expect(spawnLinkPairs("c", [t("p", { archived: true }), t("c", { spawned_by: "p" })])).toEqual([]);
  });
});
