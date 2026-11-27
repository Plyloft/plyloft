//! OB-6 — Setup's Git and identity step (onboarding spec §5 step 4, §6
//! `identity.write`).
//!
//! Two commands:
//!
//! - [`setup_identity_prefill`] — what the Name and Email fields start with,
//!   in the spec's order: (1) the global git config; (2) GitHub, when `gh` is
//!   signed in (`gh api user`: `name`, `email`, or the private
//!   `<id>+<login>@users.noreply.github.com` address when the account's email
//!   is private); (3) the system (`id -F` on the Mac, the account's display
//!   name on Windows when Windows gives one). Read only.
//! - [`setup_identity_write`] — after the consent sheet: `git config --global
//!   user.name <v>` and `user.email <v>`, each value **one argv element**
//!   (never a shell string, so quotes, `$()` and newlines are written as
//!   typed), then both read back with `--global --get`; the step turns done
//!   only on what git answers (spec §4 principle 4). The read-back email
//!   becomes `settings.identity.userEmail` at once, and `settings://changed`
//!   tells every window, so Profile and shared-library authorship agree
//!   without a relaunch (§8.6).
//!
//! Ply writes `--global` only and never edits an included file (spec §5
//! step 4, `includeIf`). The program is [`crate::platform::git_command`]: the
//! git the probe found working, never Apple's install shim.

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::SettingsStore;

/// Each `git config` call's bound.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

pub const INVALID_EMAIL: &str = "That doesn't look like an email address.";
pub const EMPTY_NAME: &str = "Enter the name to show on your commits.";
pub const GIT_NOT_WORKING: &str = "Git isn't working yet. Install it first, then save your name and email.";

// ── Validation (pure) ──────────────────────────────────────────────────

/// Only the `x@y` shape (spec §5 step 4 "Invalid email"): something, one
/// `@`, something; no spaces or control characters.
pub fn is_valid_email(email: &str) -> bool {
    let email = email.trim();
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The name as it will be written: trimmed at its ends, never empty. What is
/// inside is kept exactly (it is an argv element, not a shell word).
pub fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('\0') {
        return Err(EMPTY_NAME.into());
    }
    Ok(name.to_string())
}

pub fn clean_email(email: &str) -> Result<String, String> {
    if !is_valid_email(email) {
        return Err(INVALID_EMAIL.into());
    }
    Ok(email.trim().to_string())
}

/// The arguments after `git` for one write: `config --global <key> <value>`.
/// `key` is one of the two constants; `value` is one element as given.
pub fn write_args(key: IdentityKey, value: &str) -> Vec<String> {
    vec![
        "config".into(),
        "--global".into(),
        key.as_str().into(),
        value.to_string(),
    ]
}

/// The only two keys Setup writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityKey {
    Name,
    Email,
}

impl IdentityKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Name => "user.name",
            Self::Email => "user.email",
        }
    }
}

// ── Writing and reading back ───────────────────────────────────────────

/// What git answered after the write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityWritten {
    pub name: String,
    pub email: String,
}

fn run(mut command: Command) -> Result<std::process::Output, String> {
    crate::worktrees::run_bounded_output(&mut command, GIT_TIMEOUT).map_err(|e| match e {
        crate::worktrees::BoundedFailure::TimedOut => "Git didn't answer within ten seconds.".to_string(),
        crate::worktrees::BoundedFailure::Quitting => "Plyloft is quitting.".to_string(),
        other => format!("Git couldn't be started ({other:?})."),
    })
}

/// `git config --global --includes --get <key>`: what Git uses, an
/// `[include]`d file counted (OB-6 review P3-3). `Ok(None)` when unset
/// (exit 1). The value's one trailing newline is git's, not the value's.
pub fn read_key(git: &dyn Fn() -> Command, key: IdentityKey) -> Result<Option<String>, String> {
    read_key_in(git, key, true)
}

/// [`read_key`], or with `includes` false only what the global file itself
/// holds (what a write replaces).
pub fn read_key_in(
    git: &dyn Fn() -> Command,
    key: IdentityKey,
    includes: bool,
) -> Result<Option<String>, String> {
    let mut command = git();
    command.args(["config", "--global"]);
    if includes {
        command.arg("--includes");
    }
    command.args(["--get", key.as_str()]);
    let out = run(command)?;
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let value = text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(&text)
            .to_string();
        Ok(Some(value))
    } else if out.status.code() == Some(1) {
        Ok(None)
    } else {
        Err(stderr_words(&out))
    }
}

fn stderr_words(out: &std::process::Output) -> String {
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        format!("Git stopped with exit code {}.", out.status.code().unwrap_or(-1))
    } else {
        err
    }
}

/// `git config` exits 5 when a key holds several values and a plain set
/// can't choose one. Plyloft doesn't remove the others unasked.
pub fn several_values(key: IdentityKey) -> String {
    let (what, k) = match key {
        IdentityKey::Name => ("name", "user.name"),
        IdentityKey::Email => ("email", "user.email"),
    };
    format!(
        "Git has more than one {what} set in your global configuration, so it can't replace them with one. Remove the extra ones with git config --global --unset-all {k}, then save again."
    )
}

