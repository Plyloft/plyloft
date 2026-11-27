//! 1.170.0 G3: a card's pull request merges the way its repository allows.
//!
//! GitHub says which merge methods a repository allows
//! (`gh api repos/{o}/{r}` → `allow_squash_merge`, `allow_merge_commit`,
//! `allow_rebase_merge`). Plyloft prefers squash, else a merge commit, else
//! rebase; Merge, Merge when checks pass and the ship's own auto-merge all
//! use it. The answer is kept per workspace and repository with the time it
//! was read (`Workspace::merge_methods`, `workspaces.json`, personal to this
//! Mac; a small map keyed `host/owner/repo`, G1–G3 Challenger 5) and read
//! again at most once a day, or at once when GitHub refuses a merge because
//! of its method — then the other allowed methods are asked in order
//! (`pr_merge::ask_with_method`).
//!
//! GitHub only tells these three to someone who can push to the repository.
//! A read without them is kept too ("not said"), and reads as allowed: the
//! merge asks for squash, as before G3, and a refusal reads it again.
//!
//! Windows: the same `gh` calls through the same runner; nothing here is
//! platform-specific.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::pr_merge::GhAnswer;

/// How a pull request is merged (`gh pr merge --squash|--merge|--rebase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    pub fn flag(self) -> &'static str {
        match self {
            MergeMethod::Squash => "--squash",
            MergeMethod::Merge => "--merge",
            MergeMethod::Rebase => "--rebase",
        }
    }
}

/// What GitHub said of a repository's merge methods, and when. `None` for a
/// method: GitHub didn't say (no push access) — read as allowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMergeMethods {
    /// The repository read, `host/owner/repo` (`repo_key`): a workspace whose
    /// pull requests go elsewhere reads that one again.
    pub repo: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub squash: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebase: Option<bool>,
    /// When it was read (ms).
    #[serde(default)]
    pub read_at: i64,
}

impl RepoMergeMethods {
    /// Squash, else a merge commit, else rebase; squash when GitHub allows
    /// none it said (it always allows one).
    #[cfg(test)]
    pub fn chosen(&self) -> MergeMethod {
        self.allowed()[0]
    }

    /// G1–G3 Challenger (4): every method GitHub didn't say no to, squash
    /// first, then a merge commit, then rebase — what a merge refused for
    /// its method tries next. Never empty: all three when it said no to
    /// every one.
    pub fn allowed(&self) -> Vec<MergeMethod> {
        let said = [
            (MergeMethod::Squash, self.squash),
            (MergeMethod::Merge, self.merge),
            (MergeMethod::Rebase, self.rebase),
        ];
        let allowed: Vec<MergeMethod> = said.iter().filter(|(_, m)| *m != Some(false)).map(|(m, _)| *m).collect();
        if allowed.is_empty() {
            ALL_METHODS.to_vec()
        } else {
            allowed
        }
    }
}

/// Plyloft's order of preference, when nothing is known.
pub const ALL_METHODS: [MergeMethod; 3] = [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase];

/// The most repositories one workspace keeps an answer for; the oldest read
/// goes first.
pub const CACHE_MAX_REPOS: usize = 16;

/// G1–G3 Challenger (5): what GitHub said of each repository a workspace's
/// pull requests went to, keyed `host/owner/repo` (`repo_of`) — a workspace
/// whose cards open pull requests in two repositories keeps both. Read from
/// the single answer G3 wrote before it (`{"repo": …}`) too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct MergeMethodCache(pub BTreeMap<String, RepoMergeMethods>);

impl MergeMethodCache {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, repo: &str) -> Option<&RepoMergeMethods> {
        self.0.get(repo)
    }

    /// Keep `methods` under its repository; past [`CACHE_MAX_REPOS`], the
    /// oldest read is dropped.
    pub fn insert(&mut self, methods: RepoMergeMethods) {
        self.0.insert(methods.repo.clone(), methods);
        while self.0.len() > CACHE_MAX_REPOS {
            let Some(oldest) = self.0.iter().min_by_key(|(_, m)| m.read_at).map(|(k, _)| k.clone()) else { break };
            self.0.remove(&oldest);
        }
    }
}

impl<'de> Deserialize<'de> for MergeMethodCache {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Shape {
            /// G3 before the Challenger's fix: one repository's answer.
            One(RepoMergeMethods),
            Many(BTreeMap<String, RepoMergeMethods>),
        }
        let mut cache = MergeMethodCache::default();
        match Option::<Shape>::deserialize(d)? {
            Some(Shape::One(one)) => cache.insert(one),
            Some(Shape::Many(many)) => {
                for (repo, mut methods) in many {
                    // The key names the repository.
                    methods.repo = repo;
                    cache.insert(methods);
                }
            }
            None => {}
        }
        Ok(cache)
    }
}

/// Read again after a day.
pub const READ_EVERY_MS: i64 = 24 * 60 * 60 * 1000;
/// A read that didn't reach GitHub is tried again after this, not on every
/// read of the pull request.
const RETRY_AFTER_MS: i64 = 10 * 60 * 1000;

/// The repository of a pull request URL: its cache key (`host/owner/repo`)
/// and the `gh api` arguments that read it.
pub fn repo_of(pr_url: &str) -> Option<(String, Vec<String>)> {
    let pr = crate::pr_fix::pr_ref(pr_url)?;
    let key = format!("{}/{}/{}", pr.host, pr.owner, pr.repo);
    let mut args = vec!["api".to_string()];
    if pr.host != "github.com" {
        args.extend(["--hostname".to_string(), pr.host.clone()]);
    }
    args.push(format!("repos/{}/{}", pr.owner, pr.repo));
    Some((key, args))
}

