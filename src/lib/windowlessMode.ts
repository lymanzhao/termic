// Windowless mode: the webview half.
//
// Rust owns the state machine (see the windowless block in
// src-tauri/src/lib.rs) and pushes `termic://windowless` on every edge:
// closing the window, a `--headless` CLI launch, the menu-bar item, a
// dock-icon click, or `termic open`.
//
// Why the webview has to do anything at all: hiding the NSWindow does NOT
// pause xterm's renderers. They key on ZERO GEOMETRY, which `display: none`
// produces and a hidden window does not - a windowless window still reports
// full layout (measured: 1368x1190 with 7 live canvases still drawing). So the
// flag drives MainArea to collapse every mounted pane, which is what actually
// stops the WebGL draws. docs/performance.md bear trap 2, at window scope.
//
// Deliberately NOT keyed on `document.visibilityState`: that also goes hidden
// when the window is merely occluded or on another Space, and collapsing panes
// on every Space switch would churn layout (and xterm viewport state) for a
// window the user can still bring forward with one gesture. Only real
// windowless transitions count.

import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";

export async function initWindowlessMode(): Promise<void> {
  // A real edge always wins over the boot query below: the invoke is a round
  // trip and its reply can land after an edge that arrived mid-boot, which
  // would stamp the stale pre-edge value back over it.
  let sawEdge = false;
  await listen<boolean>("termic://windowless", e => {
    sawEdge = true;
    const bg = Boolean(e.payload);
    // Leaving windowless mode also retires any close prompt still on screen:
    // being handed a "Close Termic?" dialog you asked for minutes ago, one of
    // whose buttons kills every agent, is a trap.
    if (!bg) useUI.getState().setClosePromptOpen(false);
    useUI.getState().setWindowless(bg);
  });
  // Rust asks only when `close_action` is unset/"ask"; CloseDialog owns the
  // three outcomes (menu bar / quit / dismiss-cancels-the-close). Reset on
  // every request so a tick left over from a superseded prompt cannot ride
  // into a decision the user thinks is fresh.
  // Scoped to THIS window: Rust `emit_to`s the window whose close button was
  // clicked, and a global `listen` (target Any) would open the prompt in
  // every profile's window at once (see cliRpc.ts initCliRpc).
  await getCurrentWebviewWindow().listen("termic://close-requested", () => {
    // ACK FIRST. Rust falls back to going windowless if no ack arrives, which
    // is what stops a missing listener from turning the red button into a
    // silent no-op. Acking before showing the prompt means a dismissal is
    // respected (Rust only overrides when nobody answered at all).
    void invoke("close_prompt_ack").catch(() => {});
    useUI.getState().requestClosePrompt();
  });
  // Clicking a task in the tray's attention dropdown (lib/trayAttention.ts)
  // brings the window forward on the Rust side, then tells us which task to
  // switch to. setActiveTask already expands the right project/group.
  //
  // The dropdown is a snapshot: it can be up to the 150ms debounce window
  // (or however long the user held the menu open) stale, so the task may
  // have been archived or deleted between the click and this event. Guard
  // rather than blindly setActiveTask-ing a dead id — the window still
  // comes forward, just with nothing new selected.
  await listen<string>("termic://focus-task", e => {
    const live = useApp.getState().tasks.some(t => t.id === e.payload && !t.archived);
    if (live) useApp.getState().setActiveTask(e.payload);
  });
  // Only NOW is it safe to learn the state: a `--headless` launch goes windowless
  // itself in Rust's setup(), well before this module ran, and that edge was
  // emitted with nobody listening (Tauri has no event replay). Ask, so the
  // flag is right however the app booted.
  try {
    const atBoot = await invoke<boolean>("window_is_windowless");
    if (!sawEdge) useUI.getState().setWindowless(atBoot);
  } catch {
    // Older/newer backend without the command: leave the flag alone rather
    // than guessing, and let the next real edge correct it.
  }
}
