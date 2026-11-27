//! Skills hub H10 (`docs/plans/SKILLS_HUB.md` R6, §5.3, §5.8, §9, §14 Q4/Q5/
//! Q6/Q22/Q28): **My library** — the member's own private GitHub repository of
//! skills, in the team library's layout, cloned on each Mac that uses it,
//! pulled in the background with the team library, and delivered to every
//! session as the plugin `mine` (`mine:<skill>`, Claude and Codex).
//!
//! - **Where.** The clone is `<config_dir>/my-library/<owner>__<name>/`
//!   (`team::slug_dir_name`); `settings.library.myLibrary { repo, account }`
//!   names it per Mac; its pull record is `skills_hub/state.json` →
//!   `libraries["library:<owner>/<name>"]`.
//! - **Which account.** Every `gh` and network `git` of My library runs in
//!   the scope of the login that owns the repository (`account`), so a Mac
//!   whose gh active account is a work login still reaches the personal repo
//!   (§5.3 Challenger). Any gh account; it needn't match the Plyloft account
//!   (§14 Q6). Under the login itself, never an organisation (§14 Q5).
//! - **Create** (`gh repo create <login>/<name> --private`) seeds the layout
//!   — `library/claude/mine/` (a Claude Code plugin), `library/codex/` (a
//!   Codex marketplace `plyloft-mine` with the plugin `mine`) and a README —
//!   optionally with chosen skills of this Mac (copied; the originals stay),
//!   commits it in a scratch directory, pushes and renames the scratch into
//!   place, so nothing is half-made. Skills only: no `library/knowledge`
//!   (§14 Q22).
//! - **Use it on this Mac** clones it into a scratch directory and renames it
//!   in on success; offline it says so and leaves nothing.
//! - **Publish** (Promote → My library) never overrides the other Mac: each
//!   Mac records, per skill, the version it last published or kept
//!   (`state.json` → `myLibraryBases`). When GitHub's copy moved since then
//!   (the other Mac published), the publish stops at the in-app 3-way compare
//!   (§14 Q4: no pull request against yourself) — *Keep this Mac's* or *Keep
//!   the other's* — and either answer is refused if GitHub moved again while
//!   the compare was open. This is the only push Plyloft makes to the member's
//!   own repository, scoped exactly like `card_ship`: only the member's own My
//!   library, only the skill they pressed Publish for, never forced (a push
//!   that loses a race is undone locally and retried once from GitHub's tip;
//!   one the time limit stopped is kept, and goes with the next publish).
//! - **Gone** (R6 edge, R16): a fetch GitHub answers with *not found*, which
//!   `gh repo view` confirms, marks the library gone. The last clone keeps
//!   reaching sessions; the member may *Create it again* (re-create the
//!   private repo and push this Mac's clone), *Point to another repository…*
//!   or *Stop using it on this Mac* (the clone goes to the Trash / Recycle
//!   Bin; linked copies in repositories stay).
//! - **Plans** (§9): create, use, pull and publish are open on every plan.
//! - **Scripts** (R15, H6a): My library deliveries go through the same
//!   snapshot path as the team library's, so a skill that brings a script
//!   waits for this Mac's OK (`skill_scripts::library_id` names the origin
//!   `library:<owner>/<name>`).
//! - **Exit (Hard rule 4):** every network git runs bounded in the exit
//!   registry; `gh` calls are bounded too; nothing is long-lived.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::MyLibrarySettings;
use crate::skill_card::SourceFile;
use crate::skills_hub_state::{my_library_base_key, my_library_key};

/// The plugin My library is delivered as (`mine:<skill>`).
pub(crate) const PLUGIN: &str = "mine";
/// Its Codex marketplace's name in the overlay (R6 Challenger).
pub(crate) const MARKETPLACE: &str = "plyloft-mine";
/// The repository name the create sheet suggests.
pub(crate) const DEFAULT_NAME: &str = "plyloft-skills";
/// `gh repo create --description`.
pub(crate) const DESCRIPTION: &str = "Plyloft — my skills";
/// `<config_dir>/my-library/`.
pub(crate) const CLONES_DIR: &str = "my-library";

const PLUGIN_DESCRIPTION: &str = "My own skills, through Plyloft.";
const PLUGIN_VERSION: &str = "1.0.0";
const MARKETPLACE_DISPLAY_NAME: &str = "My library";

/// The words a refusal carries when the token lacks `repo` (the sheet shows
/// **Grant it** beside them; `myLibrary.ts` reads this marker).
pub(crate) const GRANT_MARKER: &str = "GitHub needs one more permission to create a private repository";
/// The words when GitHub couldn't be asked.
pub(crate) const OFFLINE_WORDS: &str = "Couldn't reach GitHub — try again when you're online.";
/// The refusal when the name is taken by a repository that is a My library
/// already (the sheet offers *Use it on this Mac*).
pub(crate) const ALREADY_A_LIBRARY_MARKER: &str = "is already a My library";

/// Network bounds: a clone of a small library, a push of one skill.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The bound of the one read after a push the bound stopped (A5R-09): one
/// small ref, so a press never waits a second push's worth for it.
const LANDED_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// [`LANDED_READ_TIMEOUT`], never longer than a network git's own bound.
fn landed_read_timeout() -> std::time::Duration {
    LANDED_READ_TIMEOUT.min(git_timeout())
}

/// The bound of a network git: [`GIT_TIMEOUT`] (a test may set a shorter
/// one, after the tests module).
#[cfg(not(test))]
fn git_timeout() -> std::time::Duration {
    GIT_TIMEOUT
}

// ── Where it lives ───────────────────────────────────────────────────

/// `<config_dir>/my-library/<owner>__<name>/` (§5.8).
pub(crate) fn clone_dir(config_dir: &Path, repo: &str) -> PathBuf {
    config_dir.join(CLONES_DIR).join(crate::team::slug_dir_name(repo))
}

/// Whether `clone` is a My library clone (its parent is `my-library/`).
pub(crate) fn is_clone(clone: &Path) -> bool {
    clone
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == CLONES_DIR)
}

/// The My library clones on disk (the Inbox reads them without the settings
/// store; *Stop using it* and *Point to another* move the old one away, so
/// there is at most one in practice).
pub(crate) fn clones_on_disk(config_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(config_dir.join(CLONES_DIR)) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            !path.file_name().is_some_and(|name| name.to_string_lossy().starts_with('.'))
                && path.join(".git").exists()
        })
        .collect();
    out.sort();
    out
}

/// This Mac's My library setting, if any.
pub(crate) fn setting<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<MyLibrarySettings> {
    app.try_state::<crate::settings::SettingsStore>()
        .and_then(|store| store.snapshot().library.my_library)
        .filter(|mine| crate::team::is_valid_repo_slug(&mine.repo))
}

/// The clone sessions get My library from: set on this Mac and cloned.
/// Delivery is not plan-gated (§9).
pub(crate) fn delivered_clone<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let mine = setting(app)?;
    let config_dir = crate::skills_hub::config_dir(app).ok()?;
    let dir = clone_dir(&config_dir, &mine.repo);
    dir.join(".git").exists().then_some(dir)
}

/// The scope every GitHub call of My library runs in: its account's.
pub(crate) fn scope(account: Option<&str>) -> crate::github_account::GithubScope {
    crate::github_account::enter_for_team_with(account, |login| {
        crate::github_account::resolve(&crate::project_setup::Tools::production(), Some(login))
            .map_err(|words| account_words(login, &words))
    })
}

/// [`crate::github_account::resolve`]'s refusals, said about My library.
pub(crate) fn account_words(login: &str, words: &str) -> String {
    if words.contains("isn't installed") {
        return format!(
            "My library uses the GitHub account {login}, and the GitHub CLI isn't installed. Set it up \
             in Setup's GitHub step."
        );
    }
    format!(
        "My library uses the GitHub account {login}, which isn't signed in on {}. Sign it in in \
         Setup's GitHub step, then try again.",
        crate::platform::THIS_MACHINE
    )
}

// ── GitHub, behind a seam ────────────────────────────────────────────

/// What GitHub says about a repository name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepoState {
    /// No such repository for this account (deleted, renamed, never made, or
    /// not readable by it).
    Missing,
    /// It exists with no commit yet (a create that stopped before its push).
    Empty,
    /// It has the library layout (`library/claude` or `library/codex`).
    Library,
    /// It exists and is something else.
    NotLibrary,
}

/// The GitHub calls My library makes, so the flows are testable without the
/// network. Network git (clone, fetch, push) is real git in both.
pub(crate) trait Hub {
    /// The login these calls act as.
    fn login(&self) -> Result<String, String>;
    /// The scopes `login`'s token advertises; `None` when gh doesn't say
    /// (fine-grained tokens, `GH_TOKEN`): then nothing is asked up front.
    fn scopes(&self, login: &str) -> Option<Vec<String>>;
    /// `Err`: GitHub couldn't be asked.
    fn repo(&self, slug: &str) -> Result<RepoState, String>;
    /// `gh repo create <slug> --private`; `Err` carries gh's words.
    fn create(&self, slug: &str) -> Result<(), String>;
    /// The URL git clones and pushes.
    fn url(&self, slug: &str) -> String;
}

/// The production [`Hub`]: `gh`, in the calling thread's account scope.
pub(crate) struct RealHub;

fn gh_path() -> Result<String, String> {
    crate::doctor::require("gh").map_err(|_| {
        "My library needs the GitHub CLI (gh). Settings › Setup and account › Setup installs it.".to_string()
    })
}

