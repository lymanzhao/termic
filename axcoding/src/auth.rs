//! Auth resolution for the axcoding binaries.
//!
//! Chain, most specific first:
//! 1. env `ANTHROPIC_API_KEY`          (x-api-key semantics)
//! 2. env `ANTHROPIC_AUTH_TOKEN`       (Authorization: Bearer; this is what
//!    provider switchers like cc-switch write, alongside ANTHROPIC_BASE_URL)
//! 3. env `OPENAI_API_KEY`
//! 4. the auth file (`$AXCODING_HOME`/auth.json, default `~/.axcoding/`)
//!
//! Nothing here ever prints a key. `--check-auth` reports sources, the
//! error names every place that was looked, and `auth import` copies the
//! provider config Claude Code's settings.json env block (where cc-switch
//! and friends write) into the auth file without echoing secrets.

use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    /// x-api-key header (Anthropic-style API key).
    ApiKey,
    /// Authorization: Bearer header (relay/switcher-style token).
    AuthToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    OpenAi,
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub provider: Provider,
    pub kind: AuthKind,
    pub key: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// Human-readable origin, for `--check-auth` output.
    pub source: &'static str,
}

/// The auth file's shape. Every field optional; `auth_token` and `api_key`
/// are mutually exclusive in practice (auth_token wins if both appear).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AuthFile {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// `$AXCODING_HOME` or `~/.axcoding`. termic's login store relocates the
/// dir with AXCODING_HOME, which is what makes account switching possible.
pub fn axcoding_home(home: Option<&str>) -> PathBuf {
    if let Ok(v) = std::env::var("AXCODING_HOME") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    match home {
        Some(h) if !h.is_empty() => PathBuf::from(h).join(".axcoding"),
        _ => PathBuf::from(".axcoding"),
    }
}

pub fn auth_file_path() -> PathBuf {
    let home = std::env::var("HOME").ok();
    axcoding_home(home.as_deref()).join("auth.json")
}

/// Process env, gathered once so `resolve` stays pure and testable.
#[derive(Debug, Default, Clone)]
pub struct EnvSnapshot {
    pub anthropic_api_key: Option<String>,
    pub anthropic_auth_token: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub openai_api_key: Option<String>,
}

