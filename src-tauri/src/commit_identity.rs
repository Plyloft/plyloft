//! N14 item 8 (owner decision, 2026-10-02): the identity of Plyloft's own
//! commits.
//!
//! The commits Plyloft authors itself — the team repo's manifest and library
//! writes (`team::RealLibraryGit::commit`), and the shared channel's
//! definition, library and approved-proposal commits
//! (`shared_config::Plumbing::commit_tree_changes`) — are made as **the GitHub
//! account that publishes them**: its login as the name and its private
//! address (`<id>+<login>@users.noreply.github.com`) as the email, given to
//! that one git invocation as `-c user.name=… -c user.email=…`. The global
//! git identity is left alone; it is still what a person's own commits use.
//!
//! "The publishing account" is the one the calls on this thread already act
//! as ([`crate::github_account::scoped_login`]: the team's account inside a
//! team scope, a workspace's chosen account inside its scope, gh's active
//! account otherwise). It is read with `gh api user` once and remembered in
//! memory only (never persisted).
//!
//! Only for a repository whose `origin` is on github.com: a local-only
//! repository (SP-5's "Approve and commit to main" with no remote) has no
//! publishing account, and keeps the global identity. When the account can't
//! be read (gh missing, signed out, offline) the commit falls back to the
//! global identity without a word — it is still a correct commit.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a read account is trusted (the active account can change; an
/// id never changes for a login).
const REMEMBERED: Duration = Duration::from_secs(30 * 60);

/// One GitHub account, as its commits name it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitIdentity {
    pub login: String,
    pub id: u64,
}

impl CommitIdentity {
    /// GitHub's private address for the account.
    pub fn email(&self) -> String {
        crate::setup_identity::noreply_address(self.id, &self.login)
    }

    /// The `-c` arguments that make one git invocation commit as this
    /// account (before the subcommand).
    pub fn git_args(&self) -> Vec<String> {
        vec![
            "-c".into(),
            format!("user.name={}", self.login),
            "-c".into(),
            format!("user.email={}", self.email()),
        ]
    }
}

/// Pure: `gh api user`'s answer as an identity, when it is one — and, for a
/// named account, only when GitHub answered as that account.
pub fn parse(json: &str, expected_login: Option<&str>) -> Option<CommitIdentity> {
    let user = crate::setup_identity::parse_gh_user(json)?;
    let login = user.login.trim().to_string();
    if !crate::team_admin::is_valid_login(&login) || user.id == 0 {
        return None;
    }
    if expected_login.is_some_and(|expected| !expected.eq_ignore_ascii_case(&login)) {
        return None;
    }
    Some(CommitIdentity { login, id: user.id })
}

type Cache = HashMap<String, (CommitIdentity, Instant)>;

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

/// [`publishing_identity`] with the account's cache key, the login GitHub
/// must answer as, and its reader given (tests). `key: None` — nothing to key
/// it by (gh's active login couldn't be read) — reads without remembering.
pub(crate) fn identity_with(
    cache: &Mutex<Cache>,
    key: Option<&str>,
    expected: Option<&str>,
    read: impl FnOnce() -> Result<String, String>,
) -> Option<CommitIdentity> {
    if let Some(key) = key {
        if let Some((identity, at)) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(key) {
            if at.elapsed() < REMEMBERED {
                return Some(identity.clone());
            }
        }
    }
    let identity = match read() {
        Ok(json) => parse(&json, expected),
        Err(_) => None,
    };
    match (&identity, key) {
        (Some(identity), Some(key)) => {
            cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(key.to_string(), (identity.clone(), Instant::now()));
        }
        (Some(_), None) => {}
        // Said in the log only: the commit still goes ahead, as the global
        // identity, and nothing about it is wrong.
        (None, _) => log::info!(
            "commit identity: couldn't read the GitHub account; Plyloft's commit uses the git identity"
        ),
    }
    identity
}

/// The cache key and expected login for the account this thread acts as:
/// the scope's login, or gh's **current** active login (N14 review P2-2: a
/// `gh auth switch` changes the key, so the old account is never named).
/// `Err(())` when the scope's account can't be used.
pub(crate) fn account_key(
    scoped: Option<Result<String, String>>,
    active: impl FnOnce() -> Option<String>,
) -> Result<(Option<String>, Option<String>), ()> {
    match scoped {
        Some(Ok(login)) => Ok((Some(format!("scope:{}", login.to_ascii_lowercase())), Some(login))),
        Some(Err(words)) => {
            log::info!("commit identity: the GitHub account can't be used ({words}); Plyloft's commit uses the git identity");
            Err(())
        }
        None => match active() {
            Some(login) => Ok((Some(format!("active:{}", login.to_ascii_lowercase())), Some(login))),
            None => Ok((None, None)),
        },
    }
}

