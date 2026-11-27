//! OB-7b — the per-workspace GitHub account (onboarding spec §5 step 5
//! "Several accounts", §8.4, D7; MEASUREMENTS §9).
//!
//! A workspace may name the GitHub login Plyloft uses for its GitHub calls
//! (`Workspace.github_account`). When that login is not gh's active account,
//! every GitHub network call Plyloft itself makes *for that workspace* runs
//! with that account's token in the child's environment only:
//!
//! - `gh` calls get `GH_TOKEN` (gh honours it, MEASUREMENTS §9);
//! - `git` fetch / push / ls-remote get git's credential-helper override
//!   for `https://github.com` ([`login_helper_args`]): the user's own helper
//!   (osxkeychain, store, Git Credential Manager) would answer with whichever
//!   account it stored, so gh answers instead, fetching the login's token
//!   itself when git asks. git's environment never holds the token, so its
//!   hooks never see it.
//!
//! How it is applied: a call site that acts for a workspace opens a
//! [`GithubScope`] ([`enter_for_workspace`]) on the thread that makes the
//! calls. The account is read lazily, the first time a chokepoint needs it
//! (`gh config get`, then `gh auth token --user <login>`), once per scope,
//! and the token lives only in that scope's memory. The three
//! spawn chokepoints — [`crate::github::gh_output`] (every `gh` of
//! `github.rs` and of Ship's PR flow), [`crate::worktrees::run_bounded`]
//! (`shared_config::Gh`, `git ls-remote`) and the network git runners in
//! `worktrees.rs` (fetch, push, release push) — call [`apply_to_gh`] /
//! [`apply_to_network_git`], which read the scope. Outside a scope nothing
//! changes (gh's active account, today's behaviour).
//!
//! When the chosen account can't be used (gh missing, signed out), the
//! scope carries the reason and every GitHub call inside it fails with it —
//! never a silent fall-back to another account.
//!
//! The token is never persisted, logged, put in an error or event (every
//! output read inside a scope goes through [`redact`]), and never given to
//! an agent terminal (D7): the PTY spawns (`pty.rs`) and agent processes
//! never read the scope.

use crate::project_setup::{GhToken, Tools};
use std::cell::RefCell;
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

/// One call's bound for the two local gh reads (no network).
const GH_LOCAL_READ: Duration = Duration::from_secs(20);

/// The environment Plyloft's own GitHub calls for one workspace run with:
/// the chosen login, its token and the gh that answers git's credential
/// request. `Debug` never shows the token; no `Display`, no `Serialize`.
#[derive(Clone, PartialEq, Eq)]
pub struct GhEnv {
    login: String,
    token: GhToken,
    gh: String,
}

impl std::fmt::Debug for GhEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GhEnv")
            .field("login", &self.login)
            .field("token", &self.token)
            .finish()
    }
}

impl GhEnv {
    pub fn login(&self) -> &str {
        &self.login
    }

    #[cfg(test)]
    pub(crate) fn for_test(login: &str, token: &str, gh: &str) -> Self {
        Self {
            login: login.into(),
            token: GhToken::new(token.into()).expect("a token"),
            gh: gh.into(),
        }
    }
}

/// Pure: the account a workspace names, when it names one.
fn chosen(account: Option<&str>) -> Option<&str> {
    account.map(str::trim).filter(|a| !a.is_empty())
}

