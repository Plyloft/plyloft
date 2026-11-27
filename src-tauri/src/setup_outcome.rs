//! R2 (1.176.0): what an install or update run really did, and why not.
//!
//! The pure parts of the guided runner's evidence (`setup_run.rs`):
//!
//! - **Versions.** An update is judged on the tool's version before the run
//!   and after it ([`version_change`]), not only on the tool answering
//!   afterwards: a `claude update` refused with EACCES leaves the old version
//!   answering, which used to read as success (plan, blind spot 10).
//! - **Cause.** [`classify`] reads the output's tail into a small [`Cause`]
//!   and, where the tail names it, the path that was refused, so the error
//!   block can say which folder (blind spot 24).
//! - **Time limit.** [`RUN_IDLE_LIMIT`] and [`RUN_LIMIT`] bound an install or
//!   update that hangs (blind spot 13); [`limited`] says which runs.
//!
//! Nothing here runs a process; `setup_run` does, and `setup_last_run`
//! keeps what it found on disk.

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::setup_actions::{ActionId, Tool, Watch};

// ── Time limit ─────────────────────────────────────────────────────────

/// No output at all for this long stops an install or update. 15 minutes is
/// the whole budget the hidden Codex updater (`commands.rs`) gives a
/// ~265 MB download: a run that prints nothing for as long as that download
/// is allowed in total isn't downloading, it hangs. A healthy download that
/// prints nothing (some updaters show no progress) at ~300 KB/s or more
/// finishes inside it; anything that prints — a progress bar, a spinner,
/// npm's lines — never reaches it.
pub const RUN_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);

/// However much it prints, an install or update is stopped after an hour:
/// four times the hidden updater's budget for the same download, for a run
/// that keeps printing without finishing (a retry loop, a spinner over a
/// dead connection) while nobody presses Stop. The person watching can
/// always stop it sooner.
pub const RUN_LIMIT: Duration = Duration::from_secs(60 * 60);

/// The runs the limit applies to: installs and updates, judged by the tool
/// working afterwards. Sign-ins have their own soft notice and are never
/// stopped; the Command Line Tools have their own 30-minute bound.
pub fn limited(watch: Watch) -> bool {
    matches!(watch, Watch::ToolWorks(_))
}

// ── Which tool, and whether it is an update ────────────────────────────

/// The tool an install or update is for (the last-run record's key, and the
/// version read around the run). `None` for every other action.
pub fn program_tool(action: ActionId) -> Option<Tool> {
    Some(match action {
        // R4: a Repair's steps are kept as the tool's last run too, so the
        // next plan (and its loop guard) reads what they did.
        ActionId::InstallClaude
        | ActionId::UpdateClaude
        | ActionId::RepairInstallClaude
        | ActionId::RepairChownClaude
        | ActionId::RepairNpmRemoveClaude => Tool::Claude,
        ActionId::InstallCodex
        | ActionId::UpdateCodex
        | ActionId::RepairInstallCodex
        | ActionId::RepairChownCodex
        | ActionId::RepairNpmRemoveCodex => Tool::Codex,
        ActionId::InstallGh | ActionId::UpdateGh => Tool::Gh,
        ActionId::InstallGit => Tool::Git,
        ActionId::InstallNode => Tool::Node,
        _ => return None,
    })
}

/// R4 (M4): whether a run's output may be kept — in its final event, the
/// log and the last-run record. Never a Repair's `sudo chown`: a password
/// typed before sudo turned the echo off would be in it. The visible
/// terminal already showed the output; only the outcome and exit stay.
pub fn keeps_tail(action: ActionId) -> bool {
    !matches!(action, ActionId::RepairChownClaude | ActionId::RepairChownCodex)
}

/// Pure (M4): the tail as kept for `action`.
pub fn kept_tail(action: ActionId, tail: Vec<String>) -> Vec<String> {
    if keeps_tail(action) {
        tail
    } else {
        Vec::new()
    }
}

/// An update: judged on its version, not only on the tool answering.
/// Installs keep the old tolerance (spec §4 principle 4: winget's "already
/// installed" codes exit non-zero after a good install).
pub fn is_update(action: ActionId) -> bool {
    matches!(
        action,
        ActionId::UpdateClaude | ActionId::UpdateCodex | ActionId::UpdateGh
    )
}

// ── Versions ───────────────────────────────────────────────────────────

