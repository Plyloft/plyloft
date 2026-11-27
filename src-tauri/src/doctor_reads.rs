//! OB-2 — what the dependency doctor reads around the shell probe.
//!
//!  - **Codex's sign-in**, from file presence only: `auth.json` in the real
//!    `CODEX_HOME`, beside `config.toml`'s `cli_auth_credentials_store`
//!    (MEASUREMENTS §3). No process: `codex login status` runs only in
//!    Setup's AI step (OB-5), never from here.
//!  - **The git identity**, read only (`git config --global --get`), and only
//!    when git works — on a Mac without the Command Line Tools no git runs.
//!  - **Each tool's newest release** (D6), from the vendor's own feed
//!    (MEASUREMENTS §4): read only by a Diagnostics read, never at startup,
//!    each request bounded to five seconds, the answer cached; offline reads
//!    as nothing, so no update line is shown.
//!
//! `doctor::build_report_with` stays pure; the command hands it these.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::doctor::{CodexStore, CredentialSeen, LatestVersions};
use crate::shell_env::ShellEnv;

// ── Codex sign-in ──────────────────────────────────────────────────────

/// Where Codex keeps its login, and whether `auth.json` is there, in the
/// real `CODEX_HOME` (the user's, never an overlay of Ply's).
pub fn codex_auth() -> (CodexStore, CredentialSeen) {
    codex_auth_in(&crate::codex_home::real_codex_home())
}

pub fn codex_auth_in(home: &Path) -> (CodexStore, CredentialSeen) {
    let store = match std::fs::read_to_string(home.join("config.toml")) {
        Ok(text) => codex_store_from_config(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CodexStore::File,
        Err(_) => CodexStore::Unreadable,
    };
    let file = match std::fs::metadata(home.join("auth.json")) {
        Ok(meta) if meta.is_file() => CredentialSeen::Present,
        Ok(_) => CredentialSeen::Absent,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => CredentialSeen::Absent,
        Err(_) => CredentialSeen::Unreadable,
    };
    (store, file)
}

/// Pure: `cli_auth_credentials_store` — `file` or unset is the file store;
/// `keyring`, `auto` (or a value Ply doesn't know) may keep the login in the
/// keychain, so a missing `auth.json` says nothing.
pub fn codex_store_from_config(text: &str) -> CodexStore {
    match toml::from_str::<toml::Table>(text) {
        Ok(table) => match table.get("cli_auth_credentials_store").and_then(|v| v.as_str()) {
            None | Some("file") => CodexStore::File,
            Some(_) => CodexStore::Keyring,
        },
        Err(_) => CodexStore::Unreadable,
    }
}

// ── Git identity ───────────────────────────────────────────────────────

/// `(user.name, user.email)` from `git config --global --get`, or `None`
/// when git doesn't work (never run: the CLT shim) or can't be asked.
pub fn git_identity(env: &ShellEnv) -> Option<(Option<String>, Option<String>)> {
    if !env.git_works() {
        return None;
    }
    let git = env.git_path.as_deref()?;
    let get = |key: &str| -> Option<Option<String>> {
        let mut command = crate::platform::new_command(git);
        // OB-6 review (P3-3): an identity kept in an `[include]`d file counts.
        command
            .args(["config", "--global", "--includes", "--get", key])
            .env("PATH", &env.path);
        let out = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(5)).ok()?;
        // Exit 1 = not set; anything else unreadable is "not asked".
        if out.status.success() {
            let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Some((!value.is_empty()).then_some(value))
        } else if out.status.code() == Some(1) {
            Some(None)
        } else {
            None
        }
    };
    Some((get("user.name")?, get("user.email")?))
}

// ── Newest releases (D6) ───────────────────────────────────────────────

/// A read answer is kept this long.
pub const LATEST_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// A read that learnt nothing (offline) is not retried sooner than this, so
/// the Diagnostics watch does not ask the network every three seconds.
pub const LATEST_EMPTY_TTL: Duration = Duration::from_secs(10 * 60);
/// Each request's bound.
pub const LATEST_TIMEOUT: Duration = Duration::from_secs(5);

pub const CLAUDE_FEED: &str = "https://downloads.claude.ai/claude-code-releases/";
pub const CODEX_FEED: &str = "https://releases.openai.com/codex/channels/latest";
pub const GH_FEED: &str = "https://github.com/cli/cli/releases/latest";

static LATEST: Mutex<Option<(Instant, LatestVersions)>> = Mutex::new(None);

/// What a doctor read does about the newest releases.
#[derive(Debug, Clone, PartialEq)]
pub enum LatestPlan {
    /// Say nothing (no read asked, nothing fresh remembered).
    Nothing,
    /// Show what was learnt a moment ago.
    Reuse(LatestVersions),
    /// Read the feeds.
    Fetch,
}

