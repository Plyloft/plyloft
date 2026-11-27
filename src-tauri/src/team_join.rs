//! OB-10 — Setup's Team step (onboarding spec §5 step 6, §12): the invite
//! code, joining a team (a detected one, or one named by a pasted code), and
//! the team workspace invitations.
//!
//! **The invite code is a pointer, not a credential** (§12.1). It names a
//! repository and nothing else: no token, key, email, path or expiry. Joining
//! still needs what ADR 0002 needs — `team.json` lists this login **and**
//! GitHub lets this account read the repository — so the code only saves
//! typing and prefills the Join sheet.
//!
//! - **Format** (§12.2, D11 — code only, no `ply://` handler):
//!   `ply-join:<owner>/<name>`. The prefix carries the version: the bare
//!   prefix is version 1, and a later format writes `ply-join:v<N>:`; this
//!   build reads `v1` and refuses any other number with "from a newer
//!   Plyloft". The same field also takes a bare `owner/name` and
//!   `https://github.com/<owner>/<name>` (§12.2).
//! - **Validation** (§12.3): at most [`MAX_INVITE_INPUT`] bytes; after the
//!   surrounding whitespace, printable ASCII only (so a Cyrillic `а`, a
//!   full-width `／`, a zero-width joiner or a right-to-left override is
//!   refused rather than read as a look-alike); the owner is a GitHub login
//!   (`team_admin::is_valid_login`), the name a GitHub repository name, and
//!   the pair passes `team::is_valid_repo_slug`; a link must be `https` on
//!   `github.com` (no user, port, query or fragment). Anything else is
//!   *That isn't a Plyloft invite code.*
//! - **A hostile team** (§12.3): the code never joins by itself. The sheet
//!   names the repository, its owner **as GitHub says** (not as the code
//!   says), whoever invited (from GitHub's invitation) and the manifest's
//!   owner once it is read; the manifest's name is shown cleaned and capped
//!   ([`display_team_name`]); only `owner/name` entries are ever used.
//! - **What a join may do** (D16): accept **one** pending GitHub invitation —
//!   the one to the repository whose code was pasted, by the id the sheet
//!   showed, re-checked against GitHub's list right before the `PATCH` — then
//!   read `team.json` and stop unless it lists this login. Only then is
//!   `settings.team.teamRepo` written. Team workspace invitations are
//!   accepted only for repositories the manifest lists **and** the person
//!   named in the sheet. Nothing else is ever accepted; detection lists only
//!   repositories the account can already read.
//!
//! Every `gh` call is bounded (`project_setup::run`, its own process group)
//! and its failure is put in words: single sign-on through
//! `setup_github::sso_need`, offline, a refused sign-in, a rate limit.
//!
//! The decisions are pure over [`JoinGh`], so the tests run them against a
//! stub (`team_join_tests.rs`); [`RealJoinGh`] is the one that runs `gh`.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::project_setup::{GhToken, Tools};

// ── The invite code (§12.2) ────────────────────────────────────────────

/// The code's prefix. Version 1 is the bare prefix; a later version writes
/// `ply-join:v<N>:` after it.
pub const INVITE_PREFIX: &str = "ply-join:";
/// The version this build writes and reads.
pub const INVITE_VERSION: u32 = 1;
/// The longest input the field reads at all (an owner is at most 39, a name
/// at most 100; a link adds its scheme and host).
pub const MAX_INVITE_INPUT: usize = 256;
/// A GitHub repository name's longest.
pub const MAX_REPO_NAME: usize = 100;
/// The longest team name the sheet shows.
pub const MAX_TEAM_NAME: usize = 80;
/// The largest `team.json` Plyloft reads.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
/// How many repositories detection looks at (`team_admin::DISCOVERY_SCAN_LIMIT`).
pub const DETECT_LIMIT: usize = crate::team_admin::DISCOVERY_SCAN_LIMIT;

pub const NOT_A_CODE: &str = "That isn't a Plyloft invite code.";
pub const NEWER_CODE: &str = "This invite is from a newer Plyloft. Update Plyloft, then paste it again.";
pub const OTHER_HOST: &str = "That link isn't on github.com. Plyloft teams live on GitHub.";
pub const EMPTY_CODE: &str = "Paste the invite code your team's owner sent you.";

/// Why the field's text isn't an invite code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodeRefusal {
    Empty,
    TooLong,
    NotACode,
    NewerVersion,
    OtherHost,
}

impl CodeRefusal {
    pub fn words(self) -> &'static str {
        match self {
            CodeRefusal::Empty => EMPTY_CODE,
            CodeRefusal::TooLong | CodeRefusal::NotACode => NOT_A_CODE,
            CodeRefusal::NewerVersion => NEWER_CODE,
            CodeRefusal::OtherHost => OTHER_HOST,
        }
    }
}

/// A GitHub repository name: `[A-Za-z0-9._-]`, 1–100, not `.` or `..`.
pub fn is_valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_REPO_NAME
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// `owner/name` with a GitHub login for the owner and a GitHub repository
/// name, and nothing `team::is_valid_repo_slug` refuses.
pub fn is_team_repo(slug: &str) -> bool {
    let Some((owner, name)) = slug.split_once('/') else {
        return false;
    };
    owner.len() <= 39
        && owner == owner.trim()
        && crate::team_admin::is_valid_login(owner)
        && is_valid_repo_name(name)
        && crate::team::is_valid_repo_slug(slug)
}

/// The code for `repo` (version 1), or `None` for anything that isn't a
/// team repository name.
pub fn encode_invite_code(repo: &str) -> Option<String> {
    let repo = repo.trim();
    is_team_repo(repo).then(|| format!("{INVITE_PREFIX}{repo}"))
}

/// Read the field: the team repository `owner/name` it names.
pub fn parse_invite_code(text: &str) -> Result<String, CodeRefusal> {
    if text.len() > MAX_INVITE_INPUT {
        return Err(CodeRefusal::TooLong);
    }
    let text = text.trim_matches(|c: char| c.is_whitespace());
    if text.is_empty() {
        return Err(CodeRefusal::Empty);
    }
    // Printable ASCII only: a look-alike letter, an invisible character or
    // a direction override is refused, never folded into something else.
    if !text.chars().all(|c| c.is_ascii_graphic()) {
        return Err(CodeRefusal::NotACode);
    }
    let lower = text.to_ascii_lowercase();
    let slug = if lower.starts_with(INVITE_PREFIX) {
        let rest = &text[INVITE_PREFIX.len()..];
        match versioned(rest)? {
            Some(slug) => slug,
            None => rest,
        }
    } else if lower.contains("://") || lower.starts_with("github.com/") || lower.starts_with("www.github.com/") {
        return from_link(text);
    } else {
        text
    };
    checked_slug(slug)
}

