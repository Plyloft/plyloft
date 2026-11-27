//! SL-3 tests. The `sl3_*` fixtures and every `gh` answer below are real,
//! captured on 2026-09-28 with gh 2.101 from throwaway PRs in the sandbox
//! `test-owner/plyloft-ci-sandbox` (main requires the check `test`):
//! #3 (FAIL_CI: pending, failing; auto-merge on, off, on again; fixed, then
//! merged by auto-merge), #4 (merged directly), #5 (conflicting after #4,
//! auto-merge on), #6 (a base branch with no rules: `--auto` refused while
//! checks ran; once they passed, `--auto` merged it at once). The answer of
//! a repository that doesn't allow auto-merge at all was not captured (the
//! sandbox allows it and was not changed); its shape is GitHub's documented
//! GraphQL error, used only for the words test.

use std::cell::RefCell;

use super::*;
use crate::kanban::{KanbanColumnId, ReviewStatus};
use crate::pr_status::{parse_pr_view, pr_number_from_url};

const PENDING_AUTO: &str = include_str!("pr_status_fixtures/sl3_pending_auto.json");
const FAILING_AUTO: &str = include_str!("pr_status_fixtures/sl3_failing_auto.json");
const MERGED_BY_AUTO: &str = include_str!("pr_status_fixtures/sl3_merged_by_auto.json");
const CONFLICT_AUTO: &str = include_str!("pr_status_fixtures/sl3_conflict_auto.json");
const CLEAN: &str = include_str!("pr_status_fixtures/sl3_clean.json");

const BLOCKED: &str = "X Pull request test-owner/plyloft-ci-sandbox#3 is not mergeable: the base branch policy prohibits the merge.\n\
To have the pull request merged after all the requirements have been met, add the `--auto` flag.\n\
To use administrator privileges to immediately merge the pull request, add the `--admin` flag.";
const CONFLICTING: &str = "X Pull request test-owner/plyloft-ci-sandbox#5 is not mergeable: the merge commit cannot be cleanly created.\n\
To have the pull request merged after all the requirements have been met, add the `--auto` flag.\n\
Run the following to resolve the merge conflicts locally:\n  gh pr checkout 5 && git fetch origin main && git merge origin/main";
const ALREADY: &str = "! Pull request test-owner/plyloft-ci-sandbox#3 was already merged";
const NO_RULES: &str =
    "GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)";
/// Not captured: GitHub's documented error for a repository with auto-merge
/// switched off.
const NOT_ALLOWED: &str =
    "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)";

fn ok() -> GhAnswer {
    GhAnswer { ok: true, stdout: String::new(), stderr: String::new() }
}

fn refused(stderr: &str) -> GhAnswer {
    GhAnswer { ok: false, stdout: String::new(), stderr: stderr.to_string() }
}

fn card_with(json: &str) -> KanbanCard {
    let pr = parse_pr_view(json).unwrap();
    let url = format!("https://github.com/test-owner/plyloft-ci-sandbox/pull/{}", pr.number);
    let mut card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    card.pr_url = Some(url);
    card.review_status = Some(ReviewStatus::Merged);
    card.pr = Some(pr);
    card
}

/// A stub app: `gh` answers from a queue (and records its arguments);
/// each read of GitHub returns the next card.
struct Stub {
    gh: RefCell<Vec<Result<GhAnswer, String>>>,
    calls: RefCell<Vec<Vec<String>>>,
    reads: RefCell<Vec<Result<KanbanCard, String>>>,
    written: RefCell<Option<KanbanCard>>,
    /// G3: what each read of the repository's merge methods answers (squash
    /// once the queue is empty), and whether each read was a re-read.
    methods: RefCell<Vec<MergeMethod>>,
    method_reads: RefCell<Vec<bool>>,
    /// G1–G3 Challenger (4): whole answers (every allowed method), before
    /// `methods`.
    orders: RefCell<Vec<Vec<MergeMethod>>>,
    /// Walk fix: whether the base branch requires checks (GitHub's
    /// auto-merge waits only then).
    required: RefCell<Option<bool>>,
    /// Round 3 (S4): the card branch's tip on this computer. Unset: where
    /// GitHub has the pull request (the two in step, as they usually are).
    local: RefCell<Option<Option<String>>>,
}

impl Stub {
    fn new(reads: Vec<Result<KanbanCard, String>>, gh: Vec<Result<GhAnswer, String>>) -> Self {
        Self {
            gh: RefCell::new(gh),
            calls: RefCell::new(Vec::new()),
            reads: RefCell::new(reads),
            written: RefCell::new(None),
            methods: RefCell::new(Vec::new()),
            method_reads: RefCell::new(Vec::new()),
            orders: RefCell::new(Vec::new()),
            required: RefCell::new(Some(true)),
            local: RefCell::new(None),
        }
    }
    fn with_required(self, required: Option<bool>) -> Self {
        *self.required.borrow_mut() = required;
        self
    }
    fn with_orders(self, orders: Vec<Vec<MergeMethod>>) -> Self {
        *self.orders.borrow_mut() = orders;
        self
    }
    fn with_methods(self, methods: Vec<MergeMethod>) -> Self {
        *self.methods.borrow_mut() = methods;
        self
    }
    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().clone()
    }
}

impl MergeEnv for Stub {
    fn gh(&self, args: &[&str]) -> Result<GhAnswer, String> {
        self.calls.borrow_mut().push(args.iter().map(|a| a.to_string()).collect());
        let mut q = self.gh.borrow_mut();
        assert!(!q.is_empty(), "unexpected gh {}", args.join(" "));
        q.remove(0)
    }
    fn refresh(&self) -> Result<KanbanCard, String> {
        let mut q = self.reads.borrow_mut();
        assert!(!q.is_empty(), "unexpected read");
        let read = q.remove(0);
        if let Ok(card) = &read {
            *self.written.borrow_mut() = Some(card.clone());
        }
        read
    }
    fn checks_required(&self, _url: &str) -> Option<bool> {
        *self.required.borrow()
    }
    fn local_tip(&self, card: &KanbanCard) -> Option<String> {
        match self.local.borrow().clone() {
            Some(set) => set,
            None => card.pr.as_ref().and_then(|pr| pr.head_sha.clone()),
        }
    }
    fn methods(&self, _url: &str, reread: bool) -> Vec<MergeMethod> {
        self.method_reads.borrow_mut().push(reread);
        let mut orders = self.orders.borrow_mut();
        if !orders.is_empty() {
            return orders.remove(0);
        }
        let mut q = self.methods.borrow_mut();
        vec![if q.is_empty() { MergeMethod::Squash } else { q.remove(0) }]
    }
    fn record(&self, f: &dyn Fn(&mut PrStatus)) -> Result<KanbanCard, String> {
        let mut card = self.written.borrow().clone().expect("a card was read first");
        f(card.pr.as_mut().unwrap());
        *self.written.borrow_mut() = Some(card.clone());
        Ok(card)
    }
}

const URL3: &str = "https://github.com/test-owner/plyloft-ci-sandbox/pull/3";
/// The heads of the fixtures (`headRefOid`).
const CLEAN_HEAD: &str = "a0a74794ac3eada32f2784f95c7dde0609914535";
const PENDING_HEAD: &str = "c42715b69b9e409c4a5dad796dbfeb1c1c11fdcf";
const SQUASH: MergeMethod = MergeMethod::Squash;

// ── Reading GitHub ──────────────────────────────────────────────────────

#[test]
fn auto_merge_is_read_from_github_and_only_while_open() {
    assert!(parse_pr_view(PENDING_AUTO).unwrap().auto_merge);
    assert!(parse_pr_view(FAILING_AUTO).unwrap().auto_merge);
    assert!(parse_pr_view(CONFLICT_AUTO).unwrap().auto_merge);
    assert!(!parse_pr_view(CLEAN).unwrap().auto_merge);
    // A merged PR keeps its autoMergeRequest on GitHub; it waits on nothing.
    let merged = parse_pr_view(MERGED_BY_AUTO).unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert!(!merged.auto_merge);
}

#[test]
fn a_refusal_stays_on_the_card_until_auto_merge_is_on() {
    let mut card = card_with(CLEAN);
    card.pr.as_mut().unwrap().auto_merge_refused = Some(NO_RULES.into());
    let next = parse_pr_view(CLEAN).unwrap();
    crate::pr_status::apply_status(&mut card, next, 5, "1.0.0").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().auto_merge_refused.as_deref(), Some(NO_RULES));
    // On from GitHub (turned on there, or a retry): the refusal goes.
    let mut on = serde_json::from_str::<serde_json::Value>(CLEAN).unwrap();
    on["autoMergeRequest"] = serde_json::from_str::<serde_json::Value>(PENDING_AUTO).unwrap()["autoMergeRequest"].clone();
    crate::pr_status::apply_status(&mut card, parse_pr_view(&on.to_string()).unwrap(), 6, "1.0.0").unwrap();
    let pr = card.pr.as_ref().unwrap();
    assert!(pr.auto_merge);
    assert_eq!(pr.auto_merge_refused, None);
}

#[test]
fn a_card_from_before_sl3_loads_with_auto_merge_off() {
    // SL-1's shape of `pr`, without the two SL-3 fields.
    let old = r#"{"number":3,"state":"open","checks":"pending","checksTotal":1,"checksPassed":0,
        "checksPending":1,"failingChecks":[],"mergeable":"unknown","mergeState":"blocked",
        "reviewDecision":"none","checkedAt":10}"#;
    let pr: PrStatus = serde_json::from_str(old).unwrap();
    assert!(!pr.auto_merge);
    assert_eq!(pr.auto_merge_refused, None);
    let back = serde_json::to_value(&pr).unwrap();
    assert_eq!(back["autoMerge"], false);
}

// ── gh's answers ────────────────────────────────────────────────────────

