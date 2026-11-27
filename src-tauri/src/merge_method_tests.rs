//! G3 (1.170.0): the merge method follows the repository. The repository
//! answers are the shape of `gh api repos/{o}/{r}` (read on 2026-10-26: a
//! repository the account can push to says the three `allow_*` fields; one
//! it can only read leaves them out).

use std::cell::RefCell;

use super::*;
use crate::workspace::WorkspaceStore;

const URL: &str = "https://github.com/o/r/pull/7";
const DAY: i64 = READ_EVERY_MS;

fn methods(squash: Option<bool>, merge: Option<bool>, rebase: Option<bool>) -> RepoMergeMethods {
    RepoMergeMethods { repo: "github.com/o/r".into(), squash, merge, rebase, read_at: 1_000 }
}

#[test]
fn squash_is_preferred_then_a_merge_commit_then_rebase() {
    use MergeMethod::*;
    let (y, n) = (Some(true), Some(false));
    let table = [
        ((y, y, y), Squash),
        ((y, n, n), Squash),
        ((n, y, y), Merge),
        ((n, y, n), Merge),
        ((n, n, y), Rebase),
        // GitHub always allows one; none said allowed reads as squash.
        ((n, n, n), Squash),
        // Not said (no push access): allowed — squash, as before G3.
        ((None, None, None), Squash),
        ((n, None, y), Merge),
    ];
    for ((s, m, r), want) in table {
        assert_eq!(methods(s, m, r).chosen(), want, "{s:?} {m:?} {r:?}");
    }
    assert_eq!(Squash.flag(), "--squash");
    assert_eq!(Merge.flag(), "--merge");
    assert_eq!(Rebase.flag(), "--rebase");
}

#[test]
fn the_repository_is_read_from_the_pull_request_address() {
    let (key, args) = repo_of(URL).unwrap();
    assert_eq!(key, "github.com/o/r");
    assert_eq!(args, ["api", "repos/o/r"]);
    let (key, args) = repo_of("https://git.example.com/team/app/pull/3").unwrap();
    assert_eq!(key, "git.example.com/team/app");
    assert_eq!(args, ["api", "--hostname", "git.example.com", "repos/team/app"]);
    assert_eq!(repo_of("https://github.com/o/r"), None);
}

#[test]
fn githubs_answer_is_read_with_and_without_the_three_fields() {
    let pushable = r#"{"full_name":"o/r","allow_squash_merge":false,"allow_merge_commit":true,"allow_rebase_merge":true}"#;
    let read = parse_repo(pushable, "github.com/o/r", 5).unwrap();
    assert_eq!(read, RepoMergeMethods { repo: "github.com/o/r".into(), squash: Some(false), merge: Some(true), rebase: Some(true), read_at: 5 });
    assert_eq!(read.chosen(), MergeMethod::Merge);
    let read_only = parse_repo(r#"{"full_name":"cli/cli","permissions":{"push":false}}"#, "github.com/cli/cli", 5).unwrap();
    assert_eq!((read_only.squash, read_only.merge, read_only.rebase), (None, None, None));
    assert_eq!(read_only.chosen(), MergeMethod::Squash);
    assert_eq!(parse_repo("not json", "x", 5), None);
    assert_eq!(parse_repo("[]", "x", 5), None);
}

#[test]
fn githubs_refusal_of_a_method_is_recognised() {
    for said in [
        "GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)",
        "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)",
        "GraphQL: Rebase merges are not allowed on this repository. (mergePullRequest)",
        "GraphQL: Merge method squash merging is not allowed on this repository (enablePullRequestAutoMerge)",
    ] {
        assert!(refused_for_method(said), "{said}");
    }
    for said in [
        "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)",
        "X Pull request o/r#3 is not mergeable: the base branch policy prohibits the merge.",
        "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)",
    ] {
        assert!(!refused_for_method(said), "{said}");
    }
}

#[test]
fn the_cache_is_used_for_a_day_and_read_again_after_or_when_asked() {
    let cached = methods(Some(false), Some(true), Some(true));
    let fresh = methods(Some(true), Some(true), Some(true));
    let read = |calls: &RefCell<u32>, answer: Option<RepoMergeMethods>| {
        *calls.borrow_mut() += 1;
        answer
    };
    let calls = RefCell::new(0);
    // Under a day old: no read.
    let got = resolve(Some(&cached), "github.com/o/r", false, 1_000 + DAY - 1, || read(&calls, Some(fresh.clone())));
    assert_eq!(got, (MergeMethod::Merge, None));
    assert_eq!(*calls.borrow(), 0);
    // A day old: read again, and kept.
    let got = resolve(Some(&cached), "github.com/o/r", false, 1_000 + DAY, || read(&calls, Some(fresh.clone())));
    assert_eq!(got, (MergeMethod::Squash, Some(fresh.clone())));
    // A refusal for the method: read again at once.
    let got = resolve(Some(&cached), "github.com/o/r", true, 1_001, || read(&calls, Some(fresh.clone())));
    assert_eq!(got.0, MergeMethod::Squash);
    // Another repository: read.
    let got = resolve(Some(&cached), "github.com/o/other", false, 1_001, || read(&calls, None));
    assert_eq!(got, (MergeMethod::Squash, None), "no answer, nothing of that repository: squash");
    assert_eq!(*calls.borrow(), 3);
    // A read that didn't reach GitHub keeps the old answer of that repository.
    let got = resolve(Some(&cached), "github.com/o/r", true, 1_001, || None);
    assert_eq!(got, (MergeMethod::Merge, None));
    // A clock set back reads again rather than trusting a future read time.
    let got = resolve(Some(&cached), "github.com/o/r", false, 10, || Some(fresh.clone()));
    assert_eq!(got.1, Some(fresh));
}

fn store_with(json: &str) -> (tempfile::TempDir, WorkspaceStore) {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("workspaces.json"), json).unwrap();
    let store = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    (tmp, store)
}

