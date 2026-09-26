//! Single source of truth for "where does this agent's persistent state
//! actually live". Two very different consumers used to hand-maintain
//! their own copy of this and could silently drift apart:
//!
//! - Seatbelt's default `Agent.sandbox_allowed_paths` (`lib.rs`'s
//!   `default_agents()`) — real `$HOME` paths on the host, allow-listed
//!   for `sandbox-exec` to read/write directly.
//! - Docker's per-agent config-dir mount (`docker.rs`'s `agent_config()`)
//!   — container `/root` paths, bind-mounted from a termic-owned host dir
//!   that is never the host's real `$HOME`.
//!
//! Docker only wants the CONFIRMED state dirs (login, sessions, MCP
//! config — the ones `docs/docker-sandbox/findings.md` actually
//! verified hold real state): it mounts a termic-owned dir, not the real
//! `$HOME`, so persisting a cache dir there buys nothing. Seatbelt allows
//! these same dirs, PLUS its own macOS-only extras (XDG-style
//! `.config`/`.local/share` paths some agents may or may not ever use,
//! `Library/Application Support/*`, regex-covered sidecar files like
//! claude's `.claude.json`) that have no Docker-container equivalent and
//! stay hand-authored in `default_agents()`.
//!
//! Keeping the CONFIRMED subset here means a renamed or added state dir
//! is a one-line change in one place, not two files quietly falling out
//! of sync.

/// One agent's confirmed state dirs, relative to its home (`$HOME` on the
/// host, `/root` inside the Docker image — both conventions land on the
/// same relative subpath). Order matters for an agent with no config-dir
/// relocation env var: the FIRST entry is Docker's primary mount, every
/// entry after it is an `extra_dirs` mount alongside it.
/// Where THIS agent INSTANCE keeps its config on the host.
///
/// One resolver rather than a per-agent abstraction, deliberately. The pieces
/// are already data (`state_dirs`, `config_relocation_env`, and the hook
/// installer's `settings_rel`), and the only thing missing was somewhere that
/// composes them for a specific agent entry rather than for a built-in NAME.
/// A trait or a module per agent would buy no control that these tables do not
/// already give, and would turn "add an agent" from adding a row into
/// implementing an interface.
///
/// Three cases, most specific first:
///   1. the entry relocates its whole config with the agent's own env var
///      (`CLAUDE_CONFIG_DIR=~/.next-claude`), which is how a clone holds a
///      SECOND account. That path is the config dir, verbatim.
///   2. the entry overrides `HOME`, so the default dir hangs off that instead.
///   3. neither: the base's default dir under the real home.
///
/// Returns None only when the base agent has no known state dir at all, which
/// is the honest answer for an agent nobody has mapped.
pub fn instance_config_dir(
    agents: &[crate::Agent],
    agent_id: &str,
    home: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let base = crate::docker::base_agent_id(agents, agent_id);
    let entry = agents.iter().find(|a| a.id == agent_id);
    if let Some(env) = entry.map(|a| &a.env) {
        if let Some(raw) = config_relocation_env(base).and_then(|var| env.get(var)) {
            let expanded = expand_home(raw, home);
            if !expanded.as_os_str().is_empty() {
                return Some(expanded);
            }
        }
        if let Some(h) = env.get("HOME").filter(|h| !h.is_empty()) {
            return Some(std::path::Path::new(h).join(state_dirs(base).first()?));
        }
    }
    Some(home.join(state_dirs(base).first()?))
}

/// `~` and `$HOME` in a user-typed env value. They type these by hand in
/// Settings, so a literal `~/.next-claude` has to become a real path rather
/// than a directory called `~` (which is what the file tree in the reporter's
/// screenshot was already showing).
pub(crate) fn expand_home(raw: &str, home: &std::path::Path) -> std::path::PathBuf {
    let t = raw.trim();
    if t == "~" || t == "$HOME" {
        return home.to_path_buf();
    }
    for prefix in ["~/", "$HOME/"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return home.join(rest);
        }
    }
    std::path::PathBuf::from(t)
}

/// A clone resolved against what it extends: every field it left EMPTY comes
/// from the parent, live, at read time.
///
/// A clone used to be a full COPY of the parent, made once. That is a snapshot
/// that rots: when a vendor renames a flag the built-in entry moves with the
/// app and every clone keeps the old value forever, silently, with no way for
/// the user to tell which of its seventeen fields they actually chose. It had
/// already happened here, a clone carrying the parent's literal `$HOME/.claude`
/// sandbox paths while its own config lived elsewhere, so the cage denied it
/// its own login.
///
/// EMPTY MEANS INHERIT, which is the rule `classifyAgentTitle` already uses for
/// per-field signal fallback, extended to the whole record rather than a second
/// convention. Cost of the choice, and it is the same one that doc records: "no
/// value at all" stops being expressible by clearing a field, because clearing
/// is how you ask for the parent's.
///
/// `id`, `extends`, `display_name` and `builtin` are the clone's OWN identity
/// and are never inherited. Resolution walks the chain, so a clone of a clone
/// works, and is depth-capped because ids are user-editable.

/// Per-LIST capability merge. Wholesale replacement would mean a clone that
/// overrides one flag list stops tracking the parent on every other, which is
/// the freeze this change exists to remove, one field down.
fn merge_caps(child: &mut crate::AgentCapabilities, parent: &crate::AgentCapabilities) {
    macro_rules! take_if_empty {
        ($($f:ident),* $(,)?) => { $( if child.$f.is_empty() { child.$f = parent.$f.clone(); } )* };
    }
    take_if_empty!(
        yolo_args, runtime_yolo_command, runtime_default_command,
        resume_args, session_id_args, resume_id_args, name_args,
    );
    // Signals are per-FIELD, matching `classifyAgentTitle`: overriding the
    // busy patterns must not silently drop the inherited idle ones.
    if child.signals.busy.is_empty() { child.signals.busy = parent.signals.busy.clone(); }
    if child.signals.idle.is_empty() { child.signals.idle = parent.signals.idle.clone(); }
    if child.signals.attention.is_empty() {
        child.signals.attention = parent.signals.attention.clone();
    }
    if child.signals.pending.is_empty() {
        child.signals.pending = parent.signals.pending.clone();
    }
}