#[test]
fn merge_answers_read_as_github_gave_them() {
    assert_eq!(read_merge_answer(&ok()), MergeAnswer::Merged);
    // Already merged exits 0 with a warning on stderr.
    let already = GhAnswer { ok: true, stdout: String::new(), stderr: ALREADY.into() };
    assert_eq!(read_merge_answer(&already), MergeAnswer::AlreadyMerged);
    assert_eq!(read_merge_answer(&refused(BLOCKED)), MergeAnswer::Refused(BLOCKED.into()));
    assert_eq!(
        read_merge_answer(&GhAnswer { ok: false, stdout: String::new(), stderr: String::new() }),
        MergeAnswer::Refused("GitHub CLI stopped without saying why".into())
    );
}

#[test]
fn refused_merge_words_say_what_github_meant() {
    let open = parse_pr_view(PENDING_AUTO).unwrap();
    let mut off = open.clone();
    off.auto_merge = false;
    assert!(refused_merge_words(CONFLICTING, &off).contains("conflicts with its base branch"));
    let blocked = refused_merge_words(BLOCKED, &off);
    assert!(blocked.contains("base branch rules aren't met"), "{blocked}");
    assert!(blocked.contains("Merge when checks pass"));
    assert!(!blocked.contains("--admin"));
    // Already on, or GitHub already refused it: no advice to turn it on.
    assert!(open.auto_merge);
    assert!(!refused_merge_words(BLOCKED, &open).contains("Merge when checks pass"));
    let mut refused_before = off.clone();
    refused_before.auto_merge_refused = Some(NOT_ALLOWED.into());
    let words = refused_merge_words(BLOCKED, &refused_before);
    assert!(words.contains("base branch rules") && !words.contains("Merge when checks pass"), "{words}");
    assert_eq!(refused_merge_words("HTTP 502", &off), "Not merged: GitHub refused. Its answer is below.");
}

#[test]
fn merge_is_refused_on_a_failed_check_or_a_conflict_and_closed() {
    let failing = parse_pr_view(FAILING_AUTO).unwrap();
    let words = merge_refusal(&failing).unwrap();
    assert!(words.starts_with("Not merged: checks failed on GitHub (test)"), "{words}");
    let conflict = parse_pr_view(CONFLICT_AUTO).unwrap();
    assert_eq!(conflict.mergeable, PrMergeable::Conflicting);
    assert_eq!(merge_refusal(&conflict).as_deref(), Some(CONFLICT_WORDS));
    let mut closed = parse_pr_view(CLEAN).unwrap();
    closed.state = PrState::Closed;
    assert!(merge_refusal(&closed).unwrap().contains("closed"));
    // Pending checks and a clean PR are GitHub's to judge.
    assert_eq!(merge_refusal(&parse_pr_view(PENDING_AUTO).unwrap()), None);
    assert_eq!(merge_refusal(&parse_pr_view(CLEAN).unwrap()), None);
}

#[test]
fn the_arguments_carry_the_method_and_the_head_and_never_admin() {
    let head = Some(CLEAN_HEAD);
    assert_eq!(merge_args(URL3, SQUASH, head), ["pr", "merge", URL3, "--squash", "--match-head-commit", CLEAN_HEAD]);
    assert_eq!(merge_args(URL3, MergeMethod::Merge, head)[3], "--merge");
    assert_eq!(merge_args(URL3, MergeMethod::Rebase, head)[3], "--rebase");
    assert_eq!(
        auto_merge_args(URL3, MergeMethod::Merge, head),
        ["pr", "merge", URL3, "--merge", "--match-head-commit", CLEAN_HEAD, "--auto"]
    );
    // No head known (no read of GitHub yet): no match.
    assert_eq!(merge_args(URL3, SQUASH, None), ["pr", "merge", URL3, "--squash"]);
    assert_eq!(disable_auto_merge_args(URL3), ["pr", "merge", URL3, "--disable-auto"]);
    for args in [merge_args(URL3, SQUASH, head), auto_merge_args(URL3, MergeMethod::Rebase, head)] {
        assert!(!args.contains(&"--admin"));
    }
}

/// G3: the head a merge must match is the commit Plyloft pushed; GitHub's
/// head only for a pull request shipped before Plyloft recorded it.
#[test]
fn a_merge_matches_the_head_plyloft_pushed() {
    let mut pr = parse_pr_view(CLEAN).unwrap();
    assert_eq!(merge_head(&pr).as_deref(), Some(CLEAN_HEAD), "no pushed head recorded");
    pr.pushed_head = Some("1111111111111111111111111111111111111111".into());
    assert_eq!(merge_head(&pr).as_deref(), Some("1111111111111111111111111111111111111111"), "GitHub's head moved on: the pushed one");
    pr.pushed_head = Some(CLEAN_HEAD[..12].into());
    assert_eq!(merge_head(&pr).as_deref(), Some(CLEAN_HEAD), "a short name: GitHub's full one");
    pr.pushed_head = Some(String::new());
    pr.head_sha = None;
    assert_eq!(merge_head(&pr), None);
}

// ── The Merge flow (stubbed gh) ─────────────────────────────────────────

#[test]
fn merge_success_reads_again_so_the_merged_transition_runs() {
    let clean = card_with(CLEAN);
    let url = clean.pr_url.clone().unwrap();
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let stub = Stub::new(vec![Ok(clean), Ok(merged)], vec![Ok(ok())]);
    let r = merge(&stub, None).unwrap();
    assert!(r.merged);
    assert_eq!(r.refused, None);
    assert_eq!(r.card.pr.unwrap().state, PrState::Merged);
    assert_eq!(stub.calls(), vec![vec!["pr", "merge", url.as_str(), "--squash", "--match-head-commit", CLEAN_HEAD]]);
    assert_eq!(*stub.method_reads.borrow(), [false], "the cached method, not a re-read");
}

/// 1.175.0 (A8, OP-8): a pull request the card holds no head for is never
/// merged as "whatever GitHub has": its head is read and the merge is held to
/// it; a read that gives no commit asks GitHub for nothing.
#[test]
fn a_merge_without_a_recorded_head_reads_it_first_and_never_goes_without() {
    let headless = || {
        let mut card = card_with(CLEAN);
        let pr = card.pr.as_mut().unwrap();
        pr.pushed_head = None;
        pr.head_sha = None;
        card
    };
    let url = headless().pr_url.clone().unwrap();
    let read = |text: &str| GhAnswer { ok: true, stdout: text.into(), stderr: String::new() };
    let view = vec!["pr", "view", url.as_str(), "--json", "headRefOid", "--jq", ".headRefOid"];

    // Merge: the head is read, then asked for.
    let mut merged = headless();
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let stub = Stub::new(vec![Ok(headless()), Ok(merged)], vec![Ok(read(&format!("{CLEAN_HEAD}\n"))), Ok(ok())]);
    assert!(merge(&stub, None).unwrap().merged);
    assert_eq!(
        stub.calls(),
        vec![view.clone(), vec!["pr", "merge", url.as_str(), "--squash", "--match-head-commit", CLEAN_HEAD]]
    );

    // No commit in the answer, or gh failing: no merge is asked, and nothing
    // says GitHub refused one (round 3, S4) — the words of a failed read.
    for (answer, said) in [
        (read(""), "GitHub CLI stopped without saying why"),
        (read("null"), "GitHub CLI stopped without saying why"),
        (GhAnswer { ok: false, stdout: String::new(), stderr: "HTTP 502".into() }, "HTTP 502"),
    ] {
        let stub = Stub::new(vec![Ok(headless())], vec![Ok(answer)]);
        let failed = merge(&stub, None).unwrap_err();
        assert_eq!(failed, format!("couldn't read the pull request on GitHub: {said}"));
        assert!(!failed.contains("refused"));
        assert_eq!(stub.calls(), vec![view.clone()], "nothing but the read");
    }

    // Merge when checks pass (round 3, S4): GitHub merges it later by itself,
    // so it is never held to a head just read from GitHub. A card that
    // vouches for nothing GitHub has is refused before GitHub is asked.
    let stub = Stub::new(vec![Ok(headless())], vec![]);
    let r = set_auto_merge(&stub, true).unwrap();
    assert_eq!(r.refused.as_deref(), Some(HEAD_MOVED_WORDS));
    assert_eq!(r.github, None, "GitHub was asked nothing");
    assert!(stub.calls().is_empty());
    // GitHub shows a head and the card records none of its own (a pull
    // request from before Plyloft kept what it pushed): the card branch's
    // tip on this computer decides. None here, or another commit: the same.
    for local in [None, Some(PENDING_HEAD.to_string())] {
        let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![]);
        *stub.local.borrow_mut() = Some(local);
        assert_eq!(set_auto_merge(&stub, true).unwrap().refused.as_deref(), Some(HEAD_MOVED_WORDS));
        assert!(stub.calls().is_empty());
    }
    // At the very commit GitHub has: held to it.
    let mut on = card_with(CLEAN);
    on.pr.as_mut().unwrap().auto_merge = true;
    let stub = Stub::new(vec![Ok(card_with(CLEAN)), Ok(on)], vec![Ok(ok())]);
    *stub.local.borrow_mut() = Some(Some(CLEAN_HEAD.to_string()));
    assert_eq!(set_auto_merge(&stub, true).unwrap().refused, None);
    assert_eq!(stub.calls().len(), 1);
    assert!(stub.calls()[0].ends_with(&["--match-head-commit".to_string(), CLEAN_HEAD.to_string(), "--auto".to_string()]));
    // The Builder's last checked commit is what GitHub has: held to it.
    let checked = |sha: &str| {
        let mut card = card_with(CLEAN);
        let mut builder: crate::kanban::BuilderState = serde_json::from_value(serde_json::json!({
            "vendor": "claude", "bypass": false, "startedAt": 1, "snapshots": []
        }))
        .unwrap();
        builder.snapshots.push(crate::kanban::BuildSnapshot { n: 1, sha: sha.to_string(), at: 1 });
        card.builder = Some(builder);
        card
    };
    let mut on = checked(CLEAN_HEAD);
    on.pr.as_mut().unwrap().auto_merge = true;
    let stub = Stub::new(vec![Ok(checked(CLEAN_HEAD)), Ok(on)], vec![Ok(ok())]);
    assert_eq!(set_auto_merge(&stub, true).unwrap().refused, None);
    assert_eq!(
        stub.calls(),
        vec![vec!["pr", "merge", url.as_str(), "--squash", "--match-head-commit", CLEAN_HEAD, "--auto"]]
    );
    // …and another commit on GitHub is not.
    let stub = Stub::new(vec![Ok(checked(PENDING_HEAD))], vec![]);
    assert_eq!(set_auto_merge(&stub, true).unwrap().refused.as_deref(), Some(HEAD_MOVED_WORDS));
    assert!(stub.calls().is_empty());
}