/// Validate, write what differs, read both back. `git` makes a fresh `git`
/// command (production: [`crate::platform::git_command`]; tests: one with a
/// temporary `GIT_CONFIG_GLOBAL`). Nothing is written unless both values are
/// valid; a value the global file already holds is not written again.
///
/// Multi-valued keys (OB-6 review P3-4): a plain `--global` set, as the
/// consent sheet names it — never `--replace-all`, which would delete the
/// other values unasked; git's exit 5 comes back as [`several_values`].
pub fn write_identity(
    git: &dyn Fn() -> Command,
    name: &str,
    email: &str,
) -> Result<IdentityWritten, String> {
    let name = clean_name(name)?;
    let email = clean_email(email)?;
    let mut name_changed = false;
    for (key, value) in [(IdentityKey::Name, &name), (IdentityKey::Email, &email)] {
        if read_key_in(git, key, false).ok().flatten().as_deref() == Some(value.as_str()) {
            continue;
        }
        let mut command = git();
        command.args(write_args(key, value));
        let out = run(command)?;
        if !out.status.success() {
            let why = if out.status.code() == Some(5) {
                several_values(key)
            } else {
                stderr_words(&out)
            };
            return Err(match key {
                IdentityKey::Name => format!("Git didn't save your name: {why}"),
                IdentityKey::Email if name_changed => format!(
                    "Git saved your name, but not your email: {why}"
                ),
                IdentityKey::Email => format!("Git didn't save your email: {why}"),
            });
        }
        if key == IdentityKey::Name {
            name_changed = true;
        }
    }
    let read_name = read_key(git, IdentityKey::Name)?;
    let read_email = read_key(git, IdentityKey::Email)?;
    match (read_name, read_email) {
        (Some(n), Some(e)) if n == name && e == email => Ok(IdentityWritten { name: n, email: e }),
        _ => {
            let own_name = read_key_in(git, IdentityKey::Name, false)?;
            let own_email = read_key_in(git, IdentityKey::Email, false)?;
            if own_name.as_deref() == Some(name.as_str()) && own_email.as_deref() == Some(email.as_str()) {
                Err("Git saved them, but a file your global configuration includes sets other values, and those win. Change them there, or remove them from it.".into())
            } else {
                Err("Git saved something other than what you typed. Look at git config --global --list, or try again.".into())
            }
        }
    }
}

// ── The prefill (pure) ─────────────────────────────────────────────────

/// The parts of `gh api user` the prefill reads.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct GhUser {
    pub id: u64,
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

/// `gh api user`'s JSON, or `None` when it isn't that.
pub fn parse_gh_user(stdout: &str) -> Option<GhUser> {
    let user: GhUser = serde_json::from_str(stdout.trim()).ok()?;
    (!user.login.trim().is_empty()).then_some(user)
}

/// GitHub's private commit address for an account.
pub fn noreply_address(id: u64, login: &str) -> String {
    format!("{id}+{login}@users.noreply.github.com")
}

/// Where a prefilled value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrefillSource {
    Git,
    Github,
    System,
    None,
}

/// What the Name and Email fields start with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityPrefill {
    pub name: String,
    pub name_source: PrefillSource,
    pub email: String,
    pub email_source: PrefillSource,
    /// Set when the email would come from GitHub and the account's email is
    /// private: the step offers `Use my private GitHub address` (this, the
    /// default) or `Use another email`.
    pub github_noreply: Option<String>,
    pub github_login: Option<String>,
}

fn nonblank(v: Option<&str>) -> Option<String> {
    v.map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}

/// Pure: the spec's order, per field. `git` is the global config's
/// `(user.name, user.email)`; `github` is `gh api user` when gh is signed in;
/// `system_name` is the account's full name.
pub fn prefill(
    git: (Option<&str>, Option<&str>),
    github: Option<&GhUser>,
    system_name: Option<&str>,
) -> IdentityPrefill {
    let (name, name_source) = if let Some(n) = nonblank(git.0) {
        (n, PrefillSource::Git)
    } else if let Some(n) = github.and_then(|u| nonblank(u.name.as_deref())) {
        (n, PrefillSource::Github)
    } else if let Some(n) = nonblank(system_name) {
        (n, PrefillSource::System)
    } else {
        (String::new(), PrefillSource::None)
    };
    let mut github_noreply = None;
    let (email, email_source) = if let Some(e) = nonblank(git.1) {
        (e, PrefillSource::Git)
    } else if let Some(user) = github {
        match nonblank(user.email.as_deref()) {
            Some(e) => (e, PrefillSource::Github),
            None => {
                let address = noreply_address(user.id, user.login.trim());
                github_noreply = Some(address.clone());
                (address, PrefillSource::Github)
            }
        }
    } else {
        // The system has no email to offer (spec: "email empty").
        (String::new(), PrefillSource::None)
    };
    IdentityPrefill {
        name,
        name_source,
        email,
        email_source,
        github_noreply,
        github_login: github.map(|u| u.login.trim().to_string()),
    }
}

