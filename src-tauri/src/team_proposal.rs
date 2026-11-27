//! Skills hub H4 (`docs/plans/SKILLS_HUB.md` R3, R7): a change to the team
//! library **as a pull request**, never a push to its default branch.
//!
//! Two callers:
//! - *Propose mine upstream* (R3): a linked copy modified here goes to the
//!   library it came from as a pull request `Skill: <name>` from
//!   `plyloft/skill-<name>-<yyyymmdd-hhmm>`. The copy stays *Modified here*;
//!   once the pull request merges and the clone pulls it, here = upstream and
//!   the row reads *up to date* by itself.
//! - *Promote* (R7) when the skill's paths moved since this Mac's base (a
//!   teammate published meanwhile — never override), or when GitHub refuses
//!   the push to the default branch but takes pull requests (branch
//!   protection).
//!
//! The commit is made in a **temporary, detached worktree of the team
//! clone** cut at the parent commit, with the caller's write applied there —
//! so the clone's own checkout (what sessions and the background pull read)
//! is never touched, and the write is exactly Promote's (`write_promoted_skill`,
//! manifests included). The worktree is removed before anything goes to
//! GitHub. The commit is pushed to the proposal branch only — the
//! team-library write path's own exception, never a general push — and
//! `gh pr create` opens the pull request on the team repository.
//!
//! A proposal of the same skill from this Mac while its pull request is open
//! adds a commit to the same branch (R7 edge: the row keeps one pull request).
//!
//! GitHub's permissions are the gate (D7): a member who can't write gets the
//! plain sentence ([`read_only_words`]) and nothing is left half done.

use std::path::Path;

use crate::shared_config::{Gh, Plumbing, PushResult};

/// Every proposal branch starts with it.
pub const BRANCH_PREFIX: &str = "plyloft/skill-";

/// R7: GitHub refused the push to the default branch but takes pull requests.
pub const TAKES_PULL_REQUESTS_WORDS: &str = "The team library takes changes by pull request.";

/// `plyloft/skill-<name>-<yyyymmdd-hhmm>` (R3).
pub fn branch_name(skill: &str, now: chrono::DateTime<chrono::Local>) -> String {
    format!("{BRANCH_PREFIX}{skill}-{}", now.format("%Y%m%d-%H%M"))
}

/// The pull request's title (R3, R7): `Skill: <name>`.
pub fn title(skill: &str) -> String {
    format!("Skill: {skill}")
}

/// R7: a member GitHub lets read the team library but not change it.
pub fn read_only_words(owner: Option<&str>) -> String {
    let ask = owner.map(|owner| format!("Ask {owner}")).unwrap_or_else(|| "Ask the team's owner".to_string());
    format!(
        "You can read the team library but not change it. {ask} for write access, or open a pull \
         request from a fork on GitHub."
    )
}

/// Why GitHub refused a push, when it said so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushRefusal {
    /// The account may not write the repository at all (403, "Permission
    /// to … denied").
    ReadOnly,
    /// The branch takes changes by pull request (protected branch, a ruleset,
    /// a pre-receive hook): the change can still be proposed.
    TakesPullRequests,
    /// Skills hub H4 Challenger step 13: git couldn't sign in to GitHub (gh
    /// signed out, no credential, an SSH key refused) — GitHub never saw the
    /// push, so it says nothing about access or the branch.
    SignIn,
}

/// Sort a refused push's words (git's stderr) into a [`PushRefusal`].
pub fn push_refusal(detail: &str) -> Option<PushRefusal> {
    // First: "Authentication failed" or a prompt git may not show is no
    // answer from GitHub about this account's access.
    // Plyloft's account scope refusing to start git for an account that
    // isn't signed in (Challenger) is the same.
    if crate::team::sign_in_cause(detail).is_some() {
        return Some(PushRefusal::SignIn);
    }
    let lower = detail.to_lowercase();
    if lower.contains("permission to") && lower.contains("denied")
        || lower.contains("error: 403")
        || lower.contains("returned error: 403")
        || lower.contains("write access to repository not granted")
    {
        return Some(PushRefusal::ReadOnly);
    }
    if lower.contains("protected branch")
        || lower.contains("gh006")
        || lower.contains("gh013")
        || lower.contains("repository rule violations")
        || lower.contains("[remote rejected]")
        || lower.contains("pre-receive hook declined")
    {
        return Some(PushRefusal::TakesPullRequests);
    }
    None
}

