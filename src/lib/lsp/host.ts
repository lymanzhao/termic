// The webview half of the language-server host (GH #174).
//
// One `LSPClient` per (checkout root, server), refcounted by the editors using
// it, because the unit that owns an index is the CHECKOUT, not the task: a
// main-checkout task and its five siblings read the same bytes, so they share
// one server, while two worktrees of one repo must NOT — they hold different
// content behind the same module paths, and a shared server would resolve an
// import into the wrong copy.
//
// The transport is a Tauri Channel, not `emit`/`listen`: Tauri's own docs say
// listeners "may process events out of order if a listener is async", and
// out-of-order delivery corrupts JSON-RPC.

import { invoke, Channel } from "@tauri-apps/api/core";
import { LSPClient, serverDiagnostics, type Transport } from "@codemirror/lsp-client";
import { TermicWorkspace, publishDiagnosticsToAllViews } from "./workspace";
import { useLspStatus, statusKey } from "@/store/lspStatus";
import { useApp } from "@/store/app";
import { checkoutRoot } from "@/store/codeIntel";
import { resolveServerSettings } from "./serverSettings";
import { lspOffer } from "./install";
import DOMPurify from "dompurify";

// Re-exported for the editor side, which has this module loaded anyway. The
// chip in the main chunk must import them from ./install directly: reaching
// them through here would drag the whole LSP client onto the app-start path
// (lib/mainChunkGuard.test.ts).
export { lspOffer, lspInstall, type LspOffer } from "./install";
import { choiceForRoot } from "./install";
import { LSP_PAGE_ID } from "./pageSession";
import { pathToFileUri } from "@/lib/osPath";

const lspStart = (root: string, language: string, channel: Channel<string>, options?: any) =>
  // Stamped with this page load, so a reload's orphans can be told apart from
  // the servers this page is actually using. See `lib/lsp/pageSession.ts`.
  invoke<string>("lsp_start", {
    root, language, channel, options,
    page: LSP_PAGE_ID,
    ...(() => {
      // Resolved ONCE. Calling it twice would read the store twice, and a
      // change landing between the two reads would send a pick from one
      // choice with a command from another.
      const { server, command } = choiceForRoot(root, language);
      return { preferred: server, custom: command };
    })(),
  });
const lspSend = (id: string, message: string) =>
  invoke<void>("lsp_send", { id, message });
const lspStop = (id: string) => invoke<void>("lsp_stop", { id });

export interface LspServerInfo {
  id: string;
  root: string;
  language: string;
  command: string;
  pid: number;
}
export const lspList = () => invoke<LspServerInfo[]>("lsp_list");

/** file:// URI for an absolute path, matching the Rust side's encoding. */
export function fileUri(absPath: string): string {
  return pathToFileUri(absPath);
}

type Entry = {
  client: LSPClient;
  serverId: Promise<string>;
  /** Editors currently using this client. The server dies when it hits 0. */
  refs: number;
  /** Pending idle reap, so a tab bounce does not pay for a re-index. */
  reap: number | null;
};

/**
 * Keyed by root + server, which is exactly the sharing rule above.
 *
 * Held on `globalThis` rather than as a plain module constant, because the
 * bundler is free to INLINE a shared module into more than one lazy chunk —
 * and it does: `acquireClient` ends up in the editor's chunk and in symbol
 * search's, which meant two maps. The editor would start a server and the
 * symbol search would see none, with a live process in `lsp_list` the whole
 * time. Nothing in the code says the map is a singleton, so this is where it
 * is said.
 */
const clients: Map<string, Entry> =
  ((globalThis as unknown as { __termicLspClients?: Map<string, Entry> }).__termicLspClients ??=
    new Map<string, Entry>());

/** How long a server outlives its last editor.
 *
 *  Long enough that closing a tab and opening another is free, short enough
 *  that walking away gives the memory back: these processes never shrink on
 *  their own, so ending the process is the only way to reclaim an index.
 *
 *  The e2e build uses 1.5s. The reap is the whole memory story, so it has to
 *  be tested rather than asserted in a comment, and a spec cannot sit still
 *  for three minutes. */
