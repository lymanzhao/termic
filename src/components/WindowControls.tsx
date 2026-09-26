// Minimize / maximize / close for the Windows window, which has no native
// title bar: the app's own top bar (UnifiedBar) is the title bar there, as it
// is on macOS, where the traffic lights are drawn by the system instead.
//
// Windows' own look: 46px-wide buttons the full height of the bar, the
// system's caption glyphs (Segoe Fluent Icons on Windows 11, Segoe MDL2
// Assets on 10, the same code points), a neutral hover and the system red
// on Close. Renders nothing off Windows.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Caption glyphs, as Windows draws them. */
const GLYPH = {
  minimize: "\uE921",
  maximize: "\uE922",
  restore: "\uE923",
  close: "\uE8BB",
} as const;

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_WINDOWS) return;
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => {
      win.isMaximized().then(m => { if (alive) setMaximized(m); }).catch(() => {});
    };
    sync();
    // A double click on the bar, Win+Up, or a snap all change it without a
    // click here, and they all resize the window.
    let unlisten: (() => void) | undefined;
    win.onResized(sync).then(u => { if (alive) unlisten = u; else u(); }).catch(() => {});
    return () => { alive = false; unlisten?.(); };
  }, []);

  if (!IS_WINDOWS) return null;
  const win = getCurrentWindow();

  const button = (
    kind: "minimize" | "maximize" | "close",
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      data-no-drag
      data-testid={`window-${kind}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-[46px] items-center justify-center text-[10px] text-[var(--color-fg-dim)] outline-none transition-colors",
        kind === "close"
          ? "hover:bg-[var(--color-caption-close)] hover:text-[var(--color-caption-close-fg)] focus-visible:bg-[var(--color-caption-close)] focus-visible:text-[var(--color-caption-close-fg)]"
          : "hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus-visible:bg-[var(--color-bg-3)]",
      )}
      style={{ fontFamily: '"Segoe Fluent Icons", "Segoe MDL2 Assets"' }}
    >
      {kind === "minimize" ? GLYPH.minimize : kind === "close" ? GLYPH.close : maximized ? GLYPH.restore : GLYPH.maximize}
    </button>
  );

  return (
    <div
      data-testid="window-controls"
      data-maximized={maximized ? "true" : "false"}
      className="flex h-full shrink-0 items-stretch self-stretch"
    >
      {button("minimize", "Minimize", () => { win.minimize().catch(() => {}); })}
      {button("maximize", maximized ? "Restore" : "Maximize", () => { win.toggleMaximize().catch(() => {}); })}
      {button("close", "Close", () => { win.close().catch(() => {}); })}
    </div>
  );
}