/// The environment for `account` (a workspace's `githubAccount`): `None`
/// when no account is chosen or it is gh's active one (gh then answers with
/// its own), the token of that login otherwise.
///
/// Local reads only, no network (this runs before a card is created on the
/// main thread): the active login from gh's config (`gh config get -h
/// github.com user`), then `gh auth token --user <login>`. A chosen login
/// that isn't signed in is an error in words — never its output, which on
/// success *is* the token.
pub fn resolve(tools: &Tools, account: Option<&str>) -> Result<Option<GhEnv>, String> {
    let Some(login) = chosen(account) else {
        return Ok(None);
    };
    if !crate::team_admin::is_valid_login(login) {
        return Err("That isn't a GitHub account name.".into());
    }
    let gh = tools.gh.clone().ok_or_else(|| {
        format!(
            "This workspace uses the GitHub account {login}, and the GitHub CLI isn't installed. \
             Set it up in Setup's GitHub step."
        )
    })?;
    let mut active = tools.gh(None)?;
    active.args(["config", "get", "-h", "github.com", "user"]);
    let ran = crate::project_setup::run(&mut active, GH_LOCAL_READ)?;
    if ran.ok() && ran.out().eq_ignore_ascii_case(login) {
        return Ok(None);
    }
    let mut command = tools.gh(None)?;
    command.args(["auth", "token", "--user", login]);
    let ran = crate::project_setup::run(&mut command, GH_LOCAL_READ)?;
    if !ran.ok() {
        return Err(format!(
            "This workspace uses the GitHub account {login}, which isn't signed in on this \
             computer. Sign it in in Setup's GitHub step, or pick another account in \
             Settings › Setup and account › Setup › Account for each project."
        ));
    }
    let token = GhToken::new(ran.stdout).ok_or_else(|| {
        format!(
            "The GitHub CLI gave no sign-in for {login}. Sign it in again in Setup's GitHub step."
        )
    })?;
    Ok(Some(GhEnv {
        login: login.to_string(),
        token,
        gh,
    }))
}

/// The environment for a workspace (its `githubAccount`), with the
/// production gh.
pub fn github_env_for_workspace(ws: &crate::workspace::Workspace) -> Result<Option<GhEnv>, String> {
    if chosen(ws.github_account.as_deref()).is_none() {
        return Ok(None);
    }
    resolve(&Tools::production(), ws.github_account.as_deref())
}

// ── The scope ─────────────────────────────────────────────────────────

/// What the calls on this thread run with, once resolved.
#[derive(Debug)]
enum Current {
    /// A chosen, non-active account: its environment.
    Env(GhEnv),
    /// The chosen account can't be used: every `gh` call fails with this,
    /// and so does a network git to an HTTPS github.com origin.
    Failed(String),
}

type Resolver = Box<dyn FnOnce() -> Result<Option<GhEnv>, String>>;

/// The scope's account: read on first use by a chokepoint (P3-3), so a path
/// that never reaches GitHub never spawns gh.
enum State {
    Pending(Resolver),
    /// Being read right now (the resolver's own gh runs see no account).
    Resolving,
    Resolved(Option<Current>),
}

struct Scope {
    /// The workspace the scope is for, so a nested scope for the same one
    /// reuses its token instead of reading it again.
    workspace_id: Option<String>,
    state: RefCell<State>,
}

impl std::fmt::Debug for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = match &*self.state.borrow() {
            State::Pending(_) => "pending".to_string(),
            State::Resolving => "resolving".to_string(),
            State::Resolved(current) => format!("{current:?}"),
        };
        f.debug_struct("Scope")
            .field("workspace_id", &self.workspace_id)
            .field("state", &state)
            .finish()
    }
}

thread_local! {
    static SCOPE: RefCell<Option<Rc<Scope>>> = const { RefCell::new(None) };
}

/// While alive, this thread's GitHub calls use the scope's account. Drop
/// restores whatever was there before. Not `Send`: a scope belongs to the
/// thread that opened it (a thread spawned inside it starts without one,
/// i.e. with gh's active account).
#[must_use = "the scope ends when this is dropped"]
pub struct GithubScope {
    previous: Option<Rc<Scope>>,
}

impl Drop for GithubScope {
    fn drop(&mut self) {
        let previous = self.previous.take();
        SCOPE.with(|slot| *slot.borrow_mut() = previous);
    }
}

fn install(scope: Scope) -> GithubScope {
    let previous = SCOPE.with(|slot| slot.borrow_mut().replace(Rc::new(scope)));
    GithubScope { previous }
}

