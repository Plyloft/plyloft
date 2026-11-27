//! 1.175.0 (F3, review UX-1; owner I5, 2026-11-09): *Put it on GitHub…* —
//! a private repository for a project already on this computer whose
//! repository has no `origin`.
//!
//! A new kind of GitHub write, approved by the owner on 2026-11-09. Only on
//! the person's press, after the consent sheet: `gh repo create
//! <login>/<name> --private --source . --remote origin` (never `--push`),
//! then `git push -u origin <target branch>` — under the chosen account's
//! own login (never an organisation's), only the branch cards go to, never
//! forced. A push that doesn't land leaves the repository as GitHub has it;
//! it is tried again only on the person's press ("Send it again", which
//! pushes only into a repository that still has no such branch).
//!
//! Before anything is created: the project must have no `origin`, the
//! branch must exist here, and no file in its history may be over GitHub's
//! 100 MB limit (nothing is created then). The push runs in its own
//! registry (`worktrees::run_bounded_output_stoppable`): *Stop* kills it,
//! and app exit kills it with the fetches.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

use crate::project_setup::{git_read, is_name_taken, network_git, redact, run, token_for, GhToken, Tools};

/// GitHub refuses a file over this size in a push.
pub const GITHUB_FILE_LIMIT: u64 = 100 * 1024 * 1024;
const GH_CREATE: Duration = Duration::from_secs(120);
/// A first push of a whole history can be long; Stop is the way out.
const PUSH_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const GIT_SCAN: Duration = Duration::from_secs(120);

/// Set by Stop before it kills the push, so the push says "stopped". Round 2
/// (review): per project (its workspace id), so Stop on one project's send
/// never reads as a stop of another's.
static STOPPED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::LazyLock::new(Default::default);

fn stopped_set() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    STOPPED.lock().unwrap_or_else(|p| p.into_inner())
}

/// Round 2 (review, major): the repository each project's *Put it on
/// GitHub* created (`login/name`), by workspace id. *Send it again* sends
/// only there — never to another repository `origin` may name. In memory:
/// after a relaunch Send it again isn't offered (the sheet's own state is
/// gone too), and the project is on GitHub, so its Ship it is the way on.
/// The value: the `login/name` created and the `origin` address `gh` set.
static CREATED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (String, String)>>> =
    std::sync::LazyLock::new(Default::default);

fn created() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, (String, String)>> {
    CREATED.lock().unwrap_or_else(|p| p.into_inner())
}

/// `origin` (`url`) is the repository project `workspace_id`'s Put it on
/// GitHub created: the same `login/name` (case-insensitive), or the very
/// address `gh` set when it isn't a GitHub one. Nothing recorded: no.
fn is_created_origin(workspace_id: &str, url: &str) -> bool {
    let Some((repo, made_url)) = created().get(workspace_id).cloned() else { return false };
    match crate::team::origin_slug(url) {
        Some(slug) => slug.eq_ignore_ascii_case(&repo),
        None => url.trim() == made_url.trim(),
    }
}

/// What the sheet shows before the press (`put_on_github_preview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// The branch cards go to: the one sent.
    pub branch: String,
    /// Its commits.
    pub commits: u64,
    /// Files changed and not saved in Git: they stay on this computer.
    pub unsaved_files: u64,
    /// The folder's name, the suggested name on GitHub.
    pub name: String,
}

/// What a press did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// Created and sent: `repo` is `login/name`.
    #[serde(rename_all = "camelCase")]
    Done { repo: String, branch: String },
    /// The name is taken in that account: nothing created, nothing sent.
    #[serde(rename_all = "camelCase")]
    NameTaken { name: String },
    /// Stopped while sending: the repository exists and is empty.
    #[serde(rename_all = "camelCase")]
    Stopped { repo: String, branch: String },
    /// Nothing was created (a refusal before, or `gh` failed). `large`: the
    /// file over 100 MB that stopped it. `sign_in`: GitHub refused the
    /// account's access.
    #[serde(rename_all = "camelCase")]
    NotCreated { words: String, large: Option<LargeFile>, sign_in: bool },
    /// Created, and the push didn't land: the repository exists, empty.
    #[serde(rename_all = "camelCase")]
    NotSent { repo: String, branch: String, words: String, large: Option<LargeFile> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub bytes: u64,
}