fn gh_run(args: &[&str]) -> Result<String, String> {
    let gh = gh_path()?;
    let out = crate::github::gh_output(&gh, None, args, GH_TIMEOUT)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

impl Hub for RealHub {
    fn login(&self) -> Result<String, String> {
        match crate::github_account::scoped_login() {
            Some(found) => found,
            None => crate::project_setup::active_login(&crate::project_setup::Tools::production()),
        }
    }

    fn scopes(&self, login: &str) -> Option<Vec<String>> {
        gh_accounts()
            .into_iter()
            .find(|a| a.login.eq_ignore_ascii_case(login))
            .and_then(|a| a.scopes)
            .map(|scopes| parse_scopes(&scopes))
    }

    fn repo(&self, slug: &str) -> Result<RepoState, String> {
        // The chosen account signed out (or gh missing): its own words, never
        // "offline" or "not on GitHub" (Challenger: a signed-out account is a
        // sign-in problem, R16 edge).
        if let Some(Err(words)) = crate::github_account::scoped_login() {
            return Err(words);
        }
        let viewed = gh_run(&["repo", "view", slug, "--json", "isEmpty", "--jq", ".isEmpty"]);
        match viewed {
            Ok(empty) if empty.trim() == "true" => return Ok(RepoState::Empty),
            Ok(_) => {}
            Err(error) => return repo_missing_or_offline(&error),
        }
        match gh_run(&["api", &format!("repos/{slug}/contents/library"), "--jq", ".[].name"]) {
            Ok(names) => Ok(if names.lines().any(|n| matches!(n.trim(), "claude" | "codex")) {
                RepoState::Library
            } else {
                RepoState::NotLibrary
            }),
            Err(error) => match crate::github::classify_gh_error(&error) {
                crate::github::GhErrorKind::Denied => Ok(RepoState::NotLibrary),
                _ => Err(OFFLINE_WORDS.to_string()),
            },
        }
    }

    fn create(&self, slug: &str) -> Result<(), String> {
        gh_run(&["repo", "create", slug, "--private", "--description", DESCRIPTION]).map(|_| ())
    }

    fn url(&self, slug: &str) -> String {
        format!("https://github.com/{slug}.git")
    }
}

/// Pure: `gh repo view`'s refusal — a missing repository, or no answer.
pub(crate) fn repo_missing_or_offline(error: &str) -> Result<RepoState, String> {
    let lower = error.to_ascii_lowercase();
    if lower.contains("could not resolve to a repository") {
        return Ok(RepoState::Missing);
    }
    match crate::github::classify_gh_error(error) {
        crate::github::GhErrorKind::Denied => Ok(RepoState::Missing),
        _ => Err(OFFLINE_WORDS.to_string()),
    }
}

/// Pure: `"gist, read:org, repo"` → the scope names.
pub(crate) fn parse_scopes(scopes: &str) -> Vec<String> {
    scopes
        .split(',')
        .map(|s| s.trim().trim_matches('\'').trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// The accounts gh has signed in on github.com (a local read).
pub(crate) fn gh_accounts() -> Vec<crate::setup_run::GhAccount> {
    let tools = crate::project_setup::Tools::production();
    let Ok(mut status) = tools.gh(None) else {
        return Vec::new();
    };
    status.args(["auth", "status", "--json", "hosts"]);
    crate::project_setup::run(&mut status, std::time::Duration::from_secs(10))
        .ok()
        .and_then(|ran| crate::setup_run::gh_accounts(&ran.stdout))
        .unwrap_or_default()
}

// ── Plain words ──────────────────────────────────────────────────────

/// Pure: a refused fetch or push that means "no network".
pub(crate) fn is_offline(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    [
        "could not resolve host",
        "unable to access",
        "network is unreachable",
        "couldn't connect",
        "could not connect",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "no route to host",
        "didn't answer in time",
        "was stopped after",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Pure: a refused fetch or push that says the repository isn't there.
pub(crate) fn is_not_found(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("repository not found") || (lower.contains("repository '") && lower.contains("' not found"))
}

/// Pure: a `gh repo create` refusal that is the missing `repo` scope.
pub(crate) fn is_permission_refusal(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("http 403")
        || lower.contains("resource not accessible")
        || lower.contains("must have admin rights")
        || lower.contains("insufficient")
        || lower.contains("scope")
}

/// The sentence for a missing `repo` permission.
pub(crate) fn grant_words() -> String {
    format!("{GRANT_MARKER} — Grant it, then try again. Nothing was created.")
}

/// Pure: the sentence for a refused network git of My library. Sign-in
/// problems read as everywhere else (H4 step 13: `team::SIGN_IN_MARKER`).
pub(crate) fn network_words(doing: &str, detail: &str) -> String {
    // The chosen account can't be used here: its own words, which name it.
    if let Some(at) = detail.find("My library uses the GitHub account") {
        return detail[at..].trim().to_string();
    }
    if let Some(ssh) = crate::team::sign_in_cause(detail) {
        return if ssh {
            format!(
                "Plyloft couldn't {doing}: Git couldn't sign in to GitHub over SSH. Nothing reached \
                 GitHub. Check your SSH key, or use HTTPS with the GitHub CLI's sign-in, then try again."
            )
        } else {
            format!(
                "Plyloft couldn't {doing}: {}{}. Nothing reached GitHub. Sign in to GitHub in \
                 Settings › Setup and account › Setup › GitHub accounts, then try again.",
                crate::team::SIGN_IN_MARKER,
                crate::platform::THIS_MACHINE
            )
        };
    }
    if is_offline(detail) {
        return format!("{OFFLINE_WORDS} Nothing was changed.");
    }
    format!("Plyloft couldn't {doing}. GitHub said: {}", detail.trim())
}

/// Pure: a repository name GitHub would accept.
pub(crate) fn name_problem(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return Some("Give the repository a name.".into());
    }
    if name.len() > 100 {
        return Some("A repository name is at most 100 characters.".into());
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Some("A repository name can't start with a dot.".into());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Some("Use letters, digits, - _ and . only.".into());
    }
    None
}

/// Pure (§14 Q5, the scoped push exception): My library is a repository of
/// the account's own login — never an organisation's, someone else's, or the
/// team library. `team` is the team library's `owner/name` on this computer.
pub(crate) fn ownership_problem(slug: &str, login: &str, team: Option<&str>) -> Option<String> {
    let owner = slug.split('/').next().unwrap_or_default();
    if !owner.eq_ignore_ascii_case(login) {
        return Some(format!(
            "`{slug}` belongs to {owner}, not to {login}. My library is a repository of your own \
             account: pick one under {login}, or choose the account that owns it."
        ));
    }
    if team.is_some_and(|team| team.eq_ignore_ascii_case(slug)) {
        return Some(format!(
            "`{slug}` is your team's library. My library is a repository of its own: pick another \
             name."
        ));
    }
    None
}

/// Pure: whether a remote URL names `slug` (`expected` is the URL Plyloft
/// cloned it from; an `https`/`ssh` GitHub URL of the same `owner/name`
/// counts too).
pub(crate) fn names_repo(url: &str, expected: &str, slug: &str) -> bool {
    let norm = |u: &str| {
        let u = u.trim().trim_end_matches('/');
        u.strip_suffix(".git").unwrap_or(u).to_ascii_lowercase()
    };
    norm(url) == norm(expected)
        || crate::team::origin_slug(url).is_some_and(|found| found.eq_ignore_ascii_case(slug))
}

/// The scoped push exception, checked before every push: the clone's
/// `origin` — where it fetches *and* where it pushes — is My library's own
/// repository (`settings.library.myLibrary.repo`), nothing else.
fn check_origin(hub: &dyn Hub, clone: &Path, slug: &str) -> Result<(), String> {
    let expected = hub.url(slug);
    for args in [&["remote", "get-url", "origin"][..], &["remote", "get-url", "--push", "origin"][..]] {
        let url = git(clone, args).map(|u| u.trim().to_string()).unwrap_or_default();
        if !names_repo(&url, &expected, slug) {
            return Err(format!(
                "My library's copy on {} points somewhere other than `{slug}` ({}). Nothing was \
                 pushed. Stop using it on {} and use `{slug}` again.",
                crate::platform::THIS_MACHINE,
                if url.is_empty() { "no remote" } else { url.as_str() },
                crate::platform::THIS_MACHINE
            ));
        }
    }
    Ok(())
}

/// The one push of My library: this clone's branch to the same branch of its
/// own `origin`, by an explicit refspec with no `+` — never forced, never
/// another branch or remote, whatever the member's git config says.
fn push_branch(clone: &Path) -> Result<(), NetworkFailure> {
    let refspec = format!("HEAD:refs/heads/{}", branch(clone));
    network_git_outcome(clone, &["push", "--quiet", "origin", &refspec])
}

/// [`push_branch`]; a push the bound stopped that GitHub's branch shows
/// landed went through (A5R-09): only a read, never a second push.
fn push_and_read(clone: &Path) -> Result<(), NetworkFailure> {
    push_branch(clone).or_else(|failure| if failure.timed_out && landed_on_github(clone) { Ok(()) } else { Err(failure) })
}

/// 1.176.4 (owner 2026-11-23): the words for a commit kept after a push the
/// bound stopped — neither added nor not added.
fn kept_words(skill: &str) -> String {
    format!(
        "GitHub didn't answer in time while Plyloft was adding `{skill}` to My library. It is kept \
         in My library on {}, and may not be on GitHub yet: it goes there only when you add a skill \
         to My library again and that push goes through.",
        crate::platform::THIS_MACHINE
    )
}

/// 1.176.4 review (S1): the commits this clone has that GitHub's branch (as
/// last fetched) lacks, oldest first.
fn ahead_commits(clone: &Path) -> Result<Vec<String>, String> {
    let out = git(clone, &["rev-list", "--reverse", "@{upstream}..HEAD"]).map_err(|error| {
        log::warn!("my library: couldn't list the commits ahead of GitHub: {error}");
        couldnt_read_words()
    })?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

/// Round 2 (R2-M1): a git read of the clone that failed — never taken for a
/// commit Plyloft didn't make.
fn couldnt_read_words() -> String {
    format!(
        "Plyloft couldn't read what My library on {} holds, so nothing was published. Try again.",
        crate::platform::THIS_MACHINE
    )
}

/// 1.176.4 review (S1): the skills `commits` add, when every one is a
/// Plyloft *Add to My library* commit (one parent, its own subject) touching
/// only a skill's two directories and the three manifests; else the words
/// that refuse to send them — only Plyloft's own goes to GitHub. A commit
/// made by hand that imitates one (that subject, only skill files) passes:
/// its content is skill files either way. Paths are read NUL-separated
/// (round 2, R2-M1), so a name that isn't ASCII is read as it is.
fn own_skills(clone: &Path, commits: &[String]) -> Result<std::collections::BTreeSet<String>, String> {
    let claude = format!("library/claude/{PLUGIN}/skills/");
    let codex = format!("library/codex/plugins/{PLUGIN}/skills/");
    let manifests = publish_paths("x").split_off(2);
    let sample = crate::commit_message::library_message("add x");
    let subject = sample.strip_suffix('x').unwrap_or(&sample);
    let read = |args: &[&str]| {
        git(clone, args).map_err(|error| {
            log::warn!("my library: couldn't read a commit ahead of GitHub: {error}");
            couldnt_read_words()
        })
    };
    let mut skills = std::collections::BTreeSet::new();
    for commit in commits {
        let info = read(&["log", "-1", "--format=%P%x1f%s", commit])?;
        let (parents, said) = info.trim().split_once('\u{1f}').unwrap_or((info.trim(), ""));
        let paths = read(&["diff-tree", "-z", "--no-commit-id", "--name-only", "-r", commit])?;
        let mut own = parents.split_whitespace().count() == 1 && said.starts_with(subject);
        for path in paths.split('\0').map(|p| p.trim_matches('\n')).filter(|p| !p.is_empty()) {
            match path.strip_prefix(&claude).or_else(|| path.strip_prefix(&codex)).and_then(|rest| rest.split_once('/')) {
                Some((name, _)) if !name.is_empty() => {
                    skills.insert(name.to_string());
                }
                _ if manifests.iter().any(|m| m == path) => {}
                _ => own = false,
            }
        }
        if !own {
            log::warn!("my library: {commit} ({}) isn't Plyloft's own; nothing is pushed", said.trim());
            return Err(format!(
                "My library on {} holds a commit Plyloft didn't make, so Plyloft sends nothing from it \
                 to GitHub. Nothing was published. {}",
                crate::platform::THIS_MACHINE,
                way_out_words()
            ));
        }
    }
    Ok(skills)
}

/// Whether a tracked file in the clone (its working copy or what is staged)
/// differs from `HEAD`
/// by more than its line endings — what a `reset --hard` would lose.
/// A file that differs only by CR at the end of its lines is no edit: a
/// clone checked out with `core.autocrlf=true` (Git for Windows' default)
/// and read later by a git with it off lists every such file as modified,
/// and a reset loses nothing there. Judged from the patch, not an exit
/// code (`--quiet` with an `--ignore-*` option has not always run the
/// diff): a hunk, a binary difference, a mode change, a file added or
/// deleted is an edit; a header with nothing under it is not.
fn edited_beyond_line_endings(clone: &Path) -> Result<bool, String> {
    // The working tree against HEAD, and the index against HEAD (a change
    // staged and then undone in the working tree is still one a reset loses).
    let flags = ["--ignore-cr-at-eol", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "-U0", "--"];
    let mut patch = git(clone, &[&["diff", "HEAD"][..], &flags[..]].concat())?;
    patch.push('\n');
    patch.push_str(&git(clone, &[&["diff", "--cached", "HEAD"][..], &flags[..]].concat())?);
    let edit = patch.lines().find(|line| {
        line.starts_with("@@")
            || line.starts_with("Binary files ")
            || line.starts_with("GIT binary patch")
            || line.starts_with("old mode ")
            || line.starts_with("new mode ")
            || line.starts_with("new file mode ")
            || line.starts_with("deleted file mode ")
    });
    if let Some(line) = edit {
        log::warn!("my library: an edit in the clone ({line}); nothing published");
    }
    Ok(edit.is_some())
}

/// Round 3 (R3-S1): the way out of a press that stops for good — the
/// buttons' own labels (`MyLibrary.tsx`: *Stop using it on this Mac*, which
/// moves the copy to the Trash / Recycle Bin, then *Use it on this Mac*,
/// which copies GitHub's afresh).
fn way_out_words() -> String {
    let m = crate::platform::THIS_MACHINE;
    format!(
        "To start again from GitHub's copy, choose Stop using it on {m} in My library, then Use it on \
         {m}: the copy on {m} goes to {}.",
        crate::trash::BIN
    )
}

/// Round 3 (R3-S2): a push that carried kept skills and failed for a reason
/// not taken for a refusal: `words`, then the kept skills it carried — they
/// stay kept — and, unless it was offline or a sign-in, the way out.
fn with_kept_carried(words: String, kept: &std::collections::BTreeSet<String>, detail: &str) -> String {
    if kept.is_empty() {
        return words;
    }
    let mut out = format!(
        "{words} It also carried {}, kept on {} from an earlier press; {} still kept.",
        names(kept),
        crate::platform::THIS_MACHINE,
        if kept.len() == 1 { "it is" } else { "they are" }
    );
    if !is_offline(detail) && crate::team::sign_in_cause(detail).is_none() {
        let way = way_out_words();
        out.push_str(" If this keeps happening, t");
        out.push_str(way.strip_prefix('T').unwrap_or(&way));
    }
    out
}

/// Round 2 (R2-S3): why commits couldn't be set aside — the person's words;
/// git's go to the log.
fn set_aside_failed_words(dirty: bool) -> String {
    if dirty {
        format!(
            "My library on {} has changes to its files that aren't in a commit, so Plyloft left it \
             as it is. Nothing was published. {}",
            crate::platform::THIS_MACHINE,
            way_out_words()
        )
    } else {
        format!(
            "Plyloft couldn't put My library on {} back to GitHub's copy. Nothing was published.",
            crate::platform::THIS_MACHINE
        )
    }
}

/// 1.176.4 review (M1): commits that can't go to GitHub (GitHub refused them,
/// or GitHub moved meanwhile) are set aside, never lost: a backup ref first,
/// as the team library's (`refs/ply/backup/…`, said only in the log), then
/// the clone goes back to GitHub's branch and each skill's base back to its
/// version there before them. Nothing is written to GitHub. A clone with
/// edits to tracked files is left as it is (round 2, R2-S3): a reset would
/// lose them, and a backup ref holds only commits.
fn set_aside(config_dir: &Path, repo: &str, clone: &Path, skills: &std::collections::BTreeSet<String>, now: i64) -> Result<(), String> {
    let failed = |error: String| {
        log::warn!("my library: couldn't set aside the commits GitHub doesn't have: {error}");
        set_aside_failed_words(false)
    };
    if edited_beyond_line_endings(clone).map_err(failed)? {
        return Err(set_aside_failed_words(true));
    }
    let tip = head(clone).ok_or_else(|| failed("no HEAD".to_string()))?;
    let before = git(clone, &["merge-base", "HEAD", "@{upstream}"]).map_err(failed)?.trim().to_string();
    let at = chrono::DateTime::from_timestamp_millis(now).unwrap_or_else(chrono::Utc::now);
    let backup = crate::team::record_backup(clone, &tip, at).map_err(failed)?;
    log::info!("my library: {} set aside as {backup}", names(skills));
    git(clone, &["reset", "--quiet", "--hard", "@{upstream}"]).map_err(failed)?;
    for skill in skills {
        let id = skill_id_at(clone, &before, skill);
        crate::skills_hub_state::update(config_dir, now, |state| {
            let key = my_library_base_key(repo, skill);
            match id {
                Some(id) => state.my_library_bases.insert(key, id),
                None => state.my_library_bases.remove(&key),
            }
        })
        .map_err(failed)?;
    }
    Ok(())
}

fn names(skills: &std::collections::BTreeSet<String>) -> String {
    let named: Vec<String> = skills.iter().map(|s| format!("`{s}`")).collect();
    match named.as_slice() {
        [] => "a skill".to_string(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// M1: GitHub moved while kept commits waited here. No ref, path or git
/// output (round 2, R2-S1: the team library's rule).
fn moved_aside_words(skills: &std::collections::BTreeSet<String>) -> String {
    format!(
        "My library changed on GitHub while {} waited on {} to go there, so My library on {} went \
         back to GitHub's copy. Plyloft keeps a copy of it on {}; add the skill again to send it.",
        names(skills),
        crate::platform::THIS_MACHINE,
        crate::platform::THIS_MACHINE,
        crate::platform::THIS_MACHINE
    )
}

/// M1: GitHub refused a push that carried kept commits. Every skill the
/// push carried is named, the pressed one too (round 2, R2-S2): the push
/// can't tell which one GitHub refused. git's words go to the log.
fn refused_aside_words(carried: &std::collections::BTreeSet<String>) -> String {
    format!(
        "GitHub didn't take the push of {} to My library, so My library on {} went back to \
         GitHub's copy. Nothing was published. Plyloft keeps a copy of it on {}; add the skill \
         again to send it.",
        names(carried),
        crate::platform::THIS_MACHINE,
        crate::platform::THIS_MACHINE
    )
}

/// M1: a push GitHub itself refused — not a race, not a sign-in, not
/// offline, and (round 2, R2-S4) not one of GitHub's passing answers: a
/// server error, `(failure)`, a rate limit. Those are failures like any
/// other: this press's commit is undone and earlier kept ones stay kept.
fn github_refused(words: &str) -> bool {
    let lower = words.to_lowercase();
    let passing = ["internal server error", "(failure)", "rate limit", "http 500", "http 502", "http 503", "error: 500", "error: 502", "error: 503"]
        .iter()
        .any(|w| lower.contains(w));
    !passing
        && crate::team::github_refused_push(words)
        && crate::team::sign_in_cause(words).is_none()
        && !crate::team::push_refused_by_a_race(words)
}

/// A network git that didn't go through: git's words, and whether the bound
/// stopped it (a push stopped there may have reached GitHub).
struct NetworkFailure {
    timed_out: bool,
    words: String,
}

/// 1.176.3 (A5R-09, owner 2026-11-23): whether GitHub's branch is this
/// clone's `HEAD` — read once with `ls-remote` (bounded, a read only) after a
/// push the bound stopped. Unknown counts as not there.
fn landed_on_github(clone: &Path) -> bool {
    let Some(here) = head(clone) else { return false };
    let wanted = format!("refs/heads/{}", branch(clone));
    let mut cmd = crate::platform::git_command();
    if crate::github_account::apply_to_network_git(&mut cmd, clone).is_err() {
        return false;
    }
    cmd.args(crate::team::library_git_config(clone))
        .args(["ls-remote", "origin", &wanted])
        .current_dir(clone)
        .env("GIT_TERMINAL_PROMPT", "0");
    match crate::worktrees::run_bounded_output(&mut cmd, landed_read_timeout()) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .any(|(sha, name)| name.trim() == wanted && sha.trim() == here),
        _ => false,
    }
}

// ── git on the clone ─────────────────────────────────────────────────

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    crate::team::library_git_capture(dir, args)
}

/// One bounded network git (clone, fetch, push), in this thread's scope.
fn network_git(dir: &Path, args: &[&str]) -> Result<(), String> {
    network_git_outcome(dir, args).map_err(|failure| failure.words)
}

/// [`network_git`], saying whether the bound stopped it.
fn network_git_outcome(dir: &Path, args: &[&str]) -> Result<(), NetworkFailure> {
    use crate::worktrees::BoundedFailure;
    let config = crate::team::library_git_config(dir);
    let configured: Vec<&str> = config.iter().map(String::as_str).chain(args.iter().copied()).collect();
    let out = crate::worktrees::run_bounded_network_git_in(dir, &configured, git_timeout(), crate::worktrees::exit_registry())
        .map_err(|failure| NetworkFailure {
            timed_out: matches!(failure, BoundedFailure::TimedOut),
            words: match failure {
                BoundedFailure::TimedOut => format!("GitHub didn't answer in time (`git` was stopped after {}s)", git_timeout().as_secs()),
                BoundedFailure::Spawn(words) => words,
                BoundedFailure::Quitting => "Plyloft is quitting".to_string(),
                BoundedFailure::Truncated => "git's output was cut short".to_string(),
            },
        })?;
    if out.status.success() {
        Ok(())
    } else {
        Err(NetworkFailure { timed_out: false, words: String::from_utf8_lossy(&out.stderr).trim().to_string() })
    }
}

fn head(dir: &Path) -> Option<String> {
    git(dir, &["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn branch(dir: &Path) -> String {
    git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "HEAD")
        .unwrap_or_else(|| "main".to_string())
}

/// Who a My library commit is by: the GitHub account that pushes it (this
/// thread's scope, `commit_identity`), else git's own identity, else — a
/// computer with no git identity at all — "Plyloft", so the commit is never
/// refused over it.
fn identity_args(dir: &Path) -> Vec<String> {
    let identity = crate::commit_identity::args_for(dir);
    if !identity.is_empty() {
        return identity;
    }
    let known = git(dir, &["config", "user.email"]).is_ok_and(|email| !email.trim().is_empty());
    if known {
        return Vec::new();
    }
    ["-c", "user.name=Plyloft", "-c", "user.email=plyloft@users.noreply.github.com"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// One lock for every write to a My library clone on this Mac.
fn lock() -> &'static parking_lot::Mutex<()> {
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    &LOCK
}

/// A scratch directory beside the clones, renamed in on success.
fn scratch(config_dir: &Path) -> Result<PathBuf, String> {
    let root = config_dir.join(CLONES_DIR);
    std::fs::create_dir_all(&root).map_err(|error| format!("create {}: {error}", root.display()))?;
    Ok(root.join(format!(".new-{}", uuid::Uuid::new_v4().simple())))
}

// ── The layout ───────────────────────────────────────────────────────

/// The skill's two directories in a My library clone.
pub(crate) fn skill_paths(skill: &str) -> [String; 2] {
    [
        format!("library/claude/{PLUGIN}/skills/{skill}"),
        format!("library/codex/plugins/{PLUGIN}/skills/{skill}"),
    ]
}

/// The paths one publish stages: the skill's two directories and the three
/// manifests (written only when absent).
fn publish_paths(skill: &str) -> Vec<String> {
    let [claude, codex] = skill_paths(skill);
    vec![
        claude,
        codex,
        format!("library/claude/{PLUGIN}/.claude-plugin/plugin.json"),
        format!("library/codex/plugins/{PLUGIN}/.codex-plugin/plugin.json"),
        "library/codex/.agents/plugins/marketplace.json".to_string(),
    ]
}

fn write_json_if_absent(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    crate::atomic::write_atomic_json(path, value)
}

/// The three manifests of My library, each written only when absent (a
/// member who edited theirs keeps it).
pub(crate) fn ensure_layout(clone: &Path) -> Result<(), String> {
    let manifest = serde_json::json!({
        "name": PLUGIN,
        "description": PLUGIN_DESCRIPTION,
        "version": PLUGIN_VERSION,
    });
    write_json_if_absent(
        &clone.join("library/claude").join(PLUGIN).join(".claude-plugin/plugin.json"),
        &manifest,
    )?;
    write_json_if_absent(
        &clone.join("library/codex/plugins").join(PLUGIN).join(".codex-plugin/plugin.json"),
        &manifest,
    )?;
    write_json_if_absent(
        &clone.join("library/codex/.agents/plugins/marketplace.json"),
        &serde_json::json!({
            "name": MARKETPLACE,
            "interface": { "displayName": MARKETPLACE_DISPLAY_NAME },
            "plugins": [{
                "name": PLUGIN,
                "source": { "source": "local", "path": format!("./plugins/{PLUGIN}") },
                "policy": { "installation": "AVAILABLE" },
            }],
        }),
    )
}

/// The README a new My library starts with.
pub(crate) fn readme(slug: &str) -> String {
    format!(
        "# My library\n\n\
         `{slug}` is a private repository of my own skills, kept by Plyloft. Plyloft clones it on \
         every computer I use it on and gives my Claude and Codex sessions its skills as the plugin \
         `{PLUGIN}` (`{PLUGIN}:<skill>`), from the next session after a change.\n\n\
         - `library/claude/{PLUGIN}/` is a Claude Code plugin; each skill is `skills/<name>/SKILL.md`.\n\
         - `library/codex/` is a Codex marketplace (`{MARKETPLACE}`) with the same skills under \
         `plugins/{PLUGIN}/skills/`.\n\n\
         Add or change a skill from Plyloft (All skills › a skill › Add to My library), or edit it \
         here. A skill that brings a script waits for an OK on each computer before sessions get it.\n"
    )
}

/// `files` written as a skill directory at `dir` (replacing what was there).
fn write_skill(dir: &Path, files: &[SourceFile]) -> Result<(), String> {
    let tree: Vec<crate::project_skills::TreeFile> = files
        .iter()
        .map(|f| crate::project_skills::TreeFile { path: f.path.clone(), executable: f.executable, bytes: f.bytes.clone() })
        .collect();
    crate::project_skills::write_tree(dir, &tree)
}

/// A skill directory on disk as source files: OS junk left out; a symbolic
/// link refused (`project_skills::read_tree`).
pub(crate) fn read_dir_files(dir: &Path) -> Result<Vec<SourceFile>, String> {
    let tree = crate::project_skills::read_tree(dir)?;
    let files: Vec<SourceFile> = tree
        .into_iter()
        .filter(|f| {
            !f.path
                .rsplit('/')
                .next()
                .is_some_and(crate::shared_library_sync::is_os_junk)
        })
        .map(|f| SourceFile { path: f.path, bytes: f.bytes, executable: f.executable })
        .collect();
    if files.is_empty() {
        return Err(format!("{} holds no files.", dir.display()));
    }
    Ok(files)
}

/// 1.175.0 (A7, SEC-7): the files a publish to My library reads from `dir` —
/// refused first, in the words Share with Team… uses, when the folder holds a
/// file that looks private (`.env*`, `*.pem`, `*.key`, `id_rsa*`) or a `.git`.
/// `in_checkout`: a repository's skill, whose file may be committed.
///
/// Round 3 (S3): through the one gate (`project_skills::refuse_unpublishable`),
/// so a file git ignores in a repository's checkout is left out.
pub(crate) fn publishable_files(skill: &str, dir: &Path, in_checkout: bool) -> Result<Vec<SourceFile>, String> {
    let left_out =
        crate::project_skills::refuse_unpublishable(skill, dir, in_checkout, "nothing was added to My library")
            .map_err(|refusal| refusal.to_string())?;
    let mut files = read_dir_files(dir)?;
    files.retain(|file| !left_out.contains(&file.path));
    if files.is_empty() {
        return Err(format!("{} holds no files.", dir.display()));
    }
    Ok(files)
}

/// The files of a git tree (`git ls-tree -r` of a tree id), for the compare.
pub(crate) fn tree_files(clone: &Path, tree: &str) -> Result<Vec<SourceFile>, String> {
    let out = crate::library_snapshot::git(clone, &["ls-tree", "-r", "-z", "-l", tree])?;
    let mut listed = Vec::new();
    for record in out.split(|byte| *byte == 0).filter(|record| !record.is_empty()) {
        let record = String::from_utf8_lossy(record);
        let Some((meta, path)) = record.split_once('\t') else { continue };
        let mut fields = meta.split_whitespace();
        let (mode, kind, id, size) = (fields.next(), fields.next(), fields.next(), fields.next());
        if kind != Some("blob") || !crate::library_snapshot::is_safe_tree_path(path) {
            continue;
        }
        listed.push(crate::library_snapshot::TreeFile {
            path: path.to_string(),
            id: id.unwrap_or_default().to_string(),
            size: size.and_then(|s| s.parse().ok()).unwrap_or(0),
            executable: mode == Some("100755"),
        });
    }
    let blobs = crate::library_snapshot::cat_blobs(clone, &listed)?;
    Ok(listed
        .into_iter()
        .zip(blobs)
        .map(|(f, bytes)| SourceFile { path: f.path, bytes, executable: f.executable })
        .collect())
}

// ── Create, use, recreate, stop ──────────────────────────────────────

/// What a create or use set up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Ready {
    pub repo: String,
    pub account: String,
    pub dir: PathBuf,
}

/// **Create My library** (R6): `<login>/<name>`, private, seeded, pushed;
/// `seed` the skills of this Mac to copy in (name, directory).
pub(crate) fn create_with(
    hub: &dyn Hub,
    config_dir: &Path,
    name: &str,
    seed: &[(String, PathBuf)],
) -> Result<Ready, String> {
    if let Some(problem) = name_problem(name) {
        return Err(problem);
    }
    let name = name.trim();
    let login = hub.login()?;
    let slug = format!("{login}/{name}");
    if hub.scopes(&login).is_some_and(|scopes| !scopes.iter().any(|s| s == "repo")) {
        return Err(grant_words());
    }
    let existing = hub.repo(&slug)?;
    match existing {
        RepoState::Library => {
            return Err(format!(
                "`{slug}` {ALREADY_A_LIBRARY_MARKER}. Use it on {} instead.",
                crate::platform::THIS_MACHINE
            ))
        }
        RepoState::NotLibrary => {
            return Err(format!("`{slug}` already exists and isn't a skills library. Pick another name."))
        }
        RepoState::Missing | RepoState::Empty => {}
    }
    let dest = clone_dir(config_dir, &slug);
    if dest.exists() {
        return Err(format!(
            "A copy of `{slug}` is already on {}. Stop using it there first.",
            crate::platform::THIS_MACHINE
        ));
    }
    // Copied from this Mac before anything is made: an unreadable skill stops
    // the create with nothing on GitHub.
    let mut skills: Vec<(String, Vec<SourceFile>)> = Vec::new();
    for (skill, dir) in seed {
        let skill = crate::project_skills::safe_name(skill)?;
        // A7: a private file stops the create too, with nothing on GitHub.
        let files = match crate::project_skills::refuse_unpublishable(&skill, dir, false, "nothing was added to My library") {
            Err(refusal) => return Err(refusal.to_string()),
            Ok(left_out) => {
                let mut files = read_dir_files(dir)
                    .map_err(|error| format!("Plyloft couldn't read `{skill}`: {error}. Nothing was created."))?;
                files.retain(|file| !left_out.contains(&file.path));
                files
            }
        };
        skills.push((skill, files));
    }

    let _guard = lock().lock();
    let work = scratch(config_dir)?;
    let made = (|| -> Result<(), String> {
        std::fs::create_dir_all(&work).map_err(|error| format!("create {}: {error}", work.display()))?;
        git(&work, &["init", "--quiet"])?;
        git(&work, &["checkout", "--quiet", "-b", "main"])?;
        git(&work, &["config", "core.longpaths", "true"])?;
        git(&work, &["remote", "add", "origin", &hub.url(&slug)])?;
        ensure_layout(&work)?;
        std::fs::write(work.join("README.md"), readme(&slug)).map_err(|error| format!("write README.md: {error}"))?;
        for (skill, files) in &skills {
            for path in skill_paths(skill) {
                write_skill(&work.join(&path), files)?;
            }
        }
        git(&work, &["add", "--all"])?;
        let identity = identity_args(&work);
        let message = crate::commit_message::library_message("create My library");
        crate::team::library_commit(&work, &identity, &["--quiet", "-m", &message])?;
        if existing == RepoState::Missing {
            hub.create(&slug).map_err(|error| {
                if is_permission_refusal(&error) {
                    grant_words()
                } else {
                    network_words(&format!("create `{slug}` on GitHub"), &error)
                }
            })?;
        }
        network_git(&work, &["push", "--quiet", "-u", "origin", "main"])
            .map_err(|error| network_words(&format!("put My library on GitHub (`{slug}`)"), &error))?;
        Ok(())
    })();
    if let Err(error) = made {
        let _ = std::fs::remove_dir_all(&work);
        return Err(error);
    }
    if let Err(error) = crate::platform::rename(&work, &dest) {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("My library is on GitHub, but Plyloft couldn't put its copy in place: {error}. Use it on {} to fetch it.", crate::platform::THIS_MACHINE));
    }
    Ok(Ready { repo: slug, account: login, dir: dest })
}

/// **Use it on this Mac** (R6): clone `slug` aside and rename it in.
pub(crate) fn use_with(hub: &dyn Hub, config_dir: &Path, slug: &str, team: Option<&str>) -> Result<Ready, String> {
    let slug = slug.trim().trim_end_matches(".git").trim_matches('/');
    if !crate::team::is_valid_repo_slug(slug) {
        return Err("Type the repository as owner/name.".into());
    }
    let login = hub.login()?;
    if let Some(problem) = ownership_problem(slug, &login, team) {
        return Err(problem);
    }
    match hub.repo(slug)? {
        RepoState::Library => {}
        RepoState::Missing => {
            return Err(format!("`{slug}` isn't on GitHub for the account {login}. Check the name, or create My library."))
        }
        RepoState::Empty | RepoState::NotLibrary => {
            return Err(format!("`{slug}` isn't a skills library (it has no library/ folder). Pick another repository."))
        }
    }
    let dest = clone_dir(config_dir, slug);
    let _guard = lock().lock();
    if dest.join(".git").exists() {
        return Ok(Ready { repo: slug.to_string(), account: login, dir: dest });
    }
    if dest.exists() {
        return Err(format!("{} exists but isn't a copy of My library. Remove it and try again.", dest.display()));
    }
    let work = scratch(config_dir)?;
    let parent = work.parent().map(Path::to_path_buf).unwrap_or_else(|| config_dir.to_path_buf());
    let work_arg = work.to_string_lossy().to_string();
    let cloned = network_git(&parent, &["clone", "--quiet", &hub.url(slug), &work_arg])
        .and_then(|()| git(&work, &["config", "core.longpaths", "true"]).map(|_| ()));
    if let Err(error) = cloned {
        let _ = std::fs::remove_dir_all(&work);
        return Err(network_words(&format!("copy `{slug}` to {}", crate::platform::THIS_MACHINE), &error));
    }
    crate::platform::rename(&work, &dest).map_err(|error| {
        let _ = std::fs::remove_dir_all(&work);
        format!("Plyloft couldn't put My library's copy in place: {error}")
    })?;
    Ok(Ready { repo: slug.to_string(), account: login, dir: dest })
}

/// **Find** (a second Mac): `<login>/plyloft-skills`, when it is a My library.
pub(crate) fn find_with(hub: &dyn Hub) -> Result<Option<String>, String> {
    let login = hub.login()?;
    let slug = format!("{login}/{DEFAULT_NAME}");
    Ok((hub.repo(&slug)? == RepoState::Library).then_some(slug))
}

/// **Create it again** (gone): the private repository again, this Mac's
/// clone pushed into it.
pub(crate) fn recreate_with(hub: &dyn Hub, clone: &Path, slug: &str) -> Result<(), String> {
    let _guard = lock().lock();
    let login = hub.login()?;
    if !slug.split('/').next().is_some_and(|owner| owner.eq_ignore_ascii_case(&login)) {
        return Err(format!(
            "`{slug}` belongs to another account than {login}. Sign in as its owner, or point My library to another repository."
        ));
    }
    check_origin(hub, clone, slug)?;
    match hub.repo(slug)? {
        RepoState::Missing => {
            hub.create(slug).map_err(|error| {
                if is_permission_refusal(&error) {
                    grant_words()
                } else {
                    network_words(&format!("create `{slug}` on GitHub again"), &error)
                }
            })?;
        }
        RepoState::Empty => {}
        RepoState::Library | RepoState::NotLibrary => {
            return Err(format!("`{slug}` is on GitHub again — nothing to create. Read it again."));
        }
    }
    push_branch(clone)
        .map_err(|failure| network_words(&format!("put My library back on GitHub (`{slug}`)"), &failure.words))
}

// ── The pull ─────────────────────────────────────────────────────────

/// How a pull of My library went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Pulled {
    /// Level with GitHub (`HEAD` after).
    Pulled(Option<String>),
    /// GitHub couldn't be asked.
    Offline,
    /// GitHub says the repository isn't there for this account.
    Gone,
    /// The clone holds a commit GitHub doesn't, and GitHub moved too.
    Held,
    /// Git couldn't sign in as My library's account (it was signed out of
    /// gh, or its sign-in is refused): a sign-in problem, never "gone".
    SignIn,
    /// Anything else, in words.
    Failed(String),
}

/// `git fetch` + fast-forward of the clone; a *not found* is confirmed with
/// `gh repo view` before it counts as gone.
pub(crate) fn pull_with(hub: &dyn Hub, clone: &Path, slug: &str) -> Pulled {
    let _guard = lock().lock();
    match crate::team::library_pull_in(clone, crate::team::LIBRARY_FETCH_TIMEOUT, crate::worktrees::exit_registry()) {
        Ok(()) => Pulled::Pulled(head(clone)),
        Err(crate::team::RemoteFailure::Diverged { .. }) => Pulled::Held,
        Err(crate::team::RemoteFailure::TimedOut { .. }) => Pulled::Offline,
        Err(crate::team::RemoteFailure::Refused(detail)) => {
            if detail.contains("My library uses the GitHub account") || crate::team::sign_in_cause(&detail).is_some() {
                Pulled::SignIn
            } else if is_not_found(&detail) {
                match hub.repo(slug) {
                    Ok(RepoState::Missing) => Pulled::Gone,
                    Ok(_) => Pulled::Failed(detail),
                    Err(_) => Pulled::Offline,
                }
            } else if is_offline(&detail) {
                Pulled::Offline
            } else {
                Pulled::Failed(detail)
            }
        }
    }
}

/// Pure: fold a pull into the library's record.
pub(crate) fn record_pull(lib: &mut crate::skills_hub_state::LibraryState, pulled: &Pulled, now: i64) {
    lib.last_attempt_at = Some(now);
    match pulled {
        Pulled::Pulled(head) => {
            lib.last_pull_at = Some(now);
            lib.last_pull_commit = head.clone();
            lib.last_error = None;
            lib.gone_at = None;
        }
        Pulled::Offline => lib.last_error = Some("offline".into()),
        Pulled::Gone => {
            lib.last_error = Some("gone".into());
            lib.gone_at.get_or_insert(now);
        }
        Pulled::Held => lib.last_error = Some("held".into()),
        Pulled::SignIn => lib.last_error = Some("signIn".into()),
        Pulled::Failed(_) => lib.last_error = Some("failed".into()),
    }
}

// ── Publish ──────────────────────────────────────────────────────────

/// The member's answer at the compare.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Choice {
    /// Publish this Mac's version over the other's.
    KeepThis,
    /// Leave My library as the other Mac published it.
    KeepOther,
}

/// The two-Mac compare (§14 Q4): the version both started from, the other
/// Mac's (GitHub's now) and this Mac's, per file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyCompare {
    pub skill: String,
    /// GitHub's version now, which an answer must still find there.
    pub other_id: String,
    pub other_author: Option<String>,
    pub other_at: Option<i64>,
    /// No version this Mac started from (it never published or kept this
    /// skill): 2-way, and said so.
    pub two_way: bool,
    pub files: Vec<crate::commands::skills_hub_decisions::Compare3File>,
}

/// A Windows config directory of usual length, for measuring on a Mac how
/// long a skill's paths would be in a PC's sessions (`%APPDATA%\com.mbadv.ply`
/// of a short user name).
pub(crate) const WINDOWS_CONFIG_ESTIMATE: &str = r"C:\Users\member\AppData\Roaming\com.mbadv.ply";

/// §8 (H10 Windows walk): the words when a skill's files would be too long
/// for Windows in a session snapshot under `config_dir` (this computer's on
/// Windows; [`WINDOWS_CONFIG_ESTIMATE`] elsewhere). `None` when they fit.
/// Said with [`crate::library_snapshot::PATH_TOO_LONG`], the words a skill
/// left out of a snapshot is named with.
pub(crate) fn too_long_for_windows(config_dir: &Path, clone: &Path, skill: &str, files: &[SourceFile]) -> Option<String> {
    let limit = crate::library_snapshot::WINDOWS_PATH_LIMIT;
    let mut longest: Option<(usize, String)> = None;
    for root in skill_paths(skill) {
        for file in files {
            let path = format!("{root}/{}", file.path);
            if let Some((_, units)) = crate::library_snapshot::delivered_path(config_dir, clone, &path) {
                if units > limit && longest.as_ref().is_none_or(|(n, _)| units > *n) {
                    longest = Some((units, file.path.clone()));
                }
            }
        }
    }
    let (units, file) = longest?;
    Some(format!(
        "`{skill}`: {} — its file `{file}` would be {units} characters long in a PC's sessions, past \
         Windows' {limit}. Shorten the skill's folder or file names.",
        crate::library_snapshot::PATH_TOO_LONG
    ))
}

/// What a publish did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub(crate) enum Published {
    /// Committed and pushed. `needs_ok`: it brings a script this computer
    /// hasn't said OK to, so sessions here get it only after the OK (H6a).
    /// `windows`: on a Mac, the words when its paths would be too long for a
    /// PC's sessions (published all the same; a PC refuses it).
    Published {
        skill: String,
        commit: String,
        needs_ok: bool,
        /// 1.175.0 B1: what its text asks for, when that — and no script —
        /// is what waits for the OK.
        #[serde(skip_serializing_if = "Option::is_none")]
        asks: Option<crate::skill_asks::Strongest>,
        #[serde(skip_serializing_if = "Option::is_none")]
        windows: Option<String>,
        /// 1.176.4 review (M1): kept commits set aside on the way, said.
        #[serde(skip_serializing_if = "Option::is_none")]
        set_aside: Option<String>,
    },
    /// My library already holds these exact files.
    AlreadyThere {
        skill: String,
        /// 1.176.4 review (M1): kept commits set aside on the way, said.
        #[serde(skip_serializing_if = "Option::is_none")]
        set_aside: Option<String>,
    },
    /// The other Mac changed it since: nothing written; the compare.
    Compare {
        compare: MyCompare,
        /// 1.176.4 review (M1): kept commits set aside on the way, said.
        #[serde(skip_serializing_if = "Option::is_none")]
        set_aside: Option<String>,
    },
    /// *Keep the other's*: nothing written; this Mac's base moved to it.
    KeptOther {
        skill: String,
        /// 1.176.4 review (M1): kept commits set aside on the way, said.
        #[serde(skip_serializing_if = "Option::is_none")]
        set_aside: Option<String>,
    },
    /// 1.176.4 (owner 2026-11-23): committed here, the push stopped by the
    /// time limit and not seen on GitHub: kept on this computer ([`kept_words`]).
    Kept {
        skill: String,
        words: String,
        needs_ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        asks: Option<crate::skill_asks::Strongest>,
        /// 1.176.4 review (M1): kept commits set aside on the way, said.
        #[serde(skip_serializing_if = "Option::is_none")]
        set_aside: Option<String>,
    },
}

fn base_of(config_dir: &Path, repo: &str, skill: &str) -> Option<String> {
    crate::skills_hub_state::load(config_dir)
        .my_library_bases
        .get(&my_library_base_key(repo, skill))
        .cloned()
}

fn set_base(config_dir: &Path, repo: &str, skill: &str, id: &str, now: i64) -> Result<(), String> {
    crate::skills_hub_state::update(config_dir, now, |state| {
        state.my_library_bases.insert(my_library_base_key(repo, skill), id.to_string());
    })
}

/// The skill's content id in the clone at `rev`: its Claude directory's tree
/// id, else its Codex directory's.
fn skill_id_at(clone: &Path, rev: &str, skill: &str) -> Option<String> {
    let [claude, codex] = skill_paths(skill);
    crate::library_snapshot::entry_tree(clone, rev, &claude)
        .ok()
        .flatten()
        .or_else(|| crate::library_snapshot::entry_tree(clone, rev, &codex).ok().flatten())
}

fn files_map(files: &[SourceFile]) -> std::collections::BTreeMap<String, Vec<u8>> {
    files.iter().map(|f| (f.path.clone(), f.bytes.clone())).collect()
}

fn last_change(clone: &Path, skill: &str) -> (Option<String>, Option<i64>) {
    let [claude, codex] = skill_paths(skill);
    let out = git(clone, &["log", "-1", "--format=%an%x1f%ct", "HEAD", "--", &claude, &codex]).unwrap_or_default();
    let mut parts = out.trim().split('\u{1f}');
    let author = parts.next().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let at = parts.next().and_then(|s| s.trim().parse::<i64>().ok()).map(|s| s * 1000);
    (author, at)
}

/// **Publish** one skill to My library (Promote → My library), never over
/// the other Mac's change (module doc). `expected` is the other Mac's id the
/// compare showed; an answer is refused (the compare read again) when GitHub
/// moved since.
#[allow(clippy::too_many_arguments)]
pub(crate) fn publish_with(
    hub: &dyn Hub,
    config_dir: &Path,
    clone: &Path,
    repo: &str,
    skill: &str,
    files: &[SourceFile],
    choice: Option<Choice>,
    expected: Option<&str>,
    machine: &str,
    now: i64,
) -> Result<Published, String> {
    let skill = crate::project_skills::safe_name(skill)?;
    // §8 (H10 Windows walk): on Windows a skill whose snapshot paths would
    // pass the limit is never delivered here, so it isn't published from
    // here either.
    if cfg!(windows) {
        if let Some(words) = too_long_for_windows(config_dir, clone, &skill, files) {
            return Err(format!("{words} Nothing was published."));
        }
    }
    let _guard = lock().lock();
    let doing = format!("add `{skill}` to My library");
    // Round 3 (R3-M1): a clone with edits to tracked files stops the press
    // before anything — a pull, an undo, a set-aside — could reset them.
    // Plyloft's own flow never leaves one (a failed commit or push is undone
    // within the press); a press cut short between writing the skill and
    // that commit or undo would, and can't be told apart from a person's
    // edit, so it stops too, with the way out.
    let edited = edited_beyond_line_endings(clone).map_err(|error| {
        log::warn!("my library: couldn't read the clone's changes: {error}");
        couldnt_read_words()
    })?;
    if edited {
        return Err(set_aside_failed_words(true));
    }
    // 1.176.4 review (M1): the words when kept commits were set aside on the
    // way, said with whatever this press ends in.
    let mut aside: Option<String> = None;
    let said = |aside: &Option<String>, words: String| match aside {
        Some(first) => format!("{first} {words}"),
        None => words,
    };
    for attempt in 0..2 {
        // Level with GitHub first: a stale clone would judge against an old
        // tip. A clone ahead of GitHub (a commit kept after a push the time
        // limit stopped) goes with this press's push, when it is Plyloft's
        // own (`own_skills`).
        match crate::team::library_pull_in(clone, crate::team::LIBRARY_FETCH_TIMEOUT, crate::worktrees::exit_registry()) {
            Ok(()) => {}
            Err(crate::team::RemoteFailure::Diverged { .. }) => {
                // M1: GitHub moved while kept commits waited here. Plyloft's
                // own are set aside (backup ref) and the clone goes back to
                // GitHub's branch; this press then goes on as usual.
                let kept = own_skills(clone, &ahead_commits(clone)?)?;
                set_aside(config_dir, repo, clone, &kept, now)?;
                aside = Some(moved_aside_words(&kept));
            }
            Err(failure) => return Err(said(&aside, network_words(&doing, &failure.technical()))),
        }
        let here = crate::skill_card::tree_id_of(clone, files)?;
        let other = skill_id_at(clone, "HEAD", &skill);
        if other.as_deref() == Some(here.as_str()) {
            // 1.176.4: here only by a commit kept after a push the time limit
            // stopped — Plyloft's own (S1) — this press sends it by the same
            // push, a fast-forward.
            let pending = ahead_commits(clone)?;
            if !pending.is_empty() {
                let kept = own_skills(clone, &pending)?;
                check_origin(hub, clone, repo)?;
                match push_and_read(clone) {
                    Ok(()) => {
                        set_base(config_dir, repo, &skill, &here, now)?;
                        return Ok(Published::Published { skill, commit: head(clone).unwrap_or_default(), needs_ok: false, asks: None, windows: None, set_aside: aside });
                    }
                    Err(failure) if failure.timed_out => {
                        set_base(config_dir, repo, &skill, &here, now)?;
                        return Ok(Published::Kept { words: kept_words(&skill), skill, needs_ok: false, asks: None, set_aside: aside });
                    }
                    Err(failure) if crate::team::push_refused_by_a_race(&failure.words) && attempt == 0 => continue,
                    Err(failure) if github_refused(&failure.words) => {
                        log::info!("my library: GitHub refused the push: {}", failure.words);
                        set_aside(config_dir, repo, clone, &kept, now)?;
                        return Err(said(&aside, refused_aside_words(&kept)));
                    }
                    Err(failure) => return Err(said(&aside, with_kept_carried(network_words(&doing, &failure.words), &kept, &failure.words))),
                }
            }
            set_base(config_dir, repo, &skill, &here, now)?;
            return Ok(Published::AlreadyThere { skill, set_aside: aside });
        }
        let base = base_of(config_dir, repo, &skill);
        if let Some(other_id) = other.as_deref() {
            let moved = base.as_deref() != Some(other_id);
            if moved {
                let answered = choice.is_some() && expected == Some(other_id);
                if !answered {
                    let [claude, codex] = skill_paths(&skill);
                    let path = if crate::library_snapshot::entry_tree(clone, "HEAD", &claude).ok().flatten().is_some() { claude } else { codex };
                    let other_files = crate::skill_card::read_source(clone, "HEAD", &path)?.files;
                    let base_files = base.as_deref().and_then(|id| tree_files(clone, id).ok());
                    let (other_author, other_at) = last_change(clone, &skill);
                    return Ok(Published::Compare {
                        compare: MyCompare {
                            skill: skill.clone(),
                            other_id: other_id.to_string(),
                            other_author,
                            other_at,
                            two_way: base_files.is_none(),
                            files: crate::commands::skills_hub_decisions::compare3_files(
                                base_files.as_ref().map(|f| files_map(f)).as_ref(),
                                &files_map(&other_files),
                                &files_map(files),
                            ),
                        },
                        set_aside: aside,
                    });
                }
                if choice == Some(Choice::KeepOther) {
                    set_base(config_dir, repo, &skill, other_id, now)?;
                    return Ok(Published::KeptOther { skill, set_aside: aside });
                }
            }
        }
        if choice == Some(Choice::KeepOther) {
            // Answered twice (the base is the other's already): kept.
            if other.is_some() && other.as_deref() == expected && base.as_deref() == expected {
                return Ok(Published::KeptOther { skill, set_aside: aside });
            }
            // Nothing of the other's is there any more to keep.
            return Err(said(&aside, format!("{skill} changed on GitHub while you were reading it. Open it again.")));
        }

        // Write, commit, push — to My library's own repository only. What is
        // already ahead of GitHub goes too, only when it is Plyloft's own
        // kept commits (S1).
        let kept = own_skills(clone, &ahead_commits(clone)?)?;
        check_origin(hub, clone, repo)?;
        let before = head(clone);
        ensure_layout(clone)?;
        for path in skill_paths(&skill) {
            write_skill(&clone.join(&path), files)?;
        }
        let paths = publish_paths(&skill);
        let mut add = vec!["add", "--"];
        add.extend(paths.iter().map(String::as_str));
        git(clone, &add)?;
        let identity = identity_args(clone);
        let message = crate::commit_message::library_message(&format!("add {skill} from {machine}"));
        let mut commit: Vec<&str> = vec!["--quiet", "-m", &message, "--"];
        commit.extend(paths.iter().map(String::as_str));
        if let Err(error) = crate::team::library_commit(clone, &identity, &commit) {
            undo(clone, before.as_deref());
            return Err(format!("Plyloft couldn't commit `{skill}` in My library: {error}"));
        }
        match push_and_read(clone) {
            Ok(()) => {
                let id = skill_id_at(clone, "HEAD", &skill).unwrap_or(here);
                set_base(config_dir, repo, &skill, &id, now)?;
                return Ok(Published::Published { skill, commit: head(clone).unwrap_or_default(), needs_ok: false, asks: None, windows: None, set_aside: aside });
            }
            // 1.176.4 (owner 2026-11-23): the bound stopped it and GitHub's
            // branch didn't show it — it may still land, so the commit stays
            // (as the team library keeps one), and is this computer's base.
            // It goes to GitHub only with a later press whose push goes
            // through, never by itself.
            Err(failure) if failure.timed_out => {
                let id = skill_id_at(clone, "HEAD", &skill).unwrap_or(here);
                set_base(config_dir, repo, &skill, &id, now)?;
                return Ok(Published::Kept { words: kept_words(&skill), skill, needs_ok: false, asks: None, set_aside: aside });
            }
            Err(NetworkFailure { words: error, .. }) => {
                // Never forced, never left half: the local commit goes, the
                // files are GitHub's again.
                undo(clone, before.as_deref());
                if crate::team::push_refused_by_a_race(&error) && attempt == 0 {
                    continue;
                }
                // M1: GitHub refused, and earlier kept commits went with it:
                // they are set aside too, so no later press meets them again.
                if !kept.is_empty() && github_refused(&error) {
                    log::info!("my library: GitHub refused the push: {error}");
                    set_aside(config_dir, repo, clone, &kept, now)?;
                    let mut carried = kept.clone();
                    carried.insert(skill.clone());
                    return Err(said(&aside, refused_aside_words(&carried)));
                }
                return Err(said(&aside, with_kept_carried(network_words(&doing, &error), &kept, &error)));
            }
        }
    }
    Err(said(&aside, format!("My library kept changing on GitHub while Plyloft published `{skill}`. Try again.")))
}

/// Put the clone back at `before` (the commit before a publish), files too.
fn undo(clone: &Path, before: Option<&str>) {
    if let Some(before) = before {
        if let Err(error) = git(clone, &["reset", "--quiet", "--hard", before]) {
            log::warn!("my library: couldn't undo a publish that didn't land: {error}");
        }
    }
}

// ── Delivery helpers ─────────────────────────────────────────────────

/// The plugin name My library is delivered as next to `team_plugins` (R6
/// edge): `mine`, or `mine-<login>` when the team library has a plugin of
/// that name (the team's plugin wins its name).
pub(crate) fn delivered_name(team_plugins: &[String], repo: &str) -> String {
    if team_plugins.iter().any(|p| p == PLUGIN) {
        let owner = repo.split('/').next().unwrap_or("me").to_ascii_lowercase();
        let owner: String = owner.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
        format!("{PLUGIN}-{owner}")
    } else {
        PLUGIN.to_string()
    }
}

/// A copy of the snapshot `snap` with its plugin renamed `name` (the clash
/// case), beside it and content-named; stamped, built once, never changed.
pub(crate) fn renamed_snapshot(snap: &Path, codex: bool, name: &str) -> Result<PathBuf, String> {
    let root = snap.parent().ok_or("a snapshot has a parent")?;
    let dir_name = format!(
        "{}-as-{name}",
        snap.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    );
    let dest = root.join(&dir_name);
    let stamp = root.join(format!("{dir_name}.last-used"));
    crate::atomic::write_atomic_text(&stamp, &crate::shared_config::now_millis().to_string())
        .map_err(|error| format!("stamp {}: {error}", stamp.display()))?;
    if dest.is_dir() {
        return Ok(dest);
    }
    let scratch = root.join(format!(".build-{}", uuid::Uuid::new_v4().simple()));
    let built = (|| -> Result<(), String> {
        let files = crate::project_skills::read_tree(snap)?;
        crate::project_skills::write_tree(&scratch, &files)?;
        let rename_manifest = |path: &Path| -> Result<(), String> {
            let bytes = std::fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))?;
            value["name"] = serde_json::Value::String(name.to_string());
            std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap_or_default()).map_err(|error| format!("write {}: {error}", path.display()))
        };
        if codex {
            let from = scratch.join("plugins").join(PLUGIN);
            let to = scratch.join("plugins").join(name);
            if from.is_dir() {
                std::fs::rename(&from, &to).map_err(|error| format!("rename {}: {error}", from.display()))?;
                rename_manifest(&to.join(".codex-plugin/plugin.json"))?;
            }
            let market = scratch.join(".agents/plugins/marketplace.json");
            let bytes = std::fs::read(&market).map_err(|error| format!("read {}: {error}", market.display()))?;
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", market.display()))?;
            if let Some(plugins) = value.get_mut("plugins").and_then(serde_json::Value::as_array_mut) {
                for entry in plugins.iter_mut() {
                    if entry.get("name").and_then(serde_json::Value::as_str) == Some(PLUGIN) {
                        entry["name"] = serde_json::Value::String(name.to_string());
                        entry["source"] = serde_json::json!({ "source": "local", "path": format!("./plugins/{name}") });
                    }
                }
            }
            std::fs::write(&market, serde_json::to_vec_pretty(&value).unwrap_or_default()).map_err(|error| format!("write {}: {error}", market.display()))?;
        } else {
            rename_manifest(&scratch.join(".claude-plugin/plugin.json"))?;
        }
        Ok(())
    })();
    if built.is_err() || crate::platform::rename(&scratch, &dest).is_err() {
        let _ = std::fs::remove_dir_all(&scratch);
        built?;
        if !dest.is_dir() {
            return Err(format!("could not put the renamed snapshot in place at {}", dest.display()));
        }
    }
    Ok(dest)
}