/// The clone's default branch: the branch its `HEAD` tracks on GitHub.
pub fn default_branch(clone: &Path) -> Result<String, String> {
    let out = crate::team::library_git_capture(clone, &["rev-parse", "--abbrev-ref", "@{upstream}"])?;
    let upstream = out.trim();
    upstream
        .split_once('/')
        .map(|(_, branch)| branch.to_string())
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| format!("the team clone's branch tracks no GitHub branch ({upstream})"))
}

/// The commit the clone's `HEAD` tracks on GitHub, as last fetched.
pub fn upstream_commit(clone: &Path) -> Result<String, String> {
    Ok(crate::team::library_git_capture(clone, &["rev-parse", "--verify", "@{upstream}^{commit}"])?
        .trim()
        .to_string())
}

/// What [`open`] is asked to do.
pub struct Request<'a> {
    pub clone: &'a Path,
    /// The team repository on GitHub, `owner/name`.
    pub slug: &'a str,
    /// The branch the pull request merges into.
    pub base_branch: &'a str,
    pub branch: &'a str,
    /// The commit the proposal's commit is made on: the default branch's tip
    /// for a new branch, the branch's last commit for one already open.
    pub parent: &'a str,
    /// The library paths the write may change (staged together).
    pub paths: &'a [String],
    pub message: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    /// The pull request is already open from this branch: push only.
    pub reuse: bool,
}

/// A pull request opened (or added to).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub url: String,
    pub number: Option<u64>,
    pub branch: String,
    pub commit: String,
}

/// Why a proposal didn't open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalError {
    /// The write changed nothing: the library already holds it.
    NothingToPropose,
    /// GitHub refused the account (R7's plain sentence comes from the caller,
    /// who knows the owner).
    ReadOnly(String),
    Failed(String),
}

impl ProposalError {
    pub fn words(&self, owner: Option<&str>) -> String {
        match self {
            ProposalError::NothingToPropose => {
                "The team library already has exactly this, so there is nothing to propose.".to_string()
            }
            ProposalError::ReadOnly(_) => read_only_words(owner),
            ProposalError::Failed(why) => why.clone(),
        }
    }
}

/// The commit of `request`, made in a temporary detached worktree of the
/// clone at `request.parent` with `write` applied there. The worktree is
/// removed whatever happens; the clone's own checkout is never touched.
pub fn commit_in_scratch(
    request: &Request<'_>,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<String, ProposalError> {
    let scratch = tempfile::tempdir().map_err(|e| ProposalError::Failed(format!("scratch directory: {e}")))?;
    let wt = scratch.path().join("library");
    let wt_arg = wt.to_string_lossy().into_owned();
    crate::team::library_git_run(request.clone, &["worktree", "add", "--quiet", "--detach", &wt_arg, request.parent])
        .map_err(|e| ProposalError::Failed(format!("couldn't prepare the pull request ({e})")))?;
    let made = (|| -> Result<String, ProposalError> {
        write(&wt).map_err(ProposalError::Failed)?;
        // A pathspec git knows nothing of (absent on disk and in the index)
        // is not a change; git would refuse the whole `add` over it.
        let paths: Vec<&str> = request
            .paths
            .iter()
            .map(String::as_str)
            .filter(|path| {
                wt.join(path).exists()
                    || crate::team::library_git_capture(&wt, &["ls-files", "--", path]).is_ok_and(|out| !out.trim().is_empty())
            })
            .collect();
        if paths.is_empty() {
            return Err(ProposalError::NothingToPropose);
        }
        let mut add = vec!["add", "-A", "--"];
        add.extend(paths.iter().copied());
        crate::team::library_git_run(&wt, &add).map_err(ProposalError::Failed)?;
        let mut staged = vec!["diff", "--cached", "--quiet", "--"];
        staged.extend(paths.iter().copied());
        if crate::team::library_git_run(&wt, &staged).is_ok() {
            return Err(ProposalError::NothingToPropose);
        }
        let identity = crate::commit_identity::args_for(request.clone);
        crate::team::commit_staged(&wt, &paths, request.message, &identity).map_err(ProposalError::Failed)?;
        Ok(crate::team::library_git_capture(&wt, &["rev-parse", "HEAD"]).map_err(ProposalError::Failed)?.trim().to_string())
    })();
    remove_scratch(request.clone, &wt);
    made
}

/// Remove the scratch worktree and its registration in the clone. On
/// Windows a file just written may still be held open for a moment (an
/// indexer, an antivirus scan: os error 32), and `git worktree remove` then
/// fails; the folder is retried a few times, and the registration pruned
/// once it is gone, so no stale worktree stays listed in the team clone.
fn remove_scratch(clone: &Path, wt: &Path) {
    let wt_arg = wt.to_string_lossy().into_owned();
    if crate::team::library_git_run(clone, &["worktree", "remove", "--force", &wt_arg]).is_err() {
        for attempt in 0..5 {
            if !wt.exists() || std::fs::remove_dir_all(wt).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100 * (attempt + 1)));
        }
    }
    let _ = crate::team::library_git_run(clone, &["worktree", "prune"]);
}