/// `v<N>:<slug>` after the prefix: `Some(slug)` for version 1, a refusal for
/// any other; `None` when there is no version part (version 1).
fn versioned(rest: &str) -> Result<Option<&str>, CodeRefusal> {
    let Some(after_v) = rest.strip_prefix('v').or_else(|| rest.strip_prefix('V')) else {
        return Ok(None);
    };
    let Some((number, slug)) = after_v.split_once(':') else {
        // `ply-join:v…` without a colon is an owner that starts with v.
        return Ok(None);
    };
    if number.is_empty() || number.len() > 4 || !number.chars().all(|c| c.is_ascii_digit()) {
        return Err(CodeRefusal::NotACode);
    }
    match number.parse::<u32>() {
        Ok(INVITE_VERSION) => Ok(Some(slug)),
        Ok(n) if n > INVITE_VERSION => Err(CodeRefusal::NewerVersion),
        _ => Err(CodeRefusal::NotACode),
    }
}

/// `https://github.com/<owner>/<name>` (optionally `www.`, a trailing `/`
/// or `.git`); a bare `github.com/<owner>/<name>` too.
fn from_link(text: &str) -> Result<String, CodeRefusal> {
    let lower = text.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &text["https://".len()..]
    } else if lower.contains("://") {
        // http://, ssh://, git://, javascript:… — not a way to name a team.
        return Err(if lower.starts_with("http://") { CodeRefusal::NotACode } else { CodeRefusal::OtherHost });
    } else {
        text
    };
    let (host, path) = rest.split_once('/').ok_or(CodeRefusal::NotACode)?;
    // A user or a port in the authority is a way to disguise another host.
    if host.contains('@') || host.contains(':') {
        return Err(CodeRefusal::OtherHost);
    }
    let host = host.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return Err(CodeRefusal::OtherHost);
    }
    if path.contains('?') || path.contains('#') {
        return Err(CodeRefusal::NotACode);
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    let path = match path.strip_suffix(".git") {
        Some(p) if !p.ends_with('/') => p,
        _ => path,
    };
    checked_slug(path)
}

fn checked_slug(slug: &str) -> Result<String, CodeRefusal> {
    if is_team_repo(slug) {
        Ok(slug.to_string())
    } else {
        Err(CodeRefusal::NotACode)
    }
}

/// Where "Install Plyloft" points (D12): the public releases feed's latest
/// release, which holds the signed DMG and Windows installer.
pub const PLYLOFT_DOWNLOAD_URL: &str = "https://github.com/MatteoB-adv/ply-releases/releases/latest";

/// The message the owner's **Copy invite** puts on the clipboard (§12.2).
/// The invitee never accepts on GitHub by hand: pasting the code makes the
/// Join sheet accept the invitation to `repo` for them (D16).
pub fn invite_message(team_name: &str, repo: &str) -> Option<String> {
    let code = encode_invite_code(repo)?;
    let name = display_team_name(team_name).unwrap_or_else(|| repo.to_string());
    Some(format!(
        "Join “{name}” in Plyloft.\n\
         1. Install Plyloft (macOS on Apple Silicon, or Windows 11):\n   \
         {PLYLOFT_DOWNLOAD_URL}\n\
         2. In Plyloft, open Setup › Your team › Join a team and paste this code:\n   \
         {code}\n   \
         Plyloft accepts the GitHub invitation to {repo} for you.\n"
    ))
}

/// A manifest's team name as the sheet may show it: control characters and
/// direction overrides out, whitespace collapsed, at most
/// [`MAX_TEAM_NAME`] characters. `None` when nothing is left.
pub fn display_team_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !is_invisible(*c))
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut out: String = collapsed.chars().take(MAX_TEAM_NAME).collect();
    if collapsed.chars().count() > MAX_TEAM_NAME {
        out.push('…');
    }
    Some(out)
}

/// Zero-width and direction-control characters, which could make a name
/// read as something it isn't.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

// ── What GitHub says (the seam) ────────────────────────────────────────

/// A repository as `gh api repos/<r>` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFacts {
    pub full_name: String,
    pub private: Option<bool>,
    pub owner: Option<String>,
    pub owner_is_org: bool,
}

/// One pending repository invitation (`gh api user/repository_invitations`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub id: u64,
    pub repo: String,
    pub owner: Option<String>,
    pub owner_is_org: bool,
    pub inviter: Option<String>,
    pub expired: bool,
}

/// Plyloft's GitHub calls for joining. `Err` is gh's own words (a refusal
/// the caller puts in words); "GitHub said no" is `Ok(None)` where it means
/// something.
pub trait JoinGh {
    /// `Some` when this account can read the repository, `None` when GitHub
    /// answered that it can't (404/403 without single sign-on).
    fn repo(&self, repo: &str) -> Result<Option<RepoFacts>, String>;
    /// The repository's `team.json`, raw; `None` when there is none.
    fn manifest(&self, repo: &str) -> Result<Option<Vec<u8>>, String>;
    /// Every pending invitation for this account.
    fn invitations(&self) -> Result<Vec<Invitation>, String>;
    /// Accept one invitation. Called only by [`verify_join`] and
    /// [`accept_workspace_invites`], each after its own checks.
    fn accept_invitation(&self, id: u64) -> Result<(), String>;
    /// The repositories this account can read, most recently pushed first,
    /// at most `limit`.
    fn repos(&self, limit: usize) -> Result<Vec<String>, String>;
    /// A short wait after an accept, before `team.json` is asked for again.
    fn settle(&self) {}
    /// `team.json` for several repositories (detection). Sequential here;
    /// [`RealJoinGh`] asks a few at a time.
    /// Repositories not asked by `deadline` answer [`DETECT_DEADLINE`].
    fn manifests(
        &self,
        repos: &[String],
        deadline: std::time::Instant,
    ) -> Vec<(String, Result<Option<Vec<u8>>, String>)> {
        repos
            .iter()
            .map(|r| {
                let answer = if std::time::Instant::now() >= deadline {
                    Err(DETECT_DEADLINE.to_string())
                } else {
                    self.manifest(r)
                };
                (r.clone(), answer)
            })
            .collect()
    }
}

// ── Problems, in words ─────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProblemKind {
    NotACode,
    NewerVersion,
    NoAccess,
    NotListed,
    NotATeam,
    Expired,
    InvitationGone,
    NeedsReplace,
    Sso,
    Offline,
    SignedOut,
    RateLimited,
    Other,
}

/// Why a join can't go on, in the ErrorBlock's words (§4.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinProblem {
    pub kind: ProblemKind,
    pub words: String,
    /// The organisation a single sign-on refusal named.
    pub org: Option<String>,
    pub repo: Option<String>,
    /// A GitHub invitation was accepted before this stopped.
    pub accepted: bool,
    /// gh's own words, for Details.
    pub details: Option<String>,
}