// ── The view and the commands ────────────────────────────────────────

/// One gh account the create sheet can choose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountChoice {
    pub login: String,
    pub active: bool,
}

/// What Settings and All skills show of My library.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyLibraryView {
    pub repo: Option<String>,
    pub account: Option<String>,
    pub has_clone: bool,
    pub last_pull_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    /// `"offline"` · `"gone"` · `"held"` · `"signIn"` · `"failed"`.
    pub last_error: Option<String>,
    pub gone_at: Option<i64>,
    pub default_name: String,
    /// The gh accounts signed in, when no My library is set here (the
    /// create sheet's account choice).
    pub accounts: Vec<AccountChoice>,
    /// Why sessions get it under another plugin name, when they do.
    pub plugin: String,
}

pub(crate) fn view_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>, with_accounts: bool) -> Result<MyLibraryView, String> {
    let config_dir = crate::skills_hub::config_dir(app)?;
    let mut view = MyLibraryView {
        default_name: DEFAULT_NAME.to_string(),
        plugin: PLUGIN.to_string(),
        ..Default::default()
    };
    match setting(app) {
        Some(mine) => {
            let lib = crate::skills_hub_state::load(&config_dir)
                .libraries
                .get(&my_library_key(&mine.repo))
                .cloned()
                .unwrap_or_default();
            view.has_clone = clone_dir(&config_dir, &mine.repo).join(".git").exists();
            view.last_pull_at = lib.last_pull_at;
            view.last_attempt_at = lib.last_attempt_at;
            view.last_error = lib.last_error;
            view.gone_at = lib.gone_at;
            let team_plugins: Vec<String> = crate::mcp_launch::team_clone_dir(app)
                .map(|clone| crate::team_skills::read_library(&clone).skills.into_iter().map(|s| s.plugin).collect())
                .unwrap_or_default();
            view.plugin = delivered_name(&team_plugins, &mine.repo);
            view.repo = Some(mine.repo);
            view.account = mine.account;
        }
        None if with_accounts => {
            view.accounts = gh_accounts()
                .into_iter()
                .filter(|a| a.signed_in)
                .map(|a| AccountChoice { login: a.login, active: a.active })
                .collect();
        }
        None => {}
    }
    Ok(view)
}