const OLD_FILE: &str = r#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1,"mergeWhenChecksPass":true}],"activeWorkspaceId":"w"}"#;

/// Schema migration: a `workspaces.json` from before G3 loads unchanged,
/// with no cache, and is written without the field until one is read.
#[test]
fn a_workspace_file_from_before_g3_loads_unchanged() {
    let (tmp, store) = store_with(OLD_FILE);
    let ws = store.snapshot().workspaces.into_iter().next().unwrap();
    assert!(ws.merge_methods.is_empty());
    assert!(ws.merge_when_checks_pass);
    let json = serde_json::to_value(&ws).unwrap();
    assert!(json.get("mergeMethods").is_none(), "left out of the file while empty");
    // Kept, and read back from disk.
    store.set_merge_methods("w", methods(Some(false), Some(true), None)).unwrap();
    let raw = std::fs::read_to_string(tmp.path().join("workspaces.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        v["workspaces"][0]["mergeMethods"],
        serde_json::json!({"github.com/o/r": {"repo": "github.com/o/r", "squash": false, "merge": true, "readAt": 1000}})
    );
    let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let ws = again.snapshot().workspaces.into_iter().next().unwrap();
    assert_eq!(ws.merge_methods.get("github.com/o/r"), Some(&methods(Some(false), Some(true), None)));
    // A cache a later build wrote with more in it still loads.
    let later: RepoMergeMethods =
        serde_json::from_str(r#"{"repo":"github.com/o/r","squash":true,"readAt":3,"autoMerge":true}"#).unwrap();
    assert_eq!(later.chosen(), MergeMethod::Squash);
}

/// G1–G3 Challenger (5), schema migration: G3's single answer
/// (`"mergeMethods": {"repo": …}`) loads as that repository's entry; a
/// second repository is kept beside it, not over it.
#[test]
fn g3s_single_answer_loads_into_the_per_repository_map() {
    let g3 = r#"{"workspaces":[{"id":"w","name":"n","cwd":"/tmp/n","createdAt":1,"lastOpenedAt":1,
        "mergeMethods":{"repo":"github.com/o/r","squash":false,"merge":true,"readAt":1000}}],"activeWorkspaceId":"w"}"#;
    let (tmp, store) = store_with(g3);
    let ws = store.snapshot().workspaces.into_iter().next().unwrap();
    assert_eq!(ws.merge_methods.0.len(), 1);
    assert_eq!(ws.merge_methods.get("github.com/o/r"), Some(&methods(Some(false), Some(true), None)));
    let other = RepoMergeMethods { repo: "github.com/o/fork".into(), squash: Some(true), merge: None, rebase: None, read_at: 2_000 };
    store.set_merge_methods("w", other.clone()).unwrap();
    let again = WorkspaceStore::new(tmp.path().to_path_buf()).unwrap();
    let ws = again.snapshot().workspaces.into_iter().next().unwrap();
    assert_eq!(ws.merge_methods.get("github.com/o/r").map(RepoMergeMethods::chosen), Some(MergeMethod::Merge));
    assert_eq!(ws.merge_methods.get("github.com/o/fork"), Some(&other));
    // A null the file may hold reads as empty.
    let empty: MergeMethodCache = serde_json::from_str("null").unwrap();
    assert!(empty.is_empty());
}

/// The map stays small: past its size, the oldest read goes.
#[test]
fn the_cache_keeps_at_most_a_few_repositories() {
    let mut cache = MergeMethodCache::default();
    for i in 0..(CACHE_MAX_REPOS as i64 + 3) {
        cache.insert(RepoMergeMethods { repo: format!("github.com/o/r{i}"), squash: None, merge: None, rebase: None, read_at: 100 + i });
    }
    assert_eq!(cache.0.len(), CACHE_MAX_REPOS);
    assert!(cache.get("github.com/o/r0").is_none() && cache.get("github.com/o/r2").is_none());
    assert!(cache.get(&format!("github.com/o/r{}", CACHE_MAX_REPOS + 2)).is_some());
}