// ── Reading the machine ────────────────────────────────────────────────

/// The account's full name: `id -F` on the Mac.
#[cfg(target_os = "macos")]
fn system_full_name() -> Option<String> {
    let mut command = crate::platform::new_command("/usr/bin/id");
    command.arg("-F");
    let out = crate::worktrees::run_bounded_output(&mut command, Duration::from_secs(3)).ok()?;
    if !out.status.success() {
        return None;
    }
    nonblank(Some(&String::from_utf8_lossy(&out.stdout)))
}

/// Windows: the account's display name (`GetUserNameExW(NameDisplay)`),
/// when Windows gives one — a local account without a full name, or a
/// Microsoft account off a domain, often has none.
#[cfg(windows)]
fn system_full_name() -> Option<String> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_MORE_DATA};
    use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
    let mut size: u32 = 256;
    // OB-6 review P3-5: a longer name answers ERROR_MORE_DATA with the size
    // it needs; one retry with that size.
    for _ in 0..2 {
        let mut buf: Vec<u16> = vec![0; size as usize + 1];
        let mut len = size + 1;
        // SAFETY: `buf` holds `len` u16s; the call writes at most that many
        // and sets `len` to the length written (without the NUL) on success,
        // or to the size needed on ERROR_MORE_DATA.
        let ok = unsafe { GetUserNameExW(NameDisplay, buf.as_mut_ptr(), &mut len) };
        if ok {
            buf.truncate(len as usize);
            return nonblank(Some(&String::from_utf16_lossy(&buf)));
        }
        // SAFETY: reads this thread's last error, no pointers.
        if unsafe { GetLastError() } != ERROR_MORE_DATA || len <= size {
            return None;
        }
        size = len;
    }
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_full_name() -> Option<String> {
    None
}

fn git_works() -> bool {
    crate::shell_env::try_get().is_some_and(|env| env.git_works())
}

fn production_git() -> Command {
    crate::platform::git_command()
}

/// The prefill, read on a worker. GitHub is asked only when the global
/// config lacks a value (no network for someone already set up).
#[tauri::command]
pub async fn setup_identity_prefill() -> Result<IdentityPrefill, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let git = if git_works() {
            (
                read_key(&production_git, IdentityKey::Name).ok().flatten(),
                read_key(&production_git, IdentityKey::Email).ok().flatten(),
            )
        } else {
            (None, None)
        };
        let complete = nonblank(git.0.as_deref()).is_some() && nonblank(git.1.as_deref()).is_some();
        let github = if complete {
            None
        } else {
            crate::github::api_user_json().ok().and_then(|s| parse_gh_user(&s))
        };
        let system = if nonblank(git.0.as_deref()).is_none() && github.as_ref().and_then(|u| nonblank(u.name.as_deref())).is_none() {
            system_full_name()
        } else {
            None
        };
        Ok(prefill(
            (git.0.as_deref(), git.1.as_deref()),
            github.as_ref(),
            system.as_deref(),
        ))
    })
    .await
    .map_err(|e| format!("setup worker failed: {e}"))?
}

/// After the consent sheet's `Save`: write, read back, then record the
/// email Plyloft stamps on shared records and tell every window.
#[tauri::command]
pub async fn setup_identity_write(
    app: AppHandle,
    name: String,
    email: String,
) -> Result<IdentityWritten, String> {
    // Refused before anything runs: the words are the ones the step shows.
    clean_name(&name)?;
    clean_email(&email)?;
    if !git_works() {
        return Err(GIT_NOT_WORKING.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let written = write_identity(&production_git, &name, &email)?;
        let mut changed = false;
        let saved = app.state::<SettingsStore>().update(|s| {
            if s.identity.user_email.as_deref() != Some(written.email.as_str()) {
                s.identity.user_email = Some(written.email.clone());
                changed = true;
            }
        })?;
        if changed {
            let _ = app.emit("settings://changed", saved);
        }
        Ok(written)
    })
    .await
    .map_err(|e| format!("setup worker failed: {e}"))?
}

/// Git's own downloads page: the step's `Do it yourself` (spec §5 step 4,
/// "CLT asks for an admin password"). A fixed URL — the frontend sends none.
pub const GIT_DOWNLOADS: &str = "https://git-scm.com/downloads";

#[tauri::command(async)]
pub fn setup_open_git_downloads() -> Result<(), String> {
    crate::platform::open_url(GIT_DOWNLOADS, crate::platform::WEB_SCHEMES)
        .map_err(|e| format!("open failed: {e}"))
}

#[cfg(test)]
#[path = "setup_identity_tests.rs"]
mod tests;
