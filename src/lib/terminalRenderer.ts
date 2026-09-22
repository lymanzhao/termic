// WebGL terminal renderer setup. Shared by TerminalPane + AuxTerminal.
//
// TEMP: also installs a diagnostic — `window.__termicDumpRenderer()`
// (call it from the Web Inspector console) dumps the WebGL renderer's
// full dimension state. Diffing that between the thin-launch state and
// the crisp after-monitor-move state pinpoints the exact wrong value.
// Remove once the retina-thinness bug is fixed.

import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import type { Terminal } from "@xterm/xterm";
import { usePrefs } from "@/store/prefs";
import { terminalFontReady, isTerminalFontReady } from "@/lib/terminalFontReady";
import { keepAtlasCanvasConnected } from "@/lib/atlasCanvasGuard";
import { guardAtlasPageVersions } from "@/lib/atlasPageVersionGuard";
import { onReturnFromAway } from "@/lib/userPresence";
import * as ipc from "@/lib/ipc";

function dumpRenderer(addon: WebglAddon | CanvasAddon | null): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r: any = (addon as any)?._renderer;
  if (!r) { console.log("[termic renderer] no WebGL renderer"); return; }
  console.log("[termic renderer] " + JSON.stringify({
    windowDPR: window.devicePixelRatio,
    coreBrowserDPR: r._coreBrowserService?.dpr,
    rendererDPR: r._devicePixelRatio,
    charSize: { w: r._charSizeService?.width, h: r._charSizeService?.height },
    canvasBacking: { w: r._canvas?.width, h: r._canvas?.height },
    canvasCSS: { w: r._canvas?.style?.width, h: r._canvas?.style?.height },
    dimsDeviceChar: r.dimensions?.device?.char,
    dimsDeviceCell: r.dimensions?.device?.cell,
    dimsCSSCell: r.dimensions?.css?.cell,
  }, null, 2));
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Load the renderer named by the `terminalRenderer` pref onto `term`.
 *  Returns a disposable: call `dispose()` BEFORE `term.dispose()` so the
 *  render loop can't fire on a half-disposed terminal. On "dom", or if the
 *  addon throws (unsupported), nothing is loaded and xterm's built-in DOM
 *  renderer remains. Read once at mount; changing the pref takes effect on
 *  the next terminal spawn (relaunch to switch every open terminal).
 *
 *  GH #140 reported the macOS 26 WebGL surface costing ~33pp of WindowServer
 *  while idle and asked for a way off it. Re-measuring on an M1 Max at a
 *  comparable canvas size (~3.4M device px) did not reproduce that: WebGL
 *  costs ~1pp more WindowServer than DOM, and DOM's total is actually WORSE
 *  once WebContent and WebKit's GPU process are counted, which the issue did
 *  not measure. Under sustained output WebGL is ~2.7x cheaper than either
 *  alternative. So WebGL stays the default and this pref is a compatibility
 *  escape hatch (software rasterizers on Linux/WebKitGTK, driver bugs), NOT a
 *  battery lever. Canvas is the one option that genuinely lowers idle cost,
 *  and it pays for that under load.
 *
 *  The cost also does NOT stack per surface, which the earlier "~10pp per
 *  idle visible terminal" note here got wrong in kind rather than in degree.
 *  Ten split terminals cost +0.8pp of WindowServer and +0.2pp of GPU over
 *  one (n=2 each, same maximized window), against the ~70pp a per-surface
 *  cost would predict. It tracks total canvas AREA, which the window size
 *  fixes, so splitting a window ten ways divides the same pixels rather than
 *  multiplying them. Practical consequence: window size and display scaling
 *  are the variables that matter here, not how many terminals are on screen. */