/// Who a publish's commit says it came from (the commit author is the
/// account; this names the kind of computer).
fn machine_words() -> &'static str {
    if cfg!(windows) {
        "Plyloft on Windows"
    } else {
        "Plyloft on macOS"
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// After a change: the views, the decisions (an OK a pull brought), All
/// skills' library rows.
fn changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.emit(crate::skills_hub::LIBRARY_EVENT, ());
    let _ = app.emit(crate::skills_hub::DECISION_EVENT, ());
    crate::skills_index::refresh(app, crate::skills_index::Ask { workspaces: Some(Default::default()), libraries: true });
}

fn record<R: tauri::Runtime>(app: &tauri::AppHandle<R>, repo: &str, pulled: &Pulled) {
    let Ok(config_dir) = crate::skills_hub::config_dir(app) else { return };
    let now = now_ms();
    if let Err(error) = crate::skills_hub_state::update(&config_dir, now, |state| {
        record_pull(state.libraries.entry(my_library_key(repo)).or_default(), pulled, now)
    }) {
        log::warn!("my library: couldn't record the pull: {error}");
    }
}

/// The background pull (the scheduler, after the team's) and *Read it
/// again*.
pub(crate) fn pull<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Pulled> {
    let mine = setting(app)?;
    let config_dir = crate::skills_hub::config_dir(app).ok()?;
    let clone = clone_dir(&config_dir, &mine.repo);
    if !clone.join(".git").exists() {
        return None;
    }
    let before = head(&clone);
    let pulled = {
        let _account = scope(mine.account.as_deref());
        pull_with(&RealHub, &clone, &mine.repo)
    };
    if !matches!(pulled, Pulled::Pulled(_)) {
        log::info!("skills hub: pull of My library {} did not update: {pulled:?}", mine.repo);
    }
    record(app, &mine.repo, &pulled);
    // §14 Q11: no toast for your own changes from another Mac; the rows and
    // the line move.
    let moved = matches!(&pulled, Pulled::Pulled(after) if after.as_deref() != before.as_deref());
    let _ = app.emit(crate::skills_hub::LIBRARY_EVENT, ());
    if moved || matches!(pulled, Pulled::Gone) {
        changed(app);
    }
    Some(pulled)
}

