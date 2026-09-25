//! Native OSC 777 emission for termic's pane. The binary is its own hook:
//! termic's `TerminalPane` OSC 777 handler is agent-agnostic and trusts on
//! the title field alone, so writing the sequence to stdout gets full
//! work-state treatment with no installer and no per-agent tables on the
//! other side.
//!
//! Contract (KEEP IN SYNC, both sides pin the literals in their own tests -
//! a string cannot be shared across the language boundary):
//! `src/lib/agentHooks.ts` (HOOK_OSC_TITLE / HOOK_OSC_WORKING_BODY /
//! HOOK_OSC_DONE_BODY / HOOK_OSC_READY_BODY / HOOK_OSC_SESSION_PREFIX /
//! hookOscSequence) and `src-tauri/src/agent_hooks.rs` (script_body).
//! Bodies are routed on EXACT match there; an unrecognised trusted body
//! falls through to a needs-you badge, so never emit a new body without
//! teaching termic to route it first.
//!
//! The payload moves no cursor, so a write is safe inside ratatui's inline
//! viewport; it is one `write_all` so it can never be split across a draw.

pub const TITLE: &str = "termic";
pub const WORKING: &str = "agent working";
pub const DONE: &str = "agent done";
pub const READY: &str = "agent ready for input";
pub const SESSION_PREFIX: &str = "session ";

pub fn session_body(id: &str) -> String {
    format!("{SESSION_PREFIX}{id}")
}

/// `\x1b]777;notify;termic;<body>\x07` - the exact bytes `hookOscSequence`
/// produces on the other side.
pub fn sequence(body: &str) -> Vec<u8> {
    format!("\x1b]777;notify;{TITLE};{body}\x07").into_bytes()
}

/// Write to stdout, but only when stdout is a terminal: pipes and captured
/// output stay byte-clean.
pub fn emit(body: &str) {
    use std::io::IsTerminal;
    if std::io::stdout().is_terminal() {
        let _ = emit_to(&mut std::io::stdout(), body);
    }
}

pub fn emit_to(w: &mut impl std::io::Write, body: &str) -> std::io::Result<()> {
    w.write_all(&sequence(body))?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_match_the_hook_contract() {
        // Mirrors of agentHooks.ts; the TS half is pinned in agentHooks.test.ts.
        assert_eq!(TITLE, "termic");
        assert_eq!(WORKING, "agent working");
        assert_eq!(DONE, "agent done");
        assert_eq!(READY, "agent ready for input");
        assert_eq!(SESSION_PREFIX, "session ");
    }

    #[test]
    fn sequence_shape_is_esc_777_notify_termic_body_bel() {
        assert_eq!(sequence(WORKING), b"\x1b]777;notify;termic;agent working\x07");
        assert_eq!(sequence(DONE), b"\x1b]777;notify;termic;agent done\x07");
        assert_eq!(sequence(READY), b"\x1b]777;notify;termic;agent ready for input\x07");
        assert_eq!(
            sequence(&session_body("11111111-1111-4111-8111-111111111111")),
            b"\x1b]777;notify;termic;session 11111111-1111-4111-8111-111111111111\x07"
        );
    }

    #[test]
    fn emit_to_writes_exact_bytes_to_a_vec_sink() {
        let mut sink: Vec<u8> = Vec::new();
        emit_to(&mut sink, DONE).unwrap();
        assert_eq!(sink, sequence(DONE));
    }
}