fn current_of(env: Result<Option<GhEnv>, String>) -> Option<Current> {
    match env {
        Ok(None) => None,
        Ok(Some(env)) => Some(Current::Env(env)),
        Err(words) => Some(Current::Failed(words)),
    }
}

/// Open a scope with an environment already resolved (`Ok(None)`: gh's
/// active account).
pub fn enter(workspace_id: Option<&str>, env: Result<Option<GhEnv>, String>) -> GithubScope {
    install(Scope {
        workspace_id: workspace_id.map(String::from),
        state: RefCell::new(State::Resolved(current_of(env))),
    })
}

/// Open a scope whose account is read by `resolve` on first use.
pub(crate) fn enter_lazy(
    workspace_id: Option<&str>,
    resolve: impl FnOnce() -> Result<Option<GhEnv>, String> + 'static,
) -> GithubScope {
    install(Scope {
        workspace_id: workspace_id.map(String::from),
        state: RefCell::new(State::Pending(Box::new(resolve))),
    })
}

/// Open the scope for `workspace_id`: its chosen account's token when it
/// has one that isn't gh's active one, read when a GitHub call first needs
/// it. Reuses an enclosing scope for the same workspace (one read per
/// call-site invocation). A workspace that is gone or names no account runs
/// with gh's active account.
pub fn enter_for_workspace(
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
) -> GithubScope {
    enter_for_workspace_with(workspaces, workspace_id, |ws| github_env_for_workspace(&ws))
}

/// [`enter_for_workspace`] with the resolver given (tests: a stub gh). The
/// resolver runs at most once, on first use.
pub(crate) fn enter_for_workspace_with(
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
    resolve: impl FnOnce(crate::workspace::Workspace) -> Result<Option<GhEnv>, String> + 'static,
) -> GithubScope {
    let reused = SCOPE.with(|slot| {
        slot.borrow()
            .as_ref()
            .filter(|s| s.workspace_id.as_deref() == Some(workspace_id))
            .cloned()
    });
    if let Some(same) = reused {
        let previous = SCOPE.with(|slot| slot.borrow_mut().replace(same));
        return GithubScope { previous };
    }
    let ws = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .filter(|w| chosen(w.github_account.as_deref()).is_some());
    let Some(ws) = ws else {
        return enter(Some(workspace_id), Ok(None));
    };
    let id = workspace_id.to_string();
    enter_lazy(Some(workspace_id), move || {
        let env = resolve(ws);
        if let Ok(Some(env)) = &env {
            // The login only; the token never reaches a log.
            log::info!("github: workspace {id} uses the account {}", env.login());
        }
        env
    })
}

/// [`enter_for_workspace`] from an app handle; gh's active account when the
/// app has no workspace store (a test's).
pub fn enter_for_app<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
) -> GithubScope {
    use tauri::Manager;
    match app.try_state::<crate::workspace::WorkspaceStore>() {
        Some(workspaces) => enter_for_workspace(&workspaces, workspace_id),
        None => enter(Some(workspace_id), Ok(None)),
    }
}

/// N14 (OB-7b chokepoints, LAUNCH_PLAN T4): open the scope for **the team**:
/// `settings.team.account` (the login this Mac joined or runs its team as)
/// when it is set and isn't gh's active account, read on first use like a
/// workspace's. Every team call site — create, the team refresh and its
/// membership probe, adding a team workspace, the invite plan, Remove from
/// team — opens it, so the team's gh and git run as that account and never
/// silently as whichever one gh has active.
pub fn enter_for_team(account: Option<&str>) -> GithubScope {
    enter_for_team_with(account, |login| {
        resolve(&Tools::production(), Some(login)).map_err(|words| team_words(login, &words))
    })
}