/// My library on this Mac: set or not, its pull record, the accounts.
#[tauri::command]
pub async fn my_library_status(app: AppHandle) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || view_of(&app, true))
        .await
        .map_err(|error| format!("join my library status: {error}"))?
}

/// A second Mac: is `<login>/plyloft-skills` on GitHub?
#[tauri::command]
pub async fn my_library_find(account: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _account = scope(account.as_deref());
        find_with(&RealHub)
    })
    .await
    .map_err(|error| format!("join my library find: {error}"))?
}

/// **Create My library**: `<account>/<name>`, private, with `seed` —
/// skills of this Mac by name — copied in.
#[tauri::command]
pub async fn my_library_create(
    app: AppHandle,
    name: String,
    account: Option<String>,
    seed: Vec<String>,
) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mine) = setting(&app) {
            return Err(format!("{} already uses My library `{}`.", crate::platform::THIS_MACHINE, mine.repo));
        }
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let personal = crate::personal_skills::read_personal_skills(&crate::personal_skills::home_dir());
        let mut chosen = Vec::new();
        for name in &seed {
            let entry = personal.skills.iter().find(|s| &s.name == name).ok_or_else(|| {
                format!("`{name}` isn't a skill on {} any more — read it again.", crate::platform::THIS_MACHINE)
            })?;
            chosen.push((entry.name.clone(), PathBuf::from(&entry.dir)));
        }
        let ready = {
            let _account = scope(account.as_deref());
            create_with(&RealHub, &config_dir, &name, &chosen)?
        };
        // The seeds are this Mac's versions: the base a later publish of
        // the same skill from here starts from.
        for (skill, _) in &chosen {
            if let Some(id) = skill_id_at(&ready.dir, "HEAD", skill) {
                let _ = set_base(&config_dir, &ready.repo, skill, &id, now_ms());
            }
        }
        finish(&app, &ready)?;
        view_of(&app, false)
    })
    .await
    .map_err(|error| format!("join my library create: {error}"))?
}

