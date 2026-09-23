//! The Rhai REPL the root model drives through the `eval` tool.
//!
//! This is the RLM core: the long context is a *variable in an environment*,
//! not a prompt. The script addresses it by offset, fans sub-model calls out
//! over slices it chose, and unwinds the whole script with `submit()`.
//!
//! Everything a script can touch is registered below; there is no I/O, no
//! filesystem, and the budgets make runaway scripts boring instead of fatal.

use anyhow::Result;
use rhai::{Dynamic, EvalAltResult, Engine, Position};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::ctx::ContextStore;
use crate::{ChatMessage, Llm};

const SUBMIT_PREFIX: &str = "SUBMIT::";
/// Hard ceiling on strings a script may hold from one slice call.
const MAX_SLICE_CHARS: usize = 100_000;
const NOTES_CAP: usize = 8_000;
const PRINT_BUF_CAP: usize = 1 << 20;

#[derive(Debug, Clone, Copy)]
pub struct ReplCfg {
    pub max_evals: u32,
    pub max_sub_calls: u32,
    /// Per `llm_ctx` call: how many context chars the model may spend.
    pub max_sub_input_chars: usize,
    pub max_output_chars: usize,
}

impl Default for ReplCfg {
    fn default() -> Self {
        Self {
            max_evals: 64,
            max_sub_calls: 32,
            max_sub_input_chars: 24_000,
            max_output_chars: 4_000,
        }
    }
}

#[derive(Debug, Default)]
struct ReplState {
    evals: u32,
    sub_calls: u32,
    notes: String,
    submitted: Option<String>,
}

/// Human-visible usage counters, surfaced in the run trace.
#[derive(Debug, Clone, Copy, Default)]
pub struct ReplUsage {
    pub evals: u32,
    pub sub_calls: u32,
    /// Context characters the scripts actually looked at (slices + hit lines).
    pub chars_touched: u64,
}

pub struct Repl<L: Llm> {
    ctx: Arc<ContextStore>,
    state: Arc<Mutex<ReplState>>,
    print_buf: Arc<Mutex<String>>,
    touched: Arc<AtomicU64>,
    engine: Engine,
    cfg: ReplCfg,
    _marker: std::marker::PhantomData<L>,
}

impl<L: Llm> Repl<L> {
    pub fn new(
        ctx: Arc<ContextStore>,
        llm: Arc<L>,
        sub_system: String,
        cfg: ReplCfg,
    ) -> Self {
        let state: Arc<Mutex<ReplState>> = Arc::default();
        let print_buf: Arc<Mutex<String>> = Arc::default();
        let touched = Arc::new(AtomicU64::new(0));

        let mut engine = Engine::new();
        engine.set_max_expr_depths(64, 64);
        engine.set_max_operations(20_000_000);

        {
            let buf = Arc::clone(&print_buf);
            engine.on_print(move |s: &str| {
                let mut b = buf.lock().unwrap();
                if b.len() < PRINT_BUF_CAP {
                    b.push_str(s);
                    b.push('\n');
                }
            });
        }

        engine.register_fn("ctx_len", {
            let ctx = Arc::clone(&ctx);
            move || -> i64 { ctx.len_chars() as i64 }
        });

        engine.register_fn("ctx_slice", {
            let ctx = Arc::clone(&ctx);
            let touched = Arc::clone(&touched);
            move |start: i64, len: i64| -> String {
                let total = ctx.len_chars() as i64;
                let start = start.clamp(0, total) as usize;
                let len = len.clamp(0, MAX_SLICE_CHARS as i64) as usize;
                let out = ctx.slice(start, len);
                touched.fetch_add(out.len() as u64, Ordering::Relaxed);
                out
            }
        });

        engine.register_fn("ctx_find", {
            let ctx = Arc::clone(&ctx);
            let touched = Arc::clone(&touched);
            move |pattern: &str, after: i64, max: i64| -> String {
                let total = ctx.len_chars() as i64;
                let after = after.clamp(0, total) as usize;
                let max = max.clamp(0, 50) as usize;
                match ctx.find(pattern, after, max) {
                    Err(e) => format!("ERROR: {e}"),
                    Ok(hits) if hits.is_empty() => "(no matches)".to_string(),
                    Ok(hits) => {
                        let mut out = String::new();
                        for h in &hits {
                            touched.fetch_add(h.line.len() as u64, Ordering::Relaxed);
                            out.push_str(&format!("{}: {}\n", h.start, h.line));
                        }
                        out.push_str(&format!(
                            "(use ctx_slice({}, n) to read around a hit; resume search after the last offset)",
                            hits[hits.len() - 1].start
                        ));
                        out
                    }
                }
            }
        });

        engine.register_fn("note", {
            let state = Arc::clone(&state);
            move |s: &str| {
                let mut st = state.lock().unwrap();
                if st.notes.chars().count() < NOTES_CAP {
                    st.notes.push_str(s.trim_end());
                    st.notes.push('\n');
                }
            }
        });

        engine.register_fn("notes", {
            let state = Arc::clone(&state);
            move || -> String {
                let st = state.lock().unwrap();
                if st.notes.is_empty() { "(no notes yet)".to_string() } else { st.notes.clone() }
            }
        });

        engine.register_fn("llm", {
            let llm = Arc::clone(&llm);
            let state = Arc::clone(&state);
            let sys = sub_system.clone();
            move |prompt: &str| -> String {
                Self::llm_impl(&llm, &sys, &state, prompt, None, cfg)
            }
        });

        engine.register_fn("llm_ctx", {
            let llm = Arc::clone(&llm);
            let state = Arc::clone(&state);
            let sys = sub_system.clone();
            move |prompt: &str, context: &str| -> String {
                Self::llm_impl(&llm, &sys, &state, prompt, Some(context), cfg)
            }
        });

        engine.register_fn("submit", |answer: &str| -> Result<Dynamic, Box<EvalAltResult>> {
            if answer.trim().is_empty() {
                return Ok(Dynamic::from("ERROR: submit() needs a non-empty answer"));
            }
            Err(Box::new(EvalAltResult::ErrorRuntime(
                Dynamic::from(format!("{SUBMIT_PREFIX}{answer}")),
                Position::NONE,
            )))
        });

        Self { ctx, state, print_buf, touched, engine, cfg, _marker: std::marker::PhantomData }
    }