/// N14 (P3-3): [`resolve`]'s refusals are worded for a workspace; the team's
/// say "your team" and where to fix it.
pub fn team_words(login: &str, words: &str) -> String {
    if words.contains("isn't installed") {
        return format!(
            "Your team uses the GitHub account {login}, and the GitHub CLI isn't installed. Set it \
             up in Setup's GitHub step."
        );
    }
    format!(
        "Your team uses the GitHub account {login}, which isn't signed in on {}. Sign it in in \
         Setup's GitHub step, or leave the team and join it again with another account.",
        crate::platform::THIS_MACHINE
    )
}

/// [`enter_for_team`] with the resolver given (tests: a stub gh).
pub(crate) fn enter_for_team_with(
    account: Option<&str>,
    resolve: impl FnOnce(&str) -> Result<Option<GhEnv>, String> + 'static,
) -> GithubScope {
    let Some(login) = chosen(account).map(String::from) else {
        return enter(None, Ok(None));
    };
    enter_lazy(None, move || {
        let env = resolve(&login);
        if let Ok(Some(env)) = &env {
            log::info!("github: the team uses the account {}", env.login());
        }
        env
    })
}

/// This thread's account, resolved, to open in a thread it spawns (a
/// thread starts without a scope, i.e. as gh's active account). Holds the
/// token only in memory, like the scope it came from.
#[derive(Clone)]
pub struct ScopeHandoff(Option<Result<GhEnv, String>>);

impl ScopeHandoff {
    /// Open the handed-off account on the current thread.
    pub fn enter(&self) -> GithubScope {
        match &self.0 {
            None => enter(None, Ok(None)),
            Some(Ok(env)) => enter(None, Ok(Some(env.clone()))),
            Some(Err(words)) => enter(None, Err(words.clone())),
        }
    }
}

/// [`ScopeHandoff`] for this thread's scope (resolving it if pending).
pub fn handoff() -> ScopeHandoff {
    ScopeHandoff(with_current(true, |current| match current {
        None => None,
        Some(Current::Env(env)) => Some(Ok(env.clone())),
        Some(Current::Failed(words)) => Some(Err(words.clone())),
    }))
}

/// Resolve this thread's scope if it is still pending. The resolver runs
/// with no borrow held (its own gh reads go through the chokepoints' output
/// redaction, which reads the scope).
fn resolve_current() {
    let Some(scope) = SCOPE.with(|slot| slot.borrow().clone()) else {
        return;
    };
    let pending = {
        let mut state = scope.state.borrow_mut();
        if !matches!(*state, State::Pending(_)) {
            return;
        }
        std::mem::replace(&mut *state, State::Resolving)
    };
    let State::Pending(resolve) = pending else {
        return;
    };
    let current = current_of(resolve());
    *scope.state.borrow_mut() = State::Resolved(current);
}

/// `f` over this thread's account, resolving it first when `resolve`; a
/// pending (not yet needed) scope reads as no account otherwise.
fn with_current<T>(resolve: bool, f: impl FnOnce(Option<&Current>) -> T) -> T {
    if resolve {
        resolve_current();
    }
    SCOPE.with(|slot| {
        let scope = slot.borrow();
        match scope.as_ref() {
            None => f(None),
            Some(scope) => match &*scope.state.borrow() {
                State::Resolved(current) => f(current.as_ref()),
                State::Pending(_) | State::Resolving => f(None),
            },
        }
    })
}

// ── The chokepoints ───────────────────────────────────────────────────

/// A `gh` about to run: `GH_TOKEN` when this thread's scope has a token (an
/// inherited `GITHUB_TOKEN`, which gh prefers over nothing, is dropped);
/// the scope's reason when its account can't be used; nothing otherwise.
///
/// 1.176.3, Windows: also the probed git's folder appended to gh's PATH when
/// that PATH lacks it ([`gh_path_for`]) — gh runs `git` by its bare name.
/// 1.176.4, macOS: only where `/usr/bin/git` is Apple's placeholder, the
/// probed git's folder in front of it; any other Mac's gh keeps its PATH.
pub fn apply_to_gh(cmd: &mut Command) -> Result<(), String> {
    apply_to_gh_with(cmd, crate::shell_env::try_get().as_deref())
}

