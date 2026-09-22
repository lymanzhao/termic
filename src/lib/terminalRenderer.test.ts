// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// WebGL context-loss recovery (black terminals after long idle / sleep).
// WKWebView reclaims GPU resources and every terminal's GL context dies; the
// old handler just disposed the addon and left the canvas black until the
// user restarted the tab. These tests pin the recovery contract:
//   - loss → dispose dead addon, attach a fresh one
//   - repeated losses inside the window → give up, repaint via DOM renderer
//   - silently-lost context (no event while suspended) → recovered on wake
//   - RESTORED context → rebuilt, because xterm's in-place repair leaves a
//     stale glyph atlas and both `onContextLoss` and `isContextLost()` report
//     the terminal healthy while it paints nothing
//   - one dead context reported N ways still costs one loss
//   - a pane with no geometry defers its attach to the reveal edge
//   - the first input after AWAY_MS away rebuilds a healthy-looking addon
//   - dispose() unhooks the wake listeners

const h = vi.hoisted(() => {
  class FakeWebglAddon {
    static instances: FakeWebglAddon[] = [];
    static attempts = 0;  // constructions asked for, successful or not
    static throwOnConstruct = false;
    lossCb: (() => void) | null = null;
    disposed = false;
    contextLost = false;
    released = false;
    // A real element: the recovery binds webglcontextlost /
    // webglcontextrestored on it, which is the whole point of these tests.
    canvas = document.createElement("canvas");
    _renderer = {
      _gl: {
        isContextLost: () => this.contextLost,
        getExtension: () => (this.contextLost ? null : { loseContext: () => { this.released = true; } }),
      },
      _canvas: this.canvas,
    };
    constructor() {
      FakeWebglAddon.attempts++;
      if (FakeWebglAddon.throwOnConstruct) throw new Error("no GL");
      FakeWebglAddon.instances.push(this);
    }
    onContextLoss(cb: () => void) { this.lossCb = cb; }
    // Recorded, not ignored: the atlas-swap guards (scratch canvas, page
    // versions) hang off this event, and a stub that drops the callback
    // makes their wiring untestable.
    atlasCb: (() => void) | null = null;
    onChangeTextureAtlas(cb: () => void) { this.atlasCb = cb; }
    dispose() { this.disposed = true; }
  }
  class FakeCanvasAddon {
    dispose() {}
  }
  const guardSpy = vi.fn();
  // happy-dom has no layout, so a real ResizeObserver would never fire. This
  // stub hands the callback back to the test, which is the only way to drive
  // the reveal branch (0 -> non-zero) rather than the focus path beside it.
  type Entry = { contentRect: { width: number; height: number } };
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    targets: unknown[] = [];
    constructor(public cb: (entries: Entry[]) => void) {
      FakeResizeObserver.instances.push(this);
    }
    observe(t: unknown) { this.targets.push(t); }
    disconnect() { this.targets.length = 0; }
  }
  // Unsubscribes handed out by the (real) presence module, so a test can
  // prove dispose() called one rather than infer it from a bail that would
  // happen anyway.
  const offs: Array<() => void> = [];
  const prefs = { terminalRenderer: "webgl" as string };
  return { FakeWebglAddon, FakeCanvasAddon, FakeResizeObserver, offs, prefs, guardSpy };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: h.FakeWebglAddon }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: h.FakeCanvasAddon }));
vi.mock("@/store/prefs", () => ({
  usePrefs: { getState: () => h.prefs },
}));
vi.mock("@/lib/userPresence", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/userPresence")>();
  return {
    ...real,
    onReturnFromAway: (l: (ms: number) => void) => {
      const off = vi.fn(real.onReturnFromAway(l));
      h.offs.push(off);
      return off;
    },
  };
});
vi.mock("@/lib/terminalFontReady", () => ({
  isTerminalFontReady: () => true,
  terminalFontReady: Promise.resolve(),
}));
vi.mock("@/lib/atlasCanvasGuard", () => ({ keepAtlasCanvasConnected: () => {} }));
vi.mock("@/lib/atlasPageVersionGuard", () => ({ guardAtlasPageVersions: h.guardSpy }));
vi.mock("@/lib/ipc", () => ({}));