fn finish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ready: &Ready) -> Result<(), String> {
    app.state::<crate::settings::SettingsStore>().set_my_library(Some(MyLibrarySettings {
        repo: ready.repo.clone(),
        account: Some(ready.account.clone()),
    }))?;
    record(app, &ready.repo, &Pulled::Pulled(head(&ready.dir)));
    changed(app);
    Ok(())
}

/// **Use it on this Mac** / **Point to another repository…**. A
/// library already used here is replaced: its clone goes to the Trash.
#[tauri::command]
pub async fn my_library_use(app: AppHandle, repo: String, account: Option<String>) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let previous = setting(&app);
        let account = account.or_else(|| previous.as_ref().and_then(|p| p.account.clone()));
        let ready = {
            let _account = scope(account.as_deref());
            let team = crate::commands::current_team_repo(&app);
            use_with(&RealHub, &config_dir, &repo, team.as_deref())?
        };
        if let Some(previous) = previous.filter(|p| !p.repo.eq_ignore_ascii_case(&ready.repo)) {
            stop_using(&config_dir, &previous.repo);
        }
        finish(&app, &ready)?;
        view_of(&app, false)
    })
    .await
    .map_err(|error| format!("join my library use: {error}"))?
}

/// The clone of `repo` to the Trash / Recycle Bin, its record dropped.
fn stop_using(config_dir: &Path, repo: &str) -> Option<String> {
    let _guard = lock().lock();
    let dir = clone_dir(config_dir, repo);
    let kept = if dir.exists() {
        crate::trash::trash_all(std::slice::from_ref(&dir)).err().map(|refusal| refusal.reason)
    } else {
        None
    };
    if let Err(error) = crate::skills_hub_state::update(config_dir, now_ms(), |state| {
        state.libraries.remove(&my_library_key(repo));
    }) {
        log::warn!("my library: couldn't drop the record: {error}");
    }
    kept
}