/// The tool's version before the run against the one after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionChange {
    /// Not an update: the version isn't part of the verdict.
    NotCompared,
    /// A higher version answers now — or one answers where none did before
    /// (a broken tool repaired).
    Higher,
    /// A lower version answers now: R0 saw a failed update delete the
    /// native launcher, so an older npm copy further down the PATH answers.
    Lower,
    /// Another version, but the two can't be compared as `X.Y.Z`.
    Differs,
    /// The same version answers as before the run.
    Same,
    /// The version after the run couldn't be read, or neither could.
    Unreadable,
}

/// Pure: compare the two reads of an update as `X.Y.Z`
/// (`shell_env::parse_semver`, as the doctor's update line does).
pub fn version_change(before: Option<&str>, after: Option<&str>) -> VersionChange {
    use crate::shell_env::parse_semver;
    match (before, after) {
        (_, None) => VersionChange::Unreadable,
        (None, Some(_)) => VersionChange::Higher,
        (Some(b), Some(a)) if b == a => VersionChange::Same,
        (Some(b), Some(a)) => match (parse_semver(b), parse_semver(a)) {
            (Some(b), Some(a)) if a > b => VersionChange::Higher,
            (Some(b), Some(a)) if a < b => VersionChange::Lower,
            (Some(_), Some(_)) => VersionChange::Same,
            _ => VersionChange::Differs,
        },
    }
}

/// Pure: `latest` (the doctor's last read of the vendor's feed) is newer
/// than `before`: the Update row that started this run said so.
pub fn newer_known(before: Option<&str>, latest: Option<&str>) -> bool {
    use crate::shell_env::parse_semver;
    match (before.and_then(parse_semver), latest.map(str::trim).and_then(parse_semver)) {
        (Some(b), Some(l)) => l > b,
        _ => false,
    }
}

/// winget's answers for "there is nothing newer to install" (winget-cli
/// `doc/windows/package-manager/winget/returnCodes.md`, read 2026-11-21):
/// UPDATE_NOT_APPLICABLE 0x8A15002B ("No applicable update found"),
/// UPGRADE_VERSION_NOT_NEWER 0x8A15004F, UPGRADE_VERSION_UNKNOWN 0x8A150050
/// (winget can't tell the installed version is older, so it upgrades
/// nothing), PACKAGE_ALREADY_INSTALLED 0x8A150061 and INSTALL_DOWNGRADE
/// 0x8A15010E ("A higher version of this application is already
/// installed"). INSTALL_ALREADY_INSTALLED 0x8A15010D ("Another version")
/// is left out: it doesn't say the other version is the newer one.
pub const WINGET_NOTHING_NEWER: [u32; 5] = [0x8A15_002B, 0x8A15_004F, 0x8A15_0050, 0x8A15_0061, 0x8A15_010E];

/// The exit code, signed or not, is one of [`WINGET_NOTHING_NEWER`].
pub fn winget_nothing_newer(code: Option<i32>) -> bool {
    code.is_some_and(|c| WINGET_NOTHING_NEWER.contains(&(c as u32)))
}

/// Pure: the updater's output says it put a new version in place —
/// `Successfully updated from X to version Y` (Claude), `Updating Codex CLI
/// from X to Y`, `==> Upgrading gh X -> Y` (Homebrew), winget's
/// `Successfully installed`. R0 measured Claude's updater printing exactly
/// that and exiting 0 while a read-only `~/.local/bin` kept the old version
/// running: an update that claims a new version and still answers the old
/// one is not "already current". A same-version rerun's bare `Updating Codex
/// CLI` claims nothing.
///
/// Known limit: these are the tools' English words (none of them is
/// localised today). An updater that said it in another language claims
/// nothing here, and its same-version run is then judged by the exit code
/// and by whether a newer version was known (`newer_known`): never
/// "updated" while the Update row said a newer one exists.
pub fn claims_update(tail: &[String]) -> bool {
    tail.iter().any(|line| {
        let l = line.to_lowercase();
        l.contains("successfully updated")
            || l.contains("successfully installed")
            || ((l.contains("updating") || l.contains("upgrading"))
                && ((l.contains(" from ") && l.contains(" to ")) || l.contains("->")))
    })
}

/// Pure: the version in a tool's `--version` answer. On a failed run only
/// stdout is trusted (a crash dump ends with Node's own banner), as the
/// shell probe does.
pub fn version_from_output(stdout: &str, stderr: &str, success: bool) -> Option<String> {
    let out = crate::shell_env::parse_semver_from_text(stdout);
    if !success {
        return out;
    }
    out.or_else(|| crate::shell_env::parse_semver_from_text(stderr))
}

// ── Cause ──────────────────────────────────────────────────────────────

