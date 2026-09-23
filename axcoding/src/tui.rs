//! Inline TUI for axcoding-agent's interactive mode.
//!
//! NOT alt-screen: `Viewport::Inline` pins a small live region at the
//! bottom (streaming tail + spinner + input line) while everything that
//! finishes is pushed INTO the normal scrollback with `insert_before` —
//! which is what keeps termic's pane scrollback intact.

use anyhow::Result;
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers, MouseEvent};
use ratatui::style::{Modifier, Style};
use ratatui::{TerminalOptions, Viewport};

// ── LineEditor: a pure state machine, no I/O, fully unit-tested ─────────

/// What one key press asked the caller to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditAction {
    None,
    /// Enter over a non-empty buffer. The submitted text stays readable
    /// via `text()` until `clear()`; the editor has already remembered it
    /// in history.
    Submit,
}

#[derive(Debug, Default)]
pub struct LineEditor {
    buf: String,
    /// Cursor position in CHARACTERS from the start of `buf`.
    cursor: usize,
    history: Vec<String>,
    /// Some(i) while browsing history; None means the draft below is live.
    hist: Option<usize>,
    draft: String,
}

impl LineEditor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(&self) -> &str {
        &self.buf
    }

    /// Cursor as a CELL offset (CJK chars are 2 cells) — that is what the
    /// renderer must set the terminal cursor to.
    pub fn cursor_cells(&self) -> usize {
        self.buf.chars().take(self.cursor).map(char_width).sum()
    }

    /// Prepare for the next prompt. History is retained.
    pub fn clear(&mut self) {
        self.buf.clear();
        self.cursor = 0;
        self.hist = None;
        self.draft.clear();
    }

    fn remember(&mut self, line: String) {
        if line.chars().all(char::is_whitespace) {
            return;
        }
        if self.history.last().is_some_and(|last| *last == line) {
            return;
        }
        self.history.push(line);
    }

    fn browse_history(&mut self, dir: i32) {
        if self.history.is_empty() {
            return;
        }
        let max = self.history.len() - 1; // usize
        match self.hist {
            None => {
                if dir < 0 {
                    self.draft = self.buf.clone();
                    self.hist = Some(max);
                    self.buf = self.history[max].clone();
                    self.cursor = self.buf.chars().count();
                }
            }
            Some(i) => {
                if dir < 0 {
                    if i > 0 {
                        self.hist = Some(i - 1);
                        self.buf = self.history[i - 1].clone();
                        self.cursor = self.buf.chars().count();
                    }
                } else if i < max {
                    self.hist = Some(i + 1);
                    self.buf = self.history[i + 1].clone();
                    self.cursor = self.buf.chars().count();
                } else {
                    // Stepped past the newest entry: restore the draft.
                    self.hist = None;
                    self.buf = self.draft.clone();
                    self.cursor = self.buf.chars().count();
                }
            }
        }
    }

    /// Feed one key. Char insertions at the cursor, editing keys, and
    /// history browsing; Enter over a non-empty buffer yields Submit.
    pub fn key(&mut self, code: KeyCode, ctrl: bool) -> EditAction {
        // Order matters: the ctrl navigation keys come before the generic
        // Char arm or they would be swallowed as insertions.
        if ctrl {
            match code {
                KeyCode::Char('a') => {
                    self.cursor = 0;
                    return EditAction::None;
                }
                KeyCode::Char('e') => {
                    self.cursor = self.buf.chars().count();
                    return EditAction::None;
                }
                KeyCode::Char('j') => return self.submit(),
                _ => return EditAction::None,
            }
        }
        match code {
            KeyCode::Enter => self.submit(),
            KeyCode::Char(c) => {
                // insert() takes a BYTE index; cursor counts CHARS.
                let byte = char_to_byte(&self.buf, self.cursor);
                self.buf.insert(byte, c);
                self.cursor += 1;
                self.hist = None;
                EditAction::None
            }
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    let byte = char_to_byte(&self.buf, self.cursor);
                    self.buf.remove(byte);
                }
                EditAction::None
            }
            KeyCode::Delete => {
                if self.cursor < self.buf.chars().count() {
                    let byte = char_to_byte(&self.buf, self.cursor + 1);
                    self.buf.remove(byte);
                }
                EditAction::None
            }
            KeyCode::Left => {
                self.cursor = self.cursor.saturating_sub(1);
                EditAction::None
            }
            KeyCode::Right => {
                self.cursor = (self.cursor + 1).min(self.buf.chars().count());
                EditAction::None
            }
            KeyCode::Home => {
                self.cursor = 0;
                EditAction::None
            }
            KeyCode::End => {
                self.cursor = self.buf.chars().count();
                EditAction::None
            }
            KeyCode::Up => {
                self.browse_history(-1);
                EditAction::None
            }
            KeyCode::Down => {
                self.browse_history(1);
                EditAction::None
            }
            _ => EditAction::None,
        }
    }

    fn submit(&mut self) -> EditAction {
        if self.buf.trim().is_empty() {
            return EditAction::None;
        }
        let line = self.buf.clone();
        self.remember(line);
        EditAction::Submit
    }
}