/// **Stop using it on this Mac** (after the member confirmed): the clone to
/// the Trash / Recycle Bin, the setting cleared. Linked copies in
/// repositories stay. It only removes.
#[tauri::command]
pub async fn my_library_forget(app: AppHandle) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_dir = crate::skills_hub::config_dir(&app)?;
        if let Some(mine) = setting(&app) {
            if let Some(kept) = stop_using(&config_dir, &mine.repo) {
                return Err(format!("Plyloft couldn't move My library's copy: {kept}"));
            }
        }
        app.state::<crate::settings::SettingsStore>().set_my_library(None)?;
        changed(&app);
        view_of(&app, true)
    })
    .await
    .map_err(|error| format!("join my library forget: {error}"))?
}

/// **Create it again** (gone).
#[tauri::command]
pub async fn my_library_recreate(app: AppHandle) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mine = setting(&app).ok_or("No My library is set on this computer.")?;
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let clone = clone_dir(&config_dir, &mine.repo);
        if !clone.join(".git").exists() {
            return Err(format!("My library's copy isn't on {} any more.", crate::platform::THIS_MACHINE));
        }
        {
            let _account = scope(mine.account.as_deref());
            recreate_with(&RealHub, &clone, &mine.repo)?;
        }
        record(&app, &mine.repo, &Pulled::Pulled(head(&clone)));
        changed(&app);
        view_of(&app, false)
    })
    .await
    .map_err(|error| format!("join my library recreate: {error}"))?
}