/// [`apply_to_gh`] with the probe given (testable without swapping the
/// global one, which other tests' git spawns read).
fn apply_to_gh_with(cmd: &mut Command, probed: Option<&crate::shell_env::ShellEnv>) -> Result<(), String> {
    let (git, mac_shim) = gh_git_facts(probed);
    let process = std::env::var("PATH").ok();
    if let Some(path) = gh_path_for(cmd, git.as_deref(), process.as_deref(), cfg!(windows), mac_shim) {
        cmd.env("PATH", path);
    }
    with_current(true, |current| match current {
        None => Ok(()),
        Some(Current::Failed(words)) => Err(words.clone()),
        Some(Current::Env(env)) => {
            cmd.env_remove("GITHUB_TOKEN").env("GH_TOKEN", env.token.expose());
            Ok(())
        }
    })
}

/// 1.176.4 (REV gh-shim M1): the Mac rule of [`gh_path_for`] alone, for a gh
/// child that already carries its own PATH (`project_setup::Tools::gh`, the
/// cached PATH). Never Windows' append: those children keep their PATH there.
pub(crate) fn apply_mac_rule_to_gh(cmd: &mut Command) {
    apply_mac_rule_to_gh_with(cmd, crate::shell_env::try_get().as_deref())
}

fn apply_mac_rule_to_gh_with(cmd: &mut Command, probed: Option<&crate::shell_env::ShellEnv>) {
    let (git, mac_shim) = gh_git_facts(probed);
    // The PATH set on `cmd` is the base; `windows` false: no append anywhere.
    if let Some(path) = gh_path_for(cmd, git.as_deref(), None, false, mac_shim) {
        cmd.env("PATH", path);
    }
}

/// The cached facts both gh chokepoints decide from: the probe's working git,
/// and whether this is a Mac whose probe found no Command Line Tools — told
/// by the probe's cached `xcode-select -p` answer (`clt_installed`), never by
/// running `/usr/bin/git`; an unknown answer (`None`) is not that Mac.
fn gh_git_facts(probed: Option<&crate::shell_env::ShellEnv>) -> (Option<String>, bool) {
    let git = probed.and_then(crate::shell_env::ShellEnv::working_git);
    let mac_shim = cfg!(target_os = "macos") && probed.is_some_and(|env| env.clt_installed == Some(false));
    (git, mac_shim)
}

/// 1.176.3 (REV-R1 F1): the PATH for one of Plyloft's own gh children, or
/// `None` to leave it as it is. gh launches `git` by its bare name (Ship's
/// `gh pr create`, `gh repo create --push`, `gh pr merge`), from the PATH it
/// was given — for these children Plyloft's own, from launch — so a Git
/// installed while Plyloft is open (Setup's Git step on Windows) isn't found
/// until a relaunch. The probed git's folder (`git`) is appended after the
/// PATH the child would get anyway (one set on `cmd`, else `process`), only
/// when absent ([`crate::registry_path::with_folder_of`]). Only gh children
/// come here: tiles, agents and PTYs get the cached PATH as it is.
///
/// `windows` (the owner's decision, 2026-11-23): appended as above. On a Mac
/// only with `mac_shim` — `/usr/bin/git` is Apple's placeholder (no Command
/// Line Tools) — the folder goes in front instead, when `/usr/bin` comes
/// before it or it is absent ([`crate::registry_path::with_folder_first`];
/// owner, 2026-11-23 evening, 1.176.4). Any other Mac: `None`, gh keeps
/// exactly the PATH it had. `apply_to_gh` must come before a caller's own
/// `env_clear()`, which `get_envs()` can't see.
fn gh_path_for(cmd: &Command, git: Option<&str>, process: Option<&str>, windows: bool, mac_shim: bool) -> Option<String> {
    if !windows && !mac_shim {
        return None;
    }
    let git = git?;
    // Windows' variable names ignore case (`Path` is the usual spelling); a
    // Mac's don't.
    let is_path = |key: &std::ffi::OsStr| {
        let key = key.to_string_lossy();
        if windows { key.eq_ignore_ascii_case("PATH") } else { key == "PATH" }
    };
    let base = match cmd.get_envs().find(|(key, _)| is_path(key)) {
        Some((_, Some(set))) => set.to_str()?.to_string(),
        // Removed on purpose: gh gets none, as the caller asked.
        Some((_, None)) => return None,
        None => process?.to_string(),
    };
    if windows {
        crate::registry_path::with_folder_of(&base, git, true)
    } else {
        crate::registry_path::with_folder_first(&base, git)
    }
}