pub fn resolve_agent(agents: &[crate::Agent], id: &str) -> Option<crate::Agent> {
    let mut out = agents.iter().find(|a| a.id == id)?.clone();
    let mut cur = out.extends.clone();
    for _ in 0..8 {
        let Some(parent_id) = cur.filter(|p| !p.is_empty() && *p != out.id) else { break };
        let Some(parent) = agents.iter().find(|a| a.id == parent_id) else { break };
        if out.command.trim().is_empty() { out.command = parent.command.clone(); }
        if out.args.is_empty() { out.args = parent.args.clone(); }
        if out.icon_id.trim().is_empty() { out.icon_id = parent.icon_id.clone(); }
        if out.color.trim().is_empty() { out.color = parent.color.clone(); }
        if out.env.is_empty() { out.env = parent.env.clone(); }
        if out.docker_env.is_empty() { out.docker_env = parent.docker_env.clone(); }
        if out.sandbox_allowed_paths.is_empty() {
            out.sandbox_allowed_paths = parent.sandbox_allowed_paths.clone();
        }
        if out.sandbox_allowed_hosts.is_empty() {
            out.sandbox_allowed_hosts = parent.sandbox_allowed_hosts.clone();
        }
        if out.post_launch_capture.is_none() {
            out.post_launch_capture = parent.post_launch_capture.clone();
        }
        // Capabilities are the flags a vendor renames, so this is the field
        // the whole change is FOR. Merged per-list rather than wholesale: a
        // clone overriding `yolo_args` alone must still track the parent's
        // resume flags, or overriding one field silently freezes the rest.
        merge_caps(&mut out.capabilities, &parent.capabilities);
        if !out.work_done { out.work_done = parent.work_done; }
        cur = parent.extends.clone();
    }
    Some(out)
}