    /// Run one script. Always returns text the root model can read:
    /// captured prints, the last expression's value, or an error string.
    /// A `submit()` unwinds the script and records the answer.
    pub fn eval(&mut self, code: &str) -> String {
        {
            let mut st = self.state.lock().unwrap();
            st.evals += 1;
            if st.evals > self.cfg.max_evals {
                return "ERROR: eval budget exhausted. Decide from what you have and call submit(answer).".to_string();
            }
        }
        self.print_buf.lock().unwrap().clear();

        match self.engine.eval::<Dynamic>(code) {
            Ok(v) => {
                let prints = self.print_buf.lock().unwrap().clone();
                let mut out = String::new();
                if !prints.trim().is_empty() {
                    out.push_str(prints.trim_end());
                    out.push('\n');
                }
                let value = fmt_dynamic(v);
                if !value.is_empty() {
                    out.push_str("=> ");
                    out.push_str(&value);
                }
                if out.is_empty() {
                    "(no output; print() what you need to see)".to_string()
                } else {
                    crate::clip(&out, self.cfg.max_output_chars)
                }
            }
            Err(e) => {
                if let Some(answer) = extract_submit(&e) {
                    self.state.lock().unwrap().submitted = Some(answer);
                    "SUBMITTED".to_string()
                } else {
                    crate::clip(&format!("ERROR: {e}"), self.cfg.max_output_chars)
                }
            }
        }
    }

    pub fn submitted(&self) -> Option<String> {
        self.state.lock().unwrap().submitted.clone()
    }

    pub fn usage(&self) -> ReplUsage {
        let st = self.state.lock().unwrap();
        ReplUsage {
            evals: st.evals,
            sub_calls: st.sub_calls,
            chars_touched: self.touched.load(Ordering::Relaxed),
        }
    }

    pub fn notes(&self) -> String {
        self.state.lock().unwrap().notes.clone()
    }

    pub fn ctx_len_chars(&self) -> usize {
        self.ctx.len_chars()
    }

    fn llm_impl(
        llm: &Arc<L>,
        sub_system: &str,
        state: &Mutex<ReplState>,
        prompt: &str,
        context: Option<&str>,
        cfg: ReplCfg,
    ) -> String {
        {
            let mut st = state.lock().unwrap();
            if st.sub_calls >= cfg.max_sub_calls {
                return "ERROR: sub-call budget exhausted. Decide from what you have and submit().".to_string();
            }
            st.sub_calls += 1;
        }
        if let Some(c) = context {
            let n = c.chars().count();
            if n > cfg.max_sub_input_chars {
                return format!(
                    "ERROR: slice too large for one sub-call ({n} chars, max {}). Slice it with ctx_slice() and call llm_ctx per piece.",
                    cfg.max_sub_input_chars
                );
            }
        }
        let full_prompt = match context {
            Some(c) => format!("{prompt}\n\n---\nCONTEXT (verbatim slice, the only data you have):\n{c}"),
            None => prompt.to_string(),
        };
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(h) => h,
            Err(_) => return "ERROR: no async runtime on this thread".to_string(),
        };
        let llm = Arc::clone(llm);
        let sys = sub_system.to_string();
        let msgs = vec![ChatMessage::user(full_prompt)];
        let res = tokio::task::block_in_place(|| {
            handle.block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(180),
                    llm.complete(&sys, &msgs, &[]),
                )
                .await
            })
        });
        match res {
            Ok(Ok(turn)) => crate::clip(&turn.text, cfg.max_output_chars),
            Ok(Err(e)) => format!("ERROR: sub-call failed: {e}"),
            Err(_) => "ERROR: sub-call timed out".to_string(),
        }
    }
}

