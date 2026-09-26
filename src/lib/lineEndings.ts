// CRLF files in the editor.
//
// CodeMirror normalizes every line break to `\n`, so a file checked out with
// CRLF (the Git for Windows default, and any `.gitattributes eol=crlf` file on
// every OS) came back from a save as LF: a whole-file diff for a one-character
// edit. And the buffer never equalled the file on disk, so every disk poll saw
// a "change" that was not there.
//
// Only a file whose EVERY line break is `\r\n` keeps them: with the separator
// set, CodeMirror splits lines on it alone, so a mixed file would render its
// bare `\n` breaks as one long line. Mixed files keep today's behaviour.

/** True when `text` has line breaks and all of them are CRLF. */
export function isPureCrlf(text: string): boolean {
  const lf = text.split("\n").length - 1;
  if (lf === 0) return false;
  const crlf = text.split("\r\n").length - 1;
  return crlf === lf;
}
