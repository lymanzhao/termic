//! Subscription usage: how much of an account's rolling limits is spent
//! (GH #277).
//!
//! Two providers, two transports, and they are different on purpose.
//!
//! **claude** reports itself. Claude Code pipes `rate_limits` into the
//! statusLine command's stdin on every turn, so `agent_hooks::statusline_body`
//! installs a script that forwards it over the OSC channel the hooks already
//! use. Nothing in this module is involved: the numbers arrive at the terminal.
//!
//! **codex** is asked. It exposes `account/rateLimits/read` as a documented
//! JSON-RPC method on `codex app-server`, which answers COLD, with no agent
//! running and no session in flight, and returns the account id alongside the
//! numbers. That is strictly better than the alternative (tailing the
//! `token_count` event out of its rollout JSONL): no file walking, no parsing,
//! and no dependence on `session_meta.cwd`, which inside Docker is the path as
//! the CONTAINER sees it and cannot be matched against a host worktree.
//!
//! Both are per-account for the same reason: a cloned agent relocates its whole
//! config dir with the agent's own env var (`CODEX_HOME` here), so the config
//! dir IS the account. This module never has to know what an account is; it
//! points codex at a directory and believes what comes back.
//!
//! See docs/ideas/usage-footer.md for the sources that were measured and
//! rejected, which is most of them.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long to wait for `codex app-server` to answer. Generous for the same
/// reason `codex_trust::LIST_TIMEOUT` is: this is a COLD process start, and the
/// app-server loads config and resolves auth before it answers anything.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

/// Anything at least this long is the WEEKLY window rather than the session
/// one. 7 days in minutes. Codex reports durations rather than names, and a
/// free plan reports a single 30-day window, so the split has to be made here.
const WEEKLY_MIN_MINUTES: u64 = 7 * 24 * 60;

/// One rolling limit window.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 0-100, clamped. A provider reporting 101 must not overflow a bar.
    pub used_percent: f64,
    /// Unix epoch SECONDS, or None when the provider did not say.
    pub resets_at: Option<i64>,
}

/// What one account has spent. Either window can be absent: codex on a free
/// plan reports a single 30-day window and no second one at all.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    /// `free`, `plus`, `pro`, `team`… Passed through verbatim rather than
    /// matched: the enum has a dozen arms and gains more.
    pub plan_type: Option<String>,
    /// Which account answered. Not displayed, but it is the only way to tell
    /// two clones apart in a log when one of them shows the wrong number.
    pub account_id: Option<String>,
    /// What an UNCAPPED plan has used this billing period, for an account
    /// that has no quota to be a percentage of. Only devin reports it: an
    /// Enterprise account billed in ACUs answers with unlimited credits and
    /// no daily or weekly window at all, and without this its footer could
    /// only ever say "Usage unknown". `None` whenever a window is present,
    /// because a percentage of a cap is the readout that matters.
    pub consumed: Option<PeriodConsumption>,
}

/// An amount used in the current billing period, with no cap attached.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeriodConsumption {
    pub amount: f64,
    /// What `amount` counts, e.g. `ACU`. Shown next to the number.
    pub unit: String,
    /// Unix epoch SECONDS of the period's bounds, when the provider said.
    pub period_start: Option<i64>,
    pub period_end: Option<i64>,
}

/// Read one window out of codex's JSON. Returns None for a null window, which
/// is the normal shape of `secondary` rather than an error.
fn window(v: &serde_json::Value) -> Option<(UsageWindow, u64)> {
    let obj = v.as_object()?;
    let used = obj.get("usedPercent").and_then(serde_json::Value::as_f64)?;
    // Absent duration is treated as the SHORT window, because that is the one
    // a footer leads with and mislabelling it costs less than dropping it.
    let mins = obj
        .get("windowDurationMins")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let resets_at = obj.get("resetsAt").and_then(serde_json::Value::as_i64);
    Some((
        UsageWindow { used_percent: used.clamp(0.0, 100.0), resets_at },
        mins,
    ))
}

/// Sort codex's `primary`/`secondary` into session/weekly BY DURATION.
///
/// Not by position. Codex names them by precedence, not by length, and a free
/// plan sends a single 30-day window as `primary` with no `secondary` at all.
/// Reading position as meaning would file that 30-day window under "5h" and
/// paint a session bar that resets next month.
pub fn classify(primary: Option<(UsageWindow, u64)>, secondary: Option<(UsageWindow, u64)>)
    -> (Option<UsageWindow>, Option<UsageWindow>)
{
    let mut session = None;
    let mut weekly = None;
    for (win, mins) in [primary, secondary].into_iter().flatten() {
        let slot = if mins >= WEEKLY_MIN_MINUTES { &mut weekly } else { &mut session };
        // Two windows landing in the same slot keeps the SHORTER one, so a plan
        // reporting 7d and 30d does not show whichever arrived last.
        if slot.is_none() {
            *slot = Some(win);
        }
    }
    (session, weekly)
}