impl JoinProblem {
    pub fn new(kind: ProblemKind, words: impl Into<String>) -> Self {
        Self { kind, words: words.into(), org: None, repo: None, accepted: false, details: None }
    }

    fn for_repo(mut self, repo: &str) -> Self {
        self.repo = Some(repo.to_string());
        self
    }

    fn accepted(mut self, accepted: bool) -> Self {
        self.accepted = accepted;
        self
    }
}

pub fn code_problem(refusal: CodeRefusal) -> JoinProblem {
    let kind = match refusal {
        CodeRefusal::NewerVersion => ProblemKind::NewerVersion,
        _ => ProblemKind::NotACode,
    };
    JoinProblem::new(kind, refusal.words())
}

pub fn no_access(repo: &str, login: &str) -> JoinProblem {
    JoinProblem::new(
        ProblemKind::NoAccess,
        format!("You don't have access to {repo} yet. Ask the owner to invite your GitHub account “{login}”."),
    )
    .for_repo(repo)
}

pub fn not_listed(repo: &str, accepted: bool) -> JoinProblem {
    let words = if accepted {
        "You accepted GitHub's invitation, but the team's owner hasn't added you to the team yet. Ask them to add you, then check again."
    } else {
        "You can read the team's repository, but its owner hasn't added you to the team."
    };
    JoinProblem::new(ProblemKind::NotListed, words).for_repo(repo).accepted(accepted)
}

pub fn not_a_team(repo: &str, accepted: bool, why: Option<&str>) -> JoinProblem {
    let mut words = format!("{repo} isn't a Plyloft team.");
    if let Some(why) = why {
        words.push(' ');
        words.push_str(why);
    }
    if accepted {
        words.push_str(" You accepted GitHub's invitation to it; nothing else was changed.");
    }
    JoinProblem::new(ProblemKind::NotATeam, words).for_repo(repo).accepted(accepted)
}

pub fn expired(repo: &str) -> JoinProblem {
    JoinProblem::new(ProblemKind::Expired, "The GitHub invitation expired. Ask the owner to invite you again.")
        .for_repo(repo)
}

pub fn invitation_gone(repo: &str) -> JoinProblem {
    JoinProblem::new(
        ProblemKind::InvitationGone,
        format!("The invitation to {repo} isn't on GitHub any more. Check again, or ask the owner to invite you again."),
    )
    .for_repo(repo)
}

/// The one-team-per-Mac refusal, when the replacement wasn't confirmed.
pub fn needs_replace(current: &CurrentTeam, joining: &str) -> JoinProblem {
    let current_name = current.name.clone().unwrap_or_else(|| current.repo.clone());
    JoinProblem::new(
        ProblemKind::NeedsReplace,
        format!(
            "{} is in “{current_name}”. Joining “{joining}” replaces it.",
            crate::platform::THIS_MACHINE_CAP
        ),
    )
    .for_repo(joining)
}

/// A `team.json` larger than [`MAX_MANIFEST_BYTES`]: its read is stopped at
/// the cap, and the repository is not taken for a team.
pub const TOO_LARGE_MANIFEST: &str = "Its team.json is too large to be a team's.";
/// A detection read that the overall deadline left unasked.
pub const DETECT_DEADLINE: &str = "Plyloft stopped looking before GitHub answered for this repository.";

/// A failed `team.json` read in words: too large is "not a team", anything
/// else is gh's failure.
pub fn manifest_problem(err: &str, repo: &str, login: &str, accepted: bool) -> JoinProblem {
    if err == TOO_LARGE_MANIFEST {
        not_a_team(repo, accepted, Some(TOO_LARGE_MANIFEST))
    } else {
        gh_problem(err, login).for_repo(repo).accepted(accepted)
    }
}

/// A `gh` failure in words: single sign-on (the organisation from gh's own
/// URL), offline, a refused sign-in, a rate limit, or GitHub's own words.
pub fn gh_problem(err: &str, login: &str) -> JoinProblem {
    let details = Some(err.trim().to_string()).filter(|d| !d.is_empty());
    let lower = err.to_ascii_lowercase();
    let mut problem = if let Some(sso) = crate::setup_github::sso_need(err) {
        let mut p = JoinProblem::new(
            ProblemKind::Sso,
            match sso.org.as_deref() {
                Some(org) => format!("Your organization “{org}” needs you to authorize the GitHub CLI for single sign-on."),
                None => "Your organization needs you to authorize the GitHub CLI for single sign-on.".to_string(),
            },
        );
        p.org = sso.org;
        p
    } else if is_offline(&lower) {
        JoinProblem::new(ProblemKind::Offline, "Joining needs GitHub. You're offline.")
    } else if lower.contains("http 401") || lower.contains("bad credentials") || lower.contains("gh auth login") {
        JoinProblem::new(
            ProblemKind::SignedOut,
            format!("GitHub didn't accept {login}'s sign-in. Sign in again in the GitHub step."),
        )
    } else if crate::github::classify_gh_error(err) == crate::github::GhErrorKind::RateLimited {
        JoinProblem::new(
            ProblemKind::RateLimited,
            "GitHub is limiting how often this account can ask. Try again in a few minutes.",
        )
    } else if err == crate::project_setup::GH_UNAVAILABLE {
        JoinProblem::new(ProblemKind::Other, err)
    } else {
        JoinProblem::new(ProblemKind::Other, "GitHub answered something Plyloft didn't expect.")
    };
    problem.details = details;
    problem
}

fn is_offline(lower: &str) -> bool {
    [
        "could not resolve host",
        "no such host",
        "dial tcp",
        "network is unreachable",
        "connection refused",
        "connection reset",
        "i/o timeout",
        "tls handshake",
        "timed out",
        "didn't finish within",
        "didn't answer in time",
        "error connecting to",
    ]
    .iter()
    .any(|m| lower.contains(m))
}

// ── The manifest, read as a joiner ─────────────────────────────────────

/// What a joiner is shown of `team.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadTeam {
    pub name: Option<String>,
    pub owner: Option<String>,
    pub lists_login: bool,
    /// Team workspaces: `owner/name` entries only, never the team repo.
    pub workspaces: Vec<String>,
}

pub fn read_team(repo: &str, bytes: &[u8], login: &str) -> Result<ReadTeam, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(TOO_LARGE_MANIFEST.into());
    }
    let manifest = crate::team::parse_manifest(bytes).map_err(|_| "Its team.json can't be read.".to_string())?;
    let mut workspaces: Vec<String> = Vec::new();
    for w in &manifest.workspaces {
        let r = w.repo.trim();
        if is_team_repo(r)
            && !r.eq_ignore_ascii_case(repo)
            && !workspaces.iter().any(|x| x.eq_ignore_ascii_case(r))
        {
            workspaces.push(r.to_string());
        }
    }
    Ok(ReadTeam {
        name: display_team_name(&manifest.name),
        owner: manifest
            .owner_login()
            .map(str::trim)
            .filter(|l| crate::team_admin::is_valid_login(l))
            .map(String::from),
        lists_login: crate::team_admin::is_valid_login(login) && manifest.lists(login),
        workspaces,
    })
}