import type { Terminal } from "@xterm/xterm";
import {
  loadTerminalRenderer,
  CONTEXT_LOSS_MAX,
  CONTEXT_LOSS_WINDOW_MS,
  CONTEXT_REATTACH_DELAY_MS,
  ATTACH_RETRY_MS,
} from "./terminalRenderer";
import { AWAY_MS, initUserPresence } from "./userPresence";

vi.stubGlobal("ResizeObserver", h.FakeResizeObserver);

const Fake = h.FakeWebglAddon;
const RO = h.FakeResizeObserver;

function makeTerm() {
  const renderService = { _isPaused: false };
  return {
    loadAddon: vi.fn(),
    refresh: vi.fn(),
    rows: 24,
    _core: { _renderService: renderService },
    renderService,
  } as unknown as Terminal & {
    loadAddon: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    renderService: typeof renderService;
  };
}

function current() {
  return Fake.instances[Fake.instances.length - 1];
}

function loseContext() {
  const a = current();
  a.contextLost = true;
  a.lossCb?.();
}

/** A keystroke: the user is (back) at the keyboard. */
function arrive() {
  window.dispatchEvent(new KeyboardEvent("keydown"));
}

describe("loadTerminalRenderer context-loss recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initUserPresence();
    // Presence keeps its own module-level clock across tests: stamp it with
    // the fresh fake clock so an earlier test's absence cannot leak in.
    arrive();
    Fake.instances = [];
    Fake.attempts = 0;
    Fake.throwOnConstruct = false;
    RO.instances = [];
    h.offs.length = 0;
    h.prefs.terminalRenderer = "webgl";
    h.guardSpy.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches a WebGL addon on load", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(1);
    expect(term.loadAddon).toHaveBeenCalledWith(Fake.instances[0]);
    r.dispose();
  });

  it("re-attaches a fresh addon after context loss", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    loseContext();
    expect(first.disposed).toBe(true);
    expect(Fake.instances.length).toBe(1); // re-attach is delayed
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it("gives up after too many losses in the window and repaints via DOM renderer", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i < CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX + 1);
    loseContext(); // one over the cap
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX + 1); // no new addon
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    r.dispose();
  });

  it("keeps recovering when losses are spread beyond the window", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i < CONTEXT_LOSS_MAX * 2; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_LOSS_WINDOW_MS + 1);
    }
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX * 2 + 1);
    expect(term.refresh).not.toHaveBeenCalled();
    r.dispose();
  });

  it("does not re-attach WebGL on wake while the loss budget is spent", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i <= CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    const settled = Fake.instances.length;
    window.dispatchEvent(new Event("focus")); // user tabs back and forth
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(settled);
    r.dispose();
  });

  it("re-attaches on wake once the losses age out of the window", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i <= CONTEXT_LOSS_MAX; i++) {
      loseContext();
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    const settled = Fake.instances.length;
    vi.advanceTimersByTime(CONTEXT_LOSS_WINDOW_MS + 1); // GPU comes back later
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(settled + 1);
    r.dispose();
  });

  it("recovers a silently-lost context on window focus", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    first.contextLost = true; // lost, but no webglcontextlost delivered
    window.dispatchEvent(new Event("focus"));
    expect(first.disposed).toBe(true);
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("retries a failed attach on wake", () => {
    Fake.throwOnConstruct = true; // GPU down at mount: attach fails, DOM stays
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(0);
    Fake.throwOnConstruct = false;
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
    r.dispose();
  });

  it("does nothing on wake while the context is healthy", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
    expect(current().disposed).toBe(false);
    r.dispose();
  });

  // A restored context is the branch #232 could not see: xterm clears its
  // own 3s timer (so onContextLoss never fires) and isContextLost() answers
  // false (the context really did come back), while _charAtlas still points
  // at the atlas that removeTerminalFromCache just evicted. Healthy on every
  // signal, blank on screen, and only a tab restart cured it.
  it("rebuilds the addon when the context is RESTORED rather than lost", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    first.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(first.disposed).toBe(true);
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("recovers on the raw webglcontextlost, without waiting for xterm's timer", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    first.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(first.disposed).toBe(true); // not 3s later
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("counts one dead context once, however many ways it is reported", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    // Every loss now arrives up to three times over. Counting each report
    // would spend the whole budget on the first GPU blip.
    for (let i = 0; i < CONTEXT_LOSS_MAX; i++) {
      const a = current();
      a.canvas.dispatchEvent(new Event("webglcontextlost"));
      a.canvas.dispatchEvent(new Event("webglcontextrestored"));
      a.lossCb?.();                       // xterm's own event, 3s late
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    }
    expect(Fake.instances.length).toBe(CONTEXT_LOSS_MAX + 1);
    expect(term.refresh).not.toHaveBeenCalled();  // budget intact
    r.dispose();
  });

  it("defers the attach while the pane has no geometry, and retries on wake", () => {
    const host = { offsetWidth: 0, offsetHeight: 0 };
    const term = makeTerm();
    (term as unknown as { element: unknown }).element = host;
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(0);  // display:none task/tab
    host.offsetWidth = 800;
    host.offsetHeight = 600;
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
    r.dispose();
  });

  // The wake path above shares the deferral but not the trigger: switching
  // tabs inside termic fires neither focus nor visibilitychange, so the
  // 0 -> non-zero geometry edge is the one that actually carries the reveal.
  it("takes the deferred attach on the ResizeObserver's 0 -> non-zero edge", () => {
    const host = { offsetWidth: 0, offsetHeight: 0 };
    const term = makeTerm();
    (term as unknown as { element: unknown }).element = host;
    const r = loadTerminalRenderer(term);
    expect(Fake.instances.length).toBe(0);

    const ro = RO.instances[RO.instances.length - 1];
    expect(ro.targets).toContain(host);

    // A callback that still reports zero geometry is the collapsed-split case
    // and must not attach.
    ro.cb([{ contentRect: { width: 0, height: 0 } }]);
    expect(Fake.instances.length).toBe(0);

    host.offsetWidth = 800;
    host.offsetHeight = 600;
    ro.cb([{ contentRect: { width: 800, height: 600 } }]);
    expect(Fake.instances.length).toBe(1);

    // Attached now, so a later resize must not stack a second addon on.
    ro.cb([{ contentRect: { width: 900, height: 600 } }]);
    expect(Fake.instances.length).toBe(1);

    r.dispose();
    expect(ro.targets.length).toBe(0);
  });

  it("rebuilds a healthy-looking addon on the first input after AWAY_MS away", () => {
    const seen: string[] = [];
    const term = makeTerm();
    const r = loadTerminalRenderer(term, (_tag, content) => seen.push(content));
    const first = current();
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    expect(first.disposed).toBe(true);
    expect(first.released).toBe(true);  // xterm's dispose leaves the context to GC
    expect(Fake.instances.length).toBe(2);  // same task: no reattach beat, no flash
    expect(current().disposed).toBe(false);
    expect(seen.some(c => c.startsWith("back after") && c.includes("isContextLost=false"))).toBe(true);
    r.dispose();
  });

  it("ignores the loss the released context reports on its dead canvas", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const first = current();
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    first.canvas.dispatchEvent(new Event("webglcontextlost"));
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  // Field log, laptop over Screen Sharing: every pane's rebuild threw at
  // getContext, again 100ms later, across a 30s spread, no loss event first.
  // WebGL was unavailable for a while, not for a beat.
  it("backs off a failed attach, names the error, then waits for an edge", () => {
    const seen: string[] = [];
    const term = makeTerm();
    const r = loadTerminalRenderer(term, (_tag, content) => seen.push(content));
    vi.advanceTimersByTime(AWAY_MS);
    Fake.throwOnConstruct = true;
    arrive();
    expect(Fake.instances.length).toBe(1);  // the dropped one; nothing replaced it
    expect(seen.at(-1)).toBe(`webgl attach failed (no GL), retrying in ${ATTACH_RETRY_MS[0]}ms`);
    for (const delay of ATTACH_RETRY_MS) {
      vi.advanceTimersByTime(delay);
      expect(Fake.instances.length).toBe(1);
    }
    expect(seen.at(-1)).toBe("webgl attach failed (no GL) — staying on the DOM renderer");
    vi.advanceTimersByTime(24 * 60 * 60_000);  // no timer left: a day brings nothing
    expect(Fake.instances.length).toBe(1);

    // WebGL is back; the next return from absence is the edge that finds it.
    Fake.throwOnConstruct = false;
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    expect(Fake.instances.length).toBe(2);
    expect(current().disposed).toBe(false);
    r.dispose();
  });

  // xterm's WebglRenderer appends its canvas to .xterm-screen BEFORE the
  // GL-state init that throws on a born-lost context, and registers the
  // removing disposable after it. Each failed attach therefore leaks one
  // canvas holding a live context into the screen; WebKit caps contexts
  // per process, and past the cap every later getContext (these retries
  // included) is born lost too. Field log 2026-08-23: eight panes retrying
  // wedged the window into blank-on-every-renderer until a reload.
  describe("failed-activate canvas leak", () => {
    function makeScreenTerm() {
      const screen = document.createElement("div");
      const host = {
        offsetWidth: 800,
        offsetHeight: 600,
        querySelector: (s: string) => (s === ".xterm-screen" ? screen : null),
      };
      const term = makeTerm();
      (term as unknown as { element: unknown }).element = host;
      return { term, screen };
    }
    /** A canvas the way the throwing renderer leaves one: appended, with a
     *  live webgl2 context on it. */
    function leakyCanvas(onLose: () => void) {
      const c = document.createElement("canvas");
      (c as unknown as { getContext: (t: string) => unknown }).getContext = (t: string) =>
        t === "webgl2"
          ? { getExtension: (n: string) => (n === "WEBGL_lose_context" ? { loseContext: onLose } : null) }
          : null;
      return c;
    }

    it("removes the leaked canvas and releases its context when activate throws", () => {
      const { term, screen } = makeScreenTerm();
      let released = 0;
      term.loadAddon.mockImplementation(() => {
        screen.appendChild(leakyCanvas(() => released++));
        throw new Error("value must not be falsy");
      });
      const r = loadTerminalRenderer(term);
      expect(screen.querySelectorAll("canvas").length).toBe(0);
      expect(released).toBe(1);
      r.dispose();
    });

    it("leaves pre-existing screen canvases alone", () => {
      const { term, screen } = makeScreenTerm();
      const preexisting = document.createElement("canvas");
      screen.appendChild(preexisting);
      term.loadAddon.mockImplementation(() => {
        screen.appendChild(leakyCanvas(() => {}));
        throw new Error("value must not be falsy");
      });
      const r = loadTerminalRenderer(term);
      expect(Array.from(screen.querySelectorAll("canvas"))).toEqual([preexisting]);
      r.dispose();
    });

    it("never accumulates canvases across the whole retry ladder", () => {
      const { term, screen } = makeScreenTerm();
      let released = 0;
      term.loadAddon.mockImplementation(() => {
        screen.appendChild(leakyCanvas(() => released++));
        throw new Error("value must not be falsy");
      });
      const r = loadTerminalRenderer(term);
      for (const delay of ATTACH_RETRY_MS) vi.advanceTimersByTime(delay);
      // Ladder exhausted; edges keep trying (and failing) without leaking.
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      expect(screen.querySelectorAll("canvas").length).toBe(0);
      expect(released).toBe(term.loadAddon.mock.calls.length);
      r.dispose();
    });

    it("disposes the addon whose activate threw", () => {
      const { term, screen } = makeScreenTerm();
      term.loadAddon.mockImplementation(() => {
        screen.appendChild(leakyCanvas(() => {}));
        throw new Error("value must not be falsy");
      });
      const r = loadTerminalRenderer(term);
      expect(Fake.instances.length).toBe(1);
      expect(Fake.instances[0].disposed).toBe(true);
      r.dispose();
    });
  });

  it("a retry that succeeds resets the backoff for the next outage", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    vi.advanceTimersByTime(AWAY_MS);
    Fake.throwOnConstruct = true;
    arrive();
    Fake.throwOnConstruct = false;
    vi.advanceTimersByTime(ATTACH_RETRY_MS[0]);
    expect(Fake.instances.length).toBe(2);
    vi.advanceTimersByTime(AWAY_MS);
    Fake.throwOnConstruct = true;
    arrive();
    Fake.throwOnConstruct = false;
    vi.advanceTimersByTime(ATTACH_RETRY_MS[0]);  // first step again, not the second
    expect(Fake.instances.length).toBe(3);
    r.dispose();
  });

  // The reveal TRANSITION retries; the ~60Hz stream of non-zero deliveries
  // during a window drag must not, or a down GPU gets a context request per
  // frame: the churn the backoff ladder exists to prevent.
  it("a plain resize does not retry WebGL past the backoff", () => {
    const host = { offsetWidth: 800, offsetHeight: 600 };
    const term = makeTerm();
    (term as unknown as { element: unknown }).element = host;
    Fake.throwOnConstruct = true;
    const r = loadTerminalRenderer(term);  // mount attach fails
    const ro = RO.instances[RO.instances.length - 1];
    ro.cb([{ contentRect: { width: 800, height: 600 } }]);  // first delivery: the reveal
    const attempts = Fake.attempts;
    ro.cb([{ contentRect: { width: 810, height: 600 } }]);
    ro.cb([{ contentRect: { width: 820, height: 600 } }]);
    expect(Fake.attempts).toBe(attempts);
    r.dispose();
  });

  it("an edge attach that succeeds resets the backoff clock, not just the counter", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    vi.advanceTimersByTime(AWAY_MS);
    Fake.throwOnConstruct = true;
    arrive();                                    // rebuild fails -> retry in 1s
    vi.advanceTimersByTime(ATTACH_RETRY_MS[0]);  // fails again -> 5s timer pending
    Fake.throwOnConstruct = false;
    window.dispatchEvent(new Event("focus"));    // succeeds; must also clear that timer
    const ok = current();
    Fake.throwOnConstruct = true;
    ok.contextLost = true;
    ok.lossCb?.();                               // a real loss right after
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);  // re-attach fails
    Fake.throwOnConstruct = false;
    vi.advanceTimersByTime(ATTACH_RETRY_MS[0]);  // fresh 1s retry, not the stale 5s one
    expect(current().disposed).toBe(false);
    expect(Fake.instances.length).toBe(3);
    r.dispose();
  });

  it("leaves the canvas renderer alone on return", () => {
    h.prefs.terminalRenderer = "canvas";
    const seen: string[] = [];
    const term = makeTerm();
    const r = loadTerminalRenderer(term, (_tag, content) => seen.push(content));
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    expect(seen.filter(c => c.includes("away"))).toEqual([]);
    r.dispose();
  });

  it("a reveal retries WebGL for a pane left on the DOM renderer", () => {
    const host = { offsetWidth: 800, offsetHeight: 600 };
    const term = makeTerm();
    (term as unknown as { element: unknown }).element = host;
    const r = loadTerminalRenderer(term);
    vi.advanceTimersByTime(AWAY_MS);
    Fake.throwOnConstruct = true;
    arrive();
    vi.advanceTimersByTime(ATTACH_RETRY_MS.reduce((a, b) => a + b, 0));
    expect(Fake.instances.length).toBe(1);
    Fake.throwOnConstruct = false;
    RO.instances[RO.instances.length - 1].cb([{ contentRect: { width: 800, height: 600 } }]);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("keeps the renderer kind it was loaded with across a rebuild", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    h.prefs.terminalRenderer = "dom";  // applies to the next spawn, not this one
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("leaves the addon alone on input inside AWAY_MS", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    vi.advanceTimersByTime(AWAY_MS - 1);
    arrive();
    expect(current().disposed).toBe(false);
    expect(Fake.instances.length).toBe(1);
    r.dispose();
  });

  it("counts a return-from-away rebuild against nothing: the loss budget stays intact", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    for (let i = 0; i < CONTEXT_LOSS_MAX + 2; i++) {
      vi.advanceTimersByTime(AWAY_MS);
      arrive();
    }
    const n = Fake.instances.length;
    loseContext();  // a real loss afterwards must still get WebGL back
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(n + 1);
    expect(term.refresh).not.toHaveBeenCalled();  // i.e. the give-up path never ran
    r.dispose();
  });

  // Every visited task and tab stays mounted, so a hidden pane must not pay
  // on the keystroke frame: it is marked stale and rebuilds on its reveal.
  it("defers a hidden pane's rebuild to the reveal edge", () => {
    const host = { offsetWidth: 800, offsetHeight: 600 };
    const term = makeTerm();
    (term as unknown as { element: unknown }).element = host;
    const r = loadTerminalRenderer(term);
    const first = current();
    host.offsetWidth = 0;  // task switched away: display:none
    host.offsetHeight = 0;
    vi.advanceTimersByTime(AWAY_MS);
    arrive();
    expect(first.disposed).toBe(false);
    expect(Fake.instances.length).toBe(1);
    host.offsetWidth = 800;
    host.offsetHeight = 600;
    const ro = RO.instances[RO.instances.length - 1];
    ro.cb([{ contentRect: { width: 800, height: 600 } }]);
    expect(first.disposed).toBe(true);
    expect(Fake.instances.length).toBe(2);
    // Rebuilt once: a later resize must not rebuild again.
    ro.cb([{ contentRect: { width: 900, height: 600 } }]);
    expect(Fake.instances.length).toBe(2);
    r.dispose();
  });

  it("dispose() unsubscribes from the return-from-away signal", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    const off = h.offs[h.offs.length - 1];
    expect(off).not.toHaveBeenCalled();
    r.dispose();
    expect(off).toHaveBeenCalledTimes(1);
  });

  // The canvas listeners outlive their addon's dispose (the dead canvas is
  // still reachable from the event that killed it), so their teardown has to
  // be explicit rather than left to GC. Asserted through the log sink, because
  // the recovery would refuse a disposed renderer anyway: the point is that the
  // handler does not run at all.
  it("dispose() unhooks the canvas listeners", () => {
    const seen: string[] = [];
    const term = makeTerm();
    const r = loadTerminalRenderer(term, (_tag, content) => seen.push(content));
    const first = current();
    expect(seen).toContain("webgl attached");

    r.dispose();
    seen.length = 0;
    first.canvas.dispatchEvent(new Event("webglcontextlost"));
    first.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(seen).toEqual([]);
    expect(Fake.instances.length).toBe(1);
  });

  it("dispose() unhooks the wake guard and blocks pending re-attach", () => {
    const term = makeTerm();
    const r = loadTerminalRenderer(term);
    loseContext();
    r.dispose(); // before the re-attach timer fires
    vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
    expect(Fake.instances.length).toBe(1);
    window.dispatchEvent(new Event("focus"));
    expect(Fake.instances.length).toBe(1);
  });

  // GH #314. The guard is what stops a merged atlas page inheriting a texture
  // unit's cached version and drawing the previous page's bitmap. Its failure
  // mode is silence: nothing throws, the terminal just garbles again after a
  // long session, so the WIRING is what has to be pinned here.
  describe("atlas page version guard wiring (#314)", () => {
    it("guards the atlas the addon is born with", () => {
      const term = makeTerm();
      loadTerminalRenderer(term);
      expect(h.guardSpy).toHaveBeenCalledWith(Fake.instances[0]);
    });

    it("re-guards on an atlas SWAP, which is a whole new atlas starting at 0", async () => {
      const term = makeTerm();
      loadTerminalRenderer(term);
      h.guardSpy.mockClear();
      // Zoom, theme or dpr change: xterm hands the renderer a fresh
      // TextureAtlas whose page versions restart, so an unguarded one brings
      // the bug straight back.
      Fake.instances[0].atlasCb!();
      await Promise.resolve();  // the handler defers by a microtask
      expect(h.guardSpy).toHaveBeenCalledWith(Fake.instances[0]);
    });

    it("does not guard a disposed renderer's swap", async () => {
      const term = makeTerm();
      const r = loadTerminalRenderer(term);
      const addon = Fake.instances[0];
      r.dispose();
      h.guardSpy.mockClear();
      addon.atlasCb!();
      await Promise.resolve();
      expect(h.guardSpy).not.toHaveBeenCalled();
    });

    it("guards the fresh atlas a context-loss rebuild brings with it", () => {
      const term = makeTerm();
      loadTerminalRenderer(term);
      h.guardSpy.mockClear();
      Fake.instances[0].canvas.dispatchEvent(new Event("webglcontextlost"));
      vi.advanceTimersByTime(CONTEXT_REATTACH_DELAY_MS);
      expect(Fake.instances.length).toBe(2);
      expect(h.guardSpy).toHaveBeenCalledWith(Fake.instances[1]);
    });

    it("has nothing to guard on the canvas renderer", () => {
      h.prefs.terminalRenderer = "canvas";
      const term = makeTerm();
      loadTerminalRenderer(term);
      expect(h.guardSpy).not.toHaveBeenCalled();
    });
  });
});