/// *Read it again* (it asks GitHub).
#[tauri::command]
pub async fn my_library_pull_now(app: AppHandle) -> Result<MyLibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _ = pull(&app);
        view_of(&app, false)
    })
    .await
    .map_err(|error| format!("join my library pull: {error}"))?
}

/// Where a publish takes the skill from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub(crate) enum PublishSource {
    /// A skill of this Mac (`~/.claude/skills`, `~/.agents/skills`, …),
    /// resolved by name, never by a path the window sent.
    ThisMac { skill: String },
    /// A repository skill in a workspace's checkout.
    Repository { workspace_id: String, skill: String },
}

/// **Add to My library** (Promote → My library): one skill published,
/// never over the other Mac's change (the compare instead).
#[tauri::command]
pub async fn my_library_publish(
    app: AppHandle,
    source: PublishSource,
    choice: Option<Choice>,
    expected: Option<String>,
) -> Result<Published, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mine = setting(&app).ok_or_else(|| {
            format!("Create My library first, or use it on {}.", crate::platform::THIS_MACHINE)
        })?;
        let config_dir = crate::skills_hub::config_dir(&app)?;
        let clone = clone_dir(&config_dir, &mine.repo);
        if !clone.join(".git").exists() {
            return Err(format!("My library isn't on {} yet. Use it on this computer first.", crate::platform::THIS_MACHINE));
        }
        let (skill, dir, in_checkout) = match source {
            PublishSource::ThisMac { skill } => {
                let personal = crate::personal_skills::read_personal_skills(&crate::personal_skills::home_dir());
                let entry = personal.skills.iter().find(|s| s.name == skill).ok_or_else(|| {
                    format!("`{skill}` isn't a skill on {} any more — read it again.", crate::platform::THIS_MACHINE)
                })?;
                (skill, PathBuf::from(&entry.dir), false)
            }
            PublishSource::Repository { workspace_id, skill } => {
                let (_, cwd) = crate::commands::workspace_checkout(&app, &workspace_id)?;
                let found = crate::project_skills::read_project_skills(&cwd)
                    .skills
                    .into_iter()
                    .find(|s| s.name == skill)
                    .ok_or_else(|| format!("`{skill}` isn't in this repository any more — read it again."))?;
                if let Some(blocked) = crate::project_skills::promote_blocker(&found) {
                    return Err(blocked);
                }
                let dir = crate::project_skills::promote_source(&cwd, &found)
                    .ok_or_else(|| format!("`{skill}` has no copy Plyloft can read here."))?;
                (skill, dir, true)
            }
        };
        // 1.175.0 D4 (TM-7): My library is cloned on the member's Windows
        // computer too, so a name it can't hold doesn't go — checked with the
        // private names, on the files that would travel (`publishable_files`).
        let files = publishable_files(&skill, &dir, in_checkout)?;
        let published = {
            let _account = scope(mine.account.as_deref());
            publish_with(
                &RealHub,
                &config_dir,
                &clone,
                &mine.repo,
                &skill,
                &files,
                choice,
                expected.as_deref(),
                machine_words(),
                now_ms(),
            )?
        };
        let mut published = published;
        // 1.176.4 review (S2): kept here — sessions on this computer get it,
        // so its OK and the rows are as for a publish; it is no pull.
        if let Published::Kept { skill, needs_ok, asks, .. } = &mut published {
            let state = crate::skills_hub_state::load(&config_dir);
            let waiting = crate::skill_scripts::needs_ok(&clone, &state).unwrap_or_default();
            let item = waiting.iter().find(|item| &item.skill == skill);
            *needs_ok = item.is_some();
            *asks = item.filter(|item| !item.brings_script).and_then(|item| item.asks);
            changed(&app);
        }
        if let Published::Published { skill, needs_ok, asks, windows, .. } = &mut published {
            // H6a: a skill that brings a script waits for this computer's OK.
            // 1.175.0 B1: and one whose text asks to run things.
            let state = crate::skills_hub_state::load(&config_dir);
            let waiting = crate::skill_scripts::needs_ok(&clone, &state).unwrap_or_default();
            let item = waiting.iter().find(|item| &item.skill == skill);
            *needs_ok = item.is_some();
            *asks = item.filter(|item| !item.brings_script).and_then(|item| item.asks);
            if !cfg!(windows) {
                *windows = too_long_for_windows(Path::new(WINDOWS_CONFIG_ESTIMATE), &clone, skill, &files);
            }
            record(&app, &mine.repo, &Pulled::Pulled(head(&clone)));
            changed(&app);
        }
        Ok(published)
    })
    .await
    .map_err(|error| format!("join my library publish: {error}"))?
}

#[cfg(test)]
#[path = "my_library_tests.rs"]
mod tests;

/// [`GIT_TIMEOUT`], or a test's shorter bound (A5R-09's late push).
#[cfg(test)]
fn git_timeout() -> std::time::Duration {
    TEST_GIT_TIMEOUT.with(|t| t.get()).unwrap_or(GIT_TIMEOUT)
}

#[cfg(test)]
thread_local! {
    static TEST_GIT_TIMEOUT: std::cell::Cell<Option<std::time::Duration>> = const { std::cell::Cell::new(None) };
}