#[test]
fn merge_says_merged_when_github_did_though_the_read_after_failed() {
    let stub = Stub::new(
        vec![Ok(card_with(CLEAN)), Err("error connecting to api.github.com".into())],
        vec![Ok(ok())],
    );
    let r = merge(&stub, None).unwrap();
    assert!(r.merged);
    assert_eq!(r.card.pr.unwrap().state, PrState::Open, "the poller reads it later");
}

#[test]
fn merge_of_an_already_merged_pr_is_the_merge() {
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let already = GhAnswer { ok: true, stdout: String::new(), stderr: ALREADY.into() };
    let stub = Stub::new(vec![Ok(card_with(CLEAN)), Ok(merged)], vec![Ok(already)]);
    assert!(merge(&stub, None).unwrap().merged);
    // Read as merged already: gh isn't asked at all.
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let stub = Stub::new(vec![Ok(merged)], vec![]);
    assert!(merge(&stub, None).unwrap().merged);
    assert!(stub.calls().is_empty());
}

#[test]
fn merge_with_failing_checks_or_a_conflict_never_asks_github() {
    for json in [FAILING_AUTO, CONFLICT_AUTO] {
        let stub = Stub::new(vec![Ok(card_with(json))], vec![]);
        let r = merge(&stub, None).unwrap();
        assert!(!r.merged);
        assert!(r.refused.unwrap().starts_with("Not merged:"));
        assert_eq!(r.github, None);
        assert!(stub.calls().is_empty());
    }
}

#[test]
fn merge_refused_by_github_shows_its_answer_as_is() {
    // Pending on a protected base: GitHub's rule refuses it.
    let stub = Stub::new(vec![Ok(card_with(PENDING_AUTO))], vec![Ok(refused(BLOCKED))]);
    let r = merge(&stub, None).unwrap();
    assert!(!r.merged);
    assert_eq!(r.github.as_deref(), Some(BLOCKED));
    assert!(r.refused.unwrap().contains("base branch rules"));
    // A conflict GitHub found before Plyloft's read did.
    let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Ok(refused(CONFLICTING))]);
    let r = merge(&stub, None).unwrap();
    assert_eq!(r.refused.as_deref(), Some(CONFLICT_WORDS));
    assert_eq!(r.github.as_deref(), Some(CONFLICTING));
}

#[test]
fn merge_errors_when_github_cant_be_read_or_gh_fails() {
    let stub = Stub::new(vec![Err("offline".into())], vec![]);
    assert_eq!(merge(&stub, None).unwrap_err(), "offline");
    let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Err("gh timed out".into())]);
    assert_eq!(merge(&stub, None).unwrap_err(), "gh timed out");
    // A card shipped before SL-1 has no PR state: left as it is.
    let mut legacy = card_with(CLEAN);
    legacy.pr = None;
    let stub = Stub::new(vec![Ok(legacy)], vec![]);
    assert_eq!(merge(&stub, None).unwrap_err(), crate::pr_status::LEGACY_REFUSAL);
}

// ── Auto-merge from the card ────────────────────────────────────────────

#[test]
fn turning_auto_merge_on_and_off_reads_github_after() {
    let on = card_with(PENDING_AUTO);
    let mut off = card_with(PENDING_AUTO);
    off.pr.as_mut().unwrap().auto_merge = false;
    let url = on.pr_url.clone().unwrap();
    let stub = Stub::new(vec![Ok(off.clone()), Ok(on.clone())], vec![Ok(ok())]);
    let r = set_auto_merge(&stub, true).unwrap();
    assert!(r.card.pr.unwrap().auto_merge);
    assert_eq!(
        stub.calls(),
        vec![vec!["pr", "merge", url.as_str(), "--squash", "--match-head-commit", PENDING_HEAD, "--auto"]]
    );

    let stub = Stub::new(vec![Ok(on), Ok(off)], vec![Ok(ok())]);
    let r = set_auto_merge(&stub, false).unwrap();
    assert!(!r.card.pr.unwrap().auto_merge);
    assert_eq!(stub.calls(), vec![vec!["pr", "merge", url.as_str(), "--disable-auto"]]);
}

#[test]
fn auto_merge_on_a_clean_pr_merges_it_at_once() {
    // Real (#6): `--auto` on a PR ready to merge merged it right away.
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let stub = Stub::new(vec![Ok(card_with(CLEAN)), Ok(merged)], vec![Ok(ok())]);
    assert!(set_auto_merge(&stub, true).unwrap().merged);
}

#[test]
fn auto_merge_refused_is_kept_on_the_card_and_merge_stays() {
    for answer in [NO_RULES, NOT_ALLOWED] {
        let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Ok(refused(answer))]);
        let r = set_auto_merge(&stub, true).unwrap();
        let pr = r.card.pr.clone().unwrap();
        assert!(!pr.auto_merge);
        assert_eq!(pr.auto_merge_refused.as_deref(), Some(answer));
        assert_eq!(r.github.as_deref(), Some(answer));
        assert!(!r.merged);
        assert_eq!(merge_refusal(&pr), None, "Merge is still offered");
    }
}

#[test]
fn auto_merge_on_a_merged_or_closed_pr_is_refused_without_gh() {
    let mut closed = card_with(CLEAN);
    closed.pr.as_mut().unwrap().state = PrState::Closed;
    let stub = Stub::new(vec![Ok(closed)], vec![]);
    assert!(set_auto_merge(&stub, true).unwrap().refused.is_some());
    assert!(stub.calls().is_empty());
}

// ── Right after the ship ────────────────────────────────────────────────

#[test]
fn after_ship_on_or_refused_is_recorded_and_never_fails() {
    let mut card = card_with(CLEAN);
    let url = card.pr_url.clone().unwrap();
    assert!(record_after_ship(&mut card, &url, &Ok(ok())));
    assert!(card.pr.as_ref().unwrap().auto_merge);

    assert!(record_after_ship(&mut card, &url, &Ok(refused(NOT_ALLOWED))));
    let pr = card.pr.as_ref().unwrap();
    assert!(!pr.auto_merge);
    assert_eq!(pr.auto_merge_refused.as_deref(), Some(NOT_ALLOWED));

    // No answer from GitHub (timed out, offline, gh missing) isn't a refusal:
    // nothing is recorded.
    let before = card.pr.clone();
    assert!(!record_after_ship(&mut card, &url, &Err("`gh pr merge` was stopped after 60s".into())));
    assert_eq!(card.pr, before);

    // A card that now records another PR is left alone.
    assert!(!record_after_ship(&mut card, URL3, &Ok(ok())));
    assert_eq!(pr_number_from_url(card.pr_url.as_deref().unwrap()), Some(4));
}

#[test]
fn after_ship_leaves_a_card_without_pr_state_alone() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let url = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";
    let mut card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    card.pr_url = Some(url.into());
    card.review_status = Some(ReviewStatus::Merged);
    card.pr = None;
    store.save("ws", vec![card.clone()]).unwrap();
    let path = dir.path().join(crate::kanban::KANBAN_SUBDIR).join("ws.json");
    let on_disk = std::fs::read(&path).unwrap();
    assert!(!record_after_ship(&mut card.clone(), url, &Ok(ok())));
    turn_on_after_ship(&store, "ws", "c1", url, CLEAN_HEAD, |_| vec![SQUASH], |_| Some(true), |_| Ok(ok()));
    let after = store.get_card("ws", "c1").unwrap();
    assert_eq!(after.pr, None);
    assert_eq!(std::fs::read(&path).unwrap(), on_disk, "nothing written");
}

#[test]
fn after_ship_a_transport_error_writes_nothing_through_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card]).unwrap();
    let url = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";
    store.mark_card_pr_shipped("ws", "c1", url, None).unwrap();
    turn_on_after_ship(&store, "ws", "c1", url, CLEAN_HEAD, |_| vec![SQUASH], |_| Some(true), |_| Err("error connecting to api.github.com".into()));
    let pr = store.get_card("ws", "c1").unwrap().pr.unwrap();
    assert!(!pr.auto_merge);
    assert_eq!(pr.auto_merge_refused, None);
}

#[test]
fn a_ship_that_turned_auto_merge_on_is_read_again() {
    let mut on = card_with(PENDING_AUTO);
    assert!(read_after_ship("pr", &on));
    assert!(!read_after_ship("local_merge", &on));
    on.pr.as_mut().unwrap().auto_merge = false;
    assert!(!read_after_ship("pr", &on), "auto-merge off: the poller reads it as usual");
    let mut merged = card_with(MERGED_BY_AUTO);
    merged.pr.as_mut().unwrap().auto_merge = true;
    assert!(!read_after_ship("pr", &merged));
}

#[test]
fn an_old_gh_without_auto_merge_request_is_recognised() {
    // gh's answer to a field it doesn't know (the shape seen with
    // `gh repo view --json autoMergeAllowed`, gh 2.101).
    assert!(crate::pr_status::gh_lacks_auto_merge_field(
        "Unknown JSON field: \"autoMergeRequest\"\nAvailable fields:\n  additions"
    ));
    assert!(!crate::pr_status::gh_lacks_auto_merge_field("HTTP 502"));
    let fields = crate::pr_status::PR_VIEW_FIELDS_WITHOUT_AUTO_MERGE;
    assert!(!fields.contains("autoMergeRequest"));
    assert_eq!(format!("{fields},autoMergeRequest"), crate::pr_status::PR_VIEW_FIELDS);
}

