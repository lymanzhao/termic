// Minimal shadcn-style Dialog over Radix. Sized for our dark theme.

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type React from "react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { dragRegion, appRegionStyle } from "@/lib/platform";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  description?: string;
  className?: string;
  hideClose?: boolean;
  /** Class name for the dim backdrop. Override for stacked dialogs
   *  (a Confirm opening on top of another AppDialog) — pass
   *  `"bg-transparent"` so two backdrops don't compose into double-
   *  dimming + flicker. */
  overlayClassName?: string;
  /** Override Radix's default focus-restoration on close. Pass
   *  `(e) => e.preventDefault()` when the caller handles focus itself
   *  (e.g. ConfirmDialog, where closeTab moves focus to the next tab). */
  onCloseAutoFocus?: (e: Event) => void;
  /** Override Radix's default focus-on-open (which rings the first
   *  focusable control). Pass `(e) => e.preventDefault()` for dialogs
   *  where auto-focusing the first control looks wrong (e.g. a tab strip). */
  onOpenAutoFocus?: (e: Event) => void;
  /** Renders as a non-scrolling bar pinned to the bottom of the dialog
   *  (border-top separator), always visible regardless of how tall
   *  `children` gets. Opt-in: without it, Content scrolls as one block
   *  (the default below) and the caller's own trailing action row scrolls
   *  away with everything else on a tall form. Pass the action row (Cancel/
   *  Create, error text, etc.) here for a long dialog — see NewTaskDialog. */
  stickyFooter?: ReactNode;
  /** Controls that ride the TITLE line, right-aligned, instead of taking a
   *  row of their own in `children`. For mode switches - "start from an issue
   *  instead", "import a worktree instead" - which are chrome, not fields: the
   *  title line is mostly empty, and a 12.5px link was costing a full `gap-4`
   *  form row on every open of a dialog that mostly has nothing to do with it.
   *  The row wraps rather than truncating, so a long title plus two switches
   *  degrades to what it cost before instead of clipping.
   *
   *  Anything interactive in here is inside the window drag region, so it must
   *  opt out the way Dialog.Close below does. `dialogTitleAction` (this file)
   *  is the class + attributes to spread on such a control. */
  titleAction?: ReactNode;
  children: ReactNode;
}

/** Spread onto a control passed as `titleAction`: the drag-region opt-out it
 *  needs to be clickable at all, plus the link styling the switches share. */
export const dialogTitleAction = {
  "data-tauri-drag-region": "false",
  style: appRegionStyle("no-drag") as React.CSSProperties,
  className:
    "inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-[var(--color-fg-dim)] hover:text-[var(--color-accent)]",
} as const;

export function AppDialog({ open, onOpenChange, title, description, className, hideClose, overlayClassName, onCloseAutoFocus, onOpenAutoFocus, stickyFooter, titleAction, children }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* No `backdrop-blur` — the 2px blur made the underlying logo +
            text behind the dialog look fuzzy/out of focus, which read as
            an anti-aliasing bug. Plain dim is cleaner and matches Conductor's
            backdrop style. */}
        {/* Mark the dim backdrop as a Tauri drag region so users can
            move the window even while a dialog is open (welcome wizard
            is the worst offender — it covers the whole frame for new
            users who'd otherwise be stuck). The Content below has
            its own `pointer-events-auto` so inputs/buttons keep
            working. Tauri picks up mousedown+move as drag; a pure
            click (no movement) still bubbles to Radix for outside-
            click-to-dismiss. */}
        <Dialog.Overlay
          {...dragRegion()}
          className={cn(
            "fixed inset-0 z-40 data-[state=open]:animate-in data-[state=open]:fade-in-0",
            overlayClassName ?? "bg-black/65",
          )}
        />
        {/* Vertical centering is safe ONLY because Dialog.Content below sets
            an explicit `translate3d(0,0,0)` — that promotes it to its own
            compositing layer, which WebKit pixel-snaps. Without the layer
            hint, `items-center` produces a fractional Y offset whenever
            `(viewport_height − dialog_height) / 2` is .5px, and every glyph
            inside the dialog renders blurry. DO NOT remove the translate3d. */}
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
          <Dialog.Content
            onCloseAutoFocus={onCloseAutoFocus}
            onOpenAutoFocus={onOpenAutoFocus}
            className={cn(
              // Single-column flex, NOT `grid` (shadcn's default): WebKit on
              // fractionally scaled displays (e.g. "More Space" on macOS 26)
              // sizes grid tracks inside an overflow container against the
              // padding box, laying children ~2×padding too wide and clipping
              // the right edge (Browse/Add buttons unreachable, issues #120,
              // #126). Flex-column stretch resolves widths on the plain block
              // path, which doesn't have the rounding bug.
              "relative flex flex-col w-full max-w-md pointer-events-auto",
              "rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-1)] shadow-2xl",
              // Always cap at viewport height. With no stickyFooter, Content
              // scrolls itself as one block (the pre-existing behavior —
              // gap-2 + p-5 live here so that path is pixel-identical).
              // With a stickyFooter, the padding/gap/scroll move onto the
              // inner wrapper below instead so the footer can sit outside
              // the scroll region.
              "max-h-[calc(100vh-2rem)] overflow-x-hidden",
              stickyFooter ? "gap-0 p-0" : "gap-2 p-5 overflow-y-auto",
              // Promote to its own compositing layer with an explicit
              // integer-offset transform — WebKit snaps a layer with
              // `translate3d(0,0,0)` to whole pixels, which keeps text
              // crisp even if the parent's flex math ever drifts.
              "[transform:translate3d(0,0,0)]",
              className,
            )}
          >
            <div className={cn(stickyFooter && "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-5")}>
              {(title || description || titleAction) && (
                // Title strip = drag region. Same affordance as a macOS
                // window title bar - the user grabs the chrome at the top
                // of the dialog and drags the window. Close button below
                // is positioned absolute and opts out via its own
                // data-tauri-drag-region="false".
                <div
                  {...dragRegion()}
                  // Always spaced from the body. The container's `gap-2` is
                  // 8px, which is a paragraph gap, not a header gap: with a
                  // description the title, the description and the first field
                  // label ran together as three lines of the same block. The
                  // strip owns its own separation rather than each caller
                  // remembering to add it.
                  className="mb-3 cursor-grab active:cursor-grabbing select-none"
                >
                  {/* pr-6 clears the absolutely-positioned close button. It
                      sits on the ROW, not the title, so title actions clear it
                      too. gap-y keeps the wrapped case from touching. */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pr-6">
                    {title && <Dialog.Title className="min-w-0 text-base font-medium break-words">{title}</Dialog.Title>}
                    {titleAction && (
                      <div className="flex shrink-0 items-center gap-3">{titleAction}</div>
                    )}
                  </div>
                  {description && <Dialog.Description className="text-xs text-[var(--color-fg-dim)] -mt-1">{description}</Dialog.Description>}
                </div>
              )}
              {children}
            </div>
            {stickyFooter && (
              <div className="shrink-0 border-t border-[var(--color-border-soft)] px-5 py-4">
                {stickyFooter}
              </div>
            )}
            {!hideClose && (
              <Dialog.Close
                data-tauri-drag-region="false"
                style={appRegionStyle("no-drag")}
                className="absolute right-3 top-3 rounded-md p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)]"
              >
                <X className="h-4 w-4" />
              </Dialog.Close>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