// ── Detection (§12.4 point 1) ──────────────────────────────────────────

/// A team this account can already read that lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTeam {
    pub repo: String,
    pub name: String,
    /// The manifest's owner.
    pub owner: Option<String>,
    /// This Mac's team already.
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub login: String,
    pub teams: Vec<DetectedTeam>,
    /// Repositories looked at.
    pub scanned: usize,
    /// The list stopped at its bound: there may be more.
    pub truncated: bool,
    /// Repositories whose `team.json` couldn't be asked about.
    pub unanswered: usize,
    /// The overall deadline ([`DETECT_DEADLINE_AFTER`]) stopped the look
    /// before every repository was asked.
    pub timed_out: bool,
    pub problem: Option<JoinProblem>,
}

/// How long detection looks in all, however many repositories there are.
pub const DETECT_DEADLINE_AFTER: Duration = Duration::from_secs(30);

/// Repositories this account can read that carry a `team.json` listing
/// `login` (D16: only Ply teams; a pending invitation is never listed).
pub fn detect(gh: &dyn JoinGh, login: &str, current: Option<&str>, deadline: std::time::Instant) -> Detection {
    let mut out = Detection {
        login: login.to_string(),
        teams: Vec::new(),
        scanned: 0,
        truncated: false,
        unanswered: 0,
        timed_out: false,
        problem: None,
    };
    let repos: Vec<String> = match gh.repos(DETECT_LIMIT) {
        Ok(list) => list.into_iter().filter(|r| is_team_repo(r)).take(DETECT_LIMIT).collect(),
        Err(e) => {
            out.problem = Some(gh_problem(&e, login));
            return out;
        }
    };
    out.scanned = repos.len();
    out.truncated = repos.len() >= DETECT_LIMIT;
    let mut first_error: Option<String> = None;
    for (repo, answer) in gh.manifests(&repos, deadline) {
        match answer {
            Ok(Some(bytes)) => {
                let Ok(team) = read_team(&repo, &bytes, login) else { continue };
                if !team.lists_login {
                    continue;
                }
                out.teams.push(DetectedTeam {
                    current: current.is_some_and(|c| c.eq_ignore_ascii_case(&repo)),
                    name: team.name.unwrap_or_else(|| repo.clone()),
                    owner: team.owner,
                    repo,
                });
            }
            Ok(None) => {}
            // Too large to be a team's: not a team, and nothing to retry.
            Err(e) if e == TOO_LARGE_MANIFEST => {}
            Err(e) if e == DETECT_DEADLINE => {
                out.unanswered += 1;
                out.timed_out = true;
            }
            Err(e) => {
                out.unanswered += 1;
                first_error.get_or_insert(e);
            }
        }
    }
    // Nothing answered at all: say why rather than "no teams".
    if out.unanswered > 0 && out.unanswered == out.scanned {
        out.problem = Some(match first_error {
            Some(e) => gh_problem(&e, login),
            None => gh_problem("GitHub didn't answer in time", login),
        });
    }
    // Stable order for the list: as GitHub gave them (most recent first).
    let order: Vec<&String> = repos.iter().collect();
    out.teams.sort_by_key(|t| order.iter().position(|r| r.eq_ignore_ascii_case(&t.repo)));
    out
}

// ── The Join sheet (§5 step 6 Join 2) ──────────────────────────────────

/// The team this Mac is in now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTeam {
    pub repo: String,
    pub name: Option<String>,
}

/// What the sheet says about the team.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFacts {
    pub repo: String,
    pub url: String,
    /// The manifest's name, once it can be read.
    pub name: Option<String>,
    /// The repository's owner as GitHub says.
    pub repo_owner: Option<String>,
    pub repo_owner_is_org: bool,
    /// The manifest's owner, once it can be read.
    pub manifest_owner: Option<String>,
    pub private: Option<bool>,
    /// The account joining.
    pub login: String,
}

/// The team repository's pending invitation the sheet will accept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationFacts {
    pub id: u64,
    pub inviter: Option<String>,
    /// §5 step 6: *Invited by y, not the team's owner.* (allowed).
    pub inviter_not_owner: bool,
}

