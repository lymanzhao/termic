//! The long context as an addressable store. The model never receives it in
//! full; it addresses it by character offset (model-friendly) which we map
//! to byte offsets internally.

use anyhow::{anyhow, Result};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CtxMatch {
    /// Char offset of the match start.
    pub start: usize,
    pub line: String,
}

#[derive(Debug, Clone)]
pub struct ContextStore {
    data: String,
}

impl ContextStore {
    pub fn new(data: impl Into<String>) -> Self {
        Self { data: data.into() }
    }

    pub fn len_chars(&self) -> usize {
        self.data.chars().count()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// `[start, start+len)` in char offsets, clamped to the data.
    pub fn slice(&self, start: usize, len: usize) -> String {
        self.data.chars().skip(start).take(len).collect()
    }

    /// Regex search starting at char offset `after`, at most `max` matches.
    /// Each match reports the char offset and its containing line (trimmed).
    pub fn find(&self, pattern: &str, after: usize, max: usize) -> Result<Vec<CtxMatch>> {
        if max == 0 {
            return Ok(vec![]);
        }
        let re = regex::RegexBuilder::new(pattern)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| anyhow!("bad regex {pattern:?}: {e}"))?;
        let byte_from = self
            .data
            .char_indices()
            .nth(after)
            .map(|(b, _)| b)
            .unwrap_or(self.data.len());
        let hay = &self.data[byte_from..];
        let base_chars = self.data[..byte_from].chars().count();
        let mut out = Vec::new();
        for m in re.find_iter(hay) {
            let line_start = hay[..m.start()].rfind('\n').map(|i| i + 1).unwrap_or(0);
            let line_end = hay[m.end()..].find('\n').map(|i| m.end() + i).unwrap_or(hay.len());
            let line: String = hay[line_start..line_end].trim().to_string();
            out.push(CtxMatch {
                start: base_chars + hay[..m.start()].chars().count(),
                line: crate::clip(&line, 400),
            });
            if out.len() >= max {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_is_char_offset_and_clamped() {
        let c = ContextStore::new("héllo wörld");
        assert_eq!(c.slice(0, 5), "héllo");
        assert_eq!(c.slice(6, 100), "wörld");
        assert_eq!(c.slice(100, 5), "");
        assert_eq!(c.len_chars(), 11);
    }

    #[test]
    fn find_reports_char_offsets_and_lines() {
        let c = ContextStore::new("alpha\nfind me here\nbeta\nfind me again");
        let hits = c.find("find me", 0, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].start, 6);
        assert_eq!(hits[0].line, "find me here");
        // Second search resumes after the first hit.
        let hits = c.find("find me", hits[0].start + 1, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start, 24);
        assert_eq!(hits[0].line, "find me again");
    }

    #[test]
    fn find_bad_regex_is_an_error_not_a_panic() {
        let c = ContextStore::new("abc");
        assert!(c.find("a(", 0, 5).is_err());
        assert!(c.find("x", 0, 0).unwrap().is_empty());
    }
}
