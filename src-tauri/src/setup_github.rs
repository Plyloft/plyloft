//! OB-7a — Setup's GitHub step (onboarding spec §5 step 5): its reads.
//!
//! Detection only; nothing here changes the machine. Installs, sign-ins,
//! `gh auth setup-git` and `gh auth refresh` run in the guided terminal from
//! the allowlist (`setup_actions`), never from here.
//!
//! - **Accounts**: `gh auth status --json hosts` — every github.com account,
//!   not `--active`, so the step can list several. Only the login, whether
//!   it is the active one, its state and its scopes are kept: a token (gh
//!   masks it unless asked, but whatever it prints) is never read into a
//!   field, returned, logged or written.
//! - **Git's credential helper** for github.com: `git config --get-regexp`
//!   over `credential.helper` and `credential.<url>.helper`, in config order
//!   (system, global, local), so the step offers `gh auth setup-git` only
//!   when git doesn't already ask gh — or, on Windows, Git Credential
//!   Manager, which signs in to GitHub by itself.
//! - **GitHub's address** for the identity back-fill: `gh api user`'s public
//!   email, else the account's private noreply address.
//! - **Single sign-on**: a SAML refusal in a gh answer names the
//!   organisation; `Authorize` opens its SSO page, the URL built here from a
//!   validated login (the frontend never sends a URL).
//!
//! The parsing is pure and tested in `setup_github_tests.rs`.

use serde::Serialize;
use std::time::Duration;

use crate::setup_actions::GITHUB_HOST;

/// One github.com account's state, as the step words it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccountState {
    /// gh checked the token with GitHub and it works.
    SignedIn,
    /// GitHub refused the token (HTTP 401): revoked or expired.
    Refused,
    /// gh couldn't check (offline, a locked keychain, a timeout).
    Unknown,
}

/// One github.com account in `gh auth status --json hosts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAccount {
    pub login: String,
    pub active: bool,
    pub state: AccountState,
    /// `"gist, read:org, repo"`, when gh says (a classic OAuth token).
    pub scopes: Option<String>,
}

/// Who git asks for github.com's password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelperState {
    /// The GitHub CLI (`gh auth setup-git` was run).
    Gh,
    /// Git Credential Manager, on Windows: it signs in to GitHub itself.
    Gcm,
    /// Another helper (osxkeychain, store, …): git has its own password.
    Other,
    /// No helper at all.
    None,
    /// Plyloft couldn't read git's config (no working git, an error).
    Unknown,
}

/// A SAML single sign-on refusal: the organisation, when gh named it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoNeed {
    pub org: Option<String>,
}

/// What the step reads (`setup_github_status`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// The shell probe resolved `gh`.
    pub gh_found: bool,
    /// github.com's accounts; `None` when gh's answer couldn't be read.
    pub accounts: Option<Vec<GithubAccount>>,
    pub helper: HelperState,
    /// The active account's public email, when it has one.
    pub github_email: Option<String>,
    /// The active account's private address (`<id>+<login>@users.noreply…`).
    pub github_noreply: Option<String>,
    pub sso: Option<SsoNeed>,
    /// N14 item 7: what Git Credential Manager has saved for github.com,
    /// when git uses it (Windows) and the step asked. `None` when not asked.
    pub gcm: Option<GcmSignIn>,
}

/// N14 item 7: Git Credential Manager's github.com sign-in, against the
/// GitHub account Setup uses (gh's active one).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GcmState {
    /// GCM answers for the same account: Plyloft's git works as it is.
    Same,
    /// GCM answers for another account.
    Other,
    /// GCM has nothing saved it can give without its sign-in window.
    None,
    /// Plyloft couldn't tell (a timeout, no active account to compare).
    Unknown,
}

/// What the step says about GCM. Never a secret: the login only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcmSignIn {
    pub state: GcmState,
    /// The account GCM answered for, when it is a GitHub login.
    pub login: Option<String>,
}

/// The probe's outcome, before it is compared with Setup's account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GcmProbe {
    /// A credential, for this username.
    Found(String),
    /// git (GCM) had none it could give without asking.
    Missing,
    /// No answer: it didn't run, or ran out of time.
    Unknown,
}

/// What `git credential fill` is asked: github.com over HTTPS, nothing else.
pub const GCM_PROBE_INPUT: &[u8] = b"protocol=https\nhost=github.com\n\n";

/// The probe's bound: GCM reads its store; a slow answer is not waited on.
const GCM_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// The most of `git credential fill`'s answer that is read (a username, a
/// password and a few attributes fit many times over).
const GCM_PROBE_MAX: usize = 16 * 1024;