#[test]
fn after_ship_writes_the_board_through_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card.clone()]).unwrap();
    let url = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";
    store.mark_card_pr_shipped("ws", &card.id, url, None).unwrap();
    let asked = RefCell::new(Vec::new());
    turn_on_after_ship(&store, "ws", &card.id, url, CLEAN_HEAD, |_| vec![SQUASH], |_| Some(true), |args| {
        asked.borrow_mut().push(args.join(" "));
        Ok(refused(NO_RULES))
    });
    assert_eq!(asked.borrow().as_slice(), [format!("pr merge {url} --squash --match-head-commit {CLEAN_HEAD} --auto")]);
    let pr = store.get_card("ws", &card.id).unwrap().pr.unwrap();
    assert_eq!(pr.auto_merge_refused.as_deref(), Some(NO_RULES));
    turn_on_after_ship(&store, "ws", &card.id, url, CLEAN_HEAD, |_| vec![SQUASH], |_| Some(true), |_| Ok(ok()));
    let pr = store.get_card("ws", &card.id).unwrap().pr.unwrap();
    assert!(pr.auto_merge);
    assert_eq!(pr.auto_merge_refused, None);
}

/// The real `gh` path: a stub program run through the bounded runner, as the
/// other `gh` tests do (`github::gh_stub_program`).
#[cfg(unix)]
#[test]
fn gh_merge_runs_bounded_and_its_answer_is_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pr"),
        format!("echo \"$@\" > args\nprintf '%s\\n' \"{}\" >&2\nexit 1\n", "X Pull request is not mergeable: the base branch policy prohibits the merge."),
    )
    .unwrap();
    let program = crate::github::gh_stub_program(dir.path());
    let out = crate::github::gh_output(
        &program,
        Some(dir.path()),
        &merge_args(URL3, SQUASH, Some(CLEAN_HEAD)),
        std::time::Duration::from_secs(10),
    )
    .unwrap();
    let answer = GhAnswer::from_output(&out);
    assert!(!answer.ok);
    assert!(refused_merge_words(&answer.stderr, &PrStatus::default()).contains("base branch rules"));
    let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
    assert_eq!(args.trim(), format!("merge {URL3} --squash --match-head-commit {CLEAN_HEAD}"));
}

/// v1.154.1 (M1, ADR 0006): while the Challenger's request for changes covers
/// the latest snapshot, Merge refuses in words and never asks GitHub; once
/// the pushback is accepted, it merges.
#[test]
fn merge_is_refused_while_the_challenger_asks_for_changes() {
    let asked = || {
        let mut c = card_with(CLEAN);
        c.builder = Some(
            serde_json::from_value(serde_json::json!({
                "vendor": "claude",
                "snapshots": [{"n": 2, "sha": "abc", "at": 1}],
                "review": {"snapshotN": 2, "provider": "codex", "status": "done",
                           "verdict": "changes_requested", "at": 2}
            }))
            .unwrap(),
        );
        c
    };
    let stub = Stub::new(vec![Ok(asked())], vec![]);
    let r = merge(&stub, None).unwrap();
    assert!(!r.merged);
    assert_eq!(r.refused.as_deref(), Some(changes_requested_words("Claude").as_str()));
    assert!(stub.calls().is_empty(), "GitHub is not asked");

    let mut overridden = asked();
    let review = overridden.builder.as_mut().unwrap().review.as_mut().unwrap();
    review.status = "skipped".into();
    review.verdict = None;
    let mut merged = card_with(MERGED_BY_AUTO);
    merged.pr_url = overridden.pr_url.clone();
    let stub = Stub::new(vec![Ok(overridden), Ok(merged)], vec![Ok(ok())]);
    assert!(merge(&stub, None).unwrap().merged);
}

/// v1.154.1 (walk I1, Challenger): right after a push GitHub may still show
/// the old head's failure; the refusal says what the card shows — the wait
/// for the new checks — not the old failure.
#[test]
fn the_wait_for_a_push_checks_is_refused_before_an_old_failure() {
    let mut failing = PrStatus { state: PrState::Open, checks: PrChecks::Failing, ..Default::default() };
    failing.awaiting_checks = true;
    assert_eq!(merge_refusal(&failing).as_deref(), Some(AWAITING_CHECKS_WORDS));
    assert!(AWAITING_CHECKS_WORDS.contains("or this repository has none"));
    failing.awaiting_checks = false;
    assert!(merge_refusal(&failing).unwrap().contains("checks failed"));
    // Closed still says closed.
    let closed = PrStatus { state: PrState::Closed, awaiting_checks: true, ..Default::default() };
    assert!(merge_refusal(&closed).unwrap().contains("closed"));
}

// ── G3: the repository's merge method ───────────────────────────────────

/// GitHub's words for a method the repository doesn't allow (GraphQL
/// through gh; not captured from the sandbox, which allows all three — the
/// Tier 4 walk turns squash off there).
const SQUASH_NOT_ALLOWED: &str = "GraphQL: Squash merges are not allowed on this repository. (mergePullRequest)";
const AUTO_SQUASH_NOT_ALLOWED: &str =
    "GraphQL: Merge method squash merging is not allowed on this repository (enablePullRequestAutoMerge)";
const HEAD_MODIFIED: &str = "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";

#[test]
fn merge_uses_the_method_the_repository_allows() {
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let url = merged.pr_url.clone().unwrap();
    let stub = Stub::new(vec![Ok(card_with(CLEAN)), Ok(merged)], vec![Ok(ok())]).with_methods(vec![MergeMethod::Merge]);
    assert!(merge(&stub, None).unwrap().merged);
    assert_eq!(stub.calls(), vec![vec!["pr", "merge", url.as_str(), "--merge", "--match-head-commit", CLEAN_HEAD]]);
}

/// Refused because of its method: the repository is read again once, and
/// the merge asked again with the method it allows.
#[test]
fn a_merge_refused_for_its_method_reads_the_repository_again_and_retries() {
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let url = merged.pr_url.clone().unwrap();
    let stub = Stub::new(vec![Ok(card_with(CLEAN)), Ok(merged)], vec![Ok(refused(SQUASH_NOT_ALLOWED)), Ok(ok())])
        .with_methods(vec![SQUASH, MergeMethod::Merge]);
    assert!(merge(&stub, None).unwrap().merged);
    assert_eq!(*stub.method_reads.borrow(), [false, true]);
    let calls = stub.calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0][3], "--squash");
    assert_eq!(calls[1], vec!["pr", "merge", url.as_str(), "--merge", "--match-head-commit", CLEAN_HEAD]);
}

/// The re-read names the same method (or the retry is refused too): said
/// plainly, GitHub's answer under it, asked no more than twice.
#[test]
fn a_method_github_still_refuses_is_said_plainly() {
    let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Ok(refused(SQUASH_NOT_ALLOWED))]);
    let r = merge(&stub, None).unwrap();
    assert!(!r.merged);
    assert_eq!(r.refused.as_deref(), Some(METHOD_REFUSED_WORDS));
    assert_eq!(r.github.as_deref(), Some(SQUASH_NOT_ALLOWED));
    assert_eq!(stub.calls().len(), 1, "the same method isn't asked twice");
    assert_eq!(*stub.method_reads.borrow(), [false, true]);

    let merge_refused = "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)";
    let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Ok(refused(SQUASH_NOT_ALLOWED)), Ok(refused(merge_refused))])
        .with_methods(vec![SQUASH, MergeMethod::Merge]);
    let r = merge(&stub, None).unwrap();
    assert_eq!(r.refused.as_deref(), Some(METHOD_REFUSED_WORDS));
    assert_eq!(r.github.as_deref(), Some(merge_refused));
    assert_eq!(stub.calls().len(), 2);
}

/// Any other refusal is not read as the method's: no re-read.
#[test]
fn other_refusals_never_read_the_repository_again() {
    for answer in [BLOCKED, CONFLICTING, HEAD_MODIFIED] {
        let stub = Stub::new(vec![Ok(card_with(CLEAN))], vec![Ok(refused(answer))]);
        merge(&stub, None).unwrap();
        assert_eq!(*stub.method_reads.borrow(), [false], "{answer}");
    }
    let open = parse_pr_view(CLEAN).unwrap();
    assert_eq!(refused_merge_words(HEAD_MODIFIED, &open), HEAD_MOVED_WORDS);
    assert_eq!(refused_merge_words(SQUASH_NOT_ALLOWED, &open), METHOD_REFUSED_WORDS);
}

#[test]
fn auto_merge_from_the_card_retries_with_the_allowed_method() {
    let mut off = card_with(PENDING_AUTO);
    off.pr.as_mut().unwrap().auto_merge = false;
    let on = card_with(PENDING_AUTO);
    let url = on.pr_url.clone().unwrap();
    let stub = Stub::new(vec![Ok(off), Ok(on)], vec![Ok(refused(AUTO_SQUASH_NOT_ALLOWED)), Ok(ok())])
        .with_methods(vec![SQUASH, MergeMethod::Rebase]);
    let r = set_auto_merge(&stub, true).unwrap();
    assert!(r.card.pr.unwrap().auto_merge);
    assert_eq!(
        stub.calls()[1],
        vec!["pr", "merge", url.as_str(), "--rebase", "--match-head-commit", PENDING_HEAD, "--auto"]
    );
}