/// A progress step for the sheet (`put-on-github://progress`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub workspace_id: String,
    pub repo: String,
    pub branch: String,
    pub commits: u64,
}

pub const PROGRESS_EVENT: &str = "put-on-github://progress";

fn top(tools: &Tools, dir: &Path) -> Result<std::path::PathBuf, String> {
    let top = git_read(tools, dir, &["rev-parse", "--show-toplevel"])?
        .ok_or_else(|| "This folder isn't a Git project.".to_string())?;
    Ok(std::path::PathBuf::from(top))
}

/// Refused when the repository already sends its changes somewhere.
fn refuse_origin(tools: &Tools, dir: &Path) -> Result<(), String> {
    if git_read(tools, dir, &["remote", "get-url", "origin"])?.is_some() {
        return Err("This project already sends its changes to another copy, so Plyloft won't make one on GitHub.".into());
    }
    Ok(())
}

fn commits_on(tools: &Tools, dir: &Path, branch: &str) -> Result<u64, String> {
    let count = git_read(tools, dir, &["rev-list", "--count", &format!("refs/heads/{branch}")])?
        .ok_or_else(|| format!("{branch} isn't a branch of this project yet."))?;
    count.trim().parse().map_err(|_| format!("Git didn't say how many commits {branch} has."))
}

/// The first file over GitHub's limit in `branch`'s history, if any.
pub(crate) fn large_file_in(tools: &Tools, dir: &Path, branch: &str) -> Result<Option<LargeFile>, String> {
    large_file_over(tools, dir, branch, GITHUB_FILE_LIMIT)
}

/// [`large_file_in`] with the limit given (tests use a small one).
pub(crate) fn large_file_over(tools: &Tools, dir: &Path, branch: &str, limit: u64) -> Result<Option<LargeFile>, String> {
    let mut list = tools.git_in(dir);
    list.args(["rev-list", "--objects", &format!("refs/heads/{branch}")]);
    let objects = run(&mut list, GIT_SCAN)?;
    if !objects.ok() {
        return Err(format!("Git couldn't list what {branch} holds:\n{}", objects.words()));
    }
    let paths: std::collections::HashMap<&str, &str> = objects
        .stdout
        .lines()
        .filter_map(|l| l.split_once(' '))
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let input = tempfile::tempfile().map_err(|e| e.to_string())?;
    {
        use std::io::{Seek, Write};
        let mut f = &input;
        for id in paths.keys() {
            writeln!(f, "{id}").map_err(|e| e.to_string())?;
        }
        let mut f = &input;
        f.rewind().map_err(|e| e.to_string())?;
    }
    let mut check = tools.git_in(dir);
    check.args(["cat-file", "--batch-check=%(objecttype) %(objectname) %(objectsize)"]);
    let out = crate::worktrees::run_bounded_output_with_stdin(&mut check, GIT_SCAN, input)
        .map_err(|_| "Git couldn't read the sizes of what is sent.".to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut largest: Option<LargeFile> = None;
    for line in text.lines() {
        let mut parts = line.split(' ');
        let (Some("blob"), Some(id), Some(size)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let Ok(bytes) = size.parse::<u64>() else { continue };
        if bytes > limit && largest.as_ref().is_none_or(|l| bytes > l.bytes) {
            largest = Some(LargeFile { path: paths.get(id).copied().unwrap_or(id).to_string(), bytes });
        }
    }
    Ok(largest)
}

/// What the sheet says before the press.
pub fn preview(tools: &Tools, dir: &Path, branch: &str) -> Result<Preview, String> {
    let dir = top(tools, dir)?;
    refuse_origin(tools, &dir)?;
    let commits = commits_on(tools, &dir, branch)?;
    let status = git_read(tools, &dir, &["status", "--porcelain"])?.unwrap_or_default();
    let unsaved_files = status.lines().filter(|l| !l.trim().is_empty()).count() as u64;
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Preview { branch: branch.to_string(), commits, unsaved_files, name: crate::project_setup::slugify(&name).unwrap_or(name) })
}

/// A repository name GitHub takes: letters, digits, `-`, `_`, `.`; not
/// empty, not `.` or `..`, at most 100.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn refused_access(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("http 401") || lower.contains("http 403") || lower.contains("gh auth login") || lower.contains("bad credentials")
}