/// Pure: the `username=` line of `git credential fill`'s answer, and then
/// the whole answer — the password with it — overwritten in place. Nothing
/// else of it is read, kept or returned.
pub fn credential_username(answer: &mut [u8]) -> Option<String> {
    let username = answer
        .split(|b| *b == b'\n')
        .find_map(|line| line.strip_prefix(b"username="))
        .map(|value| String::from_utf8_lossy(value).trim_end_matches('\r').trim().to_string())
        .filter(|value| !value.is_empty());
    answer.fill(0);
    std::hint::black_box(&answer);
    username
}

/// Pure: the probe compared with the account Setup uses (`active`).
pub fn gcm_sign_in(probe: &GcmProbe, active: Option<&str>) -> GcmSignIn {
    match probe {
        GcmProbe::Missing => GcmSignIn { state: GcmState::None, login: None },
        GcmProbe::Unknown => GcmSignIn { state: GcmState::Unknown, login: None },
        GcmProbe::Found(username) => {
            let login = crate::team_admin::is_valid_login(username).then(|| username.clone());
            let state = match active {
                Some(active) if active.eq_ignore_ascii_case(username) => GcmState::Same,
                Some(_) => GcmState::Other,
                None => GcmState::Unknown,
            };
            GcmSignIn { state, login }
        }
    }
}

/// The git command the probe runs: `git credential fill` for github.com,
/// told never to ask — no terminal prompt (`GIT_TERMINAL_PROMPT=0`), no GCM
/// window (`GCM_INTERACTIVE=never`, `credential.interactive=never`), no
/// askpass program — from outside any repository.
pub fn gcm_probe_command(mut command: std::process::Command) -> std::process::Command {
    command
        .current_dir(std::env::temp_dir())
        .args([
            "-c",
            "credential.interactive=never",
            "-c",
            "core.askPass=",
            "credential",
            "fill",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env_remove("GIT_ASKPASS")
        .env_remove("SSH_ASKPASS");
    command
}

/// Run the probe `command` (see [`gcm_probe_command`]): the question on
/// stdin, the answer read into a fixed buffer and reduced to its username at
/// once, bounded by `timeout` and killed with its process group past it.
pub fn probe_gcm_with(mut command: std::process::Command, timeout: Duration) -> GcmProbe {
    use std::io::{Read, Write};
    use std::process::Stdio;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    crate::platform::own_group(&mut command);
    let Ok((mut child, _group)) = crate::worktrees::exit_registry().spawn(&mut command) else {
        return GcmProbe::Unknown;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(GCM_PROBE_INPUT);
    }
    let (tx, rx) = std::sync::mpsc::channel::<(Vec<u8>, usize)>();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            // One fixed buffer, never grown, so no copy of the answer is
            // left behind in a freed allocation.
            let mut buf = vec![0u8; GCM_PROBE_MAX];
            let mut len = 0;
            while len < buf.len() {
                match stdout.read(&mut buf[len..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => len += n,
                }
            }
            if let Err(std::sync::mpsc::SendError((mut buf, _))) = tx.send((buf, len)) {
                // Nobody is waiting any more: still overwrite it.
                buf.fill(0);
                std::hint::black_box(&buf);
            }
        });
    }
    // stderr holds git's words only (never the credential): kept to tell its
    // clean "no credential" from any other failure.
    let (etx, erx) = std::sync::mpsc::channel::<String>();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.take(GCM_PROBE_MAX as u64).read_to_string(&mut text);
            let _ = etx.send(text);
        });
    }
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() >= timeout => {
                crate::platform::kill_group(child.id() as crate::platform::Pgid);
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let answer = rx.recv_timeout(Duration::from_secs(1)).ok();
    let stderr = erx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    let username = answer.map(|(mut buf, len)| {
        let username = credential_username(&mut buf[..len]);
        buf.fill(0);
        std::hint::black_box(&buf);
        username
    });
    match (status, username) {
        (Some(status), Some(Some(username))) if status.success() => GcmProbe::Found(username),
        // A clean "no": git (GCM) had nothing it could give without asking.
        (Some(status), _) if !status.success() && no_credential(&stderr) => GcmProbe::Missing,
        (Some(status), Some(None)) if status.success() => GcmProbe::Missing,
        // Any other failure says nothing about what GCM has saved.
        _ => GcmProbe::Unknown,
    }
}

/// Pure: git's words when it had no credential and wasn't allowed to ask
/// for one (`GIT_TERMINAL_PROMPT=0`, GCM non-interactive) — the one failure
/// that means "nothing saved" (N14 review P3-2).
pub fn no_credential(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("terminal prompts disabled")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("cannot prompt because user interactivity has been disabled")
}