fn char_to_byte(s: &str, char_index: usize) -> usize {
    s.char_indices().nth(char_index).map(|(b, _)| b).unwrap_or(s.len())
}

/// Cell width for the chars agent output actually contains (CJK and
/// fullwidth forms are 2; everything else 1). Deliberately local instead
/// of a unicode-width direct dep — if this ever misses a glyph the cost is
/// a one-cell cursor misalignment, not a crash.
pub fn char_width(c: char) -> usize {
    let cp = c as u32;
    if (0x1100..=0x115F).contains(&cp)
        || ((0x2E80..=0xA4CF).contains(&cp) && cp != 0x303F)
        || (0xAC00..=0xD7A3).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
        || (0xFE30..=0xFE6F).contains(&cp)
        || (0xFF00..=0xFF60).contains(&cp)
        || (0xFFE0..=0xFFE6).contains(&cp)
        || (0x20000..=0x3FFFD).contains(&cp)
    {
        2
    } else {
        1
    }
}

/// Wrap text into rows of at most `cols` CELLS, breaking at char bounds
/// (CJK-safe). Words are not kept intact across rows: this wraps output
/// for the archive, not typeset prose.
pub fn wrap_cells(text: &str, cols: usize) -> Vec<String> {
    let cols = cols.max(8);
    let mut rows: Vec<String> = Vec::new();
    for raw_line in text.split('\n') {
        let mut row = String::new();
        let mut width = 0usize;
        for c in raw_line.chars() {
            let w = char_width(c);
            if width + w > cols {
                rows.push(std::mem::take(&mut row));
                width = 0;
            }
            row.push(c);
            width += w;
        }
        rows.push(row);
    }
    rows
}

// ── The inline terminal ─────────────────────────────────────────────────

const VIEWPORT_ROWS: u16 = 3;
const SPINNER: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

/// Events from the blocking reader thread.
#[derive(Debug)]
pub enum TuiEvent {
    Key(KeyEvent),
    Mouse(MouseEvent),
    Resize,
}

pub struct Tui {
    terminal: ratatui::DefaultTerminal,
    editor: LineEditor,
    spinner: usize,
    /// Text of the current streaming turn, not yet committed to scrollback.
    live: String,
    busy: bool,
}

impl Tui {
    pub fn new() -> Result<Self> {
        // try_init (not init): init PANICS on failure. The inline viewport
        // needs the terminal to answer a DSR cursor query; a dumb pty that
        // does not fails here, and the caller falls back to the plain loop.
        let terminal = ratatui::try_init_with_options(TerminalOptions {
            viewport: Viewport::Inline(VIEWPORT_ROWS),
        })?;
        Ok(Self {
            terminal,
            editor: LineEditor::new(),
            spinner: 0,
            live: String::new(),
            busy: false,
        })
    }