/// Pure: only a read that asks (Diagnostics) fetches, and even it reuses a
/// fresh answer. App launch, the welcome screen and the sidebar never ask, so
/// they never touch the network; they show a fresh remembered answer only.
pub fn latest_plan(asked: bool, remembered: Option<(Duration, LatestVersions)>) -> LatestPlan {
    if let Some((age, latest)) = remembered {
        let ttl = if latest == LatestVersions::default() { LATEST_EMPTY_TTL } else { LATEST_TTL };
        if age < ttl {
            return LatestPlan::Reuse(latest);
        }
    }
    if asked {
        LatestPlan::Fetch
    } else {
        LatestPlan::Nothing
    }
}

/// The newest releases for this read, fetched only when `asked`.
pub fn latest_versions(asked: bool, path: &str) -> LatestVersions {
    let remembered = LATEST
        .lock()
        .ok()
        .and_then(|held| held.clone())
        .map(|(at, latest)| (at.elapsed(), latest));
    match latest_plan(asked, remembered) {
        LatestPlan::Nothing => LatestVersions::default(),
        LatestPlan::Reuse(latest) => latest,
        LatestPlan::Fetch => {
            let latest = fetch_latest(path);
            if let Ok(mut held) = LATEST.lock() {
                *held = Some((Instant::now(), latest.clone()));
            }
            latest
        }
    }
}

/// The three feeds at once, each bounded: the whole read waits five seconds
/// at most.
fn fetch_latest(path: &str) -> LatestVersions {
    let channel = claude_channel(claude_settings().as_deref());
    let claude_url = format!("{CLAUDE_FEED}{channel}");
    let p1 = path.to_string();
    let p2 = path.to_string();
    let p3 = path.to_string();
    let claude = std::thread::spawn(move || curl(&["-fsS", &claude_url], &p1).and_then(|b| parse_claude_latest(&b)));
    let codex = std::thread::spawn(move || curl(&["-fsS", CODEX_FEED], &p2).and_then(|b| parse_codex_latest(&b)));
    let gh = std::thread::spawn(move || curl(&["-fsSI", GH_FEED], &p3).and_then(|b| parse_gh_latest(&b)));
    LatestVersions {
        claude: claude.join().ok().flatten(),
        codex: codex.join().ok().flatten(),
        gh: gh.join().ok().flatten(),
    }
}

/// One bounded `curl` (on macOS and on Windows 10 and later). Its own process
/// group, killed at the bound and on app exit.
fn curl(args: &[&str], path: &str) -> Option<String> {
    let mut command = crate::platform::new_command("curl");
    command
        .args(["--max-time", &LATEST_TIMEOUT.as_secs().to_string()])
        .args(args)
        .env("PATH", path);
    let out = crate::worktrees::run_bounded_output(&mut command, LATEST_TIMEOUT + Duration::from_secs(1)).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Claude Code's own settings file, where `autoUpdatesChannel` lives.
fn claude_settings() -> Option<String> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| crate::platform::home_dir().map(|h| h.join(".claude")))?;
    std::fs::read_to_string(dir.join("settings.json")).ok()
}

/// Pure (MEASUREMENTS §4): the channel Claude Code updates from — `stable`
/// when the user chose it, else `latest` (the default). Compared against the
/// user's own channel, so a `stable` user is not told about a `latest` build.
pub fn claude_channel(settings_json: Option<&str>) -> &'static str {
    let chosen = settings_json
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|v| v.get("autoUpdatesChannel").and_then(|c| c.as_str()).map(str::to_string));
    if chosen.as_deref() == Some("stable") {
        "stable"
    } else {
        "latest"
    }
}

fn plain_version(text: &str) -> Option<String> {
    let v = text.trim().trim_start_matches("rust-v").trim_start_matches('v');
    crate::shell_env::parse_semver(v).map(|_| v.to_string())
}

/// Pure: `downloads.claude.ai/claude-code-releases/<channel>` is the version
/// alone (`2.1.283`).
pub fn parse_claude_latest(body: &str) -> Option<String> {
    plain_version(body)
}

/// Pure: `releases.openai.com/codex/channels/latest` → `tag_name`
/// (`rust-v0.157.1`).
pub fn parse_codex_latest(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    plain_version(json.get("tag_name")?.as_str()?)
}