/// The ship's own auto-merge (G1): the same method, the same retry, and the
/// head the ship pushed.
#[test]
fn the_ships_auto_merge_uses_the_method_and_the_pushed_head() {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card]).unwrap();
    let url = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";
    store.mark_card_pr_shipped("ws", "c1", url, Some(CLEAN_HEAD)).unwrap();
    let asked = RefCell::new(Vec::new());
    let rereads = RefCell::new(Vec::new());
    turn_on_after_ship(
        &store,
        "ws",
        "c1",
        url,
        CLEAN_HEAD,
        |reread| {
            rereads.borrow_mut().push(reread);
            vec![if reread { MergeMethod::Merge } else { SQUASH }]
        },
        |_| Some(true),
        |args| {
            asked.borrow_mut().push(args.join(" "));
            Ok(if args.contains(&"--squash") { refused(AUTO_SQUASH_NOT_ALLOWED) } else { ok() })
        },
    );
    assert_eq!(
        asked.borrow().as_slice(),
        [
            format!("pr merge {url} --squash --match-head-commit {CLEAN_HEAD} --auto"),
            format!("pr merge {url} --merge --match-head-commit {CLEAN_HEAD} --auto"),
        ]
    );
    assert_eq!(*rereads.borrow(), [false, true]);
    let pr = store.get_card("ws", "c1").unwrap().pr.unwrap();
    assert!(pr.auto_merge);
    assert_eq!(pr.auto_merge_refused, None);
}

/// The ship passes the commit its gate verified (`publish`) as the head.
#[test]
fn the_ship_hands_its_pushed_commit_to_auto_merge() {
    let source = include_str!("commands.rs");
    let (_, ship) = source.split_once("fn card_ship_blocking_with(").expect("card_ship");
    let (ship, _) = ship.split_once("pub async fn card_ship_with_follow_up(").expect("its end");
    // 1.173.0 A3: one ask, for a new pull request and one already open.
    assert_eq!(ship.matches("&pr_url,\n        &publish,\n    );").count(), 1);
    let (_, after) = source.split_once("fn auto_merge_after_ship(").expect("auto_merge_after_ship");
    let (after, _) = after.split_once("\n}\n").expect("its end");
    assert!(after.contains("pr_url,\n        pushed_head,") && after.contains("crate::merge_method::methods_for_pr("));
}

// ── G1–G3 Challenger (2): a head moved outside Plyloft ──────────────────

const PUSHED_A: &str = "1111111111111111111111111111111111111111";

/// GitHub's head (B, `CLEAN_HEAD`) isn't the one Plyloft pushed (A).
fn moved_card() -> KanbanCard {
    let mut card = card_with(CLEAN);
    let pr = card.pr.as_mut().unwrap();
    pr.pushed_head = Some(PUSHED_A.into());
    pr.awaiting_checks = false;
    pr.checked_at = Some(1);
    card
}

#[test]
fn a_head_moved_outside_plyloft_is_never_merged_by_itself_nor_ready() {
    let card = moved_card();
    let pr = card.pr.as_ref().unwrap();
    assert!(pr.head_moved());
    assert!(!crate::pr_status::card_ready_to_merge(&card), "no Ready to merge, no notification");
    assert!(pr.ready_to_merge(), "GitHub alone would merge it");
    // Merge: refused before GitHub is asked.
    let stub = Stub::new(vec![Ok(moved_card())], vec![]);
    let r = merge(&stub, None).unwrap();
    assert!(!r.merged);
    assert_eq!(r.refused.as_deref(), Some(HEAD_MOVED_WORDS));
    assert!(stub.calls().is_empty());
    // Merge when checks pass from the card: refused too.
    let stub = Stub::new(vec![Ok(moved_card())], vec![]);
    assert_eq!(set_auto_merge(&stub, true).unwrap().refused.as_deref(), Some(HEAD_MOVED_WORDS));
    assert!(stub.calls().is_empty());
    // Not while GitHub may still be catching up with a push.
    let mut catching_up = moved_card();
    catching_up.pr.as_mut().unwrap().awaiting_checks = true;
    assert!(!catching_up.pr.as_ref().unwrap().head_moved());
    // A short pushed name of GitHub's head is the same commit.
    let mut short = card_with(CLEAN);
    short.pr.as_mut().unwrap().pushed_head = Some(CLEAN_HEAD[..12].into());
    assert!(!short.pr.as_ref().unwrap().head_moved());
}

/// The person's press, Merge what's on GitHub now: GitHub's fresh head,
/// only while it is the one the card showed.
#[test]
fn merge_whats_on_github_now_sends_githubs_fresh_head() {
    let mut merged = moved_card();
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let url = merged.pr_url.clone().unwrap();
    let stub = Stub::new(vec![Ok(moved_card()), Ok(merged)], vec![Ok(ok())]);
    assert!(merge(&stub, Some(CLEAN_HEAD)).unwrap().merged);
    assert_eq!(stub.calls(), vec![vec!["pr", "merge", url.as_str(), "--squash", "--match-head-commit", CLEAN_HEAD]]);
    // GitHub moved again since the card showed it: nothing asked.
    let stub = Stub::new(vec![Ok(moved_card())], vec![]);
    let r = merge(&stub, Some("2222222222222222222222222222222222222222")).unwrap();
    assert_eq!(r.refused.as_deref(), Some(HEAD_CHANGED_AGAIN_WORDS));
    assert!(stub.calls().is_empty());
    // The ship's own auto-merge stays strict: the pushed commit only.
    assert_eq!(merge_head(moved_card().pr.as_ref().unwrap()).as_deref(), Some(PUSHED_A));
}

#[test]
fn the_inbox_says_a_moved_head_and_not_ready() {
    let rows = crate::inbox::derive_card_events("w", &[moved_card()], 0);
    let kinds: Vec<_> = rows.iter().map(|e| e.kind).collect();
    assert!(kinds.contains(&crate::inbox::InboxEventKind::PrHeadMoved), "{kinds:?}");
    assert!(!kinds.contains(&crate::inbox::InboxEventKind::PrReadyToMerge));
    assert!(HEAD_MOVED_WORDS.contains("Merge what's on GitHub now"));
    assert!(HEAD_MOVED_WORDS.contains("the pull request has commits Plyloft didn't push."));
    assert!(HEAD_MOVED_LINE.contains("the pull request has commits Plyloft didn't push."));
    // The card's TS words are the same line (`prStatus.ts::PR_HEAD_MOVED_LINE`).
    let ts = include_str!("../../src/lib/deliveryWords.ts");
    let (lead, _) = HEAD_MOVED_LINE.split_once(':').unwrap();
    assert!(ts.contains(&format!("SOMEONE_ELSE_CHANGED = \"{lead}\"")), "{lead}");
}

// ── G1–G3 Challenger (4): the remaining allowed methods ────────────────

#[test]
fn a_method_refusal_tries_the_remaining_allowed_methods_in_order() {
    let mut merged = card_with(CLEAN);
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let merge_refused = "GraphQL: Merge commits are not allowed on this repository. (mergePullRequest)";
    // The repository says all three; the branch's own rules allow only rebase.
    let all = vec![SQUASH, MergeMethod::Merge, MergeMethod::Rebase];
    let stub = Stub::new(
        vec![Ok(card_with(CLEAN)), Ok(merged)],
        vec![Ok(refused(SQUASH_NOT_ALLOWED)), Ok(refused(merge_refused)), Ok(ok())],
    )
    .with_orders(vec![all.clone(), all]);
    assert!(merge(&stub, None).unwrap().merged);
    let flags: Vec<String> = stub.calls().iter().map(|c| c[3].clone()).collect();
    assert_eq!(flags, ["--squash", "--merge", "--rebase"]);
    assert_eq!(*stub.method_reads.borrow(), [false, true], "the repository is read again once");
    // Every one refused: said plainly, each asked once.
    let stub = Stub::new(
        vec![Ok(card_with(CLEAN))],
        vec![Ok(refused(SQUASH_NOT_ALLOWED)), Ok(refused(merge_refused)), Ok(refused("GraphQL: Rebase merges are not allowed on this repository."))],
    )
    .with_orders(vec![vec![SQUASH], vec![SQUASH, MergeMethod::Merge, MergeMethod::Rebase]]);
    let r = merge(&stub, None).unwrap();
    assert_eq!(r.refused.as_deref(), Some(METHOD_REFUSED_WORDS));
    assert_eq!(stub.calls().len(), 3);
}

// ── G1–G3 Challenger (1, 3): auto-merge waits for a review ─────────────

const URL4: &str = "https://github.com/test-owner/plyloft-ci-sandbox/pull/4";

/// A card at round 1 (`CLEAN_HEAD`) whose pull request Plyloft pushed it to,
/// with `review` (JSON) as its last review.
fn shipped_store(review: &str) -> (tempfile::TempDir, crate::kanban::KanbanStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card: KanbanCard = serde_json::from_str(&format!(
        r#"{{"id":"c1","workspaceId":"ws","title":"t","columnId":"in_progress","createdAt":0,"updatedAt":0,
            "builder":{{"vendor":"claude","snapshots":[{{"n":1,"sha":"{CLEAN_HEAD}","at":1}}],"review":{review}}}}}"#
    ))
    .unwrap();
    store.save("ws", vec![card]).unwrap();
    store.mark_card_pr_shipped("ws", "c1", URL4, Some(CLEAN_HEAD)).unwrap();
    (dir, store)
}

const APPROVED: &str = r#"{"snapshotN":1,"provider":"codex","status":"done","verdict":"approve","reviewedRevision":"a0a74794ac3eada32f2784f95c7dde0609914535","at":1}"#;
const RUNNING: &str = r#"{"snapshotN":1,"provider":"codex","status":"running","at":1}"#;

fn pr_of_store(store: &crate::kanban::KanbanStore) -> PrStatus {
    store.get_card("ws", "c1").unwrap().pr.unwrap()
}