/// Pure: POSIX single quotes (git runs a `!` helper through `sh`, Git
/// Bash's on Windows).
fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Pure: git's `-c` arguments that make github.com's password come from
/// `gh auth token --user <login>`, asked by the helper itself when git needs
/// it. Only the login is in the argv — no token in git's environment, so a
/// hook git runs never sees one (D7). The empty value first drops the
/// user's own helpers (osxkeychain, store, GCM), which would answer with
/// whichever account they stored (MEASUREMENTS §9).
pub fn login_helper_args(gh: &str, login: &str) -> Vec<String> {
    let gh = sh_quote(&gh.replace('\\', "/"));
    let login = sh_quote(login);
    vec![
        "-c".into(),
        "credential.https://github.com.helper=".into(),
        "-c".into(),
        format!(
            "credential.https://github.com.helper=!f() {{ test \"$1\" = get || exit 0; \
             t=$({gh} auth token --user {login}) || exit 0; \
             echo username=x-access-token; echo \"password=$t\"; }}; f"
        ),
    ]
}

/// Pure: an origin that the chosen account's sign-in would answer for
/// (HTTPS on github.com); SSH origins use the SSH keys.
fn origin_needs_account(url: &str) -> bool {
    !is_ssh_url(url) && crate::team::origin_slug(url).is_some()
}

fn origin_url(repo: &std::path::Path) -> Option<String> {
    let mut git = crate::platform::git_command();
    git.arg("-C").arg(repo).args(["remote", "get-url", "origin"]);
    let ran = crate::project_setup::run(&mut git, GH_LOCAL_READ).ok()?;
    ran.ok().then(|| ran.out())
}

/// A network `git` (fetch, push, ls-remote to origin) in `repo`, about to
/// get its arguments: with a chosen account, gh answers github.com's
/// credential request for that login ([`login_helper_args`], before the
/// subcommand). Never `GH_TOKEN`. When the account can't be used, only an
/// HTTPS github.com origin is refused (P3-4: an SSH origin uses the keys).
pub fn apply_to_network_git(cmd: &mut Command, repo: &std::path::Path) -> Result<(), String> {
    let failed = with_current(true, |current| match current {
        None => Ok(None),
        Some(Current::Failed(words)) => Ok(Some(words.clone())),
        Some(Current::Env(env)) => {
            cmd.args(login_helper_args(&env.gh, &env.login));
            // An inherited one would reach git's hooks; gh's `--user` wins
            // over it anyway (MEASUREMENTS §9).
            cmd.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
            Err(())
        }
    });
    match failed {
        Ok(Some(words)) => match origin_url(repo) {
            Some(url) if !origin_needs_account(&url) => Ok(()),
            _ => Err(words),
        },
        _ => Ok(()),
    }
}

/// The login this thread's GitHub calls act as, when a scope chose one
/// (`Some(Err)` when it can't be used); `None` for gh's active account.
pub fn scoped_login() -> Option<Result<String, String>> {
    with_current(true, |current| match current {
        None => None,
        Some(Current::Failed(words)) => Some(Err(words.clone())),
        Some(Current::Env(env)) => Some(Ok(env.login.clone())),
    })
}