/// A team workspace's pending invitation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInvite {
    pub id: u64,
    pub repo: String,
    pub inviter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JoinPreview {
    /// The account can read the team and `team.json` lists it.
    #[serde(rename_all = "camelCase")]
    Ready {
        team: TeamFacts,
        workspace_invites: Vec<WorkspaceInvite>,
        replaces: Option<CurrentTeam>,
        already_in: bool,
        /// The GitHub calls Join makes, for Details.
        calls: Vec<String>,
    },
    /// A pending invitation to exactly this repository; `team.json` is read
    /// once it is accepted.
    #[serde(rename_all = "camelCase")]
    Invited {
        team: TeamFacts,
        invitation: InvitationFacts,
        replaces: Option<CurrentTeam>,
        calls: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Problem { problem: JoinProblem },
}

fn replaces(current: Option<&CurrentTeam>, repo: &str) -> Option<CurrentTeam> {
    current.filter(|c| !c.repo.eq_ignore_ascii_case(repo)).cloned()
}

fn team_url(repo: &str) -> String {
    format!("https://github.com/{repo}")
}

/// The Join sheet's facts for `repo`: whether this account can read it and is
/// listed, or has a pending invitation to exactly it.
pub fn preview(gh: &dyn JoinGh, repo: &str, login: &str, current: Option<&CurrentTeam>) -> JoinPreview {
    let problem = |p: JoinProblem| JoinPreview::Problem { problem: p };
    if !is_team_repo(repo) {
        return problem(code_problem(CodeRefusal::NotACode));
    }
    let facts = match gh.repo(repo) {
        Err(e) => return problem(gh_problem(&e, login).for_repo(repo)),
        Ok(f) => f,
    };
    match facts {
        Some(facts) => {
            let bytes = match gh.manifest(repo) {
                Err(e) => return problem(manifest_problem(&e, repo, login, false)),
                Ok(None) => return problem(not_a_team(repo, false, Some("It has no team.json."))),
                Ok(Some(b)) => b,
            };
            let team = match read_team(repo, &bytes, login) {
                Ok(t) => t,
                Err(why) => return problem(not_a_team(repo, false, Some(&why))),
            };
            if !team.lists_login {
                return problem(not_listed(repo, false));
            }
            // Pending invitations to the team's workspaces; not being able
            // to ask leaves the list empty (the picker asks again later).
            let workspace_invites = gh
                .invitations()
                .map(|list| workspace_invites_in(&list, &team.workspaces))
                .unwrap_or_default();
            let calls = join_calls(repo, None, &workspace_invites);
            JoinPreview::Ready {
                team: TeamFacts {
                    repo: facts.full_name.clone(),
                    url: team_url(&facts.full_name),
                    name: team.name,
                    repo_owner: facts.owner,
                    repo_owner_is_org: facts.owner_is_org,
                    manifest_owner: team.owner,
                    private: facts.private,
                    login: login.to_string(),
                },
                workspace_invites,
                already_in: current.is_some_and(|c| c.repo.eq_ignore_ascii_case(repo)),
                replaces: replaces(current, repo),
                calls,
            }
        }
        None => {
            let list = match gh.invitations() {
                Err(e) => return problem(gh_problem(&e, login).for_repo(repo)),
                Ok(l) => l,
            };
            // D16: only an invitation to exactly this repository.
            let Some(inv) = list.iter().find(|i| i.repo.eq_ignore_ascii_case(repo)) else {
                return problem(no_access(repo, login));
            };
            if inv.expired {
                return problem(expired(repo));
            }
            let inviter_not_owner = !inv.owner_is_org
                && match (&inv.inviter, &inv.owner) {
                    (Some(by), Some(owner)) => !by.eq_ignore_ascii_case(owner),
                    _ => false,
                };
            JoinPreview::Invited {
                team: TeamFacts {
                    repo: inv.repo.clone(),
                    url: team_url(&inv.repo),
                    name: None,
                    repo_owner: inv.owner.clone(),
                    repo_owner_is_org: inv.owner_is_org,
                    manifest_owner: None,
                    private: None,
                    login: login.to_string(),
                },
                invitation: InvitationFacts { id: inv.id, inviter: inv.inviter.clone(), inviter_not_owner },
                replaces: replaces(current, repo),
                calls: join_calls(repo, Some(inv.id), &[]),
            }
        }
    }
}

/// Pending, unexpired invitations to the listed team workspaces.
pub fn workspace_invites_in(list: &[Invitation], workspaces: &[String]) -> Vec<WorkspaceInvite> {
    list.iter()
        .filter(|i| !i.expired && workspaces.iter().any(|w| w.eq_ignore_ascii_case(&i.repo)))
        .map(|i| WorkspaceInvite { id: i.id, repo: i.repo.clone(), inviter: i.inviter.clone() })
        .collect()
}

/// The `gh api` calls a Join makes (the sheet's Details).
pub fn join_calls(repo: &str, invitation: Option<u64>, workspaces: &[WorkspaceInvite]) -> Vec<String> {
    let mut calls = Vec::new();
    if let Some(id) = invitation {
        calls.push("gh api user/repository_invitations".to_string());
        calls.push(format!("gh api -X PATCH user/repository_invitations/{id}"));
    }
    calls.push(format!("gh api repos/{repo}/contents/{}", crate::team::MANIFEST_FILE));
    for w in workspaces {
        calls.push(format!("gh api -X PATCH user/repository_invitations/{}  # {}", w.id, w.repo));
    }
    calls
}

// ── Joining (the sheet's Join) ─────────────────────────────────────────

/// What the sheet's `[Join]` sends.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub repo: String,
    /// The team repository's invitation the sheet showed, when there was one.
    #[serde(default)]
    pub accept_invitation: Option<u64>,
    /// The team workspaces whose invitations the sheet listed.
    #[serde(default)]
    pub accept_workspaces: Vec<String>,
    /// The one-team-per-Mac replacement was confirmed.
    #[serde(default)]
    pub replace: bool,
}

/// What a verified join found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub repo: String,
    pub team: ReadTeam,
    pub accepted_invitation: bool,
}

/// D16: accept the team repository's invitation (only the one the sheet
/// showed, only if it is still GitHub's invitation to **this** repository),
/// then read `team.json` and stop unless it lists `login`. Writes nothing
/// of Plyloft's; the caller writes `settings.team.teamRepo` after `Ok`.
pub fn verify_join(
    gh: &dyn JoinGh,
    request: &JoinRequest,
    login: &str,
    current: Option<&CurrentTeam>,
) -> Result<Verified, JoinProblem> {
    let repo = request.repo.trim();
    if !is_team_repo(repo) {
        return Err(code_problem(CodeRefusal::NotACode));
    }
    if let Some(current) = replaces(current, repo) {
        if !request.replace {
            return Err(needs_replace(&current, repo));
        }
    }
    let mut accepted = false;
    if let Some(id) = request.accept_invitation {
        let list = gh.invitations().map_err(|e| gh_problem(&e, login).for_repo(repo))?;
        // Re-checked against GitHub right before accepting: the id must
        // still be an invitation, to exactly the pasted repository.
        let Some(inv) = list.iter().find(|i| i.id == id) else {
            return Err(invitation_gone(repo));
        };
        if !inv.repo.eq_ignore_ascii_case(repo) {
            return Err(JoinProblem::new(
                ProblemKind::Other,
                format!("That invitation isn't for {repo}. Plyloft accepts only the invitation to the team you pasted."),
            )
            .for_repo(repo));
        }
        if inv.expired {
            return Err(expired(repo));
        }
        gh.accept_invitation(id).map_err(|e| gh_problem(&e, login).for_repo(repo))?;
        accepted = true;
    }
    let mut answer = gh.manifest(repo);
    if accepted && matches!(answer, Ok(None)) {
        // GitHub can take a moment to give access after an accept.
        gh.settle();
        answer = gh.manifest(repo);
    }
    let bytes = match answer {
        Ok(Some(bytes)) => bytes,
        Ok(None) if accepted => return Err(not_a_team(repo, true, Some("It has no team.json."))),
        Ok(None) => {
            // No team.json, or no access at all: ask which.
            return Err(match gh.repo(repo) {
                Ok(None) => no_access(repo, login),
                Err(e) => gh_problem(&e, login).for_repo(repo),
                Ok(Some(_)) => not_a_team(repo, false, Some("It has no team.json.")),
            });
        }
        Err(e) => return Err(manifest_problem(&e, repo, login, accepted)),
    };
    let team = read_team(repo, &bytes, login).map_err(|why| not_a_team(repo, accepted, Some(&why)))?;
    if !team.lists_login {
        return Err(not_listed(repo, accepted));
    }
    Ok(Verified { repo: repo.to_string(), team, accepted_invitation: accepted })
}

/// A team workspace invitation that couldn't be accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFailure {
    pub repo: String,
    pub words: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAccepts {
    pub accepted: Vec<String>,
    pub failed: Vec<WorkspaceFailure>,
    /// Invitations to team workspaces still pending (not asked for).
    pub pending: Vec<WorkspaceInvite>,
}