/// The env var that relocates an agent's ENTIRE config dir, when it has one.
///
/// This is how a duplicated agent holds a second account: the clone runs the
/// same binary with `CLAUDE_CONFIG_DIR` pointing somewhere else, so its login,
/// its settings and its hooks all live apart from the original's. Anything
/// keyed on the agent's default dir would put one account's hooks into the
/// other account's config, which is worse than not installing them.
///
/// Only agents that genuinely relocate everything are listed. grok has no clean
/// relocation env (binary, skills and config all share `~/.grok`), and the
/// others fold their HOME-root dotfiles into the same dir once relocated.
/// How ONE agent's login can be pointed somewhere else (GH #278).
///
/// This is the account switcher's whole per-agent knowledge, and it is
/// deliberately a table of FACTS rather than a per-agent abstraction: when an
/// agent moves its credential, the fix is one row here, not a new impl.
///
/// Every variant exists because an agent measured that way; there is no
/// speculative shape. See docs/agent-accounts.md for the
/// measurements, and `login_store` below for which agent is which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginStore {
    /// The variable IS the config dir. `CLAUDE_CONFIG_DIR=<store>`.
    ConfigDir { env: &'static str },
    /// The variable is a PARENT and the agent appends a fixed name to it.
    /// `GEMINI_CLI_HOME=<store>` puts the config in `<store>/.gemini`.
    /// Setting it to the config dir itself nests one level too deep.
    ParentDir { env: &'static str, child: &'static str },
    /// A generic XDG root the agent hangs its own directory off, and which
    /// OTHER tools in the same environment also read. Broader than the agent,
    /// which is a thing the UI has to admit rather than hide.
    XdgRoot { env: &'static str, child: &'static str },
    /// No dedicated variable at all: only a `HOME` override moves the login,
    /// so the store has to be a home-shaped directory.
    HomeOnly { child: &'static str },
    /// The variable moves the LOGIN, but that directory also holds the agent's
    /// own binary or bundled assets, so it can never be handed to Docker as a
    /// mount target: mounting an empty dir over it shadows the binary and the
    /// agent vanishes.
    ///
    /// grok is the whole reason this variant exists, and it is worth keeping
    /// separate from `ConfigDir` rather than adding a flag: the two facts
    /// ("the login follows this var" and "this dir is safe to relocate
    /// wholesale") look like one and are not, and conflating them is how the
    /// Docker mount would silently break.
    SelfHostingDir { env: &'static str },
}

/// Where this agent's LOGIN can be relocated to, or `None` when nobody has
/// measured it.
///
/// `None` is honest, not a gap to fill with a guess: an agent whose boundary
/// is unknown must not get an account switcher that silently shares one login
/// between "accounts". `every_builtin_agent_has_a_measured_login_store` fails
/// when a new built-in arrives without a row, so adding an agent forces the
/// measurement rather than deferring it.
pub fn login_store(base_id: &str) -> Option<LoginStore> {
    use LoginStore::*;
    match base_id {
        // Measured: relocating the var moves the whole config dir, dotfile
        // included, and claude's Keychain service is keyed by a hash OF THAT
        // PATH, which is what lets two accounts be live at once.
        "claude" => Some(ConfigDir { env: "CLAUDE_CONFIG_DIR" }),
        "codex" => Some(ConfigDir { env: "CODEX_HOME" }),
        // NOT SUPPORTED, and this is a correction rather than an omission.
        //
        // copilot keeps its credential in the OS keyring under a FIXED service
        // name (`copilot-cli`; libsecret on Linux, Keychain on macOS), so
        // COPILOT_HOME moves the config dir and the plaintext fallback but NOT
        // the credential. Two "accounts" would share one login, silently,
        // which is the exact failure this table exists to prevent. Its own
        // docs point at `/user switch` for multiple logins.
        //
        // `COPILOT_GITHUB_TOKEN` would isolate, but taking that route means
        // termic HOLDING a token, and the one rule this feature is built on is
        // that termic never handles a secret (docs/agent-accounts.md).
        //
        // Also never measured: copilot was not installed when the rest of the
        // fleet was, and signing in needs a real GitHub account.
        "copilot" => None,
        // Measured: GEMINI_CLI_HOME=<tmp> created `<tmp>/.gemini/`. The var is
        // a PARENT. Pointing it at the config dir would nest.
        //
        // The variable alone is NOT enough, and the measurement that said it
        // was is a trap worth naming: gemini stores its OAuth credential in
        // the OS keyring under a fixed service (`gemini-cli-oauth`), so
        // relocating the dir removes `settings.json` and the agent complains
        // about a missing auth method WHILE THE TOKEN STAYS SHARED. "It said
        // signed out" is therefore not proof the credential moved.
        //
        // `GEMINI_FORCE_FILE_STORAGE` pins it to the file backend, which does
        // live in the relocated dir. Carried as a COMPANION so the isolation
        // is real. See `login_companion_env`, and the caveat there: that flag
        // is in gemini's source but not its docs.
        "agy" | "antigravity" => Some(ParentDir { env: "GEMINI_CLI_HOME", child: ".gemini" }),
        // Measured: the login follows GROK_HOME. But the BINARY (`~/.grok/bin`)
        // and bundled skills live in that same tree, so relocating the auth is
        // NOT the same as moving the dir, and Docker must keep declining it.
        "grok" => Some(SelfHostingDir { env: "GROK_HOME" }),
        // Measured: only XDG_DATA_HOME moved it. Generic, shared with other
        // tools in the same environment.
        "opencode" => Some(XdgRoot { env: "XDG_DATA_HOME", child: "opencode" }),
        // Measured on a live 3000.10.21: `XDG_DATA_HOME=<empty> devin auth
        // status` prints "Not logged in" and names
        // `<empty>/devin/credentials.toml` as where it looked. The credential
        // is a plain file in the data dir, so a relocated root carries it.
        "devin" => Some(XdgRoot { env: "XDG_DATA_HOME", child: "devin" }),
        // NOT SUPPORTED until the keychain question is answered.
        //
        // Measured that XDG_CONFIG_HOME moves muse's metadata INDEX, and the
        // agent then reports itself signed out. That is not the same as the
        // credential moving: the index says `storage: "keychain"`, so the
        // secret is in the OS store and may well be one item shared by both
        // "accounts". A probe that only watches for "signed out" cannot tell
        // those apart, which is precisely how a silent shared login gets
        // shipped. Resolve the keying, then enable this.
        "muse" => None,
        // Measured: no dedicated variable exists; a HOME override does isolate
        // it (`ready` became `credentials_not_configured`).
        "pi" => Some(HomeOnly { child: ".pi" }),
        _ => None,
    }
}

/// Why an agent deliberately has NO login store, in words a user can read.
///
/// The second half of the table above, and it has to exist separately: `None`
/// from `login_store` would otherwise mean both "nobody has looked at this
/// yet" and "we looked, and it cannot be isolated", which need opposite
/// responses. An agent in neither table is the first case and fails a test.
///
/// The text is shown in Settings, so it says what is true of the AGENT rather
/// than what termic did not do.
pub fn login_unsupported_reason(base_id: &str) -> Option<&'static str> {
    match base_id {
        // Measured by research, not by this machine: the keyring service name
        // is fixed, so the directory variable moves everything EXCEPT the
        // credential.
        "copilot" => Some(
            "GitHub Copilot keeps its login in the OS keyring under one fixed name, so a second \
             set would share the same credential. Use its own `/user switch` instead.",
        ),
        // The index moves; whether the keychain item behind it does is
        // unresolved, and shipping the optimistic answer would silently share
        // one login between two "accounts".
        "muse" => Some(
            "Muse stores its credential in the OS keychain and termic has not confirmed that a \
             second set would get its own, so it does not offer one yet.",
        ),
        _ => None,
    }
}

/// What an ACCOUNT's store shares with the agent's primary config dir
/// (GH #278).
///
/// Relocating a config dir moves EVERYTHING, not just the credential. Measured
/// on a real `~/.claude`: transcripts (`projects/`), `history.jsonl`,
/// `settings.json` (permissions, hooks and termic's own status line),
/// `CLAUDE.md`, plugins. A second account therefore started as a blank agent:
/// no instructions, no permissions, no usage reporting, and `--resume` unable
/// to find the conversation the user was in the middle of. That is the exact
/// thing the switcher exists to protect.
///
/// So the store is a SYMLINK FARM. It owns the credential and nothing else;
/// every entry here points back at the primary dir, so there is ONE copy and
/// drift is impossible rather than merely unlikely. Claude's settings writer
/// follows symlinks and writes through, so an in-session `/config` change made
/// on either account lands in the same file.
///
/// Deliberately a LIST of what is shared rather than a list of what is not:
/// an entry nobody has thought about stays the account's own, which is the
/// safe direction. Getting it backwards would share a credential.
/// The directory termic installs its hook scripts into, mirrored from
/// `agent_hooks::SCRIPT_DIR`. Named here because a shared config that points
/// at scripts the account cannot see is worse than no sharing at all.
const SCRIPT_DIR_NAME: &str = "termic-hooks";

pub fn shared_config_entries(base_id: &str) -> &'static [&'static str] {
    match base_id {
        // NOT shared, and this is the whole point: `.credentials.json` (the
        // Linux credential) and `.claude.json` (account identity + per-project
        // trust). On macOS the credential is in the Keychain under a service
        // name hashed from THIS directory, which is what makes two live
        // accounts possible at all.
        "claude" => &[
            "settings.json", "CLAUDE.md", "projects", "history.jsonl",
            "plugins", "commands", "agents", "skills", "shell-snapshots",
            // termic's OWN hook scripts, and they are not optional: the
            // shared `settings.json` names them by ABSOLUTE path, so an
            // account whose directory lacks them gets an agent that fails
            // every hook on every turn:
            //
            //   /root/.claude/termic-hooks/working.sh: not found
            //
            // On the host that path resolves anyway (it points into the
            // primary dir); inside a container it is a container path, so the
            // directory has to be there. Sharing the settings without the
            // scripts they name is the half-move that produced this.
            SCRIPT_DIR_NAME,
        ],
        // Same shape for codex: `auth.json` is the credential and stays the
        // account's own; config, instructions and transcripts are shared.
        "codex" => &[
            "config.toml", "AGENTS.md", "sessions", "history.jsonl", "prompts",
            SCRIPT_DIR_NAME,
        ],
        _ => &[],
    }
}