/// gh's active github.com login, from its config (local, no network).
/// Tests never reach a developer's gh (as `github::run_gh` fails closed).
#[cfg(test)]
fn active_login() -> Option<String> {
    None
}

#[cfg(not(test))]
fn active_login() -> Option<String> {
    let env = crate::shell_env::try_get()?;
    let tools = crate::project_setup::Tools {
        git: std::sync::Arc::new(crate::platform::git_command),
        gh: env.gh_path.clone(),
        path: env.path.clone(),
    };
    let mut command = tools.gh(None).ok()?;
    command.args(["config", "get", "-h", "github.com", "user"]);
    let ran = crate::project_setup::run(&mut command, Duration::from_secs(10)).ok()?;
    let login = ran.out();
    (ran.ok() && crate::team_admin::is_valid_login(&login)).then_some(login)
}

/// The account the GitHub calls on this thread act as, read once. `None`
/// when it can't be read (or the scope's account can't be used).
pub fn publishing_identity() -> Option<CommitIdentity> {
    let scoped = crate::github_account::scoped_login();
    let unscoped = scoped.is_none();
    let (key, expected) = account_key(scoped, active_login).ok()?;
    if unscoped {
        // N14 review 2 (P3-b): gh's active account, read with GH_TOKEN and
        // GITHUB_TOKEN stripped like `active_login`, so both reads see one
        // account (an inherited token would answer as another).
        return identity_with(&CACHE, key.as_deref(), expected.as_deref(), active_user_json);
    }
    identity_with(&CACHE, key.as_deref(), expected.as_deref(), crate::github::api_user_json)
}

/// `gh api user` as gh's active account, with no inherited token.
#[cfg(test)]
fn active_user_json() -> Result<String, String> {
    Err("tests never reach gh".into())
}

#[cfg(not(test))]
fn active_user_json() -> Result<String, String> {
    let env = crate::shell_env::try_get().ok_or_else(|| "no shell environment yet".to_string())?;
    let tools = crate::project_setup::Tools {
        git: std::sync::Arc::new(crate::platform::git_command),
        gh: env.gh_path.clone(),
        path: env.path.clone(),
    };
    // `Tools::gh(None)` removes GH_TOKEN and GITHUB_TOKEN.
    let mut command = tools.gh(None)?;
    command.args(["api", "user"]);
    let ran = crate::project_setup::run(&mut command, Duration::from_secs(20))?;
    if ran.ok() { Ok(ran.out()) } else { Err(ran.words()) }
}

thread_local! {
    /// N14 review (P3-7): the identity resolved once for an operation on a
    /// repository ([`hold`]), so a check and the commit after it agree.
    static HELD: std::cell::RefCell<Option<(std::path::PathBuf, Vec<String>)>> =
        const { std::cell::RefCell::new(None) };
}

/// While alive, [`args_for`] answers for `repo` on this thread with what it
/// resolved now — never a second read that could fall back on its own.
#[must_use = "the identity is held until this is dropped"]
pub struct Held {
    previous: Option<(std::path::PathBuf, Vec<String>)>,
}

impl Drop for Held {
    fn drop(&mut self) {
        let previous = self.previous.take();
        HELD.with(|slot| *slot.borrow_mut() = previous);
    }
}

/// Resolve `repo`'s commit identity once and hold it for this thread.
pub fn hold(repo: &Path) -> Held {
    let args = args_for(repo);
    let previous = HELD.with(|slot| slot.borrow_mut().replace((repo.to_path_buf(), args)));
    Held { previous }
}

/// Pure: an origin URL a GitHub account publishes to.
pub fn publishes_to_github(origin_url: &str) -> bool {
    crate::team::origin_slug(origin_url.trim()).is_some()
}

/// `repo`'s origin URL, when it has one.
fn origin_url(repo: &Path) -> Option<String> {
    let out = crate::platform::git_command()
        .arg("-C")
        .arg(repo)
        .args(["config", "--get", "remote.origin.url"])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|url| !url.is_empty())
}

