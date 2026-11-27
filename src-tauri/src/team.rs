//! v1.114.0 (team sharing rung 1): joining a team and picking its workspaces.
//!
//! A team **is** a private GitHub repository — there is no Ply server and
//! there will not be one (ADR 0002, `docs/adr/0002-team-is-a-github-repo.md`).
//! That repo holds `team.json`, the manifest that defines the team, and a
//! `library/` that rungs 2 and 3 fill. This module is everything Ply needs
//! to *read* that arrangement:
//!
//! - [`parse_manifest`] — the manifest format, written by
//!   `scripts/team-init.sh` and (from rung 5) by Settings → Team.
//! - [`Membership`] — the one definition of "is this person in the team":
//!   listed in the manifest **and** able to read the repo on GitHub. Both
//!   halves fail with their own explicit, actionable reason.
//! - [`TeamStore`] — the local clone under `<config_dir>/team/<slug>/`,
//!   cloned once and pulled afterwards. It is never a workspace.
//! - [`add_workspace_with`] — the Team-workspaces picker: clone a listed
//!   repo under the clone root and register it through the
//!   `workspace::import_default` path, idempotently.
//!
//! Every git/`gh` call is injected at the call site, so the tests here run
//! entirely on temporary directories and never reach the network.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::platform::{THIS_MACHINE, THIS_MACHINE_CAP};
use crate::workspace::WorkspaceStore;

/// Manifest file name inside the team repo.
pub const MANIFEST_FILE: &str = "team.json";

/// Directory under the app-support config dir holding every team clone.
const TEAM_DIR: &str = "team";

/// Where team workspaces are cloned when the user has chosen neither a clone
/// root nor a projects folder: the projects folder's own default,
/// `~/Projects` (`%USERPROFILE%\Projects` on Windows) — 1.168.1, owner
/// decision 2026-10-22: team workspaces go to the projects folder Setup
/// shows, never a separate `~/code`.
pub fn default_clone_root() -> PathBuf {
    expand_tilde(crate::settings::DEFAULT_PROJECTS_FOLDER)
}

/// Where team workspaces were cloned before 1.168.1 when nothing was chosen
/// (and `scripts/onboard.sh`'s `PLY_CODE_DIR` default). Read only to find
/// checkouts already there: [`effective_clone_root`] keeps using it while
/// one is, so nothing is moved or cloned twice.
pub fn legacy_clone_root() -> PathBuf {
    home_dir().join("code")
}

/// The clone root team workspaces resolve under: the setting
/// ([`clone_root_setting`]) when there is one; else the legacy `~/code`
/// while it already holds a checkout of one of the team's workspaces;
/// else [`default_clone_root`].
pub fn effective_clone_root(setting: Option<&str>, manifest: Option<&TeamManifest>) -> PathBuf {
    effective_clone_root_with(setting, manifest, legacy_clone_root())
}

/// [`effective_clone_root`] with the legacy root given (tests).
fn effective_clone_root_with(
    setting: Option<&str>,
    manifest: Option<&TeamManifest>,
    legacy: PathBuf,
) -> PathBuf {
    if setting.map(str::trim).is_some_and(|s| !s.is_empty()) {
        return clone_root(setting);
    }
    if manifest.is_some_and(|m| has_checkout_under(&legacy, m)) {
        return legacy;
    }
    default_clone_root()
}

/// [`effective_clone_root`] and the rows under it, reading the legacy root's
/// checkouts once: with nothing chosen, the rows under `~/code` are both the
/// question (is one of them cloned there?) and, when one is, the answer.
fn effective_root_and_views(
    setting: Option<&str>,
    manifest: Option<&TeamManifest>,
    workspaces: &WorkspaceStore,
) -> (PathBuf, Vec<TeamWorkspaceView>) {
    effective_root_and_views_with(setting, manifest, workspaces, legacy_clone_root())
}

fn effective_root_and_views_with(
    setting: Option<&str>,
    manifest: Option<&TeamManifest>,
    workspaces: &WorkspaceStore,
    legacy: PathBuf,
) -> (PathBuf, Vec<TeamWorkspaceView>) {
    let chosen = setting.map(str::trim).is_some_and(|s| !s.is_empty());
    if !chosen && manifest.is_some() {
        let views = workspace_views(manifest, &legacy, workspaces);
        if views.iter().any(|v| v.cloned && v.conflict.is_none()) {
            return (legacy, views);
        }
        let root = default_clone_root();
        let views = workspace_views(manifest, &root, workspaces);
        return (root, views);
    }
    let root = effective_clone_root_with(setting, manifest, legacy);
    let views = workspace_views(manifest, &root, workspaces);
    (root, views)
}

/// Whether `root` holds a checkout of one of the manifest's workspaces
/// (where [`resolve_destination`] would put it, and it is that repo's).
fn has_checkout_under(root: &Path, manifest: &TeamManifest) -> bool {
    manifest.workspaces.iter().any(|entry| {
        resolve_destination(root, entry).is_ok_and(|dest| dest.join(".git").exists())
    })
}

/// The home directory ([`crate::platform::home_dir`]), or the current
/// directory if the process somehow has none (the same fallback `shell_env`
/// uses — never panic over a missing variable).
fn home_dir() -> PathBuf {
    crate::platform::home_dir()
        .filter(|h| !h.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The user's clone root: their setting when they have one, else
/// [`default_clone_root`]. A leading `~` is expanded — the settings field is
/// free text and "~/code" is what a human types.
pub fn clone_root(setting: Option<&str>) -> PathBuf {
    match setting.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => expand_tilde(raw),
        None => default_clone_root(),
    }
}

/// Onboarding §8.2: the clone-root setting [`clone_root`] reads — the team's
/// own `cloneRoot` when set (kept, D9), else the projects folder Setup chose,
/// else `None`: the projects folder's default, `~/Projects`, unless team
/// workspaces are already cloned in the legacy `~/code`
/// ([`effective_clone_root`]).
pub fn clone_root_setting<'a>(
    team: &'a crate::settings::TeamSettings,
    projects: &'a crate::settings::ProjectsSettings,
) -> Option<&'a str> {
    team.clone_root
        .as_deref()
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .or_else(|| projects.chosen())
}

/// Onboarding §11.1: the team this Mac is in — `settings.team.teamRepo`
/// (joined or created). Blank reads as absent. Launch G3: a stored `PLY1`
/// key's `teamRepo` no longer names one.
pub fn current_team_repo(team: &crate::settings::TeamSettings) -> Option<String> {
    team.team_repo
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Onboarding §5 step 2 / §8.3: what on this Mac says "there is a team here",
/// gathered by the caller (the key, the workspaces, the clone directory) so
/// [`effective_work_mode`] stays pure. `settings.team.teamRepo` is read from
/// the settings themselves.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamSignals {
    /// A workspace whose board is backed by GitHub Issues.
    pub github_issues_workspace: bool,
    /// A team clone under `<config_dir>/team/`.
    pub team_clone: bool,
    /// U6: the account's verified plan says this person owns a team, on a Mac
    /// that has no clone of it yet (a new Mac, a reinstall).
    pub plan_owns_team: bool,
}

/// Onboarding §8.3 / §10: solo or team, computed here and sent to the
/// frontend so it never re-derives it.
///
/// - A workspace on a GitHub Issues board is team, whatever was chosen: the
///   board is a team feature, and solo would hide the setting that switches
///   it back to Local (§5 step 2 refuses solo for this reason; §10 row 4).
/// - Otherwise an explicit choice wins — a key holder who chose solo stays
///   solo (§11.1).
/// - Otherwise it is derived: team when any team signal exists
///   (`team.teamRepo`, a team clone, a Team plan that says this person owns the
///   team), else solo.
pub fn effective_work_mode(
    team: &crate::settings::TeamSettings,
    signals: TeamSignals,
) -> crate::settings::WorkMode {
    use crate::settings::WorkMode;
    if signals.github_issues_workspace {
        return WorkMode::Team;
    }
    if let Some(chosen) = team.work_mode {
        return chosen;
    }
    let team_signal = signals.team_clone || signals.plan_owns_team || current_team_repo(team).is_some();
    if team_signal {
        WorkMode::Team
    } else {
        WorkMode::Solo
    }
}

/// Onboarding §8.3: the work mode as the frontend receives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkModeView {
    /// Solo or team, explicit or derived — what the surfaces follow.
    pub mode: crate::settings::WorkMode,
    /// Whether `settings.team.workMode` holds a choice (else derived).
    pub chosen: bool,
}

fn expand_tilde(raw: &str) -> PathBuf {
    if raw == "~" {
        return home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home_dir().join(rest);
    }
    PathBuf::from(raw)
}

// ── The manifest ────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub login: String,
    /// Exactly one member is the owner (the only person who edits members
    /// and team workspaces). Missing ⇒ not the owner.
    #[serde(default)]
    pub owner: bool,
    /// Skills hub H2 (§5.6): keys a later app writes on a member, kept as they
    /// are when this build rewrites `team.json`.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorkspace {
    /// `owner/name` on GitHub.
    pub repo: String,
    /// Optional display name; the repo's own
    /// `.atelier/workspace_default.json` still wins once it is cloned.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
}

/// `owner/name`, the only shape `gh` accepts and the only one that can be
/// joined onto the clone root safely. The manifest is a file the team owner
/// edits by hand, so a typo like `owner/../../etc` must be refused rather
/// than turned into a path outside the clone root.
pub fn is_valid_repo_slug(slug: &str) -> bool {
    let mut parts = slug.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |seg: &str| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    };
    ok(owner) && ok(name)
}

impl TeamWorkspace {
    /// The directory name a clone of this repo gets under the clone root.
    /// Only meaningful for a slug [`is_valid_repo_slug`] accepts — every
    /// caller checks first.
    pub fn dir_name(&self) -> &str {
        self.repo.rsplit('/').next().unwrap_or(&self.repo)
    }

    /// What to call the workspace when the repo carries no
    /// `workspace_default.json` of its own.
    pub fn display_name(&self) -> String {
        self.name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.dir_name())
            .to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamManifest {
    #[serde(default = "default_manifest_schema")]
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub members: Vec<TeamMember>,
    #[serde(default)]
    pub workspaces: Vec<TeamWorkspace>,
    /// Skills hub H2 (§5.6): keys this build does not know (a later app's
    /// `library`, say) survive an owner write from it. Without this an owner
    /// on an older app adding a member rewrote `team.json` without them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_manifest_schema() -> u32 {
    1
}

impl TeamManifest {
    /// GitHub logins are case-insensitive, and a manifest is hand-editable
    /// — comparing them byte-for-byte would lock people out over a capital
    /// letter.
    pub fn lists(&self, login: &str) -> bool {
        self.members
            .iter()
            .any(|m| m.login.eq_ignore_ascii_case(login.trim()))
    }

    pub fn owner_login(&self) -> Option<&str> {
        self.members
            .iter()
            .find(|m| m.owner)
            .map(|m| m.login.as_str())
    }
}

/// Parse `team.json`. The error is what Settings → Team shows, so it names
/// the file and the reason rather than a serde path.
pub fn parse_manifest(bytes: &[u8]) -> Result<TeamManifest, String> {
    let manifest: TeamManifest = serde_json::from_slice(bytes)
        .map_err(|e| format!("{MANIFEST_FILE} is not readable: {e}"))?;
    if manifest.name.trim().is_empty() {
        return Err(format!("{MANIFEST_FILE} has no team name."));
    }
    Ok(manifest)
}

// ── Membership ──────────────────────────────────────────────────────

/// Membership = listed in the manifest AND able to read the team repo.
/// Ply's job when someone cannot get in is to say **which** half is
/// missing, because the two have different fixes and different people fix
/// them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Membership {
    /// Both halves hold.
    Member,
    /// GitHub lets you read the repo, but `team.json` does not list you.
    /// Fix: the team owner adds your login to the manifest.
    NotListed,
    /// GitHub refuses the repo. Fix: the team owner grants your GitHub
    /// account access to it. This also covers "neither half holds" — with
    /// no access there is no manifest to be listed in, so access is always
    /// the first thing to repair.
    NoRepoAccess,
    /// Not evaluated yet (no refresh since launch, or `gh` was unreachable).
    Unknown,
}

impl Membership {
    /// The sentence Settings → Team shows under the membership state.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Membership::Member | Membership::Unknown => None,
            Membership::NotListed => Some(
                "GitHub lets you read the team repo, but the team manifest does not \
                 list your account. Ask the team owner to add you.",
            ),
            Membership::NoRepoAccess => Some(
                "GitHub does not give your account access to the team repo. Ask the \
                 team owner to invite you to it.",
            ),
        }
    }

    pub fn is_member(&self) -> bool {
        matches!(self, Membership::Member)
    }
}

/// What one round of asking GitHub produced.
pub struct MembershipProbe {
    pub membership: Membership,
    pub login: Option<String>,
    /// v1.117.0 (rung 4): GitHub write access to the team repo — what
    /// sharing into the team library needs. `None` is "GitHub did not say",
    /// never "no": the same rule as [`Membership::Unknown`].
    pub can_write: Option<bool>,
    /// Advisory; non-empty exactly when a half could not be answered.
    pub errors: Vec<String>,
}

/// Ask GitHub who this is and whether they may read `slug`, then apply the
/// manifest. [`Membership::Unknown`] means GitHub could not be asked — it
/// is never a refusal, so a rate limit or a train tunnel cannot evict a
/// member.
pub fn probe_membership(slug: &str, manifest: Option<&TeamManifest>) -> MembershipProbe {
    let mut errors = Vec::new();
    let login = match crate::github::current_login() {
        Ok(login) => Some(login),
        Err(e) => {
            errors.push(format!("Could not read your GitHub login: {e}"));
            None
        }
    };
    let access = match crate::github::repo_access(slug) {
        Ok(access) => Some(access),
        Err(e) => {
            errors.push(format!("Could not check access to {slug}: {e}"));
            None
        }
    };
    let membership = match (login.as_deref(), access) {
        (Some(login), Some(access)) => {
            evaluate_membership(manifest.map(|m| m.lists(login)), access.pull)
        }
        // One unanswered half means no verdict at all.
        _ => Membership::Unknown,
    };
    MembershipProbe {
        membership,
        can_write: write_answer(login.as_deref(), access),
        login,
        errors,
    }
}

/// H4 Challenger step 13 (Windows re-walk): the write half of a probe is the
/// member's only when GitHub knew who asked. With `gh` signed out,
/// `repos/{slug}` goes unauthenticated and a private repo answers 404 —
/// [`crate::github::RepoAccess::denied`], which is nobody's answer, so it
/// must not read as "read-only" (`promote_permission`).
pub fn write_answer(login: Option<&str>, access: Option<crate::github::RepoAccess>) -> Option<bool> {
    login?;
    access.and_then(|access| access.push)
}

/// On what basis an add is going ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddAuthorization {
    /// GitHub confirmed membership just now.
    Confirmed,
    /// GitHub could not be asked; the last answer it gave was "member".
    /// The caller must say so — the member deserves to know the check was
    /// not fresh.
    CachedMember,
}

/// The gate in front of every clone: DESIGN.md's rule is manifest AND
/// GitHub read access, so a picker press is refused unless both hold.
///
/// Offline policy: when GitHub cannot be asked at all, an add is allowed
/// only if the last *successful* check said "member". Anything else — no
/// cached answer, or a cached refusal — is refused, because Ply would
/// otherwise clone a private repo on nothing but a local file's word.
pub fn authorize_add(
    fresh: Membership,
    cached: Option<Membership>,
) -> Result<AddAuthorization, String> {
    match fresh {
        Membership::Member => Ok(AddAuthorization::Confirmed),
        Membership::NotListed | Membership::NoRepoAccess => Err(format!(
            "{} {}",
            "You are not a member of this team, so Plyloft will not clone its workspaces.",
            fresh.reason().unwrap_or_default()
        )),
        Membership::Unknown => match cached {
            Some(Membership::Member) => Ok(AddAuthorization::CachedMember),
            Some(other) => Err(format!(
                "{} {}",
                "You are not a member of this team, so Plyloft will not clone its workspaces.",
                other.reason().unwrap_or_default()
            )),
            None => Err("Plyloft could not check your team membership with GitHub, and has \
                 no earlier answer to fall back on. Refresh Settings › Team › Members and library once you \
                 are online."
                .to_string()),
        },
    }
}

/// The whole membership rule, as a pure function of its two halves.
/// `listed` is `None` when the manifest could not be read at all.
pub fn evaluate_membership(listed: Option<bool>, has_repo_access: bool) -> Membership {
    match (has_repo_access, listed) {
        (false, _) => Membership::NoRepoAccess,
        (true, Some(true)) => Membership::Member,
        (true, Some(false)) => Membership::NotListed,
        // Access but no readable manifest: nothing to decide on yet.
        (true, None) => Membership::Unknown,
    }
}

// ── The local clone ─────────────────────────────────────────────────

/// One directory name per team repo. `/` cannot appear in a path segment,
/// and the rest is clamped to a conservative set so a manifest-supplied
/// slug can never escape the team directory.
pub fn slug_dir_name(slug: &str) -> String {
    let mut out = String::with_capacity(slug.len());
    for ch in slug.chars() {
        match ch {
            '/' => out.push_str("__"),
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' => out.push(c),
            _ => out.push('-'),
        }
    }
    // A name of only dots would resolve to the parent directory.
    if out.chars().all(|c| c == '.') {
        out = "team".to_string();
    }
    out
}

/// What a clone-or-pull did. `pull_error` is deliberately not fatal: a
/// member offline on a train still reads the team from the local clone.
#[derive(Debug, Clone)]
pub struct SyncOutcome {
    pub path: PathBuf,
    pub cloned: bool,
    pub pull_error: Option<String>,
}

/// Clone the team repo if this Mac does not have it yet, pull it if it
/// does. Both git operations are injected — production passes `gh repo
/// clone` and `git pull --ff-only`.
pub fn sync_clone(
    dir: &Path,
    slug: &str,
    clone: impl FnOnce(&str, &Path) -> Result<(), String>,
    pull: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<SyncOutcome, String> {
    if dir.join(".git").exists() {
        let pull_error = pull(dir).err();
        return Ok(SyncOutcome {
            path: dir.to_path_buf(),
            cloned: false,
            pull_error,
        });
    }
    if dir.exists() {
        // A leftover directory that is not a checkout: refuse rather than
        // clone into it or delete a human's files.
        return Err(format!(
            "{} exists but is not a git checkout — remove it and refresh.",
            dir.display()
        ));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    clone(slug, dir)?;
    Ok(SyncOutcome {
        path: dir.to_path_buf(),
        cloned: true,
        pull_error: None,
    })
}

/// Read the manifest out of a local clone. `Ok(None)` when the clone has no
/// `team.json` (a repo that is not a team repo, or one still empty).
pub fn read_manifest(clone_dir: &Path) -> Result<Option<TeamManifest>, String> {
    let path = clone_dir.join(MANIFEST_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_manifest(&bytes).map(Some)
}

/// Where a team's clone lives, plus the last membership answer GitHub
/// gave. Owns nothing else — the team itself is the repo, and the only
/// per-machine state is the clone root setting.
pub struct TeamStore {
    root: PathBuf,
    /// Last [`Membership`] resolved by a refresh, per team repo. Held in
    /// memory only: it is a statement about GitHub right now, and a stale
    /// one written to disk would outlive the access it describes.
    cached: parking_lot::Mutex<Option<CachedMembership>>,
    /// GH #226: one git operation on the clone at a time — a refresh's pull,
    /// a library write's round trip, a reapply's rebase. Two at once would
    /// meet at `.git/index.lock` at best, and at worst a write would commit
    /// into a rebase in progress.
    git_lock: parking_lot::Mutex<()>,
}

#[derive(Debug, Clone)]
pub struct CachedMembership {
    pub slug: String,
    pub membership: Membership,
    pub login: Option<String>,
    /// v1.117.0: GitHub's last answer about write access. `None` = it never
    /// said, which Promote treats as "try it" rather than as a refusal.
    pub can_write: Option<bool>,
}

impl TeamStore {
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            root: config_dir.join(TEAM_DIR),
            cached: parking_lot::Mutex::new(None),
            git_lock: parking_lot::Mutex::new(()),
        }
    }

    /// The cached membership for `slug`, if the last refresh was about the
    /// same team. A key swap invalidates it by simply not matching.
    pub fn cached_membership(&self, slug: &str) -> Option<CachedMembership> {
        self.cached
            .lock()
            .clone()
            .filter(|c| c.slug.eq_ignore_ascii_case(slug))
    }

    /// Record what GitHub said. [`Membership::Unknown`] is *not* an
    /// answer, so it never evicts one: an offline refresh must not turn a
    /// confirmed member into someone with no history.
    pub fn remember_membership(
        &self,
        slug: &str,
        membership: Membership,
        login: Option<String>,
        can_write: Option<bool>,
    ) {
        if membership == Membership::Unknown {
            return;
        }
        *self.cached.lock() = Some(CachedMembership {
            slug: slug.to_string(),
            membership,
            login,
            can_write,
        });
    }

    /// Skills hub H4 step 8 c (Challenger): GitHub refused a push to `slug`
    /// as read-only (403). Kept as its write answer, so the Skills rows read
    /// again show Promote off with why rather than offering it once more. Only
    /// over a cached answer about the same team: a refusal says nothing about
    /// membership, and none is invented here.
    pub fn remember_read_only(&self, slug: &str) {
        let mut cached = self.cached.lock();
        if let Some(entry) = cached.as_mut().filter(|c| c.slug.eq_ignore_ascii_case(slug)) {
            entry.can_write = Some(false);
        }
    }

    /// F8 (team walk): the account that just created `slug` is its owner, a
    /// member and able to write it — GitHub made the repository for it and
    /// the manifest it pushed lists it as owner. Remembered at once, so the
    /// Team page right after **Create team** reads "Member … as <login>"
    /// rather than "Checking…" until somebody presses Read it again.
    pub fn remember_creator(&self, slug: &str, login: &str) {
        self.remember_membership(slug, Membership::Member, Some(login.to_string()), Some(true));
    }

    pub fn forget_membership(&self) {
        *self.cached.lock() = None;
    }

    pub fn clone_dir(&self, slug: &str) -> PathBuf {
        self.root.join(slug_dir_name(slug))
    }

    /// Onboarding §5 step 2: whether any team clone exists under
    /// `<config_dir>/team/` — one of the signals that a team is on this Mac.
    /// Offline and read-only: a directory listing, no git.
    pub fn has_any_clone(&self) -> bool {
        std::fs::read_dir(&self.root)
            .map(|entries| {
                entries
                    .flatten()
                    .any(|entry| entry.path().join(".git").exists())
            })
            .unwrap_or(false)
    }

    /// GH #226: hold the clone's git lock for a library write that goes
    /// through [`publish_library_paths`] directly (the owner's manifest
    /// edits) rather than through [`Self::publish`] / [`Self::publish_paths`].
    pub fn git_guard(&self) -> parking_lot::MutexGuard<'_, ()> {
        self.git_lock.lock()
    }

    /// GH #226 review 2: the real library git, holding the clone's git lock
    /// until its push returns — for a caller whose work goes on after the
    /// publish (an invite's GitHub grants) and must not hold the lock across it.
    pub fn git_until_pushed(&self) -> LockedUntilPushed<'_> {
        LockedUntilPushed {
            guard: std::cell::RefCell::new(Some(self.git_lock.lock())),
        }
    }

    /// Clone-or-pull through the real `gh`/`git`.
    ///
    /// GH #226: a clone ahead and behind GitHub is not a pull *error* here —
    /// the fetch worked, and [`status`] reports the divergence itself (with
    /// its way out) as [`TeamStatus::library_divergence`], read off the clone.
    pub fn sync(&self, slug: &str) -> Result<SyncOutcome, String> {
        let _git = self.git_lock.lock();
        self.sync_locked(slug)
    }

    /// Skills hub H2 (Challenger): [`Self::sync`], unless `skip` — asked once
    /// the clone's git lock is held — says not to. A pull that waited on the
    /// lock while the member switched the library off (which moves the clone
    /// to the Trash under that same lock) must not clone it straight back.
    /// `None` when skipped.
    pub fn sync_unless(
        &self,
        slug: &str,
        skip: impl FnOnce() -> bool,
    ) -> Option<Result<SyncOutcome, String>> {
        let _git = self.git_lock.lock();
        if skip() {
            return None;
        }
        Some(self.sync_locked(slug))
    }

    fn sync_locked(&self, slug: &str) -> Result<SyncOutcome, String> {
        let dir = self.clone_dir(slug);
        sync_clone(
            &dir,
            slug,
            |slug, dest| crate::github::library_repo_clone(slug, dest),
            // GH #224: bounded, like every network git of the library.
            |dir| {
                // An operation under way (GH #226 review 1) is reported as
                // `TeamStatus::library_interruption`; a merge now would only
                // be refused, or land on a detached HEAD.
                if library_interruption(dir).is_some() {
                    return Ok(());
                }
                match RealLibraryGit.pull(dir) {
                    Err(RemoteFailure::Diverged { .. }) => Ok(()),
                    other => other.map_err(RemoteFailure::for_refresh),
                }
            },
        )
    }
}

// ── Where a team workspace's checkout belongs ───────────────────────

/// The only host a team workspace can live on. Team workspaces are cloned
/// with `gh`, which speaks to GitHub — a `gitlab.com/alice/tools` checkout
/// is a different repository that happens to share a path, and adopting it
/// would be the same mistake as adopting `alice/tools` for `bob/tools`.
/// `ssh.github.com` is GitHub's SSH over port 443
/// (`ssh://git@ssh.github.com:443/o/r.git`), for networks that block 22.
const GITHUB_HOSTS: [&str; 3] = ["github.com", "www.github.com", "ssh.github.com"];

/// Does `url` — whatever remote form git holds — point at the GitHub
/// repository `slug`? `https://github.com/o/r`, `https://github.com/o/r.git`,
/// `ssh://git@github.com/o/r.git` and `git@github.com:o/r.git` all match
/// `o/r`; the same path on any other host does not.
/// Whether `host` (lowercased) is one of GitHub's own.
pub fn is_github_host(host: &str) -> bool {
    GITHUB_HOSTS.contains(&host)
}

pub fn origin_matches(url: &str, slug: &str) -> bool {
    let Some((host, owner_repo)) = split_remote(url) else {
        return false;
    };
    if !GITHUB_HOSTS.contains(&host.as_str()) {
        return false;
    }
    match normalize_slug(slug) {
        Some(wanted) => owner_repo == wanted,
        None => false,
    }
}

/// `(host, "owner/name")` for a remote URL, or `None` when it is not a
/// remote naming a host and a two-segment path (a local path, say).
fn split_remote(url: &str) -> Option<(String, String)> {
    let raw = url.trim();
    let raw = raw.strip_suffix('/').unwrap_or(raw);
    let raw = raw.strip_suffix(".git").unwrap_or(raw);
    // scheme://[user@]host/owner/name
    let after_scheme = match raw.split_once("://") {
        Some((_, rest)) => rest,
        // scp-like: [user@]host:owner/name — a colon that is not a scheme.
        None => {
            let (host_part, path) = raw.split_once(':')?;
            let host = host_part.rsplit('@').next()?;
            return Some((host.to_ascii_lowercase(), normalize_slug(path)?));
        }
    };
    let (authority, path) = after_scheme.split_once('/')?;
    let host = authority.rsplit('@').next()?;
    // Strip a port, if any.
    let host = host.split(':').next()?;
    Some((host.to_ascii_lowercase(), normalize_slug(path)?))
}

/// The last two path segments, lowercased: `owner/name`.
fn normalize_slug(path: &str) -> Option<String> {
    let path = path.trim().trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/').filter(|s| !s.is_empty()).rev();
    let name = segments.next()?;
    let owner = segments.next()?;
    if segments.next().is_some() {
        // More than two segments after the host is not a GitHub repo path.
        return None;
    }
    Some(format!("{owner}/{name}").to_ascii_lowercase())
}

/// The `owner/name` a remote URL names on GitHub, **in its original case**.
///
/// [`normalize_slug`] lowercases, because it exists to compare; this exists
/// to *write* — v1.118.0's Create-team form suggests the repos the owner's
/// registered workspaces already point at, and those slugs go into the team
/// manifest, where a member reads them. `gh` is case-insensitive either way;
/// a human reading `matteob-adv/atelier` in their team's manifest is not.
pub fn origin_slug(url: &str) -> Option<String> {
    let (host, _) = split_remote(url)?;
    if !GITHUB_HOSTS.contains(&host.as_str()) {
        return None;
    }
    // Re-read the path with its case intact; `split_remote` already proved
    // the shape, so this only has to find the last two segments.
    let raw = url.trim();
    let raw = raw.strip_suffix('/').unwrap_or(raw);
    let raw = raw.strip_suffix(".git").unwrap_or(raw);
    let path = match raw.split_once("://") {
        Some((_, rest)) => rest.split_once('/').map(|(_, path)| path)?,
        None => raw.split_once(':').map(|(_, path)| path)?,
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/').filter(|s| !s.is_empty()).rev();
    let name = segments.next()?;
    let owner = segments.next()?;
    Some(format!("{owner}/{name}"))
}

/// `origin` of an existing checkout, or `None` when there is no origin (or
/// git cannot read it). Unknown is never treated as a match: registering an
/// unidentified checkout as a team workspace is the mistake this guards.
fn origin_of(dir: &Path) -> Option<String> {
    crate::git::capture(dir, &["remote", "get-url", "origin"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Two repositories can share a basename — `alice/tools` and `bob/tools`
/// both want `<root>/tools`. The second one to arrive gets the qualified
/// name instead of silently adopting the first one's checkout.
fn qualified_dir_name(slug: &str) -> String {
    slug.replacen('/', "--", 1)
}

/// Where this team workspace's checkout belongs under `clone_root`.
///
/// `<root>/<name>` when it is free or already a checkout of this repo;
/// `<root>/<owner>--<name>` when the natural path holds a *different*
/// repository; an error when both are taken by other repositories. A
/// checkout whose origin cannot be read counts as "not this repo" — Ply
/// must not register a directory it cannot identify.
pub fn resolve_destination(clone_root: &Path, entry: &TeamWorkspace) -> Result<PathBuf, String> {
    if !is_valid_repo_slug(&entry.repo) {
        return Err(format!(
            "{} is not a valid owner/name repository — fix it in the team manifest.",
            entry.repo
        ));
    }
    let candidates = [
        clone_root.join(entry.dir_name()),
        clone_root.join(qualified_dir_name(&entry.repo)),
    ];
    for dest in &candidates {
        if !dest.join(".git").exists() {
            // Free, or occupied by something that is not a checkout at all —
            // the caller reports that second case in its own words.
            return Ok(dest.clone());
        }
        if origin_of(dest).is_some_and(|url| origin_matches(&url, &entry.repo)) {
            return Ok(dest.clone());
        }
    }
    Err(format!(
        "{} and {} are both checkouts of other repositories. Move one aside, \
         then add {} again.",
        candidates[0].display(),
        candidates[1].display(),
        entry.repo
    ))
}

// ── What Settings → Team renders ────────────────────────────────────

/// One row of the Team-workspaces picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamWorkspaceView {
    pub repo: String,
    pub name: String,
    /// A workspace already points at **this repo's** checkout. Never set
    /// from a checkout that belongs to a different repository, however
    /// convincing its path is.
    pub registered: bool,
    /// This repo's checkout exists under the clone root.
    pub cloned: bool,
    /// Where it would be (or is) cloned.
    pub local_path: String,
    /// Set when there is nowhere to put this repo: both candidate paths
    /// hold other repositories. The row is shown, not silently dropped,
    /// with the reason a human can act on.
    pub conflict: Option<String>,
    /// U31: the folder at `local_path` is there. Registered, not cloned and
    /// present: it isn't a repository, and a clone there would be refused.
    pub folder_present: bool,
}

/// Everything the Team panel shows. Assembled from three sources that can
/// each be absent: the key (is there a team at all), the local clone (who
/// is in it) and GitHub (may this account read it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    /// The team this Mac is in ([`current_team_repo`]: the setting, else the
    /// key's). `None` ⇒ no team yet; the panel offers to create or join one.
    pub team_repo: Option<String>,
    /// From the manifest when there is a clone; else the key's team name.
    pub team_name: Option<String>,
    pub owner_login: Option<String>,
    /// v1.118.0 (rung 5): the manifest's members, so the owner can see who
    /// is in the team and re-run an invite for one of them. Empty when
    /// there is no clone to read.
    pub members: Vec<TeamMember>,
    /// v1.118.0: this account is the manifest's owner — the only person who
    /// edits members and team workspaces. False whenever Ply cannot prove
    /// it, including when GitHub could not say who this is.
    pub is_owner: bool,
    /// v1.118.0: repositories dismissed from assisted discovery on this Mac.
    pub ignored_repos: Vec<String>,
    pub login: Option<String>,
    pub membership: Membership,
    pub membership_reason: Option<String>,
    /// The membership shown is the last answer GitHub gave, not one from
    /// this call — GitHub could not be asked. Adds still work (see
    /// [`authorize_add`]) but the UI says the check was not fresh.
    pub membership_stale: bool,
    pub clone_root: String,
    pub clone_root_is_default: bool,
    /// The team repo is cloned on this Mac.
    pub has_clone: bool,
    pub workspaces: Vec<TeamWorkspaceView>,
    /// v1.116.0 (rung 3): the team library's skills, one row per skill with
    /// the vendors that can load it. Empty when the library carries none.
    pub skills: Vec<crate::team_skills::TeamSkill>,
    /// Plugins Ply will not hand to a CLI, and why. Shown rather than
    /// swallowed — a member must be able to see that part of the library is
    /// deliberately not loaded.
    pub refused_skills: Vec<crate::team_skills::RefusedPlugin>,
    /// Whether this Mac may change the team library — Promote's gate (a team
    /// key, a clone, and GitHub write access or no answer yet), so the panel
    /// offers "Remove from team" to exactly the people Promote is offered to.
    /// Filled by the command from the cached membership, never a fresh probe:
    /// reading the status is offline.
    pub can_write_library: bool,
    /// The refusal when `can_write_library` is false; otherwise a caveat when
    /// GitHub has not said whether this account may write.
    pub write_library_reason: Option<String>,
    /// GH #226: the local clone holds library commits GitHub lacks *and*
    /// GitHub holds some it lacks, as of the last fetch. Every library write
    /// stops at its pull until this is resolved; the panel offers "Reapply
    /// mine on top". `None` when in step, only ahead, only behind, or when
    /// git could not say.
    pub library_divergence: Option<LibraryDivergence>,
    /// GH #226 review 1: an operation left under way in the team clone — Ply's
    /// own interrupted reapply (`own`, which "Reapply mine on top" finishes)
    /// or one Ply didn't start. `None` when the clone is at rest.
    pub library_interruption: Option<LibraryInterruption>,
    /// QoL 13.3: a collision put together on this Mac with the member's
    /// choices and not published yet — the panel offers Publish and Undo.
    pub library_resolved: Option<LibraryResolved>,
    /// The last thing that went wrong (a failed pull, an unreachable
    /// `gh`). Advisory — everything above still renders.
    pub error: Option<String>,
}

/// GH #226: commits only this Mac has (`ahead`) and only GitHub has
/// (`behind`), both non-zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDivergence {
    pub ahead: usize,
    pub behind: usize,
    /// The team clone, for `Details`.
    pub clone_dir: String,
}

/// The divergence of a clone, read locally against its last fetch.
pub fn library_divergence(clone_dir: &Path) -> Option<LibraryDivergence> {
    if !clone_dir.join(".git").exists() || library_interruption(clone_dir).is_some() {
        return None;
    }
    match ahead_behind(clone_dir) {
        Ok((ahead, behind)) if ahead > 0 && behind > 0 => Some(LibraryDivergence {
            ahead,
            behind,
            clone_dir: clone_dir.display().to_string(),
        }),
        _ => None,
    }
}

/// GH #226 review 1: a rebase, merge, cherry-pick or revert left under way in
/// the team clone. While one is, `HEAD` may be detached and every library
/// write would stop at its pull with advice a refresh can't follow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInterruption {
    /// Ply's own reapply, stopped halfway (Ply force-quit while a hook or a
    /// signing agent hung): Ply's marker names this rebase and nothing in the
    /// clone has changed since, so "Reapply mine on top" may abort it and
    /// start again. `false` is anything else — including a rebase the member
    /// started by hand after a collision — which Ply never touches.
    pub own: bool,
    /// The team clone, for `Details`.
    pub clone_dir: String,
}

/// The rebase's starting point, when a rebase is under way.
fn rebase_orig_head(dir: &Path) -> Option<String> {
    let git_dir = dir.join(".git");
    ["rebase-merge", "rebase-apply"].iter().find_map(|state| {
        std::fs::read_to_string(git_dir.join(state).join("orig-head"))
            .ok()
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
    })
}

/// The backup ref (name, commit) whose commit is `sha`, if Ply made one.
fn backup_at(dir: &Path, sha: &str) -> Option<(String, String)> {
    let listed = library_git_capture(
        dir,
        &["for-each-ref", "--format=%(objectname) %(refname)", BACKUP_REF_PREFIX],
    )
    .ok()?;
    listed.lines().find_map(|line| {
        let (object, name) = line.trim().split_once(' ')?;
        (object == sha).then(|| (name.to_string(), object.to_string()))
    })
}

/// GH #226 review 2: the file that marks a rebase as **Ply's own**. Written
/// atomically just before Ply's rebase starts — the backup ref's name and the
/// commit it started from — and removed once that rebase is verified done or
/// verified undone. A rebase the member starts by hand (as the collision copy
/// tells them to) never has one, even though it starts from the same commit
/// as Ply's backup; that is why matching the backup alone was not enough.
const REAPPLY_MARKER: &str = "ply-reapply";

fn reapply_marker_path(dir: &Path) -> PathBuf {
    dir.join(".git").join(REAPPLY_MARKER)
}

/// `HEAD`'s reflog subjects, newest first. `None` when git can't say.
fn head_reflog(dir: &Path) -> Option<Vec<String>> {
    library_git_capture(dir, &["log", "--walk-reflogs", "--format=%gs", "HEAD"])
        .ok()
        .map(|out| out.lines().map(str::to_string).collect())
}

/// Written just before Ply's rebase: the backup, the commit it starts from,
/// and (review 3) how long `HEAD`'s reflog was — so the marker belongs to
/// *this* rebase and to nothing that happens in the clone after it.
fn write_reapply_marker(dir: &Path, backup: &str, orig: &str) -> Result<(), String> {
    let reflog = head_reflog(dir).ok_or("HEAD has no readable reflog")?.len();
    crate::atomic::write_atomic_text(
        &reapply_marker_path(dir),
        &format!("backup {backup}\norig {orig}\nreflog {reflog}\n"),
    )
}

struct ReapplyMarker {
    backup: String,
    orig: String,
    reflog: usize,
}

fn read_reapply_marker(dir: &Path) -> Option<ReapplyMarker> {
    let text = std::fs::read_to_string(reapply_marker_path(dir)).ok()?;
    let (mut backup, mut orig, mut reflog) = (None, None, None);
    for line in text.lines() {
        match line.split_once(' ') {
            Some(("backup", value)) => backup = Some(value.trim().to_string()),
            Some(("orig", value)) => orig = Some(value.trim().to_string()),
            Some(("reflog", value)) => reflog = value.trim().parse().ok(),
            _ => {}
        }
    }
    Some(ReapplyMarker { backup: backup?, orig: orig?, reflog: reflog? })
}

/// Review 3: has `HEAD` moved only by Ply's own rebase since the marker was
/// written? Every reflog entry since then must be its `rebase (start)` or a
/// `rebase (pick)`. A `rebase (abort)`, a `commit`, a `commit (amend)`, a
/// `reset`, a `checkout` — anything a person does by hand — and the marker
/// no longer describes the rebase under way. A reflog that shrank (expired)
/// or can't be read proves nothing, so it is not Ply's either.
fn head_moved_only_by_plys_rebase(dir: &Path, since: usize) -> bool {
    let Some(entries) = head_reflog(dir) else {
        return false;
    };
    let Some(new) = entries.len().checked_sub(since) else {
        return false;
    };
    new >= 1
        && entries[..new]
            .iter()
            .all(|subject| subject.starts_with("rebase (start)") || subject.starts_with("rebase (pick)"))
}

fn remove_reapply_marker(dir: &Path) {
    match std::fs::remove_file(reapply_marker_path(dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("team: could not remove the reapply marker: {error}"),
    }
}

/// Ply may abort an interrupted rebase only while there is nothing in it a
/// person could have made: the index and the tree are exactly `HEAD`, with
/// no unmerged path, and the rebase has not got past its first pick.
fn untouched_since_ply_stopped(dir: &Path) -> bool {
    let clean = library_git_run(dir, &["diff", "--quiet", "HEAD", "--"]).is_ok()
        && library_git_run(dir, &["diff", "--cached", "--quiet", "HEAD", "--"]).is_ok()
        && library_git_capture(dir, &["ls-files", "--unmerged"])
            .map(|out| out.trim().is_empty())
            .unwrap_or(false);
    let done = std::fs::read_to_string(dir.join(".git").join("rebase-merge").join("done"))
        .map(|text| {
            text.lines()
                .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
                .count()
        })
        .unwrap_or(0);
    clean && done <= 1
}

/// What is under way in the clone, and — for Ply's own interrupted reapply
/// — the backup it started from.
///
/// Own only when all of these hold (review 2): Ply's marker is there, its
/// `orig` is the rebase's `orig-head`, the backup it names exists at that
/// commit, the rebase is the merge backend Ply uses, and nothing in the
/// clone could be a person's work in progress
/// ([`untouched_since_ply_stopped`]). Anything else is foreign, and Ply
/// never aborts it.
fn interruption_in(dir: &Path) -> Option<Option<(String, String)>> {
    let git_dir = dir.join(".git");
    if !rebase_in_progress(dir) {
        // Review 3: a marker with no rebase under way describes nothing —
        // the rebase it named ended outside Ply (the member aborted or
        // finished it by hand). Dropped at the first read that finds it, so
        // it can never be mistaken for a later rebase's.
        remove_reapply_marker(dir);
    }
    if rebase_in_progress(dir) {
        let own = (|| {
            let ReapplyMarker { backup, orig, reflog } = read_reapply_marker(dir)?;
            if !git_dir.join("rebase-merge").is_dir() || rebase_orig_head(dir)? != orig {
                return None;
            }
            if !head_moved_only_by_plys_rebase(dir, reflog) {
                return None;
            }
            let (name, at) = backup_at(dir, &orig)
                .filter(|(name, _)| *name == backup)
                .or_else(|| {
                    // Several backups may share the commit; the marker's must be one.
                    (rev_parse(dir, &backup).ok()? == orig).then(|| (backup.clone(), orig.clone()))
                })?;
            untouched_since_ply_stopped(dir).then_some((name, at))
        })();
        return Some(own);
    }
    let other = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
        .iter()
        .any(|head| git_dir.join(head).exists());
    other.then_some(None)
}

/// The interruption Settings → Team shows, read off the clone.
pub fn library_interruption(clone_dir: &Path) -> Option<LibraryInterruption> {
    if !clone_dir.join(".git").exists() {
        return None;
    }
    interruption_in(clone_dir).map(|own| LibraryInterruption {
        own: own.is_some(),
        clone_dir: clone_dir.display().to_string(),
    })
}

/// Assemble everything Settings → Team shows.
///
/// `team_repo` and `key_team_name` come from the license key, `refresh`
/// decides whether GitHub is consulted at all. Nothing here is fatal: an
/// unreachable `gh` or a failed pull lands in [`TeamStatus::error`] and
/// every other field still renders from the local clone.
#[cfg(test)]
pub fn status(
    team_repo: Option<&str>,
    key_team_name: Option<&str>,
    clone_root_setting: Option<&str>,
    ignored_repos: &[String],
    workspaces: &WorkspaceStore,
    team: &TeamStore,
    refresh: bool,
) -> TeamStatus {
    status_after_sync(team_repo, key_team_name, clone_root_setting, ignored_repos, workspaces, team, refresh, None)
}

/// [`status`], given the clone-or-pull a caller already ran (Skills hub H2:
/// the background pull reads what its own pull did). `synced: None` with
/// `refresh` runs [`TeamStore::sync`] here, as before.
#[allow(clippy::too_many_arguments)]
pub fn status_after_sync(
    team_repo: Option<&str>,
    key_team_name: Option<&str>,
    clone_root_setting: Option<&str>,
    ignored_repos: &[String],
    workspaces: &WorkspaceStore,
    team: &TeamStore,
    refresh: bool,
    synced: Option<Result<SyncOutcome, String>>,
) -> TeamStatus {
    // Without a team manifest yet: the setting, else the default. Read again
    // below once the manifest says which checkouts to look for.
    let root = clone_root(clone_root_setting);
    let mut status = TeamStatus {
        team_repo: team_repo.map(str::to_string),
        team_name: key_team_name.map(str::to_string),
        owner_login: None,
        members: Vec::new(),
        is_owner: false,
        ignored_repos: ignored_repos.to_vec(),
        login: None,
        membership: Membership::Unknown,
        membership_reason: None,
        membership_stale: false,
        clone_root: root.to_string_lossy().to_string(),
        clone_root_is_default: clone_root_setting
            .map(str::trim)
            .is_none_or(str::is_empty),
        has_clone: false,
        workspaces: Vec::new(),
        skills: Vec::new(),
        refused_skills: Vec::new(),
        can_write_library: false,
        write_library_reason: None,
        library_divergence: None,
        library_interruption: None,
        library_resolved: None,
        error: None,
    };
    let Some(slug) = team_repo else {
        // No key, or a key minted without `--team-repo`: there is no team
        // to be a member of, so no stale answer may survive either.
        team.forget_membership();
        return status;
    };

    let mut errors: Vec<String> = Vec::new();
    if refresh {
        match synced.unwrap_or_else(|| team.sync(slug)) {
            Ok(outcome) => {
                if let Some(e) = outcome.pull_error {
                    errors.push(format!("Could not pull the team repo: {e}"));
                }
            }
            Err(e) => errors.push(format!("Could not fetch the team repo: {e}")),
        }
    }

    let clone_dir = team.clone_dir(slug);
    status.has_clone = clone_dir.join(".git").exists();
    status.library_divergence = library_divergence(&clone_dir);
    status.library_interruption = library_interruption(&clone_dir);
    status.library_resolved = library_resolved(&clone_dir);
    let manifest = match read_manifest(&clone_dir) {
        Ok(m) => m,
        Err(e) => {
            errors.push(e);
            None
        }
    };
    if let Some(m) = &manifest {
        status.team_name = Some(m.name.clone());
        status.owner_login = m.owner_login().map(str::to_string);
        status.members = m.members.clone();
    }
    let (root, views) = effective_root_and_views(clone_root_setting, manifest.as_ref(), workspaces);
    status.clone_root = root.to_string_lossy().to_string();
    status.workspaces = views;

    // The skills are read straight off the clone, so they render offline and
    // without a membership answer — exactly like the workspace rows above.
    let library = crate::team_skills::read_library(&clone_dir);
    errors.extend(library.errors.iter().cloned());
    status.skills = library.skills;
    status.refused_skills = library.refused;

    if refresh {
        let probe = probe_membership(slug, manifest.as_ref());
        errors.extend(probe.errors.iter().cloned());
        team.remember_membership(
            slug,
            probe.membership,
            probe.login.clone(),
            probe.can_write,
        );
        status.login = probe.login.clone();
        status.membership = probe.membership;
        if probe.membership == Membership::Unknown {
            // GitHub could not be asked. Show the last answer it gave
            // rather than pretending we know nothing — the error line says
            // the re-check failed, and `membership_stale` says the verdict
            // is not from this call.
            if let Some(cached) = team.cached_membership(slug) {
                status.membership = cached.membership;
                status.membership_stale = true;
                status.login = status.login.or(cached.login);
            }
        }
    } else if let Some(cached) = team.cached_membership(slug) {
        status.membership = cached.membership;
        status.login = cached.login;
        status.membership_stale = true;
    }
    status.membership_reason = status.membership.reason().map(str::to_string);
    // Owner-only actions are gated on this in the backend too
    // (`team_admin::authorize_owner_action`); the flag exists so the panel
    // does not offer a button that can only be refused. A login Ply could
    // not read leaves it false, which is the same direction the gate takes.
    status.is_owner = match (status.owner_login.as_deref(), status.login.as_deref()) {
        (Some(owner), Some(login)) => login.eq_ignore_ascii_case(owner),
        _ => false,
    };
    if !errors.is_empty() {
        status.error = Some(sign_in_advice(errors).join(" "));
    }
    status
}

/// Walk follow-ups 2026-10-19: with `gh` itself signed out, Details advised
/// *turn on "Git uses your GitHub sign-in"* for the pull git couldn't sign in
/// for — a setting that hands git gh's sign-in, which there isn't. When the
/// same read says gh has no sign-in, git's words advise signing in instead;
/// with gh signed in they stay as they are (the setting is then the fix).
pub fn sign_in_advice(errors: Vec<String>) -> Vec<String> {
    let gh_signed_out = errors.iter().any(|error| {
        let gh = error.starts_with("Could not read your GitHub login:") || error.starts_with("Could not check access to ");
        let lower = error.to_lowercase();
        // Challenger: also a token GitHub refuses ("Bad credentials (HTTP
        // 401)") — git's helper gets the same refused token, and signing in
        // again is the fix (`commands::probe_says_signed_out` reads it so).
        gh && (lower.contains("requires authentication")
            || lower.contains("http 401")
            || lower.contains("gh auth login")
            || lower.contains("not logged in")
            || lower.contains("isn't signed in on"))
    });
    if !gh_signed_out {
        return errors;
    }
    errors
        .into_iter()
        .map(|error| {
            error.replace(crate::platform::GIT_AUTH_WORDS, crate::platform::GIT_AUTH_GH_SIGNED_OUT_WORDS)
        })
        .collect()
}

/// U31: the workspace on this Mac that is `repo`, wherever it is: under a clone
/// root changed since, or moved. A folder that's there answers by its origin;
/// one that's gone by the repository its board was set to, the only record left
/// (a gone folder with a local board can't be matched this way).
fn workspace_of_repo(repo: &str, list: &[crate::workspace::Workspace]) -> Option<String> {
    list.iter()
        .find(|w| {
            let cwd = Path::new(&w.cwd);
            if cwd.is_dir() {
                origin_of(cwd).is_some_and(|url| origin_matches(&url, repo))
            } else {
                w.github_owner_repo.as_deref().is_some_and(|r| r.eq_ignore_ascii_case(repo))
            }
        })
        .map(|w| w.cwd.clone())
}

/// The picker rows for a manifest, against what is actually on this Mac.
pub fn workspace_views(
    manifest: Option<&TeamManifest>,
    clone_root: &Path,
    workspaces: &WorkspaceStore,
) -> Vec<TeamWorkspaceView> {
    let list = workspaces.snapshot().workspaces;
    let registered: Vec<String> = list.iter().map(|w| w.cwd.clone()).collect();
    manifest
        .map(|m| m.workspaces.as_slice())
        .unwrap_or_default()
        .iter()
        // A malformed slug is not offered at all: the picker's whole job is
        // to clone it, and there is nothing safe to clone.
        .filter(|entry| is_valid_repo_slug(&entry.repo))
        .map(|entry| {
            if let Some(cwd) = workspace_of_repo(&entry.repo, &list) {
                let at = Path::new(&cwd);
                return TeamWorkspaceView {
                    repo: entry.repo.clone(),
                    name: entry.display_name(),
                    registered: true,
                    cloned: at.join(".git").exists(),
                    folder_present: at.is_dir(),
                    local_path: cwd,
                    conflict: None,
                };
            }
            let dest = match resolve_destination(clone_root, entry) {
                Ok(dest) => dest,
                // Nowhere to put it: both candidates hold other
                // repositories. Report that, and claim nothing about a
                // checkout that is not this repo's — an unrelated
                // registered workspace at the natural path must never
                // render as this team workspace being open.
                Err(reason) => {
                    return TeamWorkspaceView {
                        repo: entry.repo.clone(),
                        name: entry.display_name(),
                        registered: false,
                        cloned: false,
                        folder_present: false,
                        local_path: clone_root
                            .join(entry.dir_name())
                            .to_string_lossy()
                            .to_string(),
                        conflict: Some(reason),
                    };
                }
            };
            // U31: with its folder gone, the parent still says where it is, so
            // a workspace stored canonically (macOS's /var → /private/var) stays
            // recognised.
            let canonical = crate::platform::canonicalize(&dest).unwrap_or_else(|_| {
                match (dest.parent().and_then(|p| crate::platform::canonicalize(p).ok()), dest.file_name()) {
                    (Some(parent), Some(name)) => parent.join(name),
                    _ => dest.clone(),
                }
            });
            let canonical_str = canonical.to_string_lossy().to_string();
            TeamWorkspaceView {
                repo: entry.repo.clone(),
                name: entry.display_name(),
                registered: registered.iter().any(|cwd| *cwd == canonical_str),
                cloned: dest.join(".git").exists(),
                folder_present: dest.is_dir(),
                local_path: dest.to_string_lossy().to_string(),
                conflict: None,
            }
        })
        .collect()
}

// ── The Team-workspaces picker ──────────────────────────────────────

/// What picking one team workspace did, for the toast.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedWorkspace {
    pub repo: String,
    pub path: String,
    pub name: String,
    /// False when the repo was already on disk — picking it again only
    /// registers it.
    pub cloned: bool,
    /// False when a workspace already pointed at this path.
    pub registered: bool,
    /// The membership check behind this add came from the last successful
    /// answer, not from GitHub just now (see [`authorize_add`]). The toast
    /// says so rather than implying a fresh check.
    pub membership_from_cache: bool,
}

/// Clone a team workspace under `clone_root` and register it exactly as
/// `import_default` does. Idempotent in both halves: an existing checkout
/// is reused rather than re-cloned, and a path that is already a workspace
/// is left alone.
///
/// A team workspace that carries no `.atelier/workspace_default.json` is
/// still registered — under the manifest's display name — because a member
/// who picked it asked for a workspace, not for a silent clone.
pub fn add_workspace_with(
    clone_root: &Path,
    entry: &TeamWorkspace,
    workspaces: &WorkspaceStore,
    clone: impl FnOnce(&str, &Path) -> Result<(), String>,
) -> Result<AddedWorkspace, String> {
    // U31: already on this Mac elsewhere: there, never a second workspace.
    let list = workspaces.snapshot().workspaces;
    let dest = match workspace_of_repo(&entry.repo, &list) {
        Some(cwd) => PathBuf::from(cwd),
        None => resolve_destination(clone_root, entry)?,
    };
    let cloned = if dest.join(".git").exists() {
        false
    } else {
        if dest.exists() {
            return Err(format!(
                "{} already exists and is not a git checkout.",
                dest.display()
            ));
        }
        let parent = dest.parent().unwrap_or(clone_root);
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
        clone(&entry.repo, &dest)?;
        true
    };

    let canonical = crate::platform::canonicalize(&dest).unwrap_or_else(|_| dest.clone());
    let canonical_str = canonical.to_string_lossy().to_string();
    let already = workspaces
        .snapshot()
        .workspaces
        .iter()
        .any(|w| w.cwd == canonical_str);

    let (name, registered) = match workspaces.import_default(&dest)? {
        Some(ws) => (ws.name, true),
        None if already => (
            workspaces
                .snapshot()
                .workspaces
                .iter()
                .find(|w| w.cwd == canonical_str)
                .map(|w| w.name.clone())
                .unwrap_or_else(|| entry.display_name()),
            false,
        ),
        // No manifest in the repo: register it under the team's name for it.
        None => {
            // Owner, 2026-10-20: the team's name, not one this person chose,
            // so a shared definition added later fills its Name in.
            let ws = workspaces.create_named_by_team(entry.display_name(), canonical_str.clone())?;
            (ws.name, true)
        }
    };

    Ok(AddedWorkspace {
        repo: entry.repo.clone(),
        path: canonical_str,
        name,
        cloned,
        registered,
        // Set by the gated entry point; the raw picker helper makes no
        // claim about how membership was established.
        membership_from_cache: false,
    })
}

/// The gated picker path: check membership with GitHub, then clone.
///
/// `gh` auth would refuse an unreadable private repo anyway, but Ply must
/// not *offer* to clone a team's workspaces to someone the team does not
/// list — the manifest half of the rule has no enforcement other than this.
pub fn add_workspace_checked_with(
    clone_root: &Path,
    entry: &TeamWorkspace,
    manifest: &TeamManifest,
    workspaces: &WorkspaceStore,
    team: &TeamStore,
    slug: &str,
    clone: impl FnOnce(&str, &Path) -> Result<(), String>,
) -> Result<AddedWorkspace, String> {
    let probe = probe_membership(slug, Some(manifest));
    team.remember_membership(slug, probe.membership, probe.login, probe.can_write);
    let cached = team.cached_membership(slug).map(|c| c.membership);
    let authorization = authorize_add(probe.membership, cached)?;
    let mut added = add_workspace_with(clone_root, entry, workspaces, clone)?;
    added.membership_from_cache = authorization == AddAuthorization::CachedMember;
    Ok(added)
}

/// Production wrapper: clones with `gh` so the member's own GitHub auth is
/// the second enforcement behind Ply's own check.
pub fn add_workspace_checked(
    clone_root: &Path,
    entry: &TeamWorkspace,
    manifest: &TeamManifest,
    workspaces: &WorkspaceStore,
    team: &TeamStore,
    slug: &str,
) -> Result<AddedWorkspace, String> {
    add_workspace_checked_with(
        clone_root,
        entry,
        manifest,
        workspaces,
        team,
        slug,
        |slug, dest| crate::github::repo_clone(slug, dest),
    )
}

// ── The team library (v1.115.0 — team sharing rung 2) ────────────────
//
// The team repo's `library/` is the Team scope's home. Ply writes into it
// on the member's behalf and pushes: pull → write → commit → push, so a
// member never has to know there is a repository behind the library
// (`docs/team-sharing/DESIGN.md`, "Team library writes").
//
// The one thing Ply cannot decide for the member is a divergence. When the
// pull or the push is refused the change stays in the local clone and the
// caller gets a [`LibraryError::Conflict`] naming the file, which the panel
// raises as a toast.

/// The team repo subdirectory holding the whole team library.
pub const LIBRARY_DIR: &str = "library";

/// Which half of the round trip git refused. The caller needs to tell them
/// apart: before the pull nothing was written at all, while after the commit
/// a push either was refused (its commit taken back) or may have landed (kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictStage {
    /// `pull --ff-only` was refused; `apply` never ran and nothing changed.
    Pull,
    /// The write was committed in the local clone and its push failed. See
    /// [`LibraryError::Conflict`] for what is left of the commit.
    Push,
}

/// GH #224: how every timed-out library write begins. `knowledgeScopes.ts`
/// recognises a timeout by this phrase (and its test reads it from here), so
/// the panel titles it as GitHub not answering rather than as a failure.
pub const TIMEOUT_MARKER: &str = "GitHub didn't answer in time while Plyloft was";

/// GH #226: how every "this clone is ahead *and* behind GitHub" message
/// begins. `knowledgeScopes.ts` recognises it by this phrase (its test reads
/// it from here) and offers "Reapply mine on top" on the toast.
pub const DIVERGED_MARKER: &str =
    concat!(crate::this_machine!(cap), " has team library changes GitHub doesn't have");

/// Everything a library write can fail with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibraryError {
    /// Git refused the pull or the push because the team repo moved on.
    /// Carries the repo-relative path of the file so the toast can name it.
    ///
    /// GH #224: `timed_out` — git did not refuse, it was stopped at its
    /// bound, or (a push) failed without an explicit refusal from GitHub
    /// ([`push_may_have_landed`]). A pull: nothing was written, either way. A
    /// push GitHub refused: its commit was taken back and every target put
    /// back, so nothing goes out with the next write (a take-back that failed
    /// is `Abandoned`). A push that may have landed stays committed locally,
    /// and the message says so instead of blaming the team repo.
    Conflict {
        stage: ConflictStage,
        path: String,
        detail: String,
        timed_out: bool,
        /// A refused push that had this call commit nothing and left a commit
        /// of an earlier write in the clone: it still goes out with the next.
        earlier_commit_kept: bool,
    },
    /// The write did not complete and the clone is provably back as it
    /// was: no clone at all, a filesystem error, a git that would not run,
    /// or a step that failed and was rolled back successfully.
    Failed(String),
    /// The write did not complete and Ply could **not** put the clone back.
    /// The library may be missing the entry, so nothing a caller did in
    /// anticipation of this write may be undone — that local copy could be
    /// all that is left of it.
    Abandoned { path: String, detail: String },
    /// GH #226: the pull found this clone ahead *and* behind GitHub — this
    /// Mac holds library commits that were never published (a push refused
    /// or stopped earlier) and a teammate has published since. Nothing was
    /// written for `path`. Unlike a [`Self::Conflict`] at the pull, a refresh
    /// cannot clear it: the way out is [`reapply_library_changes_in`], which
    /// the message and the panel offer.
    Diverged {
        path: String,
        ahead: usize,
        behind: usize,
    },
    /// GH #226 review 1: a rebase or merge is under way in the clone. `own`:
    /// Ply's reapply, interrupted (the message opens with
    /// [`DIVERGED_MARKER`], so the toast offers "Reapply mine on top", which
    /// finishes it). Otherwise one Ply didn't start, which it never touches.
    /// Found before the pull: nothing was written.
    Interrupted { path: String, own: bool },
    /// Skills hub H4 Challenger step 13: git couldn't sign in to GitHub for
    /// the pull or the push (gh signed out, no credential, an SSH key GitHub
    /// refuses). Not a divergence: nobody published. The write was undone —
    /// at the push, Plyloft's own commit is taken back and every target put
    /// back as it was — so the clone is never left ahead by it. `detail` is
    /// git's own words, for the log only.
    SignIn {
        stage: ConflictStage,
        path: String,
        detail: String,
        /// Git over SSH: the fix is the SSH key, not the GitHub sign-in.
        ssh: bool,
    },
}

/// Skills hub H4 Challenger step 13: how every "GitHub isn't signed in"
/// refusal of a team library write reads. `SkillsPage.tsx` recognises it by
/// this phrase (its test reads it from here) and offers "Sign in to GitHub".
pub const SIGN_IN_MARKER: &str = "GitHub isn't signed in on ";

/// What a refused library write says about GitHub. `team_admin` swaps it on
/// the Remove path, where access was already taken away on GitHub.
pub const NOTHING_REACHED_GITHUB: &str = "Nothing reached GitHub and the team library is as it was.";

/// The sentence for a library write git couldn't sign in for. `doing` is what
/// the member pressed for, as a verb phrase ("share mine", "remove x from the
/// team library", "open the pull request"): a removal is no share.
pub fn sign_in_words(doing: &str, stage: ConflictStage, ssh: bool) -> String {
    let (cause, todo) = if ssh {
        (
            "Git couldn't sign in to GitHub over SSH".to_string(),
            "Check your SSH key, or use HTTPS with the GitHub CLI's sign-in, then try again.",
        )
    } else {
        (
            format!("{SIGN_IN_MARKER}{THIS_MACHINE}"),
            "Sign in to GitHub in Settings › Team › Members and library, then try again.",
        )
    };
    let refused = match stage {
        ConflictStage::Pull => "so GitHub didn't let Plyloft update the team library first",
        ConflictStage::Push => "so the push was refused",
    };
    format!(
        "Plyloft couldn't {doing}: {cause}, {refused}. {NOTHING_REACHED_GITHUB} {todo}"
    )
}

/// Whether a refused fetch or push's words are a missing sign-in —
/// `Some(ssh)`. Git's, Git Credential Manager's and ssh's own on Mac and
/// Windows (`platform::git_auth_refusal`), and (Challenger) Plyloft's account
/// scope refusing to start git at all because the team's account isn't
/// signed in (`github_account::team_words` / `resolve`: "… which isn't signed
/// in on this PC", "The GitHub CLI gave no sign-in for …").
pub fn sign_in_cause(detail: &str) -> Option<bool> {
    if let Some(words) = crate::platform::git_auth_refusal(detail) {
        return Some(words == crate::platform::GIT_SSH_AUTH_WORDS);
    }
    (detail.contains("which isn't signed in on") || detail.contains("The GitHub CLI gave no sign-in for"))
        .then_some(false)
}

/// [`sign_in_cause`] of a refused fetch or push.
pub fn sign_in_refusal(failure: &RemoteFailure) -> Option<bool> {
    match failure {
        RemoteFailure::Refused(detail) => sign_in_cause(detail),
        _ => None,
    }
}

/// Whether a failed push may have reached GitHub, so its commit must stay. Only
/// GitHub's own explicit refusal, or a connection that never opened, says it
/// can't have: a push killed at quit, or a connection lost after GitHub moved the
/// ref ("remote end hung up", "unexpected disconnect", "RPC failed; HTTP 502"),
/// proves nothing. Anything not recognised counts as landed: keeping a commit
/// costs a retry, taking back one GitHub has loses track of it.
pub fn push_may_have_landed(failure: &RemoteFailure) -> bool {
    match failure {
        RemoteFailure::TimedOut { .. } => true,
        RemoteFailure::Diverged { .. } => false,
        RemoteFailure::Refused(detail) => !github_refused_push(detail) && !push_never_connected(detail),
    }
}

/// git's words for a push that never reached GitHub at all: offline, on a Mac
/// whose pull a moment earlier still worked.
fn push_never_connected(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    ["could not resolve host", "failed to connect to", "ssh: connect to host"]
        .iter()
        .any(|words| lower.contains(words))
}

/// git's words for a push GitHub answered with no: `[rejected]`, `[remote
/// rejected]`, a declined hook, 403 or denied, a failed sign-in.
pub(crate) fn github_refused_push(detail: &str) -> bool {
    if crate::team_proposal::push_refusal(detail).is_some() {
        return true;
    }
    let lower = detail.to_lowercase();
    ["[rejected]", "[remote rejected]", "hook declined", "http 403", "error: 403", " denied"]
        .iter()
        .any(|words| lower.contains(words))
}

impl LibraryError {
    /// The message shown to the member. A conflict always names the file —
    /// that is the whole point of surfacing it rather than retrying.
    pub fn message(&self) -> String {
        match self {
            Self::Conflict {
                stage,
                path,
                detail,
                timed_out: true,
                ..
            } => match stage {
                ConflictStage::Pull => format!(
                    "{TIMEOUT_MARKER} updating the team library to write {path}. Nothing \
                     was written. Check the connection, then try again. ({detail})"
                ),
                // Not "refresh to check": a refresh shows the local clone,
                // which holds the commit either way.
                ConflictStage::Push => format!(
                    "{TIMEOUT_MARKER} pushing {path}. The change is committed in the local \
                     team clone and may have reached GitHub anyway. Try again once the \
                     connection is back: the retry pushes it if it didn't land and changes \
                     nothing if it did — unless a teammate published meanwhile, in which \
                     case the retry stops and offers to reapply your change on top of \
                     theirs. ({detail})"
                ),
            },
            Self::Conflict { stage: ConflictStage::Pull, path, detail, .. } => format!(
                "The team library changed on GitHub while Plyloft was writing {path}. \
                 Nothing was written. Refresh Settings › Team › Members and library, then \
                 try again. ({detail})"
            ),
            Self::Conflict { stage: ConflictStage::Push, path, detail, earlier_commit_kept: true, .. } => format!(
                "The team library changed on GitHub while Plyloft was writing {path}. \
                 Your change is saved in the local team clone but not pushed. Refresh \
                 Settings › Team › Members and library: if a teammate published meanwhile, it \
                 offers to reapply your change on top of theirs. ({detail})"
            ),
            // The commit is gone, so a retry is a fresh write on GitHub's tip.
            Self::Conflict { stage: ConflictStage::Push, path, detail, .. } => format!(
                "GitHub didn't take the change to {path}. {NOTHING_REACHED_GITHUB} Try again. ({detail})"
            ),
            Self::Interrupted { path, own: true } => format!(
                "{DIVERGED_MARKER}, and Plyloft's earlier attempt to reapply them on top of \
                 GitHub's was interrupted. Nothing was written for {path}; your changes are \
                 kept. Reapply mine on top finishes it — then try again."
            ),
            Self::Interrupted { path, own: false } => format!(
                "The team clone on {THIS_MACHINE} is in the middle of a rebase or merge that Plyloft \
                 didn't start, so Plyloft won't write to it. Nothing was written for {path}. \
                 Settings › Team › Members and library shows where the clone is: finish or abort it there, then try \
                 again."
            ),
            Self::Diverged { path, ahead, behind } => format!(
                "{DIVERGED_MARKER} ({ahead} of yours not yet published), and a teammate \
                 published {behind} meanwhile, so Plyloft can't bring the library up to date. \
                 Nothing was written for {path}; your earlier changes are still in the local \
                 team clone. Reapply mine on top puts yours after your teammates' and \
                 publishes them — then try again."
            ),
            Self::SignIn { stage, path, ssh, .. } => {
                sign_in_words(&format!("update {path} in the team library"), *stage, *ssh)
            }
            Self::Failed(detail) => detail.clone(),
            Self::Abandoned { path, detail } => format!(
                "{detail} The team library on {THIS_MACHINE} may now be missing {path}. \
                 Nothing was removed from your personal Knowledge — open \
                 Settings › Team › Members and library and refresh to put the clone back in step."
            ),
        }
    }

    /// True only when Ply can **prove** the team library is exactly as it
    /// was: the pull was refused before `apply` ran, or a later step failed
    /// and its rollback was confirmed.
    ///
    /// `Abandoned` is deliberately false. A rollback that itself failed
    /// leaves the library possibly missing the entry, and a caller that
    /// treated that as "unchanged" would delete the local copy it made —
    /// which is how a lesson disappears from every layer at once.
    pub fn left_the_library_unchanged(&self) -> bool {
        match self {
            // At the pull nothing ran; a push GitHub refused put everything
            // back. One that may have landed hasn't, nor does a commit of an
            // earlier write still waiting in the clone.
            Self::Conflict { stage, timed_out, earlier_commit_kept, .. } => {
                *stage == ConflictStage::Pull || !(*timed_out || *earlier_commit_kept)
            }
            // Found at the pull, before `apply` ran.
            Self::Diverged { .. } | Self::Interrupted { .. } => true,
            // At the pull nothing ran; at the push the commit and the
            // targets were put back (a rollback that failed is `Abandoned`).
            Self::SignIn { .. } => true,
            Self::Failed(_) => true,
            Self::Abandoned { .. } => false,
        }
    }
}

impl std::fmt::Display for LibraryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl From<LibraryError> for String {
    fn from(error: LibraryError) -> Self {
        error.message()
    }
}

/// What a completed library write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryOutcome {
    /// Absolute path of the file inside the local clone.
    pub path: PathBuf,
    /// Repo-relative path, as it appears in the commit.
    pub relative_path: String,
    /// False when `apply` left the tree byte-identical — re-sharing an entry
    /// that is already published is idempotent, not an error.
    pub committed: bool,
    /// The team repo on GitHub now holds this state. False only when the
    /// clone has no remote to push to (a local-only team repo). Reported
    /// rather than swallowed: nothing reached a teammate.
    pub pushed: bool,
}

/// What one target path held before `apply` ran — what a rollback puts back.
///
/// v1.117.0 (rung 4) added the directory case: a promoted skill is a *tree*
/// in two halves of the library, not one Markdown file, and a rollback that
/// could only restore a single file would leave half a plugin behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibrarySnapshot {
    /// Nothing was there, so removing what `apply` created is the rollback.
    Absent,
    File(Vec<u8>),
    /// Every regular file under the directory, with its mode.
    Tree(Vec<crate::project_skills::TreeFile>),
}

/// Capture what `path` holds right now.
///
/// Directory targets are read through `project_skills::read_tree`, the same
/// function a Promote copies with, so what a copy preserves and what a
/// rollback restores cannot drift apart — including the executable bit on a
/// skill's helper script.
///
/// A symlink anywhere under a directory target is refused rather than
/// followed: the snapshot cannot represent it, so a rollback would silently
/// replace a link with a copy of its target. Ply writes the library itself,
/// so a link there is anomalous, and failing *before* `apply` means nothing
/// happened at all.
fn snapshot_target(path: &Path) -> Result<LibrarySnapshot, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LibrarySnapshot::Absent),
        Err(error) => Err(format!("read {}: {error}", path.display())),
        Ok(meta) if meta.file_type().is_symlink() => Err(format!(
            "{} is a symlink, which Plyloft will not write through",
            path.display()
        )),
        Ok(meta) if meta.is_dir() => {
            crate::project_skills::read_tree(path).map(LibrarySnapshot::Tree)
        }
        Ok(_) => std::fs::read(path)
            .map(LibrarySnapshot::File)
            .map_err(|error| format!("read {}: {error}", path.display())),
    }
}

/// The git operations a library write needs. Injected so the wrapper's tests
/// can drive a real git against a local bare remote and *also* simulate a
/// hostile race that no fixture could produce on demand.
pub trait LibraryGit {
    fn has_remote(&self, dir: &Path) -> Result<bool, String>;
    fn pull(&self, dir: &Path) -> Result<(), RemoteFailure>;
    /// Stage `relative_paths` and commit them as **one** commit.
    /// `Ok(false)` ⇒ nothing was staged.
    ///
    /// One commit rather than one per path: a promoted skill lands in both
    /// halves of the library, and a teammate pulling half a skill would see a
    /// one-sided plugin that Ply's own panel would then report as a fault.
    fn commit(&self, dir: &Path, relative_paths: &[String], message: &str)
        -> Result<bool, String>;
    fn push(&self, dir: &Path) -> Result<(), RemoteFailure>;
    /// Put `relative_path` back exactly as [`snapshot_target`] found it.
    ///
    /// Deliberately not `git checkout HEAD -- <path>`. The target may be
    /// untracked (a teammate's entry pulled into a clone that has not
    /// committed it, a file dropped in by hand) or tracked with local
    /// edits; checking out `HEAD` would substitute the committed version
    /// and, for a path `HEAD` has never seen, delete it outright — turning
    /// a refused write into data loss.
    fn restore(
        &self,
        dir: &Path,
        relative_path: &str,
        previous: &LibrarySnapshot,
    ) -> Result<(), String>;
    /// Skills hub H4 Challenger step 13: take back the commit `commit` just
    /// made at `HEAD`, keeping its changes staged for [`Self::restore`] to put
    /// back — so a push that failed leaves the clone not ahead.
    /// Refused unless `HEAD` is still `commit`.
    fn uncommit(&self, dir: &Path, commit: &str) -> Result<(), String> {
        let head = library_git_capture(dir, &["rev-parse", "HEAD"])?;
        if head.trim() != commit {
            return Err(format!(
                "the team clone moved on since Plyloft's commit {commit}, so Plyloft left it"
            ));
        }
        library_git_run(dir, &["reset", "--soft", "-q", "HEAD^"])
    }
    /// Challenger: the rollback after a failed push is
    /// over (done or abandoned) — nothing more runs on the clone for this
    /// write. [`LockedUntilPushed`] keeps the clone's git lock through that
    /// rollback and lets it go here.
    fn rolled_back(&self) {}
}

// ── Network git of the team library (GH #224) ───────────────────────
//
// The fetch and the push are the only calls that talk to GitHub. Both run
// through the bounded runner: their own process group, killed at the bound
// and on app exit (`worktrees::kill_active_fetches`), never prompting. The
// library is Markdown files and small skill directories, so a healthy
// transfer takes seconds; the bounds are for a stalled connection (a dead
// Wi-Fi, a half-open TCP session, an ssh that waits on a host that is gone).

/// Bound on the library's `git fetch`. A stopped fetch costs nothing — no
/// write has started, and a refresh reads the clone as this Mac last pulled
/// it — so it is short: well past a slow network, and a Settings refresh or
/// a share waits at most a minute.
pub(crate) const LIBRARY_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Bound on the library's `git push`: twice the fetch's. A stopped push is
/// ambiguous (GitHub may have taken it) and costs the member a refresh and
/// a retry, so only a connection that is really gone should reach it.
pub(crate) const LIBRARY_PUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Why a fetch or push of the team library did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteFailure {
    /// Git answered and refused (a divergence, a rejected push, no network,
    /// no access), or never started. The text is git's own.
    Refused(String),
    /// Stopped at its bound with its whole process group. For a push,
    /// whether GitHub took the commit before that is unknown.
    TimedOut {
        command: &'static str,
        after: std::time::Duration,
    },
    /// GH #226: the fetch worked, but this clone and GitHub each hold library
    /// commits the other lacks — `merge --ff-only` can never succeed. Told
    /// apart from a refusal because it has a way out ("Reapply mine on top",
    /// [`reapply_library_changes_in`]) and a refresh does not fix it.
    Diverged { ahead: usize, behind: usize },
}

impl RemoteFailure {
    pub fn timed_out(&self) -> bool {
        matches!(self, Self::TimedOut { .. })
    }

    /// The wording of a Settings → Team refresh whose pull failed: a timeout
    /// says what the panel now shows and what to do.
    pub fn for_refresh(self) -> String {
        match &self {
            Self::TimedOut { .. } => format!(
                "GitHub didn't answer in time. Plyloft shows the team as {THIS_MACHINE} last pulled \
                 it; check the connection and refresh. ({})",
                self.technical()
            ),
            // T5: git needed a sign-in it may not ask for — not a slow network.
            // git's own words go to the log (`library_network_git`'s caller), not here.
            Self::Refused(detail) if crate::platform::is_git_auth_prompt_refused(detail) => {
                log::warn!("team: git couldn't sign in: {}", detail.trim());
                crate::platform::git_auth_refusal(detail).unwrap_or_default().to_string()
            }
            Self::Refused(detail) => detail.clone(),
            // Never reaches a refresh (`TeamStore::sync` reports it as
            // `TeamStatus::library_divergence`); worded for completeness.
            Self::Diverged { .. } => self.technical(),
        }
    }

    /// The command-level fact, for the parenthesis the member can skip:
    /// git's own words for a refusal, what was stopped for a timeout.
    pub fn technical(&self) -> String {
        match self {
            Self::Refused(detail) => detail.clone(),
            Self::TimedOut { command, after } => {
                let after = if after.as_secs() > 0 {
                    format!("{}s", after.as_secs())
                } else {
                    format!("{}ms", after.as_millis())
                };
                format!("`{command}` was stopped after {after}")
            }
            Self::Diverged { ahead, behind } => {
                format!("{THIS_MACHINE} is {ahead} commit(s) ahead of GitHub and {behind} behind")
            }
        }
    }
}

impl std::fmt::Display for RemoteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(detail) if crate::platform::is_git_auth_prompt_refused(detail) => {
                f.write_str(crate::platform::git_auth_refusal(detail).unwrap_or_default())
            }
            Self::Refused(detail) => f.write_str(detail),
            Self::TimedOut { .. } => {
                write!(f, "GitHub didn't answer in time ({})", self.technical())
            }
            Self::Diverged { .. } => f.write_str(&self.technical()),
        }
    }
}

impl From<String> for RemoteFailure {
    fn from(detail: String) -> Self {
        Self::Refused(detail)
    }
}

impl From<&str> for RemoteFailure {
    fn from(detail: &str) -> Self {
        Self::Refused(detail.to_string())
    }
}

impl From<RemoteFailure> for String {
    fn from(failure: RemoteFailure) -> Self {
        failure.to_string()
    }
}

/// H1 Windows walk: the config every git Plyloft runs on a library clone
/// carries. Without `core.longpaths`, git for Windows refuses to create a
/// directory past 248 characters, and a team library whose skill nests a
/// little deep (under a clone that already sits ~80 characters down
/// `AppData\Roaming`) failed its fast-forward halfway, for every member.
/// Passed per command, so clones made before this get it too, and written
/// into the clone's own config at clone time
/// ([`crate::github::library_repo_clone`]). Harmless on macOS.
pub(crate) const LIBRARY_GIT_CONFIG: [&str; 2] = ["-c", "core.longpaths=true"];

/// F2 (Challenger 1, 10): where a library clone's hooks are looked for —
/// a path inside its git folder that is never created, so no hook of the
/// person's (a global `core.hooksPath`) and none in the clone runs on any
/// git Plyloft runs there: commit, rebase, merge, checkout, push. Nothing is
/// made or left on disk. A linked worktree's `.git` file names its git
/// folder; anywhere else the path simply doesn't exist either.
pub(crate) fn library_no_hooks_path(dir: &Path) -> PathBuf {
    let dot_git = dir.join(".git");
    let git_dir = std::fs::read_to_string(&dot_git)
        .ok()
        .and_then(|text| text.lines().find_map(|l| l.strip_prefix("gitdir:")).map(|p| dir.join(p.trim())))
        .unwrap_or(dot_git);
    git_dir.join("plyloft-no-hooks")
}

/// [`LIBRARY_GIT_CONFIG`] plus what every git on a library clone Plyloft
/// owns carries (F2, Challenger 1): `commit.gpgSign=false` — a rebase
/// re-creates commits and would otherwise sign them with a global key, asking
/// for a passphrase nobody sees — and [`library_no_hooks_path`] as
/// `core.hooksPath`.
pub(crate) fn library_git_config(dir: &Path) -> Vec<String> {
    let mut config: Vec<String> = LIBRARY_GIT_CONFIG.iter().map(|s| s.to_string()).collect();
    config.extend([
        "-c".to_string(),
        "commit.gpgSign=false".to_string(),
        "-c".to_string(),
        format!("core.hooksPath={}", library_no_hooks_path(dir).display()),
    ]);
    config
}

/// [`crate::git::run`] on a library clone, with [`library_git_config`].
pub(crate) fn library_git_run(dir: &Path, args: &[&str]) -> Result<(), String> {
    library_git_capture(dir, args).map(|_| ())
}

/// [`crate::git::capture`] on a library clone, with [`library_git_config`].
pub(crate) fn library_git_capture(dir: &Path, args: &[&str]) -> Result<String, String> {
    let config = library_git_config(dir);
    let config: Vec<&str> = config.iter().map(String::as_str).collect();
    crate::git::capture_configured(dir, &config, args)
}

/// F2 (Challenger 1): how long one step of a reapply's rebase (`rebase`,
/// `--skip`, `--continue`) may take on a library clone. With no hook and no
/// signing it is local file work; past this it is killed and the reapply's
/// own abort-and-verify puts the clone back (or says it couldn't).
pub(crate) const LIBRARY_REBASE_TIMEOUT: std::time::Duration = crate::git::COMMIT_TIMEOUT;

/// [`library_git_capture`], bounded by [`LIBRARY_REBASE_TIMEOUT`], no stdin,
/// killed on quit.
pub(crate) fn library_git_capture_bounded(dir: &Path, args: &[&str]) -> Result<String, String> {
    let config = library_git_config(dir);
    let config: Vec<&str> = config.iter().map(String::as_str).collect();
    crate::git::capture_configured_bounded(dir, &config, args, LIBRARY_REBASE_TIMEOUT)
}

/// What [`heal_torn_fast_forward`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TornHeal {
    /// Nothing to heal: the tree is clean, or the clone is not simply behind.
    Clean,
    /// The tree held exactly a partial checkout of the upstream commit; these
    /// paths were put back to `HEAD`.
    Healed(Vec<String>),
    /// The tree holds something the upstream commit does not explain (a
    /// person's edit). Nothing was touched.
    NotTorn,
}

/// H1 Windows walk: a fast-forward git could not finish (a path too long, a
/// full disk) leaves `HEAD` where it was and the working tree half-written
/// with the upstream commit's files, and every later fast-forward then
/// refuses those very files ("Your local changes … would be overwritten"),
/// so the library never updates again.
///
/// When the clone is behind its upstream and not ahead, the index is still
/// `HEAD`'s, and **every** difference in the working tree is one the upstream
/// commit makes (a tracked file whose content is the upstream blob, a file
/// the upstream deletes that is gone, an untracked file the upstream adds
/// with that content), those paths are put back to `HEAD` so the
/// fast-forward can run again. Anything else (content matching neither side,
/// a path the upstream does not touch, something staged) is a person's, and
/// nothing at all is touched.
///
/// A member's own uncommitted edit that happens to equal the upstream content
/// loses nothing either: the fast-forward that follows writes the same bytes
/// back.
pub(crate) fn heal_torn_fast_forward(dir: &Path) -> Result<TornHeal, String> {
    let git_dir = dir.join(".git");
    // (Challenger) any operation under way is a person's or Ply's own, and
    // its state is not a torn checkout: the set [`interruption_in`] reports,
    // plus the sequencer a cherry-pick or revert of several commits leaves.
    let under_way = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]
        .iter()
        .any(|name| git_dir.join(name).exists());
    if rebase_in_progress(dir) || under_way {
        return Ok(TornHeal::Clean);
    }
    let Ok((ahead, behind)) = ahead_behind(dir) else {
        return Ok(TornHeal::Clean);
    };
    if ahead > 0 || behind == 0 {
        return Ok(TornHeal::Clean);
    }
    let status = library_git_capture(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut dirty: Vec<(String, String)> = Vec::new();
    for entry in status.split('\0').filter(|e| !e.is_empty()) {
        if entry.len() < 4 {
            return Ok(TornHeal::NotTorn);
        }
        let (code, path) = (&entry[..2], &entry[3..]);
        // A rename or copy is never what a torn checkout leaves.
        if code.contains('R') || code.contains('C') {
            return Ok(TornHeal::NotTorn);
        }
        dirty.push((code.to_string(), path.to_string()));
    }
    if dirty.is_empty() {
        return Ok(TornHeal::Clean);
    }
    // The index must still be `HEAD`'s: a torn checkout stages nothing.
    if library_git_run(dir, &["diff", "--cached", "--quiet", "HEAD", "--"]).is_err() {
        return Ok(TornHeal::NotTorn);
    }
    // What the upstream commit changes: path → (status letter, new blob).
    let raw = library_git_capture(
        dir,
        &["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "HEAD", "@{upstream}", "--"],
    )?;
    let mut upstream: std::collections::HashMap<String, (char, String)> =
        std::collections::HashMap::new();
    let mut fields = raw.split('\0').filter(|f| !f.is_empty());
    while let Some(meta) = fields.next() {
        let Some(path) = fields.next() else { break };
        let parts: Vec<&str> = meta.trim_start_matches(':').split_whitespace().collect();
        let (Some(blob), Some(kind)) = (parts.get(3), parts.get(4).and_then(|k| k.chars().next()))
        else {
            return Ok(TornHeal::NotTorn);
        };
        upstream.insert(path.to_string(), (kind, (*blob).to_string()));
    }
    let mut tracked: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    for (code, path) in &dirty {
        let Some((kind, blob)) = upstream.get(path) else {
            return Ok(TornHeal::NotTorn);
        };
        // Hashed with the path's filters (autocrlf on Windows), as `git
        // status` compares it; then (Challenger) byte for byte, for a blob
        // committed with CRLF that the filters would convert on the way in.
        let hashes_to = |extra: &[&str]| {
            let mut args = vec!["hash-object"];
            args.extend_from_slice(extra);
            args.extend(["--", path.as_str()]);
            library_git_capture(dir, &args).map(|id| id.trim() == blob).unwrap_or(false)
        };
        let is_upstream = || hashes_to(&[]) || hashes_to(&["--no-filters"]);
        match (code.as_str(), kind) {
            (" M", 'M') if is_upstream() => tracked.push(path.clone()),
            (" D", 'D') => tracked.push(path.clone()),
            ("??", 'A') if is_upstream() => untracked.push(path.clone()),
            _ => return Ok(TornHeal::NotTorn),
        }
    }
    // Untracked first (Challenger): where upstream turns a file into a
    // directory or back, the torn checkout's new path stands where `HEAD`'s
    // must be restored, and `checkout` could not put it back.
    for path in &untracked {
        let file = dir.join(path);
        std::fs::remove_file(&file).map_err(|e| format!("remove {}: {e}", file.display()))?;
        // The directories the torn checkout made for it, once empty.
        let mut parent = file.parent();
        while let Some(at) = parent {
            if at == dir || std::fs::remove_dir(at).is_err() {
                break;
            }
            parent = at.parent();
        }
    }
    // `--literal-pathspecs` (Challenger): a path is a path, never a glob or
    // `:(…)` magic reaching a file nothing above vetted. In chunks, so a
    // large torn commit stays under Windows' 32K-character command line.
    let mut rest: &[String] = &tracked;
    while !rest.is_empty() {
        let (mut take, mut length) = (0, 0);
        while take < rest.len() && (take == 0 || length + rest[take].len() < 16_000) {
            length += rest[take].len() + 3;
            take += 1;
        }
        let mut checkout = vec!["--literal-pathspecs", "checkout", "-q", "HEAD", "--"];
        checkout.extend(rest[..take].iter().map(String::as_str));
        library_git_run(dir, &checkout)?;
        rest = &rest[take..];
    }
    let mut healed: Vec<String> = tracked.into_iter().chain(untracked).collect();
    healed.sort();
    log::warn!(
        "team: healed a torn fast-forward of the library clone ({} path(s) put back to HEAD)",
        healed.len()
    );
    Ok(TornHeal::Healed(healed))
}

/// `git merge --ff-only @{upstream}` on a library clone, healing a torn
/// earlier attempt first ([`heal_torn_fast_forward`]) and a torn one of its
/// own after: the error stays this merge's, and the clone is left so the next
/// pull can finish it.
pub(crate) fn library_fast_forward(dir: &Path) -> Result<(), String> {
    if let Err(error) = heal_torn_fast_forward(dir) {
        log::warn!("team: could not check the library clone for a torn fast-forward: {error}");
    }
    library_git_run(dir, &["merge", "--ff-only", "--quiet", "@{upstream}"]).inspect_err(|_| {
        if let Err(error) = heal_torn_fast_forward(dir) {
            log::warn!("team: could not heal the library clone after a failed fast-forward: {error}");
        }
    })
}

/// One bounded network git; a non-zero exit is a refusal carrying stderr.
fn library_network_git(
    dir: &Path,
    args: &[&str],
    command: &'static str,
    timeout: std::time::Duration,
    fetches: &crate::worktrees::FetchRegistry,
) -> Result<(), RemoteFailure> {
    use crate::worktrees::BoundedFailure;
    let config = library_git_config(dir);
    let configured: Vec<&str> = config.iter().map(String::as_str).chain(args.iter().copied()).collect();
    let out = crate::worktrees::run_bounded_network_git_in(dir, &configured, timeout, fetches).map_err(
        |failure| match failure {
            BoundedFailure::TimedOut => RemoteFailure::TimedOut {
                command,
                after: timeout,
            },
            BoundedFailure::Spawn(e) => RemoteFailure::Refused(format!("{command}: {e}")),
            BoundedFailure::Quitting => {
                RemoteFailure::Refused(format!("{command}: Plyloft is quitting"))
            }
            // Only a parsed stdout is ever cut short; this one is not read.
            BoundedFailure::Truncated => {
                RemoteFailure::Refused(format!("{command}: its output was cut short"))
            }
        },
    )?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(RemoteFailure::Refused(if stderr.is_empty() && out.status.code().is_none() {
        // Killed by a signal with nothing to say: app exit's kill, or one
        // from outside Ply.
        format!("{command} was stopped before it finished")
    } else {
        format!("{command} failed: {stderr}")
    }))
}

/// `git pull --ff-only`, split so that only the network half can be
/// stopped: a bounded `git fetch`, then a local `git merge --ff-only` of the
/// upstream. Killing a pull during its merge could leave `.git/index.lock`
/// or a half-updated tree behind, which would refuse every later write; the
/// merge of a small library is local and brief, so it is never killed.
/// (Pre-existing and left unbounded: a `git-lfs` smudge filter, which a
/// library repo has no reason to configure, would run during that merge.)
///
/// `--ff-only`: Ply never creates a merge commit in someone's team repo. A
/// divergence is the member's call, and the conflict message is what tells
/// them there is one.
pub(crate) fn library_pull_in(
    dir: &Path,
    timeout: std::time::Duration,
    fetches: &crate::worktrees::FetchRegistry,
) -> Result<(), RemoteFailure> {
    // `--prune`: an upstream branch deleted or renamed on GitHub must not
    // survive as a stale `origin/<branch>` the merge would then accept —
    // apply and commit would run, and the push would resurrect the old
    // branch where no teammate looks (review 1).
    library_network_git(dir, &["fetch", "--quiet", "--prune"], "git fetch", timeout, fetches)?;
    // GH #226: ahead *and* behind is a divergence the merge below can only
    // refuse, this time and every time after. Said as such, so the caller can
    // offer the way out instead of "refresh and try again". A count git
    // cannot give (no upstream any more) falls through to the merge, which
    // refuses it exactly as before.
    if let Ok((ahead, behind)) = ahead_behind(dir) {
        if ahead > 0 && behind > 0 {
            return Err(RemoteFailure::Diverged { ahead, behind });
        }
    }
    library_fast_forward(dir).map_err(RemoteFailure::Refused)
}

/// GH #226: how many commits this clone has that its upstream lacks, and how
/// many the upstream has that it lacks — against the upstream as the last
/// fetch left it. Local only; no network.
pub(crate) fn ahead_behind(dir: &Path) -> Result<(usize, usize), String> {
    let out = library_git_capture(
        dir,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    let mut counts = out.split_whitespace().map(str::parse::<usize>);
    match (counts.next(), counts.next()) {
        (Some(Ok(ahead)), Some(Ok(behind))) => Ok((ahead, behind)),
        _ => Err(format!("unexpected `git rev-list --count` output: {}", out.trim())),
    }
}

/// `git push`, bounded. A push stopped at the bound may have landed:
/// [`publish_library_paths`] keeps the local commit of such a failure, so a
/// retry finds the clone in step with GitHub (nothing to push) or pushes it.
pub(crate) fn library_push_in(
    dir: &Path,
    timeout: std::time::Duration,
    fetches: &crate::worktrees::FetchRegistry,
) -> Result<(), RemoteFailure> {
    // 1.176.2 (A5R-12): git's own default, pinned, so the person's global
    // `push.default` (`nothing`, `matching`) can't refuse or widen the push:
    // the clone's branch to its same-named upstream, as everywhere it works.
    library_network_git(dir, &["-c", "push.default=simple", "push", "--quiet"], "git push", timeout, fetches)
}

/// [`RealLibraryGit`] holding the team clone's git lock until its push
/// returns (or until dropped, if the write never gets that far).
pub struct LockedUntilPushed<'a> {
    guard: std::cell::RefCell<Option<parking_lot::MutexGuard<'a, ()>>>,
}

impl LibraryGit for LockedUntilPushed<'_> {
    fn has_remote(&self, dir: &Path) -> Result<bool, String> {
        RealLibraryGit.has_remote(dir)
    }
    fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
        RealLibraryGit.pull(dir)
    }
    fn commit(&self, dir: &Path, rels: &[String], msg: &str) -> Result<bool, String> {
        RealLibraryGit.commit(dir, rels, msg)
    }
    fn push(&self, dir: &Path) -> Result<(), RemoteFailure> {
        let pushed = RealLibraryGit.push(dir);
        // Challenger (H4 step 13): a failed push is rolled back next (uncommit,
        // restore) — still under the lock, so another write can't commit
        // between the two; `rolled_back` lets it go. A push that may have
        // landed keeps its commit: nothing more runs.
        let rolls_back = matches!(&pushed, Err(failure) if !push_may_have_landed(failure));
        if !rolls_back {
            self.guard.borrow_mut().take();
        }
        pushed
    }
    fn restore(&self, dir: &Path, rel: &str, previous: &LibrarySnapshot) -> Result<(), String> {
        RealLibraryGit.restore(dir, rel, previous)
    }
    fn rolled_back(&self) {
        self.guard.borrow_mut().take();
    }
}

/// `git commit -m <message> -- <paths>` in a team clone, with `identity`'s
/// `-c user.name=… -c user.email=…` before the subcommand (N14 item 8; empty:
/// the global identity). F2: through [`library_commit`] — bounded, no hook,
/// no signing — as `chore(library): …`.
pub(crate) fn commit_staged(
    dir: &Path,
    paths: &[&str],
    message: &str,
    identity: &[String],
) -> Result<(), String> {
    let message = crate::commit_message::library_message(message);
    let mut args = vec!["-m", message.as_str(), "--"];
    args.extend_from_slice(paths);
    library_commit(dir, identity, &args)
}

/// F2: `git commit <args>` in a library repository Plyloft owns (the team
/// library, My library), the way [`crate::git::commit`] runs Plyloft's own
/// commits — bounded, no stdin, killed on quit — with [`library_git_config`]
/// and `identity` before the subcommand, and without the person's hooks or
/// signing ([`crate::git::OWN_REPO_COMMIT_FLAGS`]): a global
/// `commit.gpgSign` or `core.hooksPath` is theirs for their own projects.
/// `--no-verify` skips only `pre-commit` and `commit-msg`, so `core.hooksPath`
/// points at [`library_no_hooks_path`], which never exists: no hook at all
/// (`prepare-commit-msg`, `post-commit`, …) runs there.
pub(crate) fn library_commit(dir: &Path, identity: &[String], args: &[&str]) -> Result<(), String> {
    let config = library_git_config(dir);
    let config: Vec<&str> = config
        .iter()
        .map(String::as_str)
        .chain(identity.iter().map(String::as_str))
        .collect();
    let args: Vec<&str> = crate::git::OWN_REPO_COMMIT_FLAGS.iter().copied().chain(args.iter().copied()).collect();
    crate::git::commit_configured(dir, &config, &args).map_err(|failure| failure.text())
}

/// `git` as it actually runs against a team clone.
pub struct RealLibraryGit;

impl LibraryGit for RealLibraryGit {
    fn has_remote(&self, dir: &Path) -> Result<bool, String> {
        Ok(!library_git_capture(dir, &["remote"])?.trim().is_empty())
    }

    fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
        library_pull_in(dir, LIBRARY_FETCH_TIMEOUT, crate::worktrees::exit_registry())
    }

    fn commit(
        &self,
        dir: &Path,
        relative_paths: &[String],
        message: &str,
    ) -> Result<bool, String> {
        let paths: Vec<&str> = relative_paths.iter().map(String::as_str).collect();
        let mut add = vec!["add", "--"];
        add.extend_from_slice(&paths);
        library_git_run(dir, &add)?;
        // `diff --cached --quiet` exits 1 when something is staged, so a
        // non-zero exit here is the signal, not a failure.
        let mut staged = vec!["diff", "--cached", "--quiet", "--"];
        staged.extend_from_slice(&paths);
        if library_git_run(dir, &staged).is_ok() {
            return Ok(false);
        }
        // N14 item 8: authored as the GitHub account that pushes it (this
        // thread's team scope), the global identity when it can't be read.
        let identity = crate::commit_identity::args_for(dir);
        commit_staged(dir, &paths, message, &identity)?;
        Ok(true)
    }

    fn push(&self, dir: &Path) -> Result<(), RemoteFailure> {
        library_push_in(dir, LIBRARY_PUSH_TIMEOUT, crate::worktrees::exit_registry())
    }

    fn restore(
        &self,
        dir: &Path,
        relative_path: &str,
        previous: &LibrarySnapshot,
    ) -> Result<(), String> {
        // Undo whatever `commit` managed to stage before it failed. Git is
        // needed for this and nothing else — the content comes from the
        // snapshot, not from history.
        let _ = library_git_run(dir, &["reset", "-q", "HEAD", "--", relative_path]);
        let path = dir.join(relative_path);
        let fail = |error: std::io::Error| format!("restore {relative_path}: {error}");
        // Whatever `apply` left is removed first, so the result is the
        // snapshot and nothing else: a promote that created six files and
        // then failed must not leave the two the snapshot does not mention.
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&path).map_err(fail)?,
            Ok(_) => std::fs::remove_file(&path).map_err(fail)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(fail(error)),
        }
        match previous {
            // Nothing was there before, so `apply` created it and removing
            // it is the rollback — including the directories that were
            // created only to hold it. Git does not track an empty
            // directory, so a leftover `library/claude/ply-team/skills/`
            // would pass every `git status` check and still sit in the
            // member's clone looking like half a plugin.
            LibrarySnapshot::Absent => {
                prune_empty_parents(dir, &path);
                Ok(())
            }
            LibrarySnapshot::File(bytes) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(fail)?;
                }
                std::fs::write(&path, bytes).map_err(fail)
            }
            LibrarySnapshot::Tree(files) => {
                std::fs::create_dir_all(&path).map_err(fail)?;
                crate::project_skills::write_tree(&path, files)
            }
        }
    }
}

/// Remove the now-empty directories `apply` created above `path`, stopping at
/// the clone itself and at the first directory that still holds something.
///
/// Also what "Remove from team" tidies with: a retired skill's `skills/`
/// directory, left empty, would otherwise sit in the clone untracked.
pub(crate) fn prune_empty_parents(clone_dir: &Path, path: &Path) {
    let mut current = path.parent();
    while let Some(dir) = current {
        if dir == clone_dir || !dir.starts_with(clone_dir) {
            return;
        }
        // `remove_dir` refuses a directory that is not empty, which is
        // exactly the stop condition — no emptiness check to get wrong.
        if std::fs::remove_dir(dir).is_err() {
            return;
        }
        current = dir.parent();
    }
}

/// A repo-relative library path, rejected if it could escape `library/`.
/// The slug half comes from a Knowledge title, so this is the boundary that
/// keeps a crafted title from writing outside the library.
pub fn library_relative_path(rest: &str) -> Result<String, String> {
    let rest = rest.trim().trim_matches('/');
    if rest.is_empty() {
        return Err("empty team library path".into());
    }
    for segment in rest.split('/') {
        if segment.trim().is_empty() || segment == "." || segment == ".." {
            return Err(format!("unsafe team library path: {rest}"));
        }
        if segment.contains('\\') {
            return Err(format!("unsafe team library path: {rest}"));
        }
    }
    Ok(format!("{LIBRARY_DIR}/{rest}"))
}

/// The line [`exclude_atomic_temps`] keeps in a team clone's local exclude.
const TEMP_EXCLUDE_RULE: &str = "*.atelier-tmp";

/// GH #208: add `*.atelier-tmp` to the team clone's `.git/info/exclude`.
///
/// The clone is Ply's (`<app-support>/team/<slug>/`), and `info/exclude` is
/// local to it — never committed — so the team repo's own `.gitignore` is
/// left exactly as the team wrote it. Idempotent and best-effort: a clone
/// whose exclude cannot be written still publishes, and the Knowledge load
/// sweeps a stale temp either way.
pub(crate) fn exclude_atomic_temps(clone_dir: &Path) {
    let git_dir = clone_dir.join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let exclude = git_dir.join("info").join("exclude");
    let current = match std::fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            log::warn!("team: could not read {exclude:?}: {error}");
            return;
        }
    };
    if current.lines().any(|line| line.trim() == TEMP_EXCLUDE_RULE) {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# Plyloft: interrupted atomic writes (GH #208)\n");
    next.push_str(TEMP_EXCLUDE_RULE);
    next.push('\n');
    if let Err(error) = crate::atomic::write_atomic_text(&exclude, &next) {
        log::warn!("team: could not update {exclude:?}: {error}");
    }
}

/// Write into the team library and publish it: **pull → write → commit →
/// push**.
///
/// `apply` receives the absolute path of the target file inside the freshly
/// pulled clone and does the actual mutation (write a Markdown file, remove
/// one). It runs *after* the pull so it sees the team's current state — a
/// slug-collision refusal must be decided against what teammates published,
/// not against a stale clone.
///
/// A refused pull or push is a [`LibraryError::Conflict`] naming the file.
/// A refused push takes its commit back, so it can't go out with a later write
/// the member pressed for something else; only a push that may have landed
/// ([`push_may_have_landed`]) keeps it.
pub fn publish_library_change(
    clone_dir: &Path,
    relative_path: &str,
    message: &str,
    apply: impl FnOnce(&Path) -> Result<(), String>,
    git: &dyn LibraryGit,
) -> Result<LibraryOutcome, LibraryError> {
    let targets = [relative_path.to_string()];
    publish_library_paths(
        clone_dir,
        &targets,
        message,
        |clone| apply(&clone.join(relative_path)),
        git,
    )
}

/// The same round trip for a change that spans **several** paths, committed
/// together.
///
/// Rung 4's Promote is why this exists: one skill becomes a plugin directory
/// in `library/claude/` *and* one in `library/codex/`, plus the Codex
/// marketplace manifest. Three paths, one commit, one push — because a
/// teammate who pulled only the Claude half would see a one-sided skill,
/// which is the exact fault rung 3's badges exist to report.
///
/// `apply` receives the **clone directory**, not a file: it is the caller
/// that knows which of its targets to write. Every target is snapshotted
/// before `apply` runs and restored if anything afterwards fails, so the
/// contract is still the caller-facing one rung 2 settled — the change is in
/// the clone's history, or nothing happened. Past the commit, a push GitHub
/// refused takes it back too; one that may have landed keeps it.
///
/// The first target is the one the conflict message names and the one
/// [`LibraryOutcome::path`] points at.
pub fn publish_library_paths(
    clone_dir: &Path,
    relative_paths: &[String],
    message: &str,
    apply: impl FnOnce(&Path) -> Result<(), String>,
    git: &dyn LibraryGit,
) -> Result<LibraryOutcome, LibraryError> {
    if !clone_dir.join(".git").exists() {
        return Err(LibraryError::Failed(format!(
            "The team repo is not cloned on {THIS_MACHINE} yet ({}). Open Settings › Team › Members and library and refresh.",
            clone_dir.display()
        )));
    }
    let primary = relative_paths
        .first()
        .ok_or_else(|| LibraryError::Failed("no team library path to write".to_string()))?
        .clone();
    // GH #208: the writes below leave `*.atelier-tmp` beside their targets
    // until the rename; one a crash strands must never show as untracked in
    // this clone Ply owns.
    exclude_atomic_temps(clone_dir);
    let conflict = |stage: ConflictStage| {
        let primary = primary.clone();
        move |failure: RemoteFailure| LibraryError::Conflict {
            stage,
            path: primary,
            timed_out: failure.timed_out(),
            detail: failure.technical(),
            earlier_commit_kept: false,
        }
    };

    // GH #226 review 1: an operation under way is its own stop, before the
    // pull meets a detached HEAD and says "refresh", which can't help.
    if let Some(interrupted) = library_interruption(clone_dir) {
        return Err(LibraryError::Interrupted {
            path: primary,
            own: interrupted.own,
        });
    }
    // QoL 13.3 (Challenger): choices put together and not published yet
    // would ride along with this write's push. The member publishes them,
    // or undoes them, first — nothing is written until then.
    if library_resolved(clone_dir).is_some() {
        return Err(LibraryError::Failed(resolved_first_words()));
    }
    let remote = git.has_remote(clone_dir).map_err(LibraryError::Failed)?;
    if remote {
        git.pull(clone_dir).map_err(|failure| match failure {
            RemoteFailure::Diverged { ahead, behind } => LibraryError::Diverged {
                path: primary.clone(),
                ahead,
                behind,
            },
            // H4 Challenger step 13: a fetch git couldn't sign in for is
            // not the team library changing.
            other => match sign_in_refusal(&other) {
                Some(ssh) => LibraryError::SignIn {
                    stage: ConflictStage::Pull,
                    path: primary.clone(),
                    detail: other.technical(),
                    ssh,
                },
                None => conflict(ConflictStage::Pull)(other),
            },
        })?;
    }

    // Snapshot every target *before* `apply` touches it, so a rollback puts
    // back exactly what was there — tracked, untracked or locally edited
    // alike. From here on every failure before the commit succeeds restores
    // them, which is what makes the caller's contract exact: either the
    // change is in the clone's history, or nothing happened. Without that,
    // a demote whose commit failed (a clone with no git identity, say) left
    // the entry deleted from the working tree, absent from the personal
    // layer, and unfindable on retry.
    let mut snapshots: Vec<(String, LibrarySnapshot)> = Vec::with_capacity(relative_paths.len());
    for relative in relative_paths {
        match snapshot_target(&clone_dir.join(relative)) {
            Ok(snapshot) => snapshots.push((relative.clone(), snapshot)),
            Err(error) => return Err(LibraryError::Failed(error)),
        }
    }
    let rollback = |detail: String| {
        let mut failures = Vec::new();
        for (relative, snapshot) in &snapshots {
            if let Err(error) = git.restore(clone_dir, relative, snapshot) {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            LibraryError::Failed(format!(
                "{detail} — the local team clone was left unchanged."
            ))
        } else {
            // The undo failed too. Say so as its own kind: a caller must
            // not conclude "nothing happened" and start undoing its own
            // work on the strength of it.
            LibraryError::Abandoned {
                path: primary.clone(),
                detail: format!(
                    "{detail}. Plyloft could also not undo the half-written change: {}",
                    failures.join("; ")
                ),
            }
        }
    };
    if let Err(error) = apply(clone_dir) {
        return Err(rollback(error));
    }

    let committed = match git.commit(clone_dir, relative_paths, message) {
        Ok(committed) => committed,
        Err(error) => return Err(rollback(error)),
    };
    // H4 Challenger step 13: the commit this call made, so a refused push
    // takes back exactly it and nothing earlier.
    let made = committed
        .then(|| library_git_capture(clone_dir, &["rev-parse", "HEAD"]).ok())
        .flatten()
        .map(|out| out.trim().to_string());
    // Push even when this call committed nothing. A previous write whose
    // push may have landed left a commit behind: the retry finds
    // identical bytes, stages nothing, and would otherwise report success while
    // the member's entry sat unpushed in the local clone forever. `git push`
    // with nothing to send is a cheap no-op, so this needs no bookkeeping
    // about what is or is not still pending.
    if remote {
        if let Err(failure) = git.push(clone_dir) {
            // It may have landed: taking the commit back could undo here what
            // GitHub already has. Kept; a retry settles it.
            if push_may_have_landed(&failure) {
                return Err(LibraryError::Conflict {
                    stage: ConflictStage::Push,
                    path: primary,
                    detail: failure.technical(),
                    timed_out: true,
                    earlier_commit_kept: false,
                });
            }
            // H4 Challenger step 13: nobody published — GitHub refused, or git
            // couldn't sign in. Nothing is shared, so nothing is kept half
            // published either, to go out with the next write: Plyloft's own
            // commit goes and every target is put back.
            let sign_in = sign_in_refusal(&failure);
            let detail = failure.technical();
            log::info!("team library: the push of {primary} didn't reach GitHub: {detail}");
            let mut failures = Vec::new();
            if committed {
                match made.as_deref() {
                    Some(commit) => {
                        if let Err(error) = git.uncommit(clone_dir, commit) {
                            failures.push(error);
                        }
                    }
                    None => failures.push("Plyloft couldn't read its own commit".to_string()),
                }
            }
            if failures.is_empty() {
                for (relative, snapshot) in &snapshots {
                    if let Err(error) = git.restore(clone_dir, relative, snapshot) {
                        failures.push(error);
                    }
                }
            }
            git.rolled_back();
            if !failures.is_empty() {
                let cause = if sign_in.is_some() { "Git couldn't sign in to GitHub, so the push was refused" } else { "GitHub refused the push" };
                return Err(LibraryError::Abandoned {
                    path: primary.clone(),
                    detail: format!(
                        "Plyloft couldn't update {primary} in the team library: {cause}, and Plyloft could \
                         not take its change back ({}).",
                        failures.join("; ")
                    ),
                });
            }
            return Err(match sign_in {
                Some(ssh) => LibraryError::SignIn {
                    stage: ConflictStage::Push,
                    path: primary,
                    detail,
                    ssh,
                },
                None => LibraryError::Conflict {
                    stage: ConflictStage::Push,
                    // A clone whose state can't be read counts as still holding it.
                    earlier_commit_kept: !committed
                        && ahead_behind(clone_dir).map_or(true, |(ahead, _)| ahead > 0),
                    path: primary,
                    detail,
                    timed_out: false,
                },
            });
        }
    }
    Ok(LibraryOutcome {
        path: clone_dir.join(&primary),
        relative_path: primary,
        committed,
        pushed: remote,
    })
}

/// May a caller undo what it wrote locally in anticipation of this write?
///
/// Only when the library is provably untouched — see
/// [`LibraryError::left_the_library_unchanged`]. Everything else keeps the
/// local work: a success and a push that may have landed both really changed
/// the library, and an abandoned rollback might have.
///
/// Phrased as a question about the *undo* rather than about the write,
/// because that is the decision a caller actually makes, and because the
/// safe answer to "I am not sure" is then simply `false`.
pub fn library_is_provably_unchanged(published: &Result<LibraryOutcome, LibraryError>) -> bool {
    match published {
        Ok(_) => false,
        Err(error) => error.left_the_library_unchanged(),
    }
}

impl TeamStore {
    /// `<app-support>/team/<slug>/library/knowledge/` — the Team Knowledge
    /// scope's directory on this Mac.
    pub fn knowledge_dir(&self, slug: &str) -> PathBuf {
        ply_memory::team_knowledge_dir(&self.clone_dir(slug))
    }

    /// Publish one library change through the real git.
    pub fn publish(
        &self,
        slug: &str,
        relative_path: &str,
        message: &str,
        apply: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<LibraryOutcome, LibraryError> {
        let _git = self.git_lock.lock();
        let outcome = publish_library_change(
            &self.clone_dir(slug),
            relative_path,
            message,
            apply,
            &RealLibraryGit,
        );
        // Skills hub H2 (R1): a team write is a trigger — the background
        // pull records where the library is now.
        crate::skills_hub::nudge(crate::skills_hub::Trigger::AfterWrite);
        outcome
    }

    /// v1.117.0: one library change spanning several paths — a promoted
    /// skill's two plugin directories and the Codex marketplace manifest,
    /// committed and pushed together.
    pub fn publish_paths(
        &self,
        slug: &str,
        relative_paths: &[String],
        message: &str,
        apply: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<LibraryOutcome, LibraryError> {
        let _git = self.git_lock.lock();
        let outcome = publish_library_paths(
            &self.clone_dir(slug),
            relative_paths,
            message,
            apply,
            &RealLibraryGit,
        );
        // Skills hub H2 (R1): a team write is a trigger — the background
        // pull records where the library is now.
        crate::skills_hub::nudge(crate::skills_hub::Trigger::AfterWrite);
        outcome
    }
}

// ── GH #226: a clone ahead and behind GitHub — "Reapply mine on top" ──
//
// The owner's decision: Ply rebases this Mac's unpublished library commits
// onto GitHub's branch, then pushes — never a force-push. If the same file
// changed on both sides the rebase is aborted and the clone is left exactly
// as it was, with the colliding files named.
//
// It is an **explicit** action (the toast of a stopped write, and Settings →
// Team), never a step inside an unrelated write. A write's contract is "the
// pull was refused, nothing was written"; rewriting the member's earlier
// commits and publishing them as a side effect of sharing one note would
// publish more than they pressed for, and a collision found halfway through
// a share would have to be reported as that share's failure.
//
// Before the rebase the local tip is recorded as `refs/ply/backup/<ts>-<sha>`,
// so whatever happens next the member's commits stay reachable. Backups are
// never removed on a failure; after a successful publish those older than
// [`BACKUP_KEEP_DAYS`] are, and the one just made is always kept.

/// Where "Reapply mine on top" records the local tip before it rebases.
pub const BACKUP_REF_PREFIX: &str = "refs/ply/backup/";

/// Backups older than this are removed after a successful publish.
pub const BACKUP_KEEP_DAYS: i64 = 30;

/// The timestamp half of a backup ref's name (UTC).
const BACKUP_TS_FORMAT: &str = "%Y%m%dT%H%M%SZ";

/// What "Reapply mine on top" ended with. Every variant but `Published` and
/// `InStep` leaves the member something to do; none of them loses a commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReapplyResult {
    /// This Mac's changes are on GitHub now (rebased first when needed).
    Published,
    /// Nothing of this Mac's was unpublished; GitHub's changes, if any, were
    /// brought in by a fast-forward.
    InStep,
    /// The same file changed on both sides. The rebase was aborted and the
    /// clone is exactly as it was (HEAD == the backup).
    Collision,
    /// Git stopped the rebase without a file in conflict (an untracked file
    /// in the way, a hook). Aborted and verified back as it was.
    Stopped,
    /// Tracked files are changed without a commit; nothing was attempted.
    Dirty,
    /// A rebase or merge Ply didn't start is under way in the clone; nothing
    /// was touched.
    Foreign,
    /// GitHub could not be asked; nothing was changed.
    FetchFailed,
    /// Rebased locally, but GitHub refused the push as not a fast-forward:
    /// a teammate published again. The rebased commits are kept; pressing
    /// again redoes it.
    PushRefused,
    /// Rebased locally, but GitHub refused the push for another reason — no
    /// write access, a protected branch, a hook. Pressing again can't help;
    /// the commits are kept and a later press only pushes (no new backup).
    PushDenied,
    /// Rebased locally, and the push was stopped at its bound. It may have
    /// landed; pressing again pushes it if it didn't and changes nothing if
    /// it did.
    PushTimedOut,
    /// A stopped rebase could not be verified back as it was. The backup
    /// holds the member's commits; the clone shows as Ply's own interrupted
    /// reapply, so a later press tries the abort again.
    Unrecovered,
    /// QoL 13.3: the collision was put together on this Mac with the
    /// member's choice for each file, and nothing was published. Publish
    /// (a plain reapply, which then only pushes) sends it; Undo puts the
    /// clone back to the backup.
    Resolved,
}

/// The report of one "Reapply mine on top".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReapplyReport {
    pub result: ReapplyResult,
    /// This Mac's commits still to publish: after a rebase, those GitHub
    /// doesn't already have (`@{upstream}..HEAD`); without one, the clone's
    /// unpublished commits.
    pub reapplied: usize,
    /// GitHub's commits this Mac did not have.
    pub brought_in: usize,
    /// `Collision`: the files changed on both sides. `Dirty`: the files
    /// changed without a commit. Repo-relative, for `Details`.
    pub paths: Vec<String>,
    /// The backup ref recorded before the rebase; `None` when no rebase ran.
    pub backup_ref: Option<String>,
    /// The team clone, for `Details`.
    pub clone_dir: String,
    /// What happened, what was left untouched, what to do — in words only:
    /// no path, ref, SHA or git output (those are the fields above and
    /// `detail`, which the page shows under `Details`). Files are named by
    /// their file name alone.
    pub message: String,
    /// Git's own words, for `Details`.
    pub detail: Option<String>,
    /// QoL 13.3: the folder on this Mac where *Keep both* saved this Mac's
    /// version of each file. `None` when nothing was saved.
    pub aside_dir: Option<String>,
}

/// The bounds and exit registry the network half runs under — injected so a
/// test can stall a push in test-sized time.
pub struct ReapplyBounds<'a> {
    pub fetch: std::time::Duration,
    pub push: std::time::Duration,
    pub registry: &'a crate::worktrees::FetchRegistry,
}

fn changes(n: usize) -> String {
    if n == 1 {
        "1 change".to_string()
    } else {
        format!("{n} changes")
    }
}

/// "a.md", "a.md and b.md" — file names only, never their folders.
fn named_files(paths: &[String]) -> String {
    let names: Vec<&str> = paths
        .iter()
        .map(|p| p.rsplit('/').next().unwrap_or(p.as_str()))
        .collect();
    match names.as_slice() {
        [] => String::new(),
        [one] => (*one).to_string(),
        [head @ .., last] => format!("{} and {last}", head.join(", ")),
    }
}

fn rev_parse(dir: &Path, rev: &str) -> Result<String, String> {
    library_git_capture(dir, &["rev-parse", "--verify", "--quiet", rev])
        .map(|out| out.trim().to_string())
}

fn rebase_in_progress(dir: &Path) -> bool {
    let git_dir = dir.join(".git");
    git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists()
}

/// Tracked files changed or staged without a commit. Untracked files are
/// not counted (review 1: a Finder `.DS_Store` must not refuse the
/// reapply); one that is in the rebase's way stops it, and the abort and
/// its verification put everything back. Names only.
fn uncommitted_paths(dir: &Path) -> Result<Vec<String>, String> {
    let out = library_git_capture(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    )?;
    let mut paths = Vec::new();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (code, path) = entry.split_at(entry.len().min(3));
        paths.push(path.to_string());
        // A rename or copy carries its source as the next entry.
        if code.contains('R') || code.contains('C') {
            entries.next();
        }
    }
    Ok(paths)
}

/// One uncommitted tracked entry of the clone (Move them aside).
struct UncommittedEntry {
    path: String,
    /// A rename's or copy's source.
    source: Option<String>,
    /// Changed in the index.
    staged: bool,
    /// Changed in the working tree beyond the index.
    edited: bool,
}

fn uncommitted_entries(dir: &Path) -> Result<Vec<UncommittedEntry>, String> {
    let out = library_git_capture(dir, &["status", "--porcelain=v1", "-z", "--untracked-files=no"])?;
    let mut found = Vec::new();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (code, path) = entry.split_at(entry.len().min(3));
        let mut chars = code.chars();
        let (x, y) = (chars.next().unwrap_or(' '), chars.next().unwrap_or(' '));
        let source = if x == 'R' || x == 'C' || y == 'R' || y == 'C' { entries.next().map(str::to_string) } else { None };
        found.push(UncommittedEntry { path: path.to_string(), source, staged: x != ' ', edited: y != ' ' });
    }
    Ok(found)
}

/// The files a stopped rebase left unmerged, read before it is aborted.
fn conflicted_paths(dir: &Path) -> Vec<String> {
    let out = library_git_capture(dir, &["diff", "--name-only", "--diff-filter=U", "-z"])
        .unwrap_or_default();
    let mut paths: Vec<String> =
        out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
    paths.sort();
    paths.dedup();
    paths
}

/// Did GitHub refuse the push because its branch moved on (a teammate
/// published again), rather than because this account may not push there?
pub(crate) fn push_refused_by_a_race(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("non-fast-forward")
        || detail.contains("(fetch first)")
        || detail.contains("stale info")
        || detail.contains("cannot lock ref")
}

/// Remove `refs/ply/backup/*` older than [`BACKUP_KEEP_DAYS`], never `keep`.
/// Called only after a successful publish. A ref whose name Ply did not
/// write (no parsable timestamp) is left alone.
fn prune_old_backups(dir: &Path, now: chrono::DateTime<chrono::Utc>, keep: Option<&str>) {
    let Ok(listed) = library_git_capture(dir, &["for-each-ref", "--format=%(refname)", BACKUP_REF_PREFIX])
    else {
        return;
    };
    for name in listed.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if Some(name) == keep {
            continue;
        }
        let Some(stamp) = name.strip_prefix(BACKUP_REF_PREFIX).and_then(|rest| rest.get(..16))
        else {
            continue;
        };
        let Ok(at) = chrono::NaiveDateTime::parse_from_str(stamp, BACKUP_TS_FORMAT) else {
            continue;
        };
        if now.naive_utc() - at > chrono::Duration::days(BACKUP_KEEP_DAYS) {
            if let Err(error) = library_git_run(dir, &["update-ref", "-d", name]) {
                log::warn!("team: could not remove the old backup {name}: {error}");
            }
        }
    }
}

/// Record `head` as a new backup ref and confirm it. Two presses within one
/// second get `-2`, `-3`… rather than failing on an existing name.
pub(crate) fn record_backup(
    dir: &Path,
    head: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<String, String> {
    let short = &head[..head.len().min(12)];
    let base = format!("{BACKUP_REF_PREFIX}{}-{short}", now.format(BACKUP_TS_FORMAT));
    for n in 1..=50 {
        let name = if n == 1 { base.clone() } else { format!("{base}-{n}") };
        if rev_parse(dir, &name).is_ok() {
            continue;
        }
        // Empty old value: create it, never move an existing ref.
        library_git_run(dir, &["update-ref", &name, head, ""])?;
        if rev_parse(dir, &name)? != head {
            return Err(format!("{name} does not point at {head}"));
        }
        return Ok(name);
    }
    Err(format!("{base}: every name is taken"))
}

/// "Reapply mine on top" for the team clone at `clone_dir`.
///
/// `Ok` carries every outcome the member can act on; `Err` is reserved for a
/// clone Ply cannot reason about — not cloned, no remote, a branch gone on
/// GitHub, a backup it could not record — each with nothing changed. No
/// message carries a path, a ref or git's output: those are the report's
/// fields and `detail`, which the page shows under `Details`, and the log.
///
/// Network steps (fetch, push) run bounded; so does each rebase step (F2,
/// [`LIBRARY_REBASE_TIMEOUT`]), with no hook and no signing, and a step
/// stopped at the bound is aborted and verified like any other stop. If Ply
/// itself is stopped halfway (force-quit), the rebase's starting point is one of its backups: the next press
/// recognises it as its own, aborts it, verifies HEAD is that backup, and
/// starts again.
pub fn reapply_library_changes_in(
    clone_dir: &Path,
    bounds: &ReapplyBounds<'_>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<ReapplyReport, String> {
    reapply_resolving_in(clone_dir, bounds, now, &Resolve::default())
}

/// QoL 13.3: [`reapply_library_changes_in`] with the member's choice for
/// each file both sides changed. With choices, a rebase that stops on those
/// files is settled with them and **not pushed** ([`ReapplyResult::Resolved`]):
/// the member publishes it, or undoes it, in a second deliberate press. A
/// file without a choice stops it as before ([`ReapplyResult::Collision`],
/// every file named), with the clone put back exactly as it was.
pub fn reapply_resolving_in(
    clone_dir: &Path,
    bounds: &ReapplyBounds<'_>,
    now: chrono::DateTime<chrono::Utc>,
    resolve: &Resolve,
) -> Result<ReapplyReport, String> {
    if !clone_dir.join(".git").exists() {
        return Err(
            format!("The team repo is not cloned on {THIS_MACHINE} yet. Open Settings › Team › Members and library and refresh."),
        );
    }
    let report = |result: ReapplyResult, message: String| ReapplyReport {
        result,
        reapplied: 0,
        brought_in: 0,
        paths: Vec::new(),
        backup_ref: None,
        clone_dir: clone_dir.display().to_string(),
        message,
        detail: None,
        aside_dir: None,
    };

    // Something already under way (review 1).
    match interruption_in(clone_dir) {
        None => {}
        Some(None) => {
            return Ok(report(
                ReapplyResult::Foreign,
                format!("The team clone on {THIS_MACHINE} is in the middle of a rebase or merge that Plyloft \
                 didn't start, so Plyloft won't touch it. Nothing was changed. Finish or abort it \
                 in the team clone, then press Reapply mine on top again."),
            ));
        }
        Some(Some((backup, sha))) => {
            // Ply's own, interrupted, and untouched since. Put it back to
            // where it started.
            let aborted = library_git_run(clone_dir, &["rebase", "--abort"]);
            let back = !rebase_in_progress(clone_dir)
                && rev_parse(clone_dir, "HEAD").ok().as_deref() == Some(sha.as_str());
            if !back {
                return Ok(ReapplyReport {
                    backup_ref: Some(backup),
                    detail: aborted.err(),
                    ..report(
                        ReapplyResult::Unrecovered,
                        "Plyloft's earlier reapply was interrupted, and Plyloft couldn't put the team \
                         clone back to where it started. Your changes are safe in the backup \
                         Plyloft made first. Don't write to the team library until someone who \
                         knows git has looked at the clone."
                            .to_string(),
                    )
                });
            }
            remove_reapply_marker(clone_dir);
            log::info!("team: aborted an interrupted reapply; HEAD is {backup} again");
        }
    }
    // A marker with no rebase under way is left from a reapply that ended
    // outside Ply (the member finished or aborted it): it marks nothing.
    if !rebase_in_progress(clone_dir) {
        remove_reapply_marker(clone_dir);
    }
    if !RealLibraryGit.has_remote(clone_dir)? {
        return Err("The team clone has no remote to publish to; nothing was changed.".into());
    }

    // A rebase would carry tracked edits along or refuse halfway; either way
    // it is not Ply's to decide what they are. Refused before anything —
    // after a torn fast-forward's leftovers (H1 Windows walk), which are
    // GitHub's files and not an edit, are put back.
    if let Err(error) = heal_torn_fast_forward(clone_dir) {
        log::warn!("team: reapply could not check for a torn fast-forward: {error}");
    }
    // QoL 13.3 (Challenger): choices waiting to be published. A Publish
    // that has to rebase again keeps them undoable (the marker follows).
    let pending = resolved_still(clone_dir);
    let dirty = uncommitted_paths(clone_dir)?;
    if !dirty.is_empty() {
        return Ok(ReapplyReport {
            paths: dirty.clone(),
            ..report(
                ReapplyResult::Dirty,
                {
                    let (verb, them) = if dirty.len() == 1 { ("is", "it") } else { ("are", "them") };
                    format!(
                        "{} {verb} changed in the team clone on {THIS_MACHINE} without a commit, so \
                         Plyloft won't reapply over {them}. Nothing was changed. Undo the edit or \
                         move {them} out of the team clone, then try again.",
                        named_files(&dirty),
                    )
                },
            )
        });
    }

    if let Err(failure) = library_network_git(
        clone_dir,
        &["fetch", "--quiet", "--prune"],
        "git fetch",
        bounds.fetch,
        bounds.registry,
    ) {
        // T5: git needed a sign-in it may not ask for — or (H4 step 13
        // Challenger) the team's account isn't signed in at all. Waiting on
        // the connection won't help either.
        let (said, todo) = if failure.timed_out() {
            ("GitHub didn't answer in time", "Check the connection, then try again.")
        } else if sign_in_refusal(&failure) == Some(true) {
            ("Git couldn't sign in to GitHub over SSH", "Check your SSH key, then try again.")
        } else if sign_in_refusal(&failure).is_some() {
            ("Git couldn't sign in to GitHub", "Sign in to GitHub in Settings › Team › Members and library, then try again.")
        } else {
            ("Plyloft couldn't reach the team repo on GitHub", "Check the connection, then try again.")
        };
        return Ok(ReapplyReport {
            detail: Some(failure.technical()),
            ..report(
                ReapplyResult::FetchFailed,
                format!(
                    "{said}, so nothing was reapplied. Nothing was changed on {THIS_MACHINE} or on \
                     GitHub. {todo}"
                ),
            )
        });
    }

    let (ahead, behind) = ahead_behind(clone_dir).map_err(|error| {
        log::warn!("team: reapply could not count ahead/behind: {error}");
        "Plyloft can't compare the team clone with GitHub — its branch may have been renamed or \
         removed there. Nothing was changed."
            .to_string()
    })?;
    let counted = |published: usize, r: ReapplyReport| ReapplyReport {
        reapplied: published,
        brought_in: behind,
        ..r
    };

    if ahead == 0 {
        // QoL 13.3: nothing of this Mac's to publish — a settled reapply
        // that kept only the teammate's versions is done.
        remove_resolved_marker(clone_dir);
        if behind > 0 {
            library_fast_forward(clone_dir)
                .map_err(|error| {
                    log::warn!("team: reapply could not fast-forward: {error}");
                    "Plyloft couldn't bring in GitHub's changes to the team library. Nothing was \
                     changed."
                        .to_string()
                })?;
        }
        return Ok(counted(
            0,
            report(
                ReapplyResult::InStep,
                if behind > 0 {
                    format!(
                        "{THIS_MACHINE_CAP} had nothing unpublished; Plyloft brought in {} from GitHub.",
                        changes(behind)
                    )
                } else {
                    format!("The team library on {THIS_MACHINE} is already in step with GitHub; there was \
                     nothing to reapply.")
                },
            ),
        ));
    }

    let mut backup: Option<String> = None;
    if behind > 0 {
        // The backup first: from here on, whatever happens, the member's
        // commits stay reachable under a name Ply can quote.
        let head = rev_parse(clone_dir, "HEAD")?;
        let name = record_backup(clone_dir, &head, now).map_err(|error| {
            log::warn!("team: reapply could not record a backup: {error}");
            "Plyloft couldn't record a backup of your team library changes, so it didn't \
             reapply them. Nothing was changed."
                .to_string()
        })?;
        backup = Some(name.clone());
        // Review 2: what makes this rebase Ply's own if Ply is stopped
        // during it — written before it starts, removed once it is verified
        // done or undone.
        write_reapply_marker(clone_dir, &name, &head).map_err(|error| {
            log::warn!("team: reapply could not write its marker: {error}");
            "Plyloft couldn't prepare the team clone for the reapply, so it didn't start it. \
             Nothing was changed."
                .to_string()
        })?;

        // Local, bounded (F2: no hook, no signing, so only a stuck disk
        // reaches the bound; the abort below then puts it back). `--no-autostash`: tracked files are clean
        // (just checked), and nothing may be stashed where the member can't
        // see it.
        let rebased = library_git_capture_bounded(
            clone_dir,
            &[
                "-c",
                "core.editor=true",
                "-c",
                "rebase.autoStash=false",
                // Review 3: the merge backend whatever the member's config
                // says — what an interrupted-reapply recovery reads
                // (`rebase-merge/`) must be what Ply's rebase writes.
                "-c",
                "rebase.backend=merge",
                "rebase",
                "--no-autostash",
                "--no-autosquash",
                "--quiet",
                "@{upstream}",
            ],
        );
        // QoL 13.3: a stop on files the member chose for is settled with
        // those choices, stop after stop, until the rebase finishes — or
        // meets a file nobody chose for, which aborts as before.
        let mut aside: Option<PathBuf> = None;
        // Challenger (block 13): every file a stop met, so a collision on a
        // later commit names the earlier ones too and the chooser keeps them.
        let mut met = std::collections::BTreeSet::new();
        let rebased = match rebased {
            Err(detail) if !resolve.choices.is_empty() && !conflicted_paths(clone_dir).is_empty() => {
                match settle_rebase(clone_dir, resolve, now, &mut aside, &mut met) {
                    Settled::Done(paths) => {
                        remove_reapply_marker(clone_dir);
                        library_git_run(clone_dir, &["merge-base", "--is-ancestor", "@{upstream}", "HEAD"]).map_err(|error| {
                            log::warn!("team: the settled library is not on top of upstream: {error}");
                            "The team library Plyloft put together doesn't sit on top of GitHub's, so Plyloft won't \
                             offer to publish it. Your changes are safe in the backup Plyloft made first."
                                .to_string()
                        })?;
                        let resolved_head = rev_parse(clone_dir, "HEAD")?;
                        let onto = rev_parse(clone_dir, "@{upstream}")?;
                        if let Err(error) = write_resolved_marker(clone_dir, &name, &resolved_head, &onto, &paths, aside.as_deref()) {
                            log::warn!("team: could not record the settled reapply: {error}");
                        }
                        let kept = if aside.is_some() {
                            format!(" Your own version of what you kept both of is saved in a folder on {THIS_MACHINE}.")
                        } else {
                            String::new()
                        };
                        return Ok(counted(
                            ahead,
                            ReapplyReport {
                                paths,
                                backup_ref: Some(name.clone()),
                                aside_dir: aside.map(|dir| dir.display().to_string()),
                                ..report(
                                    ReapplyResult::Resolved,
                                    format!(
                                        "Plyloft put your team library changes on top of your teammate's, with what you \
                                         chose for each file — on {THIS_MACHINE} only, nothing is published yet.{kept} \
                                         Publish sends them; Undo puts the team library on {THIS_MACHINE} back as it was."
                                    ),
                                )
                            },
                        ));
                    }
                    Settled::Stopped(more) => Err(format!("{detail}\n{more}")),
                }
            }
            other => other,
        };
        if let Err(detail) = rebased {
            let mut collisions = conflicted_paths(clone_dir);
            if !collisions.is_empty() {
                collisions.extend(met.iter().cloned());
                collisions.sort();
                collisions.dedup();
            }
            let aborted = if rebase_in_progress(clone_dir) {
                library_git_run(clone_dir, &["rebase", "--abort"])
            } else {
                Ok(())
            };
            let back = aborted.is_ok()
                && !rebase_in_progress(clone_dir)
                && rev_parse(clone_dir, "HEAD").ok().as_deref() == Some(head.as_str())
                && uncommitted_paths(clone_dir).map(|p| p.is_empty()).unwrap_or(false);
            let detail = match aborted {
                Ok(()) => detail,
                Err(abort) => format!("{detail}\n{abort}"),
            };
            let with = |result: ReapplyResult, paths: Vec<String>, message: String| {
                counted(
                    ahead,
                    ReapplyReport {
                        paths,
                        backup_ref: backup.clone(),
                        detail: Some(detail.clone()),
                        ..report(result, message)
                    },
                )
            };
            if back {
                remove_reapply_marker(clone_dir);
            }
            if !back {
                return Ok(with(
                    ReapplyResult::Unrecovered,
                    collisions,
                    "Plyloft couldn't reapply your team library changes, and couldn't confirm the \
                     team clone is back as it was. Your changes are safe in the backup Plyloft \
                     made first. Don't write to the team library until someone who knows git \
                     has looked at the clone."
                        .to_string(),
                ));
            }
            if collisions.is_empty() {
                return Ok(with(
                    ReapplyResult::Stopped,
                    Vec::new(),
                    "Git stopped reapplying your team library changes before it finished — \
                     most often a file in the team clone that isn't part of the library is in \
                     the way. Plyloft put everything back exactly as it was: nothing was \
                     published or lost. Clear what git names, then try again."
                        .to_string(),
                ));
            }
            let message = format!(
                "You and a teammate both changed {}, so Plyloft can't put yours on top without \
                 choosing between them. Plyloft stopped and put everything back exactly as it \
                 was: nothing was published or lost, and a backup of your changes is kept. \
                 Agree with your teammate which version to keep, then settle it by hand in \
                 the team clone; until then, writes to the team library stop here.",
                named_files(&collisions)
            );
            return Ok(with(ReapplyResult::Collision, collisions, message));
        }
        // The rebase finished: nothing is under way any more.
        remove_reapply_marker(clone_dir);
        // What the push below relies on: GitHub's tip is under this one, so
        // the push is a fast-forward and never replaces a teammate's work.
        library_git_run(clone_dir, &["merge-base", "--is-ancestor", "@{upstream}", "HEAD"])
            .map_err(|error| {
                log::warn!("team: the reapplied library is not on top of upstream: {error}");
                "The reapplied team library doesn't sit on top of GitHub's, so Plyloft won't \
                 publish it. Your changes are safe in the backup Plyloft made first."
                    .to_string()
            })?;
        if let Some(pending) = &pending {
            let moved = (|| -> Result<(), String> {
                let head = rev_parse(clone_dir, "HEAD")?;
                let onto = rev_parse(clone_dir, "@{upstream}")?;
                let aside = pending.aside.as_deref().map(Path::new);
                write_resolved_marker(clone_dir, &pending.backup, &head, &onto, &pending.paths, aside)
            })();
            if let Err(error) = moved {
                log::warn!("team: could not move the settled-reapply marker: {error}");
            }
        }
    }

    // Review 1: what is really left to publish. A rebase drops a commit
    // whose change a teammate already published.
    let published = if backup.is_some() {
        library_git_capture(clone_dir, &["rev-list", "--count", "@{upstream}..HEAD"])
            .ok()
            .and_then(|out| out.trim().parse().ok())
            .unwrap_or(ahead)
    } else {
        ahead
    };
    let on_top = if backup.is_some() {
        format!(
            ", on top of the {} a teammate published. A backup of how {THIS_MACHINE} had them is \
             kept",
            changes(behind)
        )
    } else {
        String::new()
    };
    match library_push_in(clone_dir, bounds.push, bounds.registry) {
        Ok(()) => {
            prune_old_backups(clone_dir, now, backup.as_deref());
            // QoL 13.3: a settled reapply is published now; nothing to undo.
            remove_resolved_marker(clone_dir);
            let message = if published == 0 {
                format!("Your changes were already on GitHub — a teammate had published the same \
                 ones — so there was nothing new to publish. The team library on {THIS_MACHINE} is \
                 in step again.")
            } else {
                format!("Published your {} to the team library{on_top}.", changes(published))
            };
            Ok(counted(
                published,
                ReapplyReport {
                    backup_ref: backup.clone(),
                    ..report(ReapplyResult::Published, message)
                },
            ))
        }
        Err(failure) => {
            let technical = failure.technical();
            let (result, message) = if failure.timed_out() {
                (
                    ReapplyResult::PushTimedOut,
                    format!(
                        "{TIMEOUT_MARKER} publishing your {}. They're kept in the team clone \
                         on {THIS_MACHINE} and may have reached GitHub anyway. Press Reapply mine on \
                         top again once the connection is back: it publishes them if they \
                         didn't land and changes nothing if they did.",
                        changes(published)
                    ),
                )
            } else if push_refused_by_a_race(&technical) {
                (
                    ReapplyResult::PushRefused,
                    format!(
                        "GitHub refused your {} because a teammate published again meanwhile. \
                         They're kept in the team clone on {THIS_MACHINE}. Press Reapply mine on top \
                         again.",
                        changes(published)
                    ),
                )
            } else {
                (
                    ReapplyResult::PushDenied,
                    format!(
                        "GitHub refused your {}: this account may not be allowed to publish to \
                         the team repo, or its branch is protected. They're kept in the team \
                         clone on {THIS_MACHINE}. Pressing again won't help — ask the team's owner \
                         for write access (Details has GitHub's answer).",
                        changes(published)
                    ),
                )
            };
            Ok(counted(
                published,
                ReapplyReport {
                    backup_ref: backup,
                    detail: Some(technical),
                    ..report(result, message)
                },
            ))
        }
    }
}

// ── QoL block 13.3: the conflict resolver ──────────────────────────────
//
// A collision used to end with "settle it by hand in the team clone". Now
// the member chooses per file — Keep mine, Keep theirs, Keep both — and
// Plyloft settles the same rebase with those choices, on this Mac only; a
// second press publishes it (the plain reapply, which then only pushes, as
// the team library always has) or undoes it (back to the backup ref the
// reapply recorded first). Uncommitted edits in the clone are moved aside
// into a dated folder instead of being settled by hand. Nothing here pushes:
// the only push is the reapply's own, fast-forward, never forced.

/// What the member chose for one file both sides changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReapplyChoice {
    /// This Mac's version.
    Mine,
    /// The teammate's version, as GitHub has it.
    Theirs,
    /// The teammate's version in the library, and this Mac's saved in a
    /// dated folder on this Mac (never published).
    Both,
}

/// The choices one settling press carries, and where *Keep both* saves.
#[derive(Debug, Clone, Default)]
pub struct Resolve {
    /// Repo-relative path → choice.
    pub choices: std::collections::BTreeMap<String, ReapplyChoice>,
    /// The folder dated set-aside folders go in (`<config>/team-set-aside`).
    pub aside_root: Option<PathBuf>,
}

/// How settling a stopped rebase ended.
enum Settled {
    /// The rebase finished; the files settled, sorted.
    Done(Vec<String>),
    /// It stopped where the choices don't reach (or git refused a step);
    /// the rebase is left for the caller's abort, with git's words.
    Stopped(String),
}

/// The stages an unmerged `path` has: `(base, ours, theirs)`.
fn unmerged_stages(dir: &Path, path: &str) -> (bool, bool, bool) {
    let out = library_git_capture(dir, &["ls-files", "-u", "-z", "--", path]).unwrap_or_default();
    let mut stages = (false, false, false);
    for record in out.split('\0').filter(|r| !r.is_empty()) {
        let stage = record.split('\t').next().and_then(|meta| meta.split_whitespace().nth(2));
        match stage {
            Some("1") => stages.0 = true,
            Some("2") => stages.1 = true,
            Some("3") => stages.2 = true,
            _ => {}
        }
    }
    stages
}

/// A dated folder under `root` for this clone (`<clone> 2026-10-22 101500`),
/// made on first use. No `:` in it, so the same name works on Windows.
fn aside_dir_for(root: &Path, clone_dir: &Path, now: chrono::DateTime<chrono::Utc>) -> Result<PathBuf, String> {
    let clone = clone_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "team".into());
    let base = format!("{clone} {}", now.format("%Y-%m-%d %H%M%S"));
    for n in 1..=50 {
        let name = if n == 1 { base.clone() } else { format!("{base} {n}") };
        let dir = root.join(&name);
        if dir.exists() {
            continue;
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
        return Ok(dir);
    }
    Err(format!("{base}: every name is taken"))
}

/// `rel` (with `/`) under `dir`, refusing anything that would leave it.
fn under_dir(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") || Path::new(rel).is_absolute() {
        return Err(format!("{rel} isn't a path Plyloft can save safely"));
    }
    Ok(rel.split('/').fold(dir.to_path_buf(), |path, part| path.join(part)))
}

/// Save this Mac's side of an unmerged `path` (stage 3 in a rebase) into
/// `aside`, byte for byte.
fn save_mine_aside(dir: &Path, path: &str, aside: &Path) -> Result<(), String> {
    let out = library_git_capture(dir, &["checkout-index", "--stage=3", "--temp", "--", path])?;
    let temp = out.split('\t').next().map(str::trim).filter(|t| !t.is_empty()).ok_or("git made no copy")?;
    let temp = under_dir(dir, temp)?;
    let to = under_dir(aside, path)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let moved = std::fs::rename(&temp, &to).or_else(|_| std::fs::copy(&temp, &to).map(|_| ()));
    let _ = std::fs::remove_file(&temp);
    moved.map_err(|e| format!("couldn't save {path}: {e}"))
}

/// Settle one unmerged `path` with `choice`. In a rebase, *ours* is GitHub's
/// side with this Mac's earlier commits on it, and *theirs* is this Mac's
/// commit being put on top.
fn apply_choice(dir: &Path, path: &str, choice: ReapplyChoice, aside: Option<&Path>) -> Result<(), String> {
    let (_, ours, theirs) = unmerged_stages(dir, path);
    if choice == ReapplyChoice::Both && theirs {
        let aside = aside.ok_or("there is no folder to save your version in")?;
        save_mine_aside(dir, path, aside)?;
    }
    let (present, side) = match choice {
        ReapplyChoice::Mine => (theirs, "--theirs"),
        ReapplyChoice::Theirs | ReapplyChoice::Both => (ours, "--ours"),
    };
    if present {
        library_git_run(dir, &["checkout", side, "--", path])?;
        library_git_run(dir, &["add", "--", path])
    } else {
        // The chosen side removed it: out of the index, then off the disk
        // (never a forced `git rm`: the team library's code carries no force).
        library_git_run(dir, &["rm", "-q", "--cached", "--ignore-unmatch", "--", path])?;
        let file = under_dir(dir, path)?;
        if file.is_file() {
            std::fs::remove_file(&file).map_err(|e| format!("{path}: {e}"))?;
        }
        Ok(())
    }
}

/// Settle a rebase stopped on conflicts with `resolve`'s choices, stop after
/// stop. A stop with a file nobody chose for, or one git won't continue
/// from, is left for the caller to abort.
fn settle_rebase(
    dir: &Path,
    resolve: &Resolve,
    now: chrono::DateTime<chrono::Utc>,
    aside: &mut Option<PathBuf>,
    met: &mut std::collections::BTreeSet<String>,
) -> Settled {
    let mut settled = std::collections::BTreeSet::new();
    for _ in 0..500 {
        if !rebase_in_progress(dir) {
            return Settled::Done(settled.into_iter().collect());
        }
        let unmerged = conflicted_paths(dir);
        if unmerged.is_empty() {
            // A commit the choices left with nothing to add: skip it, as a
            // rebase does with a change GitHub already has.
            let empty = library_git_run(dir, &["diff", "--cached", "--quiet", "HEAD", "--"]).is_ok();
            if !empty {
                return Settled::Stopped("git stopped the reapply without a file in conflict".into());
            }
            if let Err(error) = library_git_capture_bounded(dir, &["-c", "core.editor=true", "rebase", "--skip"]) {
                if rebase_in_progress(dir) && conflicted_paths(dir).is_empty() {
                    return Settled::Stopped(error);
                }
            }
            continue;
        }
        met.extend(unmerged.iter().cloned());
        if let Some(missing) = unmerged.iter().find(|path| !resolve.choices.contains_key(*path)) {
            return Settled::Stopped(format!("{missing} changed on both sides too, and has no choice yet"));
        }
        for path in &unmerged {
            let choice = resolve.choices[path];
            if choice == ReapplyChoice::Both && aside.is_none() {
                match resolve.aside_root.as_deref().map(|root| aside_dir_for(root, dir, now)) {
                    Some(Ok(made)) => *aside = Some(made),
                    Some(Err(error)) => return Settled::Stopped(error),
                    None => return Settled::Stopped("there is no folder to save your version in".into()),
                }
            }
            if let Err(error) = apply_choice(dir, path, choice, aside.as_deref()) {
                return Settled::Stopped(format!("{path}: {error}"));
            }
            settled.insert(path.clone());
        }
        let continued = library_git_capture_bounded(
            dir,
            &["-c", "core.editor=true", "-c", "rebase.backend=merge", "rebase", "--continue"],
        );
        if let Err(error) = continued {
            if !rebase_in_progress(dir) {
                return Settled::Stopped(error);
            }
        }
    }
    Settled::Stopped("the reapply stopped too many times".into())
}

/// Why a team library write waits while settled choices are unpublished.
pub fn resolved_first_words() -> String {
    format!(
        "Your choices for the team library are put together on {THIS_MACHINE} and not published yet. \
         Publish or Undo your choices first, in Settings › Team › Members and library; nothing was written."
    )
}

/// The file that marks a settled, unpublished reapply (QoL 13.3): the backup
/// it can go back to, the commit it left, the files settled and where *Keep
/// both* saved. Removed once published, undone, or out of date.
const RESOLVED_MARKER: &str = "ply-resolved";

fn resolved_marker_path(dir: &Path) -> PathBuf {
    dir.join(".git").join(RESOLVED_MARKER)
}

fn write_resolved_marker(dir: &Path, backup: &str, head: &str, onto: &str, paths: &[String], aside: Option<&Path>) -> Result<(), String> {
    let mut text = format!("backup {backup}\nhead {head}\nonto {onto}\n");
    if let Some(aside) = aside {
        text.push_str(&format!("aside {}\n", aside.display()));
    }
    for path in paths {
        text.push_str(&format!("path {path}\n"));
    }
    crate::atomic::write_atomic_text(&resolved_marker_path(dir), &text)
}

struct ResolvedMarker {
    backup: String,
    head: String,
    /// GitHub's tip the choices were put on top of.
    onto: String,
    aside: Option<String>,
    paths: Vec<String>,
}

fn read_resolved_marker(dir: &Path) -> Option<ResolvedMarker> {
    let text = std::fs::read_to_string(resolved_marker_path(dir)).ok()?;
    let (mut backup, mut head, mut onto, mut aside, mut paths) = (None, None, None, None, Vec::new());
    for line in text.lines() {
        match line.split_once(' ') {
            Some(("backup", value)) => backup = Some(value.trim().to_string()),
            Some(("head", value)) => head = Some(value.trim().to_string()),
            Some(("onto", value)) => onto = Some(value.trim().to_string()),
            Some(("aside", value)) => aside = Some(value.to_string()),
            Some(("path", value)) => paths.push(value.to_string()),
            _ => {}
        }
    }
    Some(ResolvedMarker { backup: backup?, head: head?, onto: onto?, aside, paths })
}

fn remove_resolved_marker(dir: &Path) {
    match std::fs::remove_file(resolved_marker_path(dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("team: could not remove the settled-reapply marker: {error}"),
    }
}

/// The settled reapply the marker describes, while it still does: the clone
/// is where the settling left it, and GitHub doesn't have it yet — or there
/// was nothing of this Mac's left to publish (every choice was Keep theirs),
/// which Undo can still take back.
fn resolved_still(dir: &Path) -> Option<ResolvedMarker> {
    let marker = read_resolved_marker(dir)?;
    let here = !rebase_in_progress(dir) && rev_parse(dir, "HEAD").ok().as_deref() == Some(marker.head.as_str());
    let published = marker.head != marker.onto
        && library_git_run(dir, &["merge-base", "--is-ancestor", "HEAD", "@{upstream}"]).is_ok();
    (here && !published).then_some(marker)
}

/// QoL 13.3: a settled reapply waiting on this Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryResolved {
    /// The files settled, repo-relative (for `Details`).
    pub paths: Vec<String>,
    /// The backup Undo goes back to (for `Details`).
    pub backup_ref: String,
    /// Where *Keep both* saved this Mac's versions, if it did.
    pub aside_dir: Option<String>,
    pub clone_dir: String,
}

/// The settled reapply waiting in `clone_dir`, if one is.
pub fn library_resolved(clone_dir: &Path) -> Option<LibraryResolved> {
    if !clone_dir.join(".git").exists() {
        return None;
    }
    let marker = resolved_still(clone_dir)?;
    Some(LibraryResolved {
        paths: marker.paths,
        backup_ref: marker.backup,
        aside_dir: marker.aside,
        clone_dir: clone_dir.display().to_string(),
    })
}

/// QoL 13.3 **Undo**: put the clone back to the backup the settled reapply
/// started from. Local only, and only while the clone is exactly where the
/// settling left it and GitHub doesn't have it; anything else changes
/// nothing and says why.
pub fn undo_resolved_in(clone_dir: &Path) -> Result<String, String> {
    let Some(marker) = read_resolved_marker(clone_dir) else {
        return Err(format!("There is nothing to undo in the team library on {THIS_MACHINE}."));
    };
    if resolved_still(clone_dir).is_none() {
        remove_resolved_marker(clone_dir);
        return Err(
            "The team library moved on since your choices were put together (or they were published), so \
             Plyloft changed nothing. The backup of how it was is still kept."
                .into(),
        );
    }
    if !uncommitted_paths(clone_dir)?.is_empty() {
        return Err("The team clone has changes Plyloft didn't make, so Plyloft changed nothing.".into());
    }
    let backup = rev_parse(clone_dir, &marker.backup)
        .map_err(|_| "The backup of how the team library was is gone, so Plyloft changed nothing.".to_string())?;
    library_git_run(clone_dir, &["reset", "--keep", "-q", &backup])?;
    if rev_parse(clone_dir, "HEAD")? != backup {
        return Err("Git didn't put the team clone back to the backup. Nothing was published.".into());
    }
    remove_resolved_marker(clone_dir);
    Ok(format!("Undone: the team library on {THIS_MACHINE} is back as it was before your choices. Nothing was published."))
}

/// What *Move them aside* did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedAside {
    /// The dated folder the files were copied into.
    pub dir: String,
    /// The files, repo-relative.
    pub paths: Vec<String>,
}

/// QoL 13.3 **Move them aside**: the team clone's uncommitted edits are
/// copied into a dated folder under `aside_root`, then put back to what the
/// clone's last commit holds (a file that commit lacks is taken out). Every
/// copy is made before anything is put back; a copy that fails changes
/// nothing in the clone.
pub fn move_aside_in(clone_dir: &Path, aside_root: &Path, now: chrono::DateTime<chrono::Utc>) -> Result<MovedAside, String> {
    if !clone_dir.join(".git").exists() {
        return Err(format!("The team repo is not cloned on {THIS_MACHINE} yet."));
    }
    if interruption_in(clone_dir).is_some() {
        return Err(format!("A git step is under way in the team library on {THIS_MACHINE}, so Plyloft moved nothing."));
    }
    if let Err(error) = heal_torn_fast_forward(clone_dir) {
        log::warn!("team: move aside could not check for a torn fast-forward: {error}");
    }
    let entries = uncommitted_entries(clone_dir)?;
    if entries.is_empty() {
        return Err(format!("Nothing in the team library on {THIS_MACHINE} needs moving aside."));
    }
    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let dir = aside_dir_for(aside_root, clone_dir, now)?;
    for entry in &entries {
        let path = &entry.path;
        let from = under_dir(clone_dir, path)?;
        if from.is_file() {
            let to = under_dir(&dir, path)?;
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            std::fs::copy(&from, &to).map_err(|e| format!("couldn't copy {path}: {e}. Nothing in the team library was changed."))?;
        }
        // Challenger: staged and then edited again (`MM`): the staged
        // version is a second copy, under `staged/`.
        if entry.staged && entry.edited {
            let out = library_git_capture(clone_dir, &["checkout-index", "--temp", "--", path])?;
            let temp = out.split('\t').next().map(str::trim).filter(|t| !t.is_empty()).ok_or("git made no copy")?;
            let temp = under_dir(clone_dir, temp)?;
            let to = under_dir(&dir.join("staged"), path)?;
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            let moved = std::fs::rename(&temp, &to).or_else(|_| std::fs::copy(&temp, &to).map(|_| ()));
            let _ = std::fs::remove_file(&temp);
            moved.map_err(|e| format!("couldn't copy the staged {path}: {e}. Nothing in the team library was changed."))?;
        }
    }
    // A staged rename's source goes back too, or the clone stays changed.
    let mut restore: Vec<String> = paths.clone();
    restore.extend(entries.iter().filter_map(|e| e.source.clone()));
    for path in &restore {
        let at_head = library_git_run(clone_dir, &["cat-file", "-e", &format!("HEAD:{path}")]).is_ok();
        if at_head {
            library_git_run(clone_dir, &["checkout", "HEAD", "--", path])?;
        } else {
            library_git_run(clone_dir, &["rm", "-q", "--cached", "--ignore-unmatch", "--", path])?;
            let file = under_dir(clone_dir, path)?;
            if file.is_file() {
                std::fs::remove_file(&file).map_err(|e| format!("{path}: {e}"))?;
            }
        }
    }
    if !uncommitted_paths(clone_dir)?.is_empty() {
        return Err(format!(
            "Plyloft copied the files into {} but couldn't put all of them back in the team library.",
            dir.display()
        ));
    }
    Ok(MovedAside { dir: dir.display().to_string(), paths })
}

impl TeamStore {
    /// "Reapply mine on top" through the real git, serialised with every
    /// other git operation on the clone — QoL 13.3: with the member's choice
    /// for each file both sides changed (empty: the plain reapply).
    pub fn reapply_resolving(
        &self,
        slug: &str,
        choices: std::collections::BTreeMap<String, ReapplyChoice>,
    ) -> Result<ReapplyReport, String> {
        let _git = self.git_lock.lock();
        reapply_resolving_in(
            &self.clone_dir(slug),
            &ReapplyBounds {
                fetch: LIBRARY_FETCH_TIMEOUT,
                push: LIBRARY_PUSH_TIMEOUT,
                registry: crate::worktrees::exit_registry(),
            },
            chrono::Utc::now(),
            &Resolve { choices, aside_root: Some(self.aside_root()) },
        )
    }

    /// QoL 13.3: Undo a settled reapply (local only).
    pub fn undo_resolved(&self, slug: &str) -> Result<String, String> {
        let _git = self.git_lock.lock();
        undo_resolved_in(&self.clone_dir(slug))
    }

    /// QoL 13.3: Move the clone's uncommitted edits aside.
    pub fn move_aside(&self, slug: &str) -> Result<MovedAside, String> {
        let _git = self.git_lock.lock();
        move_aside_in(&self.clone_dir(slug), &self.aside_root(), chrono::Utc::now())
    }

    /// Where the dated set-aside folders go: beside the team clones, never
    /// among them (a folder there would read as a clone).
    pub fn aside_root(&self) -> PathBuf {
        self.root.with_file_name("team-set-aside")
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Walk follow-ups 2026-10-19 (Windows, `gh` signed out): Details said
    /// to turn on "Git uses your GitHub sign-in" beside gh's own 401.
    #[test]
    fn a_pull_git_could_not_sign_in_for_advises_gh_sign_in_when_gh_is_signed_out() {
        use crate::platform::{GIT_AUTH_GH_SIGNED_OUT_WORDS, GIT_AUTH_WORDS, GIT_SSH_AUTH_WORDS};
        let pull = format!("Could not pull the team repo: {GIT_AUTH_WORDS}");
        for gh in [
            "Could not read your GitHub login: gh: Requires authentication (HTTP 401)",
            "Could not check access to o/t: To get started with GitHub CLI, please run:  gh auth login",
            "Could not read your GitHub login: Your team uses the GitHub account ana, which isn't signed in on this PC.",
            "Could not read your GitHub login: gh: Bad credentials (HTTP 401)",
        ] {
            let said = sign_in_advice(vec![pull.clone(), gh.to_string()]);
            assert_eq!(said[0], format!("Could not pull the team repo: {GIT_AUTH_GH_SIGNED_OUT_WORDS}"), "{gh}");
            assert!(!said[0].contains("Git uses your GitHub sign-in"), "{gh}");
            assert_eq!(said[1], gh, "gh's own words stay for Details");
        }
        assert!(GIT_AUTH_GH_SIGNED_OUT_WORDS.starts_with("Git couldn't sign in to GitHub"), "the UI's marker");
        assert!(GIT_AUTH_GH_SIGNED_OUT_WORDS.contains(crate::platform::THIS_MACHINE));
        assert!(GIT_AUTH_GH_SIGNED_OUT_WORDS.contains("In Settings › Setup and account › Setup › GitHub, sign in to GitHub"));
        // gh signed in (its login read): git's helper is the fix, as before.
        let kept = sign_in_advice(vec![pull.clone()]);
        assert_eq!(kept, vec![pull.clone()]);
        let kept = sign_in_advice(vec![pull.clone(), "Could not check access to o/t: error connecting to api.github.com".into()]);
        assert_eq!(kept[0], pull);
        // Over SSH gh's sign-in plays no part.
        let ssh = format!("Could not pull the team repo: {GIT_SSH_AUTH_WORDS}");
        let kept = sign_in_advice(vec![ssh.clone(), "Could not read your GitHub login: gh: Requires authentication (HTTP 401)".into()]);
        assert_eq!(kept[0], ssh);
    }

    #[test]
    fn an_unauthenticated_404_is_no_write_answer() {
        let denied = crate::github::RepoAccess::denied();
        // gh signed out: no login, and the private repo's 404.
        assert_eq!(write_answer(None, Some(denied)), None);
        assert_eq!(write_answer(Some("member"), Some(denied)), Some(false));
        let writer = crate::github::RepoAccess { pull: true, push: Some(true) };
        assert_eq!(write_answer(Some("member"), Some(writer)), Some(true));
        assert_eq!(write_answer(Some("member"), None), None);
    }

    /// Byte-for-byte the manifest `scripts/team-init.sh` writes. If the two
    /// ever drift, this is the test that says so.
    const TEAM_INIT_MANIFEST: &[u8] = br#"{
  "schemaVersion": 1,
  "name": "MB Adv",
  "members": [
    { "login": "MatteoB-adv", "owner": true },
    { "login": "minidev", "owner": false }
  ],
  "workspaces": [
    { "repo": "MatteoB-adv/atelier" },
    { "repo": "MatteoB-adv/other" }
  ]
}"#;

    #[test]
    fn parses_the_manifest_team_init_writes() {
        let m = parse_manifest(TEAM_INIT_MANIFEST).expect("parse");
        assert_eq!(m.schema_version, 1);
        assert_eq!(m.name, "MB Adv");
        assert_eq!(m.owner_login(), Some("MatteoB-adv"));
        assert!(m.lists("minidev"));
        // GitHub logins are case-insensitive.
        assert!(m.lists("MINIDEV"));
        assert!(!m.lists("stranger"));
        assert_eq!(m.workspaces.len(), 2);
        assert_eq!(m.workspaces[0].dir_name(), "atelier");
        assert_eq!(m.workspaces[0].display_name(), "atelier");
    }

    #[test]
    fn manifest_optional_fields_and_failures() {
        // Minimal manifest: a name is all that is required.
        let m = parse_manifest(br#"{"name":"Solo"}"#).expect("parse");
        assert_eq!(m.schema_version, 1);
        assert!(m.members.is_empty());
        assert!(m.workspaces.is_empty());
        assert_eq!(m.owner_login(), None);
        assert!(!m.lists("anyone"));

        // Optional workspace fields survive the round trip.
        let m = parse_manifest(
            br#"{"name":"T","workspaces":[{"repo":"o/r","name":"Nice Name","defaultBranch":"trunk"}]}"#,
        )
        .expect("parse");
        assert_eq!(m.workspaces[0].display_name(), "Nice Name");
        assert_eq!(m.workspaces[0].default_branch.as_deref(), Some("trunk"));

        // A member entry without `owner` is not the owner.
        let m = parse_manifest(br#"{"name":"T","members":[{"login":"a"}]}"#).expect("parse");
        assert_eq!(m.owner_login(), None);
        assert!(m.lists("a"));

        // Failures name the file.
        assert!(parse_manifest(b"{nope").unwrap_err().contains(MANIFEST_FILE));
        assert!(parse_manifest(br#"{"name":"  "}"#)
            .unwrap_err()
            .contains("no team name"));
    }

    /// The membership matrix — all four combinations of the two halves.
    #[test]
    fn membership_matrix() {
        // Listed + access → in.
        assert_eq!(
            evaluate_membership(Some(true), true),
            Membership::Member
        );
        // Access but not listed → the owner must add you.
        assert_eq!(
            evaluate_membership(Some(false), true),
            Membership::NotListed
        );
        // Listed but no access → the owner must invite your GitHub account.
        assert_eq!(
            evaluate_membership(Some(true), false),
            Membership::NoRepoAccess
        );
        // Neither: access is the half to fix first — without it there is no
        // manifest to be listed in.
        assert_eq!(
            evaluate_membership(Some(false), false),
            Membership::NoRepoAccess
        );

        assert!(Membership::Member.is_member());
        assert!(Membership::Member.reason().is_none());
        assert!(Membership::NotListed.reason().unwrap().contains("does not \
                 list"));
        assert!(Membership::NoRepoAccess
            .reason()
            .unwrap()
            .contains("access"));
        // An unreadable manifest with access is undecided, not a refusal.
        assert_eq!(evaluate_membership(None, true), Membership::Unknown);
    }

    #[test]
    fn repo_slugs_that_could_escape_the_clone_root_are_refused() {
        assert!(is_valid_repo_slug("MatteoB-adv/atelier"));
        assert!(is_valid_repo_slug("owner/repo.js"));
        assert!(!is_valid_repo_slug("owner/../../etc"));
        assert!(!is_valid_repo_slug("owner/.."));
        assert!(!is_valid_repo_slug("/etc/passwd"));
        assert!(!is_valid_repo_slug("owner"));
        assert!(!is_valid_repo_slug("owner/repo/extra"));
        assert!(!is_valid_repo_slug("owner/re po"));
        assert!(!is_valid_repo_slug(""));
    }

    #[test]
    fn picker_refuses_a_manifest_entry_that_is_not_a_repo_slug() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let store = WorkspaceStore::new(config).expect("store");
        let entry = team_workspace("owner/../../escape", None);
        let err = add_workspace_with(&tmp.path().join("code"), &entry, &store, |_, _| {
            unreachable!()
        })
        .unwrap_err();
        assert!(err.contains("not a valid owner/name"));
        // …and it is never offered in the picker either.
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry],
            extra: Default::default(),
        };
        assert!(workspace_views(Some(&manifest), &tmp.path().join("code"), &store).is_empty());
    }

    #[test]
    fn slug_dir_names_stay_inside_the_team_directory() {
        assert_eq!(slug_dir_name("MatteoB-adv/mbadv-team"), "MatteoB-adv__mbadv-team");
        assert_eq!(slug_dir_name("../../etc"), "..__..__etc");
        assert!(!slug_dir_name("../../etc").contains('/'));
        assert_eq!(slug_dir_name("owner/re po!"), "owner__re-po-");
        assert_eq!(slug_dir_name(".."), "team");
    }

    #[test]
    fn sync_clone_clones_once_then_pulls() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("team").join("owner__repo");

        let out = sync_clone(
            &dir,
            "owner/repo",
            |slug, dest| {
                assert_eq!(slug, "owner/repo");
                std::fs::create_dir_all(dest.join(".git")).unwrap();
                Ok(())
            },
            |_| panic!("must not pull a directory that was not there"),
        )
        .expect("clone");
        assert!(out.cloned);
        assert!(out.pull_error.is_none());

        let pulled = std::cell::Cell::new(false);
        let out = sync_clone(
            &dir,
            "owner/repo",
            |_, _| panic!("must not re-clone an existing checkout"),
            |_| {
                pulled.set(true);
                Ok(())
            },
        )
        .expect("pull");
        assert!(!out.cloned);
        assert!(pulled.get());

        // Offline: the pull error is reported, never fatal.
        let out = sync_clone(&dir, "owner/repo", |_, _| unreachable!(), |_| {
            Err("could not resolve host".into())
        })
        .expect("degrades");
        assert_eq!(out.pull_error.as_deref(), Some("could not resolve host"));
    }

    #[test]
    fn sync_clone_refuses_a_non_checkout_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("occupied");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), "mine").unwrap();
        let err = sync_clone(&dir, "owner/repo", |_, _| unreachable!(), |_| unreachable!())
            .unwrap_err();
        assert!(err.contains("not a git checkout"));
    }

    #[test]
    fn read_manifest_missing_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_manifest(tmp.path()).unwrap().is_none());
        std::fs::write(tmp.path().join(MANIFEST_FILE), TEAM_INIT_MANIFEST).unwrap();
        assert_eq!(read_manifest(tmp.path()).unwrap().unwrap().name, "MB Adv");
    }

    #[test]
    fn clone_root_default_and_override() {
        assert_eq!(clone_root(None), default_clone_root());
        assert_eq!(clone_root(Some("   ")), default_clone_root());
        assert_eq!(clone_root(Some("/tmp/ply-code")), PathBuf::from("/tmp/ply-code"));
        let home = home_dir();
        assert_eq!(clone_root(Some("~/elsewhere")), home.join("elsewhere"));
        assert_eq!(clone_root(Some("~")), home);
    }

    // ── Onboarding §8 helpers ─────────────────────────────────────────

    fn team_settings() -> crate::settings::TeamSettings {
        crate::settings::TeamSettings::default()
    }

    /// §8.2 / D9: the team's own clone root is kept; else the projects folder
    /// Setup chose; else nothing — the legacy `~/code` default, so a member
    /// who set neither sees no change.
    #[test]
    fn clone_root_setting_keeps_the_team_root_then_the_projects_folder() {
        use crate::settings::ProjectsSettings;
        let mut team = team_settings();
        let mut projects = ProjectsSettings::default();
        assert_eq!(clone_root_setting(&team, &projects), None);
        assert_eq!(clone_root(clone_root_setting(&team, &projects)), default_clone_root());

        projects.folder = Some("~/Projects".into());
        assert_eq!(clone_root_setting(&team, &projects), Some("~/Projects"));
        assert_eq!(
            clone_root(clone_root_setting(&team, &projects)),
            home_dir().join("Projects")
        );

        team.clone_root = Some("~/work".into());
        assert_eq!(clone_root_setting(&team, &projects), Some("~/work"), "kept (D9)");

        team.clone_root = Some("  ".into());
        assert_eq!(clone_root_setting(&team, &projects), Some("~/Projects"));
        projects.folder = Some(" ".into());
        assert_eq!(clone_root_setting(&team, &projects), None);
    }

    /// 1.168.1 (owner, 2026-10-22): with nothing chosen, team workspaces go
    /// to the projects folder's default `~/Projects`, not `~/code` — except
    /// while the legacy `~/code` already holds one of the team's checkouts,
    /// which stays where it is (nothing moved, nothing cloned twice).
    #[test]
    fn with_nothing_chosen_team_workspaces_go_to_the_projects_default() {
        use crate::settings::DEFAULT_PROJECTS_FOLDER;
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("code");
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![team_workspace("bob/tools", None), team_workspace("bob/site", None)],
            extra: Default::default(),
        };
        let projects = expand_tilde(DEFAULT_PROJECTS_FOLDER);
        assert_eq!(default_clone_root(), projects);
        assert_eq!(clone_root(None), projects);
        assert_ne!(default_clone_root(), legacy_clone_root());
        // Nothing in ~/code: the projects default, with or without a manifest.
        assert_eq!(effective_clone_root_with(None, Some(&manifest), legacy.clone()), projects);
        let empty = temp_store(&tmp.path().join("store0"));
        assert_eq!(
            effective_root_and_views_with(None, Some(&manifest), &empty, legacy.clone()).0,
            projects
        );
        assert_eq!(effective_clone_root_with(None, None, legacy.clone()), projects);
        // Something else in ~/code (another repo at the natural path): still
        // the projects default.
        fake_clone(&legacy.join("tools"), "alice/tools", None);
        assert_eq!(effective_clone_root_with(None, Some(&manifest), legacy.clone()), projects);
        // One of the team's own checkouts there: it stays the root.
        fake_clone(&legacy.join("site"), "bob/site", None);
        assert_eq!(effective_clone_root_with(None, Some(&manifest), legacy.clone()), legacy);
        // The status's rows agree with the root, read once under ~/code.
        let store = temp_store(tmp.path());
        let (root, views) = effective_root_and_views_with(None, Some(&manifest), &store, legacy.clone());
        assert_eq!(root, legacy);
        let site = views.iter().find(|v| v.repo == "bob/site").unwrap();
        assert!(site.cloned && site.local_path.ends_with("site"));
        // A chosen root or projects folder always wins.
        assert_eq!(
            effective_clone_root_with(Some("~/Work"), Some(&manifest), legacy.clone()),
            home_dir().join("Work")
        );
        // A blank setting reads as unset, so the legacy checkout above still
        // decides.
        assert_eq!(effective_clone_root_with(Some("  "), Some(&manifest), legacy.clone()), legacy);
    }

    /// §11.1 / launch G3: `team.teamRepo` names the team, a stored key's
    /// repo never does, and blanks read as absent.
    #[test]
    fn current_team_repo_reads_the_setting_only() {
        let mut team = team_settings();
        assert_eq!(current_team_repo(&team), None);
        team.team_repo = Some(" new-org/team ".into());
        assert_eq!(current_team_repo(&team).as_deref(), Some("new-org/team"));
        team.team_repo = Some(" ".into());
        assert_eq!(current_team_repo(&team), None);
    }

    /// U31: a registered team project whose folder is gone reads as registered
    /// and not cloned, and picking it again clones it without a second
    /// workspace.
    #[test]
    fn a_registered_project_with_its_folder_gone_is_cloned_back_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("code");
        let store = temp_store(tmp.path());
        let entry = TeamWorkspace { repo: "acme/lyra".into(), name: Some("Lyra".into()), default_branch: None };
        let clone = |slug: &str, dest: &Path| {
            fake_clone(dest, slug, Some("Lyra"));
            Ok(())
        };
        let first = add_workspace_with(&root, &entry, &store, clone).unwrap();
        assert!(first.cloned && first.registered);
        std::fs::remove_dir_all(root.join("lyra")).unwrap();

        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry.clone()],
            extra: Default::default(),
        };
        let views = workspace_views(Some(&manifest), &root, &store);
        assert!(views[0].registered && !views[0].cloned, "{views:?}");

        let again = add_workspace_with(&root, &entry, &store, clone).unwrap();
        assert!(again.cloned && !again.registered);
        assert_eq!(store.snapshot().workspaces.len(), 1);
        assert!(root.join("lyra/.git").exists());
    }

    /// U31: under a clone root changed since, the project is matched by its
    /// repository, not offered as new; a gone folder by its board's repository.
    #[test]
    fn a_project_under_another_root_is_the_same_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let old_root = tmp.path().join("old");
        let new_root = tmp.path().join("new");
        let store = temp_store(tmp.path());
        let entry = TeamWorkspace { repo: "acme/lyra".into(), name: Some("Lyra".into()), default_branch: None };
        let clone = |slug: &str, dest: &Path| {
            fake_clone(dest, slug, Some("Lyra"));
            Ok(())
        };
        add_workspace_with(&old_root, &entry, &store, clone).unwrap();
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry.clone()],
            extra: Default::default(),
        };
        let views = workspace_views(Some(&manifest), &new_root, &store);
        assert!(views[0].registered && views[0].cloned && views[0].folder_present, "{views:?}");
        assert!(views[0].local_path.contains("old"), "{views:?}");
        let again = add_workspace_with(&new_root, &entry, &store, |_, _| unreachable!()).unwrap();
        assert!(!again.cloned && !again.registered);
        assert_eq!(store.snapshot().workspaces.len(), 1);
        assert!(!new_root.join("lyra").exists());
    }

    /// U31: registered, there, and not a repository: said apart from gone.
    #[test]
    fn a_folder_there_that_isnt_a_repository_isnt_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("code");
        let store = temp_store(tmp.path());
        let entry = TeamWorkspace { repo: "acme/lyra".into(), name: Some("Lyra".into()), default_branch: None };
        add_workspace_with(&root, &entry, &store, |slug, dest| {
            fake_clone(dest, slug, Some("Lyra"));
            Ok(())
        })
        .unwrap();
        std::fs::remove_dir_all(root.join("lyra/.git")).unwrap();
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry.clone()],
            extra: Default::default(),
        };
        let views = workspace_views(Some(&manifest), &root, &store);
        assert!(views[0].registered && !views[0].cloned && views[0].folder_present, "{views:?}");
    }

    /// §8.3 / §5 step 2 / §10 / §11.1: the derivation, case by case.
    #[test]
    fn effective_work_mode_derives_team_from_signals_unless_solo_was_chosen() {
        use crate::settings::WorkMode;
        let none = TeamSignals::default();
        let mut team = team_settings();

        // A fresh Mac: nothing says team.
        assert_eq!(effective_work_mode(&team, none), WorkMode::Solo);

        // Each signal alone derives team, with no write.
        for signals in [
            TeamSignals { team_clone: true, ..none },
            TeamSignals { github_issues_workspace: true, ..none },
            TeamSignals { plan_owns_team: true, ..none },
        ] {
            assert_eq!(effective_work_mode(&team, signals), WorkMode::Team, "{signals:?}");
        }
        // U6: the plan derives team, and never overrides a choice of solo.
        let mut chose_solo = team_settings();
        chose_solo.work_mode = Some(WorkMode::Solo);
        assert_eq!(effective_work_mode(&chose_solo, TeamSignals { plan_owns_team: true, ..none }), WorkMode::Solo);
        team.team_repo = Some("new-org/team".into());
        assert_eq!(effective_work_mode(&team, none), WorkMode::Team, "team.teamRepo");
        team.team_repo = None;

        // An explicit choice wins over the derivation…
        team.work_mode = Some(WorkMode::Solo);
        assert_eq!(
            effective_work_mode(&team, TeamSignals { team_clone: true, ..none }),
            WorkMode::Solo,
            "a member who chose solo stays solo"
        );
        team.team_repo = Some("new-org/team".into());
        assert_eq!(effective_work_mode(&team, none), WorkMode::Solo);
        team.work_mode = Some(WorkMode::Team);
        assert_eq!(effective_work_mode(&team_settings_with(WorkMode::Team), none), WorkMode::Team);

        // …except a GitHub Issues board, a team feature solo would hide the
        // way out of.
        team.work_mode = Some(WorkMode::Solo);
        assert_eq!(
            effective_work_mode(&team, TeamSignals { github_issues_workspace: true, ..none }),
            WorkMode::Team
        );
    }

    fn team_settings_with(mode: crate::settings::WorkMode) -> crate::settings::TeamSettings {
        crate::settings::TeamSettings {
            work_mode: Some(mode),
            ..team_settings()
        }
    }

    /// §5 step 2: a team clone is any directory under `<config_dir>/team/`
    /// with a `.git`; a missing directory or a stray folder is not one.
    #[test]
    fn has_any_clone_sees_only_git_checkouts_under_the_team_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TeamStore::new(tmp.path().to_path_buf());
        assert!(!store.has_any_clone(), "no team dir at all");
        std::fs::create_dir_all(tmp.path().join(TEAM_DIR).join("stray")).unwrap();
        assert!(!store.has_any_clone(), "a folder without .git");
        std::fs::create_dir_all(store.clone_dir("mb-adv/ply-team").join(".git")).unwrap();
        assert!(store.has_any_clone());
    }

    /// A checkout of `slug`, as `gh repo clone` would leave it: a real git
    /// repository with an `origin` remote, so the destination resolver can
    /// tell whose checkout it is.
    fn fake_clone(dest: &Path, slug: &str, workspace_name: Option<&str>) {
        std::fs::create_dir_all(dest).unwrap();
        crate::git::run(dest, &["init", "-q"]).unwrap();
        crate::git::run(
            dest,
            &[
                "remote",
                "add",
                "origin",
                &format!("https://github.com/{slug}.git"),
            ],
        )
        .unwrap();
        if let Some(name) = workspace_name {
            std::fs::create_dir_all(dest.join(".atelier")).unwrap();
            std::fs::write(
                dest.join(".atelier").join("workspace_default.json"),
                format!(r#"{{"name":"{name}"}}"#),
            )
            .unwrap();
        }
    }

    fn team_workspace(repo: &str, name: Option<&str>) -> TeamWorkspace {
        TeamWorkspace {
            repo: repo.into(),
            name: name.map(str::to_string),
            default_branch: None,
        }
    }

    fn temp_store(tmp: &Path) -> WorkspaceStore {
        let config = tmp.join("config");
        std::fs::create_dir_all(&config).unwrap();
        WorkspaceStore::new(config).expect("store")
    }

    #[test]
    fn origin_urls_are_matched_by_their_last_two_segments() {
        for url in [
            "https://github.com/MatteoB-adv/atelier.git",
            "https://github.com/MatteoB-adv/atelier",
            "git@github.com:MatteoB-adv/atelier.git",
            "ssh://git@github.com/MatteoB-adv/atelier.git",
            "https://github.com/matteob-adv/atelier",
        ] {
            assert!(origin_matches(url, "MatteoB-adv/atelier"), "{url}");
        }
        // A different owner with the same repo name is NOT a match — this is
        // the whole point.
        assert!(!origin_matches(
            "https://github.com/alice/tools.git",
            "bob/tools"
        ));
        assert!(!origin_matches("https://github.com/o/other", "o/repo"));
        assert!(!origin_matches("", "o/repo"));
        assert!(!origin_matches("noslash", "o/repo"));
    }

    /// The same owner/name on another host is a different repository. Team
    /// workspaces are cloned with `gh`, so only GitHub remotes can be this
    /// team workspace's checkout.
    #[test]
    fn a_matching_path_on_another_host_is_not_a_match() {
        for url in [
            "https://gitlab.com/alice/tools.git",
            "https://gitlab.com/alice/tools",
            "git@gitlab.com:alice/tools.git",
            "ssh://git@bitbucket.org/alice/tools.git",
            "https://github.evil.com/alice/tools.git",
            "https://ghe.internal/alice/tools",
            // A local path is not a host at all.
            "/Users/someone/code/alice/tools",
            "file:///Users/someone/code/alice/tools",
        ] {
            assert!(!origin_matches(url, "alice/tools"), "{url}");
        }
        // GitHub in every accepted shape still matches, port included.
        assert!(origin_matches("ssh://git@github.com:22/alice/tools.git", "alice/tools"));
        assert!(origin_matches("https://www.github.com/alice/tools", "alice/tools"));
        assert!(origin_matches("ssh://git@ssh.github.com:443/alice/tools.git", "alice/tools"));
        // …and a GitHub URL with extra path segments is not a repo URL.
        assert!(!origin_matches(
            "https://github.com/alice/tools/tree/main",
            "alice/tools"
        ));
    }

    /// A checkout of another repository sitting at the natural path must
    /// never make the row read "Open" — and when there is nowhere left to
    /// clone to, the row says so instead of hiding it.
    #[test]
    fn a_conflicting_row_reports_the_conflict_and_is_never_registered() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let root = tmp.path().join("code");
        // Alice's tools are checked out at BOTH candidate paths…
        fake_clone(&root.join("tools"), "alice/tools", Some("Alice Tools"));
        fake_clone(&root.join("bob--tools"), "carol/tools", Some("Carol Tools"));
        // …and Alice's checkout is a registered workspace of this user.
        store
            .import_default(&root.join("tools"))
            .expect("import")
            .expect("registered");

        let entry = team_workspace("bob/tools", Some("Bob Tools"));
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry.clone()],
            extra: Default::default(),
        };
        let views = workspace_views(Some(&manifest), &root, &store);
        assert_eq!(views.len(), 1);
        // The unrelated registered checkout does not make bob/tools "Open".
        assert!(!views[0].registered);
        assert!(!views[0].cloned);
        let conflict = views[0].conflict.as_deref().expect("conflict reported");
        assert!(conflict.contains("bob--tools"));
        assert!(conflict.contains("other repositories"));

        // Move the second one aside: the row goes back to a normal, free
        // destination with no conflict.
        std::fs::rename(root.join("bob--tools"), root.join("carol--tools")).unwrap();
        let views = workspace_views(Some(&manifest), &root, &store);
        assert!(views[0].conflict.is_none());
        assert!(!views[0].registered);
        assert!(views[0].local_path.ends_with("bob--tools"));
    }

    /// Two team workspaces with the same basename: the second gets its own
    /// `owner--name` directory instead of adopting the first one's checkout.
    #[test]
    fn a_basename_taken_by_another_repo_gets_a_qualified_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let root = tmp.path().join("code");
        // Alice's tools are already checked out at the natural path.
        fake_clone(&root.join("tools"), "alice/tools", Some("Alice Tools"));

        let entry = team_workspace("bob/tools", Some("Bob Tools"));
        assert_eq!(
            resolve_destination(&root, &entry).unwrap(),
            root.join("bob--tools")
        );

        let cloned_into = std::cell::RefCell::new(PathBuf::new());
        let added = add_workspace_with(&root, &entry, &store, |slug, dest| {
            assert_eq!(slug, "bob/tools");
            *cloned_into.borrow_mut() = dest.to_path_buf();
            fake_clone(dest, slug, Some("Bob Tools"));
            Ok(())
        })
        .expect("pick");
        assert!(added.cloned);
        assert!(added.registered);
        assert_eq!(*cloned_into.borrow(), root.join("bob--tools"));
        assert!(added.path.ends_with("bob--tools"));
        // Alice's checkout was never registered.
        let registered = store.snapshot().workspaces;
        assert_eq!(registered.len(), 1);
        assert!(!registered[0].cwd.ends_with("/tools"));

        // The picker row shows the qualified path too, so what the member
        // reads is where the clone lands.
        let manifest = TeamManifest {
            schema_version: 1,
            name: "T".into(),
            members: Vec::new(),
            workspaces: vec![entry.clone()],
            extra: Default::default(),
        };
        let views = workspace_views(Some(&manifest), &root, &store);
        assert!(views[0].local_path.ends_with("bob--tools"));
        assert!(views[0].registered);

        // …and picking it again still does nothing.
        let again =
            add_workspace_with(&root, &entry, &store, |_, _| unreachable!()).expect("second pick");
        assert!(!again.cloned);
        assert!(!again.registered);
        assert_eq!(store.snapshot().workspaces.len(), 1);
    }

    /// Both candidate paths held by other repositories: refuse, and say
    /// which two directories are in the way.
    #[test]
    fn both_candidate_paths_taken_by_other_repos_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let root = tmp.path().join("code");
        fake_clone(&root.join("tools"), "alice/tools", None);
        fake_clone(&root.join("bob--tools"), "carol/tools", None);

        let entry = team_workspace("bob/tools", None);
        let err = resolve_destination(&root, &entry).unwrap_err();
        assert!(err.contains("bob--tools"));
        assert!(err.contains("Move one aside"));
        let err = add_workspace_with(&root, &entry, &store, |_, _| unreachable!()).unwrap_err();
        assert!(err.contains("other repositories"));
        assert!(store.snapshot().workspaces.is_empty());
    }

    /// A checkout whose origin cannot be read is not assumed to be ours.
    #[test]
    fn a_checkout_without_an_origin_is_not_adopted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("code");
        let stray = root.join("atelier");
        std::fs::create_dir_all(&stray).unwrap();
        crate::git::run(&stray, &["init", "-q"]).unwrap();

        let entry = team_workspace("MatteoB-adv/atelier", None);
        assert_eq!(
            resolve_destination(&root, &entry).unwrap(),
            root.join("MatteoB-adv--atelier")
        );
    }

    /// The picker is idempotent: picking a team workspace whose clone is
    /// already on disk neither re-clones nor registers a second workspace.
    #[test]
    fn picker_is_idempotent_on_an_existing_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let store = WorkspaceStore::new(config).expect("store");
        let root = tmp.path().join("code");
        let entry = team_workspace("MatteoB-adv/atelier", None);

        // First pick: clones and registers.
        let first = add_workspace_with(&root, &entry, &store, |slug, dest| {
            assert_eq!(slug, "MatteoB-adv/atelier");
            fake_clone(dest, slug, Some("Atelier"));
            Ok(())
        })
        .expect("first pick");
        assert!(first.cloned);
        assert!(first.registered);
        assert_eq!(first.name, "Atelier");
        assert_eq!(store.snapshot().workspaces.len(), 1);

        // Second pick: the checkout is there, so no clone, no second
        // workspace — and the call still succeeds (the picker is a button a
        // member may press twice).
        let second = add_workspace_with(&root, &entry, &store, |_, _| {
            panic!("must not clone over an existing checkout")
        })
        .expect("second pick");
        assert!(!second.cloned);
        assert!(!second.registered);
        assert_eq!(second.name, "Atelier");
        assert_eq!(second.path, first.path);
        assert_eq!(store.snapshot().workspaces.len(), 1);
    }

    /// A team workspace without a committed `workspace_default.json` is
    /// still registered, under the manifest's display name.
    #[test]
    fn picker_registers_a_repo_without_a_workspace_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let store = WorkspaceStore::new(config).expect("store");
        let root = tmp.path().join("code");
        let entry = team_workspace("MatteoB-adv/tools", Some("Team Tools"));

        let added = add_workspace_with(&root, &entry, &store, |slug, dest| {
            fake_clone(dest, slug, None);
            Ok(())
        })
        .expect("pick");
        assert!(added.cloned);
        assert!(added.registered);
        assert_eq!(added.name, "Team Tools");
        assert_eq!(store.snapshot().workspaces.len(), 1);
        // Owner, 2026-10-20: the team's name, not this person's — a shared
        // definition the branch carries later fills its Name in.
        assert_eq!(store.snapshot().workspaces[0].name_chosen, Some(false));

        // …and picking it again is still a no-op.
        let again = add_workspace_with(&root, &entry, &store, |_, _| unreachable!())
            .expect("second pick");
        assert!(!again.cloned);
        assert!(!again.registered);
        assert_eq!(store.snapshot().workspaces.len(), 1);
    }

    /// A Mac whose key names no team: the panel has nothing to show, and
    /// any membership cached from a previous key is dropped.
    #[test]
    fn status_without_a_team_repo_is_empty_and_forgets_the_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::new(tmp.path().join("config")).expect("store");
        let team = TeamStore::new(tmp.path().join("config"));
        team.remember_membership("old/team", Membership::Member, Some("octocat".into()), None);

        let out = status(None, Some("MB Adv"), None, &[], &store, &team, false);
        assert_eq!(out.team_repo, None);
        assert_eq!(out.membership, Membership::Unknown);
        assert!(out.workspaces.is_empty());
        assert!(out.clone_root_is_default);
        assert_eq!(out.clone_root, default_clone_root().to_string_lossy());
        assert!(team.cached_membership("old/team").is_none());
    }

    /// The local read: manifest from the clone, picker rows against what is
    /// on disk, membership from the last refresh. No `gh` call — the test
    /// seam is not armed, so any call would fail loudly.
    #[test]
    fn status_reads_the_local_clone_and_the_cached_membership() {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let store = WorkspaceStore::new(config.clone()).expect("store");
        let team = TeamStore::new(config);
        let clone_dir = team.clone_dir("MatteoB-adv/mbadv-team");
        std::fs::create_dir_all(clone_dir.join(".git")).unwrap();
        std::fs::write(clone_dir.join(MANIFEST_FILE), TEAM_INIT_MANIFEST).unwrap();
        team.remember_membership(
            "MatteoB-adv/mbadv-team",
            Membership::Member,
            Some("minidev".into()),
            None,
        );

        let root = tmp.path().join("code");
        let out = status(
            Some("MatteoB-adv/mbadv-team"),
            Some("Key Name"),
            Some(root.to_str().unwrap()),
            &[],
            &store,
            &team,
            false,
        );
        // The manifest's name wins over the key's.
        assert_eq!(out.team_name.as_deref(), Some("MB Adv"));
        assert_eq!(out.owner_login.as_deref(), Some("MatteoB-adv"));
        assert!(out.has_clone);
        assert!(!out.clone_root_is_default);
        assert_eq!(out.membership, Membership::Member);
        assert_eq!(out.login.as_deref(), Some("minidev"));
        assert!(out.membership_reason.is_none());
        assert_eq!(out.workspaces.len(), 2);
        assert!(!out.workspaces[0].cloned);
        assert!(!out.workspaces[0].registered);
        assert!(out.error.is_none());

        // A cached answer belongs to its own team: a key swap drops it.
        let other = status(
            Some("other/team"),
            None,
            None,
            &[],
            &store,
            &team,
            false,
        );
        assert_eq!(other.membership, Membership::Unknown);
    }

    /// The refresh path end to end, with GitHub answering "you may read it"
    /// and the manifest not listing this account: the panel says which half
    /// is missing, and the verdict is cached for the next local read.
    #[test]
    fn refresh_resolves_membership_and_caches_it() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let store = WorkspaceStore::new(config.clone()).expect("store");
        let team = TeamStore::new(config);
        let clone_dir = team.clone_dir("MatteoB-adv/mbadv-team");
        std::fs::create_dir_all(clone_dir.join(".git")).unwrap();
        std::fs::write(clone_dir.join(MANIFEST_FILE), TEAM_INIT_MANIFEST).unwrap();
        // The clone exists, so sync pulls: `git pull` in a directory that is
        // not a real checkout fails, which must stay advisory.
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok("stranger".into()), // gh api user --jq .login
            Ok("true".into()),     // gh api repos/… --jq .permissions.pull
        ]);

        let out = status(
            Some("MatteoB-adv/mbadv-team"),
            None,
            Some(tmp.path().join("code").to_str().unwrap()),
            &[],
            &store,
            &team,
            true,
        );
        assert_eq!(out.membership, Membership::NotListed);
        assert_eq!(out.login.as_deref(), Some("stranger"));
        assert!(out.membership_reason.unwrap().contains("does not"));
        // The failed pull is reported, not fatal.
        assert!(out.error.is_some());
        assert_eq!(out.team_name.as_deref(), Some("MB Adv"));

        let cached = team.cached_membership("MatteoB-adv/mbadv-team").unwrap();
        assert_eq!(cached.membership, Membership::NotListed);

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// An unreachable `gh` must never render as "you are not in the team".
    #[test]
    fn refresh_with_an_unreachable_gh_stays_unknown() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("config");
        let store = WorkspaceStore::new(config.clone()).expect("store");
        let team = TeamStore::new(config);
        let clone_dir = team.clone_dir("MatteoB-adv/mbadv-team");
        std::fs::create_dir_all(clone_dir.join(".git")).unwrap();
        std::fs::write(clone_dir.join(MANIFEST_FILE), TEAM_INIT_MANIFEST).unwrap();
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Err("no such host".into()),
            Err("no such host".into()),
        ]);

        let out = status(
            Some("MatteoB-adv/mbadv-team"),
            None,
            None,
            &[],
            &store,
            &team,
            true,
        );
        assert_eq!(out.membership, Membership::Unknown);
        assert!(out.membership_reason.is_none());
        assert!(out.error.unwrap().contains("no such host"));

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    // ── The membership gate in front of every clone ─────────────────

    fn gate_fixture() -> (tempfile::TempDir, WorkspaceStore, TeamStore, TeamWorkspace, TeamManifest)
    {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let team = TeamStore::new(tmp.path().join("config"));
        let entry = team_workspace("MatteoB-adv/atelier", None);
        let manifest = parse_manifest(TEAM_INIT_MANIFEST).expect("manifest");
        (tmp, store, team, entry, manifest)
    }

    const SLUG: &str = "MatteoB-adv/mbadv-team";

    /// GitHub grants read access, but the manifest does not list this
    /// account: refused, and nothing is cloned. `gh` would happily clone a
    /// public team workspace, so this check is the only thing enforcing
    /// the manifest half of the rule.
    #[test]
    fn add_is_refused_when_the_manifest_does_not_list_you() {
        let _guard = crate::github::test_serial_lock();
        let (tmp, store, team, entry, manifest) = gate_fixture();
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok("stranger".into()), // gh api user
            Ok("true".into()),     // read access granted
        ]);

        let err = add_workspace_checked_with(
            &tmp.path().join("code"),
            &entry,
            &manifest,
            &store,
            &team,
            SLUG,
            |_, _| panic!("must not clone for a non-member"),
        )
        .unwrap_err();
        assert!(err.contains("not a member"), "{err}");
        assert!(err.contains("does not"), "{err}");
        assert!(store.snapshot().workspaces.is_empty());

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// The manifest lists this account but GitHub refuses the team repo:
    /// also refused, with the other half's reason.
    #[test]
    fn add_is_refused_when_github_denies_the_team_repo() {
        let _guard = crate::github::test_serial_lock();
        let (tmp, store, team, entry, manifest) = gate_fixture();
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Ok("minidev".into()),
            Err("gh: Not Found (HTTP 404)".into()),
        ]);

        let err = add_workspace_checked_with(
            &tmp.path().join("code"),
            &entry,
            &manifest,
            &store,
            &team,
            SLUG,
            |_, _| panic!("must not clone without access to the team repo"),
        )
        .unwrap_err();
        assert!(err.contains("not a member"), "{err}");
        assert!(err.contains("invite"), "{err}");
        assert!(store.snapshot().workspaces.is_empty());

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// A confirmed member: cloned, registered, and the toast is not told to
    /// hedge.
    #[test]
    fn add_proceeds_for_a_confirmed_member() {
        let _guard = crate::github::test_serial_lock();
        let (tmp, store, team, entry, manifest) = gate_fixture();
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![Ok("minidev".into()), Ok("true".into())]);

        let added = add_workspace_checked_with(
            &tmp.path().join("code"),
            &entry,
            &manifest,
            &store,
            &team,
            SLUG,
            |slug, dest| {
                fake_clone(dest, slug, Some("Atelier"));
                Ok(())
            },
        )
        .expect("member may add");
        assert!(added.cloned);
        assert!(added.registered);
        assert!(!added.membership_from_cache);
        assert_eq!(store.snapshot().workspaces.len(), 1);

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// Offline, with GitHub's last answer being "member": allowed, and
    /// flagged so the toast can say the check was not fresh.
    #[test]
    fn add_offline_falls_back_to_the_last_confirmed_membership() {
        let _guard = crate::github::test_serial_lock();
        let (tmp, store, team, entry, manifest) = gate_fixture();
        team.remember_membership(SLUG, Membership::Member, Some("minidev".into()), None);
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Err("no such host".into()),
            Err("no such host".into()),
        ]);

        let added = add_workspace_checked_with(
            &tmp.path().join("code"),
            &entry,
            &manifest,
            &store,
            &team,
            SLUG,
            |slug, dest| {
                fake_clone(dest, slug, Some("Atelier"));
                Ok(())
            },
        )
        .expect("a known member may add while offline");
        assert!(added.membership_from_cache);
        assert_eq!(store.snapshot().workspaces.len(), 1);
        // The unanswered probe must not have evicted the cached answer.
        assert_eq!(
            team.cached_membership(SLUG).unwrap().membership,
            Membership::Member
        );

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// Offline with nothing to fall back on: refused. Ply will not clone a
    /// team's private repositories on a local file's word alone.
    #[test]
    fn add_offline_without_a_previous_answer_is_refused() {
        let _guard = crate::github::test_serial_lock();
        let (tmp, store, team, entry, manifest) = gate_fixture();
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Err("no such host".into()),
            Err("no such host".into()),
        ]);

        let err = add_workspace_checked_with(
            &tmp.path().join("code"),
            &entry,
            &manifest,
            &store,
            &team,
            SLUG,
            |_, _| panic!("must not clone on an unverified membership"),
        )
        .unwrap_err();
        assert!(err.contains("could not check"), "{err}");
        assert!(store.snapshot().workspaces.is_empty());

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    /// The gate as a pure decision, including the case a rate limit puts us
    /// in: unknown now, refused before — still refused.
    #[test]
    fn authorize_add_matrix() {
        assert_eq!(
            authorize_add(Membership::Member, None).unwrap(),
            AddAuthorization::Confirmed
        );
        assert!(authorize_add(Membership::NotListed, Some(Membership::Member)).is_err());
        assert!(authorize_add(Membership::NoRepoAccess, Some(Membership::Member)).is_err());
        assert_eq!(
            authorize_add(Membership::Unknown, Some(Membership::Member)).unwrap(),
            AddAuthorization::CachedMember
        );
        assert!(authorize_add(Membership::Unknown, Some(Membership::NotListed)).is_err());
        assert!(authorize_add(Membership::Unknown, None).is_err());
    }

    /// A failed re-check shows the last answer, marked stale — not a blank
    /// "Checking…" that would contradict the add still being allowed.
    #[test]
    fn a_failed_refresh_shows_the_last_answer_as_stale() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let team = TeamStore::new(tmp.path().join("config"));
        let clone_dir = team.clone_dir(SLUG);
        std::fs::create_dir_all(clone_dir.join(".git")).unwrap();
        std::fs::write(clone_dir.join(MANIFEST_FILE), TEAM_INIT_MANIFEST).unwrap();
        team.remember_membership(SLUG, Membership::Member, Some("minidev".into()), None);
        crate::github::invalidate_login_cache();
        crate::github::set_test_gh_responses(vec![
            Err("no such host".into()),
            Err("no such host".into()),
        ]);

        let out = status(Some(SLUG), None, None, &[], &store, &team, true);
        assert_eq!(out.membership, Membership::Member);
        assert!(out.membership_stale);
        assert_eq!(out.login.as_deref(), Some("minidev"));
        assert!(out.error.is_some());

        crate::github::clear_test_gh_responses();
        crate::github::invalidate_login_cache();
    }

    #[test]
    fn picker_refuses_a_non_checkout_destination() {
        let tmp = tempfile::tempdir().unwrap();
        let store = temp_store(tmp.path());
        let root = tmp.path().join("code");
        std::fs::create_dir_all(root.join("atelier")).unwrap();
        std::fs::write(root.join("atelier").join("mine.txt"), "x").unwrap();
        let entry = team_workspace("MatteoB-adv/atelier", None);
        let err = add_workspace_with(&root, &entry, &store, |_, _| unreachable!()).unwrap_err();
        assert!(err.contains("not a git checkout"));
        assert!(store.snapshot().workspaces.is_empty());
    }
    /// v1.118.0 (rung 5): the Create-team form suggests the repos the
    /// owner's registered workspaces point at, so the slug it puts in the
    /// manifest keeps the case GitHub shows.
    #[test]
    fn origin_slug_keeps_the_case_a_human_reads() {
        for url in [
            "https://github.com/MatteoB-adv/atelier.git",
            "https://github.com/MatteoB-adv/atelier",
            "git@github.com:MatteoB-adv/atelier.git",
            "ssh://git@github.com/MatteoB-adv/atelier.git",
            // 1.169.1: GitHub's SSH over 443.
            "ssh://git@ssh.github.com:443/MatteoB-adv/atelier.git",
            "git@ssh.github.com:MatteoB-adv/atelier.git",
        ] {
            assert_eq!(origin_slug(url).as_deref(), Some("MatteoB-adv/atelier"), "{url}");
        }
        // Not GitHub, and not a remote at all.
        assert_eq!(origin_slug("https://gitlab.com/a/b.git"), None);
        assert_eq!(origin_slug("/Users/me/code/atelier"), None);
    }

    // ── Team library writes (v1.115.0 — team sharing rung 2) ─────────
    //
    // These drive REAL git against a local bare remote in a temp dir: no
    // network, no GitHub, but a genuine clone/pull/commit/push, which is the
    // only way to prove the conflict path is the one git actually takes.

    fn git(dir: &Path, args: &[&str]) {
        let output = crate::platform::git_command()
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Plyloft Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Plyloft Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .unwrap_or_else(|e| panic!("spawn git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A bare "GitHub" plus one clone of it, both under `root`. Returns the
    /// bare repo and the clone (the stand-in for `<app-support>/team/<slug>`).
    fn bare_remote_and_clone(root: &Path) -> (PathBuf, PathBuf) {
        let bare = root.join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "--bare", "--initial-branch=main", "."]);

        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "--initial-branch=main", "."]);
        std::fs::write(seed.join("team.json"), br#"{"name":"MB Adv"}"#).unwrap();
        std::fs::create_dir_all(seed.join("library").join("knowledge")).unwrap();
        std::fs::write(
            seed.join("library").join("knowledge").join(".gitkeep"),
            b"",
        )
        .unwrap();
        git(&seed, &["add", "-A"]);
        git(&seed, &["commit", "-m", "seed"]);
        git(&seed, &["remote", "add", "origin", &bare.to_string_lossy()]);
        git(&seed, &["push", "-u", "origin", "main"]);

        let clone = root.join("clone");
        git(
            root,
            &[
                "clone",
                &bare.to_string_lossy(),
                &clone.to_string_lossy(),
            ],
        );
        git(&clone, &["config", "user.name", "Plyloft Test"]);
        git(&clone, &["config", "user.email", "test@example.invalid"]);
        (bare, clone)
    }

    fn write_entry(path: &Path, text: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    #[test]
    fn library_relative_path_refuses_escapes() {
        assert_eq!(
            library_relative_path("knowledge/auth-flow.md").unwrap(),
            "library/knowledge/auth-flow.md"
        );
        assert_eq!(
            library_relative_path("/knowledge/auth-flow.md/").unwrap(),
            "library/knowledge/auth-flow.md"
        );
        for bad in ["", "   ", "..", "knowledge/../../etc/passwd", "knowledge/./x.md"] {
            assert!(
                library_relative_path(bad).is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn publish_pulls_writes_commits_and_pushes_to_the_bare_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();

        let outcome = publish_library_change(
            &clone,
            &rel,
            "knowledge: share \"Auth flow\" with the team",
            |path| write_entry(path, "---\nid: a\n---\nbody\n"),
            &RealLibraryGit,
        )
        .expect("publish");
        assert!(outcome.committed);
        assert!(outcome.pushed);
        assert_eq!(outcome.relative_path, "library/knowledge/auth-flow.md");
        assert!(outcome.path.is_file());

        // The bare remote really received it.
        let listed = crate::platform::git_command()
            .args(["show", "--name-only", "--format=%s", "HEAD"])
            .current_dir(&bare)
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert!(listed.contains("library/knowledge/auth-flow.md"), "{listed}");
        assert!(listed.contains("share \"Auth flow\" with the team"), "{listed}");
    }

    #[test]
    fn publishing_identical_bytes_commits_nothing_and_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let body = "---\nid: a\n---\nbody\n";

        publish_library_change(&clone, &rel, "first", |p| write_entry(p, body), &RealLibraryGit)
            .expect("first publish");
        let again =
            publish_library_change(&clone, &rel, "second", |p| write_entry(p, body), &RealLibraryGit)
                .expect("second publish");
        assert!(!again.committed);
        // Still pushed: `pushed` means "GitHub holds this state", and the
        // no-op push is what makes a retry after a refused one honest.
        assert!(again.pushed);
    }

    #[test]
    fn a_retry_after_a_refused_push_is_a_fresh_write_that_reaches_github() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let body = "---\nid: a\n---\nbody\n";

        struct PushRejected;
        impl LibraryGit for PushRejected {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                dir: &Path,
                rels: &[String],
                msg: &str,
            ) -> Result<bool, String> {
                RealLibraryGit.commit(dir, rels, msg)
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                Err("! [rejected] main -> main (fetch first)".into())
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        // First attempt: push refused, its commit taken back.
        assert!(publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, body),
            &PushRejected
        )
        .is_err());

        // The retry commits again and pushes. (A push stopped at its bound is
        // the one that keeps its commit for the retry to push: see
        // `a_stalled_library_push_is_stopped_at_its_bound…` below.)
        let retry = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, body),
            &RealLibraryGit,
        )
        .expect("retry");
        assert!(retry.committed);
        assert!(retry.pushed);

        let listed = crate::platform::git_command()
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .current_dir(&bare)
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert!(
            listed.contains("library/knowledge/auth-flow.md"),
            "the retry never reached the remote: {listed}"
        );
    }

    #[test]
    fn publish_removes_a_file_and_pushes_the_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect("add");

        let removed = publish_library_change(
            &clone,
            &rel,
            "knowledge: move \"Auth flow\" out of the team library",
            |path| std::fs::remove_file(path).map_err(|e| e.to_string()),
            &RealLibraryGit,
        )
        .expect("remove");
        assert!(removed.committed);
        assert!(removed.pushed);

        let listed = crate::platform::git_command()
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .current_dir(&bare)
            .output()
            .unwrap();
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert!(!listed.contains("auth-flow.md"), "{listed}");
    }

    #[test]
    fn a_write_to_a_diverged_team_repo_stops_as_diverged_and_names_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();

        // A teammate publishes their own entry, and this Mac commits one
        // locally without pulling: the two histories have diverged, so the
        // very next `pull --ff-only` is refused.
        let other = tmp.path().join("teammate");
        git(
            tmp.path(),
            &["clone", &bare.to_string_lossy(), &other.to_string_lossy()],
        );
        git(&other, &["config", "user.name", "Plyloft Test"]);
        git(&other, &["config", "user.email", "test@example.invalid"]);
        write_entry(&other.join("library/knowledge/theirs.md"), "theirs").unwrap();
        git(&other, &["add", "-A"]);
        git(&other, &["commit", "-m", "teammate"]);
        git(&other, &["push"]);

        write_entry(&clone.join("library/knowledge/local.md"), "local").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-m", "local"]);

        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, "mine"),
            &RealLibraryGit,
        )
        .expect_err("diverged repo must conflict");
        // GH #226: ahead and behind is its own kind — it has a way out that a
        // refresh does not give.
        match &error {
            LibraryError::Diverged { path, ahead, behind } => {
                assert_eq!(path, "library/knowledge/auth-flow.md");
                assert_eq!((*ahead, *behind), (1, 1));
            }
            other => panic!("expected a divergence, got {other:?}"),
        }
        assert!(error.message().starts_with(DIVERGED_MARKER), "{}", error.message());
        assert!(error.message().contains("Reapply mine on top"), "{}", error.message());
        assert!(!error.message().contains("Refresh Settings"), "{}", error.message());
        assert!(error.left_the_library_unchanged());
        // A refused pull applied nothing, so nothing is waiting locally.
        // The member must be able to read which file it was out of the toast.
        assert!(error.message().contains("library/knowledge/auth-flow.md"));
        // Nothing was written: the pull is refused before `apply` runs, so
        // a collision check never runs against a stale clone.
        assert!(!clone.join(&rel).exists());
    }

    #[test]
    fn a_push_refused_after_the_pull_conflicts_and_takes_its_commit_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let before = rev(&clone, "HEAD");
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();

        // A teammate winning the race between our pull and our push is real
        // but not reproducible on demand; the injected git makes it exact.
        struct PushRejected;
        impl LibraryGit for PushRejected {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                dir: &Path,
                rels: &[String],
                msg: &str,
            ) -> Result<bool, String> {
                RealLibraryGit.commit(dir, rels, msg)
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                Err("! [rejected] main -> main (fetch first)".into())
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, "mine"),
            &PushRejected,
        )
        .expect_err("a rejected push must conflict");
        assert!(matches!(
            error,
            LibraryError::Conflict {
                stage: ConflictStage::Push,
                ..
            }
        ));
        // Nothing stays half published: the caller undoes its own half.
        assert!(error.left_the_library_unchanged());
        assert!(error.message().contains("library/knowledge/auth-flow.md"));
        assert!(error.message().contains("Nothing reached GitHub"), "{}", error.message());
        assert!(!error.message().contains("reapply"), "{}", error.message());
        assert!(!clone.join(&rel).exists());
        assert_eq!(rev(&clone, "HEAD"), before);
        assert_eq!(uncommitted_paths(&clone).unwrap(), Vec::<String>::new());
    }

    /// Bug 1 of the share proposal, through a real refusal: what GitHub refused
    /// doesn't go out with the next write, which was for something else.
    #[test]
    fn a_refused_push_does_not_ride_along_with_the_next_write() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let given_up = library_relative_path("knowledge/given-up.md").unwrap();
        let next = library_relative_path("knowledge/next.md").unwrap();
        let before = commits_on(&bare);

        install_hook(&bare, "pre-receive", "echo 'no' >&2\nexit 1");
        let refused =
            publish_library_change(&clone, &given_up, "give up", |p| write_entry(p, "mine"), &RealLibraryGit)
                .expect_err("refused");
        assert!(matches!(refused, LibraryError::Conflict { stage: ConflictStage::Push, timed_out: false, .. }));
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"), "the clone isn't ahead");
        assert!(!clone.join(&given_up).exists());
        assert_eq!(uncommitted_paths(&clone).unwrap(), Vec::<String>::new());

        std::fs::remove_file(bare.join("hooks/pre-receive")).unwrap();
        publish_library_change(&clone, &next, "next", |p| write_entry(p, "next"), &RealLibraryGit).unwrap();
        assert!(bare_has(&bare, &next));
        assert!(!bare_has(&bare, &given_up), "the refused change stayed out");
        assert_eq!(commits_on(&bare), before + 1);
        // Promote's fallback after a refusal finds nothing left to drop.
        let tip = rev(&clone, "HEAD");
        assert!(!crate::team_proposal::drop_refused_commit(&clone, &tip).unwrap());
        assert_eq!(rev(&clone, "HEAD"), tip);
    }

    /// A removal GitHub refused puts the file back, and an earlier commit a
    /// stopped push left isn't this write's to take.
    #[test]
    fn a_refused_push_takes_back_only_its_own_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let held = library_relative_path("knowledge/held.md").unwrap();
        publish_library_change(&clone, &held, "add", |p| write_entry(p, "held"), &RealLibraryGit).unwrap();
        commit_file(&clone, "library/knowledge/stopped.md", "stopped", "a push stopped at its bound left this");
        let earlier = rev(&clone, "HEAD");

        install_hook(&bare, "pre-receive", "exit 1");
        let refused = publish_library_change(
            &clone,
            &held,
            "remove",
            |p| std::fs::remove_file(p).map_err(|e| e.to_string()),
            &RealLibraryGit,
        )
        .expect_err("refused");
        assert!(refused.left_the_library_unchanged(), "{refused:?}");
        assert_eq!(std::fs::read_to_string(clone.join(&held)).unwrap(), "held");
        assert_eq!(rev(&clone, "HEAD"), earlier);
        assert_eq!(uncommitted_paths(&clone).unwrap(), Vec::<String>::new());
        // Promote's fallback does drop that earlier one: GitHub refuses it too.
        assert!(crate::team_proposal::drop_refused_commit(&clone, &earlier).unwrap());
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
    }

    /// F1: git's own words. Only GitHub's explicit no takes a commit back.
    #[test]
    fn only_an_explicit_refusal_from_github_means_the_push_did_not_land() {
        for refused in [
            "git push failed: To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:o/r.git'",
            "git push failed: ! [rejected] main -> main (non-fast-forward)",
            "git push failed: ! [remote rejected] main -> main (pre-receive hook declined)",
            "git push failed: remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)",
            "git push failed: remote: Permission to o/r.git denied to u.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
            "git push failed: error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403",
            "git push failed: ERROR: Permission to o/r.git denied to deploy-key.\nfatal: Could not read from remote repository.",
            "git push failed: git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
            "git push failed: fatal: Authentication failed for 'https://github.com/o/r.git/'",
            "git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ] {
            assert!(!push_may_have_landed(&RemoteFailure::Refused(refused.into())), "{refused}");
        }
        for never_connected in [
            "git push failed: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
            "git push failed: fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 75000 ms: Couldn't connect to server",
            "git push failed: ssh: connect to host github.com port 22: Connection refused\nfatal: Could not read from remote repository.",
        ] {
            assert!(!push_may_have_landed(&RemoteFailure::Refused(never_connected.into())), "{never_connected}");
        }
        for unknown in [
            "git push failed: fatal: the remote end hung up unexpectedly\nEverything up-to-date",
            "git push failed: error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly",
            "git push failed: error: RPC failed; curl 56 LibreSSL SSL_read: Connection reset by peer",
            "git push failed: Connection to github.com closed by remote host.",
            // App exit's kill, and Plyloft's own stops.
            "git push was stopped before it finished",
            "git push: Plyloft is quitting",
            "git push: its output was cut short",
            // An unrecognised failure counts as landed.
            "git push failed: ",
        ] {
            assert!(push_may_have_landed(&RemoteFailure::Refused(unknown.into())), "{unknown}");
        }
        let stopped = RemoteFailure::TimedOut { command: "git push", after: std::time::Duration::from_secs(1) };
        assert!(push_may_have_landed(&stopped));
    }

    struct PushFailsWith(&'static str);
    impl LibraryGit for PushFailsWith {
        fn has_remote(&self, dir: &Path) -> Result<bool, String> {
            RealLibraryGit.has_remote(dir)
        }
        fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
            RealLibraryGit.pull(dir)
        }
        fn commit(&self, dir: &Path, rels: &[String], msg: &str) -> Result<bool, String> {
            RealLibraryGit.commit(dir, rels, msg)
        }
        fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
            Err(RemoteFailure::Refused(self.0.to_string()))
        }
        fn restore(&self, dir: &Path, rel: &str, previous: &LibrarySnapshot) -> Result<(), String> {
            RealLibraryGit.restore(dir, rel, previous)
        }
    }

    /// F1: a demote whose connection was lost: the removal may be on GitHub, so
    /// the commit stays and `library_is_provably_unchanged` is false, which is
    /// what makes `knowledge_demote_team` keep the personal copy (the source
    /// check in commands.rs holds it to that question).
    #[test]
    fn a_push_that_lost_its_connection_keeps_its_commit_and_a_demote_keeps_its_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/note.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "note"), &RealLibraryGit).unwrap();
        let before = rev(&clone, "HEAD");

        let published = publish_library_change(
            &clone,
            &rel,
            "move out",
            |p| std::fs::remove_file(p).map_err(|e| e.to_string()),
            &PushFailsWith("git push failed: fatal: the remote end hung up unexpectedly"),
        );
        assert!(!library_is_provably_unchanged(&published), "{published:?}");
        let error = published.unwrap_err();
        assert!(!error.left_the_library_unchanged());
        assert!(matches!(error, LibraryError::Conflict { stage: ConflictStage::Push, timed_out: true, .. }), "{error:?}");
        let message = error.message();
        assert!(message.starts_with(TIMEOUT_MARKER), "{message}");
        assert!(message.contains("may have reached GitHub"), "{message}");
        assert!(message.contains("remote end hung up"), "{message}");
        assert_ne!(rev(&clone, "HEAD"), before, "the commit stays");
        assert!(!clone.join(&rel).exists(), "and so does what it did");
    }

    /// F3: a retry that commits nothing, over a commit an earlier write kept,
    /// then refused: that commit still goes out with the next write, so neither
    /// the words nor the answer may say the library is as it was.
    #[test]
    fn a_refused_retry_over_an_earlier_commit_says_it_is_still_saved() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/kept.md").unwrap();
        let kept = publish_library_change(&clone, &rel, "keep", |p| write_entry(p, "kept"), &PushFailsWith("git push failed: fatal: the remote end hung up unexpectedly"));
        assert!(kept.is_err());
        let earlier = rev(&clone, "HEAD");
        assert_ne!(earlier, rev(&bare, "main"));

        install_hook(&bare, "pre-receive", "exit 1");
        let refused = publish_library_change(&clone, &rel, "keep", |p| write_entry(p, "kept"), &RealLibraryGit)
            .expect_err("refused");
        assert!(matches!(refused, LibraryError::Conflict { timed_out: false, earlier_commit_kept: true, .. }), "{refused:?}");
        assert!(!refused.left_the_library_unchanged());
        let LibraryError::Conflict { detail, .. } = &refused else { unreachable!() };
        assert_eq!(
            refused.message(),
            format!(
                "The team library changed on GitHub while Plyloft was writing {rel}. Your change is saved in the local team clone but not pushed. Refresh Settings › Team › Members and library: if a teammate published meanwhile, it offers to reapply your change on top of theirs. ({detail})"
            )
        );
        assert_eq!(rev(&clone, "HEAD"), earlier);
        assert!(clone.join(&rel).is_file());

        // Nothing earlier in the clone: it is as it was, and says so.
        let (_bare2, clean) = bare_remote_and_clone(&tmp.path().join("other"));
        publish_library_change(&clean, &rel, "add", |p| write_entry(p, "kept"), &RealLibraryGit).unwrap();
        let refused = publish_library_change(&clean, &rel, "same", |p| write_entry(p, "kept"), &PushFailsWith("! [rejected] main -> main (fetch first)"))
            .expect_err("refused");
        assert!(refused.left_the_library_unchanged(), "{refused:?}");
        assert!(refused.message().contains("the team library is as it was"), "{}", refused.message());
    }

    /// A take-back that can't run says so: a caller must not undo its own half
    /// on the strength of "nothing happened".
    #[test]
    fn a_refused_push_whose_commit_cant_be_taken_back_is_abandoned() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/x.md").unwrap();
        struct CantUndo;
        impl LibraryGit for CantUndo {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(&self, dir: &Path, rels: &[String], msg: &str) -> Result<bool, String> {
                RealLibraryGit.commit(dir, rels, msg)
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                Err("! [rejected] main -> main (fetch first)".into())
            }
            fn restore(&self, dir: &Path, rel: &str, previous: &LibrarySnapshot) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
            fn uncommit(&self, _dir: &Path, _commit: &str) -> Result<(), String> {
                Err("the clone moved on".to_string())
            }
        }
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &CantUndo)
            .expect_err("refused");
        assert!(matches!(error, LibraryError::Abandoned { .. }), "{error:?}");
        assert!(!error.left_the_library_unchanged());
        assert!(error.message().contains("GitHub refused the push"), "{}", error.message());
    }

    #[test]
    fn publishing_without_a_clone_is_a_plain_failure_not_a_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let error = publish_library_change(
            &tmp.path().join("never-cloned"),
            "library/knowledge/x.md",
            "share",
            |_| Ok(()),
            &RealLibraryGit,
        )
        .expect_err("no clone");
        assert!(matches!(error, LibraryError::Failed(_)));
        assert!(error.message().contains(&format!("not cloned on {THIS_MACHINE}")));
    }

    #[test]
    fn knowledge_dir_is_the_library_knowledge_subdir_of_the_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let team = TeamStore::new(tmp.path().to_path_buf());
        assert_eq!(
            team.knowledge_dir("MatteoB-adv/ply-team"),
            tmp.path()
                .join("team")
                .join("MatteoB-adv__ply-team")
                .join("library")
                .join("knowledge")
        );
    }
    /// The sequence `knowledge_promote_team` and `knowledge_demote_team`
    /// orchestrate, end to end on disk and in git. Those commands cannot be
    /// driven directly (an `AppHandle` plus `spawn_blocking`), so the exact
    /// order they use is proven here against a real bare remote.
    #[test]
    fn a_share_to_the_team_library_and_its_demote_round_trip_through_git() {
        use crate::memory::{
            publish_shared_entry, remove_project_entry, MemoryStore, NewMemory,
        };
        use ply_memory::{KnowledgeLayer, KnowledgeType, MemoryScope, MemorySource};

        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let config = tmp.path().join("config");
        let store = MemoryStore::new(config).unwrap();

        let entry = store
            .create(NewMemory {
                title: "Auth flow".into(),
                body: "Use the CLI's own session.".into(),
                scope: MemoryScope::Global,
                workspace_id: None,
                tags: vec!["auth".into()],
                linked_cards: vec!["card-1".into()],
                source: MemorySource::Manual,
                entry_type: KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            })
            .unwrap();

        // ── Share: plan, publish through git, then drop the source ──────
        let (planned, text) = store
            .shared_publish_plan(MemoryScope::Global, None, &entry.id)
            .unwrap();
        let relative =
            library_relative_path(&format!("knowledge/{}.md", planned.slug)).unwrap();
        publish_library_change(
            &clone,
            &relative,
            "knowledge: share \"Auth flow\" with the team",
            |path| {
                let dir = path.parent().unwrap();
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                publish_shared_entry(dir, &planned.slug, &text)
            },
            &RealLibraryGit,
        )
        .expect("share");
        store.delete(MemoryScope::Global, None, &entry.id).unwrap();

        assert!(store.list(MemoryScope::Global, None).unwrap().is_empty());
        let in_team = store.list_team(&clone).unwrap();
        assert_eq!(in_team.len(), 1);
        assert_eq!(in_team[0].layer, KnowledgeLayer::Team);
        assert_eq!(in_team[0].id, entry.id);
        assert_eq!(in_team[0].body, entry.body);

        // A teammate cloning the bare repo sees exactly the same entry.
        let teammate = tmp.path().join("teammate");
        git(
            tmp.path(),
            &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()],
        );
        let theirs = store.list_team(&teammate).unwrap();
        assert_eq!(theirs.len(), 1);
        assert_eq!(theirs[0].id, entry.id);

        // ── Demote: remove through git, then adopt back to personal ─────
        let existing = store.team_entry(&clone, &entry.id).unwrap();
        publish_library_change(
            &clone,
            &relative,
            "knowledge: move \"Auth flow\" out of the team library",
            |path| std::fs::remove_file(path).map_err(|e| e.to_string()),
            &RealLibraryGit,
        )
        .expect("demote");
        let adopted = store.adopt_shared_entry(&existing, false).unwrap();

        assert!(store.list_team(&clone).unwrap().is_empty());
        assert_eq!(adopted.scope, MemoryScope::Global);
        assert_eq!(adopted.layer, KnowledgeLayer::Personal);
        // A demote is a move home, so the lesson keeps its card links.
        assert_eq!(adopted.linked_cards, vec!["card-1".to_string()]);
        assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);

        // The removal really reached the remote.
        let listed = crate::platform::git_command()
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .current_dir(&bare)
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&listed.stdout).contains("auth-flow.md"));

        // `remove_project_entry` is the Project → Team promote's second
        // half; it is a no-op when this repo never had the entry.
        let repo = tempfile::tempdir().unwrap();
        remove_project_entry(repo.path(), &planned.slug).unwrap();
    }
    /// A commit that fails after `apply` has already touched the working
    /// tree must leave the clone exactly as it was. Without this, a demote
    /// whose commit failed deleted the entry from the working tree, created
    /// no personal copy, and could not be retried — the lesson was gone
    /// from every layer a member can see.
    #[test]
    fn a_commit_failure_rolls_the_working_tree_back_for_a_removal() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "body"), &RealLibraryGit)
            .expect("seed");

        struct CommitFails;
        impl LibraryGit for CommitFails {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                _dir: &Path,
                _rels: &[String],
                _msg: &str,
            ) -> Result<bool, String> {
                Err("*** Please tell me who you are.".into())
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                unreachable!("a failed commit must never reach the push")
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        let error = publish_library_change(
            &clone,
            &rel,
            "demote",
            |path| std::fs::remove_file(path).map_err(|e| e.to_string()),
            &CommitFails,
        )
        .expect_err("a failed commit is a failure");
        // Not a conflict: the team repo did not move, this clone could not
        // write. The caller must not treat it as "committed locally".
        assert!(matches!(error, LibraryError::Failed(_)));
        assert!(error.message().contains("left unchanged"), "{}", error.message());

        // The entry is back, and the clone is clean.
        assert!(clone.join(&rel).is_file());
        assert_eq!(std::fs::read_to_string(clone.join(&rel)).unwrap(), "body");
        let status = crate::platform::git_command()
            .args(["status", "--porcelain"])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "");
    }

    #[test]
    fn a_commit_failure_rolls_back_a_newly_written_file_too() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/brand-new.md").unwrap();

        struct CommitFails;
        impl LibraryGit for CommitFails {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                _dir: &Path,
                _rels: &[String],
                _msg: &str,
            ) -> Result<bool, String> {
                Err("index.lock exists".into())
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                unreachable!()
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &CommitFails)
            .expect_err("a failed commit is a failure");
        // A path HEAD has never seen cannot be checked out; removing what
        // `apply` created is the rollback.
        assert!(!clone.join(&rel).exists());
        let status = crate::platform::git_command()
            .args(["status", "--porcelain"])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout).trim(), "");
    }

    #[test]
    fn an_apply_failure_rolls_back_and_never_commits() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "body"), &RealLibraryGit)
            .expect("seed");

        // A slug-collision refusal is exactly this shape: `apply` writes
        // nothing and says why. The clone must be untouched afterwards.
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |path| {
                write_entry(path, "half-written").unwrap();
                Err("A shared entry with this slug already exists: auth-flow.".into())
            },
            &RealLibraryGit,
        )
        .expect_err("apply refused");
        assert!(matches!(error, LibraryError::Failed(_)));
        assert!(error.message().contains("slug already exists"));
        assert_eq!(std::fs::read_to_string(clone.join(&rel)).unwrap(), "body");
    }
    /// The Challenger's P1 on snapshot 2: the rollback must put back what
    /// was actually there, not what `HEAD` happens to hold. An untracked
    /// entry — a teammate's file in a clone that has not committed it, or
    /// one dropped in by hand — is invisible to `git checkout HEAD`, so
    /// the previous rollback deleted it outright and turned a refused
    /// write into data loss.
    #[test]
    fn a_refused_write_never_deletes_an_untracked_entry_it_collided_with() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();

        // Untracked: present in the working tree, unknown to HEAD.
        write_entry(&clone.join(&rel), "a teammate's untracked entry").unwrap();

        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |_| {
                Err("A shared entry with this slug already exists: auth-flow. \
                     Rename yours or fork the shared one."
                    .into())
            },
            &RealLibraryGit,
        )
        .expect_err("the collision is refused");
        assert!(error.message().contains("slug already exists"));
        assert_eq!(
            std::fs::read_to_string(clone.join(&rel)).unwrap(),
            "a teammate's untracked entry",
            "a refused write must not delete the entry it refused to overwrite"
        );
    }

    #[test]
    fn a_rollback_restores_local_edits_rather_than_the_committed_version() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "committed"), &RealLibraryGit)
            .expect("seed");
        // Tracked, with an uncommitted local edit on top.
        write_entry(&clone.join(&rel), "edited, not committed").unwrap();

        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| {
                write_entry(p, "half-written").unwrap();
                Err("refused".into())
            },
            &RealLibraryGit,
        )
        .expect_err("apply refused");
        assert!(matches!(error, LibraryError::Failed(_)));
        assert_eq!(
            std::fs::read_to_string(clone.join(&rel)).unwrap(),
            "edited, not committed",
            "the rollback must restore what was there, not what HEAD holds"
        );
    }

    /// The Challenger's P2 on snapshot 2: `removed` is set inside `apply`,
    /// so on a rolled-back commit it says "the removal was attempted", not
    /// "it stuck". Running the demote orchestration for real proves the
    /// team entry survives and no personal copy is minted — twice over, so
    /// a retry cannot accumulate duplicates.
    #[test]
    fn a_demote_whose_commit_fails_changes_nothing_however_often_it_is_retried() {
        use crate::memory::{publish_shared_entry, MemoryStore, NewMemory};
        use ply_memory::{KnowledgeType, MemoryScope, MemorySource};

        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let store = MemoryStore::new(tmp.path().join("config")).unwrap();

        // Seed one entry in the team library and none in the personal layer.
        let seeded = store
            .create(NewMemory {
                title: "Auth flow".into(),
                body: "Use the CLI's own session.".into(),
                scope: MemoryScope::Global,
                workspace_id: None,
                tags: vec![],
                linked_cards: vec![],
                source: MemorySource::Manual,
                entry_type: KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            })
            .unwrap();
        let (planned, text) = store
            .shared_publish_plan(MemoryScope::Global, None, &seeded.id)
            .unwrap();
        let rel = library_relative_path(&format!("knowledge/{}.md", planned.slug)).unwrap();
        publish_library_change(
            &clone,
            &rel,
            "share",
            |path| {
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                publish_shared_entry(path.parent().unwrap(), &planned.slug, &text)
            },
            &RealLibraryGit,
        )
        .expect("seed the team library");
        store.delete(MemoryScope::Global, None, &seeded.id).unwrap();
        assert!(store.list(MemoryScope::Global, None).unwrap().is_empty());

        struct CommitFails;
        impl LibraryGit for CommitFails {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                _dir: &Path,
                _rels: &[String],
                _msg: &str,
            ) -> Result<bool, String> {
                Err("*** Please tell me who you are.".into())
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                unreachable!("a failed commit must never reach the push")
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        // Exactly the sequence `knowledge_demote_team` runs.
        for attempt in 1..=2 {
            let existing = store.team_entry(&clone, &seeded.id).unwrap_or_else(|error| {
                panic!("attempt {attempt}: the team entry must survive ({error})")
            });
            let removed: std::cell::RefCell<Option<ply_memory::Memory>> =
                std::cell::RefCell::new(None);
            let published = publish_library_change(
                &clone,
                &rel,
                "demote",
                |path| {
                    let entry = store.team_entry(&clone, &seeded.id)?;
                    std::fs::remove_file(path).map_err(|e| e.to_string())?;
                    *removed.borrow_mut() = Some(entry);
                    Ok(())
                },
                &CommitFails,
            );
            assert!(published.is_err());
            // `apply` did run and did set `removed` …
            assert!(removed.borrow().is_some());
            // … but the write was rolled back, so nothing is adopted.
            assert!(library_is_provably_unchanged(&published));
            assert_eq!(existing.id, seeded.id);

            assert_eq!(
                store.list_team(&clone).unwrap().len(),
                1,
                "attempt {attempt}: the team entry must be restored"
            );
            assert!(
                store.list(MemoryScope::Global, None).unwrap().is_empty(),
                "attempt {attempt}: a rolled-back demote must mint no personal copy"
            );
        }
    }

    /// The Challenger's P1 on snapshot 3, as the orchestration actually
    /// runs it: the personal copy is written first, and a publish that
    /// rolls back takes it away again. Twice over, because "avoid
    /// duplicates on retry" is the whole point of the undo.
    #[test]
    fn a_demote_secures_the_personal_copy_first_and_undoes_it_when_rolled_back() {
        use crate::memory::{publish_shared_entry, MemoryStore, NewMemory};
        use ply_memory::{KnowledgeType, MemoryScope, MemorySource};

        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let store = MemoryStore::new(tmp.path().join("config")).unwrap();
        let seeded = store
            .create(NewMemory {
                title: "Auth flow".into(),
                body: "Use the CLI's own session.".into(),
                scope: MemoryScope::Global,
                workspace_id: None,
                tags: vec![],
                linked_cards: vec![],
                source: MemorySource::Manual,
                entry_type: KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            })
            .unwrap();
        let (planned, text) = store
            .shared_publish_plan(MemoryScope::Global, None, &seeded.id)
            .unwrap();
        let rel = library_relative_path(&format!("knowledge/{}.md", planned.slug)).unwrap();
        publish_library_change(
            &clone,
            &rel,
            "share",
            |path| {
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                publish_shared_entry(path.parent().unwrap(), &planned.slug, &text)
            },
            &RealLibraryGit,
        )
        .expect("seed the team library");
        store.delete(MemoryScope::Global, None, &seeded.id).unwrap();

        struct CommitFails;
        impl LibraryGit for CommitFails {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                _dir: &Path,
                _rels: &[String],
                _msg: &str,
            ) -> Result<bool, String> {
                Err("*** Please tell me who you are.".into())
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                unreachable!()
            }
            fn restore(
                &self,
                dir: &Path,
                rel: &str,
                previous: &LibrarySnapshot,
            ) -> Result<(), String> {
                RealLibraryGit.restore(dir, rel, previous)
            }
        }

        for attempt in 1..=2 {
            let existing = store.team_entry(&clone, &seeded.id).unwrap_or_else(|error| {
                panic!("attempt {attempt}: the team entry must survive ({error})")
            });
            // Adopt FIRST — the order the command uses.
            let adopted = store.adopt_shared_entry(&existing, false).unwrap();
            assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);

            let published = publish_library_change(
                &clone,
                &rel,
                "demote",
                |path| std::fs::remove_file(path).map_err(|e| e.to_string()),
                &CommitFails,
            );
            assert!(library_is_provably_unchanged(&published));
            store
                .delete(MemoryScope::Global, None, &adopted.id)
                .unwrap();

            assert_eq!(
                store.list_team(&clone).unwrap().len(),
                1,
                "attempt {attempt}: the team entry must be restored"
            );
            assert!(
                store.list(MemoryScope::Global, None).unwrap().is_empty(),
                "attempt {attempt}: the duplicate must be undone"
            );
        }

        // And the successful demote keeps the copy it secured.
        let existing = store.team_entry(&clone, &seeded.id).unwrap();
        let adopted = store.adopt_shared_entry(&existing, false).unwrap();
        let published = publish_library_change(
            &clone,
            &rel,
            "demote",
            |path| std::fs::remove_file(path).map_err(|e| e.to_string()),
            &RealLibraryGit,
        );
        assert!(!library_is_provably_unchanged(&published));
        assert!(store.list_team(&clone).unwrap().is_empty());
        assert_eq!(
            store.list(MemoryScope::Global, None).unwrap()[0].id,
            adopted.id
        );
    }

    #[test]
    fn only_a_provably_untouched_library_lets_a_caller_undo_its_local_work() {
        let outcome = LibraryOutcome {
            path: PathBuf::from("/x"),
            relative_path: "library/knowledge/x.md".into(),
            committed: true,
            pushed: true,
        };
        // The write landed: the caller's local half stands.
        assert!(!library_is_provably_unchanged(&Ok(outcome)));
        // A push stopped at its bound: it may have landed, so it stands.
        assert!(!library_is_provably_unchanged(&Err(LibraryError::Conflict {
            stage: ConflictStage::Push,
            path: "library/knowledge/x.md".into(),
            detail: "stopped".into(),
            timed_out: true,
            earlier_commit_kept: false,
        })));
        // A push GitHub refused took its commit back.
        assert!(library_is_provably_unchanged(&Err(LibraryError::Conflict {
            stage: ConflictStage::Push,
            path: "library/knowledge/x.md".into(),
            detail: "rejected".into(),
            timed_out: false,
            earlier_commit_kept: false,
        })));
        // The pull was refused before anything ran.
        assert!(library_is_provably_unchanged(&Err(LibraryError::Conflict {
            stage: ConflictStage::Pull,
            path: "library/knowledge/x.md".into(),
            detail: "diverged".into(),
            timed_out: false,
            earlier_commit_kept: false,
        })));
        // GH #224: a push stopped at its bound may have landed; a fetch
        // stopped at its bound ran before `apply`, so nothing was written.
        assert!(!library_is_provably_unchanged(&Err(LibraryError::Conflict {
            stage: ConflictStage::Push,
            path: "library/knowledge/x.md".into(),
            detail: "stopped".into(),
            timed_out: true,
            earlier_commit_kept: false,
        })));
        assert!(library_is_provably_unchanged(&Err(LibraryError::Conflict {
            stage: ConflictStage::Pull,
            path: "library/knowledge/x.md".into(),
            detail: "stopped".into(),
            timed_out: true,
            earlier_commit_kept: false,
        })));
        // A failure whose rollback was confirmed.
        assert!(library_is_provably_unchanged(&Err(LibraryError::Failed(
            "no identity".into()
        ))));
        // A rollback that itself failed proves nothing, so the caller keeps
        // its copy — that copy may be all that is left of the entry.
        assert!(!library_is_provably_unchanged(&Err(LibraryError::Abandoned {
            path: "library/knowledge/x.md".into(),
            detail: "no identity, and the undo failed".into(),
        })));
    }
    /// Seed one entry in the team library and return its repo-relative path.
    fn seeded_team_entry(
        clone: &Path,
        store: &crate::memory::MemoryStore,
        title: &str,
        body: &str,
    ) -> (String, String) {
        use crate::memory::{publish_shared_entry, NewMemory};
        use ply_memory::{KnowledgeType, MemoryScope, MemorySource};

        let seeded = store
            .create(NewMemory {
                title: title.into(),
                body: body.into(),
                scope: MemoryScope::Global,
                workspace_id: None,
                tags: vec![],
                linked_cards: vec![],
                source: MemorySource::Manual,
                entry_type: KnowledgeType::Note,
                system_prompt: None,
                prompt_template: None,
                evidence: None,
            })
            .unwrap();
        let (planned, text) = store
            .shared_publish_plan(MemoryScope::Global, None, &seeded.id)
            .unwrap();
        let rel = library_relative_path(&format!("knowledge/{}.md", planned.slug)).unwrap();
        publish_library_change(
            clone,
            &rel,
            "share",
            |path| {
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                publish_shared_entry(path.parent().unwrap(), &planned.slug, &text)
            },
            &RealLibraryGit,
        )
        .expect("seed the team library");
        store.delete(MemoryScope::Global, None, &seeded.id).unwrap();
        (seeded.id, rel)
    }

    /// The Challenger's P1 on snapshot 4: a teammate's edit can land in the
    /// pull `publish` does, after the caller has already read the entry.
    /// Reading and copying *inside* the post-pull mutation is what stops
    /// the demote keeping the stale text and deleting the fresh one.
    #[test]
    fn a_demote_keeps_the_text_the_pull_brought_not_the_one_it_read_first() {
        use ply_memory::MemoryScope;

        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let store = crate::memory::MemoryStore::new(tmp.path().join("config")).unwrap();
        let (id, rel) = seeded_team_entry(&clone, &store, "Auth flow", "the original body");

        // What the command reads before `publish` pulls.
        let stale = store.team_entry(&clone, &id).unwrap();
        assert_eq!(stale.body, "the original body");

        // A teammate edits the same entry and pushes, between the two reads.
        let teammate = tmp.path().join("teammate");
        git(
            tmp.path(),
            &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()],
        );
        git(&teammate, &["config", "user.name", "Plyloft Test"]);
        git(&teammate, &["config", "user.email", "test@example.invalid"]);
        let mut edited = store.team_entry(&teammate, &id).unwrap();
        edited.body = "the teammate's newer body".into();
        std::fs::write(
            teammate.join(&rel),
            crate::memory::encode_memory_entry(&edited).unwrap(),
        )
        .unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "teammate edit"]);
        git(&teammate, &["push"]);

        // Exactly the demote's mutation: read, copy, remove — all post-pull.
        let adopted: std::cell::RefCell<Option<ply_memory::Memory>> =
            std::cell::RefCell::new(None);
        publish_library_change(
            &clone,
            &rel,
            "demote",
            |path| {
                let entry = store.team_entry(&clone, &id)?;
                *adopted.borrow_mut() = Some(store.adopt_shared_entry(&entry, false)?);
                std::fs::remove_file(path).map_err(|e| e.to_string())
            },
            &RealLibraryGit,
        )
        .expect("demote");

        let kept = adopted.into_inner().expect("a copy was made");
        assert_eq!(
            kept.body, "the teammate's newer body",
            "the copy must be what the pull brought, not what was read before it"
        );
        assert_eq!(
            store.list(MemoryScope::Global, None).unwrap()[0].body,
            "the teammate's newer body"
        );
        assert!(store.list_team(&clone).unwrap().is_empty());
    }

    /// The Challenger's P1 on snapshot 4: when the commit fails *and* the
    /// rollback fails, the entry may be gone from the library. Reporting
    /// that as "unchanged" would have the caller delete the copy it just
    /// made — the lesson would then exist in no layer at all.
    #[test]
    fn a_removal_whose_commit_and_rollback_both_fail_keeps_the_personal_copy() {
        use ply_memory::MemoryScope;

        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let store = crate::memory::MemoryStore::new(tmp.path().join("config")).unwrap();
        let (id, rel) = seeded_team_entry(&clone, &store, "Auth flow", "body");

        struct CommitAndRestoreFail;
        impl LibraryGit for CommitAndRestoreFail {
            fn has_remote(&self, dir: &Path) -> Result<bool, String> {
                RealLibraryGit.has_remote(dir)
            }
            fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
                RealLibraryGit.pull(dir)
            }
            fn commit(
                &self,
                _dir: &Path,
                _rels: &[String],
                _msg: &str,
            ) -> Result<bool, String> {
                Err("*** Please tell me who you are.".into())
            }
            fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
                unreachable!()
            }
            fn restore(
                &self,
                _dir: &Path,
                _rel: &str,
                _prev: &LibrarySnapshot,
            ) -> Result<(), String> {
                Err("read-only file system".into())
            }
        }

        let adopted: std::cell::RefCell<Option<ply_memory::Memory>> =
            std::cell::RefCell::new(None);
        let published = publish_library_change(
            &clone,
            &rel,
            "demote",
            |path| {
                let entry = store.team_entry(&clone, &id)?;
                *adopted.borrow_mut() = Some(store.adopt_shared_entry(&entry, false)?);
                std::fs::remove_file(path).map_err(|e| e.to_string())
            },
            &CommitAndRestoreFail,
        );

        let error = published.as_ref().expect_err("the commit failed");
        assert!(matches!(error, LibraryError::Abandoned { .. }));
        // The decisive bit: not provably unchanged, so the caller keeps the
        // copy instead of deleting it.
        assert!(!library_is_provably_unchanged(&published));
        assert!(error.message().contains("may now be missing"));
        assert!(error.message().contains("Nothing was removed from your personal Knowledge"));

        // The team file really is gone (the restore failed), which is
        // exactly why the personal copy must stand.
        assert!(store.list_team(&clone).unwrap().is_empty());
        assert!(adopted.into_inner().is_some());
        assert_eq!(store.list(MemoryScope::Global, None).unwrap().len(), 1);
    }

    /// GH #208: a temp a crashed write left in the team clone is never an
    /// untracked file there, and the team's own `.gitignore` is not touched.
    #[test]
    fn a_stranded_atomic_temp_never_shows_as_untracked_in_the_team_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        publish_library_change(&clone, &rel, "add", |p| write_entry(p, "body"), &RealLibraryGit)
            .expect("publish");
        // A second publish must not add the rule twice.
        publish_library_change(&clone, &rel, "edit", |p| write_entry(p, "body 2"), &RealLibraryGit)
            .expect("publish again");
        let knowledge = clone.join("library").join("knowledge");
        std::fs::write(knowledge.join("auth-flow.md.a1b2c3.atelier-tmp"), "half").unwrap();
        std::fs::write(knowledge.join("other.md.atelier-tmp"), "half").unwrap();
        let status = crate::platform::git_command()
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(&clone)
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(!status.contains("atelier-tmp"), "{status}");
        assert!(!clone.join(".gitignore").exists(), "the team's .gitignore is not Plyloft's to write");
        let exclude = std::fs::read_to_string(clone.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == TEMP_EXCLUDE_RULE).count(), 1);
    }

    // ── GH #224: the library's network git is bounded ──────────────────

    /// The real library git with its bounds and exit registry injected, so a
    /// stalled remote is stopped in a test-sized time. Everything but the
    /// fetch and the push is the production [`RealLibraryGit`].
    struct BoundedGit<'a> {
        fetch: std::time::Duration,
        push: std::time::Duration,
        registry: &'a crate::worktrees::FetchRegistry,
    }

    impl LibraryGit for BoundedGit<'_> {
        fn has_remote(&self, dir: &Path) -> Result<bool, String> {
            RealLibraryGit.has_remote(dir)
        }
        fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
            library_pull_in(dir, self.fetch, self.registry)
        }
        fn commit(&self, dir: &Path, rels: &[String], msg: &str) -> Result<bool, String> {
            RealLibraryGit.commit(dir, rels, msg)
        }
        fn push(&self, dir: &Path) -> Result<(), RemoteFailure> {
            library_push_in(dir, self.push, self.registry)
        }
        fn restore(&self, dir: &Path, rel: &str, previous: &LibrarySnapshot) -> Result<(), String> {
            RealLibraryGit.restore(dir, rel, previous)
        }
    }

    fn test_registry() -> crate::worktrees::FetchRegistry {
        crate::worktrees::FetchRegistry::refusing_with("Plyloft is quitting (test)")
    }

    fn rev(dir: &Path, rev: &str) -> String {
        let out = crate::platform::git_command()
            .args(["rev-parse", rev])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// 1.176.2 (A5R-12): the plain push ignores the person's `push.default`:
    /// `nothing` doesn't refuse it, and `matching` doesn't carry another local
    /// branch along — only the clone's branch goes, to its own name.
    #[test]
    fn the_library_push_ignores_the_persons_push_default() {
        let root = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(root.path());
        // A second branch on both sides, moved on locally only.
        git(&clone, &["branch", "side"]);
        git(&clone, &["push", "--quiet", "origin", "side"]);
        let side_on_github = rev(&bare, "side");
        git(&clone, &["checkout", "--quiet", "side"]);
        std::fs::write(clone.join("side.txt"), b"side").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "--quiet", "-m", "side"]);
        git(&clone, &["checkout", "--quiet", "main"]);

        for default in ["nothing", "matching"] {
            git(&clone, &["config", "push.default", default]);
            let file = format!("library/knowledge/{default}.md");
            std::fs::write(clone.join(&file), default).unwrap();
            git(&clone, &["add", "-A"]);
            git(&clone, &["commit", "--quiet", "-m", default]);
            let registry = test_registry();
            library_push_in(&clone, std::time::Duration::from_secs(20), &registry)
                .unwrap_or_else(|e| panic!("push.default={default}: {e:?}"));
            assert_eq!(rev(&bare, "main"), rev(&clone, "main"), "push.default={default}");
            assert_eq!(rev(&bare, "side"), side_on_github, "push.default={default}: only main is pushed");
        }
    }

    fn bare_has(bare: &Path, rel: &str) -> bool {
        let out = crate::platform::git_command()
            .args(["ls-tree", "-r", "--name-only", "main"])
            .current_dir(bare)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().any(|l| l == rel)
    }

    fn commits_on(bare: &Path) -> usize {
        let out = crate::platform::git_command()
            .args(["rev-list", "--count", "main"])
            .current_dir(bare)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
    }

    // ── H4 Challenger step 13: a push git couldn't sign in for ─────────

    fn porcelain(dir: &Path) -> String {
        let out = crate::platform::git_command()
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// The real git, except the network: a push (or a pull) refused with
    /// `words`, as git says it on a machine with no GitHub sign-in.
    struct SignedOut {
        words: &'static str,
        pull_too: bool,
    }

    impl LibraryGit for SignedOut {
        fn has_remote(&self, dir: &Path) -> Result<bool, String> {
            RealLibraryGit.has_remote(dir)
        }
        fn pull(&self, dir: &Path) -> Result<(), RemoteFailure> {
            if self.pull_too {
                return Err(RemoteFailure::Refused(format!("git fetch failed: {}", self.words)));
            }
            RealLibraryGit.pull(dir)
        }
        fn commit(&self, dir: &Path, rels: &[String], msg: &str) -> Result<bool, String> {
            RealLibraryGit.commit(dir, rels, msg)
        }
        fn push(&self, _dir: &Path) -> Result<(), RemoteFailure> {
            Err(RemoteFailure::Refused(format!("git push failed: {}", self.words)))
        }
        fn restore(&self, dir: &Path, rel: &str, previous: &LibrarySnapshot) -> Result<(), String> {
            RealLibraryGit.restore(dir, rel, previous)
        }
    }

    /// Git's words for "no sign-in", on a Mac and on Windows (Git Credential
    /// Manager), and GitHub's for a credential it refuses.
    const SIGNED_OUT_WORDS: [&str; 4] = [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "fatal: could not read Username for 'https://github.com': Device not configured",
        "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/team.git/'",
    ];

    fn assert_signed_out_words(message: &str, what: &str) {
        assert!(
            message.starts_with(&format!(
                "Plyloft couldn't update {what} in the team library: {SIGN_IN_MARKER}{THIS_MACHINE}"
            )),
            "{message}"
        );
        assert!(message.contains("so the push was refused"), "{message}");
        assert!(message.contains("Nothing reached GitHub and the team library is as it was."), "{message}");
        assert!(message.ends_with("Sign in to GitHub in Settings › Team › Members and library, then try again."), "{message}");
        assert!(!message.contains("changed on GitHub"), "nobody published: {message}");
        assert!(!message.contains("Reapply") && !message.contains("reapply"), "{message}");
        assert!(!message.contains("fatal:") && !message.contains("terminal prompts"), "git's words stay in the log: {message}");
    }

    /// H4 Challenger step 13: a push git couldn't sign in for is not "the
    /// team library changed on GitHub". The library write takes its own
    /// commit back and puts the targets back, so the clone is not left ahead
    /// (Settings › Team offers no Reapply) — on Mac and Windows words alike.
    #[test]
    fn a_push_git_could_not_sign_in_for_takes_its_commit_back() {
        for words in SIGNED_OUT_WORDS {
            let tmp = tempfile::tempdir().unwrap();
            let (bare, clone) = bare_remote_and_clone(tmp.path());
            let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
            let head = rev(&clone, "HEAD");
            let error = publish_library_change(
                &clone,
                &rel,
                "share",
                |p| write_entry(p, "mine"),
                &SignedOut { words, pull_too: false },
            )
            .expect_err("a push with no sign-in fails");
            match &error {
                LibraryError::SignIn { stage: ConflictStage::Push, path, ssh: false, detail } => {
                    assert_eq!(path, &rel);
                    assert!(detail.contains("git push failed"), "{detail}");
                }
                other => panic!("{words}: expected a sign-in refusal, got {other:?}"),
            }
            assert_signed_out_words(&error.message(), &rel);
            assert!(error.left_the_library_unchanged());
            // Exactly as before: no commit ahead, nothing staged or left over.
            assert_eq!(rev(&clone, "HEAD"), head, "{words}");
            assert_eq!(ahead_behind(&clone).unwrap(), (0, 0), "{words}");
            assert_eq!(porcelain(&clone), "", "{words}");
            assert!(!clone.join(&rel).exists(), "{words}");
            assert_eq!(rev(&bare, "main"), head);
        }
    }

    /// The same for a Replace: what the library held before is put back, and
    /// an earlier unpublished commit (not this write's) is left alone.
    #[test]
    fn a_replace_git_could_not_sign_in_for_puts_the_old_copy_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        write_entry(&clone.join(&rel), "theirs").unwrap();
        git(&clone, &["add", "--", &rel]);
        git(&clone, &["commit", "-q", "-m", "an earlier share whose push never landed"]);
        let head = rev(&clone, "HEAD");
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, "mine"),
            &SignedOut { words: SIGNED_OUT_WORDS[0], pull_too: false },
        )
        .expect_err("refused");
        assert!(matches!(error, LibraryError::SignIn { stage: ConflictStage::Push, .. }), "{error:?}");
        assert_eq!(rev(&clone, "HEAD"), head, "only this write's commit goes");
        assert_eq!(std::fs::read_to_string(clone.join(&rel)).unwrap(), "theirs");
        assert_eq!(porcelain(&clone), "");
    }

    /// Git over SSH: the key, not the GitHub sign-in, is what to fix.
    #[test]
    fn a_push_ssh_could_not_sign_in_for_names_the_ssh_key() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let head = rev(&clone, "HEAD");
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| write_entry(p, "mine"),
            &SignedOut {
                words: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
                pull_too: false,
            },
        )
        .expect_err("refused");
        assert!(matches!(error, LibraryError::SignIn { ssh: true, .. }), "{error:?}");
        let message = error.message();
        assert!(message.contains("Git couldn't sign in to GitHub over SSH"), "{message}");
        assert!(!message.contains(SIGN_IN_MARKER), "no Sign in to GitHub for an SSH key: {message}");
        assert!(message.contains("Check your SSH key"), "{message}");
        assert_eq!(rev(&clone, "HEAD"), head);
        assert_eq!(porcelain(&clone), "");
    }

    /// A pull git couldn't sign in for: nothing ran, said as the sign-in.
    #[test]
    fn a_pull_git_could_not_sign_in_for_writes_nothing_and_says_so() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let applied = std::cell::Cell::new(false);
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| {
                applied.set(true);
                write_entry(p, "mine")
            },
            &SignedOut { words: SIGNED_OUT_WORDS[2], pull_too: true },
        )
        .expect_err("refused");
        assert!(matches!(error, LibraryError::SignIn { stage: ConflictStage::Pull, .. }), "{error:?}");
        assert!(!applied.get());
        let message = error.message();
        assert!(message.contains(&format!("{SIGN_IN_MARKER}{THIS_MACHINE}")), "{message}");
        assert!(!message.contains("changed on GitHub"), "{message}");
        assert!(error.left_the_library_unchanged());
    }

    /// The real push, refused by the remote in git's sign-in words (a
    /// pre-receive hook stands in for GitHub's credential check): sorted and
    /// rolled back through the production network runner too.
    #[test]
    fn a_real_push_refused_for_sign_in_leaves_the_clone_as_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        install_hook(
            &bare,
            "pre-receive",
            "echo \"fatal: Authentication failed for 'https://github.com/acme/team.git/'\" >&2\nexit 1",
        );
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let head = rev(&clone, "HEAD");
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            push: std::time::Duration::from_secs(20),
            registry: &registry,
        };
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &git)
            .expect_err("refused");
        assert!(matches!(error, LibraryError::SignIn { stage: ConflictStage::Push, .. }), "{error:?}");
        assert_eq!(rev(&clone, "HEAD"), head);
        assert_eq!(ahead_behind(&clone).unwrap(), (0, 0));
        assert_eq!(porcelain(&clone), "");
        assert!(!bare_has(&bare, &rel));
    }

    /// Challenger (H4 step 13): with the team's account recorded and not
    /// signed in, Plyloft's account scope refuses to start git at all — its
    /// own words, not git's. That is the same missing sign-in, at the pull
    /// (nothing written) or at the push (taken back), never "the team
    /// library changed on GitHub".
    #[test]
    fn the_account_scopes_refusal_is_a_sign_in_too() {
        let words: &'static str = "git fetch: Your team uses the GitHub account ana, which isn't signed in on this PC. \
            Sign it in in Setup's GitHub step, or leave the team and join it again with another account.";
        assert_eq!(sign_in_cause(words), Some(false));
        assert_eq!(sign_in_cause("The GitHub CLI gave no sign-in for ana. Sign it in again in Setup's GitHub step."), Some(false));
        assert_eq!(sign_in_cause("fatal: unable to access: Could not resolve host: github.com"), None);
        assert_eq!(sign_in_cause("! [rejected] main -> main (fetch first)"), None);
        for pull_too in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let (_bare, clone) = bare_remote_and_clone(tmp.path());
            let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
            let head = rev(&clone, "HEAD");
            let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &SignedOut { words, pull_too })
                .expect_err("refused");
            let stage = if pull_too { ConflictStage::Pull } else { ConflictStage::Push };
            assert!(matches!(&error, LibraryError::SignIn { stage: s, ssh: false, .. } if *s == stage), "{error:?}");
            assert!(!error.message().contains("changed on GitHub"), "{}", error.message());
            assert!(error.message().contains(SIGN_IN_MARKER), "{}", error.message());
            assert_eq!(rev(&clone, "HEAD"), head);
            assert_eq!(porcelain(&clone), "");
        }
    }

    /// Challenger (H4 step 13): the invite's git keeps the clone's lock
    /// through the rollback of a push git couldn't sign in for — another
    /// write committing between the uncommit and the restore would be
    /// tangled with it — and lets it go once the rollback is over.
    #[test]
    fn the_invites_git_holds_the_lock_through_a_sign_in_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        install_hook(
            &bare,
            "pre-receive",
            "echo \"fatal: Authentication failed for 'https://github.com/acme/team.git/'\" >&2\nexit 1",
        );
        let store = TeamStore::new(tmp.path().join("config"));
        let locked = store.git_until_pushed();
        assert!(locked.push(&clone).is_ok(), "nothing to push yet");
        let locked = store.git_until_pushed();
        write_entry(&clone.join("library/knowledge/x.md"), "x").unwrap();
        git(&clone, &["add", "--", "library/knowledge/x.md"]);
        git(&clone, &["commit", "-q", "-m", "x"]);
        assert!(locked.push(&clone).is_err());
        assert!(store.git_lock.try_lock().is_none(), "kept for the rollback");
        locked.rolled_back();
        assert!(store.git_lock.try_lock().is_some(), "released once it is over");
        git(&clone, &["reset", "-q", "--hard", "HEAD^"]);

        let locked = store.git_until_pushed();
        let head = rev(&clone, "HEAD");
        let error = publish_library_change(
            &clone,
            &library_relative_path("knowledge/y.md").unwrap(),
            "share",
            |p| write_entry(p, "y"),
            &locked,
        )
        .expect_err("refused");
        assert!(matches!(error, LibraryError::SignIn { .. }), "{error:?}");
        assert!(store.git_lock.try_lock().is_some(), "released after the rollback");
        assert_eq!(rev(&clone, "HEAD"), head);
        assert_eq!(porcelain(&clone), "");
    }

    fn install_hook(bare: &Path, name: &str, body: &str) {
        let hook = bare.join("hooks").join(name);
        std::fs::write(&hook, format!("#!/bin/sh\n{body}\n")).unwrap();
        crate::platform::set_mode(&hook, 0o755).unwrap();
    }

    /// A fetch from a local-path remote runs `uploadpack` through the shell;
    /// the trailing `#` swallows the path, so it never answers.
    fn stall_fetch(clone: &Path, marker: &Path, started: Option<&Path>) {
        let started = started
            .map(|p| format!("touch '{}' && ", p.display()))
            .unwrap_or_default();
        let uploadpack = format!("{started}sleep 2 && touch '{}' #", marker.display());
        git(clone, &["config", "remote.origin.uploadpack", &uploadpack]);
    }

    /// Skills hub H2 (Hard rule 4): a background pull hung on the remote is
    /// killed with the other bounded git children at exit — the call returns
    /// at once, the clone is as it was, and nothing it started survives.
    #[test]
    fn a_hung_pull_is_killed_at_exit_with_its_children() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let marker = tmp.path().join("orphan-survived");
        let started = tmp.path().join("fetch-started");
        stall_fetch(&clone, &marker, Some(&started));
        let head = rev(&clone, "HEAD");
        let registry: &'static crate::worktrees::FetchRegistry = Box::leak(Box::new(test_registry()));
        let dir = clone.clone();
        let pull = std::thread::spawn(move || {
            library_pull_in(&dir, std::time::Duration::from_secs(60), registry)
        });
        let wait = std::time::Instant::now();
        while !started.exists() && wait.elapsed() < std::time::Duration::from_secs(10) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(started.exists(), "the fetch never started");
        let quit = std::time::Instant::now();
        assert!(registry.shutdown() >= 1, "the pull was in the registry");
        let error = pull.join().unwrap().expect_err("a killed pull fails");
        assert!(quit.elapsed() < std::time::Duration::from_secs(2), "{:?}", quit.elapsed());
        assert!(!error.timed_out(), "killed at exit, not at its bound: {error:?}");
        assert_eq!(rev(&clone, "HEAD"), head);
        assert!(!clone.join(".git/index.lock").exists());
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(!marker.exists(), "the fetch's child process outlived the exit");
        // And nothing new starts afterwards.
        assert!(library_pull_in(&clone, std::time::Duration::from_secs(5), registry).is_err());
    }

    #[test]
    fn a_stalled_library_fetch_is_stopped_at_its_bound_with_its_children_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let marker = tmp.path().join("orphan-survived");
        stall_fetch(&clone, &marker, None);
        let head = rev(&clone, "HEAD");
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_millis(300),
            push: std::time::Duration::from_secs(20),
            registry: &registry,
        };

        let applied = std::cell::Cell::new(false);
        let started = std::time::Instant::now();
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| {
                applied.set(true);
                write_entry(p, "mine")
            },
            &git,
        )
        .expect_err("a stalled fetch must fail");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "stopped at the bound, not after the remote: {:?}",
            started.elapsed()
        );
        match &error {
            LibraryError::Conflict {
                stage: ConflictStage::Pull,
                timed_out: true,
                path,
                ..
            } => assert_eq!(path, &rel),
            other => panic!("expected a timed-out pull, got {other:?}"),
        }
        let message = error.message();
        assert!(message.contains("didn't answer in time"), "{message}");
        assert!(message.contains("`git fetch` was stopped after 300ms"), "{message}");
        assert!(message.contains("Nothing was written"), "{message}");
        assert!(!message.contains("changed on GitHub"), "not a divergence: {message}");
        assert!(message.starts_with(TIMEOUT_MARKER), "{message}");
        assert_eq!(message.matches("didn't answer in time").count(), 1, "{message}");
        // State: nothing applied, the clone exactly as it was, no lock left.
        assert!(!applied.get());
        assert!(error.left_the_library_unchanged());
        assert!(!clone.join(&rel).exists());
        assert_eq!(rev(&clone, "HEAD"), head);
        assert!(!clone.join(".git/index.lock").exists());
        // Its whole process group went with it.
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(!marker.exists(), "the fetch's child process outlived its bound");
    }

    #[test]
    fn a_stalled_library_push_is_stopped_at_its_bound_keeps_the_commit_and_a_retry_pushes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let marker = tmp.path().join("orphan-survived");
        install_hook(
            &bare,
            "pre-receive",
            &format!("sleep 3\ntouch '{}'", marker.display()),
        );
        let before = commits_on(&bare);
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            push: std::time::Duration::from_millis(500),
            registry: &registry,
        };

        let started = std::time::Instant::now();
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &git)
            .expect_err("a stalled push must fail");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(2500),
            "{:?}",
            started.elapsed()
        );
        assert!(
            matches!(
                error,
                LibraryError::Conflict {
                    stage: ConflictStage::Push,
                    timed_out: true,
                    ..
                }
            ),
            "{error:?}"
        );
        let message = error.message();
        assert!(message.contains("`git push` was stopped after 500ms"), "{message}");
        assert!(message.contains("may have reached GitHub"), "{message}");
        // A refresh shows the local clone, which cannot tell; and a retry
        // after a teammate's publish is refused, which the copy must not hide.
        assert!(!message.contains("Refresh Settings"), "{message}");
        assert!(message.contains("unless a teammate published meanwhile"), "{message}");
        assert!(message.starts_with(TIMEOUT_MARKER), "{message}");
        assert_eq!(message.matches("didn't answer in time").count(), 1, "{message}");
        assert!(message.contains(&rel), "{message}");
        // The rollback does not run after the commit: the change is kept,
        // committed, and the caller must not undo its own half.
        assert!(!error.left_the_library_unchanged());
        assert!(clone.join(&rel).is_file());
        assert_ne!(rev(&clone, "HEAD"), rev(&bare, "main"));
        // The hook was killed before the ref moved: nothing landed.
        assert!(!bare_has(&bare, &rel));
        assert_eq!(commits_on(&bare), before);
        std::thread::sleep(std::time::Duration::from_millis(3500));
        assert!(!marker.exists(), "the push's hook outlived its bound");

        // Retry once the remote answers: the kept commit is pushed, once. The
        // retry's bound is not what's under test — a plain push can take more
        // than 500 ms on a busy Windows runner.
        std::fs::remove_file(bare.join("hooks/pre-receive")).unwrap();
        let retry_git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            push: std::time::Duration::from_secs(20),
            registry: &registry,
        };
        let outcome = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &retry_git)
            .expect("the retry pushes the pending commit");
        assert!(!outcome.committed, "identical bytes: nothing new to commit");
        assert!(outcome.pushed);
        assert!(bare_has(&bare, &rel));
        assert_eq!(commits_on(&bare), before + 1);
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
    }

    /// The ambiguous case the message warns about: GitHub took the push, but
    /// the answer never came back before the bound. No rollback runs after
    /// the commit, so nothing that landed is undone locally, and a retry
    /// finds the clone already in step — no second commit, no conflict.
    #[cfg(unix)] // execs a `/bin/sh` stub directly
    #[test]
    fn a_push_that_landed_before_its_bound_stopped_it_is_kept_and_a_retry_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        // post-receive runs after the ref moved; the client waits for it.
        // The marker proves the ref moved before the bound, however slow the
        // machine; the sleep is far past the bound either way.
        let landed = tmp.path().join("landed");
        install_hook(
            &bare,
            "post-receive",
            &format!(
                "[ -n \"$PLY_TEST_PREWARM\" ] && exit 0\ntouch '{}'\nsleep 30",
                landed.display()
            ),
        );
        // GH #234, the #147 pre-warm: exec the fresh hook once and wait for
        // it, with no deadline. macOS assesses a new executable on its first
        // exec (5-12 s measured beside other test runs); inside the push that
        // ate the 5 s bound before post-receive ever ran. ETXTBSY (Linux:
        // another test's fork holding the new file) is retried.
        loop {
            match crate::platform::new_command(bare.join("hooks/post-receive"))
                .env("PLY_TEST_PREWARM", "1")
                .stdin(std::process::Stdio::null())
                .status()
            {
                Ok(status) => {
                    assert!(status.success(), "test setup failure: hook pre-warm: {status}");
                    break;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("test setup failure: hook pre-warm: {e}"),
            }
        }
        assert!(!landed.exists(), "the pre-warm is not the push");
        let before = commits_on(&bare);
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            // Generous for a loaded run; the hook holds the push 30 s.
            push: std::time::Duration::from_secs(10),
            registry: &registry,
        };

        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &git)
            .expect_err("the push never confirmed");
        assert!(landed.exists(), "post-receive ran: the push landed before the bound");
        assert!(
            matches!(
                error,
                LibraryError::Conflict {
                    stage: ConflictStage::Push,
                    timed_out: true,
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(error.message().contains("may have reached GitHub"));
        // It did land, and the clone still holds the very same commit.
        assert!(bare_has(&bare, &rel));
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
        assert!(clone.join(&rel).is_file());

        std::fs::remove_file(bare.join("hooks/post-receive")).unwrap();
        let outcome = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &git)
            .expect("a retry after a landed push");
        assert!(!outcome.committed);
        assert!(outcome.pushed);
        assert_eq!(commits_on(&bare), before + 1, "no duplicate commit");
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
    }

    /// Review 1: `pull --ff-only` fails when the upstream branch is gone on
    /// GitHub (renamed or deleted). The split fetch + merge must too — a
    /// stale `origin/main` accepted by the merge would let the write commit
    /// and the push resurrect `main` where no teammate looks.
    #[test]
    fn a_write_after_the_upstream_branch_was_renamed_stops_at_the_pull() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        git(&bare, &["branch", "-m", "main", "trunk"]);
        git(&bare, &["symbolic-ref", "HEAD", "refs/heads/trunk"]);
        let head = rev(&clone, "HEAD");
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();

        let applied = std::cell::Cell::new(false);
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| {
                applied.set(true);
                write_entry(p, "mine")
            },
            &RealLibraryGit,
        )
        .expect_err("a gone upstream must stop the write");
        assert!(
            matches!(
                error,
                LibraryError::Conflict {
                    stage: ConflictStage::Pull,
                    timed_out: false,
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(!applied.get());
        assert!(!clone.join(&rel).exists());
        assert_eq!(rev(&clone, "HEAD"), head);
        let heads = crate::platform::git_command()
            .args(["for-each-ref", "--format=%(refname)", "refs/heads"])
            .current_dir(&bare)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&heads.stdout).trim(),
            "refs/heads/trunk",
            "no branch resurrected on the remote"
        );
    }

    #[test]
    fn quitting_ply_kills_an_in_flight_library_fetch_and_refuses_the_next() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let marker = tmp.path().join("orphan-survived");
        let started_marker = tmp.path().join("fetch-started");
        stall_fetch(&clone, &marker, Some(&started_marker));
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            push: std::time::Duration::from_secs(20),
            registry: &registry,
        };

        let started = std::time::Instant::now();
        let result = std::thread::scope(|s| {
            let publish = s.spawn(|| {
                publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &git)
            });
            while !started_marker.exists() {
                assert!(started.elapsed() < std::time::Duration::from_secs(5), "fetch never ran");
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(registry.shutdown(), 1, "the fetch was registered for exit");
            publish.join().unwrap()
        });
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "the exit kill ended it");
        let error = result.expect_err("killed on quit");
        assert!(
            matches!(error, LibraryError::Conflict { stage: ConflictStage::Pull, .. }),
            "{error:?}"
        );
        assert!(!clone.join(&rel).exists());
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(!marker.exists(), "the fetch's child process outlived the exit kill");

        // Once quitting, no new network git is started.
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &git)
            .expect_err("refused while quitting");
        assert!(error.message().contains("Plyloft is quitting"), "{}", error.message());
    }

    /// GH #204 review 2 for the library: an ssh ControlPersist master (here a
    /// helper that leaves its session holding stderr) must not fail a fetch
    /// or push that worked, nor hold the call until it exits.
    #[cfg(unix)] // execs a `/bin/sh` stub directly
    #[test]
    fn a_helper_holding_stderr_open_after_success_is_still_ok() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let pids = tmp.path().join("daemon-pids");
        // Touched by a daemon only once its hold (60 s, was 30 s) is up (GH #236).
        let released = tmp.path().join("daemon-released");
        let ready = tmp.path().join("ready");
        let wrapper = tmp.path().join("daemonising-helper.sh");
        // `$1` is `upload-pack` or `receive-pack`; git appends the path.
        // GH #236: git starts only once the daemon is in its own session and
        // has recorded its pid (`ready.<wrapper pid>`). A perl slow to start
        // under load was otherwise still in git's process group when git
        // exited, and the group kill took it before it daemonised, as it
        // should: an ssh master is in its own session before ssh goes on.
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\n\
                 [ -n \"$PLY_TEST_PREWARM\" ] && exit 0\n\
                 sub=\"$1\"; shift\n\
                 perl -MPOSIX -e 'setsid(); open(my $f, \">>\", $ARGV[0]); print $f \"$$\\n\"; close $f; open($f, \">\", $ARGV[2]); close $f; sleep 60; open($f, \">\", $ARGV[1]); close $f' '{}' '{}' \"{}.$$\" </dev/null >/dev/null &\n\
                 while [ ! -e \"{}.$$\" ]; do sleep 0.05; done\n\
                 exec git \"$sub\" \"$@\"\n",
                pids.display(),
                released.display(),
                ready.display(),
                ready.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        // GH #236, the #147 pre-warm: exec the fresh helper once and wait for
        // it, with no deadline. macOS assesses a new executable on its first
        // exec; beside two other loaded suites that pushed the publish past
        // its old 12 s check (19-23 s) and once the fetch past its 20 s bound.
        // ETXTBSY (Linux: another test's fork holding the new file) is retried.
        loop {
            match crate::platform::new_command(&wrapper)
                .env("PLY_TEST_PREWARM", "1")
                .stdin(std::process::Stdio::null())
                .status()
            {
                Ok(status) => {
                    assert!(status.success(), "test setup failure: helper pre-warm: {status}");
                    break;
                }
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("test setup failure: helper pre-warm: {e}"),
            }
        }
        assert!(!pids.exists(), "the pre-warm is not the fetch");
        let w = wrapper.display().to_string();
        git(&clone, &["config", "remote.origin.uploadpack", &format!("{w} upload-pack")]);
        git(&clone, &["config", "remote.origin.receivepack", &format!("{w} receive-pack")]);
        let rel = library_relative_path("knowledge/auth-flow.md").unwrap();
        let registry = test_registry();
        let git = BoundedGit {
            fetch: std::time::Duration::from_secs(20),
            push: std::time::Duration::from_secs(20),
            registry: &registry,
        };

        let outcome = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "mine"), &git);
        // Returned before any daemon's hold was up: waiting for the daemons
        // (60 s) would be the unbounded `.output()` (GH #236: a marker
        // instead of the old 12 s elapsed-time check).
        let waited = released.exists();
        let daemons: Vec<i32> = std::fs::read_to_string(&pids)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect();
        for pid in &daemons {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
        let outcome = outcome.expect("a fetch and push that worked are Ok");
        assert_eq!(daemons.len(), 2, "both helpers ran and left a daemon behind");
        assert!(outcome.committed && outcome.pushed);
        assert!(bare_has(&bare, &rel));
        assert!(!waited, "the fetch or push waited for a daemon holding its stderr");
    }

    /// A Settings → Team refresh through the bounded pull: a teammate's entry
    /// arrives; a stalled fetch is a non-fatal `pull_error` that says what
    /// the panel shows and what to do.
    #[test]
    fn the_refresh_pull_is_bounded_and_says_what_a_timeout_means() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TeamStore::new(tmp.path().join("config"));
        let slug = "owner/team";
        let (bare, seeded) = bare_remote_and_clone(tmp.path());
        let dir = store.clone_dir(slug);
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::fs::rename(&seeded, &dir).unwrap();

        let teammate = tmp.path().join("teammate");
        git(
            tmp.path(),
            &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()],
        );
        write_entry(&teammate.join("library/knowledge/theirs.md"), "theirs").unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "teammate"]);
        git(&teammate, &["push"]);

        let outcome = store.sync(slug).expect("sync");
        assert!(outcome.pull_error.is_none(), "{:?}", outcome.pull_error);
        assert!(dir.join("library/knowledge/theirs.md").is_file());

        let marker = tmp.path().join("orphan-survived");
        stall_fetch(&dir, &marker, None);
        let registry = test_registry();
        let outcome = sync_clone(&dir, slug, |_, _| unreachable!(), |dir| {
            library_pull_in(dir, std::time::Duration::from_millis(300), &registry)
                .map_err(RemoteFailure::for_refresh)
        })
        .expect("a stalled pull is not fatal");
        let error = outcome.pull_error.expect("reported");
        assert!(error.contains("`git fetch` was stopped after 300ms"), "{error}");
        assert!(error.contains(&format!("as {THIS_MACHINE} last pulled it")), "{error}");
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(!marker.exists());
    }

    /// T5 (team walk, Windows): a pull git couldn't sign in for says so and
    /// where to fix it — never "GitHub didn't answer in time".
    #[test]
    fn a_pull_that_could_not_sign_in_says_where_to_turn_it_on() {
        let refused = RemoteFailure::Refused(
            "git fetch failed: fatal: Cannot prompt because user interactivity has been disabled.".into(),
        );
        for words in [refused.clone().for_refresh(), refused.to_string()] {
            // The plain words alone; git's stderr goes to the log.
            assert_eq!(words, crate::platform::GIT_AUTH_WORDS);
        }
        let ssh = RemoteFailure::Refused("git@github.com: Permission denied (publickey).".into());
        assert_eq!(ssh.to_string(), crate::platform::GIT_SSH_AUTH_WORDS);
        let other = RemoteFailure::Refused("fatal: Could not resolve host: github.com".into());
        assert_eq!(other.clone().for_refresh(), "fatal: Could not resolve host: github.com");
        assert_eq!(other.to_string(), "fatal: Could not resolve host: github.com");
    }

    /// Red when any network git goes back to the unbounded `crate::git::run`
    /// (`.output()`, no bound, no exit kill, may prompt), or is spawned raw
    /// with `git_command()` outside the bounded runner. No exceptions:
    /// GH #222 bounded Ship's pushes and the PR-branch push
    /// (`worktrees::release_push`).
    #[test]
    fn no_network_git_runs_through_the_unbounded_helpers() {
        const NETWORK: [&str; 5] = ["\"pull\"", "\"push\"", "\"fetch\"", "\"clone\"", "\"ls-remote\""];
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut raw_seen = 0;
        for entry in std::fs::read_dir(&src).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let code = strip_inline_test_modules(&source);
            // The first element of an array literal, as `"verb"`.
            let first_of = |array: &str| -> String {
                array.trim_start().split([',', ']']).next().unwrap_or_default().trim().to_string()
            };
            for helper in ["git::run(", "git::capture(", "git_run(", "git_capture(", "run_git("] {
                for (at, _) in code.match_indices(helper) {
                    // This call's statement only: its array literal, never the next.
                    let stmt = &code[at..];
                    let stmt = &stmt[..stmt.find(';').unwrap_or(stmt.len())];
                    let Some(open) = stmt.find("&[") else { continue };
                    let first = first_of(&stmt[open + 2..]);
                    // `git fetch … . <refspec>` reads this repository itself.
                    let local = stmt.contains("\".\", ");
                    if !NETWORK.contains(&first.as_str()) || local {
                        continue;
                    }
                    let line_start = code[..at].rfind('\n').map_or(0, |i| i + 1);
                    let call = &code[line_start..at + stmt.len()];
                    offenders.push(format!("{name}: {}", call.lines().next().unwrap_or("").trim()));
                }
            }
            // Raw spawns: the builder that follows up to the end of the
            // enclosing function must hand the command to the bounded runner.
            for (at, _) in code.match_indices("git_command()") {
                let rest = &code[at..];
                let body_end = ["\nfn ", "\n    fn ", "\npub", "\n    pub"]
                    .iter()
                    .filter_map(|m| rest.find(m))
                    .min()
                    .unwrap_or(rest.len());
                let body = &rest[..body_end];
                let Some(args) = body.find(".args([").map(|i| i + ".args([".len()).or_else(|| {
                    body.find(".arg(").map(|i| i + ".arg(".len())
                }) else {
                    continue;
                };
                if !NETWORK.contains(&first_of(&body[args..]).as_str()) {
                    continue;
                }
                raw_seen += 1;
                if !body.contains("run_bounded") {
                    let line_start = code[..at].rfind('\n').map_or(0, |i| i + 1);
                    let line = code[line_start..].lines().next().unwrap_or("").trim();
                    offenders.push(format!("{name} (raw): {line}"));
                }
            }
        }
        assert!(offenders.is_empty(), "unbounded network git: {offenders:#?}");
        // The raw path is exercised: shared_config's bounded `ls-remote`.
        assert!(raw_seen >= 1, "the raw `git_command()` scan matched nothing");
    }

    /// `source` without its inline `#[cfg(test)] mod <name> { … }` blocks —
    /// a `mod name;` declaration (lib.rs) is kept, and so is everything
    /// after a test module. Braces inside strings, chars and comments are
    /// skipped so a `"{path}"` never ends a block early.
    fn strip_inline_test_modules(source: &str) -> String {
        let mut out = String::with_capacity(source.len());
        let mut rest = source;
        while let Some(at) = rest.find("#[cfg(test)]") {
            let after = &rest[at + "#[cfg(test)]".len()..];
            let trimmed = after.trim_start();
            let is_inline_mod = trimmed.starts_with("mod ")
                && trimmed
                    .find(['{', ';'])
                    .is_some_and(|i| trimmed.as_bytes()[i] == b'{');
            if !is_inline_mod {
                out.push_str(&rest[..at + "#[cfg(test)]".len()]);
                rest = after;
                continue;
            }
            out.push_str(&rest[..at]);
            let open = after.len() - trimmed.len() + trimmed.find('{').unwrap();
            let close = matching_brace(&after[open..]).map_or(after.len(), |i| open + i + 1);
            rest = &after[close..];
        }
        out.push_str(rest);
        out
    }

    /// Byte offset of the `}` closing the `{` at the start of `s`.
    fn matching_brace(s: &str) -> Option<usize> {
        let b = s.as_bytes();
        let (mut i, mut depth) = (0usize, 0usize);
        while i < b.len() {
            match b[i] {
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'*') => {
                    i += 2;
                    while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                        i += 1;
                    }
                    i += 1;
                }
                b'r' if matches!(b.get(i + 1), Some(b'"') | Some(b'#'))
                    && (i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_')) =>
                {
                    let hashes = b[i + 1..].iter().take_while(|c| **c == b'#').count();
                    let quote = i + 1 + hashes;
                    if b.get(quote) == Some(&b'"') {
                        let end = format!("\"{}", "#".repeat(hashes));
                        i = s[quote + 1..].find(&end).map_or(b.len(), |e| quote + 1 + e + end.len() - 1);
                    }
                }
                b'"' => {
                    i += 1;
                    while i < b.len() && b[i] != b'"' {
                        if b[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                }
                // A char literal: `'{'`, `'\''`, `'\n'` — not a lifetime.
                b'\'' if b.get(i + 2) == Some(&b'\'') => i += 2,
                b'\'' if b.get(i + 1) == Some(&b'\\') => {
                    i += 2;
                    while i < b.len() && b[i] != b'\'' {
                        i += 1;
                    }
                }
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    #[test]
    fn the_scan_strips_inline_test_modules_only() {
        let source = "mod a;\n#[cfg(test)]\nmod b;\nfn keep() {}\n#[cfg(test)]\nmod tests {\n    \
                      fn t() { let _ = \"}\"; let _ = '}'; /* } */ // }\n    }\n}\nfn after() {}\n";
        let stripped = strip_inline_test_modules(source);
        assert!(stripped.contains("mod b;"), "{stripped}");
        assert!(stripped.contains("fn keep()"), "{stripped}");
        assert!(!stripped.contains("fn t()"), "{stripped}");
        assert!(stripped.contains("fn after()"), "{stripped}");
    }

    // ── GH #226: "Reapply mine on top" ─────────────────────────────────

    fn commit_file(dir: &Path, rel: &str, text: &str, msg: &str) {
        write_entry(&dir.join(rel), text).unwrap();
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-m", msg]);
    }

    fn teammate_of(root: &Path, bare: &Path) -> PathBuf {
        let other = root.join("teammate");
        git(root, &["clone", &bare.to_string_lossy(), &other.to_string_lossy()]);
        git(&other, &["config", "user.name", "Teammate"]);
        git(&other, &["config", "user.email", "mate@example.invalid"]);
        other
    }

    /// This Mac commits `mine` without publishing it (a push refused or
    /// stopped earlier), then a teammate publishes `theirs`: ahead 1, behind 1.
    fn diverged(root: &Path, mine: (&str, &str), theirs: (&str, &str)) -> (PathBuf, PathBuf) {
        let (bare, clone) = bare_remote_and_clone(root);
        let other = teammate_of(root, &bare);
        commit_file(&other, theirs.0, theirs.1, "teammate");
        git(&other, &["push"]);
        commit_file(&clone, mine.0, mine.1, "mine, unpublished");
        (bare, clone)
    }

    fn backups(dir: &Path) -> Vec<String> {
        let out = crate::platform::git_command()
            .args(["for-each-ref", "--format=%(refname)", BACKUP_REF_PREFIX])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect()
    }

    fn bare_text(bare: &Path, rel: &str) -> String {
        let out = crate::platform::git_command()
            .args(["show", &format!("main:{rel}")])
            .current_dir(bare)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn reapply_with(clone: &Path, push: std::time::Duration) -> Result<ReapplyReport, String> {
        reapply_at(clone, push, chrono::Utc::now())
    }

    fn reapply_at(
        clone: &Path,
        push: std::time::Duration,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<ReapplyReport, String> {
        let registry = test_registry();
        let report = reapply_library_changes_in(
            clone,
            &ReapplyBounds {
                fetch: std::time::Duration::from_secs(20),
                push,
                registry: &registry,
            },
            now,
        )?;
        // Review 1 (ux-language §4): the sentence is words only — paths,
        // refs and git's output are the report's fields, for Details.
        let clone_text = clone.display().to_string();
        for leaked in ["library/", "refs/ply", ".git", clone_text.as_str()] {
            assert!(!report.message.contains(leaked), "`{leaked}` in: {}", report.message);
        }
        Ok(report)
    }

    const MINE: &str = "library/knowledge/mine.md";
    const THEIRS: &str = "library/knowledge/theirs.md";
    const SAME: &str = "library/knowledge/same.md";

    /// F2 (Challenger 1, 10): a reapply's rebase re-creates this Mac's
    /// commits. In a clone that signs every commit with a key program that
    /// can't run and whose hooks refuse or hang, it still finishes, the
    /// re-created commit is unsigned, no hook ran, and the never-created
    /// hooks path is still not there.
    #[cfg(unix)]
    #[test]
    fn a_reapply_in_a_hostile_clone_finishes_unsigned_and_runs_no_hook() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let hooks = tmp.path().join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let ran = tmp.path().join("a-hook-ran");
        for name in ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-rewrite", "post-checkout", "pre-push", "pre-rebase"] {
            let path = hooks.join(name);
            std::fs::write(&path, format!("#!/bin/sh\ntouch '{}'\nexit 1\n", ran.display())).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(&clone, &["config", "commit.gpgSign", "true"]);
        git(&clone, &["config", "gpg.program", &tmp.path().join("no-such-gpg").to_string_lossy()]);
        git(&clone, &["config", "core.hooksPath", &hooks.to_string_lossy()]);

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reapply");
        assert_eq!(report.result, ReapplyResult::Published, "{report:?}");
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
        let signed = crate::git::capture(&clone, &["log", "-1", "--format=%s|%G?"]).unwrap();
        assert_eq!(signed.trim(), "mine, unpublished|N");
        assert!(!ran.exists(), "no hook ran");
        assert!(!library_no_hooks_path(&clone).exists(), "nothing was made for the hooks path");
        assert_eq!(library_no_hooks_path(&clone), clone.join(".git").join("plyloft-no-hooks"));
    }

    /// F2 (Challenger 10): a linked worktree's hooks path is inside its own
    /// git folder, read from its `.git` file.
    #[test]
    fn the_no_hooks_path_of_a_linked_worktree_is_inside_its_git_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let (_, clone) = bare_remote_and_clone(tmp.path());
        let wt = tmp.path().join("wt");
        git(&clone, &["worktree", "add", "--quiet", "--detach", &wt.to_string_lossy()]);
        let path = library_no_hooks_path(&wt);
        let parent = path.parent().unwrap().canonicalize().unwrap();
        let worktrees = clone.join(".git").join("worktrees").canonicalize().unwrap();
        assert!(parent.starts_with(&worktrees), "{}", path.display());
        assert!(path.ends_with("plyloft-no-hooks") && !path.exists());
    }

    #[test]
    fn a_diverged_clone_on_different_files_is_reapplied_and_both_changes_reach_github() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let local_tip = rev(&clone, "HEAD");
        let theirs_tip = rev(&bare, "main");
        // A month-old backup goes after a successful publish; one whose name
        // Ply didn't write is never touched.
        git(&clone, &["update-ref", "refs/ply/backup/20200101T000000Z-old", &local_tip]);
        git(&clone, &["update-ref", "refs/ply/backup/by-hand", &local_tip]);

        // The write stops as a divergence, not a generic conflict.
        let rel = library_relative_path("knowledge/next.md").unwrap();
        let stopped = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect_err("a diverged clone stops the write");
        assert!(matches!(stopped, LibraryError::Diverged { ahead: 1, behind: 1, .. }), "{stopped:?}");
        assert_eq!(
            library_divergence(&clone).map(|d| (d.ahead, d.behind)),
            Some((1, 1))
        );

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reapply");
        assert_eq!(report.result, ReapplyResult::Published, "{report:?}");
        assert_eq!((report.reapplied, report.brought_in), (1, 1));
        assert!(report.message.contains("Published your 1 change"), "{}", report.message);
        // Both changes are on GitHub, mine on top of theirs — a fast-forward.
        assert!(bare_has(&bare, MINE) && bare_has(&bare, THEIRS));
        assert_eq!(bare_text(&bare, MINE), "mine");
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
        assert_eq!(rev(&bare, "main~1"), theirs_tip, "theirs is kept, mine goes on top");
        // The backup holds the tip as this Mac had it.
        let made = report.backup_ref.clone().expect("a backup ref");
        assert!(made.starts_with(BACKUP_REF_PREFIX), "{made}");
        assert_eq!(rev(&clone, &made), local_tip);
        let kept = backups(&clone);
        assert!(kept.contains(&made), "{kept:?}");
        assert!(kept.contains(&"refs/ply/backup/by-hand".to_string()), "{kept:?}");
        assert!(
            !kept.contains(&"refs/ply/backup/20200101T000000Z-old".to_string()),
            "an old backup is removed after a successful publish: {kept:?}"
        );
        // The backup stays on this Mac: only the branch was pushed.
        let remote_refs = crate::platform::git_command()
            .args(["for-each-ref", "--format=%(refname)"])
            .current_dir(&bare)
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&remote_refs.stdout).contains("refs/ply/"));

        // The way back in: the next write goes through.
        assert_eq!(library_divergence(&clone), None);
        let outcome = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect("writes work again");
        assert!(outcome.pushed);
        assert!(bare_has(&bare, &rel));
    }

    #[test]
    fn a_collision_on_the_same_file_is_aborted_and_nothing_is_lost() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let local_tip = rev(&clone, "HEAD");
        let theirs_tip = rev(&bare, "main");
        git(&clone, &["update-ref", "refs/ply/backup/20200101T000000Z-old", &local_tip]);

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Collision, "{report:?}");
        assert_eq!(report.paths, vec![SAME.to_string()]);
        assert!(report.message.contains("same.md"), "{}", report.message);
        assert!(report.message.contains("nothing was published or lost"), "{}", report.message);
        // HEAD is exactly the backup, the rebase is gone, the tree is clean
        // and still holds my version.
        let made = report.backup_ref.clone().expect("a backup ref");
        assert_eq!(rev(&clone, "HEAD"), local_tip);
        assert_eq!(rev(&clone, &made), local_tip);
        assert!(!rebase_in_progress(&clone));
        assert!(uncommitted_paths(&clone).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "my version");
        // GitHub is untouched.
        assert_eq!(rev(&bare, "main"), theirs_tip);
        assert_eq!(bare_text(&bare, SAME), "their version");
        // A failure never removes a backup, old or new.
        let kept = backups(&clone);
        assert!(kept.contains(&made) && kept.contains(&"refs/ply/backup/20200101T000000Z-old".to_string()), "{kept:?}");
        // Still diverged: the panel keeps offering the way out.
        assert_eq!(library_divergence(&clone).map(|d| (d.ahead, d.behind)), Some((1, 1)));
    }

    #[test]
    fn a_clone_with_uncommitted_changes_is_refused_before_anything_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let local_tip = rev(&clone, "HEAD");
        let theirs_tip = rev(&bare, "main");
        std::fs::write(clone.join(MINE), "edited, not committed").unwrap();

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Dirty, "{report:?}");
        assert_eq!(report.paths, vec![MINE.to_string()]);
        assert!(report.message.contains("mine.md"), "{}", report.message);
        assert!(report.message.contains("Nothing was changed"), "{}", report.message);
        assert_eq!(report.backup_ref, None);
        assert!(backups(&clone).is_empty(), "no backup, no rebase: nothing ran");
        assert_eq!(rev(&clone, "HEAD"), local_tip);
        assert_eq!(std::fs::read_to_string(clone.join(MINE)).unwrap(), "edited, not committed");
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    /// Review 1 (m2): an untracked file Finder or a person left in the clone
    /// is not a reason to refuse — the reapply goes through and leaves it.
    #[test]
    fn an_untracked_file_out_of_the_way_does_not_stop_the_reapply() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        std::fs::write(clone.join(".DS_Store"), "finder").unwrap();
        write_entry(&clone.join("library/knowledge/draft.md"), "not shared").unwrap();

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reapply");
        assert_eq!(report.result, ReapplyResult::Published, "{report:?}");
        assert!(bare_has(&bare, MINE) && bare_has(&bare, THEIRS));
        assert!(!bare_has(&bare, "library/knowledge/draft.md"));
        assert_eq!(std::fs::read_to_string(clone.join(".DS_Store")).unwrap(), "finder");
        assert_eq!(
            std::fs::read_to_string(clone.join("library/knowledge/draft.md")).unwrap(),
            "not shared"
        );
    }

    /// Review 1 (m2): an untracked file exactly where the teammate's commit
    /// puts one stops the rebase; the abort and its check put everything back
    /// and the untracked file is untouched.
    #[test]
    fn an_untracked_file_in_the_rebases_way_stops_it_and_everything_is_put_back() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let local_tip = rev(&clone, "HEAD");
        let theirs_tip = rev(&bare, "main");
        write_entry(&clone.join(THEIRS), "my untracked copy").unwrap();

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Stopped, "{report:?}");
        assert!(report.detail.is_some());
        assert!(report.backup_ref.is_some());
        assert_eq!(rev(&clone, "HEAD"), local_tip);
        assert!(!rebase_in_progress(&clone));
        assert_eq!(std::fs::read_to_string(clone.join(THEIRS)).unwrap(), "my untracked copy");
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    #[test]
    fn a_push_stopped_after_the_rebase_keeps_it_and_a_retry_publishes_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let before = commits_on(&bare);
        install_hook(&bare, "pre-receive", "sleep 3");

        let report = reapply_with(&clone, std::time::Duration::from_millis(500)).expect("reported");
        assert_eq!(report.result, ReapplyResult::PushTimedOut, "{report:?}");
        assert!(report.message.starts_with(TIMEOUT_MARKER), "{}", report.message);
        assert!(report.message.contains("changes nothing if they did"), "{}", report.message);
        // The rebased commit is kept, on top of GitHub's; nothing landed.
        assert!(!bare_has(&bare, MINE));
        assert_eq!(commits_on(&bare), before);
        assert_eq!(library_divergence(&clone), None);
        git(&clone, &["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
        let first_backup = report.backup_ref.clone().expect("a backup ref");

        std::thread::sleep(std::time::Duration::from_millis(3000));
        std::fs::remove_file(bare.join("hooks/pre-receive")).unwrap();
        let retry = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("retry");
        assert_eq!(retry.result, ReapplyResult::Published, "{retry:?}");
        assert_eq!((retry.reapplied, retry.brought_in), (1, 0));
        assert_eq!(retry.backup_ref, None, "only ahead: pushed, not rebased again");
        assert!(bare_has(&bare, MINE) && bare_has(&bare, THEIRS));
        assert_eq!(commits_on(&bare), before + 1, "published once");
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
        assert_eq!(backups(&clone), vec![first_backup]);

        // Once more: in step, nothing to do.
        let again = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("again");
        assert_eq!(again.result, ReapplyResult::InStep);
        assert_eq!(commits_on(&bare), before + 1);
    }

    #[test]
    fn settings_team_reports_the_divergence_instead_of_a_pull_error() {
        let _guard = crate::github::test_serial_lock();
        let tmp = tempfile::tempdir().unwrap();
        let store = TeamStore::new(tmp.path().join("config"));
        let slug = "owner/team";
        let (_bare, seeded) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let dir = store.clone_dir(slug);
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        std::fs::rename(&seeded, &dir).unwrap();

        let outcome = store.sync(slug).expect("sync");
        assert!(outcome.pull_error.is_none(), "{:?}", outcome.pull_error);
        let workspaces = temp_store(tmp.path());
        let status = status(Some(slug), None, None, &[], &workspaces, &store, false);
        let clone_dir = dir.display().to_string();
        assert_eq!(
            status.library_divergence,
            Some(LibraryDivergence { ahead: 1, behind: 1, clone_dir: clone_dir.clone() })
        );
        assert_eq!(status.library_interruption, None);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(
            json["libraryDivergence"],
            serde_json::json!({ "ahead": 1, "behind": 1, "cloneDir": clone_dir })
        );
    }

    /// Red when any team library push in the shipped code could replace
    /// GitHub's history: a `--force` of any kind, `-f`, or a `+` refspec.
    /// Every push is the plain `git push --quiet`, and the rebase refuses to
    /// stash anything the member can't see.
    #[test]
    fn the_team_library_never_force_pushes() {
        let source = include_str!("team.rs");
        let code = strip_inline_test_modules(source);
        for banned in ["--force", "\"-f\"", "\"+", "force-with-lease", "--mirror"] {
            assert!(!code.contains(banned), "team.rs ships `{banned}`");
        }
        let pushes: Vec<&str> = code.match_indices("\"push\"").map(|(at, _)| &code[at..]).collect();
        assert!(!pushes.is_empty(), "the scan found no push");
        for push in pushes {
            let args = &push[..push.find(']').unwrap()];
            assert_eq!(args, "\"push\", \"--quiet\"", "an unexpected push: {args}");
        }
        assert!(code.contains("\"--no-autostash\""), "the rebase must never autostash");
    }

    // ── GH #226 review 1 ───────────────────────────────────────────────

    /// Where the stand-in for a force-quit stops the rebase.
    #[derive(Clone, Copy)]
    enum StopAt {
        /// Before any pick (a `break` first): clean, one line in `done`.
        BeforeTheFirstPick,
        /// After the first pick (`pick`, then `break`): clean, two lines.
        AfterTheFirstPick,
        /// At the first pick's conflict: unmerged paths in the index.
        Conflict,
    }

    /// Do what Ply's reapply does — backup, marker, rebase — and leave the
    /// rebase stopped: the state a force-quit mid-rebase leaves.
    fn interrupted_reapply(clone: &Path, stop: StopAt) -> (String, String) {
        git(clone, &["fetch", "--quiet"]);
        let head = rev(clone, "HEAD");
        let backup = record_backup(clone, &head, chrono::Utc::now()).unwrap();
        write_reapply_marker(clone, &backup, &head).unwrap();
        rebase_by_hand(clone, stop);
        (backup, head)
    }

    /// A rebase started with plain git, stopped where `stop` says.
    fn rebase_by_hand(clone: &Path, stop: StopAt) {
        let editor = match stop {
            StopAt::BeforeTheFirstPick => "perl -0pi -e 's/^/break\\n/'",
            StopAt::AfterTheFirstPick => "perl -0pi -e 's/\\A(pick[^\\n]*\\n)/$1break\\n/'",
            StopAt::Conflict => "true",
        };
        let out = crate::platform::git_command()
            .args(["-c", "core.editor=true", "-c", &format!("sequence.editor={editor}")])
            .args(["rebase", "-i", "origin/main"])
            .current_dir(clone)
            .output()
            .unwrap();
        assert!(rebase_in_progress(clone), "the rebase was meant to stop: {out:?}");
    }

    fn marker_exists(clone: &Path) -> bool {
        reapply_marker_path(clone).exists()
    }

    #[test]
    fn an_interrupted_reapply_is_recognised_and_finished_by_the_next_press() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let (_backup, head) = interrupted_reapply(&clone, StopAt::BeforeTheFirstPick);
        assert_eq!(
            library_interruption(&clone),
            Some(LibraryInterruption { own: true, clone_dir: clone.display().to_string() })
        );
        assert_eq!(library_divergence(&clone), None);

        // A write stops before the pull, and its toast offers the way out.
        let rel = library_relative_path("knowledge/next.md").unwrap();
        let applied = std::cell::Cell::new(false);
        let error = publish_library_change(
            &clone,
            &rel,
            "share",
            |p| {
                applied.set(true);
                write_entry(p, "x")
            },
            &RealLibraryGit,
        )
        .expect_err("stopped");
        assert!(matches!(error, LibraryError::Interrupted { own: true, .. }), "{error:?}");
        assert!(error.message().starts_with(DIVERGED_MARKER), "{}", error.message());
        assert!(error.message().contains("Reapply mine on top"), "{}", error.message());
        assert!(!error.message().contains("Refresh Settings"), "{}", error.message());
        assert!(error.left_the_library_unchanged() && !applied.get());

        // The press aborts it back to the backup, then reapplies for real.
        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reapply");
        assert_eq!(report.result, ReapplyResult::Published, "{report:?}");
        assert!(!rebase_in_progress(&clone));
        assert!(!marker_exists(&clone), "a verified success removes the marker");
        assert!(bare_has(&bare, MINE) && bare_has(&bare, THEIRS));
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
        assert!(backups(&clone).iter().any(|b| rev(&clone, b) == head));
        assert_eq!(library_interruption(&clone), None);
    }

    /// Review 2: even Ply's own rebase is not aborted once it holds anything
    /// a person could have made — here git's own conflict state.
    #[test]
    fn an_interrupted_reapply_stopped_at_a_conflict_is_never_aborted() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        interrupted_reapply(&clone, StopAt::Conflict);
        assert!(!library_interruption(&clone).unwrap().own);

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone), "left as it is");
        assert!(!crate::git::capture(&clone, &["ls-files", "--unmerged"]).unwrap().trim().is_empty());
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    /// Review 2 (M1b): a rebase past its first pick is somebody's progress.
    #[test]
    fn an_interrupted_reapply_past_its_first_pick_is_never_aborted() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        commit_file(&clone, "library/knowledge/second.md", "second", "second of mine");
        let theirs_tip = rev(&bare, "main");
        interrupted_reapply(&clone, StopAt::AfterTheFirstPick);
        let picked = rev(&clone, "HEAD");
        assert!(!library_interruption(&clone).unwrap().own);

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone));
        assert_eq!(rev(&clone, "HEAD"), picked, "the first pick is kept where it is");
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    /// Review 2 (B1, M1a): after a collision the copy tells the member to
    /// settle it by hand. Their own `git rebase`, resolved and staged, starts
    /// from the very commit Ply's backup holds — and is still theirs.
    #[test]
    fn the_members_own_rebase_after_a_collision_is_never_aborted() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        let collided = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(collided.result, ReapplyResult::Collision);
        assert!(!marker_exists(&clone), "a verified abort removes the marker");

        rebase_by_hand(&clone, StopAt::Conflict);
        std::fs::write(clone.join(SAME), "MERGED BY HAND").unwrap();
        git(&clone, &["add", SAME]);
        assert_eq!(
            library_interruption(&clone).map(|i| i.own),
            Some(false),
            "the member's rebase is not Plyloft's"
        );

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone));
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "MERGED BY HAND");
        let staged = crate::git::capture(&clone, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains(SAME), "the staged resolution is intact: {staged}");
        assert_eq!(rev(&bare, "main"), theirs_tip);

        // A write stops as foreign too: no toast offers the abort.
        let rel = library_relative_path("knowledge/next.md").unwrap();
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect_err("stopped");
        assert!(matches!(error, LibraryError::Interrupted { own: false, .. }), "{error:?}");
    }

    /// Review 2: the marker is what makes a rebase Ply's — not the backup it
    /// starts from. A member's rebase, stopped clean before its first pick
    /// (nothing in it a check of the tree could see), is still theirs.
    #[test]
    fn a_clean_rebase_without_plys_marker_is_never_aborted() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        let collided = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(collided.result, ReapplyResult::Collision);
        rebase_by_hand(&clone, StopAt::BeforeTheFirstPick);
        let onto = rev(&clone, "HEAD");
        assert_eq!(library_interruption(&clone).map(|i| i.own), Some(false));

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone));
        assert_eq!(rev(&clone, "HEAD"), onto);
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    /// Review 3 (M1'): Ply stopped at a conflict, the member aborted that
    /// rebase by hand, started their own at once (no read of the clone in
    /// between, so the marker is still there), resolved the first pick and
    /// ran `git commit`. The marker's commit is this rebase's orig-head, the
    /// tree is clean, one step is done — and it is still the member's.
    #[test]
    fn a_stale_marker_never_makes_the_members_later_rebase_plys() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        interrupted_reapply(&clone, StopAt::Conflict);
        git(&clone, &["rebase", "--abort"]);
        assert!(marker_exists(&clone), "no read yet: the stale marker is still there");
        rebase_by_hand(&clone, StopAt::Conflict);
        std::fs::write(clone.join(SAME), "HAND-RESOLVED").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["-c", "core.editor=true", "commit", "-q", "--no-edit"]);
        let mine = rev(&clone, "HEAD");
        assert!(untouched_since_ply_stopped(&clone), "the case the tree check alone misses");
        assert_eq!(library_interruption(&clone).map(|i| i.own), Some(false));

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone));
        assert_eq!(rev(&clone, "HEAD"), mine, "the member's commit is where they left it");
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "HAND-RESOLVED");
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    /// Review 3 (M1', S2): the amend variant — `rebase -i`, `edit` on the
    /// first pick, `commit --amend`.
    #[test]
    fn an_amended_first_pick_under_a_stale_marker_is_the_members() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        commit_file(&clone, "library/knowledge/b.md", "b", "b");
        git(&clone, &["fetch", "--quiet"]);
        let head = rev(&clone, "HEAD");
        let backup = record_backup(&clone, &head, chrono::Utc::now()).unwrap();
        write_reapply_marker(&clone, &backup, &head).unwrap();
        let out = crate::platform::git_command()
            .args(["-c", "sequence.editor=perl -pi -e 's/^pick/edit/ if $. == 1'"])
            .args(["rebase", "-i", "origin/main"])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert!(rebase_in_progress(&clone), "{out:?}");
        std::fs::write(clone.join(MINE), "AMENDED").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-q", "--amend", "--no-edit"]);
        let amended = rev(&clone, "HEAD");
        assert_eq!(library_interruption(&clone).map(|i| i.own), Some(false));

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert_eq!(rev(&clone, "HEAD"), amended);
    }

    /// Review 3 (b): a marker found with no rebase under way is dropped by
    /// the first read.
    #[test]
    fn a_marker_with_no_rebase_under_way_is_dropped_by_the_first_read() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = diverged(tmp.path(), (SAME, "mine"), (SAME, "theirs"));
        interrupted_reapply(&clone, StopAt::Conflict);
        git(&clone, &["rebase", "--abort"]);
        assert!(marker_exists(&clone));
        assert_eq!(library_interruption(&clone), None);
        assert!(!marker_exists(&clone));
    }

    /// Review 3: Ply's rebase is the merge backend whatever the member set, so
    /// the recovery (which reads `rebase-merge/`) always applies to it.
    #[test]
    fn plys_rebase_ignores_a_configured_apply_backend() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "mine"), (SAME, "theirs"));
        git(&clone, &["config", "rebase.backend", "apply"]);
        let head = rev(&clone, "HEAD");
        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Collision, "{report:?}");
        assert_eq!(rev(&clone, "HEAD"), head);
        assert!(!rebase_in_progress(&clone));
        let source = strip_inline_test_modules(include_str!("team.rs"));
        assert!(source.contains("\"rebase.backend=merge\""));
        let _ = bare;
    }

    /// The same for `git pull --rebase` by hand (M1c).
    #[test]
    fn a_pull_rebase_by_hand_is_never_aborted() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        let out = crate::platform::git_command()
            .args(["-c", "pull.rebase=true", "-c", "core.editor=true", "pull", "-q"])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert!(!out.status.success() && rebase_in_progress(&clone));
        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone));
    }

    #[test]
    fn a_rebase_ply_did_not_start_is_never_touched() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        git(&clone, &["fetch", "--quiet"]);
        let out = crate::platform::git_command()
            .args(["-c", "core.editor=true", "rebase", "origin/main"])
            .current_dir(&clone)
            .output()
            .unwrap();
        assert!(!out.status.success());
        let orig = rebase_orig_head(&clone).unwrap();
        assert_eq!(
            library_interruption(&clone),
            Some(LibraryInterruption { own: false, clone_dir: clone.display().to_string() })
        );

        let rel = library_relative_path("knowledge/next.md").unwrap();
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect_err("stopped");
        assert!(matches!(error, LibraryError::Interrupted { own: false, .. }), "{error:?}");
        assert!(!error.message().starts_with(DIVERGED_MARKER), "no reapply offered for it");

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::Foreign, "{report:?}");
        assert!(rebase_in_progress(&clone), "left exactly as the member had it");
        assert_eq!(rebase_orig_head(&clone).unwrap(), orig);
        assert!(backups(&clone).is_empty());
        assert_eq!(rev(&bare, "main"), theirs_tip);
    }

    #[test]
    fn a_push_github_denies_is_said_as_such_and_a_second_press_makes_no_new_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        let theirs_tip = rev(&bare, "main");
        install_hook(&bare, "pre-receive", "echo 'GH006: Protected branch update failed' >&2\nexit 1");

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(report.result, ReapplyResult::PushDenied, "{report:?}");
        assert!(report.message.contains("Pressing again won't help"), "{}", report.message);
        assert!(report.detail.as_deref().unwrap_or("").contains("declined"), "{report:?}");
        assert_eq!(backups(&clone).len(), 1);
        assert_eq!(rev(&bare, "main"), theirs_tip);

        let again = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reported");
        assert_eq!(again.result, ReapplyResult::PushDenied);
        assert_eq!(again.backup_ref, None, "only ahead now: a push, no rebase");
        assert_eq!(backups(&clone).len(), 1, "no new backup per press");
    }

    #[test]
    fn a_push_refused_as_non_fast_forward_is_a_race_and_anything_else_is_not() {
        for race in [
            "git push failed: ! [rejected]        main -> main (fetch first)",
            "git push failed: ! [rejected] main -> main (non-fast-forward)",
            "git push failed: ! [rejected] main -> main (stale info)",
            "git push failed: error: cannot lock ref 'refs/heads/main': is at abc but expected def",
        ] {
            assert!(push_refused_by_a_race(race), "{race}");
        }
        for denied in [
            "git push failed: ! [remote rejected] main -> main (pre-receive hook declined)",
            "git push failed: remote: Permission to o/r.git denied to me. fatal: 403",
            "git push failed: ! [remote rejected] main -> main (protected branch hook declined)",
        ] {
            assert!(!push_refused_by_a_race(denied), "{denied}");
        }
    }

    /// Review 1 (m3): a commit whose change a teammate already published is
    /// dropped by the rebase, and the success says so rather than counting it.
    #[test]
    fn changes_already_on_github_are_not_counted_as_published() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = diverged(tmp.path(), (MINE, "same text"), (MINE, "same text"));
        let before = commits_on(&bare);

        let report = reapply_with(&clone, std::time::Duration::from_secs(20)).expect("reapply");
        assert_eq!(report.result, ReapplyResult::Published, "{report:?}");
        assert_eq!(report.reapplied, 0);
        assert!(report.message.contains("already on GitHub"), "{}", report.message);
        assert_eq!(commits_on(&bare), before, "nothing new was pushed");
        assert_eq!(rev(&clone, "HEAD"), rev(&bare, "main"));
    }

    #[test]
    fn two_presses_in_the_same_second_keep_two_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = diverged(tmp.path(), (SAME, "mine"), (SAME, "theirs"));
        let now = chrono::Utc::now();
        let first = reapply_at(&clone, std::time::Duration::from_secs(20), now).unwrap();
        let second = reapply_at(&clone, std::time::Duration::from_secs(20), now).unwrap();
        let (a, b) = (first.backup_ref.unwrap(), second.backup_ref.unwrap());
        assert_ne!(a, b);
        assert!(b.ends_with("-2"), "{b}");
        assert_eq!(backups(&clone).len(), 2);
    }

    #[test]
    fn the_invites_git_releases_the_clone_lock_once_its_push_returns() {
        let tmp = tempfile::tempdir().unwrap();
        let (_bare, clone) = bare_remote_and_clone(tmp.path());
        let store = TeamStore::new(tmp.path().join("config"));
        let git = store.git_until_pushed();
        assert!(store.git_lock.try_lock().is_none(), "held through the publish");
        publish_library_change(
            &clone,
            &library_relative_path("knowledge/x.md").unwrap(),
            "share",
            |p| write_entry(p, "x"),
            &git,
        )
        .expect("publish");
        assert!(store.git_lock.try_lock().is_some(), "released once the push returned");
    }

    // ── H1 Windows walk: long paths and a torn fast-forward ──────────

    const DEEP_NOTE: &str = "library/claude/ply-team/skills/walk-long/references/\
        a-deliberately-long-folder-name-for-the-windows-path-walk/\
        another-long-folder-name-to-pass-the-limit/note.md";
    const WALK_SKILL: &str = "library/claude/ply-team/skills/walk-long/SKILL.md";

    /// The walk's repo, as git left it: a teammate pushed a commit that
    /// changes `team.json`, deletes `.gitkeep` and adds the `walk-long`
    /// skill; this clone fetched it and its fast-forward stopped halfway —
    /// `team.json` and `.gitkeep` already as upstream has them, `SKILL.md`
    /// written untracked, the deep `note.md` never created, `HEAD` unmoved.
    fn torn_clone(root: &Path) -> (PathBuf, String) {
        let (bare, clone) = bare_remote_and_clone(root);
        let teammate = root.join("teammate");
        git(root, &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()]);
        std::fs::write(teammate.join("team.json"), br#"{"name":"MB Adv","v":2}"#).unwrap();
        std::fs::remove_file(teammate.join("library/knowledge/.gitkeep")).unwrap();
        write_entry(&teammate.join(WALK_SKILL), "---\nname: walk-long\n---\n").unwrap();
        write_entry(&teammate.join(DEEP_NOTE), "deep").unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "walk-long"]);
        git(&teammate, &["push"]);

        let head = rev(&clone, "HEAD");
        git(&clone, &["fetch", "--quiet"]);
        std::fs::write(clone.join("team.json"), br#"{"name":"MB Adv","v":2}"#).unwrap();
        std::fs::remove_file(clone.join("library/knowledge/.gitkeep")).unwrap();
        write_entry(&clone.join(WALK_SKILL), "---\nname: walk-long\n---\n").unwrap();
        (clone, head)
    }

    fn status_of(dir: &Path) -> String {
        library_git_capture(dir, &["status", "--porcelain", "--untracked-files=all"]).unwrap()
    }

    #[test]
    fn the_torn_state_is_the_one_every_later_pull_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        // Today's failure, reproduced: the plain merge refuses for ever.
        let refused = crate::git::run(&clone, &["merge", "--ff-only", "--quiet", "@{upstream}"])
            .expect_err("the torn tree blocks a plain fast-forward");
        assert!(refused.contains("would be overwritten"), "{refused}");
    }

    #[test]
    fn a_torn_fast_forward_heals_and_the_next_pull_finishes() {
        let tmp = tempfile::tempdir().unwrap();
        let (clone, head) = torn_clone(tmp.path());

        let healed = heal_torn_fast_forward(&clone).unwrap();
        assert_eq!(
            healed,
            TornHeal::Healed(vec![
                WALK_SKILL.to_string(),
                "library/knowledge/.gitkeep".to_string(),
                "team.json".to_string(),
            ])
        );
        assert_eq!(rev(&clone, "HEAD"), head, "the heal never moves HEAD");
        assert!(status_of(&clone).trim().is_empty(), "back to HEAD: {}", status_of(&clone));
        assert!(!clone.join("library/claude").exists(), "the torn checkout's directories went too");

        // And from the torn state itself, the real pull finishes.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        RealLibraryGit.pull(&clone).expect("the pull heals the torn tree and fast-forwards");
        assert_eq!(rev(&clone, "HEAD"), rev(&clone, "@{upstream}"));
        assert!(clone.join(DEEP_NOTE).is_file());
        assert!(status_of(&clone).trim().is_empty());
        // Nothing left to heal.
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::Clean);
    }

    #[test]
    fn a_real_local_edit_is_never_discarded_by_the_heal() {
        // A tracked edit matching neither HEAD nor upstream.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, head) = torn_clone(tmp.path());
        std::fs::write(clone.join("team.json"), b"mine").unwrap();
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::NotTorn);
        let err = RealLibraryGit.pull(&clone).expect_err("today's behaviour and error");
        assert!(err.to_string().contains("would be overwritten"), "{err}");
        assert_eq!(std::fs::read(clone.join("team.json")).unwrap(), b"mine");
        assert!(clone.join(WALK_SKILL).is_file(), "nothing else was touched either");
        assert_eq!(rev(&clone, "HEAD"), head);

        // An untracked file upstream doesn't add.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        write_entry(&clone.join("library/knowledge/draft.md"), "my draft").unwrap();
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::NotTorn);
        assert_eq!(std::fs::read(clone.join("library/knowledge/draft.md")).unwrap(), b"my draft");
        assert_eq!(std::fs::read(clone.join("team.json")).unwrap(), br#"{"name":"MB Adv","v":2}"#);

        // An untracked file upstream adds, with other content.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        std::fs::write(clone.join(WALK_SKILL), "my own walk-long").unwrap();
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::NotTorn);
        assert_eq!(std::fs::read(clone.join(WALK_SKILL)).unwrap(), b"my own walk-long");

        // Something staged.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        git(&clone, &["add", "team.json"]);
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::NotTorn);
        assert!(clone.join(WALK_SKILL).is_file());

        // A clone with its own commit (GH #226's reapply case) is not healed.
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        write_entry(&clone.join("library/knowledge/mine.md"), "mine").unwrap();
        git(&clone, &["add", "library/knowledge/mine.md"]);
        git(&clone, &["commit", "-m", "mine"]);
        assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::Clean);
        assert!(clone.join(WALK_SKILL).is_file());
    }

    #[test]
    fn reapply_heals_a_torn_tree_instead_of_calling_it_an_edit() {
        let tmp = tempfile::tempdir().unwrap();
        let (clone, _) = torn_clone(tmp.path());
        let report = reapply_library_changes_in(
            &clone,
            &ReapplyBounds {
                fetch: LIBRARY_FETCH_TIMEOUT,
                push: LIBRARY_PUSH_TIMEOUT,
                registry: crate::worktrees::exit_registry(),
            },
            chrono::Utc::now(),
        )
        .expect("reapply");
        assert_ne!(report.result, ReapplyResult::Dirty, "{}", report.message);
        assert_eq!(report.result, ReapplyResult::InStep, "{}", report.message);
        assert_eq!(rev(&clone, "HEAD"), rev(&clone, "@{upstream}"));
        assert!(clone.join(DEEP_NOTE).is_file());
    }

    /// (Challenger) A teammate's commit that turns a file into a folder of
    /// the same name (and a folder into a file), torn halfway: the heal puts
    /// both back, with paths git would read as globs, and the pull finishes.
    #[test]
    fn a_torn_file_to_folder_swap_heals_with_literal_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let teammate = tmp.path().join("teammate");
        git(tmp.path(), &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()]);
        // `[x]*` would match `x-mine.md` as a glob. Windows can't hold a `*` in a
        // file name, so there `[x]` (a glob for `x`) stands in, with an `x` beside it.
        let file = if cfg!(windows) { "library/knowledge/[x]" } else { "library/knowledge/[x]*" };
        if cfg!(windows) {
            write_entry(&teammate.join("library/knowledge/x"), "a bystander").unwrap();
        }
        let folder = "library/knowledge/old";
        write_entry(&teammate.join(file), "a file").unwrap();
        write_entry(&teammate.join(folder).join("inner.md"), "a folder").unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "before"]);
        git(&teammate, &["push"]);
        RealLibraryGit.pull(&clone).unwrap();
        std::fs::remove_file(teammate.join(file)).unwrap();
        write_entry(&teammate.join(file).join("now.md"), "now a folder").unwrap();
        std::fs::remove_dir_all(teammate.join(folder)).unwrap();
        write_entry(&teammate.join(folder), "now a file").unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "swap"]);
        git(&teammate, &["push"]);

        let head = rev(&clone, "HEAD");
        git(&clone, &["fetch", "--quiet"]);
        std::fs::remove_file(clone.join(file)).unwrap();
        write_entry(&clone.join(file).join("now.md"), "now a folder").unwrap();
        std::fs::remove_dir_all(clone.join(folder)).unwrap();
        write_entry(&clone.join(folder), "now a file").unwrap();

        assert!(matches!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::Healed(_)));
        assert_eq!(rev(&clone, "HEAD"), head);
        assert!(status_of(&clone).trim().is_empty(), "{}", status_of(&clone));
        assert_eq!(std::fs::read(clone.join(file)).unwrap(), b"a file");
        assert_eq!(std::fs::read(clone.join(folder).join("inner.md")).unwrap(), b"a folder");
        RealLibraryGit.pull(&clone).expect("the pull finishes");
        assert_eq!(std::fs::read(clone.join(folder)).unwrap(), b"now a file");
    }

    /// (Challenger) A cherry-pick or revert under way is the member's, even
    /// one whose tree happens to look torn: nothing is touched.
    #[test]
    fn the_heal_leaves_a_cherry_pick_or_revert_under_way_alone() {
        for head in ["CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"] {
            let tmp = tempfile::tempdir().unwrap();
            let (clone, _) = torn_clone(tmp.path());
            let marker = clone.join(".git").join(head);
            if head == "sequencer" {
                std::fs::create_dir_all(&marker).unwrap();
            } else {
                std::fs::write(&marker, rev(&clone, "HEAD")).unwrap();
            }
            assert_eq!(heal_torn_fast_forward(&clone).unwrap(), TornHeal::Clean, "{head}");
            assert!(clone.join(WALK_SKILL).is_file(), "{head}");
        }
    }

    /// (Challenger) A file the upstream commit holds with CRLF, written by
    /// the torn checkout as is, is the upstream's even where autocrlf would
    /// convert it on the way in.
    #[test]
    fn a_torn_crlf_blob_heals_under_autocrlf() {
        let tmp = tempfile::tempdir().unwrap();
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let teammate = tmp.path().join("teammate");
        git(tmp.path(), &["clone", &bare.to_string_lossy(), &teammate.to_string_lossy()]);
        let path = "library/knowledge/windows.md";
        write_entry(&teammate.join(path), "one\r\ntwo\r\n").unwrap();
        git(&teammate, &["add", "-A"]);
        git(&teammate, &["commit", "-m", "crlf"]);
        git(&teammate, &["push"]);
        git(&clone, &["config", "core.autocrlf", "input"]);
        git(&clone, &["fetch", "--quiet"]);
        write_entry(&clone.join(path), "one\r\ntwo\r\n").unwrap();
        assert_eq!(
            heal_torn_fast_forward(&clone).unwrap(),
            TornHeal::Healed(vec![path.to_string()])
        );
        RealLibraryGit.pull(&clone).expect("the pull finishes");
    }

    /// Every git Plyloft runs on a library clone carries `core.longpaths`:
    /// the helpers pass it (proved by asking git), and the production code of
    /// this module reaches git only through them (`origin_of` reads a
    /// workspace checkout, not a library clone).
    #[test]
    fn library_git_carries_core_longpaths() {
        assert_eq!(LIBRARY_GIT_CONFIG, ["-c", "core.longpaths=true"]);
        let tmp = tempfile::tempdir().unwrap();
        let (_, clone) = bare_remote_and_clone(tmp.path());
        assert_eq!(
            library_git_capture(&clone, &["config", "--get", "core.longpaths"]).unwrap().trim(),
            "true"
        );

        let source = include_str!("team.rs");
        let code = &source[..source.find("#[cfg(test)]\nmod tests").expect("tests module")];
        let raw: Vec<&str> = code
            .lines()
            .filter(|l| {
                (l.contains("crate::git::run(") || l.contains("crate::git::capture("))
                    && !l.trim_start().starts_with("//")
            })
            .collect();
        assert_eq!(
            raw,
            vec!["    crate::git::capture(dir, &[\"remote\", \"get-url\", \"origin\"])"],
            "only origin_of (a workspace checkout) may skip the library config"
        );
        assert!(!code.contains("git_command()"), "no raw git spawn on a library clone");
        let network = &code[code.find("fn library_network_git(").unwrap()..];
        let network = &network[..network.find("\n}\n").unwrap()];
        assert!(network.contains("library_git_config(dir)"), "fetch and push carry it too");
        assert!(code.contains("crate::github::library_repo_clone(slug, dest)"));
        assert!(!code.contains("|slug, dest| crate::github::repo_clone(slug, dest),\n            // GH #224"));

        let snapshot = include_str!("library_snapshot.rs");
        let git_cmd = &snapshot[snapshot.find("fn git_cmd(").unwrap()..];
        let git_cmd = &git_cmd[..git_cmd.find("\n}\n").unwrap()];
        assert!(git_cmd.contains("crate::team::library_git_config(clone)"));

        let commands = include_str!("commands.rs");
        let create = &commands[commands.find("create_team_with(").unwrap()..];
        assert!(
            create[..600].contains("crate::github::library_repo_clone(slug, dest)"),
            "a new team's first clone carries it in its own config"
        );
    }

    // ── QoL 13.3: the conflict resolver ────────────────────────────────

    fn settle(clone: &Path, aside: &Path, choices: &[(&str, ReapplyChoice)]) -> ReapplyReport {
        let registry = test_registry();
        let report = reapply_resolving_in(
            clone,
            &ReapplyBounds { fetch: std::time::Duration::from_secs(20), push: std::time::Duration::from_secs(20), registry: &registry },
            chrono::Utc::now(),
            &Resolve {
                choices: choices.iter().map(|(p, c)| (p.to_string(), *c)).collect(),
                aside_root: Some(aside.to_path_buf()),
            },
        )
        .expect("reported");
        let clone_text = clone.display().to_string();
        for leaked in ["library/", "refs/ply", ".git", clone_text.as_str()] {
            assert!(!report.message.contains(leaked), "`{leaked}` in: {}", report.message);
        }
        report
    }

    /// Keep mine: settled on this Mac with this Mac's version, nothing
    /// pushed until Publish (the plain reapply), which pushes it.
    #[test]
    fn keep_mine_settles_locally_and_publish_sends_it() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        let collided = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(collided.result, ReapplyResult::Collision);
        assert_eq!(collided.paths, [SAME]);

        let settled = settle(&clone, &aside, &[(SAME, ReapplyChoice::Mine)]);
        assert_eq!(settled.result, ReapplyResult::Resolved, "{settled:?}");
        assert_eq!(settled.paths, [SAME]);
        assert!(settled.backup_ref.is_some());
        assert!(settled.aside_dir.is_none());
        assert_eq!(rev(&bare, "main"), theirs_tip, "nothing pushed yet");
        assert!(!rebase_in_progress(&clone));
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "my version");
        assert!(library_divergence(&clone).is_none(), "on top of GitHub's now");
        let waiting = library_resolved(&clone).expect("waits for Publish or Undo");
        assert_eq!(waiting.paths, [SAME]);

        let published = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(published.result, ReapplyResult::Published, "{published:?}");
        assert_eq!(bare_text(&bare, SAME), "my version");
        assert!(library_resolved(&clone).is_none(), "nothing left to undo once published");
        assert!(undo_resolved_in(&clone).is_err());
    }

    /// Keep theirs, then Undo: the clone goes back to the backup — diverged,
    /// this Mac's commit intact — and nothing ever reached GitHub.
    #[test]
    fn keep_theirs_is_undone_back_to_the_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let before = rev(&clone, "HEAD");
        let theirs_tip = rev(&bare, "main");
        let settled = settle(&clone, &aside, &[(SAME, ReapplyChoice::Theirs)]);
        assert_eq!(settled.result, ReapplyResult::Resolved, "{settled:?}");
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "their version");
        // My only commit became empty: dropped, so nothing is left to publish.
        assert_eq!(rev(&clone, "HEAD"), theirs_tip);

        let undone = undo_resolved_in(&clone).expect("undone");
        assert!(undone.contains("Nothing was published"), "{undone}");
        assert_eq!(rev(&clone, "HEAD"), before, "back to this Mac's own commit");
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "my version");
        assert!(library_divergence(&clone).is_some(), "diverged again, as before");
        assert!(library_resolved(&clone).is_none());
        assert_eq!(rev(&bare, "main"), theirs_tip);
        assert!(undo_resolved_in(&clone).is_err(), "nothing more to undo");
    }

    /// Keep both: the teammate's version stays in the library, this Mac's
    /// is saved in a dated folder outside the clone, never published.
    #[test]
    fn keep_both_saves_mine_outside_the_library() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let settled = settle(&clone, &aside, &[(SAME, ReapplyChoice::Both)]);
        assert_eq!(settled.result, ReapplyResult::Resolved, "{settled:?}");
        let dir = PathBuf::from(settled.aside_dir.clone().expect("a folder"));
        assert!(dir.starts_with(&aside), "{dir:?}");
        assert!(!dir.starts_with(&clone));
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains(':'), "a name Windows takes: {name}");
        assert_eq!(std::fs::read_to_string(dir.join(SAME)).unwrap(), "my version");
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "their version");
        assert_eq!(library_resolved(&clone).and_then(|r| r.aside_dir), settled.aside_dir);
        assert_eq!(bare_text(&bare, SAME), "their version");
    }

    /// A file the choices don't cover stops it as before: Collision, every
    /// file named, the clone exactly as it was.
    #[test]
    fn a_file_without_a_choice_stops_and_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (_bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let before = rev(&clone, "HEAD");
        let report = settle(&clone, &aside, &[("library/knowledge/other.md", ReapplyChoice::Mine)]);
        assert_eq!(report.result, ReapplyResult::Collision, "{report:?}");
        assert_eq!(report.paths, [SAME]);
        assert_eq!(rev(&clone, "HEAD"), before);
        assert!(!rebase_in_progress(&clone));
        assert!(library_resolved(&clone).is_none());
    }

    /// Move them aside: uncommitted edits are copied into a dated folder,
    /// then put back to the last commit, so the reapply can run.
    #[test]
    fn uncommitted_edits_are_moved_aside_and_the_reapply_runs() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        std::fs::write(clone.join(MINE), "an edit by hand").unwrap();
        write_entry(&clone.join("library/knowledge/new.md"), "new by hand").unwrap();
        git(&clone, &["add", "library/knowledge/new.md"]);
        let dirty = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(dirty.result, ReapplyResult::Dirty);

        let moved = move_aside_in(&clone, &aside, chrono::Utc::now()).expect("moved");
        assert_eq!(moved.paths.len(), 2, "{moved:?}");
        let dir = PathBuf::from(&moved.dir);
        assert_eq!(std::fs::read_to_string(dir.join(MINE)).unwrap(), "an edit by hand");
        assert_eq!(std::fs::read_to_string(dir.join("library/knowledge/new.md")).unwrap(), "new by hand");
        assert_eq!(std::fs::read_to_string(clone.join(MINE)).unwrap(), "mine");
        assert!(!clone.join("library/knowledge/new.md").exists());
        assert!(uncommitted_paths(&clone).unwrap().is_empty());
        assert!(move_aside_in(&clone, &aside, chrono::Utc::now()).is_err(), "nothing left to move");

        let published = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(published.result, ReapplyResult::Published, "{published:?}");
        assert_eq!(bare_text(&bare, MINE), "mine");
    }

    /// A teammate removed the file this Mac edited: Keep theirs removes it
    /// here too (no forced `git rm`), Keep mine keeps this Mac's edit.
    #[test]
    fn a_file_removed_on_one_side_follows_the_choice() {
        for (choice, kept) in [(ReapplyChoice::Theirs, false), (ReapplyChoice::Mine, true)] {
            let tmp = tempfile::tempdir().unwrap();
            let aside = tmp.path().join("team-set-aside");
            let (bare, clone) = bare_remote_and_clone(tmp.path());
            commit_file(&clone, SAME, "v1", "v1");
            git(&clone, &["push", "--quiet"]);
            let other = teammate_of(tmp.path(), &bare);
            git(&other, &["rm", "-q", SAME]);
            git(&other, &["commit", "-m", "teammate removes it"]);
            git(&other, &["push", "--quiet"]);
            commit_file(&clone, SAME, "my edit", "mine, unpublished");
            let settled = settle(&clone, &aside, &[(SAME, choice)]);
            assert_eq!(settled.result, ReapplyResult::Resolved, "{choice:?}: {settled:?}");
            assert_eq!(clone.join(SAME).exists(), kept, "{choice:?}");
            assert!(uncommitted_paths(&clone).unwrap().is_empty(), "{choice:?}");
        }
    }

    /// Challenger (block 13): a team library write never carries choices
    /// put together and not published — it waits for Publish or Undo.
    #[test]
    fn a_library_write_waits_while_choices_are_unpublished() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let theirs_tip = rev(&bare, "main");
        assert_eq!(settle(&clone, &aside, &[(SAME, ReapplyChoice::Mine)]).result, ReapplyResult::Resolved);
        let rel = library_relative_path("knowledge/next.md").unwrap();
        let error = publish_library_change(&clone, &rel, "share", |p| write_entry(p, "x"), &RealLibraryGit)
            .expect_err("waits");
        assert!(matches!(&error, LibraryError::Failed(words) if words.contains("Publish or Undo your choices first")), "{error:?}");
        assert!(!clone.join("library/knowledge/next.md").exists(), "nothing written");
        assert_eq!(rev(&bare, "main"), theirs_tip, "nothing pushed");
        undo_resolved_in(&clone).unwrap();
        assert!(library_resolved(&clone).is_none());
    }

    /// Challenger (block 13): two unpublished commits that collide on two
    /// different files — the second stop names both files, so the chooser
    /// keeps the first choice, and both choices together settle it.
    #[test]
    fn a_later_collision_names_every_file_met() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = bare_remote_and_clone(tmp.path());
        let other = teammate_of(tmp.path(), &bare);
        commit_file(&other, SAME, "their same", "teammate same");
        commit_file(&other, THEIRS, "their other", "teammate other");
        git(&other, &["push", "--quiet"]);
        commit_file(&clone, SAME, "my same", "mine 1");
        commit_file(&clone, THEIRS, "my other", "mine 2");
        let first = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert_eq!(first.result, ReapplyResult::Collision);
        assert_eq!(first.paths, [SAME]);
        let second = settle(&clone, &aside, &[(SAME, ReapplyChoice::Mine)]);
        assert_eq!(second.result, ReapplyResult::Collision, "{second:?}");
        let mut want = vec![SAME.to_string(), THEIRS.to_string()];
        want.sort();
        assert_eq!(second.paths, want, "the earlier file is named too");
        assert!(!rebase_in_progress(&clone));
        let done = settle(&clone, &aside, &[(SAME, ReapplyChoice::Mine), (THEIRS, ReapplyChoice::Theirs)]);
        assert_eq!(done.result, ReapplyResult::Resolved, "{done:?}");
        assert_eq!(std::fs::read_to_string(clone.join(SAME)).unwrap(), "my same");
        assert_eq!(std::fs::read_to_string(clone.join(THEIRS)).unwrap(), "their other");
    }

    /// Challenger: a staged rename and a staged-then-edited file are moved
    /// aside whole — the rename's source comes back, the staged version is
    /// a second copy — and the clone is left with nothing uncommitted.
    #[test]
    fn a_staged_rename_and_a_twice_changed_file_are_moved_aside() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (_bare, clone) = diverged(tmp.path(), (MINE, "mine"), (THEIRS, "theirs"));
        commit_file(&clone, SAME, "v1", "same v1");
        git(&clone, &["mv", MINE, "library/knowledge/renamed.md"]);
        std::fs::write(clone.join(SAME), "staged").unwrap();
        git(&clone, &["add", SAME]);
        std::fs::write(clone.join(SAME), "edited again").unwrap();
        let moved = move_aside_in(&clone, &aside, chrono::Utc::now()).expect("moved");
        let dir = PathBuf::from(&moved.dir);
        assert_eq!(std::fs::read_to_string(dir.join("library/knowledge/renamed.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(dir.join(SAME)).unwrap(), "edited again");
        assert_eq!(std::fs::read_to_string(dir.join("staged").join(SAME)).unwrap(), "staged");
        assert!(uncommitted_paths(&clone).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(clone.join(MINE)).unwrap(), "mine", "the source is back");
        assert!(!clone.join("library/knowledge/renamed.md").exists());
    }

    /// Challenger: a Publish that had to rebase again and then failed to
    /// push keeps the choices undoable, back to the first backup.
    #[test]
    fn a_publish_that_rebases_and_fails_keeps_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let aside = tmp.path().join("team-set-aside");
        let (bare, clone) = diverged(tmp.path(), (SAME, "my version"), (SAME, "their version"));
        let before = rev(&clone, "HEAD");
        assert_eq!(settle(&clone, &aside, &[(SAME, ReapplyChoice::Mine)]).result, ReapplyResult::Resolved);
        let other = tmp.path().join("teammate");
        git(&other, &["pull", "--quiet"]);
        commit_file(&other, "library/knowledge/later.md", "later", "teammate again");
        git(&other, &["push", "--quiet"]);
        let hook = bare.join("hooks").join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let failed = reapply_with(&clone, std::time::Duration::from_secs(20)).unwrap();
        assert!(matches!(failed.result, ReapplyResult::PushDenied | ReapplyResult::PushRefused), "{failed:?}");
        assert!(library_resolved(&clone).is_some(), "still undoable");
        undo_resolved_in(&clone).expect("undone");
        assert_eq!(rev(&clone, "HEAD"), before);
    }

    /// The schema of the choices on the wire.
    #[test]
    fn choices_read_as_the_page_sends_them() {
        let choices: std::collections::BTreeMap<String, ReapplyChoice> =
            serde_json::from_str(r#"{"a.md":"mine","b.md":"theirs","c.md":"both"}"#).unwrap();
        assert_eq!(choices["a.md"], ReapplyChoice::Mine);
        assert_eq!(choices["b.md"], ReapplyChoice::Theirs);
        assert_eq!(choices["c.md"], ReapplyChoice::Both);
        let report = serde_json::to_value(ReapplyResult::Resolved).unwrap();
        assert_eq!(report, "resolved");
    }

}

/// N14 item 8: the team clone's own commits name the publishing account.
#[cfg(test)]
mod commit_identity_tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    #[test]
    fn a_library_write_is_committed_as_the_publishing_account() {
        let dir = tempfile::tempdir().unwrap();
        let clone = dir.path();
        git(clone, &["init", "-q", "--initial-branch=main", "."]);
        git(clone, &["config", "user.name", "Global Person"]);
        git(clone, &["config", "user.email", "person@example.invalid"]);
        std::fs::write(clone.join("team.json"), b"{}\n").unwrap();
        git(clone, &["add", "--", "team.json"]);
        let identity = crate::commit_identity::CommitIdentity { login: "team-bot".into(), id: 42 };
        commit_staged(clone, &["team.json"], "team: manifest", &identity.git_args()).unwrap();
        assert_eq!(
            git(clone, &["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(),
            "team-bot <42+team-bot@users.noreply.github.com>|team-bot <42+team-bot@users.noreply.github.com>"
        );
        assert_eq!(git(clone, &["config", "user.name"]).trim(), "Global Person");

        // Through the real writer: no GitHub origin here, so the global
        // identity, without asking GitHub.
        std::fs::write(clone.join("team.json"), b"{\"a\":1}\n").unwrap();
        assert!(RealLibraryGit.commit(clone, &["team.json".to_string()], "team: change").unwrap());
        assert_eq!(
            git(clone, &["log", "-1", "--format=%an <%ae>"]).trim(),
            "Global Person <person@example.invalid>"
        );
    }
}

/// F2: the team library's commits are Plyloft's own — bounded, never
/// signed, never refused or held by the member's hooks — and conventional.
#[cfg(test)]
mod own_commit_tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        crate::git::capture(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    fn hook(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A clone whose config signs every commit with a key program that
    /// can't run and whose hooks refuse every commit.
    fn hostile_clone(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let clone = root.join("clone");
        let hooks = root.join("hooks");
        std::fs::create_dir_all(&clone).unwrap();
        std::fs::create_dir_all(&hooks).unwrap();
        git(&clone, &["init", "-q", "--initial-branch=main", "."]);
        git(&clone, &["config", "user.name", "Person"]);
        git(&clone, &["config", "user.email", "person@example.invalid"]);
        git(&clone, &["config", "commit.gpgSign", "true"]);
        git(&clone, &["config", "gpg.program", &root.join("no-such-gpg").to_string_lossy()]);
        git(&clone, &["config", "core.hooksPath", &hooks.to_string_lossy()]);
        hook(&hooks, "pre-commit", "echo refused by pre-commit >&2\nexit 1");
        hook(&hooks, "commit-msg", "echo refused by commit-msg >&2\nexit 1");
        (clone, hooks)
    }

    #[test]
    fn a_library_commit_is_never_signed_nor_refused_by_a_hook() {
        let dir = tempfile::tempdir().unwrap();
        let (clone, _) = hostile_clone(dir.path());
        std::fs::write(clone.join("team.json"), b"{}\n").unwrap();
        git(&clone, &["add", "--", "team.json"]);
        // The way git itself would commit here: refused.
        assert!(crate::git::run(&clone, &["commit", "-q", "-m", "x"]).is_err(), "the setup must bite");

        commit_staged(&clone, &["team.json"], "team: add alice as a member", &[]).expect("committed");
        assert_eq!(git(&clone, &["log", "-1", "--format=%s|%G?"]).trim(), "chore(library): add alice as a member|N");

        std::fs::write(clone.join("team.json"), b"{\"a\":1}\n").unwrap();
        assert!(RealLibraryGit.commit(&clone, &["team.json".to_string()], "skills: share \"x\" with the team").unwrap());
        assert_eq!(git(&clone, &["log", "-1", "--format=%s"]).trim(), "chore(library): share \"x\" with the team");
    }

    /// F2 follow-up: `--no-verify` doesn't skip `prepare-commit-msg` or
    /// `post-commit`; the empty hooks folder does — no hook runs at all.
    #[test]
    fn a_library_commit_runs_no_hook_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let (clone, hooks) = hostile_clone(dir.path());
        hook(&hooks, "prepare-commit-msg", "echo refused by prepare-commit-msg >&2\nexit 1");
        let ran = dir.path().join("post-commit-ran");
        hook(&hooks, "post-commit", &format!("touch '{}'\nsleep 30", ran.display()));
        std::fs::write(clone.join("team.json"), b"{}\n").unwrap();
        git(&clone, &["add", "--", "team.json"]);
        // `--no-verify` alone would still be refused by prepare-commit-msg.
        assert!(
            crate::git::run(&clone, &["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "x"]).is_err(),
            "the setup must bite"
        );
        let started = std::time::Instant::now();
        commit_staged(&clone, &["team.json"], "team: manifest", &[]).expect("committed");
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
        assert_eq!(git(&clone, &["log", "-1", "--format=%s"]).trim(), "chore(library): manifest");
        assert!(!ran.exists(), "post-commit never ran");
    }
}
