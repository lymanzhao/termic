// Pasting an image into a terminal running in a DOCKER container.
//
// Only there. Outside a container the agent reads the Mac clipboard itself
// (claude shells out to `osascript -e 'the clipboard as «class PNGf»'`) and
// gets the real bytes unaided, so stepping in would replace an image with a
// file path - a downgrade. Inside one it cannot: it is a Linux process whose
// clipboard path shells out to xclip / wl-paste, with no route to the Mac's
// pasteboard, and xterm.js only ever sends text down the PTY. So termic takes
// the bytes off the paste event, writes them to a file both sides can see
// (`clipboard_image_save`, mounted read-only into every container at the same
// absolute path) and PASTES that path in the image's place.
//
// Pasted, not typed, and that distinction is the feature: measured against
// claude's own TUI, a typed path is echoed as literal text, while the same
// string delivered as a paste makes it read the file and render `[Image #1]`
// - the same attachment a native paste produces. `TerminalPane` sends it
// through `term.paste()`, which wraps it in bracketed-paste markers whenever
// the agent has that mode on.
//
// The two pure pieces live here so they can be tested without a DataTransfer
// or a PTY.

import { shellEscapePath } from "./terminalDrop";
import { toContainerPath } from "@/lib/osPath";

/** What we are willing to write to disk, matching what agents accept. */
export const PASTEABLE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * The image in a paste, or null when this is an ordinary text paste that
 * should be left alone.
 *
 * `files` first (a screenshot from the macOS pasteboard arrives as one) with
 * `items` as the fallback, because a copy from a web page can arrive as an
 * item with no entry in `files`. A paste that carries BOTH text and an image
 * (copying a chunk of a web page, say) is treated as text: the user pasting
 * an article does not mean "save this favicon to disk".
 */
export function imageFromClipboard(dt: DataTransfer | null | undefined): File | null {
  if (!dt) return null;
  if (dt.types?.includes("text/plain")) return null;
  const fromFiles = Array.from(dt.files ?? []).find(f => PASTEABLE_IMAGE_TYPES.includes(f.type));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || !PASTEABLE_IMAGE_TYPES.includes(item.type)) continue;
    const f = item.getAsFile();
    if (f) return f;
  }
  return null;
}

/**
 * The text typed in the image's place.
 *
 * Deliberately the SAME shape a dragged-in file gets (`shellEscapePath`,
 * shared with the drop target): backslash-escaped, which is what macOS
 * itself produces when a file is dragged into a terminal and what every
 * agent's path parser already unescapes. It matters more here than there,
 * because this path is always inside the app data dir, i.e. it always
 * contains the space in "Application Support" - unescaped, a shell reads it
 * as two arguments and an agent reads a truncated path. The trailing space
 * leaves the caret ready for the sentence the user was going to write about
 * the image.
 */
export function pastePathText(path: string): string {
  // Only Docker tasks paste an image as a path (TerminalPane), so this is
  // always the container's view of it: `/c/...` on a Windows host.
  return `${shellEscapePath(toContainerPath(path))} `;
}