/// The probe against this machine's git.
fn probe_gcm() -> GcmProbe {
    probe_gcm_with(gcm_probe_command(crate::platform::git_command()), GCM_PROBE_TIMEOUT)
}

// ── Pure ───────────────────────────────────────────────────────────────

/// The first JSON value in `stdout` (gh may add a line after it).
fn first_json(stdout: &str) -> Option<serde_json::Value> {
    let start = stdout.find('{')?;
    serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter::<serde_json::Value>()
        .next()?
        .ok()
}

/// github.com's accounts from `gh auth status --json hosts` (all of them).
/// `None` when the output isn't that JSON; an empty list when gh has no
/// account there (`{"hosts":{}}`, MEASUREMENTS §9).
pub fn parse_accounts(stdout: &str) -> Option<Vec<GithubAccount>> {
    let json = first_json(stdout)?;
    let hosts = json.get("hosts")?.as_object()?;
    let Some(list) = hosts.get(GITHUB_HOST) else {
        return Some(Vec::new());
    };
    Some(
        list.as_array()?
            .iter()
            .filter_map(|a| {
                let login = a.get("login")?.as_str()?.trim();
                if !crate::team_admin::is_valid_login(login) {
                    return None;
                }
                let state = match a.get("state").and_then(|v| v.as_str()) {
                    Some("success") => AccountState::SignedIn,
                    Some("error")
                        if a
                            .get("error")
                            .and_then(|v| v.as_str())
                            .is_some_and(crate::doctor::gh_error_is_refusal) =>
                    {
                        AccountState::Refused
                    }
                    _ => AccountState::Unknown,
                };
                Some(GithubAccount {
                    login: login.to_string(),
                    active: a.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
                    state,
                    scopes: a
                        .get("scopes")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from),
                })
            })
            .collect(),
    )
}

/// Whether a `credential.<url>.helper` subsection is github.com's.
fn is_github_url(subsection: &str) -> bool {
    let rest = subsection
        .strip_prefix("https://")
        .or_else(|| subsection.strip_prefix("http://"))
        .unwrap_or(subsection);
    rest.trim_end_matches('/').eq_ignore_ascii_case(GITHUB_HOST)
}

/// Whether a helper value is gh's (`!/opt/homebrew/bin/gh auth
/// git-credential`, `!"C:\…\gh.exe" auth git-credential`).
fn is_gh_helper(value: &str) -> bool {
    value.trim().trim_end_matches('"').ends_with("auth git-credential")
}

/// Whether a helper value is Git Credential Manager's (`manager`,
/// `manager-core`, or its program's path).
fn is_gcm_helper(value: &str) -> bool {
    let v = value.trim().trim_matches('"').to_ascii_lowercase();
    v == "manager" || v == "manager-core" || v.contains("git-credential-manager")
}

/// Pure: who git asks for github.com's password, from `git config
/// --get-regexp '^credential\..*helper$'` (every scope, in config order).
/// An empty value clears the helpers before it, as git does; `gh auth
/// setup-git` writes one before its own. GCM counts only on Windows (spec:
/// "not Git Credential Manager on Windows, which works already").
pub fn helper_state(get_regexp: &str, windows: bool) -> HelperState {
    let mut helpers: Vec<String> = Vec::new();
    for line in get_regexp.lines() {
        let line = line.trim_end_matches('\r');
        let (key, value) = match line.split_once(' ') {
            Some((k, v)) => (k, v.trim()),
            None => (line, ""),
        };
        let lower = key.to_ascii_lowercase();
        // Challenger P3-1: `[credential ""]` gives `credential..helper`, whose
        // prefix and suffix overlap; strip them, never slice by lengths.
        let applies = lower == "credential.helper"
            || lower
                .strip_prefix("credential.")
                .and_then(|rest| rest.strip_suffix(".helper"))
                .is_some_and(is_github_url);
        if !applies {
            continue;
        }
        if value.is_empty() {
            helpers.clear();
        } else {
            helpers.push(value.to_string());
        }
    }
    if helpers.iter().any(|h| is_gh_helper(h)) {
        HelperState::Gh
    } else if windows && helpers.iter().any(|h| is_gcm_helper(h)) {
        HelperState::Gcm
    } else if helpers.is_empty() {
        HelperState::None
    } else {
        HelperState::Other
    }
}