/// MAJOR 1: an unreviewed commit on a pull request that merges by itself —
/// auto-merge is turned off and the card says so; nothing asked when it is
/// off and nobody wanted it.
#[test]
fn an_unreviewed_commit_turns_auto_merge_off() {
    let (_d, store) = shipped_store(RUNNING);
    let asked = RefCell::new(Vec::new());
    let gh = |args: &[&str]| {
        asked.borrow_mut().push(args.join(" "));
        Ok(ok())
    };
    store.update_card_pr("ws", "c1", |c| {
        c.pr.as_mut().unwrap().auto_merge = true;
        Ok(((), PrWrite::Stamp))
    })
    .unwrap();
    assert!(hold_for_review(&store, "ws", "c1", URL4, true, false, gh));
    assert_eq!(asked.borrow().as_slice(), [format!("pr merge {URL4} --disable-auto")]);
    let pr = pr_of_store(&store);
    assert!(!pr.auto_merge);
    assert_eq!(pr.auto_merge_wanted, Some(AutoMergeWanted::TurnedOff));

    // Off, and the press didn't want it: nothing asked, nothing recorded.
    let (_d, store) = shipped_store(RUNNING);
    asked.borrow_mut().clear();
    assert!(!hold_for_review(&store, "ws", "c1", URL4, false, false, gh));
    assert!(asked.borrow().is_empty());
    assert_eq!(pr_of_store(&store).auto_merge_wanted, None);

    // Off, a press wanted it: held, nothing asked of GitHub.
    assert!(!hold_for_review(&store, "ws", "c1", URL4, false, true, gh));
    assert!(asked.borrow().is_empty());
    assert_eq!(pr_of_store(&store).auto_merge_wanted, Some(AutoMergeWanted::Held));
}

/// MINOR 3: held auto-merge is turned on once the pushed commit is
/// reviewed — with the method and only on that head — and the card says so.
#[test]
fn a_held_auto_merge_turns_on_once_the_commit_is_reviewed() {
    let asked = RefCell::new(Vec::new());
    let gh = |args: &[&str]| {
        asked.borrow_mut().push(args.join(" "));
        Ok(ok())
    };
    // Not reviewed yet: nothing.
    let (_d, store) = shipped_store(RUNNING);
    hold_for_review(&store, "ws", "c1", URL4, false, true, gh);
    assert!(resume_due(&store.get_card("ws", "c1").unwrap()).is_none());
    assert!(!resume_held(&store, "ws", "c1", |_, _| vec![SQUASH], |_| Some(true), gh));
    assert!(asked.borrow().is_empty());

    // Approved: on, on the pushed head.
    let (_d, store) = shipped_store(APPROVED);
    hold_for_review(&store, "ws", "c1", URL4, false, true, gh);
    assert_eq!(resume_due(&store.get_card("ws", "c1").unwrap()), Some((URL4.to_string(), CLEAN_HEAD.to_string())));
    assert!(resume_held(&store, "ws", "c1", |_, _| vec![MergeMethod::Merge], |_| Some(true), gh));
    assert_eq!(asked.borrow().as_slice(), [format!("pr merge {URL4} --merge --match-head-commit {CLEAN_HEAD} --auto")]);
    let pr = pr_of_store(&store);
    assert!(pr.auto_merge);
    assert_eq!(pr.auto_merge_wanted, Some(AutoMergeWanted::Resumed));
    // Nothing more to do.
    assert!(resume_due(&store.get_card("ws", "c1").unwrap()).is_none());

    // GitHub refused: its answer is kept, the hold is over.
    let (_d, store) = shipped_store(APPROVED);
    hold_for_review(&store, "ws", "c1", URL4, false, true, gh);
    assert!(!resume_held(&store, "ws", "c1", |_, _| vec![SQUASH], |_| Some(true), |_| Ok(refused(NOT_ALLOWED))));
    let pr = pr_of_store(&store);
    assert_eq!((pr.auto_merge, pr.auto_merge_wanted), (false, None));
    assert_eq!(pr.auto_merge_refused.as_deref(), Some(NOT_ALLOWED));

    // Nothing held (nobody wanted it): an approval turns nothing on.
    let (_d, store) = shipped_store(APPROVED);
    assert!(resume_due(&store.get_card("ws", "c1").unwrap()).is_none());
    // Commits on GitHub Plyloft didn't push: never by itself.
    hold_for_review(&store, "ws", "c1", URL4, false, true, gh);
    store
        .update_card_pr("ws", "c1", |c| {
            let pr = c.pr.as_mut().unwrap();
            pr.head_sha = Some(PUSHED_A.into());
            pr.awaiting_checks = false;
            Ok(((), PrWrite::Stamp))
        })
        .unwrap();
    assert!(resume_due(&store.get_card("ws", "c1").unwrap()).is_none());
}

/// GitHub's word on an existing pull request's auto-merge.
#[test]
fn githubs_auto_merge_answer_is_read() {
    let said = |out: &str| Ok(GhAnswer { ok: true, stdout: out.into(), stderr: String::new() });
    assert_eq!(auto_merge_on_from(&said("true")), Some(true));
    assert_eq!(auto_merge_on_from(&said("false")), Some(false));
    assert_eq!(auto_merge_on_from(&said("")), None);
    assert_eq!(auto_merge_on_from(&Ok(refused("unknown field"))), None);
    assert_eq!(auto_merge_on_from(&Err("offline".into())), None);
    assert_eq!(auto_merge_on_args(URL4), ["pr", "view", URL4, "--json", "autoMergeRequest", "--jq", ".autoMergeRequest != null"]);
}

/// The person's own Turn off / Merge when checks pass ends Plyloft's hold.
#[test]
fn the_persons_press_ends_the_hold() {
    let mut held = card_with(PENDING_AUTO);
    held.pr.as_mut().unwrap().auto_merge = false;
    held.pr.as_mut().unwrap().auto_merge_wanted = Some(AutoMergeWanted::Held);
    let mut on = card_with(PENDING_AUTO);
    on.pr.as_mut().unwrap().auto_merge_wanted = Some(AutoMergeWanted::Held);
    let stub = Stub::new(vec![Ok(held), Ok(on)], vec![Ok(ok())]);
    let r = set_auto_merge(&stub, true).unwrap();
    assert_eq!(r.card.pr.unwrap().auto_merge_wanted, None);
}

/// 1.174.0 A2 round 2: Don't merge by itself while Plyloft only holds a merge
/// it means to turn on — the hold ends, and GitHub is never asked.
#[test]
fn off_while_held_ends_the_hold_without_github() {
    let mut held = card_with(PENDING_AUTO);
    held.pr.as_mut().unwrap().auto_merge = false;
    held.pr.as_mut().unwrap().plyloft_auto_merge = false;
    held.pr.as_mut().unwrap().auto_merge_wanted = Some(AutoMergeWanted::Held);
    let stub = Stub::new(vec![Ok(held)], vec![]);
    let r = set_auto_merge(&stub, false).unwrap();
    assert!(stub.calls().is_empty(), "no gh call: {:?}", stub.calls());
    assert_eq!(r.refused, None);
    let pr = r.card.pr.unwrap();
    assert_eq!((pr.auto_merge, pr.auto_merge_wanted), (false, None));
}

/// Schema migration: a pull request read before the hold loads without it,
/// is written without it, and the hold round-trips.
#[test]
fn a_pull_request_from_before_the_hold_loads_unchanged() {
    let old = r#"{"number":3,"state":"open","checks":"pending","checksTotal":1,"checksPassed":0,
        "checksPending":1,"failingChecks":[],"mergeable":"unknown","reviewDecision":"none","checkedAt":10,
        "autoMerge":false,"pushedHead":"abc","mergeMethod":"squash"}"#;
    let pr: PrStatus = serde_json::from_str(old).unwrap();
    assert_eq!(pr.auto_merge_wanted, None);
    assert!(serde_json::to_value(&pr).unwrap().get("autoMergeWanted").is_none());
    for (w, word) in [
        (AutoMergeWanted::Held, "held"),
        (AutoMergeWanted::TurnedOff, "turnedOff"),
        (AutoMergeWanted::Resumed, "resumed"),
    ] {
        let v = serde_json::to_value(PrStatus { auto_merge_wanted: Some(w), ..pr.clone() }).unwrap();
        assert_eq!(v["autoMergeWanted"], word);
        assert_eq!(serde_json::from_value::<PrStatus>(v).unwrap().auto_merge_wanted, Some(w));
    }
}

/// Each read keeps the hold until auto-merge is on, and "on again" while it is.
#[test]
fn reads_keep_the_hold_until_auto_merge_is_on() {
    let (_d, store) = shipped_store(APPROVED);
    hold_for_review(&store, "ws", "c1", URL4, false, true, |_| Ok(ok()));
    let mut card = store.get_card("ws", "c1").unwrap();
    let mut read = parse_pr_view(CLEAN).unwrap();
    read.number = 4;
    crate::pr_status::apply_status(&mut card, read.clone(), 10_000_000, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().auto_merge_wanted, Some(AutoMergeWanted::Held));
    let mut on = read.clone();
    on.auto_merge = true;
    crate::pr_status::apply_status(&mut card, on.clone(), 10_000_001, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().auto_merge_wanted, None, "someone turned it on");
    card.pr.as_mut().unwrap().auto_merge_wanted = Some(AutoMergeWanted::Resumed);
    crate::pr_status::apply_status(&mut card, on, 10_000_002, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().auto_merge_wanted, Some(AutoMergeWanted::Resumed));
    crate::pr_status::apply_status(&mut card, read, 10_000_003, "x").unwrap();
    assert_eq!(card.pr.as_ref().unwrap().auto_merge_wanted, None, "off again: the line goes");
}