/// Why an install or update didn't work, as far as its output says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cause {
    /// The system refused to let it write a file or folder.
    Permissions,
    DiskFull,
    /// A file it had to replace was in use (an open tile's binary).
    FileInUse,
    /// The download couldn't reach its host (offline, DNS, a proxy).
    Network,
    /// Plyloft stopped it at [`RUN_IDLE_LIMIT`] or [`RUN_LIMIT`].
    TimedOut,
    /// R4: sudo said this user isn't an administrator (`… is not in the
    /// sudoers file`).
    NotAdmin,
    /// R4: sudo didn't accept the password (`3 incorrect password attempts`).
    PasswordRefused,
    /// 1.176.1: a command the run needed wasn't found (exit 127 or Windows'
    /// 9009, or a failed run whose only account is such a line: `command not found`, `is not recognized as an internal
    /// or external command`, `env: node: No such file or directory`). The
    /// diagnosis's `path` is the command's name when the output names it.
    CommandNotFound,
    Unknown,
}

/// What the tail says: the cause, and the path it names, when it names one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnosis {
    pub cause: Cause,
    pub path: Option<String>,
}

/// What a run's final event and its record carry besides the outcome.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    /// Set when the run didn't succeed (and wasn't stopped by the person).
    pub cause: Option<Cause>,
    /// The folder or file the tail says was refused, best effort.
    pub cause_path: Option<String>,
    /// An install or update: the tool's version before the run (`None`: not
    /// installed, or it didn't answer).
    pub version_before: Option<String>,
    pub version_after: Option<String>,
}

const PERMISSIONS: &[&str] = &[
    "eacces",
    "eperm",
    "permission denied",
    "operation not permitted",
    "access is denied",
    "access to the path",
    "unauthorizedaccessexception",
    "insufficient permissions",
    "not writable",
    "os error 13",
];

const DISK_FULL: &[&str] = &[
    "enospc",
    "no space left",
    "not enough space on the disk",
    "there is not enough space",
    "disk is full",
    "os error 28",
    "os error 112",
];

const FILE_IN_USE: &[&str] = &[
    "ebusy",
    "etxtbsy",
    "text file busy",
    "resource busy",
    "being used by another process",
];

const NETWORK: &[&str] = &[
    "could not resolve host",
    "could not resolve proxy",
    "connection reset",
    "connection timed out",
    "connection refused",
    "network is unreachable",
    "failed to connect",
    "enotfound",
    "econnreset",
    "etimedout",
    "econnrefused",
    "eai_again",
    "socket hang up",
    // PowerShell's Invoke-WebRequest / Invoke-RestMethod.
    "the remote name could not be resolved",
    "unable to connect to the remote server",
    "the operation has timed out",
];

/// curl's exit codes for a host it couldn't reach: 6 resolve, 7 connect,
/// 28 timed out, 35 TLS handshake, 56 receive (a proxy's refused CONNECT).
const CURL_NETWORK_CODES: [i32; 5] = [6, 7, 28, 35, 56];

/// `needle` in `line`, not followed by a digit ("os error 13", not "130").
fn has(line: &str, needle: &str) -> bool {
    line.match_indices(needle).any(|(at, _)| {
        !needle.ends_with(|c: char| c.is_ascii_digit())
            || !line[at + needle.len()..].starts_with(|c: char| c.is_ascii_digit())
    })
}

fn any_of(line: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| has(line, n))
}

/// `curl: (N)` with one of curl's network codes.
fn curl_network(line: &str) -> bool {
    CURL_NETWORK_CODES
        .iter()
        .any(|code| line.contains(&format!("curl: ({code})")))
}

fn network_line(line: &str) -> bool {
    any_of(line, NETWORK)
        || curl_network(line)
        // A proxy's words only on a line that reads as an error: "407" or
        // "proxy" alone is too common in an installer's chatter.
        || ((line.contains("curl:")
            || line.contains("error")
            || line.contains("fail")
            || line.contains("unable"))
            && crate::setup_actions::proxy_words(line))
}