/// Pure: a SAML refusal in gh's words. GitHub's 403 says "Resource protected
/// by organization SAML enforcement", and gh prints the SSO URL
/// (`https://github.com/orgs/<org>/sso?authorization_request=…`) when
/// GitHub sends one; the organisation is read from that URL only.
pub fn sso_need(text: &str) -> Option<SsoNeed> {
    let lower = text.to_ascii_lowercase();
    let marker = "github.com/orgs/";
    let org = lower.find(marker).and_then(|at| {
        let rest = &text[at + marker.len()..];
        let end = rest.find('/')?;
        let (org, after) = rest.split_at(end);
        (after.starts_with("/sso") && crate::team_admin::is_valid_login(org)).then(|| org.to_string())
    });
    if org.is_none() && !lower.contains("saml") {
        return None;
    }
    Some(SsoNeed { org })
}

/// The organisation's SSO page, for a valid login only.
pub fn sso_url(org: &str) -> Option<String> {
    let org = org.trim();
    crate::team_admin::is_valid_login(org).then(|| format!("https://github.com/orgs/{org}/sso"))
}

/// Pure: GitHub's address for the back-fill from `gh api user`: the public
/// email, and the private noreply one.
pub fn github_addresses(user: &crate::setup_identity::GhUser) -> (Option<String>, String) {
    let email = user
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(String::from);
    (email, crate::setup_identity::noreply_address(user.id, user.login.trim()))
}

// ── Reading the machine ────────────────────────────────────────────────

fn read_accounts(gh: &str, path: &str) -> Option<Vec<GithubAccount>> {
    let mut command = crate::platform::command(gh, path);
    command
        .args(["auth", "status", "--json", "hosts"])
        .env("PATH", path)
        .env("GH_PROMPT_DISABLED", "1");
    // Bounded, its own process group (GH #204). stdout only: the JSON; gh
    // exits 1 when any account fails, and still prints it.
    let out = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(8)).ok()?;
    parse_accounts(&String::from_utf8_lossy(&out.stdout))
}

fn read_helper(git_works: bool) -> HelperState {
    if !git_works {
        return HelperState::Unknown;
    }
    let mut command = crate::platform::git_command();
    // Challenger P3-2: outside any repository, so the app's own cwd never
    // adds a local config (or an includeIf keyed on it).
    command
        .current_dir(std::env::temp_dir())
        .args(["config", "--get-regexp", r"^credential\..*helper$"]);
    match crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(5)) {
        Ok(out) if out.status.success() => helper_state(&String::from_utf8_lossy(&out.stdout), cfg!(windows)),
        // Exit 1: no such key anywhere.
        Ok(out) if out.status.code() == Some(1) => HelperState::None,
        _ => HelperState::Unknown,
    }
}

/// The step's read. `details`: also ask GitHub for the account's address
/// (one `gh api user`), which only the step itself shows; opening Setup
/// asks for the accounts alone.
#[tauri::command]
pub async fn setup_github_status(details: Option<bool>) -> Result<GithubStatus, String> {
    let details = details.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let env = crate::shell_env::get();
        let gh = env.gh_path.clone();
        let accounts = gh.as_deref().and_then(|gh| read_accounts(gh, &env.path));
        let helper = read_helper(env.git_works());
        let signed_in = accounts
            .as_deref()
            .is_some_and(|list| list.iter().any(|a| a.active && a.state == AccountState::SignedIn));
        let (mut github_email, mut github_noreply, mut sso) = (None, None, None);
        // N14 item 7: only where git uses Git Credential Manager (`helper`
        // says GCM on Windows only), and only for the step's own read.
        let gcm = (details && signed_in && helper == HelperState::Gcm).then(|| {
            let active = accounts
                .as_deref()
                .and_then(|list| list.iter().find(|a| a.active))
                .map(|a| a.login.clone());
            gcm_sign_in(&probe_gcm(), active.as_deref())
        });
        if details && signed_in {
            match crate::github::api_user_json() {
                Ok(json) => {
                    if let Some(user) = crate::setup_identity::parse_gh_user(&json) {
                        let (email, noreply) = github_addresses(&user);
                        github_email = email;
                        github_noreply = Some(noreply);
                    }
                }
                Err(words) => sso = sso_need(&words),
            }
        }
        Ok(GithubStatus {
            gh_found: gh.is_some(),
            accounts,
            helper,
            github_email,
            github_noreply,
            sso,
            gcm,
        })
    })
    .await
    .map_err(|e| format!("setup worker failed: {e}"))?
}

/// `Authorize` on the single sign-on message: the organisation's SSO page.
#[tauri::command(async)]
pub fn setup_open_github_sso(org: String) -> Result<(), String> {
    let url = sso_url(&org).ok_or_else(|| "That isn't a GitHub organization name.".to_string())?;
    crate::platform::open_url(&url, crate::platform::WEB_SCHEMES).map_err(|e| format!("open failed: {e}"))
}

#[cfg(test)]
#[path = "setup_github_tests.rs"]
mod tests;