/// G1–G3 Challenger (4): every method GitHub didn't say no to, in
/// Plyloft's order — what a refused merge tries next.
#[test]
fn the_allowed_methods_come_in_plyloft_order() {
    use MergeMethod::*;
    let (y, n) = (Some(true), Some(false));
    assert_eq!(methods(y, y, y).allowed(), [Squash, Merge, Rebase]);
    assert_eq!(methods(n, y, y).allowed(), [Merge, Rebase]);
    assert_eq!(methods(n, n, y).allowed(), [Rebase]);
    assert_eq!(methods(None, n, None).allowed(), [Squash, Rebase]);
    assert_eq!(methods(n, n, n).allowed(), [Squash, Merge, Rebase]);
}

/// Schema migration: a card's pull request from before G3 has no method;
/// the field is left out until a read sets it.
#[test]
fn a_pull_request_read_from_before_g3_loads_without_a_method() {
    let old = r#"{"number":3,"state":"open","checks":"pending","checksTotal":1,"checksPassed":0,
        "checksPending":1,"failingChecks":[],"mergeable":"unknown","reviewDecision":"none","checkedAt":10,
        "autoMerge":false,"pushedHead":"abc"}"#;
    let pr: crate::pr_status::PrStatus = serde_json::from_str(old).unwrap();
    assert_eq!(pr.merge_method, None);
    assert!(serde_json::to_value(&pr).unwrap().get("mergeMethod").is_none());
    let with = crate::pr_status::PrStatus { merge_method: Some(MergeMethod::Rebase), ..pr };
    let v = serde_json::to_value(&with).unwrap();
    assert_eq!(v["mergeMethod"], "rebase");
    assert_eq!(serde_json::from_value::<crate::pr_status::PrStatus>(v).unwrap().merge_method, Some(MergeMethod::Rebase));
}

/// Through the store: the first ask reads GitHub and keeps the answer; the
/// next one uses it; a refusal's re-read asks GitHub again.
#[test]
fn for_pr_reads_once_keeps_it_and_reads_again_when_refused() {
    let (_tmp, store) = store_with(OLD_FILE);
    let asked = RefCell::new(Vec::<String>::new());
    let answer = RefCell::new(r#"{"allow_squash_merge":false,"allow_merge_commit":true,"allow_rebase_merge":true}"#);
    let gh = |args: &[&str]| {
        asked.borrow_mut().push(args.join(" "));
        Ok(GhAnswer { ok: true, stdout: answer.borrow().to_string(), stderr: String::new() })
    };
    assert_eq!(for_pr(&store, "w", URL, false, gh), MergeMethod::Merge);
    assert_eq!(asked.borrow().as_slice(), ["api repos/o/r"]);
    let kept = store.snapshot().workspaces[0].merge_methods.get("github.com/o/r").cloned().unwrap();
    assert_eq!((kept.repo.as_str(), kept.squash, kept.merge), ("github.com/o/r", Some(false), Some(true)));
    assert_eq!(for_pr(&store, "w", URL, false, gh), MergeMethod::Merge);
    assert_eq!(asked.borrow().len(), 1, "the cache, not GitHub");
    *answer.borrow_mut() = r#"{"allow_squash_merge":false,"allow_merge_commit":false,"allow_rebase_merge":true}"#;
    assert_eq!(for_pr(&store, "w", URL, true, gh), MergeMethod::Rebase);
    assert_eq!(asked.borrow().len(), 2);
    assert_eq!(store.snapshot().workspaces[0].merge_methods.get("github.com/o/r").unwrap().chosen(), MergeMethod::Rebase);
    assert_eq!(methods_for_pr(&store, "w", URL, false, gh), [MergeMethod::Rebase]);
}

/// GitHub unreachable: squash (as before G3), nothing kept, and not asked
/// again on every read of the pull request.
#[test]
fn for_pr_without_an_answer_is_squash_and_keeps_nothing() {
    let (_tmp, store) = store_with(OLD_FILE);
    let asked = RefCell::new(0);
    let gh = |_: &[&str]| {
        *asked.borrow_mut() += 1;
        Err::<GhAnswer, String>("error connecting to api.github.com".into())
    };
    let url = "https://github.com/o/unreachable/pull/1";
    assert_eq!(for_pr(&store, "w", url, false, gh), MergeMethod::Squash);
    assert!(store.snapshot().workspaces[0].merge_methods.is_empty());
    // Nothing known: every method, squash first.
    assert_eq!(
        methods_for_pr(&store, "w", url, false, gh),
        [MergeMethod::Squash, MergeMethod::Merge, MergeMethod::Rebase]
    );
    assert_eq!(for_pr(&store, "w", url, false, gh), MergeMethod::Squash);
    assert_eq!(*asked.borrow(), 1, "tried again only after a while");
    // A refusal's re-read asks anyway.
    for_pr(&store, "w", url, true, gh);
    assert_eq!(*asked.borrow(), 2);
}