fn extract_submit(e: &EvalAltResult) -> Option<String> {
    if let EvalAltResult::ErrorRuntime(v, _) = e {
        if let Some(s) = v.clone().try_cast::<String>() {
            if let Some(rest) = s.strip_prefix(SUBMIT_PREFIX) {
                return Some(rest.to_string());
            }
        }
    }
    None
}

fn fmt_dynamic(d: Dynamic) -> String {
    if d.is_unit() {
        return String::new();
    }
    if let Some(s) = d.clone().try_cast::<String>() {
        return s;
    }
    format!("{d}")
}

/// The script surface, in the order the preamble lists it.
pub const REPL_DOCS: &str = "\
ctx_len() -> int                          total chars in the context
ctx_slice(start, len) -> string           slice by char offset
ctx_find(pattern, after, max) -> string   regex search, \"offset: line\" per hit
note(text) / notes() -> string            scratchpad across eval calls
llm(prompt) -> string                     sub-model call, no context
llm_ctx(prompt, context) -> string        sub-model call, sees ONLY prompt+context
print(x)                                  capture a value back to you
submit(answer)                            finish the whole run with this answer";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_fake::ScriptedLlm;

    fn multi_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
    }

    // "alpha\nfind me here\nbeta\nfind me again\n" = 6 + 13 + 5 + 14 = 38 chars
    const DEMO_CTX: &str = "alpha\nfind me here\nbeta\nfind me again\n";

    #[test]
    fn ctx_surface_and_prints() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), ReplCfg::default());

            let out = repl.eval(
                r#"print(ctx_len());
                   let hits = ctx_find("find me", 0, 10);
                   print(hits);
                   print(ctx_slice(6, 12));"#,
            );
            assert!(out.contains("38"), "ctx_len output: {out}");
            assert!(out.contains("6: find me here"), "find output: {out}");
            assert!(out.contains("24: find me again"), "find output: {out}");
            assert!(out.contains("find me here"), "slice output: {out}");
            let usage = repl.usage();
            assert_eq!(usage.evals, 1);
            assert!(usage.chars_touched > 0);
        });
    }

    #[test]
    fn submit_unwinds_and_records() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), ReplCfg::default());

            let out = repl.eval(r#"let x = 40 + 2; submit("answer " + x); print("never reached");"#);
            assert_eq!(out, "SUBMITTED");
            assert_eq!(repl.submitted().as_deref(), Some("answer 42"));
        });
    }

    #[test]
    fn empty_submit_is_rejected_not_recorded() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), ReplCfg::default());

            let out = repl.eval(r#"submit("   ")"#);
            assert!(out.contains("ERROR: submit() needs a non-empty answer"), "{out}");
            assert!(repl.submitted().is_none());
        });
    }

    #[test]
    fn eval_budget_stops_scripts() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let cfg = ReplCfg { max_evals: 2, ..ReplCfg::default() };
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), cfg);

            assert!(!repl.eval("1 + 1").starts_with("ERROR"));
            assert!(!repl.eval("2 + 2").starts_with("ERROR"));
            let out = repl.eval("3 + 3");
            assert!(out.contains("eval budget exhausted"), "{out}");
        });
    }

    #[test]
    fn sub_call_budget_stops_fanout() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let cfg = ReplCfg { max_sub_calls: 1, ..ReplCfg::default() };
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), cfg);

            let out = repl.eval(r#"print(llm("first")); print(llm("second"));"#);
            assert!(out.contains("sub-call budget exhausted"), "{out}");
            assert_eq!(repl.usage().sub_calls, 1);
        });
    }

    #[test]
    fn oversize_slices_are_refused_not_truncated() {
        let rt = multi_runtime();
        rt.block_on(async {
            let llm = Arc::new(ScriptedLlm::new());
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let cfg = ReplCfg { max_sub_input_chars: 8, ..ReplCfg::default() };
            let mut repl = Repl::new(Arc::clone(&ctx), llm, "sub".into(), cfg);

            let out = repl.eval(r#"llm_ctx("summarize", ctx_slice(0, 20))"#);
            assert!(out.contains("too large for one sub-call"), "{out}");
        });
    }

    #[test]
    fn sub_calls_reach_the_backend_isolated() {
        let rt = multi_runtime();
        rt.block_on(async {
            let mut llm = ScriptedLlm::new();
            llm.push_sub_text("SUB-ANSWER");
            let llm = Arc::new(llm);
            let ctx = Arc::new(ContextStore::new(DEMO_CTX));
            let mut repl = Repl::new(Arc::clone(&ctx), Arc::clone(&llm), "sub-sys".into(), ReplCfg::default());

            let out = repl.eval(r#"print(llm_ctx("dig", ctx_slice(0, 5)))"#);
            assert!(out.contains("SUB-ANSWER"), "{out}");

            let calls = llm.recorded();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].system, "sub-sys");
            assert_eq!(calls[0].n_tools, 0, "sub-calls must not offer tools");
            assert!(calls[0].last_user_content.contains("dig"));
            assert!(calls[0].last_user_content.contains("alpha"));
        });
    }
}