/// Accept the invitations to the team workspaces `requested` names — only
/// those the manifest lists (`workspaces`) and GitHub has pending now.
pub fn accept_workspace_invites(
    gh: &dyn JoinGh,
    workspaces: &[String],
    requested: &[String],
    login: &str,
) -> WorkspaceAccepts {
    let mut out = WorkspaceAccepts::default();
    let list = match gh.invitations() {
        Ok(l) => l,
        Err(e) => {
            let words = gh_problem(&e, login).words;
            out.failed = requested
                .iter()
                .filter(|r| workspaces.iter().any(|w| w.eq_ignore_ascii_case(r)))
                .map(|r| WorkspaceFailure { repo: r.clone(), words: words.clone() })
                .collect();
            return out;
        }
    };
    for invite in workspace_invites_in(&list, workspaces) {
        if !requested.iter().any(|r| r.trim().eq_ignore_ascii_case(&invite.repo)) {
            out.pending.push(invite);
            continue;
        }
        match gh.accept_invitation(invite.id) {
            Ok(()) => out.accepted.push(invite.repo),
            Err(e) => out.failed.push(WorkspaceFailure { repo: invite.repo, words: gh_problem(&e, login).words }),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JoinResult {
    #[serde(rename_all = "camelCase")]
    Joined {
        repo: String,
        name: String,
        accepted_invitation: bool,
        workspaces: WorkspaceAccepts,
        /// The team this Mac followed before, when the join replaced it.
        replaced: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Problem { problem: JoinProblem },
}

// ── gh, for real ───────────────────────────────────────────────────────

/// One `gh` call's bound.
const GH_CALL: Duration = Duration::from_secs(20);
/// How many `team.json` reads detection runs at once.
const LANES: usize = 8;

/// [`JoinGh`] over the GitHub CLI, as `account` (gh's active account when
/// the token is `None`). The token lives in the child's environment only.
pub struct RealJoinGh {
    pub tools: Tools,
    pub token: Option<GhToken>,
}

#[derive(Deserialize)]
struct ApiOwner {
    login: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct ApiRepo {
    full_name: Option<String>,
    private: Option<bool>,
    owner: Option<ApiOwner>,
}

#[derive(Deserialize)]
struct ApiInvitation {
    id: Option<u64>,
    repository: Option<ApiRepo>,
    inviter: Option<ApiOwner>,
    #[serde(default)]
    expired: bool,
}

fn login_of(owner: &Option<ApiOwner>) -> Option<String> {
    owner
        .as_ref()
        .and_then(|o| o.login.as_deref())
        .map(str::trim)
        .filter(|l| crate::team_admin::is_valid_login(l))
        .map(String::from)
}

fn is_org(owner: &Option<ApiOwner>) -> bool {
    owner.as_ref().and_then(|o| o.kind.as_deref()) == Some("Organization")
}

/// Pure: `gh api user/repository_invitations`. An entry whose repository
/// isn't a team repository name is dropped.
pub fn parse_invitations(json: &str) -> Result<Vec<Invitation>, String> {
    let list: Vec<ApiInvitation> =
        serde_json::from_str(json.trim()).map_err(|_| "GitHub's list of invitations couldn't be read.".to_string())?;
    Ok(list
        .into_iter()
        .filter_map(|i| {
            let repo = i.repository.as_ref()?;
            let full = repo.full_name.as_deref()?.trim().to_string();
            if !is_team_repo(&full) {
                return None;
            }
            Some(Invitation {
                id: i.id?,
                owner: login_of(&repo.owner),
                owner_is_org: is_org(&repo.owner),
                repo: full,
                inviter: login_of(&i.inviter),
                expired: i.expired,
            })
        })
        .collect())
}

/// Pure: `gh api repos/<r>`.
pub fn parse_repo(json: &str) -> Result<RepoFacts, String> {
    let repo: ApiRepo =
        serde_json::from_str(json.trim()).map_err(|_| "GitHub's answer about the repository couldn't be read.".to_string())?;
    let full_name = repo
        .full_name
        .as_deref()
        .map(str::trim)
        .filter(|f| is_team_repo(f))
        .ok_or_else(|| "GitHub's answer about the repository couldn't be read.".to_string())?
        .to_string();
    Ok(RepoFacts {
        full_name,
        private: repo.private,
        owner: login_of(&repo.owner),
        owner_is_org: is_org(&repo.owner),
    })
}

/// GitHub refused to show the thing (404/403), and it wasn't single sign-on.
fn refused(err: &str) -> bool {
    crate::setup_github::sso_need(err).is_none()
        && crate::github::classify_gh_error(err) == crate::github::GhErrorKind::Denied
}

impl RealJoinGh {
    /// `team.json`, read to at most [`MAX_MANIFEST_BYTES`] (the read stops
    /// there; the bytes are never all held).
    fn manifest_within(&self, repo: &str, timeout: Duration) -> Result<Option<Vec<u8>>, String> {
        use crate::worktrees::BoundedFailure;
        let path = format!("repos/{repo}/contents/{}", crate::team::MANIFEST_FILE);
        let mut command = self.tools.gh(self.token.as_ref())?;
        command.args(["api", "-H", "Accept: application/vnd.github.raw", &path]);
        let out = match crate::worktrees::run_bounded_output_capped(&mut command, timeout, MAX_MANIFEST_BYTES) {
            Ok(out) => out,
            Err(BoundedFailure::Truncated) => return Err(TOO_LARGE_MANIFEST.into()),
            Err(BoundedFailure::TimedOut) => {
                return Err(format!("It didn't finish within {} seconds.", timeout.as_secs()))
            }
            Err(BoundedFailure::Quitting) => return Err("Plyloft is quitting.".into()),
            Err(BoundedFailure::Spawn(_)) => return Err(crate::project_setup::GH_UNAVAILABLE.into()),
        };
        if out.status.success() {
            return Ok(Some(out.stdout));
        }
        let words = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let e = crate::project_setup::redact(&words, self.token.as_ref());
        if refused(&e) {
            Ok(None)
        } else {
            Err(e)
        }
    }

    fn api(&self, args: &[&str]) -> Result<String, String> {
        let mut command = self.tools.gh(self.token.as_ref())?;
        command.arg("api").args(args);
        let ran = crate::project_setup::run(&mut command, GH_CALL)?;
        if ran.ok() {
            Ok(ran.stdout)
        } else {
            Err(crate::project_setup::redact(&ran.words(), self.token.as_ref()))
        }
    }
}

impl JoinGh for RealJoinGh {
    fn repo(&self, repo: &str) -> Result<Option<RepoFacts>, String> {
        match self.api(&[&format!("repos/{repo}")]) {
            Ok(json) => parse_repo(&json).map(Some),
            Err(e) if refused(&e) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn manifest(&self, repo: &str) -> Result<Option<Vec<u8>>, String> {
        self.manifest_within(repo, GH_CALL)
    }

    fn invitations(&self) -> Result<Vec<Invitation>, String> {
        parse_invitations(&self.api(&["user/repository_invitations?per_page=100"])?)
    }

    fn accept_invitation(&self, id: u64) -> Result<(), String> {
        self.api(&["-X", "PATCH", &format!("user/repository_invitations/{id}")]).map(|_| ())
    }

    fn repos(&self, limit: usize) -> Result<Vec<String>, String> {
        let endpoint = format!(
            "user/repos?per_page={}&sort=pushed&affiliation=owner,collaborator,organization_member",
            limit.clamp(1, 100)
        );
        let json = self.api(&[&endpoint, "--jq", "[.[].full_name]"])?;
        serde_json::from_str::<Vec<String>>(json.trim())
            .map_err(|_| "GitHub's list of repositories couldn't be read.".to_string())
    }

    fn settle(&self) {
        std::thread::sleep(Duration::from_secs(2));
    }

    fn manifests(
        &self,
        repos: &[String],
        deadline: std::time::Instant,
    ) -> Vec<(String, Result<Option<Vec<u8>>, String>)> {
        let next = std::sync::atomic::AtomicUsize::new(0);
        let out = std::sync::Mutex::new(Vec::with_capacity(repos.len()));
        std::thread::scope(|scope| {
            for _ in 0..LANES.min(repos.len()) {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(repo) = repos.get(i) else { return };
                    // Past the deadline nothing new is asked, and a call
                    // started before it gets only the time left.
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    let answer = if left.is_zero() {
                        Err(DETECT_DEADLINE.to_string())
                    } else {
                        self.manifest_within(repo, left.min(GH_CALL).max(Duration::from_secs(1)))
                    };
                    out.lock().unwrap_or_else(|e| e.into_inner()).push((repo.clone(), answer));
                });
            }
        });
        out.into_inner().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Commands ───────────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("team worker failed: {e}"))?
}

/// gh as `account` (else the active one), and the login it is.
pub(crate) fn signed_in(account: Option<&str>) -> Result<(RealJoinGh, String), JoinProblem> {
    let tools = Tools::production();
    if tools.gh.is_none() {
        return Err(JoinProblem::new(ProblemKind::SignedOut, "Connect GitHub first."));
    }
    let chosen = account.map(str::trim).filter(|a| !a.is_empty());
    let token = crate::project_setup::token_for(&tools, chosen)
        .map_err(|e| JoinProblem::new(ProblemKind::SignedOut, e))?;
    let login = match chosen {
        Some(login) => login.to_string(),
        None => crate::project_setup::active_login(&tools).map_err(|e| {
            let mut p = gh_problem(&e, "this account");
            if p.kind == ProblemKind::Other {
                p = JoinProblem::new(ProblemKind::SignedOut, e);
            }
            p
        })?,
    };
    Ok((RealJoinGh { tools, token }, login))
}

fn current_team<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<CurrentTeam> {
    let repo = crate::commands::current_team_repo(app)?;
    let name = crate::team::read_manifest(&app.state::<crate::team::TeamStore>().clone_dir(&repo))
        .ok()
        .flatten()
        .and_then(|m| display_team_name(&m.name));
    Some(CurrentTeam { repo, name })
}

/// Detection's answers this session, by login (lowercase). Only a look that
/// finished cleanly is kept; `Look again` asks GitHub afresh.
static DETECTED: std::sync::Mutex<Option<std::collections::HashMap<String, Detection>>> = std::sync::Mutex::new(None);

/// A kept answer, with `current` re-read (the team this Mac is in may have
/// changed since).
pub fn cached_detection(login: &str, current: Option<&str>) -> Option<Detection> {
    let guard = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
    let mut found = guard.as_ref()?.get(&login.to_ascii_lowercase())?.clone();
    for t in &mut found.teams {
        t.current = current.is_some_and(|c| c.eq_ignore_ascii_case(&t.repo));
    }
    Some(found)
}

/// Keep `detection` for its login when it is a clean answer.
pub fn remember_detection(detection: &Detection) {
    if detection.problem.is_some() || detection.timed_out || detection.unanswered > 0 {
        return;
    }
    let mut guard = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(Default::default)
        .insert(detection.login.to_ascii_lowercase(), detection.clone());
}

/// §12.4 point 1: the teams this account can already read that list it.
/// Kept for the session per account; `refresh` looks again.
#[tauri::command]
pub async fn team_join_detect(
    app: AppHandle,
    account: Option<String>,
    refresh: Option<bool>,
) -> Result<Detection, String> {
    blocking(move || {
        let (gh, login) = match signed_in(account.as_deref()) {
            Ok(x) => x,
            Err(problem) => {
                return Ok(Detection {
                    login: String::new(),
                    teams: Vec::new(),
                    scanned: 0,
                    truncated: false,
                    unanswered: 0,
                    timed_out: false,
                    problem: Some(problem),
                })
            }
        };
        Ok(detection_for(&app, &gh, &login, refresh.unwrap_or(false)))
    })
    .await
}

/// The teams listing `login`: this session's kept answer unless `refresh`,
/// else a fresh look, kept when it is clean. Also Setup's solo/team
/// deduction's read (1.175.0 F2, `setup_team_hint.rs`), so the Join the
/// step then offers is the same answer.
pub(crate) fn detection_for(app: &AppHandle, gh: &dyn JoinGh, login: &str, refresh: bool) -> Detection {
    let current = crate::commands::current_team_repo(app);
    if !refresh {
        if let Some(kept) = cached_detection(login, current.as_deref()) {
            return kept;
        }
    }
    let found = detect(gh, login, current.as_deref(), std::time::Instant::now() + DETECT_DEADLINE_AFTER);
    remember_detection(&found);
    found
}

/// The Join sheet for a pasted code (or a detected team's `owner/name`).
/// Reads GitHub; changes nothing.
#[tauri::command]
pub async fn team_join_preview(app: AppHandle, code: String, account: Option<String>) -> Result<JoinPreview, String> {
    blocking(move || {
        let repo = match parse_invite_code(&code) {
            Ok(repo) => repo,
            Err(refusal) => return Ok(JoinPreview::Problem { problem: code_problem(refusal) }),
        };
        let (gh, login) = match signed_in(account.as_deref()) {
            Ok(x) => x,
            Err(problem) => return Ok(JoinPreview::Problem { problem }),
        };
        Ok(preview(&gh, &repo, &login, current_team(&app).as_ref()))
    })
    .await
}

/// The sheet's `[Join]`: [`verify_join`], then — only then — this Mac's team
/// is recorded (`settings.team.teamRepo`, and `settings.team.account`: the
/// account chosen, else the gh login the join verified — launch G3, so the
/// team gates compare with a record), then the team workspace invitations the
/// sheet named are accepted.
#[tauri::command]
pub async fn team_join_confirm(
    app: AppHandle,
    request: JoinRequest,
    account: Option<String>,
) -> Result<JoinResult, String> {
    blocking(move || {
        let (gh, login) = match signed_in(account.as_deref()) {
            Ok(x) => x,
            Err(problem) => return Ok(JoinResult::Problem { problem }),
        };
        let current = current_team(&app);
        let verified = match verify_join(&gh, &request, &login, current.as_ref()) {
            Ok(v) => v,
            Err(problem) => return Ok(JoinResult::Problem { problem }),
        };
        let replaced = replaces(current.as_ref(), &verified.repo).map(|c| c.repo);
        let settings = app.state::<crate::settings::SettingsStore>();
        // Launch G3 (Challenger P3-5): the account the join ran as is the
        // team's account from now on — the one chosen, else gh's active login
        // the join verified — so the team gates compare with a record.
        let chosen = account
            .as_deref()
            .map(str::trim)
            .filter(|a| !a.is_empty())
            .map(String::from)
            .or_else(|| Some(login.trim().to_string()).filter(|l| !l.is_empty()));
        let saved = match settings.set_joined_team(&verified.repo, chosen) {
            Ok(saved) => saved,
            Err(e) => return Ok(JoinResult::Problem { problem: not_remembered(&verified, &e) }),
        };
        if replaced.is_some() {
            app.state::<crate::team::TeamStore>().forget_membership();
        }
        let _ = app.emit("settings://changed", saved);
        let workspaces = if request.accept_workspaces.is_empty() {
            // Nothing asked: only say what is pending.
            gh.invitations()
                .map(|list| WorkspaceAccepts {
                    pending: workspace_invites_in(&list, &verified.team.workspaces),
                    ..WorkspaceAccepts::default()
                })
                .unwrap_or_default()
        } else {
            accept_workspace_invites(&gh, &verified.team.workspaces, &request.accept_workspaces, &login)
        };
        Ok(JoinResult::Joined {
            name: verified.team.name.clone().unwrap_or_else(|| verified.repo.clone()),
            repo: verified.repo,
            accepted_invitation: verified.accepted_invitation,
            workspaces,
            replaced,
        })
    })
    .await
}

fn not_in_a_team() -> String {
    format!("{} isn't in a team yet.", crate::platform::THIS_MACHINE_CAP)
}

/// The join was verified but this Mac's settings couldn't be written: said
/// with what was already accepted on GitHub.
pub fn not_remembered(verified: &Verified, err: &str) -> JoinProblem {
    let mut p = JoinProblem::new(
        ProblemKind::Other,
        format!(
            "Plyloft checked the team, but couldn't remember it on {}. Join again.",
            crate::platform::THIS_MACHINE
        ),
    )
    .for_repo(&verified.repo)
    .accepted(verified.accepted_invitation);
    p.details = Some(err.to_string());
    p
}

/// The account for a call about this Mac's team: the one given, else the
/// one the team was joined with (`settings.team.account`) — never silently
/// gh's active one when a join chose another.
pub fn team_account(given: Option<&str>, remembered: Option<&str>) -> Option<String> {
    given
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .or_else(|| remembered.map(str::trim).filter(|a| !a.is_empty()))
        .map(String::from)
}

fn joined_account<R: tauri::Runtime>(app: &AppHandle<R>, given: Option<&str>) -> Option<String> {
    let remembered = app.state::<crate::settings::SettingsStore>().snapshot().team.account;
    team_account(given, remembered.as_deref())
}

/// The team manifest's workspaces, read from GitHub (the local clone may not
/// be there yet right after joining).
fn current_workspaces(gh: &dyn JoinGh, repo: &str, login: &str) -> Result<Vec<String>, JoinProblem> {
    match gh.manifest(repo) {
        Ok(Some(bytes)) => read_team(repo, &bytes, login)
            .map(|t| t.workspaces)
            .map_err(|why| not_a_team(repo, false, Some(&why))),
        Ok(None) => Err(not_a_team(repo, false, Some("It has no team.json."))),
        Err(e) => Err(manifest_problem(&e, repo, login, false)),
    }
}

/// Pending invitations to this Mac's team's workspaces.
#[tauri::command]
pub async fn team_join_workspace_invites(app: AppHandle, account: Option<String>) -> Result<WorkspaceAccepts, String> {
    blocking(move || {
        let repo = crate::commands::current_team_repo(&app).ok_or_else(not_in_a_team)?;
        let account = joined_account(&app, account.as_deref());
        let (gh, login) = signed_in(account.as_deref()).map_err(|p| p.words)?;
        let workspaces = current_workspaces(&gh, &repo, &login).map_err(|p| p.words)?;
        let list = gh.invitations().map_err(|e| gh_problem(&e, &login).words)?;
        Ok(WorkspaceAccepts { pending: workspace_invites_in(&list, &workspaces), ..WorkspaceAccepts::default() })
    })
    .await
}

/// Accept the invitations to the team workspaces the sheet named — only
/// those this Mac's team's manifest lists.
#[tauri::command]
pub async fn team_join_accept_workspaces(
    app: AppHandle,
    repos: Vec<String>,
    account: Option<String>,
) -> Result<WorkspaceAccepts, String> {
    blocking(move || {
        let repo = crate::commands::current_team_repo(&app).ok_or_else(not_in_a_team)?;
        let account = joined_account(&app, account.as_deref());
        let (gh, login) = signed_in(account.as_deref()).map_err(|p| p.words)?;
        let workspaces = current_workspaces(&gh, &repo, &login).map_err(|p| p.words)?;
        Ok(accept_workspace_invites(&gh, &workspaces, &repos, &login))
    })
    .await
}

/// **Copy invite** (§12.2): this Mac's team's code and the message around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCodeView {
    pub code: String,
    pub message: String,
}

#[tauri::command(async)]
pub fn team_invite_code(app: AppHandle) -> Result<InviteCodeView, String> {
    let current = current_team(&app).ok_or_else(not_in_a_team)?;
    let code = encode_invite_code(&current.repo).ok_or_else(|| format!("{} isn't a team repository name.", current.repo))?;
    let message = invite_message(current.name.as_deref().unwrap_or(&current.repo), &current.repo)
        .ok_or_else(|| format!("{} isn't a team repository name.", current.repo))?;
    Ok(InviteCodeView { code, message })
}

#[cfg(test)]
#[path = "team_join_tests.rs"]
mod tests;
