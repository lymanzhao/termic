//! The self-improvement memory. The model proposes; the code disposes.
//! Every application rule is deterministic and capped so a runaway
//! reflection cannot bloat the preamble unboundedly.

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const MAX_ENTRIES: usize = 20;
const WHEN_CAP: usize = 200;
const STRATEGY_CAP: usize = 600;
/// Append-only refinement history; oldest dropped beyond this.
const MAX_REFINEMENTS: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    /// When does this strategy apply? Short trigger description.
    pub when: String,
    /// What to do about it.
    pub strategy: String,
    #[serde(default)]
    pub wins: u32,
    #[serde(default)]
    pub misses: u32,
    /// Bumped on every applied update, enabling audit and later rollback.
    #[serde(default)]
    pub version: u32,
}

/// One applied refinement pass, kept for audit (prime-agent's
/// HarnessRefinementEvent, simplified).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefinementEvent {
    pub id: String,
    /// "auto" here; the CLI could add "user" later.
    pub trigger: String,
    pub changes: Vec<String>,
    pub outcome: String,
    /// Unix seconds.
    pub created_at: u64,
}

impl Entry {
    fn score(&self) -> i64 {
        self.wins as i64 - self.misses as i64
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Playbook {
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub refinements: Vec<RefinementEvent>,
}

/// What the reflection step is allowed to propose.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Proposal {
    #[serde(default)]
    pub add: Vec<ProposedEntry>,
    #[serde(default)]
    pub update: Vec<ProposedUpdate>,
    #[serde(default)]
    pub drop: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProposedEntry {
    pub when: String,
    pub strategy: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProposedUpdate {
    pub id: String,
    /// "win" or "miss" — did following this strategy help this run?
    pub verdict: String,
    /// Optional rewording of the strategy.
    #[serde(default)]
    pub revision: Option<String>,
}

impl Playbook {
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create dir {}", dir.display()))?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Rendered into the root preamble. Empty playbook renders as "".
    pub fn render(&self) -> String {
        if self.entries.is_empty() {
            return String::new();
        }
        let mut out = String::from("## Playbook: strategies learned from earlier runs\n\n");
        for e in &self.entries {
            out.push_str(&format!(
                "- [{}] when: {}\n  do: {} (record {}W/{}L)\n",
                e.id, e.when, e.strategy, e.wins, e.misses
            ));
        }
        out.push_str(
            "\nThese were proposed by earlier runs of agents like you. \
             Follow what fits the task; ignore what does not.\n",
        );
        out
    }

    /// Apply a proposal deterministically. Returns a human digest of what changed.
    pub fn apply(&mut self, p: &Proposal) -> String {
        let mut log = Vec::new();

        for add in &p.add {
            if self.entries.len() >= MAX_ENTRIES {
                log.push(format!("add skipped (cap {} reached)", MAX_ENTRIES));
                continue;
            }
            let when = crate::clip(add.when.trim(), WHEN_CAP);
            if when.is_empty() {
                continue;
            }
            if self.entries.iter().any(|e| e.when == when) {
                log.push(format!("add skipped (duplicate when: {:?})", crate::clip(&when, 40)));
                continue;
            }
            let id = format!("p{}", self.next_num());
            let strategy = crate::clip(add.strategy.trim(), STRATEGY_CAP);
            log.push(format!("added {id}"));
            self.entries.push(Entry { id, when, strategy, wins: 0, misses: 0, version: 1 });
        }

        for upd in &p.update {
            let Some(e) = self.entries.iter_mut().find(|e| e.id == upd.id) else {
                log.push(format!("update skipped (unknown id {})", upd.id));
                continue;
            };
            match upd.verdict.as_str() {
                "win" => e.wins += 1,
                "miss" => e.misses += 1,
                other => {
                    log.push(format!("update skipped (bad verdict {other:?})"));
                    continue;
                }
            }
            if let Some(rev) = &upd.revision {
                let rev = rev.trim();
                if !rev.is_empty() {
                    e.strategy = crate::clip(rev, STRATEGY_CAP);
                }
            }
            e.version += 1;
            log.push(format!("updated {}", e.id));
        }

        for id in &p.drop {
            if let Some(pos) = self.entries.iter().position(|e| &e.id == id) {
                log.push(format!("dropped {id}"));
                self.entries.remove(pos);
            }
        }

        // Keep the strongest, cull chronic losers.
        self.entries.retain(|e| e.score() >= -2);
        self.entries.sort_by(|a, b| b.score().cmp(&a.score()).then(a.id.cmp(&b.id)));
        self.entries.truncate(MAX_ENTRIES);

        if log.is_empty() {
            "no changes".to_string()
        } else {
            log.join("; ")
        }
    }

    fn next_num(&self) -> u32 {
        self.entries
            .iter()
            .filter_map(|e| e.id.strip_prefix('p')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0)
            + 1
    }

    /// Record the applied pass in the append-only history.
    pub fn record_refinement(&mut self, trigger: &str, changes: Vec<String>, outcome: &str) {
        if changes.is_empty() {
            return;
        }
        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let n = self.refinements.len() + 1;
        self.refinements.push(RefinementEvent {
            id: format!("r{created_at}_{n}"),
            trigger: trigger.to_string(),
            changes,
            outcome: crate::clip(outcome, 300),
            created_at,
        });
        if self.refinements.len() > MAX_REFINEMENTS {
            let overflow = self.refinements.len() - MAX_REFINEMENTS;
            self.refinements.drain(0..overflow);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(add: &[(&str, &str)], update: &[(&str, &str)], drop: &[&str]) -> Proposal {
        Proposal {
            add: add
                .iter()
                .map(|(w, s)| ProposedEntry {
                    when: w.to_string(),
                    strategy: s.to_string(),
                })
                .collect(),
            update: update
                .iter()
                .map(|(id, v)| ProposedUpdate {
                    id: id.to_string(),
                    verdict: v.to_string(),
                    revision: None,
                })
                .collect(),
            drop: drop.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn apply_adds_dedupes_and_caps() {
        let mut pb = Playbook::default();
        let p = proposal(&[("long doc", "find section headers first")], &[], &[]);
        assert_eq!(pb.apply(&p), "added p1");
        // Duplicate `when` is refused.
        let p = proposal(&[("long doc", "something else")], &[], &[]);
        assert!(pb.apply(&p).contains("duplicate"));
        assert_eq!(pb.entries.len(), 1);
        assert_eq!(pb.entries[0].id, "p1");
    }

    #[test]
    fn apply_verdicts_and_drop() {        let mut pb = Playbook::default();
        pb.apply(&proposal(&[("a", "a"), ("b", "b")], &[], &[]));
        let p = proposal(&[], &[("p1", "win"), ("p2", "miss"), ("pX", "win")], &[]);
        let log = pb.apply(&p);
        assert!(log.contains("updated p1"));
        assert!(log.contains("unknown id pX"));
        assert_eq!(pb.entries[0].id, "p1"); // sorted by score
        assert_eq!(pb.entries[0].wins, 1);

        let p = proposal(&[], &[("p1", "miss"), ("p1", "miss"), ("p1", "miss")], &[]);
        pb.apply(&p);
        // score -2 survives; one more miss would cull it
        assert!(pb.entries.iter().any(|e| e.id == "p1"));
        let p = proposal(&[], &[("p1", "miss")], &[]);
        pb.apply(&p);
        assert!(!pb.entries.iter().any(|e| e.id == "p1"));
    }

    #[test]
    fn updates_bump_version_and_log_refinements() {
        let mut pb = Playbook::default();
        pb.apply(&proposal(&[("a", "do it v1")], &[], &[]));
        assert_eq!(pb.entries[0].version, 1);
        let p = proposal(
            &[],
            &[("p1", "win")],
            &[],
        );
        let mut p = p;
        p.update[0].revision = Some("do it v2".to_string());
        pb.apply(&p);
        assert_eq!(pb.entries[0].version, 2);
        assert_eq!(pb.entries[0].strategy, "do it v2");

        pb.record_refinement("auto", vec!["added p1; updated p1".to_string()], "submitted: ok");
        assert_eq!(pb.refinements.len(), 1);
        assert_eq!(pb.refinements[0].trigger, "auto");
        assert!(pb.refinements[0].outcome.contains("submitted"));
        // Empty change sets are not recorded.
        pb.record_refinement("auto", vec![], "nothing");
        assert_eq!(pb.refinements.len(), 1);
    }

    #[test]
    fn roundtrips_through_disk() {
        let dir = std::env::temp_dir().join(format!("axcoding-test-{}", std::process::id()));
        let path = dir.join("playbook.json");
        let mut pb = Playbook::default();
        pb.apply(&proposal(&[("when x", "do y")], &[], &[]));
        pb.save(&path).unwrap();
        let loaded = Playbook::load(&path);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].strategy, "do y");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn render_is_empty_when_empty() {
        assert_eq!(Playbook::default().render(), "");
    }
}