fn push(
    tools: &Tools,
    dir: &Path,
    account: Option<&str>,
    repo: &str,
    branch: &str,
    commits: u64,
    on_progress: &mut dyn FnMut(Progress),
    workspace_id: &str,
) -> Outcome {
    on_progress(Progress { workspace_id: workspace_id.to_string(), repo: repo.to_string(), branch: branch.to_string(), commits });
    let url = git_read(tools, dir, &["remote", "get-url", "origin"]).ok().flatten().unwrap_or_default();
    let github = crate::team::origin_slug(&url).is_some();
    let mut command = network_git(tools, dir, github, account);
    // The branch cards go to, by its full name, never forced.
    command.args(["push", "-u", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")]);
    stopped_set().remove(workspace_id);
    let ran = crate::worktrees::run_bounded_output_stoppable(&mut command, PUSH_TIMEOUT, workspace_id);
    let stopped = stopped_set().remove(workspace_id);
    match ran {
        _ if stopped => Outcome::Stopped { repo: repo.to_string(), branch: branch.to_string() },
        Ok(out) if out.status.success() => Outcome::Done { repo: repo.to_string(), branch: branch.to_string() },
        Ok(out) => {
            let words = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Outcome::NotSent {
                repo: repo.to_string(),
                branch: branch.to_string(),
                large: large_file_in(tools, dir, branch).ok().flatten().filter(|_| words.to_lowercase().contains("large file") || words.contains("GH001")),
                words,
            }
        }
        Err(_) => Outcome::NotSent {
            repo: repo.to_string(),
            branch: branch.to_string(),
            words: "Sending didn't finish.".into(),
            large: None,
        },
    }
}

/// The press of *Put it on GitHub*: create the private repository
/// `login/name` and send `branch` to it.
#[allow(clippy::too_many_arguments)]
pub fn create_and_send(
    tools: &Tools,
    dir: &Path,
    login: &str,
    account: Option<&str>,
    name: &str,
    branch: &str,
    token: Option<&GhToken>,
    on_progress: &mut dyn FnMut(Progress),
    workspace_id: &str,
) -> Outcome {
    let not_created = |words: String, large: Option<LargeFile>, sign_in: bool| Outcome::NotCreated { words, large, sign_in };
    let dir = match top(tools, dir) {
        Ok(d) => d,
        Err(e) => return not_created(e, None, false),
    };
    if let Err(e) = refuse_origin(tools, &dir) {
        return not_created(e, None, false);
    }
    if !crate::team_admin::is_valid_login(login) {
        return not_created("That isn't a GitHub account name.".into(), None, false);
    }
    if !valid_name(name) {
        return not_created("GitHub takes letters, digits, -, _ and . in a repository's name.".into(), None, false);
    }
    let commits = match commits_on(tools, &dir, branch) {
        Ok(n) if n > 0 => n,
        Ok(_) => return not_created(format!("{branch} has no commits to send yet."), None, false),
        Err(e) => return not_created(e, None, false),
    };
    // Before anything exists on GitHub: a file it would refuse.
    match large_file_in(tools, &dir, branch) {
        Ok(Some(large)) => return not_created(String::new(), Some(large), false),
        Ok(None) => {}
        Err(e) => return not_created(e, None, false),
    }
    let repo = format!("{login}/{name}");
    let mut create = match tools.gh(token) {
        Ok(c) => c,
        Err(words) => return not_created(words, None, false),
    };
    // The account's own login: never an organisation's. No `--push`.
    create
        .current_dir(&dir)
        .args(["repo", "create", &repo, "--private", "--source", ".", "--remote", "origin"]);
    match run(&mut create, GH_CREATE) {
        Ok(ran) if ran.ok() => {
            // Round 2: the one repository Send it again may send to.
            let url = git_read(tools, &dir, &["remote", "get-url", "origin"]).ok().flatten().unwrap_or_default();
            created().insert(workspace_id.to_string(), (repo.clone(), url));
        }
        Ok(ran) if is_name_taken(&ran.stderr) => return Outcome::NameTaken { name: name.to_string() },
        Ok(ran) => {
            let words = redact(&ran.words(), token);
            return not_created(words.clone(), None, refused_access(&words));
        }
        Err(words) => return not_created(words, None, false),
    }
    push(tools, &dir, account, &repo, branch, commits, on_progress, workspace_id)
}

/// "Send it again": only into the repository this project now sends to, on
/// GitHub, while it has no `branch` yet — never over anything there.
pub fn send_again(
    tools: &Tools,
    dir: &Path,
    account: Option<&str>,
    branch: &str,
    on_progress: &mut dyn FnMut(Progress),
    workspace_id: &str,
) -> Outcome {
    let not_created = |words: String| Outcome::NotCreated { words, large: None, sign_in: false };
    let dir = match top(tools, dir) {
        Ok(d) => d,
        Err(e) => return not_created(e),
    };
    let Some(url) = git_read(tools, &dir, &["remote", "get-url", "origin"]).ok().flatten() else {
        return not_created("This project has no copy on GitHub to send to.".into());
    };
    let repo = crate::team::origin_slug(&url).unwrap_or_else(|| url.clone());
    let github = crate::team::origin_slug(&url).is_some();
    // Round 2 (review, major): only into the repository this project's Put it
    // on GitHub created — `origin` naming any other is refused, nothing sent.
    if !is_created_origin(workspace_id, &url) {
        return not_created(SEND_AGAIN_ELSEWHERE.into());
    }
    let mut ls = network_git(tools, &dir, github, account);
    ls.args(["ls-remote", "--heads", "origin", &format!("refs/heads/{branch}")]);
    match run(&mut ls, Duration::from_secs(60)) {
        Ok(ran) if ran.ok() && ran.out().is_empty() => {}
        Ok(ran) if ran.ok() => {
            return not_created(format!("{repo} already has {branch}, so Plyloft sends nothing over it."));
        }
        Ok(ran) => return not_created(format!("Plyloft couldn't reach GitHub:\n{}", ran.words())),
        Err(e) => return not_created(e),
    }
    let commits = commits_on(tools, &dir, branch).unwrap_or(0);
    if let Ok(Some(large)) = large_file_in(tools, &dir, branch) {
        return Outcome::NotSent { repo, branch: branch.to_string(), words: String::new(), large: Some(large) };
    }
    push(tools, &dir, account, &repo, branch, commits, on_progress, workspace_id)
}

/// Round 2: why Send it again sends nothing to an `origin` this project's
/// Put it on GitHub didn't create.
pub const SEND_AGAIN_ELSEWHERE: &str =
    "This project now sends to a repository Plyloft didn't make here, so Send it again sends nothing. Use Ship it to send cards there.";

/// Stop: project `workspace_id`'s push in flight ends; the repository stays
/// as GitHub has it. Another project's send goes on.
pub fn stop(workspace_id: &str) -> usize {
    stopped_set().insert(workspace_id.to_string());
    crate::worktrees::stop_pushes(workspace_id)
}

/// R13: which of these commits GitHub has — reachable from a branch this
/// computer last saw on `origin` (local refs only, never a fetch). A card
/// shipped only here before the project was put on GitHub went with its
/// target branch, so its receipt mustn't say "not on GitHub". At most 64,
/// hexadecimal names only; an unknown one is "not sent".
pub fn sent_already(tools: &Tools, dir: &Path, shas: &[String]) -> Vec<String> {
    shas.iter()
        .take(64)
        .filter(|sha| (4..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()))
        .filter(|sha| {
            git_read(tools, dir, &["for-each-ref", "--count=1", "--format=%(refname)", "--contains", sha, "refs/remotes/origin/"])
                .ok()
                .flatten()
                .is_some_and(|r| !r.trim().is_empty())
        })
        .cloned()
        .collect()
}

// ── Commands ──────────────────────────────────────────────────────────

fn workspace_cwd(app: &tauri::AppHandle, workspace_id: &str) -> Result<(std::path::PathBuf, String), String> {
    use tauri::Manager;
    let ws = app
        .state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
    let branch = app
        .state::<crate::project_config::ProjectConfigStore>()
        .get(workspace_id)
        .map(|c| c.target_branch)
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    Ok((std::path::PathBuf::from(ws.cwd), branch))
}

/// `put_on_github_preview(workspaceId)`: the sheet's lines. Reads only.
#[tauri::command(async)]
pub fn put_on_github_preview(app: tauri::AppHandle, workspace_id: String) -> Result<Preview, String> {
    let (cwd, branch) = workspace_cwd(&app, &workspace_id)?;
    preview(&Tools::production(), &cwd, &branch)
}

/// `put_on_github(workspaceId, login, name)`: the sheet's press. `login` is
/// the chosen account (the sheet's), whose own login names the repository.
#[tauri::command(async)]
pub fn put_on_github(app: tauri::AppHandle, workspace_id: String, login: String, name: String) -> Result<Outcome, String> {
    use tauri::Emitter;
    let (cwd, branch) = workspace_cwd(&app, &workspace_id)?;
    let tools = Tools::production();
    let token = token_for(&tools, Some(&login))?;
    let emitter = app.clone();
    // The account's sign-in answers git too (`network_git` with its login).
    let outcome = create_and_send(&tools, &cwd, &login, Some(&login), &name, &branch, token.as_ref(), &mut |p| {
        let _ = emitter.emit(PROGRESS_EVENT, p);
    }, &workspace_id);
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    Ok(outcome)
}

/// `put_on_github_send_again(workspaceId, login)`.
#[tauri::command(async)]
pub fn put_on_github_send_again(app: tauri::AppHandle, workspace_id: String, login: Option<String>) -> Result<Outcome, String> {
    use tauri::Emitter;
    let (cwd, branch) = workspace_cwd(&app, &workspace_id)?;
    let emitter = app.clone();
    let outcome = send_again(&Tools::production(), &cwd, login.as_deref(), &branch, &mut |p| {
        let _ = emitter.emit(PROGRESS_EVENT, p);
    }, &workspace_id);
    let _ = app.emit(crate::workspace_definition::EDITED_EVENT, &workspace_id);
    Ok(outcome)
}

/// `put_on_github_sent(workspaceId, shas)`: R13's reading (local refs only).
#[tauri::command(async)]
pub fn put_on_github_sent(app: tauri::AppHandle, workspace_id: String, shas: Vec<String>) -> Result<Vec<String>, String> {
    let (cwd, _) = workspace_cwd(&app, &workspace_id)?;
    Ok(sent_already(&Tools::production(), &cwd, &shas))
}

/// `put_on_github_stop(workspaceId)`: Stop on the sheet, for its project.
#[tauri::command]
pub fn put_on_github_stop(workspace_id: String) -> usize {
    stop(&workspace_id)
}

#[cfg(test)]
#[path = "put_on_github_tests.rs"]
mod tests;