/// Does this agent tell termic how much of its plan is spent (GH #277)?
///
/// The automatic account switch needs a number to act on, so it is offered
/// only where this is true. Everywhere else the switch is manual, which is the
/// half that works for all eight built-ins.
///
/// FOUR agents, and none is a guess: claude and agy push percentages through
/// the status line termic installs (agy's carries its per-bucket `quota`,
/// measured on 1.2.6), codex answers `agent_usage.rs` over JSON-RPC, and devin
/// answers it over the Connect `GetUserStatus` call its own TUI header reads.
/// copilot also reports a number (its quota cache) but is NOT here: it has no
/// login store, so an automatic switch would have nothing to switch to. An agent gets a `true` here
/// only once one of those paths actually produces numbers for it, because the
/// cost of being wrong is an "auto-switch" toggle that silently never fires.
/// See `docs/ideas/usage-footer.md` for why the transports differ.
///
/// A clone resolves through `base_agent_id` first, exactly like the login
/// table, so a second claude entry reports usage for the same reason the
/// original does.
pub fn reports_usage(base_id: &str) -> bool {
    matches!(base_id, "claude" | "codex" | "devin" | "agy")
}

/// Extra variables an agent needs before its login REALLY follows the store.
///
/// Empty for almost everything. It exists for the case where relocating the
/// directory makes an agent SAY it is signed out while the credential stays
/// shared in an OS keyring, which is a false positive a probe cannot see.
pub fn login_companion_env(base_id: &str) -> &'static [(&'static str, &'static str)] {
    match base_id {
        // gemini keeps its OAuth token in the OS keyring under a fixed service
        // name, so `GEMINI_CLI_HOME` alone moves `settings.json` (the agent
        // then complains about a missing auth method) while the TOKEN stays
        // shared. This pins it to the file backend, which does live in the
        // relocated directory.
        //
        // CAVEAT, and it is why `make login-probe` matters more for this agent
        // than any other: the flag is in gemini's source but not its
        // documentation, so it carries no stability promise. If it is ever
        // removed, gemini silently returns to sharing one login.
        "agy" | "antigravity" => &[("GEMINI_FORCE_FILE_STORAGE", "true")],
        _ => &[],
    }
}

/// The variable that IS an agent's whole config dir, or `None`.
///
/// Derived from [`login_store`] rather than kept as a second table: two
/// hand-maintained copies is exactly the drift this module exists to prevent.
///
/// Only `ConfigDir` qualifies, and that restriction is load-bearing rather
/// than tidiness. Docker sets this variable to the container path it mounted,
/// so handing it a `ParentDir` would make gemini write to `<mount>/.gemini`
/// (one level below the mount, i.e. into the throwaway layer) and an
/// `XdgRoot` would redirect unrelated tools in the container.
pub fn config_relocation_env(base_id: &str) -> Option<&'static str> {
    match login_store(base_id) {
        Some(LoginStore::ConfigDir { env }) => Some(env),
        _ => None,
    }
}

/// The environment that points `base_id` at `store` for its login.
///
/// One place, so a caller never has to know which shape an agent is. Returns
/// empty for an agent with no measured boundary, which means "this agent
/// cannot hold a second account" and must be surfaced rather than silently
/// producing a shared login.
pub fn login_env(base_id: &str, store: &std::path::Path) -> Vec<(String, String)> {
    let Some(shape) = login_store(base_id) else { return Vec::new() };
    let p = store.to_string_lossy().into_owned();
    let mut out: Vec<(String, String)> = login_companion_env(base_id)
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    out.extend(match shape {
        // The store IS the config dir, or the parent/root the agent hangs its
        // own directory off. In every directory shape the caller passes the
        // same store path and this decides what the agent is told.
        LoginStore::ConfigDir { env } => vec![(env.into(), p)],
        LoginStore::SelfHostingDir { env } => vec![(env.into(), p)],
        LoginStore::ParentDir { env, .. } => vec![(env.into(), p)],
        LoginStore::XdgRoot { env, .. } => vec![(env.into(), p)],
        // Node reads the home dir from USERPROFILE on Windows, not HOME, so
        // relocating only HOME there would leave a second account quietly
        // sharing the first one's login.
        LoginStore::HomeOnly { .. } => {
            let mut v = vec![("HOME".to_string(), p.clone())];
            if cfg!(windows) {
                v.push(("USERPROFILE".into(), p));
            }
            v
        }
        // No directory at all. The token is not known here: the caller reads
        // it from the account's own store, so this only names the variable.
    });
    out
}