export const IDLE_REAP_MS = import.meta.env.VITE_E2E ? 1_500 : 3 * 60_000;

function makeTransport(serverId: Promise<string>, channel: Channel<string>): Transport {
  const handlers = new Set<(value: string) => void>();
  channel.onmessage = (msg) => {
    for (const h of [...handlers]) h(msg);
  };
  return {
    send(message: string) {
      // Fire and forget, in order: `invoke` resolves after Rust has written
      // the frame, and awaiting here would serialise the editor on the pipe.
      serverId.then(id => lspSend(id, message)).catch(() => {});
    },
    subscribe(handler) { handlers.add(handler); },
    unsubscribe(handler) { handlers.delete(handler); },
  };
}

/**
 * Take a reference to the client for a checkout + server, spawning the server
 * on the first one. The returned `release` drops the reference and, when it
 * was the last, schedules the idle reap.
 */
export function acquireClient(root: string, server: string): {
  client: LSPClient;
  release: () => void;
} {
  const key = clientKey(root, server);
  // The STATUS store has its own key, and it is not this one. `clientKey`
  // joins with a NUL (it is a map key and a checkout path can contain
  // anything); `statusKey` joins with a space because that is what the chip
  // reads. Writing phases under `key` meant every phase landed in a slot
  // nothing reads: no busy dot, no "Indexing", no "the server stopped",
  // exactly the silence lspStatus.ts exists to prevent. This file's own
  // comment about a NUL against a space is about the same mistake.
  const skey = statusKey(root, server);
  let entry = clients.get(key);
  if (!entry) {
    const channel = new Channel<string>();
    const status = useLspStatus.getState();
    // Spawned but not yet answering. Everything between here and `ready` is
    // time the user spends asking questions that come back empty, which is why
    // it is a state rather than a gap.
    status.set(skey, { phase: "starting" });

    const app = useApp.getState();
    const task = app.tasks.find(t => {
      const p = app.projects.find(proj => proj.id === t.project_id);
      return p && checkoutRoot(t, p) === root;
    });
    const project = task ? app.projects.find(p => p.id === task.project_id) : undefined;
    const rawSettings = project?.code_intel_settings?.[server];

    const serverId = lspOffer(root, server).then((offer) => {
      const options = resolveServerSettings(offer.exe, rawSettings);
      return lspStart(root, server, channel, options);
    });
    serverId.catch((e: Error) => status.set(skey, { phase: "failed", message: String(e) }));
    const client = new LSPClient({
      rootUri: fileUri(root),
      // Not the default workspace: it THROWS on a second view of one file, and
      // termic reaches that without trying — several tasks can share the main
      // checkout, each with its own editor on the same path.
      workspace: c => new TermicWorkspace(c, root, server),
      // Servers return Markdown that we render to HTML inside the webview, so
      // a hover card is an XSS channel from a process that reads the repo —
      // including a docstring an agent wrote a minute ago. Same posture as the
      // remote-image gate (#69).
      // Sanitised AND stripped of images.
      //
      // DOMPurify's default strips scripts and handlers but keeps
      // `<img src="https://…">`, and this app's CSP allows `img-src … https:`,
      // so a remote image in a hover was a GET to whoever wrote it: IP,
      // user-agent and timing, fired by hovering, with no click.
      //
      // Hover content is not trustworthy. A docstring is written by whatever
      // the agent read a minute ago (docs/sandbox.md's prompt-injection case),
      // and a dependency's docstring needs no agent at all: a rustdoc comment
      // with a shields.io badge beacons on its own. #69 closed the same hole
      // for markdown previews with `gateRemoteImages`, which never ran here.
      //
      // Images are dropped outright rather than gated behind a click, because
      // a hover is transient and there is nothing to click: a picture is not
      // why anyone hovers a symbol, and the text around it is kept.
      sanitizeHTML: (html: string) => DOMPurify.sanitize(html, HOVER_SANITIZE),
      // Indexing a large repo is not a 3-second operation, and the default
      // would time out the first hover on every cold server.
      timeout: 20_000,
      // Diagnostics feed `lintGutter()`, which EditorPane has had mounted with
      // no source since the day it was written. It belongs on the CLIENT, not
      // in the editor's extension array, because it also has to claim pull
      // support in `initialize`: several servers do only pull (TypeScript 7
      // among them, silently), several only push, and rust-analyzer pushes
      // `cargo check` results ungated while advertising pull for its own.
      extensions: [
        serverDiagnostics(),
        {
          // Advertise work-done progress, now that there is somewhere to show
          // it. The plan said not to until then, for a good reason: a server
          // that sends `window/workDoneProgress/create` and gets no reply
          // blocks (pylsp waits ~1s per linter per pass). Our Rust host
          // answers that request before the webview ever sees it, and
          // `$/progress` above renders the result.
          clientCapabilities: { window: { workDoneProgress: true } },
        },
      ],
      // Tried before the extensions' handlers, so this replaces the built-in
      // one rather than doubling it: the built-in reports to a single view,
      // and a file open in two tasks has two.
      notificationHandlers: {
        "textDocument/publishDiagnostics": publishDiagnosticsToAllViews,
        // Work-done progress: how a server says "I am indexing, ask me later".
        // rust-analyzer reports its crate graph this way and takes minutes on
        // a large workspace; without this the editor looks broken for all of
        // it. `window/workDoneProgress/create` is answered by the Rust host
        // before it ever reaches here.
        "$/progress": (_client, params: {
          value?: { kind?: string; title?: string; message?: string; percentage?: number };
        }) => {
          const v = params?.value;
          if (!v?.kind) return true;
          if (v.kind === "end") {
            useLspStatus.getState().set(skey, { phase: "ready" });
            return true;
          }
          useLspStatus.getState().set(skey, {
            phase: "indexing",
            message: v.message || v.title || undefined,
            percent: v.percentage,
          });
          return true;
        },
      },
    });
    const transport = makeTransport(serverId, channel);
    client.connect(transport);
    // Handshake done means it will answer, even if it is still reading the
    // repo; a server that then reports progress moves itself back to indexing.
    client.initializing.then(
      () => {
        const cur = useLspStatus.getState().byKey[skey];
        if (!cur || cur.phase === "starting") useLspStatus.getState().set(skey, { phase: "ready" });
      },
      (e) => useLspStatus.getState().set(skey, { phase: "failed", message: String(e) }),
    );
    entry = { client, serverId, refs: 0, reap: null };
    clients.set(key, entry);
  }
  if (entry.reap !== null) {
    window.clearTimeout(entry.reap);
    entry.reap = null;
  }
  entry.refs++;
  let released = false;
  return {
    client: entry.client,
    release() {
      if (released) return;
      released = true;
      // The entry THIS caller acquired, not whatever is under the key now. A
      // re-look-up decremented a SUCCESSOR: stop the server, let another task
      // start a fresh one, then close the first editor, and the stale closure
      // took a reference off the new entry and scheduled its reap. Three
      // minutes later a server somebody was actively using went away.
      const e = clients.get(key);
      if (!e || e !== entry) return;
      e.refs--;
      if (e.refs > 0) return;
      e.reap = window.setTimeout(() => {
        const cur = clients.get(key);
        // Someone re-armed it inside the grace period.
        if (!cur || cur.refs > 0) return;
        clients.delete(key);
        useLspStatus.getState().clear(statusKey(root, server));
        cur.client.disconnect();
        cur.serverId.then(lspStop).catch(() => {});
      }, IDLE_REAP_MS);
    },
  };
}