/// GitHub's answer to `gh api repos/{o}/{r}`, read at `now`.
pub fn parse_repo(json: &str, repo: &str, now: i64) -> Option<RepoMergeMethods> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if !v.is_object() {
        return None;
    }
    let flag = |k: &str| v.get(k).and_then(serde_json::Value::as_bool);
    Some(RepoMergeMethods {
        repo: repo.to_string(),
        squash: flag("allow_squash_merge"),
        merge: flag("allow_merge_commit"),
        rebase: flag("allow_rebase_merge"),
        read_at: now,
    })
}

/// GitHub refused a merge (or auto-merge) because of its method. Its words
/// (GraphQL, through gh): "Squash merges are not allowed on this
/// repository.", "Merge commits are not allowed on this repository.",
/// "Merge method squash merging is not allowed on this repository".
pub fn refused_for_method(said: &str) -> bool {
    let lower = said.to_ascii_lowercase();
    lower.contains("not allowed on this repository")
        && (lower.contains("merge method") || lower.contains("merges are") || lower.contains("merge commits are"))
}

/// What to merge with, from `cached` for `repo` at `now`: the cached answer
/// while it is under a day old and of the same repository, unless `reread`;
/// else `read()`'s — and the answer to keep, when one was read. A read that
/// didn't reach GitHub keeps the old answer for that repository, if any.
#[cfg(test)]
pub fn resolve(
    cached: Option<&RepoMergeMethods>,
    repo: &str,
    reread: bool,
    now: i64,
    read: impl FnOnce() -> Option<RepoMergeMethods>,
) -> (MergeMethod, Option<RepoMergeMethods>) {
    let (known, fresh) = resolve_known(cached, repo, reread, now, read);
    (known.map_or(MergeMethod::Squash, |k| k.chosen()), fresh)
}

/// [`resolve`]'s answer as GitHub said it (None: nothing known of that
/// repository), and the answer to keep.
fn resolve_known(
    cached: Option<&RepoMergeMethods>,
    repo: &str,
    reread: bool,
    now: i64,
    read: impl FnOnce() -> Option<RepoMergeMethods>,
) -> (Option<RepoMergeMethods>, Option<RepoMergeMethods>) {
    let same = cached.filter(|c| c.repo == repo);
    if let Some(c) = same {
        if !reread && now - c.read_at < READ_EVERY_MS && c.read_at <= now {
            return (Some(c.clone()), None);
        }
    }
    match read() {
        Some(fresh) => (Some(fresh.clone()), Some(fresh)),
        None => (same.cloned(), None),
    }
}

fn tried() -> &'static Mutex<HashMap<String, i64>> {
    static TRIED: std::sync::OnceLock<Mutex<HashMap<String, i64>>> = std::sync::OnceLock::new();
    TRIED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The merge method for the workspace's pull request `pr_url`: the cached
/// answer, or GitHub's (`gh` as the caller runs it), kept in
/// `workspaces.json`. Never fails: no answer is squash, as before G3.
pub fn for_pr(
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
    pr_url: &str,
    reread: bool,
    gh: impl Fn(&[&str]) -> Result<GhAnswer, String>,
) -> MergeMethod {
    methods_for_pr(workspaces, workspace_id, pr_url, reread, gh)[0]
}

/// G1–G3 Challenger (4): [`for_pr`] as every method the repository allows,
/// in Plyloft's order (the first is `for_pr`'s); all three when nothing is
/// known. Never empty.
pub fn methods_for_pr(
    workspaces: &crate::workspace::WorkspaceStore,
    workspace_id: &str,
    pr_url: &str,
    reread: bool,
    gh: impl Fn(&[&str]) -> Result<GhAnswer, String>,
) -> Vec<MergeMethod> {
    let Some((repo, args)) = repo_of(pr_url) else {
        return ALL_METHODS.to_vec();
    };
    let cached = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|w| w.id == workspace_id)
        .and_then(|w| w.merge_methods.get(&repo).cloned());
    let now = crate::kanban::now_ms();
    let throttle = format!("{workspace_id}::{repo}");
    let (known, fresh) = resolve_known(cached.as_ref(), &repo, reread, now, || {
        if !reread {
            let last = tried().lock().unwrap_or_else(|p| p.into_inner()).get(&throttle).copied();
            if last.is_some_and(|at| now - at < RETRY_AFTER_MS && at <= now) {
                return None;
            }
        }
        tried().lock().unwrap_or_else(|p| p.into_inner()).insert(throttle.clone(), now);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        match gh(&refs) {
            Ok(a) if a.ok => parse_repo(&a.stdout, &repo, now),
            Ok(a) => {
                log::info!("merge_method: couldn't read {repo}'s merge methods: {}", a.stderr);
                None
            }
            Err(e) => {
                log::info!("merge_method: couldn't read {repo}'s merge methods: {e}");
                None
            }
        }
    });
    if let Some(fresh) = fresh {
        if let Err(e) = workspaces.set_merge_methods(workspace_id, fresh) {
            log::warn!("merge_method: couldn't keep {repo}'s merge methods: {e}");
        }
    }
    known.map_or_else(|| ALL_METHODS.to_vec(), |k| k.allowed())
}

#[cfg(test)]
#[path = "merge_method_tests.rs"]
mod tests;
