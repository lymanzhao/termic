// Quick task creation shared by the sidebar `+` menu inline row and the
// Custom command dialog. "Quick" = create straight from a name (and, for
// worktrees, an auto-generated branch) without the full New Task modal.
//
// The mode ("worktree" vs "repo_root" / main checkout) is remembered
// app-wide in one localStorage key — the SAME key the New Task dialog reads
// and writes, so the toggle, the dialog, and "Advanced…" all agree on the
// last choice.

import { taskCreate, taskOpenRepo, taskImportWorktree, settingsLoad } from "@/lib/ipc";
import { projectSandboxDefault, projectYoloDefault, yoloForCreate, mergeLists } from "@/lib/projectSandboxDefault";
import { selectionToFields } from "@/lib/types";
import { isTerminalCli } from "@/lib/agents";
import { useApp } from "@/store/app";
import { launchSetupTab } from "@/lib/runTabs";
import { withCreateLock } from "@/lib/createLock";
import { slugify, branchify } from "@/lib/utils";
import type { SandboxMode, Task } from "@/lib/types";

export type NewTaskMode = "worktree" | "repo_root";

const LS_LAST_MODE = "newTaskLastMode";

/** Read the app-wide remembered new-task mode. Defaults to "repo_root" (the
 *  main checkout) when nothing is stored: most people start in their main
 *  checkout and reach for worktrees later, so that's the gentler default. */
export function readNewTaskMode(): NewTaskMode {
  try {
    const v = localStorage.getItem(LS_LAST_MODE);
    return v === "worktree" ? "worktree" : "repo_root";
  } catch {
    return "repo_root";
  }
}

/** Persist the app-wide new-task mode. Shared with NewTaskDialog. */
export function writeNewTaskMode(mode: NewTaskMode) {
  try { localStorage.setItem(LS_LAST_MODE, mode); } catch {}
}

/** Auto-derive a worktree branch from the task name, matching the New Task
 *  dialog exactly: an already-qualified name (contains "/") is branchified
 *  as-is; otherwise `<branchPrefix>/<slug>` (a blank prefix yields a bare
 *  slug). This is what we seed the editable branch field with.
 *
 *  Empty in, empty OUT, and that includes a name that slugifies away: a
 *  prefix plus an empty slug composed `sim/`, which is not a git ref, and
 *  nothing noticed until `git branch` failed with its own wording several
 *  layers down. The caller refuses an empty branch with the message the CLI
 *  and quick-create already use. */
export function derivedBranch(name: string, branchPrefix: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.includes("/")) return branchify(trimmed);
  const slug = slugify(trimmed);
  if (!slug) return "";
  const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${slug}` : slug;
}

/** Bump an auto-derived branch past names already taken in the repo.
 *  `git branch --no-track` on an existing name either fails or silently
 *  checks out stale commits (issue #129). If the base ends in `-<n>` we
 *  bump that number; otherwise append `-2`, `-3`, ... until free. Shared
 *  by the New Task dialog and the CLI's new_task handler; only
 *  auto-filled defaults are adjusted, never a branch the user typed
 *  (empty `existing` short-circuits). */
export function uniqueBranch(base: string, existing: string[]): string {
  if (!base || existing.length === 0) return base;
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const m = base.match(/^(.*)-(\d+)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** The sandbox argument a quick create should send for `projectId`, or
 *  `undefined` when the project's default is "off" (send nothing, stay
 *  uncaged - the historical behaviour of this path).
 *
 *  The allow-lists are merged HERE, global + project, because
 *  `task_open_repo` does not merge them the way `task_create` does: it takes
 *  what it is given. That is the same merge the New Task dialog performs when
 *  it seeds its own fields, so a quick main-checkout task and a dialog one
 *  end up with the same cage. */
async function quickSandboxArgs(projectId: string) {
  const project = useApp.getState().projects.find(p => p.id === projectId);
  const selection = projectSandboxDefault(project);
  if (selection === "off") return undefined;
  const { mode, docker } = selectionToFields(selection);
  const globals = await settingsLoad().catch(() => null);
  return {
    enabled: !docker,
    mode,
    rwPaths: mergeLists(globals?.sandbox_default_rw_paths, project?.sandbox_rw_paths),
    allowedHosts: mergeLists(globals?.sandbox_default_allowed_hosts, project?.sandbox_allowed_hosts),
    docker,
    // Project list first, global as fallback - the same order task_create
    // resolves them in on the worktree path.
    dockerExtraMounts: docker
      ? (project?.docker_extra_mounts?.length
          ? project.docker_extra_mounts
          : globals?.docker_default_extra_mounts ?? [])
      : undefined,
  };
}

/** The `yolo` a quick create should send for `projectId`: the project's
 *  default, else the app-wide one, through the same `yoloForCreate` gate the
 *  New Task dialog uses (nothing for a caged task or a non-agent).
 *
 *  Quick create has no form to show a checkbox in, so the default is applied
 *  the way `quickSandboxArgs` applies the project's cage, and the red ⚡ on
 *  the new row is where it shows. Leaving it out would make the + menu the
 *  one human create path that ignores the setting, which is the per-task
 *  toggling the default exists to remove. */
async function quickYolo(projectId: string, cli: string): Promise<boolean | undefined> {
  // Dynamic, like autoStart.ts's: prefs.ts touches the DOM at import time,
  // and this module is imported by node-environment unit tests.
  const { usePrefs } = await import("@/store/prefs");
  const project = useApp.getState().projects.find(p => p.id === projectId);
  const on = yoloForCreate(
    projectYoloDefault(project, usePrefs.getState().defaultYolo),
    projectSandboxDefault(project),
    !isTerminalCli(cli),
  );
  return on || undefined;
}

/** Map a sandbox mode string ("off" | "monitor" | "enforce" |
 *  "enforce-fs") onto task-create pins. Anything else (absent flag,
 *  unknown string) returns undefined: leave the pins unset so Rust
 *  applies the project seeds, exactly like the GUI's quick path.
 *  Shared by the CLI's new_task handler. */
export function sandboxPins(
  sandbox: unknown,
): { sandbox_enabled: boolean; sandbox_mode: SandboxMode } | undefined {
  if (sandbox === "off") return { sandbox_enabled: false, sandbox_mode: "off" };
  if (sandbox === "monitor" || sandbox === "enforce" || sandbox === "enforce-fs") {
    return { sandbox_enabled: true, sandbox_mode: sandbox };
  }
  return undefined;
}

/** Create a task in the given mode and focus it. Worktree tasks also fire
 *  their setup script as an unfocused background tab (same as the dialog).
 *  `command` is only meaningful for `cli === "custom"`. `branch` (worktree
 *  only) falls back to the Rust-side slug when blank. `id`, when given, is
 *  used as the task's id instead of generating one here — lets a caller
 *  pre-generate it to subscribe to `setup-output://<id>` (worktree creation
 *  progress) BEFORE this resolves, same reason NewTaskDialog does it. */