/// Parse the `result` of `account/rateLimits/read`.
pub fn parse_codex_result(result: &serde_json::Value) -> AgentUsage {
    let rl = result.get("rateLimits");
    let (session, weekly) = match rl {
        Some(rl) => classify(
            rl.get("primary").and_then(window),
            rl.get("secondary").and_then(window),
        ),
        None => (None, None),
    };
    AgentUsage {
        session,
        weekly,
        plan_type: rl
            .and_then(|r| r.get("planType"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        account_id: result
            .get("accountId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),        consumed: None,
    }
}

/// The `codex app-server` invocation, built separately so a test can read its
/// ENVIRONMENT back without needing a codex on the machine.
///
/// It exists because of a bug that shipped. A packaged `.app` is launched by
/// the GUI with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and codex installs to
/// `~/.local/bin`, so `Command::new("codex")` is a plain ENOENT in every
/// release build while working in every dev one, where the terminal's PATH is
/// inherited. The frontend swallows this error on purpose, so the footer was
/// simply empty for codex with nothing anywhere saying why.
///
/// `shell_env` exists for exactly this and its module doc says so; the fix is
/// to use it, and the test below is what stops it being dropped again.
fn app_server_command(bin: &str, home: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.arg("app-server")
        .env("PATH", crate::shell_env::resolved_path())
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd
}

/// One `initialize` + one `account/rateLimits/read` over stdio, then kill the
/// child.
///
/// Deliberately the same shape as `codex_trust::hooks_list`, down to the worker
/// thread and the kill-first-report-second ordering, because it is the same
/// hazard: the app-server is a long-lived JSON-RPC peer, termic wants one
/// answer, and a child that never answers would otherwise hang a caller with
/// the pipe still open.
pub fn fetch_codex(agent_id: &str, docker: bool, account: Option<&str>) -> Result<AgentUsage, String> {
    let home = codex_home(agent_id, docker, account)?;
    let bin = codex_binary(agent_id);

    let mut child = app_server_command(&bin, &home)
        .spawn()
        .map_err(|e| {
            // Logged, not just returned. The caller swallows this error on
            // purpose (a missing codex must not raise a banner over a footer
            // number), so without a trace here a total failure is invisible,
            // which is precisely how it reached a release.
            let msg = format!("could not start `{bin} app-server`: {e}");
            crate::dlog(&format!("[agent-usage] {msg}"));
            msg
        })?;

    {
        let stdin = child.stdin.as_mut().ok_or("no stdin on codex app-server")?;
        let init = serde_json::json!({
            "id": 1, "method": "initialize",
            "params": { "clientInfo": { "name": "termic", "version": env!("CARGO_PKG_VERSION") } }
        });
        let read = serde_json::json!({ "id": 2, "method": "account/rateLimits/read", "params": {} });
        for msg in [init, read] {
            writeln!(stdin, "{msg}").map_err(|e| format!("write to codex app-server: {e}"))?;
        }
        stdin.flush().map_err(|e| format!("flush codex app-server: {e}"))?;
    }

    let stdout = child.stdout.take().ok_or("no stdout on codex app-server")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            // Responses only. The app-server also streams notifications, which
            // carry no `id` and are none of our business here.
            if v.get("id").and_then(serde_json::Value::as_i64) == Some(2) {
                let _ = tx.send(v);
                return;
            }
        }
    });

    let answer = rx.recv_timeout(RPC_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    let answer = answer.map_err(|_| {
        format!(
            "`{bin} app-server` did not answer account/rateLimits/read within {}s",
            RPC_TIMEOUT.as_secs()
        )
    })?;

    if let Some(err) = answer.get("error") {
        return Err(format!("codex refused account/rateLimits/read: {err}"));
    }
    let result = answer
        .get("result")
        .ok_or("codex answered account/rateLimits/read with no result")?;
    Ok(parse_codex_result(result))
}

/// Where codex keeps ITS config for this agent entry. `CODEX_HOME` is how a
/// clone points codex at a second account, and `instance_config_dir` already
/// resolves that from the agent ENTRY, so a clone is asked about its own login
/// rather than the base's.
fn codex_home(agent_id: &str, docker: bool, account: Option<&str>) -> Result<PathBuf, String> {
    // A NAMED account has its own CODEX_HOME, and asking the primary dir
    // instead reports the primary account's quota under every account's name:
    // two different logins showed the same percentage, which is the exact
    // misattribution the account-keyed usage store exists to prevent.
    //
    // The ADOPTED account is excluded because it NAMES the login the agent
    // already had and relocates nothing, so its home IS the primary dir.
    if let Some(a) = account {
        let agents = crate::load_settings_inner().agents;
        let adopted = agents.iter().find(|x| x.id == agent_id)
            .and_then(|x| x.adopted_account.as_deref());
        if adopted != Some(a) {
            let realm = if docker { crate::LoginRealm::Docker } else { crate::LoginRealm::Host };
            if let Some(dir) = crate::login_store_dir(agent_id, Some(a), realm) {
                return Ok(dir);
            }
        }
    }
    // A DOCKER task's codex logs in inside the container, whose CODEX_HOME is
    // the termic-owned directory bind-mounted at that path. Asking the host's
    // `~/.codex` instead would report a DIFFERENT ACCOUNT's quota under the
    // task's name, which is worse than reporting none: the number looks
    // authoritative and belongs to someone else's login.
    if docker {
        return Ok(crate::docker::agent_config_host_dir(agent_id));
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let agents = crate::load_settings_inner().agents;
    crate::agent_dirs::instance_config_dir(&agents, agent_id, &home)
        .ok_or_else(|| format!("{agent_id} has no known state dir"))
}

/// The codex binary to ask. Resolved from the REGISTRY entry rather than
/// hard-coded, so a user who renamed the command or pointed it at an absolute
/// path gets their binary asked.
fn codex_binary(agent_id: &str) -> String {
    let agents = crate::load_settings_inner().agents;
    crate::agent_dirs::resolve_agent(&agents, agent_id)
        .map(|a| a.command)
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "codex".to_string())
}

/// Ask codex for this agent entry's usage.
///
/// `async` and off the main thread, because it SPAWNS A PROCESS and waits up to
/// 10s for it: a synchronous Tauri command doing that blocks the WKWebView
/// event loop and freezes the whole window (see CLAUDE.md).
#[tauri::command]
pub async fn agent_usage_codex(
    agent_id: String,
    docker: bool,
    account: Option<String>,
) -> Result<AgentUsage, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_codex(&agent_id, docker, account.as_deref()))
        .await
        .map_err(|e| format!("usage task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// devin
//
// **devin is asked too**, but not through the binary: `devin acp` answers ACP
// session traffic, not account state, and `auth status` prints the plan NAME
// without the quota. What the TUI's "Pro · 99% remaining" header reads is
// `GetUserStatus` on the Connect service in credentials.toml, which answers
// COLD over plain HTTPS with the account's own API key - the same "ask the
// agent's backend" shape as codex, minus the child process.
//
// The request is Codeium-lineage (`exa.seat_management_pb`, public in
// Exafunction/CodeiumJetBrains): Connect JSON POST, and `metadata` must carry
// all five fields or the service answers invalid_argument. Verified against a
// live Pro account on devin 3000.10.21.
//
// `user_status.*.bin` in `~/.cache/devin/cli` was the alternative and loses:
// it is devin's own read-through cache, written only when devin refreshes it,
// so a footer that read it would show numbers as stale as the last time the
// user happened to run devin - and it is keyed by an identity digest termic
// cannot recompute, so a second account's file cannot be told apart from the
// first's.

/// Where devin's `credentials.toml` lives for this agent entry. Mirrors
/// `codex_home`: the account's store wins, and the entry's own
/// `XDG_DATA_HOME` override is how a clone's login is found.
fn devin_credentials(agent_id: &str, docker: bool, account: Option<&str>) -> Result<PathBuf, String> {
    // devin declines a Docker config mount (its data dir also holds the CLI
    // binaries), so a container login stays inside the container. Nothing on
    // the host can answer for it - including a named account's store, which
    // Docker never receives.
    if docker {
        return Err(format!("{agent_id} in Docker signs in inside the container"));
    }
    if let Some(a) = account {
        let agents = crate::load_settings_inner().agents;
        let adopted = agents.iter().find(|x| x.id == agent_id)
            .and_then(|x| x.adopted_account.as_deref());
        if adopted != Some(a) {
            // XdgRoot: the store IS XDG_DATA_HOME and devin appends `devin`.
            if let Some(dir) = crate::login_store_dir(agent_id, Some(a), crate::LoginRealm::Host) {
                return Ok(dir.join("devin").join("credentials.toml"));
            }
        }
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let agents = crate::load_settings_inner().agents;
    let root = agents.iter().find(|a| a.id == agent_id)
        .and_then(|a| a.env.get("XDG_DATA_HOME"))
        .map(|v| crate::agent_dirs::expand_home(v, &home))
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| home.join(".local/share"));
    Ok(root.join("devin").join("credentials.toml"))
}

/// `(api_key, api_server_url)` out of the agent's own credential file.
/// The server comes from the file so an enterprise deployment's endpoint is
/// honoured rather than assumed.
///
/// The key is read, sent once over TLS to the server the file itself names,
/// and dropped: never stored, never logged, never sent anywhere else. That is
/// the same trust position as spawning the agent, which reads this file for
/// every launch.
fn devin_credential(path: &Path) -> Result<(String, String), String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let doc = text.parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    let key = doc.get("windsurf_api_key").and_then(|v| v.as_str())
        .ok_or_else(|| format!("{} has no windsurf_api_key", path.display()))?
        .to_string();
    let server = doc.get("api_server_url").and_then(|v| v.as_str())
        .unwrap_or("https://server.codeium.com")
        .trim_end_matches('/')
        .to_string();
    Ok((key, server))
}

/// proto3-JSON emits int64 as strings and int32 as numbers; take both.
fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.parse().ok())
}

