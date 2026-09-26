/**
 * Remove Claude Code's leading status glyphs from a live terminal title.
 *
 * Claude prefixes idle titles with ✳ and working titles with one or more
 * Braille spinner glyphs. We only hide those prefixes when Termic is already
 * showing its own working indicator, so users with the indicator disabled
 * still retain Claude's built-in state signal.
 */
export function formatTerminalTitle(
  title: string,
  cli: string,
  hideClaudeStatusGlyph: boolean,
): string {
  if (cli !== "claude" || !hideClaudeStatusGlyph) {
    return title;
  }

  return title
    .replace(/^\s*✳\s*/, "")
    .replace(/^\s*[\u2800-\u28ff](?:\s+[\u2800-\u28ff])*\s*/, "");
}

/**
 * True for the title Windows' console host announces on its own: ConPTY
 * sets the window title to the spawned program's path
 * (`\e]0;C:\Program Files\nodejs\node.exe\a`, measured on the Windows CI
 * runner by `src-tauri/examples/conpty_osc_probe.rs`) before the program has
 * run a line. It is not the program's title, so it must not become a tab's
 * live label or count as the agent having started. No title a unix program
 * sets looks like this.
 */
export function isConsoleHostTitle(title: string): boolean {
  // An elevated console prefixes it with "Administrator: " (measured on the
  // Windows CI runner, which runs elevated).
  return /^(Administrator: )?[A-Za-z]:\\[^\n]*\.(exe|com|cmd|bat)$/i.test(title.trim());
}