/// Pure: the `releases/latest` redirect's `location: …/releases/tag/v2.101.0`.
pub fn parse_gh_latest(headers: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case("location") {
            return None;
        }
        plain_version(value.trim().rsplit_once("/tag/")?.1)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_config_is_the_file_store() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(codex_auth_in(dir.path()), (CodexStore::File, CredentialSeen::Absent));
        std::fs::write(dir.path().join("auth.json"), "{}").unwrap();
        assert_eq!(codex_auth_in(dir.path()), (CodexStore::File, CredentialSeen::Present));
    }

    #[test]
    fn keyring_and_auto_stores_make_a_missing_file_unknowable() {
        assert_eq!(codex_store_from_config(""), CodexStore::File);
        assert_eq!(codex_store_from_config("model = \"o3\"\n"), CodexStore::File);
        assert_eq!(codex_store_from_config("cli_auth_credentials_store = \"file\"\n"), CodexStore::File);
        assert_eq!(codex_store_from_config("cli_auth_credentials_store = \"keyring\"\n"), CodexStore::Keyring);
        assert_eq!(codex_store_from_config("cli_auth_credentials_store = \"auto\"\n"), CodexStore::Keyring);
        assert_eq!(codex_store_from_config("this is = = not toml"), CodexStore::Unreadable);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.toml"), "cli_auth_credentials_store = \"keyring\"\n").unwrap();
        assert_eq!(codex_auth_in(dir.path()), (CodexStore::Keyring, CredentialSeen::Absent));
    }

    #[test]
    fn identity_is_never_read_while_git_does_not_work() {
        // The CLT shim: resolved, never run, so nothing is asked of it.
        let env = ShellEnv { git_path: Some("/usr/bin/git".into()), ..ShellEnv::default() };
        assert_eq!(git_identity(&env), None);
    }

    #[test]
    fn only_a_read_that_asks_fetches_and_a_fresh_answer_is_reused() {
        let some = LatestVersions { claude: Some("2.1.290".into()), ..LatestVersions::default() };
        // App launch, the welcome screen, the sidebar: never the network.
        assert_eq!(latest_plan(false, None), LatestPlan::Nothing);
        assert_eq!(latest_plan(false, Some((LATEST_TTL, some.clone()))), LatestPlan::Nothing);
        // Diagnostics.
        assert_eq!(latest_plan(true, None), LatestPlan::Fetch);
        assert_eq!(latest_plan(true, Some((Duration::from_secs(60), some.clone()))), LatestPlan::Reuse(some.clone()));
        assert_eq!(latest_plan(false, Some((Duration::from_secs(60), some.clone()))), LatestPlan::Reuse(some));
        assert_eq!(latest_plan(true, Some((LATEST_TTL, LatestVersions::default()))), LatestPlan::Fetch);
        // Offline: not asked again for ten minutes (the watch polls every 3 s).
        assert_eq!(
            latest_plan(true, Some((Duration::from_secs(30), LatestVersions::default()))),
            LatestPlan::Reuse(LatestVersions::default())
        );
        assert_eq!(latest_plan(true, Some((LATEST_EMPTY_TTL, LatestVersions::default()))), LatestPlan::Fetch);
    }

    #[test]
    fn each_feed_is_read_the_way_it_was_measured() {
        assert_eq!(parse_claude_latest("2.1.283\n").as_deref(), Some("2.1.283"));
        assert_eq!(parse_claude_latest("<html>not found</html>"), None);
        assert_eq!(
            parse_codex_latest(r#"{"assets":[],"tag_name":"rust-v0.157.1"}"#).as_deref(),
            Some("0.157.1")
        );
        assert_eq!(parse_codex_latest("{}"), None);
        assert_eq!(parse_codex_latest("offline"), None);
        let headers = "HTTP/2 302 \r\ndate: x\r\nlocation: https://github.com/cli/cli/releases/tag/v2.101.0\r\n\r\n";
        assert_eq!(parse_gh_latest(headers).as_deref(), Some("2.101.0"));
        assert_eq!(parse_gh_latest("HTTP/2 200 \r\n\r\n"), None);
    }

    #[test]
    fn claude_is_compared_with_the_users_own_channel() {
        assert_eq!(claude_channel(None), "latest");
        assert_eq!(claude_channel(Some("{}")), "latest");
        assert_eq!(claude_channel(Some(r#"{"autoUpdatesChannel":"stable"}"#)), "stable");
        assert_eq!(claude_channel(Some(r#"{"autoUpdatesChannel":"latest"}"#)), "latest");
        assert_eq!(claude_channel(Some("not json")), "latest");
    }

    #[test]
    fn nothing_here_runs_a_status_command() {
        // D2/D4: `claude auth status` and `codex login status` run only in
        // Setup's AI step. Nothing the doctor reads may run them.
        let code: String = include_str!("doctor_reads.rs")
            .lines()
            .take_while(|line| !line.starts_with("#[cfg(test)]"))
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["\"status\"", "auth status", "login status", "\"login\""] {
            assert!(!code.contains(forbidden), "doctor_reads.rs must not use {forbidden}");
        }
    }

    /// By hand, online: `cargo test --lib doctor_reads::tests::the_feeds_answer -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn the_feeds_answer() {
        let path = std::env::var("PATH").unwrap_or_default();
        println!("{:?}", fetch_latest(&path));
    }
}