/// The push of a proposal goes to a `plyloft/skill-…` branch and nowhere
/// else: never the branch the pull request merges into (the library's
/// default branch), whatever a stored proposal names.
pub fn branch_allowed(branch: &str, base_branch: &str) -> bool {
    branch.len() > BRANCH_PREFIX.len()
        && branch.starts_with(BRANCH_PREFIX)
        && branch != base_branch
        && !branch.contains("..")
        && !branch.ends_with('/')
}

/// Commit `write`'s change on `request.parent`, push it to `request.branch`
/// and open the pull request (or, with `reuse`, add the commit to the one
/// already open). Runs in the caller's GitHub account scope (the team's).
pub fn open(
    request: &Request<'_>,
    gh: &Gh,
    write: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Opened, ProposalError> {
    if !branch_allowed(request.branch, request.base_branch) {
        return Err(ProposalError::Failed(format!(
            "Plyloft only proposes on a branch of its own ({BRANCH_PREFIX}…), never on {}. Nothing \
             changed in the team library.",
            request.branch
        )));
    }
    let commit = commit_in_scratch(request, write)?;
    let git = Plumbing { cwd: request.clone.to_path_buf() };
    match git.push(&commit, request.branch) {
        PushResult::Pushed => {}
        PushResult::Refused(detail) if push_refusal(&detail) == Some(PushRefusal::ReadOnly) => {
            return Err(ProposalError::ReadOnly(detail))
        }
        PushResult::Refused(detail) | PushResult::Unreachable(detail)
            if push_refusal(&detail) == Some(PushRefusal::SignIn) =>
        {
            log::info!("skills: the pull request branch's push couldn't sign in to GitHub: {}", detail.trim());
            let ssh = crate::team::sign_in_cause(&detail) == Some(true);
            return Err(ProposalError::Failed(crate::team::sign_in_words(
                "open the pull request",
                crate::team::ConflictStage::Push,
                ssh,
            )));
        }
        PushResult::Refused(detail) | PushResult::NonFastForward(detail) => {
            return Err(ProposalError::Failed(format!(
                "GitHub didn't take the branch {} for the pull request. Nothing changed in the team \
                 library. ({})",
                request.branch,
                detail.trim()
            )))
        }
        PushResult::Unreachable(detail) => {
            return Err(ProposalError::Failed(format!(
                "Plyloft couldn't reach GitHub to open the pull request. Nothing changed in the team \
                 library; try again once you're online. ({})",
                detail.trim()
            )))
        }
    }
    let url = if request.reuse {
        gh.pr_for_branch(request.clone, request.slug, request.branch)
            .ok()
            .flatten()
            .map(|found| found.url)
            .unwrap_or_default()
    } else {
        String::new()
    };
    let url = if url.is_empty() {
        gh.pr_create(request.clone, request.slug, request.base_branch, request.branch, request.title, request.body)
            .map_err(|e| {
                ProposalError::Failed(format!(
                    "The branch {} is on GitHub, but the pull request couldn't be opened: {e}",
                    request.branch
                ))
            })?
    } else {
        url
    };
    Ok(Opened {
        number: crate::shared_config::pr_number(&url),
        url,
        branch: request.branch.to_string(),
        commit,
    })
}

/// R7 protected-branch fallback and the read-only refusal: a refused write takes
/// its own commit back, but an earlier push that may have landed can have left
/// one local commit on the clone's branch, and GitHub refuses it too. Once the
/// change lives somewhere else (the pull request's branch) or is refused for
/// good, the clone goes back to GitHub's tip, so the next write doesn't find
/// it ahead and ask to reapply a change nobody may publish. Only when `HEAD`
/// is exactly that one commit on top of the upstream; otherwise nothing is
/// touched.
pub fn drop_refused_commit(clone: &Path, commit: &str) -> Result<bool, String> {
    let head = crate::team::library_git_capture(clone, &["rev-parse", "HEAD"])?.trim().to_string();
    if head != commit {
        return Ok(false);
    }
    let parent = crate::team::library_git_capture(clone, &["rev-parse", "HEAD^"])?.trim().to_string();
    if parent != upstream_commit(clone)? {
        return Ok(false);
    }
    crate::team::library_git_run(clone, &["reset", "--keep", "--quiet", &parent])?;
    Ok(true)
}

#[cfg(test)]
#[path = "team_proposal_tests.rs"]
mod tests;