export async function createQuickTask(opts: {
  projectId: string;
  mode: NewTaskMode;
  cli: string;
  name: string;
  branch?: string;
  command?: string;
  id?: string;
}): Promise<Task> {
  const { projectId, mode, cli, name } = opts;
  const trimmedName = name.trim();
  const command = opts.command?.trim() || undefined;

  // A worktree name that slugs to "" (all punctuation) is invalid: the branch
  // and the worktree dir derive from the slug, and an empty dir name is a
  // data-loss footgun on the Rust side. Reject early with a clear message.
  // (Main checkout uses the live repo dir, not a slug, so it's exempt.)
  if (mode === "worktree" && slugify(trimmedName) === "") {
    throw new Error("Task name must contain at least one letter or number.");
  }

  // Creates serialize behind the app-wide lock (createLock.ts): git
  // worktree add contends on the repo index, and task_create's orphan
  // cleanup makes interleaved same-name creates destructive.
  let task: Task;
  if (mode === "repo_root") {
    // Main checkout: no worktree, open the agent/shell/custom in the repo's
    // live checkout (same IPC the "Run in repo" rows have always used).
    //
    // The project's default cage is applied HERE rather than in Rust:
    // `task_open_repo` deliberately never falls back to it, so that legacy
    // callers and the CLI, which pass nothing, are not surprised by a cage.
    // Passing it explicitly gives the quick path the same behaviour as the
    // New Task dialog (which has always sent its picker's value) without
    // changing that contract for anyone else. A project defaulting to "off"
    // still sends nothing, so the uncaged path is untouched.
    task = await withCreateLock(async () =>
      taskOpenRepo(
        projectId, cli, trimmedName, await quickSandboxArgs(projectId), command,
        undefined, undefined, undefined, await quickYolo(projectId, cli),
      ),
    );
  } else {
    const yolo = await quickYolo(projectId, cli);
    task = await withCreateLock(() =>
      taskCreate({
        id: opts.id ?? crypto.randomUUID(),
        project_id: projectId,
        name: trimmedName,
        cli,
        base_branch: null,
        branch: opts.branch?.trim() || undefined,
        // Sandbox pins are left unset so Rust falls back to the project's
        // defaults (quick create doesn't expose the sandbox panel — that's
        // what "Advanced…" is for).
        custom_command: cli === "custom" ? (command ?? null) : undefined,
        yolo,
      }),
    );
  }

  await useApp.getState().loadAll();
  useApp.getState().setActiveTask(task.id);
  // Worktrees run their setup script in the background (unfocused) so the
  // main agent keeps focus. Main-checkout tasks have no per-task setup.
  if (mode === "worktree") launchSetupTab(task.id, { focus: false }).catch(() => {});
  return task;
}

/** Adopt an existing git worktree as a task and focus it, straight from the
 *  launcher menu (issue #92). Name and CLI are left unset so Rust derives
 *  them (branch name / dir basename, and the project's default CLI). No setup
 *  script: the worktree already exists and is presumed set up. */
export async function importQuickWorktree(projectId: string, path: string): Promise<Task> {
  // Rust derives the CLI as the project's default, so that is the agent the
  // YOLO default is judged against.
  const project = useApp.getState().projects.find(p => p.id === projectId);
  const yolo = await quickYolo(projectId, project?.default_cli ?? "shell");
  // Import runs git worktree list/prune and the port math; serialize it
  // with every other create (createLock.ts).
  const task = await withCreateLock(() => taskImportWorktree(
    projectId, path, undefined, undefined, undefined, undefined, undefined, yolo,
  ));
  await useApp.getState().loadAll();
  useApp.getState().setActiveTask(task.id);
  return task;
}