/**
 * Stop ONE server now, rather than after the idle grace.
 *
 * The grace exists so that closing a tab and opening another does not pay for
 * a re-index. An explicit "turn this off" is a different act: the user has
 * decided, and the most common reason to turn it off and on again is that they
 * changed the environment underneath it (installing django-stubs, switching
 * branches, adding a dependency). Reusing the cached client there hands them
 * the same process with the same stale module graph, and the feature looks
 * broken for a reason they cannot see.
 */
export async function stopClient(root: string, server: string): Promise<void> {
  const key = clientKey(root, server);
  const entry = clients.get(key);
  if (!entry) return;
  // Deliberately stops even while editors hold references: this is the
  // explicit "off", and the callers that must NOT take navigation away from a
  // task nobody touched check the grant's refcount before calling it (see
  // CodeIntelActions.turnOff). Refs are zeroed rather than left dangling so a
  // later release cannot decrement a successor into an early reap.
  entry.refs = 0;
  clients.delete(key);
  if (entry.reap !== null) window.clearTimeout(entry.reap);
  useLspStatus.getState().clear(statusKey(root, server));
  entry.client.disconnect();
  try { await lspStop(await entry.serverId); } catch { /* already gone */ }
}

/**
 * Stop every server running for ONE language, whatever is still using it.
 *
 * For the moment somebody picks a different server: the running process is the
 * old one, and leaving it up means the setting appears to do nothing until the
 * next relaunch. The grants survive, so the next editor open starts the newly
 * chosen binary without asking again.
 */