/** GH #70: the bundled JetBrains Mono is a lazy @font-face; xterm's WebGL atlas
 *  keys glyphs per (char, fg, bg, ext) with no font in the key, so a glyph
 *  rasterized against the fallback stays wrong-height until the cell happens to
 *  re-rasterize (selection changes the bg, new key, correct glyph, which is why
 *  selecting text "fixed" it).
 *
 *  The previous gate polled `document.fonts` for the family, but check() and
 *  load() both report a family READY before it is registered in the FontFaceSet
 *  (check() returns true and load() resolves with zero faces for an unregistered
 *  family, reproduced on WKWebView). Since fontsource registers "JetBrains Mono"
 *  via async CSS @font-face, that vacuous window is the poison window on a cold
 *  spawn. So correctness now comes from loadTerminalRenderer holding the WebGL
 *  attach until `terminalFontReady` resolves: real FontFace handles we own and
 *  await (lib/terminalFontReady). The atlas is then built against the real face
 *  and never poisoned, so nothing is cleared under a live renderer (the
 *  disproven #70 path). This fn is the spawn-side gate: it waits the same
 *  promise, then RE-FITS so the PTY cols/rows match the real metrics.
 *
 *  Warm path (faces already loaded, the norm thanks to the boot warm-up in
 *  main.tsx): return immediately, zero cost. The re-fit is guarded against
 *  zero-geometry hosts (collapsed split, same reason the panes' ResizeObservers
 *  bail at 0x0) and the mid-spawn window where term.onResize isn't registered
 *  yet, which would silently desync PTY cols/rows (hence the ptyResize retry). */
export async function awaitTerminalFonts(
  term: Terminal,
  fit: { fit(): void },
  host: HTMLElement,
  isCancelled: () => boolean,
  ptyId: () => string | null,
): Promise<void> {
  if (isTerminalFontReady()) return;
  await terminalFontReady;
  if (isCancelled()) return;
  // Faces are genuinely loaded now, so cols/rows measured against the fallback
  // are stale: re-fit. No clearTextureAtlas (the WebGL renderer only attached
  // once the faces were loaded, so the atlas was never poisoned).
  if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
  try { fit.fit(); } catch {}
  let tries = 20;
  const push = () => {
    if (isCancelled() || tries-- <= 0) return;
    const pid = ptyId();
    if (pid) ipc.ptyResize(pid, term.rows, term.cols).catch(() => {});
    else window.setTimeout(push, 250);
  };
  push();
}

/** Context-loss recovery budget. A dead GL context is normal and transient
 *  (WebKit reaps the GPU process under memory pressure, after sleep, or after
 *  a long idle); a GPU that dies MAX times inside WINDOW is not, and retrying
 *  into it just black-flashes the pane on a loop. Past the budget we stay on
 *  xterm's DOM renderer, which is slower but always paints, until the losses
 *  age out of the window and WebGL is worth a try again. Deliberately a
 *  sliding window rather than a permanent give-up: a terminal can live for
 *  days in one session, and a transient GPU outage should not cost it the
 *  fast renderer for all of them.
 *  The delay is one beat for WebKit's GPU process to come back:
 *  asking for a context in the same task as the loss event hands back one
 *  that is already lost. Exported for terminalRenderer.test.ts. */
export const CONTEXT_LOSS_WINDOW_MS = 60_000;
export const CONTEXT_LOSS_MAX = 3;
export const CONTEXT_REATTACH_DELAY_MS = 100;

/** Backoff after an attach that could not build an addon at all (getContext
 *  returned null, so xterm threw before any renderer was swapped in). Seen
 *  in the field on a laptop driven over Screen Sharing: every pane's rebuild
 *  failed this way, and again 100ms later, across a 30s spread, with no loss
 *  event first. That is not a GPU process mid-restart; WebGL is unavailable
 *  for a while. A few spaced retries catch the "for a while" case; past
 *  them the pane stays on xterm's DOM renderer, which paints, and every
 *  later edge (wake, return from absence, reveal) tries WebGL again. */
export const ATTACH_RETRY_MS = [1_000, 5_000, 30_000];

