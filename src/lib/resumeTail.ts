// What a failed resume printed, made readable for a toast (GH #311).
//
// TerminalPane keeps the raw bytes a resume attempt writes in its first
// RESUME_FAILURE_MS, because xterm's buffer can lag the exit event and Rust
// drains every byte before emitting it. This turns that tail into one line.

/** The last few non-empty lines a failed resume printed, joined and trimmed
 *  for a toast (GH #311): claude's "No conversation found", or its "running
 *  as a background session ... claude attach", which is the one way out the
 *  user needs. Control and escape sequences are stripped: the raw stream
 *  carries the agent's own cursor and colour codes. */
export function lastAgentLine(raw: string, maxLen = 220): string {
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    // Any other two-byte escape: ESC 7 / ESC 8 (save and restore the cursor),
    // ESC = / ESC >, charset selection and the like.
    .replace(/\x1b[^[\]]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-3);
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > maxLen ? joined.slice(0, maxLen - 1) + "…" : joined;
}