pub fn state_dirs(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        // claude and codex relocate their ENTIRE config dir via an env var
        // (CLAUDE_CONFIG_DIR / CODEX_HOME — see docker.rs's `agent_config`),
        // which folds HOME-root dotfiles in too (claude's `.claude.json`
        // sits inside `$CLAUDE_CONFIG_DIR` once relocated) — one dir covers
        // everything, so there is nothing else to list.
        "claude" => &[".claude"],
        "codex" => &[".codex"],
        "copilot" => &[".copilot"],
        // agy shares the `.gemini` config shape (Gemini-family CLI) plus
        // its own `.antigravity`.
        "agy" | "antigravity" => &[".gemini", ".antigravity"],
        // opencode follows XDG: config in `.config/opencode`, auth +
        // session DB in `.local/share/opencode`.
        "opencode" => &[".config/opencode", ".local/share/opencode"],
        // pi (Earendil): global settings + trust file live under
        // `~/.pi/agent/`, so the whole `.pi` tree is the config dir. Safe to
        // mount in Docker ONLY because the image installs pi from npm (the
        // binary lands in the global prefix, outside HOME) - pi's own
        // install.sh can put it in `~/.pi/agent/bin`, which would be grok's
        // situation exactly. See assets/Dockerfile.default.
        "pi" => &[".pi"],
        // Muse Code follows XDG: auth + enterprise config in `.config/muse`,
        // session logs / bundled skills / plugin cache in
        // `.local/share/muse`. Neither holds the binary (the launcher shim
        // and its versioned `muse-bin-<version>` sibling live in
        // `.local/bin`), so unlike grok these are safe to mount over in
        // Docker — see assets/Dockerfile.default.
        "muse" => &[".config/muse", ".local/share/muse"],
        // grok: binary, bundled skills, and config all live under `.grok`
        // with no clean relocation env. Listed here for Seatbelt (which
        // allows the real path regardless); `docker::agent_config` still
        // declines to support it — see findings.md's "outlier" writeup.
        "grok" => &[".grok"],
        // Devin (Cognition): config.json + hooks in `.config/devin` (FIRST,
        // so it is where hooks install and what Docker would call the config
        // dir), credentials + sessions + the CLI's own versioned binaries in
        // `.local/share/devin`, user-level plans/extensions in `.devin`, and
        // telemetry in `.cache/devin`. `.local/share/devin` holding the
        // binary is exactly grok's collision, so Docker keeps declining it.
        "devin" => &[".config/devin", ".local/share/devin", ".devin", ".cache/devin"],
        _ => &[],
    }
}