export async function stopClientsForLanguage(server: string): Promise<void> {
  // `splitKey`, not a string suffix: the separator is part of the key format
  // and a checkout path can contain anything.
  const doomed = [...clients.entries()].filter(([key]) => splitKey(key)[1] === server);
  for (const [key, e] of doomed) {
    clients.delete(key);
    e.refs = 0;
    if (e.reap !== null) window.clearTimeout(e.reap);
    // The status entry is keyed differently (a space, not a NUL): see the note
    // in `acquireClient`.
    useLspStatus.getState().clear(statusKey(splitKey(key)[0], server));
    e.client.disconnect();
    try { await lspStop(await e.serverId); } catch { /* already gone */ }
  }
}

/** Stop every server now, whatever is still using it. Reached from the UI's
 *  "stop" action, which is why it says out loud that it stops the server for
 *  every task sharing that checkout. */
export async function stopAllClients(): Promise<void> {
  const entries = [...clients.values()];
  clients.clear();
  useLspStatus.setState({ byKey: {} });
  for (const e of entries) {
    if (e.reap !== null) window.clearTimeout(e.reap);
    e.client.disconnect();
    try { await lspStop(await e.serverId); } catch { /* already gone */ }
  }
}

/**
 * Every live client for a checkout, whatever language it serves.
 *
 * Symbol search has no file to take a language from — it is reached with
 * nothing open, which is exactly when you most need it — so it asks all of
 * them and merges. A checkout with Python and TypeScript armed answers about
 * both, which is also what the reader means by "search this project".
 */
export function clientsForRoot(root: string): Array<{ server: string; client: LSPClient }> {
  const out: Array<{ server: string; client: LSPClient }> = [];
  for (const [key, entry] of clients) {
    const [entryRoot, server] = splitKey(key);
    if (entryRoot === root) out.push({ server, client: entry.client });
  }
  return out;
}

/**
 * The map's key, spelled ONCE.
 *
 * It was built with one separator and split on another — a NUL against a
 * space — which is invisible in the source and turned `clientsForRoot` into a
 * function that always returned nothing: the editor started a server and
 * symbol search saw none, with the process alive in `lsp_list` the whole time.
 * A path may contain spaces, so NUL is the right separator; the point is that
 * exactly one place says so.
 */
const KEY_SEP = "\u0000";
/** What a language server is allowed to put on screen. Exported so the policy
 *  can be asserted without a DOM: see host.test.ts. */
export const HOVER_SANITIZE = {
  FORBID_TAGS: ["img", "svg", "video", "audio", "iframe", "object", "embed"],
  // The other attributes that fetch without being clicked.
  FORBID_ATTR: ["srcset", "ping", "formaction", "background", "poster"],
};

export function clientKey(root: string, server: string): string {
  return `${root}${KEY_SEP}${server}`;
}
function splitKey(key: string): [string, string] {
  const at = key.indexOf(KEY_SEP);
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + KEY_SEP.length)];
}

/** Test seam: how many clients are live, and their refcounts. */
export function liveClients(): Array<{ key: string; refs: number }> {
  return [...clients.entries()].map(([key, e]) => ({ key, refs: e.refs }));
}