    pub fn editor(&mut self) -> &mut LineEditor {
        &mut self.editor
    }

    pub fn set_busy(&mut self, busy: bool) {
        self.busy = busy;
        self.draw();
    }

    /// Append a streaming delta to the live tail and repaint.
    pub fn push_live(&mut self, delta: &str) {
        self.live.push_str(delta);
        self.tick_spinner();
    }

    pub fn tick_spinner(&mut self) {
        self.spinner = (self.spinner + 1) % SPINNER.len();
        self.draw();
    }

    /// Move finished text into real scrollback, above the live region.
    pub fn commit(&mut self, text: &str) {
        let cols = self.terminal.size().map(|s| s.width as usize).unwrap_or(80).max(20);
        if !text.trim().is_empty() {
            let rows = wrap_cells(text, cols);
            let h = rows.len() as u16;
            let _ = self.terminal.insert_before(h, |buf| {
                for (i, row) in rows.iter().enumerate() {
                    buf.set_string(0, i as u16, row, Style::default());
                }
            });
        }
        self.live.clear();
        self.draw();
    }

    pub fn draw(&mut self) {
        let _ = self.terminal.draw(|frame| {
            let area = frame.area();
            let width = area.width as usize;
            let status = if self.busy {
                format!("{} working…  Ctrl-C cancels this task", SPINNER[self.spinner])
            } else {
                "type a task · /clear resets the session · Ctrl-D exits".to_string()
            };
            let live_tail: String = {
                let chars: Vec<char> = self.live.chars().collect();
                let budget = width.saturating_sub(2).max(4);
                let mut w = 0usize;
                let mut start = chars.len();
                while start > 0 {
                    let cw = char_width(chars[start - 1]);
                    if w + cw > budget {
                        break;
                    }
                    w += cw;
                    start -= 1;
                }
                if start == 0 {
                    self.live.clone()
                } else {
                    format!("…{}", chars[start..].iter().collect::<String>())
                }
            };
            let prompt = "❯ ";
            let input = format!("{prompt}{}", self.editor.text());
            let [live_a, status_a, input_a] = ratatui::layout::Layout::vertical([
                ratatui::layout::Constraint::Length(1),
                ratatui::layout::Constraint::Length(1),
                ratatui::layout::Constraint::Length(1),
            ])
            .areas(area);

            frame.render_widget(ratatui::text::Line::from(live_tail), live_a);
            frame.render_widget(
                ratatui::text::Line::from(status).style(Style::default().add_modifier(Modifier::DIM)),
                status_a,
            );
            frame.render_widget(ratatui::text::Line::from(input), input_a);
            let x = (input_a.x as usize + prompt.len() + self.editor.cursor_cells())
                .min(width.saturating_sub(1));
            frame.set_cursor_position((x as u16, input_a.y));
        });
    }

    /// Blocking read for the event thread. Recurses past non-key/mouse
    /// events only when they are truly ignorable; resize is surfaced so the
    /// next draw re-clamps.
    pub fn read_event() -> std::io::Result<TuiEvent> {
        match crossterm::event::read()? {
            Event::Key(k) => Ok(TuiEvent::Key(k)),
            Event::Mouse(m) => Ok(TuiEvent::Mouse(m)),
            Event::Resize(_, _) => Ok(TuiEvent::Resize),
            _ => Self::read_event(),
        }
    }

