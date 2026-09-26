// Host paths as the TERMINAL needs them: how a dropped or pasted file's path
// is typed into a shell or an agent prompt, per platform and per cage.
import { IS_WINDOWS } from "./platform";

/** Where a host path appears inside a Docker task's Linux container.
 *  Mirrors `docker::in_container` (src-tauri/src/docker.rs), which mounts
 *  every host path at this location: the identity off Windows, and
 *  `C:\Users\u\x` -> `/c/Users/u/x` on Windows. `windows` is injectable
 *  so both rules are tested on every host. */
export function toContainerPath(host: string, windows: boolean = IS_WINDOWS): string {
  if (!windows) return host;
  const h = host.startsWith("\\\\?\\") ? host.slice(4) : host;
  const m = /^([A-Za-z]):(.*)$/.exec(h);
  if (!m) return h.replace(/\\/g, "/");
  const rest = m[2].replace(/\\/g, "/").replace(/^\/+/, "");
  const drive = m[1].toLowerCase();
  return rest ? `/${drive}/${rest}` : `/${drive}`;
}

/** Backslash-escape every character outside a conservative safe set, the way
 *  macOS Terminal / iTerm2 insert a dragged file's path. POSIX shells and
 *  every agent CLI's path parser unescape it. */
export function shellEscapePath(p: string): string {
  return p.replace(/[^A-Za-z0-9._/-]/g, "\\$&");
}

/** A native Windows path typed into cmd, PowerShell or a Windows agent:
 *  backslash-escaping would corrupt it (the separators ARE backslashes), so
 *  quote it when it needs quoting and leave it alone otherwise. */
export function quoteWindowsPath(p: string): string {
  return /[\s"&|<>^%()'`;,]/.test(p) ? `"${p.replace(/"/g, '""')}"` : p;
}

/** The text to type for `host` into a terminal of a task that is (or is
 *  not) running in Docker. */
export function terminalPathText(host: string, docker: boolean, windows: boolean = IS_WINDOWS): string {
  if (docker) return shellEscapePath(toContainerPath(host, windows));
  return windows ? quoteWindowsPath(host) : shellEscapePath(host);
}

/** `abs` relative to `root`, with `/` separators (the app's task-relative
 *  form), or null when `abs` is not strictly inside `root`. A segment
 *  boundary, not a raw prefix: `/repo-old/a.ts` is not under `/repo`. On
 *  Windows both separators count and the comparison ignores case, the way
 *  the filesystem does. */
export function relUnder(abs: string, root: string, windows: boolean = IS_WINDOWS): string | null {
  if (!root) return null;
  const norm = (p: string) => (windows ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "");
  const a = norm(abs);
  const r = norm(root);
  const head = windows ? a.slice(0, r.length).toLowerCase() : a.slice(0, r.length);
  const want = windows ? r.toLowerCase() : r;
  if (a.length <= r.length + 1 || head !== want || a[r.length] !== "/") return null;
  return a.slice(r.length + 1);
}

/** The last path segment, splitting on `/`, and on `\` too on Windows. */
export function baseName(p: string, windows: boolean = IS_WINDOWS): string {
  const parts = p.split(windows ? /[\\/]/ : "/");
  return parts[parts.length - 1] || p;
}

/** `name` inside directory `dir`, in the platform's own spelling: a
 *  backslash on Windows, where a folder picked in the dialog or a canonical
 *  path from Rust already uses them. Trailing separators on `dir` are
 *  dropped, so a root (`/`, `C:\\`) joins to `/x`, `C:\\x`. */
export function joinPath(dir: string, name: string, windows: boolean = IS_WINDOWS): string {
  const sep = windows ? "\\" : "/";
  return `${dir.replace(windows ? /[\\/]+$/ : /\/+$/, "")}${sep}${name}`;
}

/** A `file://` URI for an absolute path, percent-encoding everything outside
 *  the unreserved set, the same bytes as the Rust side (lsp_path_to_uri).
 *  Windows paths take the standard form `file:///C:/Users/u/x`: a leading
 *  slash, forward slashes, and the drive colon left as is. */
export function pathToFileUri(abs: string, windows: boolean = IS_WINDOWS): string {
  let p = abs;
  let drive = "";
  if (windows) {
    p = p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
    const m = /^([A-Za-z]):(.*)$/.exec(p);
    if (m) { drive = `/${m[1]}:`; p = m[2]; }
  }
  return "file://" + drive + [...new TextEncoder().encode(p)]
    .map(b =>
      (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
      b === 0x2f || b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e
        ? String.fromCharCode(b)
        : "%" + b.toString(16).toUpperCase().padStart(2, "0"))
    .join("");
}

/** Inverse of `pathToFileUri`: a native path (backslashes on Windows). */
export function fileUriToPath(uri: string, windows: boolean = IS_WINDOWS): string | null {
  if (!uri.startsWith("file://")) return null;
  let p: string;
  try { p = decodeURIComponent(uri.slice("file://".length)); } catch { return null; }
  if (windows && /^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, "\\");
  return p;
}