/// Pure: why a run didn't work, from its tail (ANSI already stripped) and
/// exit code. `timed_out`: Plyloft stopped it at its limit. When several
/// causes show, the most specific wins: a full disk, then a file in use,
/// then a refused permission (npm reports a full disk or a busy file with
/// its own errno, but a refused write is sometimes a side effect of
/// either), then the network. The path is taken from the last line of that
/// cause (npm's own `path` line first, for a refused write).
/// R4: [`classify`] for `action`. Only a Repair's `sudo chown` reads sudo's
/// own answers first (a refused chown names no path); no other run's
/// output is taken for sudo's.
pub fn classify_for(action: ActionId, tail: &[String], exit: Option<i32>, timed_out: bool) -> Diagnosis {
    if !timed_out && matches!(action, ActionId::RepairChownClaude | ActionId::RepairChownCodex) {
        let lower: Vec<String> = tail.iter().map(|l| l.to_lowercase()).collect();
        if lower.iter().any(|l| {
            l.contains("is not in the sudoers file") || l.contains("is not allowed to run sudo") || l.contains("may not run sudo")
        }) {
            return Diagnosis { cause: Cause::NotAdmin, path: None };
        }
        if lower.iter().any(|l| l.contains("incorrect password attempt")) {
            return Diagnosis { cause: Cause::PasswordRefused, path: None };
        }
    }
    classify(tail, exit, timed_out)
}

pub fn classify(tail: &[String], exit: Option<i32>, timed_out: bool) -> Diagnosis {
    if timed_out {
        return Diagnosis { cause: Cause::TimedOut, path: None };
    }
    // npm's warnings (`npm warn cleanup … EPERM`) are noise around the real
    // error, never its cause.
    let tail: Vec<String> = tail
        .iter()
        .filter(|l| {
            let t = l.trim_start().to_lowercase();
            !(t.starts_with("npm warn") || t.starts_with("npm warning"))
        })
        .cloned()
        .collect();
    let tail = &tail[..];
    let lower: Vec<String> = tail.iter().map(|l| l.to_lowercase()).collect();
    // 1.176.1 (review 1): a command the run needed isn't there — decided
    // only when the run itself ended as a shell does for that (127, or
    // cmd.exe's 9009). A handled `shasum: command not found` before an
    // EACCES is the EACCES's run.
    let not_found_line = || tail.iter().rev().find_map(|l| command_not_found_in(l));
    if exit.is_some_and(|c| NOT_FOUND_EXITS.contains(&c)) {
        return Diagnosis { cause: Cause::CommandNotFound, path: not_found_line().flatten() };
    }

    type Pick = fn(&str) -> bool;
    let checks: [(Cause, Pick); 4] = [
        (Cause::DiskFull, |l| any_of(l, DISK_FULL)),
        (Cause::FileInUse, |l| any_of(l, FILE_IN_USE)),
        (Cause::Permissions, |l| any_of(l, PERMISSIONS)),
        (Cause::Network, network_line),
    ];
    for (cause, pick) in checks {
        if let Some(at) = lower.iter().rposition(|l| pick(l)) {
            let npm = (cause == Cause::Permissions).then(|| npm_path(tail)).flatten();
            let path = npm.or_else(|| path_in(&tail[at]));
            let path = if cause == Cause::Network { None } else { path };
            // Windows refuses to replace a program that runs as EPERM or
            // "access is denied": a refused `.exe`/`.cmd`/`.dll`/`.node` is a
            // file in use (an open tile), not another account's folder.
            if cause == Cause::Permissions && path.as_deref().is_some_and(windows_program) {
                return Diagnosis { cause: Cause::FileInUse, path };
            }
            let path = if cause == Cause::Permissions { path.map(|p| folder_of_temp(&p)) } else { path };
            return Diagnosis { cause, path };
        }
    }
    let curl_said = lower.iter().any(|l| l.contains("curl"));
    if exit.is_some_and(|c| CURL_NETWORK_CODES.contains(&c)) && curl_said {
        return Diagnosis { cause: Cause::Network, path: None };
    }
    // No other cause matched and the run failed: a not-found line is then the
    // best account there is.
    if exit.is_some_and(|c| c != 0) {
        if let Some(name) = not_found_line() {
            return Diagnosis { cause: Cause::CommandNotFound, path: name };
        }
    }
    Diagnosis { cause: Cause::Unknown, path: None }
}

/// 1.176.1: the exits a shell gives a command it can't find (127) and
/// cmd.exe's "not recognized" (9009). Not 126: that one was found but
/// couldn't be run, which the other causes (permissions…) say.
pub const NOT_FOUND_EXITS: [i32; 2] = [127, 9009];