    /// Handle a key at the PROMPT. Returns Some(line) on submit, None when
    /// the key was consumed (or means quit — see `quit_requested`).
    pub fn prompt_key(&mut self, key: KeyEvent) -> Option<String> {
        if key.kind == crossterm::event::KeyEventKind::Release {
            return None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            if self.editor.text().is_empty() {
                return Some(String::new()); // signal: quit
            }
            self.editor.clear();
            self.draw();
            return None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('d') {
            return Some(String::new()); // signal: quit
        }
        match self.editor.key(key.code, key.modifiers.contains(KeyModifiers::CONTROL)) {
            EditAction::Submit => {
                let line = self.editor.text().to_string();
                self.editor.clear();
                self.draw();
                Some(line)
            }
            EditAction::None => {
                self.draw();
                None
            }
        }
    }
}

impl Drop for Tui {
    fn drop(&mut self) {
        ratatui::restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn type_str(e: &mut LineEditor, s: &str) {
        for c in s.chars() {
            e.key(KeyCode::Char(c), false);
        }
    }

    #[test]
    fn typing_cursor_and_backspace() {
        let mut e = LineEditor::new();
        type_str(&mut e, "你好world");
        assert_eq!(e.text(), "你好world");
        assert_eq!(e.cursor_cells(), 2 + 2 + 5);
        // Backspace removes "d".
        e.key(KeyCode::Backspace, false);
        assert_eq!(e.text(), "你好worl");
        // Left, then insert between.
        e.key(KeyCode::Left, false);
        e.key(KeyCode::Char('X'), false);
        assert_eq!(e.text(), "你好worXl");
        assert_eq!(e.cursor_cells(), 2 + 2 + 3 + 1);
    }

    #[test]
    fn submit_requires_nonempty_and_resets() {
        let mut e = LineEditor::new();
        assert_eq!(e.key(KeyCode::Enter, false), EditAction::None);
        type_str(&mut e, "do it");
        assert_eq!(e.key(KeyCode::Enter, false), EditAction::Submit);
        assert_eq!(e.text(), "do it", "caller reads then clears");
        e.clear();
        assert_eq!(e.text(), "");
        // History: Up recalls it.
        e.key(KeyCode::Up, false);
        assert_eq!(e.text(), "do it");
        // Down past newest restores the (empty) draft.
        e.key(KeyCode::Down, false);
        assert_eq!(e.text(), "");
    }

    #[test]
    fn history_browsing_and_dedup() {
        let mut e = LineEditor::new();
        type_str(&mut e, "one");
        e.key(KeyCode::Enter, false);
        e.clear();
        type_str(&mut e, "two");
        e.key(KeyCode::Enter, false);
        e.clear();
        // Up: "two", Up: "one", Up again: stays at "one".
        e.key(KeyCode::Up, false);
        assert_eq!(e.text(), "two");
        e.key(KeyCode::Up, false);
        assert_eq!(e.text(), "one");
        e.key(KeyCode::Up, false);
        assert_eq!(e.text(), "one");
        // Down: "two", Down: draft restored.
        e.key(KeyCode::Down, false);
        assert_eq!(e.text(), "two");
        e.key(KeyCode::Down, false);
        assert_eq!(e.text(), "");
        // Enter submits are remembered without duplicates.
        type_str(&mut e, "two");
        e.key(KeyCode::Enter, false);
        e.clear();
        e.key(KeyCode::Up, false);
        e.key(KeyCode::Up, false);
        assert_eq!(e.text(), "one", "duplicate 'two' must not be remembered twice");
    }

    #[test]
    fn wrap_cells_is_cjk_safe() {
        // cols clamps up to a floor of 8 (degenerate tiny viewports), so
        // exercise the real budget: 你好 = 4 cells, "你好abcd" = 8 exactly.
        assert_eq!(wrap_cells("你好ab", 4), vec!["你好ab"], "floor-of-8 clamp");
        assert_eq!(wrap_cells("你好abcdef", 8), vec!["你好abcd", "ef"]);
        assert_eq!(wrap_cells("abc", 10), vec!["abc"]);
        assert_eq!(wrap_cells("a\nb", 10), vec!["a", "b"]);
        assert_eq!(wrap_cells("", 10), vec![""]);
    }
}
