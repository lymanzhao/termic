// What "open" means to a language server, in an app where one checkout can be
// on screen several times at once (GH #174).
//
// `DefaultWorkspace` THROWS on a second view of the same file ("doesn't
// support multiple views on the same file"), and termic reaches that state
// without trying: several tasks can share the main checkout, and each renders
// its own editor. One server serves them all, so the workspace has to hold a
// list of views per file and only tell the server about the first open and the
// last close.
//
// It also owns the landing half of go-to-definition. The client asks the
// workspace to put a file in front of the user, and termic already has the
// mechanism: `openPreviewTab` with a `revealAt` opens, jumps, centers and
// focuses (Find-in-Files drives the same call).

import { Text } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { Workspace, type WorkspaceFile, LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import type { LSPClient as Client } from "@codemirror/lsp-client";
import { taskFileRead, fileReadExternal } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { applyDiagnostics } from "./diagnosticsSink";
import { attribution, severityOf } from "./diagnosticMap";
import { useCodeIntel, checkoutRoot, grantKey } from "@/store/codeIntel";
import { pathToFileUri, fileUriToPath, relUnder, baseName } from "@/lib/osPath";

/** Encode an absolute path as a `file://` URI, matching the Rust side. */
export function pathToUri(abs: string): string {
  return pathToFileUri(abs);
}

/**
 * Read any file on disk, contained where it can be.
 *
 * A path inside a task goes through the CONTAINED read; anything else (a
 * package in site-packages, the module cache) goes through the one uncontained
 * read the app has, which exists for exactly this (GH #240). Returns null for
 * anything unreadable rather than throwing: every caller here is improving on
 * an answer it already has.
 */
export async function readAnyFile(abs: string): Promise<string | null> {
  const app = useApp.getState();
  const task = app.tasks.find(t => relUnder(abs, t.path) !== null);
  try {
    return task
      ? await taskFileRead(task.id, relUnder(abs, task.path)!)
      : await fileReadExternal(abs);
  } catch {
    return null;
  }
}

/** Decode a `file://` URI back into a filesystem path. */
export function uriToPath(uri: string): string | null {
  return fileUriToPath(uri);
}

class MultiViewFile implements WorkspaceFile {
  version = 0;
  doc: Text;
  /** Every editor showing this file. The first is authoritative for syncing:
   *  two tasks on one checkout are two buffers over the same path, and they
   *  can genuinely diverge (each has its own unsaved edits). Picking one and
   *  saying so beats interleaving both into the server's model. */
  views: EditorView[] = [];

  constructor(readonly uri: string, readonly languageId: string, view: EditorView) {
    this.doc = view.state.doc;
    this.views.push(view);
  }

  getView(main?: EditorView): EditorView | null {
    if (main && this.views.includes(main)) return main;
    return this.views[0] ?? null;
  }
}

export class TermicWorkspace extends Workspace {
  files: MultiViewFile[] = [];
  private fileVersions: Record<string, number> = Object.create(null);
  /** The last diagnostics the server pushed per file. A server publishes when
   *  a file is OPENED, and the second task to open an already-open file
   *  produces no `didOpen` — so without a replay its editor would sit clean
   *  while the one next to it shows errors, until something else happened to
   *  make the server speak. */
  private lastDiagnostics = new Map<string, any>();

  constructor(client: LSPClient, readonly root: string, readonly server: string) {
    super(client);
  }

  /** Files read from disk to answer a question about them, keyed by uri.
   *  Never edited, never synced: they exist so a usage in a file nobody has
   *  opened can still be listed with its line of code. */
  private loaded = new Map<string, WorkspaceFile>();

  /**
   * Give the client a file it asked about, opening it from DISK when nothing
   * has it on screen.
   *
   * The default implementation returns only files that already have an editor,
   * and `findReferences` DROPS every location it cannot resolve — so usages in
   * files you have not opened simply do not appear, which is most of them the
   * first time you look at a symbol. For reading unfamiliar code that is the
   * difference between an answer and a misleading half-answer.
   */
  async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    const cached = this.loaded.get(uri);
    if (cached) return cached;

    const abs = uriToPath(uri);
    if (!abs) return null;
    const text = await readAnyFile(abs);
    if (text == null) return null;   // unreadable, binary, or past the size cap
    const file: WorkspaceFile = {
      uri,
      languageId: "plaintext",
      version: 0,
      doc: Text.of(text.split("\n")),
      getView: () => null,
    };
    this.loaded.set(uri, file);
    return file;
  }

  /** Keep the last push, so a view that attaches later can be caught up. */
  rememberDiagnostics(params: { uri: string }) {
    this.lastDiagnostics.set(params.uri, params);
  }

  private nextVersion(uri: string) {
    return (this.fileVersions[uri] = (this.fileVersions[uri] ?? -1) + 1);
  }

  syncFiles() {
    const out = [];
    for (const file of this.files) {
      const view = file.views[0];
      if (!view) continue;
      const plugin = LSPPlugin.get(view);
      if (!plugin) continue;
      const changes = plugin.unsyncedChanges;
      if (changes.empty) continue;
      out.push({ changes, file, prevDoc: file.doc });
      file.doc = view.state.doc;
      file.version = this.nextVersion(file.uri);
      plugin.clear();
    }
    return out;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const existing = this.files.find(f => f.uri === uri);
    if (existing) {
      // A second editor on a file the server already knows about. Telling it
      // twice would leave one `didClose` short and desync its model — which
      // returns wrong answers rather than errors.
      if (!existing.views.includes(view)) existing.views.push(view);
      // Deferred: this runs from the plugin's own construction, so
      // `LSPPlugin.get(view)` is not answerable yet.
      const pending = this.lastDiagnostics.get(uri);
      if (pending) setTimeout(() => publishDiagnosticsToAllViews(this.client, pending), 0);
      return;
    }
    const file = new MultiViewFile(uri, languageId, view);
    file.version = this.nextVersion(uri);
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.files.find(f => f.uri === uri);
    if (!file) return;
    file.views = file.views.filter(v => v !== view);
    if (file.views.length) return;      // another task still has it open
    this.files = this.files.filter(f => f !== file);
    this.lastDiagnostics.delete(uri);
    this.client.didClose(uri);
  }

  /**
   * Put a file in front of the user for go-to-definition.
   *
   * Inside the checkout it is an ordinary editor tab. OUTSIDE it — a
   * definition in `site-packages`, `node_modules`, `~/.cargo/registry`, the Go
   * module cache — it is the read-only external tab (GH #240), because every
   * task-relative path in the app is contained by `safe_task_path` on purpose
   * and there is no uncontained write to pair with the uncontained read.
   *
   * Following a symbol into a dependency is most of what reading unfamiliar
   * code IS, so refusing to leave the checkout would leave the feature stopping
   * exactly where the interesting part starts.
   */
  async displayFile(uri: string): Promise<EditorView | null> {
    const open = this.files.find(f => f.uri === uri);
    if (open) return open.getView();

    const abs = uriToPath(uri);
    const app = useApp.getState();
    // Which task shows it: the one the user is looking at, if it reads this
    // checkout, else any task that armed it.
    const holders = useCodeIntel.getState().grants[grantKey(this.root, this.server)] ?? [];
    // The active task first: several tasks can share one main checkout, and
    // opening the file in a different one hides the pane the reader is in.
    const taskFor = (id: string | null) => {
      const t = app.tasks.find(x => x.id === id);
      if (!t) return null;
      const project = app.projects.find(p => p.id === t.project_id);
      return checkoutRoot(t, project) === this.root ? t : null;
    };
    const task = taskFor(app.activeTaskId) ?? holders.map(taskFor).find(Boolean) ?? null;
    if (!abs || !task) return null;

    const rel = relUnder(abs, task.path);
    app.openPreviewTab(task.id, rel !== null
      ? { type: "edit", path: rel, title: baseName(abs) }
      // Absolute path, read-only, and titled by the file rather than by a
      // trail nobody can click: the tab is outside every root this task has.
      : { type: "external", path: abs, title: baseName(abs) });

    // The pane mounts asynchronously (file read + grammar chunk), and the
    // client dispatches its selection into whatever this resolves to. Give the
    // editor a moment to exist, then hand back its view; a null just means the
    // jump lands on the tab without moving the cursor.
    for (let i = 0; i < 40; i++) {
      const file = this.files.find(f => f.uri === uri);
      const view = file?.getView();
      if (view) return view;
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  }
}

/**
 * Apply pushed diagnostics to EVERY editor showing the file.
 *
 * The client's own handler dispatches to `file.getView()`, which is one view —
 * fine when a file can only be open once, wrong here: two tasks sharing a
 * checkout each render their own editor on the same path, and the second one
 * would sit there with no squiggles and no way to know why.
 *
 * Registered as a config-level notification handler, which the client tries
 * BEFORE the ones its extensions install, so returning true replaces the
 * built-in rather than doubling it.
 */
export function publishDiagnosticsToAllViews(
  client: Client,
  params: { uri: string; version?: number | null; diagnostics: any[] },
): boolean {
  const file = client.workspace.getFile(params.uri);
  if (!file) return false;
  const ws = client.workspace;
  if (ws instanceof TermicWorkspace) ws.rememberDiagnostics(params);
  if (params.version != null && params.version !== file.version) return false;
  const views = file instanceof MultiViewFile ? file.views : [file.getView()].filter(Boolean) as EditorView[];
  let handled = false;
  for (const view of views) {
    const plugin = LSPPlugin.get(view);
    if (!plugin) continue;
    // Navigation is the point; type checking is opt-in (prefs.codeIntelDiagnostics).
    // Dropped here rather than by not asking, because a PUSHING server sends
    // these unbidden, and the same switch has to silence both models. An empty
    // set rather than an early `continue`: turning the pref off mid-session
    // must clear what is already underlined, not freeze it on screen.
    applyDiagnostics(view, params.diagnostics.map(item => ({
      from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
      to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
      severity: severityOf(item.severity),
      // A pushing server's diagnostics used to arrive anonymous: no server
      // name and no rule id, where the pull path printed both.
      source: attribution(item.source, item.code),
      message: item.message,
    })));
    handled = true;
  }
  return handled;
}