impl EnvSnapshot {
    pub fn from_process() -> Self {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        Self {
            anthropic_api_key: get("ANTHROPIC_API_KEY"),
            anthropic_auth_token: get("ANTHROPIC_AUTH_TOKEN"),
            anthropic_base_url: get("ANTHROPIC_BASE_URL"),
            openai_api_key: get("OPENAI_API_KEY"),
        }
    }
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

/// Walk the chain. `file` is the auth.json TEXT, already read by the
/// caller (the bin reads the real path; tests pass explicit strings), so
/// `None` cleanly means "no file" and tests never touch the filesystem.
pub fn resolve(env: &EnvSnapshot, file: Option<&str>) -> Result<AuthConfig, String> {
    if let Some(k) = non_empty(env.anthropic_api_key.clone()) {
        return Ok(AuthConfig {
            provider: Provider::Anthropic,
            kind: AuthKind::ApiKey,
            key: k,
            base_url: non_empty(env.anthropic_base_url.clone()),
            model: None,
            source: "ANTHROPIC_API_KEY",
        });
    }
    if let Some(t) = non_empty(env.anthropic_auth_token.clone()) {
        return Ok(AuthConfig {
            provider: Provider::Anthropic,
            kind: AuthKind::AuthToken,
            key: t,
            base_url: non_empty(env.anthropic_base_url.clone()),
            model: None,
            source: "ANTHROPIC_AUTH_TOKEN",
        });
    }
    if let Some(k) = non_empty(env.openai_api_key.clone()) {
        return Ok(AuthConfig {
            provider: Provider::OpenAi,
            kind: AuthKind::ApiKey,
            key: k,
            base_url: None,
            model: None,
            source: "OPENAI_API_KEY",
        });
    }

    if let Some(raw) = file {
        let path = auth_file_path();
        let parsed: AuthFile = serde_json::from_str(raw)
            .map_err(|e| format!("auth file {} is not valid JSON: {e}", path.display()))?;
        let base_url = non_empty(parsed.base_url.clone());
        let model = non_empty(parsed.model.clone());
        if let Some(t) = non_empty(parsed.auth_token.clone()) {
            return Ok(AuthConfig {
                provider: Provider::Anthropic,
                kind: AuthKind::AuthToken,
                key: t,
                base_url,
                model,
                source: "auth file",
            });
        }
        if let Some(k) = non_empty(parsed.api_key.clone()) {
            let openai = parsed
                .provider
                .as_deref()
                .map(|p| p.eq_ignore_ascii_case("openai"))
                .unwrap_or(false);
            return Ok(AuthConfig {
                provider: if openai { Provider::OpenAi } else { Provider::Anthropic },
                kind: AuthKind::ApiKey,
                key: k,
                base_url,
                model,
                source: "auth file",
            });
        }
        return Err(format!(
            "auth file {} has neither auth_token nor api_key",
            path.display()
        ));
    }

    Err(format!(
        "not authenticated. Looked in: ANTHROPIC_API_KEY (unset), \
         ANTHROPIC_AUTH_TOKEN (unset), OPENAI_API_KEY (unset), {} (missing). \
         Run `axcoding-agent auth import` to copy the provider config from \
         Claude Code's settings.json (where cc-switch and similar tools write), \
         or set one of those variables.",
        auth_file_path().display()
    ))
}

/// Read the auth file from disk and resolve, the way the bins call it.
pub fn resolve_from_process() -> Result<AuthConfig, String> {
    let raw = std::fs::read_to_string(auth_file_path()).ok();
    resolve(&EnvSnapshot::from_process(), raw.as_deref())
}

/// `ANTHROPIC_MODEL` (and friends) carry Claude Code context aliases as a
/// bracket suffix - `glm-5.3-flash[1M]` - which the raw Messages API does
/// not accept as a model code ([1211] model-not-found on bigmodel). Strip
/// it for the wire; users who want the suffix semantics are using Claude
/// Code, not this binary.
pub fn strip_model_alias(model: &str) -> String {
    match model.find('[') {
        Some(at) if model.ends_with(']') && at > 0 => model[..at].to_string(),
        _ => model.to_string(),
    }
}

/// What `auth import` found and wrote. Field names only, never values.
#[derive(Debug)]
pub struct ImportSummary {
    pub wrote: PathBuf,
    pub auth_token: bool,
    pub api_key: bool,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

/// Copy the provider config from Claude Code's settings.json env block -
/// where cc-switch and similar switchers persist the active provider -
/// into the axcoding auth file. The output path is a parameter so tests
/// never touch the real `$HOME`; the bin passes `auth_file_path()`.
/// Refuses to overwrite an existing file without `force`: switching
/// providers in cc-switch does NOT update this copy, so re-running import
/// is a deliberate act.
pub fn import_from_claude_settings(
    claude_settings: &str,
    out: &PathBuf,
    force: bool,
) -> Result<ImportSummary> {
    let parsed: serde_json::Value =
        serde_json::from_str(claude_settings).context("claude settings.json is not valid JSON")?;
    let env = match parsed.get("env").and_then(|e| e.as_object()) {
        Some(e) => e,
        None => bail!("claude settings.json has no env block"),
    };

    let str_field = |name: &str| {
        env.get(name)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|v| !v.trim().is_empty())
    };
    let auth_token = str_field("ANTHROPIC_AUTH_TOKEN");
    let api_key = str_field("ANTHROPIC_API_KEY");
    if auth_token.is_none() && api_key.is_none() {
        bail!("claude settings.json env block has neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY");
    }
    let file = AuthFile {
        provider: Some("anthropic".into()),
        auth_token,
        api_key,
        base_url: str_field("ANTHROPIC_BASE_URL"),
        model: str_field("ANTHROPIC_MODEL")
            .or_else(|| str_field("ANTHROPIC_DEFAULT_SONNET_MODEL"))
            .map(|m| strip_model_alias(&m)),
    };
    let summary = ImportSummary {
        wrote: out.clone(),
        auth_token: file.auth_token.is_some(),
        api_key: file.api_key.is_some(),
        base_url: file.base_url.clone(),
        model: file.model.clone(),
    };