/// Ship, Push update and the review's settle are wired to the hold.
#[test]
fn the_ship_push_update_and_the_review_reach_the_hold() {
    let source = include_str!("commands.rs");
    let (_, ship) = source.split_once("fn card_ship_blocking_with(").expect("card_ship");
    let (ship, _) = ship.split_once("pub async fn card_ship_with_follow_up(").expect("its end");
    assert!(ship.contains("let press_auto_merge = auto_merge;"));
    assert!(ship.contains("let review_hold = (unreviewed.is_some() || pr_line.is_some())"));
    // 1.173.0 A3: `existed` is false for a new pull request, true for the
    // one that existed (`open_branch_pr`'s answer).
    assert_eq!(ship.matches("review_hold,\n        existed,\n").count(), 1);
    assert!(ship.contains("PrOpened::New(url) => (url, false)"), "a new pull request");
    assert!(ship.contains("PrOpened::Existing(url) => (url, true)"), "the one that existed");
    let (_, after) = source.split_once("fn auto_merge_after_ship(").expect("auto_merge_after_ship");
    let (after, _) = after.split_once("\n}\n").expect("its end");
    let hold = after.find("crate::pr_merge::hold_for_review(").expect("the hold");
    assert!(hold < after.find("if !ship_wants_auto_merge(auto,").unwrap(), "before anything is turned on");
    // 1.174.0 X1: Push update's env moved to `card_pr_commands.rs`.
    let card_pr = include_str!("card_pr_commands.rs");
    let (_, push) = card_pr.split_once("fn after_push(&self, card: &KanbanCard, rev: &str) {").expect("after_push");
    let (push, _) = push.split_once("fn bound_words(").expect("its end");
    assert!(push.contains("if unreviewed.is_some() {") && push.contains("crate::pr_merge::hold_for_review("));
    assert!(push.contains("crate::pr_merge::resume_held("));
    let builder = include_str!("builder.rs");
    let (_, settle) = builder.split_once("fn settle_and_take_next(").expect("settle");
    let (settle, _) = settle.split_once("\n}\n").expect("its end");
    assert!(settle.contains("crate::pr_merge::kick_resume_held(app, workspace_id, card_id);"));
}

// ── 1.170.0 walk fix: merge when checks pass waits for the checks ──────

/// A read of `rules/branches/main` and of `branches/main`, as GitHub
/// answers them (shapes from GitHub's REST docs).
const RULES_WITH_CHECKS: &str = r#"[{"type":"pull_request","parameters":{}},{"type":"required_status_checks","ruleset_id":7,
    "parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"test"}]}}]"#;
const RULES_WITHOUT_CHECKS: &str = r#"[{"type":"deletion"},{"type":"required_status_checks","parameters":{"required_status_checks":[]}}]"#;
const BRANCH_UNPROTECTED: &str = r#"{"name":"main","protected":false,"protection":{"enabled":false,
    "required_status_checks":{"enforcement_level":"off","contexts":[],"checks":[]}}}"#;
const BRANCH_REQUIRES_TEST: &str = r#"{"name":"main","protected":true,"protection":{"enabled":true,
    "required_status_checks":{"enforcement_level":"non_admins","contexts":["test"],"checks":[{"context":"test","app_id":null}]}}}"#;