/** Optional sink for renderer lifecycle events. TerminalPane forwards its
 *  per-PTY `ptyDebug` logger, so a "my terminals went black" report can be
 *  answered from a log file instead of reconstructed from the xterm bundle.
 *  Which branch of a context loss you hit is invisible from the outside and
 *  decides whether recovery even runs, so it has to be recorded. */
export type RendererLog = (tag: string, content: string) => void;

export function loadTerminalRenderer(term: Terminal, log?: RendererLog): { dispose(): void } {
  let addon: WebglAddon | CanvasAddon | null = null;
  let disposed = false;
  // Read once: the pref applies to terminals opened after a change, and a
  // rebuild months into a session must not be the moment it silently takes.
  const kind = usePrefs.getState().terminalRenderer;
  const note = (content: string) => { try { log?.("renderer", content); } catch { /* never fatal */ } };

  // Reported symptom: after a long session (sleep, or the window left in the
  // background for hours) every terminal pane is BLACK, and only restarting
  // that tab brings it back. Nothing is wrong with the terminal — the PTY is
  // live and the scrollback is intact, which is exactly why a respawn "fixes"
  // it. What died is the WebGL context: WKWebView reclaims GPU resources for
  // a webview it considers idle, every context in the process is lost at
  // once, and the addon's canvas keeps compositing its last (empty) frame.
  //
  // This handler used to be `a.onContextLoss(() => a.dispose())`. Disposing is
  // necessary (a renderer on a dead context draws nothing and throws on some
  // paths) but it is only half the job: xterm falls back to its DOM renderer
  // internally, yet nothing repaints, so the pane stays black until the user
  // notices and restarts the tab by hand. Do NOT reduce this back to a bare
  // dispose. Re-attaching is what gets the pixels back.
  let lossTimes: number[] = [];
  // The budget is a sliding window, not a one-way latch: losses that age out
  // stop counting, so a GPU that comes back an hour later gets WebGL back
  // instead of leaving the terminal on the DOM renderer for the rest of its
  // life. Every path that would attach WebGL has to consult this, not just the
  // loss handler, or the give-up decision is only as durable as the next
  // window focus.
  const lossBudgetSpent = () => {
    const now = Date.now();
    lossTimes = lossTimes.filter(t => now - t < CONTEXT_LOSS_WINDOW_MS);
    return lossTimes.length > CONTEXT_LOSS_MAX;
  };

  const glOf = (a: WebglAddon) =>
    (a as unknown as { _renderer?: { _gl?: WebGLRenderingContext } })._renderer?._gl;

  // Dispose `a` and, if it was the live addon, forget it FIRST: a UA that
  // dispatched the release's webglcontextlost synchronously would otherwise
  // re-enter recovery past the stale-addon guards and spend loss budget on a
  // deliberate drop. Returns whether it was live. The explicit release is
  // ours to do: xterm's dispose detaches the canvas but leaves the context
  // to GC, and live ones count against WebKit's per-process cap.
  const dropAddon = (a: WebglAddon): boolean => {
    const wasLive = a === addon;
    if (wasLive) addon = null;
    const gl = glOf(a);
    try { a.dispose(); } catch { /* already gone */ }
    try { gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* already lost */ }
    return wasLive;
  };

  const recoverFromContextLoss = (lost: WebglAddon) => {
    // Idempotent per addon. ONE dead context is now reported up to three
    // times — our own `webglcontextlost` listener, a `webglcontextrestored`
    // that lands on the same canvas afterwards, and xterm's `onContextLoss`
    // three seconds later — and an addon that is no longer the live one has
    // nothing left to recover. Without this guard a single GPU blip pushes
    // three entries into `lossTimes` and spends the whole budget at once,
    // dropping the terminal to the DOM renderer on the first hiccup.
    const wasLive = dropAddon(lost);
    if (!wasLive || disposed) return;
    lossTimes.push(Date.now());
    if (lossBudgetSpent()) {
      // Out of budget: the DOM renderer xterm fell back to on dispose owns the
      // pane now, but it only paints rows it is told are dirty and the loss
      // dirtied nothing. Without this the give-up path looks identical to the
      // bug it exists to avoid.
      note(`loss budget spent (${lossTimes.length} in ${CONTEXT_LOSS_WINDOW_MS}ms) — staying on the DOM renderer`);
      try { term.refresh(0, term.rows - 1); } catch { /* mid-teardown */ }
      return;
    }
    note(`re-attaching in ${CONTEXT_REATTACH_DELAY_MS}ms (loss ${lossTimes.length}/${CONTEXT_LOSS_MAX})`);
    window.setTimeout(() => { if (!disposed && !addon) attach(); }, CONTEXT_REATTACH_DELAY_MS);
  };

  // Own the raw canvas events rather than waiting on xterm's derived
  // `onContextLoss`, because xterm's handling of a RESTORED context is the
  // hole the pane falls through. Its WebglRenderer answers `webglcontextlost`
  // with `preventDefault()` plus a 3s timer, and fires `onContextLoss` only if
  // no `webglcontextrestored` arrives first. When one DOES arrive it repairs
  // in place: `removeTerminalFromCache(terminal)` (which disposes the glyph
  // atlas outright when this terminal was its only owner) followed by
  // `_initializeWebGLState()`, which builds a fresh GlyphRenderer on the new
  // context but never calls `_refreshCharAtlas()`. So `_charAtlas` still
  // points at the evicted atlas, no texture is uploaded to the new context,
  // and the pane draws nothing. The one path that would rebuild it — the
  // `!_isAttached` branch of `renderRows()` — cannot run, because `_isAttached`
  // was set true at construction (`screenElement.isConnected`, and a
  // display:none pane is still connected) and nothing clears it.
  //
  // From out here that state is invisible: `onContextLoss` never fires (the
  // timer was cleared) and `gl.isContextLost()` is FALSE, because the context
  // genuinely was restored. Both of the signals the recovery is wired to say
  // the terminal is healthy while it paints nothing, which is why only a tab
  // restart cured it. Treat a restore as a loss and rebuild the addon: a fresh
  // context with a fresh atlas is the only state we can reason about.
  //
  // Taking `webglcontextlost` directly also removes the 3s of black that the
  // working path costs today. xterm's own timer still fires afterwards onto an
  // addon we have already replaced; `recoverFromContextLoss` no-ops on it.
  // One controller for every canvas this renderer ever owns. Each recovery
  // attaches a new addon with a new canvas, and the dead ones are collectable
  // anyway once the addon is disposed, but tying them all to a signal makes
  // the lifetime explicit rather than a GC argument: dispose() drops every
  // listener at a known point, in a terminal that may live for days.
  const canvasWatch = new AbortController();

  const watchCanvas = (a: WebglAddon) => {
    const canvas = (a as unknown as { _renderer?: { _canvas?: HTMLCanvasElement } })
      ._renderer?._canvas;
    if (!canvas?.addEventListener) return;  // xterm rename → event-driven only
    const { signal } = canvasWatch;
    // A dropped addon's canvas still reports (dropAddon releases its context,
    // which fires one last loss); only the live one is news.
    canvas.addEventListener("webglcontextlost", () => {
      if (a !== addon) return;
      note("webglcontextlost");
      recoverFromContextLoss(a);
    }, { signal });
    canvas.addEventListener("webglcontextrestored", () => {
      if (a !== addon) return;
      // Healthy-looking and blank. See the note above.
      note("webglcontextrestored (stale atlas) — rebuilding");
      recoverFromContextLoss(a);
    }, { signal });
  };

  // The event is not guaranteed. A webview that is suspended (window hidden
  // for hours, App Nap) can have its context reaped without `webglcontextlost`
  // ever being delivered — the same black pane with no callback to recover
  // from it, which is the shape the original report describes. So also probe
  // on the edges where the user is about to LOOK at the terminal: focus and
  // visibilitychange. `_gl` is optional-chained and pinned by
  // xtermInternals.test.ts, so an xterm rename degrades to "event-driven
  // recovery only" rather than throwing.
  //
  // A null addon here is the other half: an earlier re-attach that ran while
  // the GPU was still down hit the catch in attach(), or was deferred because
  // the pane had no geometry, and either way the terminal is on the DOM
  // renderer. Wake is the natural moment to try again.
  //
  // `isContextLost()` is NOT a health check, only a liveness one: a context
  // that WebKit restored reads as healthy while the renderer draws nothing
  // against a stale atlas. That case is caught on the canvas events in
  // watchCanvas, not here.
  const onWake = () => {
    if (disposed || document.visibilityState === "hidden") return;
    if (addon instanceof WebglAddon) {
      if (glOf(addon)?.isContextLost() === true) recoverFromContextLoss(addon);
      return;
    }
    if (!addon) attach();
  };
  window.addEventListener("focus", onWake);
  document.addEventListener("visibilitychange", onWake);


  // A pane with no pixels on screen has nothing to repaint, and a GPU outage
  // is process-wide: every mounted terminal loses its context at the same
  // moment while at most one of them is visible (MainArea keeps every visited
  // task mounted under display:none, TaskView every tab). Re-attaching all of
  // them on that edge spends a live GL context each to draw nothing, and
  // WebKit caps contexts per process — past the cap it force-loses the oldest,
  // which is another loss, aimed at whichever pane happens to be next in line.
  // So attach only where there are pixels, and let the reveal edge do the rest.
  //
  // `term.element` is absent before term.open() (and in unit tests): treat that
  // as "no reason to defer", so this gate can never be the thing that stops a
  // renderer attaching.
  const onScreen = () => {
    const el = term.element;
    return !el || (el.offsetWidth > 0 && el.offsetHeight > 0);
  };

  // Every gate lives here so every edge can just call attach(): no addon yet,
  // WebGL wanted, faces loaded (GH #70), loss budget not spent, and pixels on
  // screen. A call that fails a gate is a no-op, and the next edge tries
  // again, so there is no "pending" state to keep in sync.
  let retries = 0;
  let retryTimer: number | null = null;
  const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // The screen div xterm renders into. `term.element` is a plain stub in unit
  // tests and absent before term.open(), so reach optionally.
  const screenOf = () =>
    (term.element as { querySelector?: (s: string) => Element | null } | undefined)
      ?.querySelector?.(".xterm-screen") ?? null;
  const screenCanvases = (): HTMLCanvasElement[] => {
    const screen = screenOf();
    return screen ? Array.from(screen.querySelectorAll("canvas")) : [];
  };

  // A failed activate LEAKS a canvas holding a live GL context. xterm's
  // WebglRenderer constructor appends its canvas to .xterm-screen, then runs
  // _initializeWebGLState() — the call that throws "value must not be falsy"
  // when the new context is born lost (GL object constructors return null) —
  // and only AFTER that registers the disposable that would remove the
  // canvas. The half-built renderer is unreachable from the addon (the throw
  // happened before assignment), so the DOM is the only handle left. WebKit
  // caps live WebGL contexts per process and past the cap every context
  // anyone asks for is born lost too, including these retries: one GPU
  // outage plus eight panes retrying leaked dozens of contexts and wedged
  // the whole window into blank-on-every-renderer until a reload (field log
  // 2026-08-23). Releasing the context and removing the canvas makes a
  // failed attach cost nothing.
  const releaseLeakedCanvases = (prior: Set<HTMLCanvasElement>) => {
    for (const c of screenCanvases()) {
      if (prior.has(c)) continue;
      try {
        (c.getContext("webgl2") as WebGL2RenderingContext | null)
          ?.getExtension("WEBGL_lose_context")?.loseContext();
      } catch { /* not a GL canvas */ }
      c.remove();
    }
  };

  const attach = () => {
    if (disposed || addon || kind === "dom") return;
    if (!isTerminalFontReady() || lossBudgetSpent() || !onScreen()) return;
    const priorCanvases = new Set(screenCanvases());
    let pending: WebglAddon | CanvasAddon | null = null;
    try {
      if (kind === "canvas") {
        // No GL context, so no onContextLoss and no shared texture atlas to
        // park: the canvas renderer owns its own <canvas> layers inside the
        // terminal element, and disposing it takes them with it. That is the
        // whole reason it exists as a middle option.
        const c = pending = new CanvasAddon();
        term.loadAddon(c);
        addon = c;
        return;
      }
      const a = pending = new WebglAddon();
      a.onContextLoss(() => { note("onContextLoss (xterm, not restored)"); recoverFromContextLoss(a); });
      // Atlas swaps (font/theme/dpr). Microtask: the event fires before the
      // renderer stores the new atlas; its warm-up runs later, on idle.
      a.onChangeTextureAtlas(() => queueMicrotask(() => {
        if (disposed) return;
        keepAtlasCanvasConnected(a);
        // A swap hands the renderer a WHOLE NEW TextureAtlas (font size, theme
        // or dpr change), unguarded and starting its page versions at 0 again.
        // Re-guarding here is what keeps GH #314 fixed across a Cmd +/-.
        guardAtlasPageVersions(a);
      }));
      term.loadAddon(a);
      addon = a;
      retries = 0;
      if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; }
      watchCanvas(a);
      // Initial atlas (born inside loadAddon; fires the event too early for
      // the addon to forward it). Park before the idle warm-up rasterizes.
      keepAtlasCanvasConnected(a);
      // Same edge for GH #314: guard the pages this atlas already has and
      // subscribe for the ones it will create.
      guardAtlasPageVersions(a);
      note("webgl attached");
    } catch (e) {
      // xterm threw before swapping any renderer in, so its DOM renderer
      // still owns the pane and keeps painting.
      addon = null;
      try { pending?.dispose(); } catch { /* activate threw mid-construction */ }
      releaseLeakedCanvases(priorCanvases);
      const delay = ATTACH_RETRY_MS[retries];
      note(`webgl attach failed (${describe(e)})${delay === undefined ? " — staying on the DOM renderer" : `, retrying in ${delay}ms`}`);
      if (delay === undefined || retryTimer !== null) return;
      retries++;
      retryTimer = window.setTimeout(() => { retryTimer = null; attach(); }, delay);
    }
  };

  // What the field log needs to name the mechanism, none of which the
  // recovery can act on. `_isPaused` earns its place because a paused render
  // service (IntersectionObserver said "off screen") draws nothing on ANY
  // renderer. Reach-ins pinned by xtermInternals.test.ts.
  type RenderServiceInternals = { _isPaused?: boolean };
  const renderServiceOf = () =>
    (term as unknown as { _core?: { _renderService?: RenderServiceInternals } })._core?._renderService;

  const paneState = () => {
    const paused = renderServiceOf()?._isPaused;
    const el = term.element;
    return [
      `isContextLost=${String(addon instanceof WebglAddon ? glOf(addon)?.isContextLost() : undefined)}`,
      `paused=${String(paused)}`,
      `visibility=${document.visibilityState}`,
      `focus=${String(document.hasFocus())}`,
      `size=${el ? `${el.offsetWidth}x${el.offsetHeight}` : "?"}`,
    ].join(" ");
  };

  // The fourth signal, and the only one that needs nothing from WebKit: the
  // user came back (userPresence.ts has the screen-sharing case it exists
  // for). A renderer that reports healthy and paints nothing cannot be told
  // from a healthy one, so rebuild without asking: fresh context, fresh
  // atlas, fresh canvas, disposed and attached in one task so no blank frame
  // paints between them. Not a loss, so no budget is spent. Only a pane with
  // pixels pays on the keystroke frame; a hidden one rebuilds on its reveal.
  let stale = false;
  const rebuild = (why: string) => {
    stale = false;
    if (kind !== "webgl") return;  // nothing GL-backed to lose or rebuild
    if (!(addon instanceof WebglAddon)) {
      // An earlier attach failed and the DOM renderer owns the pane: the
      // edge is one more chance at WebGL.
      note(`${why} — on the DOM renderer, trying webgl (${paneState()})`);
      attach();
      return;
    }
    note(`${why} — rebuilding the renderer (${paneState()})`);
    dropAddon(addon);
    attach();
  };
  const onReturn = (awayMs: number) => {
    if (disposed) return;
    if (!onScreen()) { stale = true; return; }
    rebuild(`back after ${Math.round(awayMs / 1000)}s away`);
  };
  const offReturn = onReturnFromAway(onReturn);

  // The reveal edge: display:none reports 0x0 and the real size lands when the
  // tab or task is shown again, which is where an attach that found no pixels
  // gets picked up. Same edge TerminalPane repairs the viewport scroller on.
  // `onWake` only covers app-level focus, and switching tabs inside termic
  // fires neither `focus` nor `visibilitychange`. The same edge rebuilds a
  // pane that was hidden when the user came back.
  // Read the entry's contentRect rather than offsetWidth: a layout read inside
  // a ResizeObserver callback is the classic forced-reflow loop, and the size
  // we need is already in the entry.
  let hadGeometry = false;
  const ro = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(entries => {
        if (disposed) return;
        const r = entries[entries.length - 1]?.contentRect;
        const has = !!r && r.width > 0 && r.height > 0;
        const revealed = has && !hadGeometry;
        hadGeometry = has;
        if (!has) return;
        if (stale) rebuild("revealed after a return from absence");
        // Only the 0 -> non-zero REVEAL retries WebGL. A plain resize fires
        // this ~60x/s during a drag, and while WebGL is down each attach is
        // a context request against WebKit's cap: exactly the churn the
        // backoff ladder exists to prevent.
        else if (revealed) attach();
      })
    : null;
  if (term.element) { try { ro?.observe(term.element); } catch { /* not an Element */ } }

  // GH #70: hold the FIRST attach until the owned faces are genuinely loaded
  // (terminalFontReady is real FontFace handles, not document.fonts.check(),
  // which is vacuously true before the family is registered). The addon then
  // builds its glyph atlas against the real face instead of caching
  // fallback-height glyphs that never correct, so nothing is ever cleared under
  // a live renderer. xterm's DOM renderer covers the gap. GPU-off and warm-face
  // attach right away; a face that never loads still resolves terminalFontReady
  // and gets GPU (consistent fallback, not the mixed-height "waves").
  //
  // The canvas renderer keys its glyph cache the same way, so it needs the
  // same gate; only "dom" can attach unconditionally, and for it attach() is
  // a no-op anyway.
  if (isTerminalFontReady() || kind === "dom") {
    attach();
  } else {
    terminalFontReady.then(() => { if (!disposed && !addon) attach(); });
  }

  // TEMP diagnostic. Auto-dumps the launch state; the global lets the
  // user dump again after a monitor move (the crisp state) to diff.
  (window as unknown as { __termicDumpRenderer?: () => void }).__termicDumpRenderer =
    () => dumpRenderer(addon);
  const dumpTimers = [400, 1800].map(d => window.setTimeout(() => dumpRenderer(addon), d));

  return {
    dispose() {
      disposed = true;
      canvasWatch.abort();
      ro?.disconnect();
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      offReturn();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      dumpTimers.forEach(t => window.clearTimeout(t));
      // Park the shared atlas canvas before this pane's DOM unmounts with it.
      // Only WebGL has one; the canvas renderer's layers die with its dispose.
      if (addon instanceof WebglAddon) keepAtlasCanvasConnected(addon, term.element);
      try { addon?.dispose(); } catch { /* already gone */ }
    },
  };
}