    if out.exists() && !force {
        bail!(
            "{} already exists; pass --force to overwrite (note: a later provider \
             switch in cc-switch does not update this copy, so re-import when you switch)",
            out.display()
        );
    }
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("create {}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(&file)?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(out)?;
    f.write_all(json.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(out, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(
        api: Option<&str>,
        token: Option<&str>,
        base: Option<&str>,
        openai: Option<&str>,
    ) -> EnvSnapshot {
        EnvSnapshot {
            anthropic_api_key: api.map(str::to_string),
            anthropic_auth_token: token.map(str::to_string),
            anthropic_base_url: base.map(str::to_string),
            openai_api_key: openai.map(str::to_string),
        }
    }

    #[test]
    fn precedence_is_env_then_file() {
        // AUTH_TOKEN beats the file; API_KEY beats AUTH_TOKEN.
        let r = resolve(&env(Some("k"), None, None, None), None).unwrap();
        assert_eq!(r.kind, AuthKind::ApiKey);
        assert_eq!(r.source, "ANTHROPIC_API_KEY");

        let r = resolve(&env(None, Some("t"), Some("https://relay.example/v1"), None), None)
            .unwrap();
        assert_eq!(r.kind, AuthKind::AuthToken);
        assert_eq!(r.base_url.as_deref(), Some("https://relay.example/v1"));

        let file = r#"{"auth_token":"ft","base_url":"https://file.example","model":"glm-x"}"#;
        let r = resolve(&env(None, Some("t"), None, None), Some(file)).unwrap();
        assert_eq!(r.source, "ANTHROPIC_AUTH_TOKEN", "env must win over the file");

        let r = resolve(&env(None, None, None, None), Some(file)).unwrap();
        assert_eq!(r.source, "auth file");
        assert_eq!(r.model.as_deref(), Some("glm-x"));

        // OPENAI env beats the file too (env is more specific to the session).
        let r = resolve(&env(None, None, None, Some("ok")), Some(file)).unwrap();
        assert_eq!(r.provider, Provider::OpenAi);
    }

    #[test]
    fn openai_provider_flag_in_file() {
        let file = r#"{"provider":"openai","api_key":"sk-x"}"#;
        let r = resolve(&env(None, None, None, None), Some(file)).unwrap();
        assert_eq!(r.provider, Provider::OpenAi);
        assert_eq!(r.kind, AuthKind::ApiKey);
    }

    #[test]
    fn error_names_every_place_looked() {
        let e = resolve(&env(None, None, None, None), None).unwrap_err();
        assert!(e.contains("ANTHROPIC_API_KEY"));
        assert!(e.contains("ANTHROPIC_AUTH_TOKEN"));
        assert!(e.contains("OPENAI_API_KEY"));
        assert!(e.contains("auth.json"));
        assert!(e.contains("auth import"));
    }

    #[test]
    fn blank_values_count_as_unset() {
        let r = resolve(&env(Some("  "), None, None, None), None);
        assert!(r.is_err(), "blank key must not authenticate");
    }

    #[test]
    fn import_maps_the_claude_env_block() {
        let dir = std::env::temp_dir().join(format!("axcoding-auth-test-{}", std::process::id()));
        let out = dir.join("auth.json");
        std::fs::remove_dir_all(&dir).ok();
        let settings = r#"{"env":{
            "ANTHROPIC_AUTH_TOKEN":"tok-abc",
            "ANTHROPIC_BASE_URL":"https://relay.example/api/anthropic",
            "ANTHROPIC_MODEL":"glm-x[1M]"
        }}"#;
        let s = import_from_claude_settings(settings, &out, false).unwrap();
        assert!(s.auth_token);
        assert!(!s.api_key);
        assert_eq!(s.base_url.as_deref(), Some("https://relay.example/api/anthropic"));
        // The [1M] context alias is Claude Code's, not a model code.
        assert_eq!(s.model.as_deref(), Some("glm-x"));
        // The file must actually hold it, and be 0600.
        let written = std::fs::read_to_string(&s.wrote).unwrap();
        assert!(written.contains("tok-abc"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&s.wrote).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Refuses to overwrite without force.
        assert!(import_from_claude_settings(settings, &out, false).is_err());
        assert!(import_from_claude_settings(settings, &out, true).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_refuses_settings_without_credentials() {
        let out = std::env::temp_dir().join("axcoding-auth-test-refuse.json");
        assert!(import_from_claude_settings(r#"{"env":{}}"#, &out, true).is_err());
        assert!(import_from_claude_settings("not json", &out, true).is_err());
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn model_alias_suffix_is_stripped_for_the_wire() {
        assert_eq!(strip_model_alias("glm-5.3-flash[1M]"), "glm-5.3-flash");
        assert_eq!(strip_model_alias("glm-5.3"), "glm-5.3");
        // Not a suffix-shaped string: keep verbatim.
        assert_eq!(strip_model_alias("claude-sonnet-4-6"), "claude-sonnet-4-6");
        assert_eq!(strip_model_alias("[1M]"), "[1M]");
        assert_eq!(strip_model_alias("weird[unclosed"), "weird[unclosed");
    }
}