/// The `-c` arguments for a commit Plyloft makes in `repo`: the publishing
/// account's identity when `repo` publishes to GitHub and the account can be
/// read; nothing (the global identity) otherwise.
pub fn args_for(repo: &Path) -> Vec<String> {
    if let Some(held) = HELD.with(|slot| {
        slot.borrow().as_ref().filter(|(at, _)| at == repo).map(|(_, args)| args.clone())
    }) {
        return held;
    }
    if !origin_url(repo).is_some_and(|url| publishes_to_github(&url)) {
        return Vec::new();
    }
    publishing_identity().map(|identity| identity.git_args()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const USER: &str = r#"{"login":"MatteoB-adv","id":12345,"name":"Matteo","email":null}"#;

    #[test]
    fn the_account_commits_with_its_login_and_noreply_address() {
        let identity = parse(USER, None).expect("an identity");
        assert_eq!(identity.email(), "12345+MatteoB-adv@users.noreply.github.com");
        assert_eq!(
            identity.git_args(),
            vec![
                "-c",
                "user.name=MatteoB-adv",
                "-c",
                "user.email=12345+MatteoB-adv@users.noreply.github.com"
            ]
        );
    }

    #[test]
    fn an_answer_for_another_account_or_no_account_is_not_used() {
        assert!(parse(USER, Some("someone-else")).is_none());
        assert!(parse(USER, Some("matteob-adv")).is_some(), "logins are case-insensitive");
        assert!(parse("not json", None).is_none());
        assert!(parse(r#"{"login":"","id":1}"#, None).is_none());
        assert!(parse(r#"{"login":"a b","id":1}"#, None).is_none());
    }

    #[test]
    fn the_account_is_read_once_and_a_failure_falls_back_quietly() {
        let cache = Mutex::new(Cache::new());
        let mut reads = 0;
        for _ in 0..3 {
            let got = identity_with(&cache, Some("scope:matteob-adv"), Some("MatteoB-adv"), || {
                reads += 1;
                Ok(USER.to_string())
            });
            assert_eq!(got.map(|i| i.id), Some(12345));
        }
        assert_eq!(reads, 1, "cached after the first read");
        // A failure is not remembered: the next commit asks again.
        let cache = Mutex::new(Cache::new());
        assert!(identity_with(&cache, Some("active:x"), None, || Err("gh: not signed in".into())).is_none());
        assert!(cache.lock().unwrap().is_empty());
        // No key: read, never remembered.
        assert!(identity_with(&cache, None, None, || Ok(USER.to_string())).is_some());
        assert!(cache.lock().unwrap().is_empty());
    }

    /// N14 review P2-2: after `gh auth switch` the active login is another
    /// key, so the old account's cached identity is never used for it.
    #[test]
    fn a_switched_active_account_is_read_again_not_taken_from_the_cache() {
        let cache = Mutex::new(Cache::new());
        let other = r#"{"login":"mb-work","id":777}"#;
        let (key, expected) = account_key(None, || Some("MatteoB-adv".into())).unwrap();
        let first = identity_with(&cache, key.as_deref(), expected.as_deref(), || Ok(USER.to_string()));
        assert_eq!(first.unwrap().login, "MatteoB-adv");
        let (key, expected) = account_key(None, || Some("mb-work".into())).unwrap();
        let mut read = false;
        let second = identity_with(&cache, key.as_deref(), expected.as_deref(), || {
            read = true;
            Ok(other.to_string())
        });
        assert!(read, "a new active account is asked again");
        assert_eq!(second.unwrap().login, "mb-work");
        // GitHub answering for an account other than the active one is not used.
        let (key, expected) = account_key(None, || Some("third".into())).unwrap();
        assert!(identity_with(&cache, key.as_deref(), expected.as_deref(), || Ok(USER.to_string())).is_none());
        // A scope whose account can't be used: no identity at all.
        assert!(account_key(Some(Err("signed out".into())), || None).is_err());
        assert_eq!(account_key(None, || None).unwrap(), (None, None));
    }

    #[test]
    fn a_held_identity_answers_for_its_repository_only() {
        let dir = tempfile::tempdir().unwrap();
        crate::git::run(dir.path(), &["init", "-q"]).unwrap();
        let args = vec!["-c".to_string(), "user.name=held".to_string()];
        let previous = HELD.with(|slot| slot.borrow_mut().replace((dir.path().to_path_buf(), args.clone())));
        let guard = Held { previous };
        assert_eq!(args_for(dir.path()), args);
        assert!(args_for(&dir.path().join("other")).is_empty());
        drop(guard);
        assert!(args_for(dir.path()).is_empty());
    }

    #[test]
    fn only_a_github_origin_has_a_publishing_account() {
        assert!(publishes_to_github("https://github.com/mbadv/team.git"));
        assert!(publishes_to_github("git@github.com:mbadv/team.git"));
        assert!(!publishes_to_github("/tmp/origin.git"));
        assert!(!publishes_to_github("https://gitlab.com/mbadv/team.git"));
        // A repository without a GitHub origin keeps the global identity, and
        // no GitHub call is made for it.
        let dir = tempfile::tempdir().unwrap();
        crate::git::run(dir.path(), &["init", "-q"]).unwrap();
        assert!(args_for(dir.path()).is_empty());
        crate::git::run(dir.path(), &["remote", "add", "origin", "/tmp/x.git"]).unwrap();
        assert!(args_for(dir.path()).is_empty());
    }
}