#[test]
fn whether_the_base_branch_requires_checks_is_read() {
    assert_eq!(rules_require_checks(RULES_WITH_CHECKS), Some(true));
    assert_eq!(rules_require_checks(RULES_WITHOUT_CHECKS), Some(false));
    assert_eq!(rules_require_checks("[]"), Some(false));
    assert_eq!(rules_require_checks(r#"{"message":"Not Found"}"#), None);
    assert_eq!(branch_requires_checks(BRANCH_UNPROTECTED), Some(false));
    assert_eq!(branch_requires_checks(BRANCH_REQUIRES_TEST), Some(true));
    assert_eq!(branch_requires_checks(r#"{"name":"main","protected":true}"#), None, "protected, not shown");
    assert_eq!(branch_requires_checks(r#"{"name":"main","protected":false}"#), Some(false));
    assert_eq!(branch_requires_checks(r#"{"message":"Branch not found"}"#), None);
    assert_eq!(checks_required_from(Some(true), None), Some(true));
    assert_eq!(checks_required_from(None, Some(true)), Some(true));
    assert_eq!(checks_required_from(Some(false), Some(false)), Some(false));
    assert_eq!(checks_required_from(Some(false), None), None, "one read missing: unknown");
}

#[test]
fn checks_required_asks_github_for_the_base_and_its_rules() {
    let asked_cell = RefCell::new(Vec::new());
    let asked = &asked_cell;
    let answers = |rules: Result<GhAnswer, String>, branch: Result<GhAnswer, String>| {
        let rules = RefCell::new(Some(rules));
        let branch = RefCell::new(Some(branch));
        move |args: &[&str]| -> Result<GhAnswer, String> {
            asked.borrow_mut().push(args.join(" "));
            match args {
                ["pr", "view", ..] => Ok(GhAnswer { ok: true, stdout: "main\n".into(), stderr: String::new() }),
                [_, path] if path.contains("/rules/branches/") => rules.borrow_mut().take().unwrap(),
                [_, path] if path.contains("/branches/") => branch.borrow_mut().take().unwrap(),
                other => panic!("unexpected gh {other:?}"),
            }
        }
    };
    let said = |json: &str| Ok(GhAnswer { ok: true, stdout: json.into(), stderr: String::new() });
    let gh = answers(said(RULES_WITH_CHECKS), Err("not asked".into()));
    assert_eq!(checks_required(URL4, None, &gh), Some(true));
    assert_eq!(
        asked.borrow().as_slice(),
        [
            format!("pr view {URL4} --json baseRefName --jq .baseRefName"),
            "api repos/test-owner/plyloft-ci-sandbox/rules/branches/main".to_string(),
        ],
        "a ruleset requiring checks is enough"
    );
    asked.borrow_mut().clear();
    let gh = answers(said("[]"), said(BRANCH_UNPROTECTED));
    assert_eq!(checks_required(URL4, None, &gh), Some(false));
    let gh = answers(said("[]"), said(BRANCH_REQUIRES_TEST));
    assert_eq!(checks_required(URL4, Some("main"), &gh), Some(true));
    let gh = answers(said("[]"), Ok(refused("HTTP 404: Not Found")));
    assert_eq!(checks_required(URL4, Some("main"), &gh), None, "unknown");
    let gh = answers(Err("offline".into()), said(BRANCH_UNPROTECTED));
    assert_eq!(checks_required(URL4, Some("main"), &gh), None, "unknown");
}

/// The card of `shipped_store(review)` with Plyloft's "Merge when checks
/// pass" on, after a read of the CLEAN pull request with `checks`, well
/// after the wait for checks.
fn plyloft_card(review: &str, checks: crate::pr_status::PrChecks) -> KanbanCard {
    let (_d, store) = shipped_store(review);
    let mut card = store.get_card("ws", "c1").unwrap();
    card.pr.as_mut().unwrap().plyloft_auto_merge = true;
    let mut read = parse_pr_view(CLEAN).unwrap();
    read.number = 4;
    read.checks = checks;
    if checks == crate::pr_status::PrChecks::None {
        read.checks_total = 0;
        read.checks_passed = 0;
    }
    let later = crate::kanban::now_ms() + 20 * 60_000;
    crate::pr_status::apply_status(&mut card, read, later, "x").unwrap();
    card
}

#[test]
fn no_required_checks_the_ship_asks_github_nothing_and_plyloft_keeps_it() {
    for required in [Some(false), None] {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
        let card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
        store.save("ws", vec![card]).unwrap();
        store.mark_card_pr_shipped("ws", "c1", URL4, Some(CLEAN_HEAD)).unwrap();
        turn_on_after_ship(&store, "ws", "c1", URL4, CLEAN_HEAD, |_| vec![SQUASH], |_| required, |args| {
            panic!("GitHub asked {args:?}")
        });
        let pr = pr_of_store(&store);
        assert!(pr.plyloft_auto_merge && !pr.auto_merge, "{required:?}");
        assert_eq!(pr.auto_merge_refused, None);
    }
    // Required: GitHub's auto-merge, as before.
    let dir = tempfile::tempdir().unwrap();
    let store = crate::kanban::KanbanStore::new(dir.path().to_path_buf()).unwrap();
    let card = KanbanCard::new("c1".into(), "ws".into(), "Probe".into(), None, KanbanColumnId::InProgress);
    store.save("ws", vec![card]).unwrap();
    store.mark_card_pr_shipped("ws", "c1", URL4, Some(CLEAN_HEAD)).unwrap();
    let asked = RefCell::new(Vec::new());
    turn_on_after_ship(&store, "ws", "c1", URL4, CLEAN_HEAD, |_| vec![SQUASH], |_| Some(true), |args| {
        asked.borrow_mut().push(args.join(" "));
        Ok(ok())
    });
    assert_eq!(asked.borrow().as_slice(), [format!("pr merge {URL4} --squash --match-head-commit {CLEAN_HEAD} --auto")]);
    let pr = pr_of_store(&store);
    assert!(pr.auto_merge && !pr.plyloft_auto_merge);
}

#[test]
fn the_cards_switch_without_required_checks_is_plyloft_s() {
    let mut card = card_with(CLEAN);
    card.pr.as_mut().unwrap().auto_merge = false;
    for required in [Some(false), None] {
        let stub = Stub::new(vec![Ok(card.clone())], vec![]).with_required(required);
        let r = set_auto_merge(&stub, true).unwrap();
        assert!(r.refused.is_none() && !r.merged);
        assert!(stub.calls().is_empty(), "no --auto: {:?}", stub.calls());
        assert!(r.card.pr.as_ref().unwrap().plyloft_auto_merge);
        // Turn off: Plyloft's, nothing asked of GitHub.
        let on = r.card.clone();
        let stub = Stub::new(vec![Ok(on)], vec![]).with_required(required);
        let r = set_auto_merge(&stub, false).unwrap();
        assert!(stub.calls().is_empty());
        assert!(!r.card.pr.unwrap().plyloft_auto_merge);
    }
    // Required: GitHub's.
    let stub = Stub::new(vec![Ok(card.clone()), Ok(card.clone())], vec![Ok(ok())]).with_required(Some(true));
    set_auto_merge(&stub, true).unwrap();
    assert_eq!(stub.calls().len(), 1);
    assert!(stub.calls()[0].contains(&"--auto".to_string()));
}

#[test]
fn plyloft_merges_only_once_the_checks_passed() {
    use crate::pr_status::PrChecks;
    // Checks still running: nothing.
    assert_eq!(merge_due(&plyloft_card(APPROVED, PrChecks::Pending)), None);
    // Failing: nothing.
    assert_eq!(merge_due(&plyloft_card(APPROVED, PrChecks::Failing)), None);
    // Passed, reviewed: due, on the pushed head.
    let due = plyloft_card(APPROVED, PrChecks::Passing);
    assert_eq!(merge_due(&due), Some((URL4.to_string(), CLEAN_HEAD.to_string())));
    assert!(!crate::pr_status::card_ready_to_merge(&due), "no Ready to merge notification: Plyloft merges it");
    // No checks at all, after the wait: due.
    assert!(merge_due(&plyloft_card(APPROVED, PrChecks::None)).is_some());
    // Not reviewed: nothing.
    assert_eq!(merge_due(&plyloft_card(RUNNING, PrChecks::Passing)), None);
    // Switch off: nothing.
    let mut off = plyloft_card(APPROVED, PrChecks::Passing);
    off.pr.as_mut().unwrap().plyloft_auto_merge = false;
    assert_eq!(merge_due(&off), None);
    // Commits on GitHub Plyloft didn't push: nothing.
    let mut moved = plyloft_card(APPROVED, PrChecks::Passing);
    moved.pr.as_mut().unwrap().head_sha = Some(PUSHED_A.into());
    assert_eq!(merge_due(&moved), None);
    // Within the wait after the opening (GitHub may not have started them): nothing.
    let mut early = plyloft_card(APPROVED, PrChecks::None);
    early.pr.as_mut().unwrap().awaiting_checks = true;
    assert_eq!(merge_due(&early), None);

    // The merge: the method, the pushed head, never --auto or --admin.
    let mut merged = due.clone();
    merged.pr.as_mut().unwrap().state = PrState::Merged;
    let stub = Stub::new(vec![Ok(merged)], vec![Ok(ok())]);
    let r = merge_when_due(&stub, &due).unwrap();
    assert!(r.merged);
    assert_eq!(stub.calls(), vec![vec!["pr", "merge", URL4, "--squash", "--match-head-commit", CLEAN_HEAD]]);
    // Nothing due: GitHub asked nothing.
    let stub = Stub::new(vec![], vec![]);
    assert!(merge_when_due(&stub, &plyloft_card(APPROVED, PrChecks::Pending)).is_none());
    // GitHub refused: Plyloft's switch goes off, its answer kept.
    let stub = Stub::new(vec![], vec![Ok(refused(BLOCKED))]);
    *stub.written.borrow_mut() = Some(due.clone());
    let r = merge_when_due(&stub, &due).unwrap();
    assert!(!r.merged && r.refused.is_some());
    let pr = r.card.pr.unwrap();
    assert!(!pr.plyloft_auto_merge);
    assert_eq!(pr.auto_merge_refused.as_deref(), Some(BLOCKED));
}

#[test]
fn reads_keep_plyloft_s_switch_while_open() {
    let card = plyloft_card(APPROVED, crate::pr_status::PrChecks::Passing);
    assert!(card.pr.as_ref().unwrap().plyloft_auto_merge);
    assert!(crate::pr_status::watched_closely(card.pr.as_ref().unwrap()), "read every minute");
    let mut closed = card.clone();
    let mut read = parse_pr_view(CLEAN).unwrap();
    read.number = 4;
    read.state = PrState::Closed;
    crate::pr_status::apply_status(&mut closed, read, crate::kanban::now_ms() + 30 * 60_000, "x").unwrap();
    assert!(!closed.pr.unwrap().plyloft_auto_merge);
}

#[test]
fn a_held_switch_turns_on_as_plyloft_s_without_required_checks() {
    let (_d, store) = shipped_store(APPROVED);
    hold_for_review(&store, "ws", "c1", URL4, false, true, |_| Ok(ok()));
    assert!(resume_held(&store, "ws", "c1", |_, _| vec![SQUASH], |_| None, |args| panic!("GitHub asked {args:?}")));
    let pr = pr_of_store(&store);
    assert!(pr.plyloft_auto_merge && !pr.auto_merge);
    assert_eq!(pr.auto_merge_wanted, None);
    // An unreviewed push holds Plyloft's switch too, and says so.
    assert!(hold_for_review(&store, "ws", "c1", URL4, false, false, |args| panic!("GitHub asked {args:?}")));
    let pr = pr_of_store(&store);
    assert!(!pr.plyloft_auto_merge);
    assert_eq!(pr.auto_merge_wanted, Some(AutoMergeWanted::TurnedOff));
}

/// Schema migration: a pull request recorded before Plyloft's own switch
/// loads with it off and is written without it; on round-trips.
#[test]
fn a_pull_request_from_before_plyloft_s_switch_loads_unchanged() {
    let old = r#"{"number":3,"state":"open","checks":"pending","checksTotal":1,"checksPassed":0,
        "checksPending":1,"failingChecks":[],"mergeable":"unknown","reviewDecision":"none","checkedAt":10,
        "autoMerge":false,"pushedHead":"abc","mergeMethod":"squash","autoMergeWanted":"held"}"#;
    let pr: PrStatus = serde_json::from_str(old).unwrap();
    assert!(!pr.plyloft_auto_merge);
    assert_eq!(pr.auto_merge_wanted, Some(AutoMergeWanted::Held));
    assert!(serde_json::to_value(&pr).unwrap().get("plyloftAutoMerge").is_none());
    let v = serde_json::to_value(PrStatus { plyloft_auto_merge: true, ..pr }).unwrap();
    assert_eq!(v["plyloftAutoMerge"], true);
    assert!(serde_json::from_value::<PrStatus>(v).unwrap().plyloft_auto_merge);
}

/// T4: a board opened from its last saved copy is one save behind — the
/// lost save may be the person turning "Merge when checks pass" off. A
/// restored card that had Plyloft's own on comes back off and the poller
/// does not merge it; one still waiting for a review to be turned on is no
/// longer waiting; GitHub's own, and a card without any of it, are as they
/// were. The notice says on how many cards, also after a relaunch.
#[test]
fn a_restore_turns_plyloft_s_merge_when_checks_pass_off() {
    use crate::kanban::{KanbanStore, KANBAN_SUBDIR};
    use crate::pr_status::{AutoMergeWanted, PrChecks};
    let due = plyloft_card(APPROVED, PrChecks::Passing);
    assert!(merge_due(&due).is_some(), "before: the poller would merge it");
    let mut held = plyloft_card(APPROVED, PrChecks::Passing);
    held.id = "held".into();
    {
        let pr = held.pr.as_mut().unwrap();
        pr.plyloft_auto_merge = false;
        pr.auto_merge_wanted = Some(AutoMergeWanted::Held);
    }
    assert!(resume_due(&held).is_some(), "before: Plyloft would turn GitHub's on by itself");
    let mut on_github = plyloft_card(APPROVED, PrChecks::Passing);
    on_github.id = "github".into();
    {
        let pr = on_github.pr.as_mut().unwrap();
        pr.plyloft_auto_merge = false;
        pr.auto_merge = true;
        pr.auto_merge_wanted = Some(AutoMergeWanted::Resumed);
    }
    let plain = KanbanCard::new("plain".into(), "ws".into(), "No pull request".into(), None, KanbanColumnId::Todo);
    let untouched = |card: &KanbanCard| serde_json::to_value(card).unwrap();
    let (github_before, plain_before) = (untouched(&on_github), untouched(&plain));

    let tmp = tempfile::tempdir().unwrap();
    {
        let before = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
        before.save("ws", vec![due, held, on_github, plain]).unwrap();
        // One more save, so the backup holds the four cards.
        before.create_card("ws", KanbanCard::new("lost".into(), "ws".into(), "Lost".into(), None, KanbanColumnId::Todo)).unwrap();
    }
    let boards = tmp.path().join(KANBAN_SUBDIR);
    std::fs::write(boards.join("ws.json"), b"").unwrap();

    let store = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    let cards = store.load("ws").unwrap();
    let by_id = |id: &str| cards.iter().find(|c| c.id == id).unwrap().clone();
    let c1 = by_id("c1");
    assert!(!c1.pr.as_ref().unwrap().plyloft_auto_merge, "comes back off");
    assert_eq!(merge_due(&c1), None, "the poller does not merge it");
    let held = by_id("held");
    assert_eq!(held.pr.as_ref().unwrap().auto_merge_wanted, None);
    assert_eq!(resume_due(&held), None, "nor turns GitHub's on by itself");
    assert_eq!(untouched(&by_id("github")), github_before, "GitHub's own is GitHub's");
    assert_eq!(untouched(&by_id("plain")), plain_before);
    // Written off, not only in memory.
    let on_disk: crate::kanban::KanbanFile = serde_json::from_slice(&std::fs::read(boards.join("ws.json")).unwrap()).unwrap();
    assert!(on_disk.cards.iter().all(|c| c.pr.as_ref().is_none_or(|p| !p.plyloft_auto_merge)));

    // Said with the notice — at this launch, or at the next if it wasn't shown.
    drop(store);
    let relaunched = KanbanStore::new(tmp.path().to_path_buf()).unwrap();
    relaunched.load("ws").unwrap();
    let notice = relaunched.take_notice("ws").unwrap();
    assert!(notice.restored);
    assert_eq!(notice.auto_merge_off, 2, "c1 and held");

    // A restore where no card had it on says nothing of it.
    let mut none = [KanbanCard::new("a".into(), "ws".into(), "A".into(), None, KanbanColumnId::Todo)];
    assert_eq!(turn_off_on_restore(&mut none), 0);
}