/// 1.176.1: a line that says a command wasn't found: `Some(Some(name))` with
/// its name, `Some(None)` without one, `None` for any other line.
pub fn command_not_found_in(line: &str) -> Option<Option<String>> {
    let l = line.trim();
    // 1.176.2 R1: ASCII only, so every offset found in `lower` is the same
    // byte offset in `l` (every marker is ASCII). A full Unicode lowercase
    // changes the length of `İ` or the Kelvin sign: the name read was
    // shifted, or the slice panicked and the run never said its end.
    let lower = l.to_ascii_lowercase();
    let clean = |s: &str| {
        let n = s.trim().trim_matches(|c| c == '\'' || c == '"' || c == '`').trim().to_string();
        (!n.is_empty() && !n.contains(' ')).then_some(n)
    };
    // zsh: `zsh: command not found: curl`
    if let Some(at) = lower.find("command not found: ") {
        return Some(clean(&l[at + "command not found: ".len()..]));
    }
    // bash, sh: `bash: line 1: curl: command not found`
    if let Some(at) = lower.find(": command not found") {
        let head = &l[..at];
        return Some(clean(head.rsplit(": ").next().unwrap_or(head)));
    }
    // cmd.exe: `'curl' is not recognized as an internal or external command`;
    // PowerShell: `The term 'curl' is not recognized as …`.
    if lower.contains("is not recognized as") {
        let quoted = l.split('\'').nth(1).and_then(clean);
        return Some(quoted);
    }
    // `env: node: No such file or directory`, `/bin/sh: x: not found`: a
    // program, not a file the run wrote (two short parts before it).
    for marker in [": no such file or directory", ": not found"] {
        if let Some(at) = lower.find(marker) {
            let parts: Vec<&str> = l[..at].split(": ").collect();
            if parts.len() == 2 || (parts.len() == 3 && parts[1].starts_with("line ")) {
                let first = parts[0].trim();
                let shellish = ["env", "sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh", "/usr/bin/env"]
                    .iter()
                    .any(|s| first == *s || first.ends_with(&format!("/{s}")));
                if shellish {
                    return Some(clean(parts[parts.len() - 1]));
                }
            }
        }
    }
    None
}

/// A Windows program or library file.
fn windows_program(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    [".exe", ".cmd", ".dll", ".node"].iter().any(|ext| l.ends_with(ext))
}

/// A temporary name an installer writes beside its target
/// (`~/.local/bin/.codex.59509`): the folder it was in is what to fix.
fn folder_of_temp(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(at) if trimmed[at + 1..].starts_with('.') && at > 0 => trimmed[..at].to_string(),
        _ => path.to_string(),
    }
}

/// The folder to fix for a refused path: the path itself when it is a
/// folder, else the folder it is in (a file, or one no longer there).
/// `is_dir` is the caller's look at the disk.
pub fn folder_to_fix(path: &str, is_dir: bool) -> String {
    if is_dir {
        return path.to_string();
    }
    let trimmed = path.trim_end_matches(['/', '\\']);
    match trimmed.rfind(['/', '\\']) {
        Some(0) => trimmed[..1].to_string(),
        Some(at) => trimmed[..at].to_string(),
        None => path.to_string(),
    }
}

/// npm's `npm error path <path>` (`npm ERR! path` before npm 10), the last.
fn npm_path(tail: &[String]) -> Option<String> {
    tail.iter().rev().find_map(|line| {
        let t = line.trim();
        let rest = t
            .strip_prefix("npm error path ")
            .or_else(|| t.strip_prefix("npm ERR! path "))?;
        let rest = rest.trim();
        looks_like_path(rest).then(|| rest.to_string())
    })
}

fn looks_like_path(s: &str) -> bool {
    let b = s.as_bytes();
    if s.len() < 2 || s.starts_with("//") {
        return false;
    }
    s.starts_with('/')
        || s.starts_with("~/")
        || s.starts_with("\\\\")
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
}

/// Pure, best effort: the first path a line names — quoted first (`'…'`,
/// `"…"`, PowerShell's and Node's way), else a bare word that starts like a
/// path (`cp: /usr/local/bin/claude: Permission denied`).
pub fn path_in(line: &str) -> Option<String> {
    for quote in ['\'', '"'] {
        let mut parts = line.split(quote);
        parts.next();
        // Every other piece is inside a pair of quotes.
        while let (Some(inside), Some(_)) = (parts.next(), parts.clone().next()) {
            if looks_like_path(inside) {
                return Some(inside.to_string());
            }
            parts.next();
        }
    }
    line.split_whitespace()
        .map(|w| w.trim_end_matches([':', ',', ';', ')']).trim_start_matches('('))
        .find(|w| looks_like_path(w))
        .map(|w| w.trim_end_matches('.').to_string())
}

#[cfg(test)]
#[path = "setup_outcome_tests.rs"]
mod tests;