/// `text` without this thread's scoped token — for words built from a
/// command that ran with it outside the chokepoints (which redact their
/// output themselves, [`redact_output`]).
#[cfg_attr(not(test), allow(dead_code))]
pub fn redact(text: &str) -> String {
    with_current(false, |current| match current {
        Some(Current::Env(env)) => crate::project_setup::redact(text, Some(&env.token)),
        _ => text.to_string(),
    })
}

/// [`redact`] over a finished command's two pipes. Never resolves a pending
/// scope (a command run before it was needed had no token).
pub fn redact_output(out: &mut std::process::Output) {
    let token = with_current(false, |current| match current {
        Some(Current::Env(env)) => Some(env.token.clone()),
        _ => None,
    });
    let Some(token) = token else {
        return;
    };
    for pipe in [&mut out.stdout, &mut out.stderr] {
        let text = String::from_utf8_lossy(pipe);
        if text.contains(token.expose()) {
            *pipe = crate::project_setup::redact(&text, Some(&token)).into_bytes();
        }
    }
}

/// OB-12 (step 8) / Settings: whether a workspace should be asked which
/// account — only when gh lists more than one github.com account (one
/// account: nothing extra, today's behaviour). Exported for OB-12.
#[allow(dead_code)]
pub fn account_choice_needed(accounts: &[crate::setup_run::GhAccount]) -> bool {
    accounts.len() > 1
}

// ── Settings › Setup › GitHub accounts ────────────────────────────────

/// One workspace whose checkout's origin is on github.com, for the
/// Settings section's per-workspace choice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGithub {
    pub id: String,
    pub name: String,
    /// `owner/name`.
    pub repo: String,
    /// origin is an SSH URL: its pushes and fetches use the SSH keys; the
    /// chosen account covers the `gh` calls (spec §5 step 5, SSH remotes).
    pub ssh: bool,
    /// `Workspace.github_account`; `None` = gh's active account.
    pub account: Option<String>,
}

/// Pure: an origin URL is SSH (`git@host:…`, `ssh://…`).
pub fn is_ssh_url(url: &str) -> bool {
    let url = url.trim();
    url.starts_with("ssh://") || (!url.contains("://") && url.contains('@') && url.contains(':'))
}

/// The workspaces whose origin is on github.com (read-only: `git remote
/// get-url origin`, bounded), in the store's order.
pub fn workspace_rows(tools: &Tools, workspaces: &[crate::workspace::Workspace]) -> Vec<WorkspaceGithub> {
    workspaces
        .iter()
        .take(300)
        .filter(|w| std::path::Path::new(&w.cwd).is_dir())
        .filter_map(|w| {
            let mut git = tools.git_in(std::path::Path::new(&w.cwd));
            git.args(["remote", "get-url", "origin"]);
            let ran = crate::project_setup::run(&mut git, GH_LOCAL_READ).ok()?;
            if !ran.ok() {
                return None;
            }
            let url = ran.out();
            let repo = crate::team::origin_slug(&url)?;
            Some(WorkspaceGithub {
                id: w.id.clone(),
                name: w.name.clone(),
                repo,
                ssh: is_ssh_url(&url),
                account: chosen(w.github_account.as_deref()).map(String::from),
            })
        })
        .collect()
}

/// Settings › Setup › GitHub accounts: every workspace with a GitHub origin
/// and the account it uses. Never a token.
#[tauri::command]
pub async fn github_account_workspaces(
    app: tauri::AppHandle,
) -> Result<Vec<WorkspaceGithub>, String> {
    use tauri::Manager;
    let workspaces = app
        .state::<crate::workspace::WorkspaceStore>()
        .snapshot()
        .workspaces;
    tauri::async_runtime::spawn_blocking(move || workspace_rows(&Tools::production(), &workspaces))
        .await
        .map_err(|e| format!("GitHub accounts worker failed: {e}"))
}

#[cfg(test)]
#[path = "github_account_tests.rs"]
mod tests;