/// `planStatus` into termic's two windows. Devin reports REMAINING percent,
/// so the number is inverted: the footer and the warn thresholds are all
/// written against "how much is spent", and a 1%-used day must not render as
/// a 99% bar.
pub fn parse_devin_result(result: &serde_json::Value) -> AgentUsage {
    let us = result.get("userStatus");
    let ps = us.and_then(|u| u.get("planStatus"));
    let window = |remaining_key: &str, reset_key: &str| -> Option<UsageWindow> {
        let ps = ps?;
        let remaining = ps.get(remaining_key).and_then(as_f64)?;
        Some(UsageWindow {
            used_percent: (100.0 - remaining).clamp(0.0, 100.0),
            resets_at: ps.get(reset_key).and_then(as_f64).map(|v| v as i64),
        })
    };
    let session = window("dailyQuotaRemainingPercent", "dailyQuotaResetAtUnix");
    let weekly = window("weeklyQuotaRemainingPercent", "weeklyQuotaResetAtUnix");
    // An ACU-billed plan (Enterprise) has no quota windows, only what it has
    // consumed since `planStart`. Read only when there is no window: a capped
    // plan's percentage is the number to watch.
    let rfc3339 = |key: &str| -> Option<i64> {
        let raw = ps?.get(key)?.as_str()?;
        chrono::DateTime::parse_from_rfc3339(raw).ok().map(|d| d.timestamp())
    };
    let consumed = if session.is_none() && weekly.is_none() {
        ps.and_then(|p| p.get("acuConsumed")).and_then(as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map(|amount| PeriodConsumption {
                amount,
                unit: "ACU".to_string(),
                period_start: rfc3339("planStart"),
                period_end: rfc3339("planEnd"),
            })
    } else {
        None
    };
    AgentUsage {
        session,
        weekly,
        plan_type: ps
            .and_then(|p| p.get("planInfo"))
            .and_then(|i| i.get("planName"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        account_id: us
            .and_then(|u| u.get("userId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),        consumed,
    }
}

/// POST `GetUserStatus` with the account's key and parse the plan windows.
/// async rather than spawn_blocking: the only wait is a network await, which
/// is what the runtime is for.
pub async fn fetch_devin(agent_id: &str, docker: bool, account: Option<&str>)
    -> Result<AgentUsage, String>
{
    let path = devin_credentials(agent_id, docker, account)?;
    let (api_key, server) = devin_credential(&path)?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("termic/", env!("CARGO_PKG_VERSION")))
        .timeout(RPC_TIMEOUT)
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let resp = client
        .post(format!("{server}/exa.seat_management_pb.SeatManagementService/GetUserStatus"))
        .header("Connect-Protocol-Version", "1")
        .json(&serde_json::json!({
            "metadata": {
                // All five fields are required: with only apiKey the service
                // answers invalid_argument. The name identifies termic, not
                // devin - the apiKey is what makes this the account's answer.
                "apiKey": api_key,
                "ideName": "termic",
                "ideVersion": env!("CARGO_PKG_VERSION"),
                "extensionName": "termic",
                "extensionVersion": env!("CARGO_PKG_VERSION"),
                "locale": "en",
            }
        }))
        .send()
        .await
        .map_err(|e| format!("GetUserStatus: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GetUserStatus: HTTP {}", resp.status()));
    }
    let body = resp.json::<serde_json::Value>().await
        .map_err(|e| format!("GetUserStatus response: {e}"))?;
    if let Some(msg) = body.get("message").and_then(|m| m.as_str()) {
        return Err(format!("GetUserStatus refused: {msg}"));
    }
    Ok(parse_devin_result(&body))
}

/// Ask devin's API for this agent entry's usage.
#[tauri::command]
pub async fn agent_usage_devin(
    agent_id: String,
    docker: bool,
    account: Option<String>,
) -> Result<AgentUsage, String> {
    fetch_devin(&agent_id, docker, account.as_deref()).await
}

// ───────────────────────────── devin context ────────────────────────────
//
// devin reports its context window NOWHERE live: no status line, and no hook
// payload carries a token count (measured on 3000.10.31, every event). What it
// does keep is `num_tokens_preceding` on each assistant node in its session
// store, which is the prompt size of that request, i.e. the context in use
// (cross-checked against the session's own transcript metrics). The window
// comes from `devin models list`, which is a 2s spawn, so it is asked once
// per launch and per devin binary.
//
// Read on the turn's END (the tab's Done hook), from the frontend, so it costs
// one sqlite3 read per turn and nothing while idle. `sessions.db` is not a
// documented interface: when a column moves this returns None and the chip
// shows no context, never a wrong one.

/// One reading, in the shape `lib/agentContext.ts` takes.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextReading {
    pub used_tokens: u64,
    pub window_tokens: u64,
}

static DEVIN_WINDOWS: std::sync::Mutex<Option<std::collections::HashMap<String, u64>>> =
    std::sync::Mutex::new(None);

/// `model_uid -> max_context_tokens` out of `devin models list --format json`.
pub fn parse_devin_models(v: &serde_json::Value) -> std::collections::HashMap<String, u64> {
    let mut out = std::collections::HashMap::new();
    for fam in v.get("families").and_then(|f| f.as_array()).into_iter().flatten() {
        for var in fam.get("variants").and_then(|x| x.as_array()).into_iter().flatten() {
            if let (Some(uid), Some(max)) = (
                var.get("model_uid").and_then(|x| x.as_str()),
                var.get("max_context_tokens").and_then(|x| x.as_u64()),
            ) {
                out.insert(uid.to_string(), max);
            }
        }
    }
    out
}

fn devin_window(agent_id: &str, model: &str) -> Option<u64> {
    if let Some(map) = DEVIN_WINDOWS.lock().ok()?.as_ref() {
        if let Some(w) = map.get(model) {
            return Some(*w);
        }
    }
    let agents = crate::load_settings_inner().agents;
    let bin = crate::agent_dirs::resolve_agent(&agents, agent_id)
        .map(|a| a.command)
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "devin".to_string());
    let out = Command::new(&bin)
        .args(["models", "list", "--format", "json"])
        .env("PATH", crate::shell_env::resolved_path())
        .stdin(Stdio::null()).stderr(Stdio::null())
        .output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let map = parse_devin_models(&v);
    let w = map.get(model).copied();
    *DEVIN_WINDOWS.lock().ok()? = Some(map);
    w
}

/// A devin session id is a slug (`brassy-polish`). It is interpolated into a
/// SQL string for the sqlite3 CLI, so anything else is refused outright.
fn devin_slug_ok(s: &str) -> bool {
    !s.is_empty() && s.len() < 128
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The query, pure, so the slug rule and the SQL can be pinned together.
pub fn devin_context_sql(session_id: &str) -> Option<String> {
    devin_slug_ok(session_id).then(|| format!(
        "select s.model, (select json_extract(m.metadata, '$.num_tokens_preceding') \
         from message_nodes m where m.session_id = s.id \
         and json_extract(m.chat_message, '$.role') = 'assistant' \
         and json_extract(m.metadata, '$.num_tokens_preceding') is not null \
         order by m.node_id desc limit 1) from sessions s where s.id = '{session_id}'"
    ))
}

/// Read one devin session's context. `Ok(None)` for "nothing to say yet".
#[tauri::command]
pub async fn agent_context_devin(
    agent_id: String,
    account: Option<String>,
    session_id: String,
) -> Result<Option<ContextReading>, String> {
    let sql = devin_context_sql(&session_id).ok_or("not a devin session id")?;
    let creds = devin_credentials(&agent_id, false, account.as_deref())?;
    let db = creds.parent().ok_or("no devin data dir")?.join("cli").join("sessions.db");
    if !db.exists() {
        return Ok(None);
    }
    let out = Command::new("sqlite3")
        .arg("-readonly").arg("-separator").arg("|").arg(&db).arg(&sql)
        .stdin(Stdio::null()).stderr(Stdio::null())
        .output().map_err(|e| format!("sqlite3: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().splitn(2, '|');
    let (Some(model), Some(used)) = (parts.next(), parts.next()) else { return Ok(None) };
    let Ok(used) = used.trim().parse::<u64>() else { return Ok(None) };
    let Some(window) = devin_window(&agent_id, model.trim()) else { return Ok(None) };
    Ok((window > 0).then_some(ContextReading { used_tokens: used, window_tokens: window }))
}

// ─────────────────────────────── copilot ────────────────────────────────
//
// **copilot is read from its own cache**, not asked. The CLI fetches
// `GET api.github.com/copilot_internal/user` on every run and writes the answer
// to `copilot-user-cache.json` in the platform cache dir, `//` comment lines
// and all (measured on 1.0.86). Asking the endpoint ourselves would mean the
// OAuth token, which copilot keeps in the macOS Keychain under an ACL termic
// does not own: the same wall `docs/ideas/usage-footer.md` hit with claude's.
// The cache is as fresh as copilot's last run, and a footer chip is only shown
// for a task that is running copilot, so that is fresh enough.
//
// The quota is MONTHLY, and it is filed under `session` because that is the
// window the chip leads with; `shortWindowWords("copilot")` names it.

/// Which quota bucket is the account's real limit. `premium_interactions` on a
/// paid plan; a Free, token-billed plan has `entitlement: 0` there and its
/// real caps on `chat`. Measured on a Free account; the paid shape is the
/// documented one.
const COPILOT_BUCKETS: &[&str] = &["premium_interactions", "chat"];

/// Parse the cache file's text into a reading, from the entry copilot wrote
/// most recently (one entry per token it has used).
pub fn parse_copilot_cache(text: &str) -> Result<AgentUsage, String> {
    let json: String = text.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>().join("\n");
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| format!("copilot cache: {e}"))?;
    let entries = v.get("copilotUserCache").and_then(|c| c.as_object())
        .ok_or("copilot cache has no entries")?;
    let newest = entries.values()
        .max_by_key(|e| e.get("retrievedAt").and_then(|r| r.as_str()).unwrap_or("").to_string())
        .and_then(|e| e.get("response"))
        .ok_or("copilot cache has no response")?;
    let resets_at = newest.get("quota_reset_date_utc").and_then(|r| r.as_str())
        .and_then(|r| chrono::DateTime::parse_from_rfc3339(r).ok())
        .map(|d| d.timestamp());
    let snaps = newest.get("quota_snapshots");
    let session = COPILOT_BUCKETS.iter().find_map(|name| {
        let b = snaps?.get(*name)?;
        let capped = b.get("has_quota").and_then(|x| x.as_bool()) == Some(true)
            && b.get("unlimited").and_then(|x| x.as_bool()) != Some(true)
            && b.get("entitlement").and_then(as_f64).is_some_and(|e| e > 0.0);
        if !capped { return None; }
        let remaining = b.get("percent_remaining").and_then(as_f64)?;
        Some(UsageWindow { used_percent: (100.0 - remaining).clamp(0.0, 100.0), resets_at })
    });
    Ok(AgentUsage {
        session,
        weekly: None,
        plan_type: newest.get("copilot_plan").and_then(|p| p.as_str()).map(str::to_string),
        account_id: None,
        consumed: None,
    })
}

/// Read copilot's usage for this agent entry. Host only: a Docker task's
/// copilot writes its cache inside the container.
#[tauri::command]
pub async fn agent_usage_copilot(
    agent_id: String,
    docker: bool,
    account: Option<String>,
) -> Result<AgentUsage, String> {
    let _ = (agent_id, account);
    if docker {
        return Err("copilot usage is not readable from a Docker task".into());
    }
    let path = dirs::cache_dir().ok_or("no cache dir")?
        .join("copilot").join("copilot-user-cache.json");
    // A 6 KB file, read on the async command's worker, never the main thread.
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_copilot_cache(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cache's shape on 1.0.86, retyped with placeholders: the comment
    /// header, two token entries, and a Free plan whose premium bucket is
    /// empty and whose real cap is `chat`.
    const COPILOT_CACHE: &str = r#"// Disposable cache for Copilot user responses, safe to delete. Managed automatically.
// User settings belong in settings.json.
{
  "copilotUserCache": {
    "v1:aaaa": { "schemaVersion": 1, "retrievedAt": "2026-09-18T09:00:00.000Z", "response": {
      "copilot_plan": "individual", "quota_reset_date_utc": "2026-10-01T00:00:00.000Z",
      "quota_snapshots": {
        "premium_interactions": { "entitlement": 0, "percent_remaining": 0, "unlimited": false, "has_quota": false },
        "chat": { "entitlement": 200, "percent_remaining": 100, "unlimited": false, "has_quota": true }
      } } },
    "v1:bbbb": { "schemaVersion": 1, "retrievedAt": "2026-09-18T09:30:00.000Z", "response": {
      "copilot_plan": "individual", "quota_reset_date_utc": "2026-10-01T00:00:00.000Z",
      "quota_snapshots": {
        "premium_interactions": { "entitlement": 0, "percent_remaining": 0, "unlimited": false, "has_quota": false },
        "chat": { "entitlement": 200, "percent_remaining": 99.5, "unlimited": false, "has_quota": true }
      } } }
  }
}"#;

    #[test]
    fn devin_models_map_every_variant_to_its_window() {
        let v = serde_json::json!({ "families": [
            { "family_uid": "f", "variants": [
                { "model_uid": "swe-2-high", "max_context_tokens": 262144 },
                { "model_uid": "no-window" } ] },
            { "family_uid": "g", "variants": [ { "model_uid": "opus-x", "max_context_tokens": 1000000 } ] } ] });
        let m = parse_devin_models(&v);
        assert_eq!(m.get("swe-2-high"), Some(&262144));
        assert_eq!(m.get("opus-x"), Some(&1000000));
        assert_eq!(m.get("no-window"), None);
    }

    /// The session id lands inside a SQL string. A slug passes; anything that
    /// could close the quote never reaches sqlite3.
    #[test]
    fn devin_context_sql_takes_only_a_slug() {
        assert!(devin_context_sql("brassy-polish").unwrap().contains("s.id = 'brassy-polish'"));
        for bad in ["", "x' or '1'='1", "-lead", "a b", "a;b", "a'"] {
            assert_eq!(devin_context_sql(bad), None, "{bad:?}");
        }
    }

    /// Against a real sqlite3 and a database with devin's schema: the LAST
    /// assistant node with a count wins, user and tool nodes never do.
    #[test]
    #[cfg(unix)]
    fn devin_context_sql_reads_the_last_assistant_prompt_size() {
        if Command::new("sqlite3").arg("-version").output().is_err() { return; }
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("s.db");
        let setup = "create table sessions(id text primary key, model text, metadata text);\
            create table message_nodes(row_id integer primary key autoincrement, session_id text, node_id integer, parent_node_id integer, chat_message text, created_at integer, metadata text);\
            insert into sessions values('brassy-polish','swe-2-high','{}');\
            insert into message_nodes(session_id,node_id,chat_message,created_at,metadata) values\
            ('brassy-polish',1,'{\"role\":\"assistant\"}',0,'{\"num_tokens_preceding\":11881}'),\
            ('brassy-polish',2,'{\"role\":\"tool\"}',0,'{\"num_tokens_preceding\":null}'),\
            ('brassy-polish',3,'{\"role\":\"assistant\"}',0,'{\"num_tokens_preceding\":null}'),\
            ('brassy-polish',4,'{\"role\":\"assistant\"}',0,'{\"num_tokens_preceding\":12037}'),\
            ('brassy-polish',5,'{\"role\":\"user\"}',0,'{\"num_tokens_preceding\":99999}');";
        assert!(Command::new("sqlite3").arg(&db).arg(setup).status().unwrap().success());
        let out = Command::new("sqlite3").arg("-readonly").arg("-separator").arg("|").arg(&db)
            .arg(devin_context_sql("brassy-polish").unwrap()).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "swe-2-high|12037");
    }

    #[test]
    fn copilot_reads_the_newest_entry_and_the_bucket_that_has_a_cap() {
        let u = parse_copilot_cache(COPILOT_CACHE).unwrap();
        let w = u.session.expect("a monthly window");
        assert!((w.used_percent - 0.5).abs() < 1e-9, "newest entry, chat bucket: {w:?}");
        assert_eq!(w.resets_at, Some(1790812800));
        assert_eq!(u.weekly, None);
        assert_eq!(u.plan_type.as_deref(), Some("individual"));
    }

    #[test]
    fn copilot_prefers_premium_requests_on_a_paid_plan_and_shows_nothing_when_unlimited() {
        let paid = COPILOT_CACHE.replace(
            r#""premium_interactions": { "entitlement": 0, "percent_remaining": 0, "unlimited": false, "has_quota": false }"#,
            r#""premium_interactions": { "entitlement": 300, "percent_remaining": 60, "unlimited": false, "has_quota": true }"#,
        );
        assert!((parse_copilot_cache(&paid).unwrap().session.unwrap().used_percent - 40.0).abs() < 1e-9);
        let unlimited = COPILOT_CACHE.replace(r#""unlimited": false, "has_quota": true"#, r#""unlimited": true, "has_quota": true"#);
        assert_eq!(parse_copilot_cache(&unlimited).unwrap().session, None);
        assert!(parse_copilot_cache("// only a comment").is_err());
    }

    /// The shape codex answers with on a paid plan: a short window and a long
    /// one. Transcribed from the protocol schema, not pasted from a real
    /// account (see CLAUDE.md on fixtures).
    fn paid() -> serde_json::Value {
        serde_json::json!({
            "rateLimits": {
                "primary":   { "usedPercent": 58.0, "windowDurationMins": 300, "resetsAt": 1790000000i64 },
                "secondary": { "usedPercent": 41.0, "windowDurationMins": 10080, "resetsAt": 1790500000i64 },
                "planType": "pro"
            },
            "accountId": "00000000-0000-0000-0000-000000000000"
        })
    }

    /// The RPC against a REAL codex, end to end: spawn, handshake, method,
    /// parse. Everything above this tests the parse alone, and the parse is not
    /// where this breaks. The method name, the handshake shape and whether the
    /// app-server answers a client it has never seen are the parts that can be
    /// wrong, and only a live binary can say.
    ///
    /// `#[ignore]`d for the same reason `codex_hooks_install_...` is: CI has no
    /// codex on PATH and no login. Run it against a real one with
    ///
    /// ```sh
    /// cargo test codex_rate_limits_live -- --ignored --nocapture
    /// ```
    ///
    /// It asserts SHAPE, never a number: the percentages belong to whoever runs
    /// it and change by the hour.
    #[test]
    #[ignore = "needs a real, logged-in codex binary on PATH"]
    fn codex_rate_limits_live() {
        let usage = fetch_codex("codex", false, None).expect("codex should answer account/rateLimits/read");
        println!("{}", serde_json::to_string_pretty(&usage).unwrap());
        assert!(
            usage.session.is_some() || usage.weekly.is_some(),
            "a logged-in account reports at least one window"
        );
        for w in [usage.session.as_ref(), usage.weekly.as_ref()].into_iter().flatten() {
            assert!((0.0..=100.0).contains(&w.used_percent), "{w:?}");
        }
    }

    /// The regression that shipped in 1.2.1: the spawn inherited the GUI's
    /// minimal PATH, could not find `codex` in `~/.local/bin`, and the footer
    /// was silently empty in every release build.
    ///
    /// Asserted on the COMMAND rather than by running codex, so it holds on a
    /// machine that has none, which is every CI runner.
    #[test]
    fn the_app_server_spawn_carries_the_login_path() {
        let cmd = app_server_command("codex", Path::new("/Users/u/.codex"));
        let envs: Vec<_> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(),
                           v.map(|v| v.to_string_lossy().into_owned())))
            .collect();
        let path = envs.iter().find(|(k, _)| k == "PATH")
            .expect("PATH must be set explicitly, never inherited from the GUI");
        assert!(
            path.1.as_deref().is_some_and(|p| !p.is_empty()),
            "PATH was set to nothing, which is worse than not setting it"
        );
        assert!(
            envs.iter().any(|(k, v)| k == "CODEX_HOME"
                && v.as_deref() == Some("/Users/u/.codex")),
            "CODEX_HOME is how a clone is asked about its own login: {envs:?}"
        );
    }

    /// A Docker task's codex logs in INSIDE the container, against the config
    /// dir termic mounts there. Asking the host's `~/.codex` would report a
    /// different account's quota under this task's name, which is worse than
    /// reporting none: it looks authoritative and belongs to someone else.
    #[test]
    fn each_account_is_asked_at_its_own_codex_home() {
        // Two accounts reported the SAME percentage because `codex_home`
        // ignored the account and always pointed at the primary dir: it was
        // one login answering twice, under two names. That is the exact
        // misattribution the account-keyed usage store exists to prevent, and
        // it is invisible unless the two accounts happen to differ.
        crate::test_support::with_scratch_data_dir(|_| {
            let work = codex_home("codex", false, Some("Work")).expect("a named account resolves");
            let other = codex_home("codex", false, Some("Personal")).expect("...and so does another");
            assert_ne!(work, other, "two accounts must not share one CODEX_HOME");
            assert!(work.to_string_lossy().replace('\\', "/").contains("/logins/"), "{work:?}");

            // No account named: the agent's ordinary login, unchanged.
            let plain = codex_home("codex", false, None).expect("the plain path still resolves");
            assert_ne!(plain, work);
        });
    }

    #[test]
    fn a_docker_task_is_asked_about_the_mounted_config_dir() {
        let docker = codex_home("codex", true, None).expect("docker dir always resolves");
        assert!(
            docker.ends_with("docker-agents/codex"),
            "expected the termic-owned mounted dir, got {}",
            docker.display()
        );
        if let Ok(host) = codex_home("codex", false, None) {
            assert_ne!(host, docker);
        }
    }

    #[test]
    fn sorts_the_two_windows_by_duration() {
        let u = parse_codex_result(&paid());
        assert_eq!(u.session.as_ref().unwrap().used_percent, 58.0);
        assert_eq!(u.weekly.as_ref().unwrap().used_percent, 41.0);
        assert_eq!(u.session.as_ref().unwrap().resets_at, Some(1790000000));
        assert_eq!(u.plan_type.as_deref(), Some("pro"));
        assert!(u.account_id.is_some());
    }

    /// The bug this exists to prevent: reading `primary` as "the session
    /// window" files a free plan's 30-day window under 5h and paints a session
    /// bar that resets next month.
    #[test]
    fn a_free_plans_single_long_window_is_weekly_not_session() {
        let free = serde_json::json!({
            "rateLimits": {
                "primary": { "usedPercent": 49.0, "windowDurationMins": 43200, "resetsAt": 1790491695i64 },
                "secondary": serde_json::Value::Null,
                "planType": "free"
            }
        });
        let u = parse_codex_result(&free);
        assert!(u.session.is_none(), "a 30-day window is not a session window");
        assert_eq!(u.weekly.unwrap().used_percent, 49.0);
        assert_eq!(u.plan_type.as_deref(), Some("free"));
    }

    #[test]
    fn a_null_or_missing_rate_limits_is_empty_not_an_error() {
        assert_eq!(parse_codex_result(&serde_json::json!({})), AgentUsage::default());
        let no_windows = serde_json::json!({ "rateLimits": { "primary": null, "secondary": null } });
        let u = parse_codex_result(&no_windows);
        assert!(u.session.is_none() && u.weekly.is_none());
    }

    #[test]
    fn percentages_are_clamped_so_a_bar_cannot_overflow() {
        let over = serde_json::json!({
            "rateLimits": { "primary": { "usedPercent": 140.0, "windowDurationMins": 300 } }
        });
        assert_eq!(parse_codex_result(&over).session.unwrap().used_percent, 100.0);
    }

    // -- devin ---------------------------------------------------------------

    /// The shape GetUserStatus answers with on a paid devin plan: daily and
    /// weekly REMAINING percents, reset epochs as int64-strings, the plan name
    /// nested under planInfo. Field names transcribed from the measured
    /// response; values are invented (see CLAUDE.md on fixtures).
    fn devin_pro() -> serde_json::Value {
        serde_json::json!({
            "userStatus": {
                "userId": "user-0000000000000000000000000000dead",
                "planStatus": {
                    "planInfo": { "planName": "Pro" },
                    "dailyQuotaRemainingPercent": 87,
                    "weeklyQuotaRemainingPercent": 62,
                    "dailyQuotaResetAtUnix": "1790000000",
                    "weeklyQuotaResetAtUnix": "1790500000"
                }
            }
        })
    }

    #[test]
    fn devin_remaining_percents_become_used() {
        let u = parse_devin_result(&devin_pro());
        // 87 remaining -> 13 used. Reporting the raw field would paint a
        // nearly-empty day as a nearly-full bar.
        assert_eq!(u.session.as_ref().unwrap().used_percent, 13.0);
        assert_eq!(u.weekly.as_ref().unwrap().used_percent, 38.0);
        assert_eq!(u.session.unwrap().resets_at, Some(1790000000));
        assert_eq!(u.weekly.unwrap().resets_at, Some(1790500000));
        assert_eq!(u.plan_type.as_deref(), Some("Pro"));
        assert_eq!(u.account_id.as_deref(), Some("user-0000000000000000000000000000dead"));
    }

    #[test]
    fn devin_windows_tolerate_number_or_string_fields() {
        // proto3-JSON renders int64 as strings and int32 as numbers; a server
        // or version that flips one must not blank the footer.
        let mut v = devin_pro();
        v["userStatus"]["planStatus"]["dailyQuotaRemainingPercent"] =
            serde_json::json!("40");
        let u = parse_devin_result(&v);
        assert_eq!(u.session.unwrap().used_percent, 60.0);
    }

    #[test]
    fn devin_plan_status_absent_is_empty_not_an_error() {
        // A plan without quota windows (or an error response shaped like
        // `{"code":..,"message":..}`) yields no windows rather than a fake 0%.
        assert_eq!(parse_devin_result(&serde_json::json!({})), AgentUsage::default());
        let u = parse_devin_result(&serde_json::json!({ "userStatus": {} }));
        assert!(u.session.is_none() && u.weekly.is_none() && u.plan_type.is_none());
    }

    /// The shape an ACU-billed (Enterprise) devin account answers with:
    /// unlimited credits, no quota windows, `acuConsumed` since `planStart`.
    /// Field names transcribed from the measured response; values invented.
    fn devin_enterprise() -> serde_json::Value {
        serde_json::json!({
            "userStatus": {
                "userId": "user-0000000000000000000000000000beef",
                "planStatus": {
                    "planInfo": {
                        "planName": "Enterprise",
                        "billingStrategy": "BILLING_STRATEGY_ACU",
                        "monthlyPromptCredits": -1
                    },
                    "planStart": "2030-01-10T08:00:00Z",
                    "planEnd": "2030-02-10T08:00:00Z",
                    "availablePromptCredits": -1,
                    "acuConsumed": 12.345
                }
            }
        })
    }

    #[test]
    fn devin_uncapped_plan_reports_what_it_consumed_this_period() {
        let u = parse_devin_result(&devin_enterprise());
        assert!(u.session.is_none() && u.weekly.is_none(), "no quota means no fake percentage");
        let c = u.consumed.expect("an ACU plan's consumption is its readout");
        assert_eq!(c.amount, 12.345);
        assert_eq!(c.unit, "ACU");
        assert_eq!(c.period_start, Some(1894262400));
        assert_eq!(c.period_end, Some(1896940800));
    }

    #[test]
    fn devin_consumption_yields_to_a_quota_window() {
        // A capped plan that also carries acuConsumed: the percentage of the
        // cap is the number to watch, and two readouts would compete.
        let mut v = devin_pro();
        v["userStatus"]["planStatus"]["acuConsumed"] = serde_json::json!(3.0);
        assert!(parse_devin_result(&v).consumed.is_none());
        assert!(parse_devin_result(&devin_pro()).consumed.is_none());
    }

    #[test]
    fn devin_consumption_without_dates_still_reads() {
        let mut v = devin_enterprise();
        v["userStatus"]["planStatus"]["planEnd"] = serde_json::json!("not a date");
        v["userStatus"]["planStatus"].as_object_mut().unwrap().remove("planStart");
        let c = parse_devin_result(&v).consumed.unwrap();
        assert_eq!((c.period_start, c.period_end), (None, None));
    }

    /// The credential path is the whole per-account story: two named accounts
    /// must resolve to different credentials.toml, or both chips would report
    /// the primary login's quota under two names.
    #[test]
    fn each_devin_account_is_asked_at_its_own_store() {
        crate::test_support::with_scratch_data_dir(|_| {
            let work = devin_credentials("devin", false, Some("Work")).expect("a named account resolves");
            let other = devin_credentials("devin", false, Some("Personal")).expect("...and so does another");
            assert_ne!(work, other, "two accounts must not share one credentials.toml");
            assert!(work.to_string_lossy().replace('\\', "/").contains("/logins/"), "{work:?}");
            // XDG_DATA_HOME=<store>, devin appends `devin/credentials.toml`.
            assert!(work.to_string_lossy().replace('\\', "/").ends_with("devin/credentials.toml"), "{work:?}");

            let plain = devin_credentials("devin", false, None).expect("the plain path resolves");
            assert!(plain.to_string_lossy().replace('\\', "/").ends_with(".local/share/devin/credentials.toml"), "{plain:?}");
        });
    }

    /// devin declines a Docker config mount, so a container login is inside
    /// the container and the host cannot answer for it. An honest error beats
    /// reporting the host's quota under the task's name.
    #[test]
    fn a_docker_devin_has_no_host_credential() {
        assert!(devin_credentials("devin", true, None).is_err());
    }

    /// The full call against a REAL devin login: reads the actual
    /// credentials.toml and posts GetUserStatus to the actual server.
    /// `#[ignore]`d like `codex_rate_limits_live` - CI has no credential and
    /// must not see network. Run it with
    ///
    /// ```sh
    /// cargo test devin_user_status_live -- --ignored --nocapture
    /// ```
    ///
    /// Asserts SHAPE, never a number: the percentages belong to whoever runs
    /// it and change by the hour.
    #[test]
    #[ignore = "needs a real, logged-in devin credential on this machine"]
    fn devin_user_status_live() {
        let usage = tauri::async_runtime::block_on(fetch_devin("devin", false, None))
            .expect("devin's API should answer GetUserStatus");
        println!("{}", serde_json::to_string_pretty(&usage).unwrap());
        assert!(
            usage.session.is_some() || usage.weekly.is_some(),
            "a logged-in plan reports at least one window"
        );
        for w in [usage.session.as_ref(), usage.weekly.as_ref()].into_iter().flatten() {
            assert!((0.0..=100.0).contains(&w.used_percent), "{w:?}");
        }
    }

    /// A window with no duration at all still shows up, as the session one.
    /// Dropping it would be a silently empty footer on a schema change.
    #[test]
    fn a_window_without_a_duration_degrades_to_session() {
        let bare = serde_json::json!({
            "rateLimits": { "primary": { "usedPercent": 12.0 } }
        });
        let u = parse_codex_result(&bare);
        assert_eq!(u.session.unwrap().used_percent, 12.0);
        assert!(u.weekly.is_none());
    }
}