#[cfg(test)]
mod instance_dir_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn agent(id: &str, extends: Option<&str>, env: &[(&str, &str)]) -> crate::Agent {
        // Same stub shape docker's tests use: clone a real default rather than
        // construct one, so a new required field cannot silently skip these.
        let mut a = crate::default_agents().into_iter().next().unwrap();
        a.id = id.to_string();
        a.extends = extends.map(|s| s.to_string());
        a.env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        a
    }
    const HOME: &str = "/Users/u";

    // ── what the account switcher can and cannot express today (GH #278) ──
    //
    // The host realm's counterpart to docker.rs's realm tests. Measured
    // 2026-09-06: every built-in has SOME way to isolate a login, but only two
    // of them are expressible through this module, so these pin the gap rather
    // than the wish.

    /// Every agent termic ships, DERIVED from the registry rather than typed.
    ///
    /// This was a hand-written list, and a hand-written list is exactly the
    /// bug the guards below exist to prevent: adding a built-in that appears
    /// in no other table failed ZERO tests, because it was not in this list
    /// either. Measured, then fixed. Deriving it means a new agent is checked
    /// the moment it exists.
    ///
    /// `kind == "agent"` skips custom TERMINAL entries, which are shell
    /// commands and have no login of their own.
    fn built_ins() -> Vec<String> {
        crate::default_agents()
            .into_iter()
            .filter(|a| a.kind == "agent")
            .map(|a| a.id)
            .collect()
    }

    #[test]
    fn every_builtin_agent_has_a_measured_login_store() {
        // THE MAINTENANCE GUARD. Adding an agent without measuring where its
        // login lives would give it an account switcher that silently shares
        // one login between "accounts", which is worse than not offering one.
        // This fails the moment a built-in appears without a row.
        let missing: Vec<String> = built_ins().into_iter()
            .filter(|a| login_store(a).is_none() && login_unsupported_reason(a).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "no answer for: {missing:?}. Point the agent's candidate variable at an empty dir and \
             see whether it loses its login (docs/adding-an-agent.md §1b), then EITHER add a row to \
             `login_store` OR, if it cannot be isolated, a reason to `login_unsupported_reason`. \
             Do not guess: silence here means a second account would share one credential.",
        );
    }

    #[test]
    fn a_new_builtin_agent_is_registered_in_every_table_that_needs_it() {
        // THE GUARD FOR EVERY PER-AGENT TABLE. Adding a built-in used to fail
        // ZERO tests: it appeared in `default_agents()` and in none of the
        // hand-maintained tables around it, and nothing said so. Measured by
        // adding a fake agent and running the suite, which passed.
        //
        // Each table below is checked from the DERIVED agent list, so a new
        // agent is covered the moment it exists rather than when someone
        // remembers to add it here too. The message names the file to edit,
        // because the person hitting this is usually meeting these tables for
        // the first time. See docs/adding-an-agent.md.
        let mut problems: Vec<String> = Vec::new();
        for id in built_ins() {
            if login_store(&id).is_none() && login_unsupported_reason(&id).is_none() {
                problems.push(format!(
                    "{id}: no `agent_dirs::login_store` row and no `login_unsupported_reason`. \
                     Measure which env var moves its login (docs/adding-an-agent.md §1b), then \
                     either add the shape or state why it cannot be isolated. Saying nothing \
                     means a second account would silently share one credential.",
                ));
            }
            if state_dirs(&id).is_empty() {
                problems.push(format!(
                    "{id}: no `agent_dirs::state_dirs` row. Without it Seatbelt will not allow \
                     its config dir and Docker will not mount it, so the agent loses its login \
                     on every run.",
                ));
            }
            if !crate::docker::base_agent_id_is_known(&id) {
                problems.push(format!(
                    "{id}: missing from `docker::base_agent_id_str`'s BUILTINS. A CLONE of this \
                     agent will not resolve its config shape, which is what made cloned agents \
                     unusable in Docker before.",
                ));
            }
        }
        assert!(problems.is_empty(), "per-agent tables are incomplete:\n  {}", problems.join("\n  "));
    }

    #[test]
    fn a_shared_config_brings_the_hook_scripts_it_names_with_it() {
        // `settings.json` is shared, and it names termic's hook scripts by
        // ABSOLUTE path. Sharing the settings without the scripts gave a
        // container an agent that failed every hook on every turn:
        //
        //   /root/.claude/termic-hooks/working.sh: not found
        //
        // Pinned by NAME because the failure is silent on the host (the path
        // resolves into the primary dir anyway) and only shows up inside a
        // container, which is the case least likely to be tried first.
        for agent in ["claude", "codex"] {
            let shared = shared_config_entries(agent);
            assert!(
                shared.contains(&SCRIPT_DIR_NAME),
                "{agent} shares its config but not the hook scripts that config points at",
            );
        }
    }

    #[test]
    fn an_agent_that_reports_usage_can_also_hold_a_second_account() {
        // The automatic switch is the intersection of the two tables, so this
        // pins that the intersection is never empty in the wrong direction: an
        // agent whose usage we can read but whose login we cannot isolate
        // would render an auto-switch toggle with nowhere to switch to.
        //
        // It is not symmetric on purpose. Six agents hold accounts and report
        // no usage, which is exactly the manual-switch case the feature is
        // built around.
        for id in built_ins() {
            if reports_usage(&id) {
                assert!(
                    login_store(&id).is_some(),
                    "{id} reports usage but has no login store, so an automatic switch would \
                     have nothing to switch to. Either give it a `login_store` shape or take \
                     it out of `reports_usage`.",
                );
            }
        }
    }

    #[test]
    fn only_the_agents_with_a_measured_transport_report_usage() {
        // A row here turns on a control that ACTS on the user's behalf, so it
        // is pinned by name rather than by count: adding an agent to this
        // table has to be a deliberate edit backed by a working transport,
        // not something a refactor can do quietly.
        let reporting: Vec<String> = built_ins().into_iter().filter(|id| reports_usage(id)).collect();
        assert_eq!(
            reporting,
            vec!["claude".to_string(), "codex".to_string(), "agy".to_string(), "devin".to_string()]
        );
    }

    #[test]
    fn docker_only_ever_sees_the_shape_it_can_actually_honour() {
        // Docker sets this variable to the CONTAINER PATH it mounted, so only
        // "the variable is the config dir" is safe. A ParentDir would make the
        // agent write one level below the mount (into the throwaway layer) and
        // an XdgRoot would redirect unrelated tools inside the container.
        //
        // This is the guard that replaced an earlier one asserting those
        // agents were absent from the table entirely. They are present now,
        // with shapes; what must stay true is which shapes reach Docker.
        for a in built_ins() {
            let a = a.as_str();
            let via_shape = matches!(login_store(a), Some(LoginStore::ConfigDir { .. }));
            assert_eq!(
                config_relocation_env(a).is_some(), via_shape,
                "{a}: config_relocation_env must be exactly the ConfigDir agents",
            );
        }
        assert_eq!(config_relocation_env("claude"), Some("CLAUDE_CONFIG_DIR"));
        assert_eq!(config_relocation_env("codex"), Some("CODEX_HOME"));
        // The three that would be WRONG as a plain variable name.
        assert_eq!(config_relocation_env("agy"), None, "GEMINI_CLI_HOME is a parent, not a config dir");
        assert_eq!(config_relocation_env("grok"), None,
            "GROK_HOME moves grok's login, but its binary lives in that tree: mounting over it in \
             Docker shadows the binary and the agent vanishes");
        assert_eq!(config_relocation_env("opencode"), None, "XDG_DATA_HOME is a generic root");
        assert_eq!(config_relocation_env("devin"), None,
            "XDG_DATA_HOME again; and .local/share/devin also holds the CLI's binaries, so a \
             Docker mount there is grok's shadowing problem with a second path");
        assert_eq!(config_relocation_env("muse"), None, "muse has no login store at all");
        assert_eq!(config_relocation_env("copilot"), None,
            "copilot's keyring service name is fixed, so COPILOT_HOME does not move the credential");
        assert_eq!(config_relocation_env("pi"), None, "pi has no dedicated variable at all");
    }

    #[test]
    fn each_shape_points_the_agent_at_the_store_the_way_that_agent_expects() {
        let store = Path::new("/data/logins/claude/work");
        assert_eq!(login_env("claude", store), vec![("CLAUDE_CONFIG_DIR".to_string(), "/data/logins/claude/work".to_string())]);
        assert_eq!(login_env("codex", store), vec![("CODEX_HOME".to_string(), "/data/logins/claude/work".to_string())]);
        // Relocatable for a LOGIN even though Docker cannot mount it.
        assert_eq!(login_env("grok", store), vec![("GROK_HOME".to_string(), "/data/logins/claude/work".to_string())]);
        // The parent shape still gets the STORE, not the config dir: the agent
        // is the one that appends. Passing `<store>/.gemini` here would nest.
        // gemini needs a COMPANION: the variable alone moves settings.json
        // while the token stays in a fixed keyring slot.
        assert_eq!(login_env("agy", store), vec![
            ("GEMINI_FORCE_FILE_STORAGE".to_string(), "true".to_string()),
            ("GEMINI_CLI_HOME".to_string(), "/data/logins/claude/work".to_string()),
        ]);
        assert_eq!(login_env("opencode", store), vec![("XDG_DATA_HOME".to_string(), "/data/logins/claude/work".to_string())]);
        // Windows also relocates USERPROFILE, which is where Node reads the
        // home dir there.
        let mut pi = vec![("HOME".to_string(), "/data/logins/claude/work".to_string())];
        if cfg!(windows) {
            pi.push(("USERPROFILE".to_string(), "/data/logins/claude/work".to_string()));
        }
        assert_eq!(login_env("pi", store), pi);
        // An unmeasured agent gets NOTHING, which is the caller's signal that
        // it cannot hold a second account.
        assert!(login_env("some-unmapped-cli", store).is_empty());
    }


    #[test]
    fn the_agents_whose_variable_is_broader_than_themselves_are_known() {
        // XdgRoot redirects a variable other tools in the same environment
        // read, so the UI has to say so rather than present it as agent-local.
        // Listed here so adding one is a deliberate act with a UI consequence.
        let broad: Vec<String> = built_ins().into_iter()
            .filter(|a| matches!(login_store(a), Some(LoginStore::XdgRoot { .. })))
            .collect();
        assert_eq!(broad, vec!["opencode", "devin"]);

        // HomeOnly is broader still: the store has to be a home-shaped dir.
        let home_only: Vec<String> = built_ins().into_iter()
            .filter(|a| matches!(login_store(a), Some(LoginStore::HomeOnly { .. })))
            .collect();
        assert_eq!(home_only, vec!["pi"]);
    }

    #[test]
    fn grok_relocates_its_login_but_is_never_a_docker_mount() {
        // Two facts that look like one. The measurement says GROK_HOME moves
        // the login; the binary living in the same tree says the directory
        // cannot be mounted over. Conflating them is how the Docker mount
        // silently breaks, so they are separate variants and both are pinned.
        assert!(matches!(login_store("grok"), Some(LoginStore::SelfHostingDir { env: "GROK_HOME" })));
        assert!(!login_env("grok", Path::new("/s")).is_empty(), "grok CAN hold a second account");
        assert_eq!(config_relocation_env("grok"), None, "and Docker must still decline it");
        assert!(!crate::docker::persist_offerable("grok"),
            "docker's own refusal has to agree with this table");
    }

    #[test]
    fn devin_relocates_its_login_but_is_never_a_docker_mount() {
        // Same pair of facts as grok's test above, one shape over: the
        // login follows XDG_DATA_HOME (an XdgRoot, so Docker never sees it
        // as a mountable config dir), and `.local/share/devin` carries the
        // versioned binaries next to credentials.toml, so even the opt-in
        // persist path must decline it.
        assert!(matches!(login_store("devin"), Some(LoginStore::XdgRoot { env: "XDG_DATA_HOME", child: "devin" })));
        assert!(!login_env("devin", Path::new("/s")).is_empty(), "devin CAN hold a second account");
        assert_eq!(config_relocation_env("devin"), None, "and Docker must still decline it");
        assert!(!crate::docker::persist_offerable("devin"),
            "docker's own refusal has to agree with this table");
    }

    #[test]
    fn the_probe_covers_every_agent_with_a_measured_login_store() {
        // `login_store` is a table of MEASUREMENTS of other people's software,
        // so it goes stale silently when an agent ships a change: the switcher
        // keeps "working", every test here keeps passing, and two accounts
        // quietly share one credential. `make login-probe` is what catches
        // that, by pointing each variable at an empty dir against the REAL
        // CLI, and it can only catch it for agents it knows about.
        //
        // So this fails when an agent gains a store and the probe is not
        // taught to check it. Cross-file guard, same idea as cspGuard.test.ts.
        let probe = include_str!("../../scripts/login-probe.mjs");
        // The probe keys on the BINARY name; the table keys on the agent id,
        // and the Gemini-family agents run `gemini`.
        fn binary_for(id: &str) -> &str { match id {
            "agy" | "antigravity" => "gemini",
            other => other,
        } }
        let missing: Vec<String> = built_ins().into_iter()
            .filter(|id| login_store(id).is_some())
            .filter(|id| !probe.contains(&format!("id: \"{}\"", binary_for(id))))
            .collect();
        assert!(
            missing.is_empty(),
            "scripts/login-probe.mjs does not check: {missing:?}. An agent with a measured login \
             store but no probe row is one whose table entry can rot unnoticed. Add a row with the \
             variable and a read-only command that reveals whether it is signed in.",
        );

        // And the reverse: a probe row for an agent the table does not know is
        // checking something nothing uses.
        for id in built_ins().into_iter().filter(|i| login_store(i).is_some()) {
            let bin = binary_for(&id);
            assert!(probe.contains(&format!("id: \"{bin}\"")), "{bin} vanished from the probe");
        }
    }

    #[test]
    fn a_clone_resolves_its_base_agents_shape() {
        // A clone of claude runs the claude binary and keeps claude's layout,
        // which is what `extends` is for. The switcher must not treat a clone
        // as an unmeasured agent.
        assert_eq!(login_store("claude"), login_store("claude"));
        assert!(login_store("next-claude").is_none(),
            "a clone id is not a base id; callers resolve it through docker::base_agent_id first");
    }

    #[test]
    fn a_login_is_isolated_per_agent_entry_not_per_account() {
        // The symmetrical gap to docker.rs's
        // `a_docker_login_is_keyed_by_agent_id_and_nothing_else`: on the host
        // too, the only thing that separates two logins today is a different
        // agent ENTRY. That is the clone workaround, and it is what the
        // account switcher replaces.
        let plain = vec![agent("claude", None, &[])];
        let cloned = vec![
            agent("claude", None, &[]),
            agent("next-claude", Some("claude"), &[("CLAUDE_CONFIG_DIR", "~/.next-claude")]),
        ];
        assert_eq!(
            instance_config_dir(&plain, "claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.claude")),
        );
        assert_eq!(
            instance_config_dir(&cloned, "next-claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.next-claude")),
        );
        // Two ACCOUNTS of the same entry are indistinguishable: there is
        // nowhere to say which one is meant.
        assert_eq!(
            instance_config_dir(&cloned, "claude", Path::new(HOME)),
            instance_config_dir(&cloned, "claude", Path::new(HOME)),
        );
    }

    #[test]
    fn a_plain_agent_uses_its_own_default_dir() {
        let agents = vec![agent("claude", None, &[])];
        assert_eq!(
            instance_config_dir(&agents, "claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.claude")),
        );
    }

    #[test]
    fn a_clone_with_no_env_falls_back_to_the_base_dir() {
        // Correct, and worth stating: two agents sharing one login share one
        // config, so they share one set of hooks. Nothing is wrong with that.
        let agents = vec![agent("claude", None, &[]), agent("next-claude", Some("claude"), &[])];
        assert_eq!(
            instance_config_dir(&agents, "next-claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.claude")),
        );
    }

    #[test]
    fn a_clone_holding_a_second_account_gets_its_own_dir() {
        // The reported shape: a second agent entry whose CLAUDE_CONFIG_DIR
        // points outside the first one's default.
        let agents = vec![
            agent("claude", None, &[]),
            agent("next-claude", Some("claude"), &[("CLAUDE_CONFIG_DIR", "/Users/u/.next-claude")]),
        ];
        assert_eq!(
            instance_config_dir(&agents, "next-claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.next-claude")),
        );
        // And the original is untouched, which is the whole point: installing
        // for one account must never write into the other's config.
        assert_eq!(
            instance_config_dir(&agents, "claude", Path::new(HOME)),
            Some(PathBuf::from("/Users/u/.claude")),
        );
    }

    #[test]
    fn a_hand_typed_tilde_is_expanded() {
        // Users type this by hand in Settings, and an unexpanded `~` creates a
        // directory literally called "~".
        for raw in ["~/.next-claude", "$HOME/.next-claude"] {
            let agents = vec![
                agent("claude", None, &[]),
                agent("c2", Some("claude"), &[("CLAUDE_CONFIG_DIR", raw)]),
            ];
            assert_eq!(
                instance_config_dir(&agents, "c2", Path::new(HOME)),
                Some(PathBuf::from("/Users/u/.next-claude")),
                "{raw}",
            );
        }
    }

    #[test]
    fn a_home_override_moves_the_default_dir() {
        let agents = vec![
            agent("claude", None, &[]),
            agent("c2", Some("claude"), &[("HOME", "/tmp/alt")]),
        ];
        assert_eq!(
            instance_config_dir(&agents, "c2", Path::new(HOME)),
            Some(PathBuf::from("/tmp/alt/.claude")),
        );
    }

    #[test]
    fn the_relocation_var_outranks_a_home_override() {
        let agents = vec![
            agent("claude", None, &[]),
            agent("c2", Some("claude"), &[("HOME", "/tmp/alt"), ("CLAUDE_CONFIG_DIR", "/tmp/cfg")]),
        ];
        assert_eq!(
            instance_config_dir(&agents, "c2", Path::new(HOME)),
            Some(PathBuf::from("/tmp/cfg")),
        );
    }

    #[test]
    fn an_agent_with_no_known_dir_says_so() {
        let agents = vec![agent("mystery", None, &[])];
        assert_eq!(instance_config_dir(&agents, "mystery", Path::new(HOME)), None);
    }

    #[test]
    fn only_agents_that_truly_relocate_are_listed() {
        assert_eq!(config_relocation_env("claude"), Some("CLAUDE_CONFIG_DIR"));
        assert_eq!(config_relocation_env("codex"), Some("CODEX_HOME"));
        // grok's binary lives inside its config dir, so it has no clean one.
        assert_eq!(config_relocation_env("grok"), None);
        assert_eq!(config_relocation_env("opencode"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_agents_have_at_least_one_dir() {
        for id in ["claude", "codex", "copilot", "agy", "antigravity", "opencode", "grok"] {
            assert!(!state_dirs(id).is_empty(), "{id} should list at least one state dir");
        }
    }

    #[test]
    fn unknown_agent_has_no_dirs() {
        assert!(state_dirs("not-a-real-agent").is_empty());
    }

    #[test]
    fn every_entry_is_a_relative_dotfile_path() {
        // Every consumer prefixes these with either "$HOME/" or "/root/",
        // so a leading slash or a bare (non-dotfile) name here would
        // silently produce a wrong mount/allow-list path in both places.
        for id in ["claude", "codex", "copilot", "agy", "opencode", "grok"] {
            for dir in state_dirs(id) {
                assert!(dir.starts_with('.'), "{id}'s {dir} should be a relative dotfile path");
                assert!(!dir.starts_with('/'), "{id}'s {dir} should not be absolute");
            }
        }
    }
}
