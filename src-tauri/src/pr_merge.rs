//! SL-3 (ship loop): merge a card's pull request from the card, and have
//! GitHub merge it when its checks pass ("Merge when checks pass").
//!
//! Every call is `gh pr merge <url> …` — bounded, in its own process group,
//! as the workspace's GitHub account (`github::gh_output`), with the method
//! the repository allows (1.170.0 G3, `merge_method`: squash, else a merge
//! commit, else rebase) and `--match-head-commit` on the head Plyloft pushed,
//! so GitHub merges nothing Plyloft didn't verify. Plyloft never passes
//! `--admin`: whatever GitHub's branch rules require still applies.
//!
//! A merge is never recorded here. After GitHub says it merged, the card's
//! pull request is read again (`pr_status::refresh_card`), and that one path
//! moves the card to Done, stamps the ship and prunes the worktree and branch
//! with their guards.
//!
//! Answers of `gh` 2.101 against the sandbox (2026-09-28, see
//! `pr_merge_tests.rs`): a blocked merge exits 1 with "X Pull request … is
//! not mergeable: the base branch policy prohibits the merge." on stderr;
//! `--auto` and `--disable-auto` exit 0 and print nothing when not on a
//! terminal; a PR that is already merged exits 0 with "! Pull request … was
//! already merged".

use serde::Serialize;

use crate::kanban::KanbanCard;
pub use crate::merge_method::MergeMethod;
use crate::pr_status::{AutoMergeWanted, PrCheck, PrChecks, PrMergeable, PrState, PrStatus, PrWrite};

/// What `gh` answered: whether it exited 0, and its two streams.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhAnswer {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl GhAnswer {
    pub fn from_output(out: &std::process::Output) -> Self {
        Self {
            ok: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        }
    }

    /// GitHub's own words: stderr, else stdout.
    fn said(&self) -> String {
        if !self.stderr.is_empty() {
            self.stderr.clone()
        } else if !self.stdout.is_empty() {
            self.stdout.clone()
        } else {
            "GitHub CLI stopped without saying why".to_string()
        }
    }
}

/// `gh pr merge <url> --<method> [--match-head-commit <head>]`.
pub fn merge_args<'a>(url: &'a str, method: MergeMethod, head: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec!["pr", "merge", url, method.flag()];
    if let Some(head) = head {
        args.extend(["--match-head-commit", head]);
    }
    args
}

/// [`merge_args`] with `--auto`: GitHub merges it once its checks pass.
pub fn auto_merge_args<'a>(url: &'a str, method: MergeMethod, head: Option<&'a str>) -> Vec<&'a str> {
    let mut args = merge_args(url, method, head);
    args.push("--auto");
    args
}

pub fn disable_auto_merge_args(url: &str) -> Vec<&str> {
    vec!["pr", "merge", url, "--disable-auto"]
}

// ── 1.170.0 walk fix: who keeps "Merge when checks pass" ───────────────
//
// GitHub's auto-merge waits only for the checks the base branch REQUIRES.
// On a branch that requires none, `gh pr merge --auto` merges at once,
// before any check ran (walk 2026-10-27, sandbox PR #114: merged a second
// before its checks started). So GitHub keeps it only where the base
// branch requires checks; elsewhere — or when Plyloft can't tell — Plyloft
// keeps it (`PrStatus::plyloft_auto_merge`) and the poller merges once the
// checks passed ([`merge_due`]).

/// `gh pr view <url> --json baseRefName --jq .baseRefName`.
pub fn base_ref_args(url: &str) -> Vec<&str> {
    vec!["pr", "view", url, "--json", "baseRefName", "--jq", ".baseRefName"]
}

/// GitHub's answer to `gh api repos/{o}/{r}/rules/branches/{base}` (the
/// rulesets on the branch, readable with read access): whether one requires
/// a status check. None when it isn't that answer.
pub fn rules_require_checks(json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    let rules = v.as_array()?;
    Some(rules.iter().any(|rule| {
        rule.get("type").and_then(serde_json::Value::as_str) == Some("required_status_checks")
            && rule
                .pointer("/parameters/required_status_checks")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|checks| !checks.is_empty())
    }))
}

/// GitHub's answer to `gh api repos/{o}/{r}/branches/{base}` (readable with
/// read access; its `protection` is the classic branch protection's
/// summary): whether that protection requires a status check. None when it
/// isn't that answer, or a protected branch whose protection it doesn't
/// show.
pub fn branch_requires_checks(json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    v.get("name")?;
    let Some(required) = v.pointer("/protection/required_status_checks") else {
        return match v.get("protected").and_then(serde_json::Value::as_bool) {
            Some(false) => Some(false),
            _ => None,
        };
    };
    if required.get("enforcement_level").and_then(serde_json::Value::as_str) == Some("off") {
        return Some(false);
    }
    let named = |key: &str| required.get(key).and_then(serde_json::Value::as_array).is_some_and(|a| !a.is_empty());
    Some(named("contexts") || named("checks"))
}

/// One answer from the two reads: required when either says so, not
/// required only when both said not, else unknown.
pub fn checks_required_from(rules: Option<bool>, branch: Option<bool>) -> Option<bool> {
    match (rules, branch) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

/// Whether the base branch of the pull request `url` (`base`, else read
/// from GitHub) requires status checks: Some(true) — GitHub's auto-merge
/// waits for them; Some(false) — GitHub would merge at once; None — Plyloft
/// couldn't tell. `gh` as the caller runs it (the workspace's account).
pub fn checks_required(
    url: &str,
    base: Option<&str>,
    gh: &dyn Fn(&[&str]) -> Result<GhAnswer, String>,
) -> Option<bool> {
    let pr = crate::pr_fix::pr_ref(url)?;
    let said = |args: &[&str]| match gh(args) {
        Ok(a) if a.ok => Some(a.stdout),
        Ok(a) => {
            log::info!("pr_merge: couldn't read the required checks ({}): {}", args.join(" "), a.said());
            None
        }
        Err(e) => {
            log::info!("pr_merge: couldn't read the required checks ({}): {e}", args.join(" "));
            None
        }
    };
    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(base) => base.to_string(),
        None => said(&base_ref_args(url))?.trim().to_string(),
    };
    if base.is_empty() {
        return None;
    }
    let api = |path: String| {
        let mut args = vec!["api".to_string()];
        if pr.host != "github.com" {
            args.extend(["--hostname".to_string(), pr.host.clone()]);
        }
        args.push(path);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        said(&refs)
    };
    let rules = api(format!("repos/{}/{}/rules/branches/{base}", pr.owner, pr.repo)).and_then(|j| rules_require_checks(&j));
    if rules == Some(true) {
        return Some(true);
    }
    let branch = api(format!("repos/{}/{}/branches/{base}", pr.owner, pr.repo)).and_then(|j| branch_requires_checks(&j));
    checks_required_from(rules, branch)
}

/// Plyloft keeps "Merge when checks pass" on the card's pull request — the
/// base branch requires no checks, or Plyloft couldn't tell. Recorded on
/// the card; GitHub is asked nothing.
fn keep_on_plyloft(pr: &mut PrStatus) {
    pr.plyloft_auto_merge = true;
    pr.auto_merge_refused = None;
    pr.auto_merge_wanted = None;
}

/// G3: the head a merge must match (`--match-head-commit`) — the commit
/// Plyloft pushed to the pull request (Ship, Push update), which its gate
/// verified. A pull request shipped before Plyloft recorded it: the head
/// GitHub showed on the read just before. A short name GitHub's head starts
/// with is GitHub's full one (GitHub wants the full commit).
pub fn merge_head(pr: &PrStatus) -> Option<String> {
    let nonempty = |h: &Option<String>| h.clone().filter(|h| !h.is_empty());
    match (nonempty(&pr.pushed_head), nonempty(&pr.head_sha)) {
        (Some(pushed), Some(head)) if pushed.len() < 40 && head.starts_with(&pushed) => Some(head),
        (Some(pushed), _) => Some(pushed),
        (None, head) => head,
    }
}

/// Round 3 (S4): the head *Merge when checks pass* is held to — a commit the
/// card records as verified, in GitHub's full name for it: what Plyloft
/// pushed ([`merge_head`]), else the Builder's last checked commit while the
/// pull request is at it, else the card branch's tip on this computer while
/// the pull request is at it. `None`: the card vouches for nothing GitHub has.
fn verified_head(env: &dyn MergeEnv, card: &KanbanCard, pr: &PrStatus) -> Option<String> {
    if pr.pushed_head.as_deref().is_some_and(|head| !head.is_empty()) {
        return merge_head(pr);
    }
    // A pull request from before Plyloft recorded what it pushed: the
    // Builder's last checked commit, else the card branch's tip on this
    // computer — and only while GitHub's head is that very commit.
    let github = pr.head_sha.clone().filter(|head| !head.is_empty())?;
    let here = match card.builder.as_ref().and_then(|b| b.snapshots.last()) {
        Some(last) => last.sha.clone(),
        None => env.local_tip(card)?,
    };
    crate::pr_status::same_commit(&here, &github).then_some(github)
}

/// `gh pr view <url> --json headRefOid --jq .headRefOid`: the commit the pull
/// request is at on GitHub now.
pub fn head_read_args(url: &str) -> Vec<&str> {
    vec!["pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"]
}

/// 1.175.0 (A8, OP-8): the head a merge asked from the card names, always.
/// A pull request with neither a pushed head nor one GitHub showed
/// ([`merge_head`] is `None`) is read once more; without `--match-head-commit`
/// GitHub would merge whatever the pull request holds when the call lands.
/// `Err`: gh's answer when that read gave no commit — nothing is asked then.
fn head_to_match(env: &dyn MergeEnv, url: &str, pr: &PrStatus) -> Result<Result<String, GhAnswer>, String> {
    if let Some(head) = merge_head(pr) {
        return Ok(Ok(head));
    }
    let answer = env.gh(&head_read_args(url))?;
    let head = answer.stdout.trim();
    if answer.ok && head.len() >= 40 && head.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(Ok(head.to_string()));
    }
    // A read that printed no commit said nothing a person can use.
    let stdout = if answer.ok { String::new() } else { answer.stdout.clone() };
    Ok(Err(GhAnswer { ok: false, stdout, stderr: answer.stderr }))
}

/// G3: ask GitHub with the repository's method (the first of
/// `methods_of(false)`); refused because of the method, read the repository
/// again (`methods_of(true)`, once) and — G1–G3 Challenger (4) — ask with
/// each method it allows that wasn't asked yet, in Plyloft's order, until
/// one is not refused for its method (a branch's own rules may allow fewer
/// than the repository). Returns the last answer and the method it was
/// asked with.
pub fn ask_with_method(
    methods_of: &dyn Fn(bool) -> Vec<MergeMethod>,
    ask: &dyn Fn(MergeMethod) -> Result<GhAnswer, String>,
) -> Result<(GhAnswer, MergeMethod), String> {
    let refused = |a: &GhAnswer| !a.ok && crate::merge_method::refused_for_method(&a.said());
    let mut method = methods_of(false).first().copied().unwrap_or(MergeMethod::Squash);
    let mut answer = ask(method)?;
    if !refused(&answer) {
        return Ok((answer, method));
    }
    let mut asked = vec![method];
    for next in methods_of(true) {
        if asked.contains(&next) {
            continue;
        }
        asked.push(next);
        method = next;
        answer = ask(next)?;
        if !refused(&answer) {
            break;
        }
    }
    Ok((answer, method))
}

/// Why Plyloft doesn't ask GitHub to merge, from a fresh read: the pull
/// request is closed, a check on GitHub failed, or it conflicts. Pending
/// checks and reviews are GitHub's to judge (its answer is shown).
pub fn merge_refusal(pr: &PrStatus) -> Option<String> {
    if pr.state == PrState::Closed {
        return Some("Not merged: the pull request is closed on GitHub.".to_string());
    }
    if pr.state != PrState::Open {
        return None;
    }
    // v1.154.1 (walk I1): right after a push, GitHub reporting no checks (or
    // still the old head's) is GitHub not having started them yet — before
    // the failure branch, as the card shows it (the old head's failure is
    // not the pushed commit's).
    if pr.awaiting_checks {
        return Some(AWAITING_CHECKS_WORDS.to_string());
    }
    if pr.checks == PrChecks::Failing {
        let names = pr
            .failing_checks
            .iter()
            .map(PrCheck::label)
            .collect::<Vec<_>>()
            .join(", ");
        return Some(if names.is_empty() {
            "Not merged: checks failed on GitHub. Merge it once they pass.".to_string()
        } else {
            format!("Not merged: checks failed on GitHub ({names}). Merge it once they pass.")
        });
    }
    if pr.mergeable == PrMergeable::Conflicting {
        return Some(CONFLICT_WORDS.to_string());
    }
    None
}

/// v1.154.1 (walk I1): Merge while GitHub hasn't started the checks of the
/// latest push.
pub const AWAITING_CHECKS_WORDS: &str = "Not merged: GitHub hasn't started the checks on the latest \
push yet (or this repository has none); Merge comes back within a few minutes.";

const CONFLICT_WORDS: &str =
    "Not merged: it conflicts with its base branch. Resolve the conflict, then merge.";

/// What a `gh pr merge` answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeAnswer {
    Merged,
    /// Merged already (on GitHub, or by auto-merge a moment ago).
    AlreadyMerged,
    /// GitHub (or gh on its behalf) refused; its words as they are.
    Refused(String),
}

pub fn read_merge_answer(answer: &GhAnswer) -> MergeAnswer {
    let said = answer.said();
    if said.to_ascii_lowercase().contains("was already merged") {
        return MergeAnswer::AlreadyMerged;
    }
    if answer.ok {
        MergeAnswer::Merged
    } else {
        MergeAnswer::Refused(said)
    }
}

/// The line above GitHub's own answer when it refused a merge. It points at
/// Merge when checks pass only when that is still something to do: not when
/// it is on, nor when GitHub already refused it for this PR.
pub fn refused_merge_words(github: &str, pr: &PrStatus) -> String {
    let lower = github.to_ascii_lowercase();
    if crate::merge_method::refused_for_method(github) {
        METHOD_REFUSED_WORDS.to_string()
    } else if lower.contains("head branch was modified") || lower.contains("expected head") {
        HEAD_MOVED_WORDS.to_string()
    } else if lower.contains("cannot be cleanly created") || lower.contains("conflict") {
        CONFLICT_WORDS.to_string()
    } else if lower.contains("base branch policy") {
        let base = "Not merged: GitHub says its base branch rules aren't met yet — checks on GitHub \
                    still running, or a review.";
        if pr.auto_merge || pr.auto_merge_refused.is_some() {
            base.to_string()
        } else {
            format!("{base} Turn on Merge when checks pass to have GitHub merge it then.")
        }
    } else {
        "Not merged: GitHub refused. Its answer is below.".to_string()
    }
}

/// G3: GitHub refused the merge method even after Plyloft read the
/// repository's allowed ones again.
pub const METHOD_REFUSED_WORDS: &str = "Not merged: this repository doesn't allow that way of merging, \
and Plyloft found no other way it allows. Its answer is below.";

/// G3, G1–G3 Challenger (2): the pull request on GitHub is no longer at the
/// commit Plyloft pushed (`--match-head-commit`), so nothing was merged —
/// GitHub's "Update branch", a bot or someone else's push. Merge what's on
/// GitHub now is the person's way on.
pub const HEAD_MOVED_WORDS: &str = "Not merged: someone else changed it on GitHub — the pull request has commits \
Plyloft didn't push. Look at them on GitHub; to merge them anyway, press Merge what's on GitHub now.";

/// G1–G3 Challenger (2): the card's line while GitHub's head isn't the one
/// Plyloft pushed (`prStatus.ts::PR_HEAD_MOVED_LINE`).
/// 1.171.0 B3 (DL-24): who changed it, said first (`deliveryWords.ts::SOMEONE_ELSE_CHANGED`).
pub const HEAD_MOVED_LINE: &str = "Someone else changed it on GitHub: the pull request has commits Plyloft didn't push.";

/// G1–G3 Challenger (2): Merge what's on GitHub now, when GitHub's head moved
/// again since the card showed it.
pub const HEAD_CHANGED_AGAIN_WORDS: &str = "Not merged: the pull request on GitHub changed again since the card \
showed it. Look at it on GitHub, then merge.";

/// What the card's Merge (or its auto-merge switch) did, for the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrMergeResult {
    /// The card as written (after the read that followed).
    pub card: KanbanCard,
    /// GitHub merged it (now or before).
    pub merged: bool,
    /// Plyloft's line when nothing was merged or turned on/off.
    pub refused: Option<String>,
    /// GitHub's own answer, as it is (for Details).
    pub github: Option<String>,
}

/// What a merge flow needs from the app — `gh` as the workspace's account,
/// a fresh read of the card's PR (SL-1's one path), and a write of the card's
/// auto-merge facts. Tests give a stub.
pub trait MergeEnv {
    fn gh(&self, args: &[&str]) -> Result<GhAnswer, String>;
    fn refresh(&self) -> Result<KanbanCard, String>;
    fn record(&self, f: &dyn Fn(&mut PrStatus)) -> Result<KanbanCard, String>;
    /// G3: how `url`'s repository allows merging, every allowed method in
    /// Plyloft's order (`merge_method::methods_for_pr`); `reread` reads
    /// GitHub again whatever the cache says.
    fn methods(&self, url: &str, reread: bool) -> Vec<MergeMethod>;
    /// Walk fix: whether `url`'s base branch requires status checks
    /// ([`checks_required`]).
    fn checks_required(&self, url: &str) -> Option<bool>;
    /// Round 3 (S4): the commit the card's branch ends in on this computer,
    /// `None` when it has no such branch here.
    fn local_tip(&self, card: &KanbanCard) -> Option<String>;
}

fn pr_of(card: &KanbanCard) -> Result<(String, PrStatus), String> {
    let url = card
        .pr_url
        .clone()
        .ok_or_else(|| "this card has no pull request".to_string())?;
    let pr = card
        .pr
        .clone()
        .ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
    Ok((url, pr))
}

fn result(card: KanbanCard, refused: Option<String>, github: Option<String>) -> PrMergeResult {
    let merged = card.pr.as_ref().is_some_and(|p| p.state == PrState::Merged);
    PrMergeResult { card, merged, refused, github }
}

/// v1.154.1 (M1): Merge while the Challenger's request for changes covers the
/// latest round (the words of `pr_fix::changes_requested_words`). 1.171.0
/// C3: by the card's real press.
pub fn changes_requested_words(ai: &str) -> String {
    format!(
        "Not merged: the Reviewer asked for changes to the latest round. Have {ai} address them and press Finish and \
check, or, on the card, Agree with {ai}, keep it as it is; then Merge."
    )
}

/// The card's **Merge**: read the PR fresh, refuse on a failed check or a
/// conflict, else `gh pr merge <url> --<method> --match-head-commit <head>`
/// (G3); on success read it again so SL-1's merged transition runs.
///
/// G1–G3 Challenger (2): while GitHub's head isn't the one Plyloft pushed
/// (`PrStatus::head_moved`), Merge is refused before GitHub is asked;
/// **Merge what's on GitHub now** passes `github_head`, the head the card
/// showed, and merges only while the fresh read still has it.
pub fn merge(env: &dyn MergeEnv, github_head: Option<&str>) -> Result<PrMergeResult, String> {
    let card = env.refresh()?;
    let (url, pr) = pr_of(&card)?;
    if pr.state == PrState::Merged {
        return Ok(result(card, None, None));
    }
    if let Some(words) = merge_refusal(&pr) {
        return Ok(result(card, Some(words), None));
    }
    // v1.154.1 (M1, ADR 0006): not while the Challenger's request for changes
    // covers the latest snapshot — as Push update (`pr_fix::push_update`).
    if crate::builder::changes_requested_on_current(&card) {
        let words = changes_requested_words(crate::pr_fix::builder_ai(&card));
        return Ok(result(card, Some(words), None));
    }
    let head = if pr.head_moved() {
        let fresh = pr.head_sha.clone().unwrap_or_default();
        match github_head.map(str::trim).filter(|h| !h.is_empty()) {
            None => return Ok(result(card, Some(HEAD_MOVED_WORDS.to_string()), None)),
            Some(shown) if !crate::pr_status::same_commit(shown, &fresh) => {
                return Ok(result(card, Some(HEAD_CHANGED_AGAIN_WORDS.to_string()), None))
            }
            // The person's press: GitHub's full name for the head they saw.
            Some(_) => fresh,
        }
    } else {
        match head_to_match(env, &url, &pr)? {
            Ok(head) => head,
            // Round 3 (S4): GitHub was asked for no merge, so nothing here
            // says it refused one — the words of a read that failed.
            Err(unread) => return Err(format!("couldn't read the pull request on GitHub: {}", unread.said())),
        }
    };
    let (answer, _) = ask_with_method(&|reread| env.methods(&url, reread), &|method| {
        env.gh(&merge_args(&url, method, Some(&head)))
    })?;
    match read_merge_answer(&answer) {
        MergeAnswer::Refused(github) => {
            Ok(result(card, Some(refused_merge_words(&github, &pr)), Some(github)))
        }
        MergeAnswer::Merged | MergeAnswer::AlreadyMerged => match env.refresh() {
            Ok(card) => {
                let mut done = result(card, None, None);
                // GitHub said merged; a read that still says open is behind it.
                done.merged = true;
                Ok(done)
            }
            Err(e) => {
                log::info!("pr_merge: merged on GitHub; the read after it failed: {e}");
                Ok(PrMergeResult { card, merged: true, refused: None, github: None })
            }
        },
    }
}

/// Turn "Merge when checks pass" on or off for the card's open PR from the
/// card. On: `--<method> --match-head-commit <head> --auto` (G3); a refusal
/// is kept on the card (its line says why, the Merge button stays). Off:
/// `--disable-auto`. Then a fresh read says what GitHub holds.
pub fn set_auto_merge(env: &dyn MergeEnv, on: bool) -> Result<PrMergeResult, String> {
    let card = env.refresh()?;
    let (url, pr) = pr_of(&card)?;
    if pr.state != PrState::Open {
        return Ok(result(card, Some("The pull request isn't open any more.".to_string()), None));
    }
    // G1–G3 Challenger (2): nothing automatic merges commits Plyloft didn't
    // push.
    if on && pr.head_moved() {
        return Ok(result(card, Some(HEAD_MOVED_WORDS.to_string()), None));
    }
    // Walk fix: GitHub keeps it only where the base branch requires checks;
    // elsewhere Plyloft does, and the poller merges once they passed.
    if on && !pr.auto_merge && env.checks_required(&url) != Some(true) {
        let card = env.record(&keep_on_plyloft)?;
        return Ok(result(card, None, None));
    }
    // 1.174.0 A2 round 2: off while Plyloft only holds a merge it means to
    // turn on (nothing on GitHub to turn off) — the hold ends, no gh call.
    if !on && !pr.auto_merge && !pr.plyloft_auto_merge && pr.auto_merge_wanted.is_some() {
        let card = env.record(&|p| p.auto_merge_wanted = None)?;
        return Ok(result(card, None, None));
    }
    if !on && pr.plyloft_auto_merge {
        let mut card = env.record(&|p| p.plyloft_auto_merge = false)?;
        if card.pr.as_ref().is_some_and(|p| p.auto_merge_wanted.is_some()) {
            card = env.record(&|p| p.auto_merge_wanted = None)?;
        }
        if !pr.auto_merge {
            return Ok(result(card, None, None));
        }
    }
    let answer = if on {
        // OP-8, round 3 (S4): GitHub merges this later by itself, so it is
        // held to a commit the card records as verified — what Plyloft
        // pushed, or the card's last checked commit while GitHub's head is
        // that one — never to a head just read from GitHub. The person's
        // own Merge press reads and matches ([`merge`]).
        let Some(head) = verified_head(env, &card, &pr) else {
            return Ok(result(card, Some(HEAD_MOVED_WORDS.to_string()), None));
        };
        ask_with_method(&|reread| env.methods(&url, reread), &|method| {
            env.gh(&auto_merge_args(&url, method, Some(&head)))
        })?
        .0
    } else {
        env.gh(&disable_auto_merge_args(&url))?
    };
    if !answer.ok {
        let github = answer.said();
        let card = if on {
            let refused = github.clone();
            env.record(&move |p| {
                p.auto_merge = false;
                p.auto_merge_refused = Some(refused.clone());
            })?
        } else {
            card
        };
        let words = if on {
            "Merge when checks pass couldn't be turned on. GitHub's answer is below."
        } else {
            "Merge when checks pass couldn't be turned off. GitHub's answer is below."
        };
        return Ok(result(card, Some(words.to_string()), Some(github)));
    }
    let card = match env.refresh() {
        Ok(card) => card,
        // GitHub said yes; the next read confirms it.
        Err(_) => env.record(&move |p| {
            p.auto_merge = on;
            if on {
                p.auto_merge_refused = None;
            }
        })?,
    };
    // G1–G3 Challenger (3): the person decided; Plyloft's hold is over.
    let card = if card.pr.as_ref().is_some_and(|p| p.auto_merge_wanted.is_some()) {
        env.record(&|p| p.auto_merge_wanted = None)?
    } else {
        card
    };
    Ok(result(card, None, None))
}

/// Record on the card what `gh pr merge --squash --auto` answered right
/// after the ship opened `url`: on, or GitHub's refusal. A call that never got
/// GitHub's answer (timed out, offline, gh missing) is not a refusal and
/// records nothing. Nothing either when the card now records another PR, or
/// has no PR state.
pub fn record_after_ship(card: &mut KanbanCard, url: &str, answer: &Result<GhAnswer, String>) -> bool {
    if card.pr_url.as_deref() != Some(url) {
        return false;
    }
    let Some(pr) = card.pr.as_mut() else { return false };
    match answer {
        Ok(a) if a.ok => {
            pr.auto_merge = true;
            pr.auto_merge_refused = None;
        }
        Ok(a) => {
            pr.auto_merge = false;
            pr.auto_merge_refused = Some(a.said());
        }
        Err(_) => return false,
    }
    true
}

/// Right after `gh pr create` (or linking the PR that already existed), with
/// "Merge when checks pass" on for the workspace: ask GitHub to merge it when
/// its checks pass — with the repository's method (`method_of`, G3), only
/// while its head is `head`, the commit the ship pushed. The ship has
/// succeeded either way; this never fails it.
///
/// Walk fix: only where the base branch requires checks
/// (`checks_required`, Some(true)); elsewhere GitHub would merge it at once,
/// so Plyloft keeps it (`plyloft_auto_merge`) and asks GitHub nothing.
#[allow(clippy::too_many_arguments)]
pub fn turn_on_after_ship(
    kanban: &crate::kanban::KanbanStore,
    workspace_id: &str,
    card_id: &str,
    url: &str,
    // Round 3 (S4): always the commit the ship pushed.
    head: &str,
    methods_of: impl Fn(bool) -> Vec<MergeMethod>,
    checks_required: impl Fn(&str) -> Option<bool>,
    gh: impl Fn(&[&str]) -> Result<GhAnswer, String>,
) {
    if checks_required(url) != Some(true) {
        log::info!("pr_merge: {card_id}: no required checks on the base branch (or unknown): Plyloft merges it once checks pass");
        let written = kanban.update_card_pr(workspace_id, card_id, |c| {
            if c.pr_url.as_deref() != Some(url) {
                return Ok(((), PrWrite::Skip));
            }
            let Some(pr) = c.pr.as_mut() else { return Ok(((), PrWrite::Skip)) };
            keep_on_plyloft(pr);
            Ok(((), PrWrite::Stamp))
        });
        if let Err(e) = written {
            log::warn!("pr_merge: {card_id}: couldn't record merge when checks pass: {e}");
        }
        return;
    }
    let answer = ask_with_method(&methods_of, &|method| gh(&auto_merge_args(url, method, Some(head)))).map(|(a, _)| a);
    match &answer {
        Err(e) => log::info!("pr_merge: {card_id}: auto-merge not asked (no answer from GitHub): {e}"),
        Ok(a) if !a.ok => log::info!("pr_merge: {card_id}: auto-merge refused: {}", a.said()),
        _ => {}
    }
    let written = kanban.update_card_pr(workspace_id, card_id, |c| {
        let wrote = record_after_ship(c, url, &answer);
        Ok(((), if wrote { PrWrite::Stamp } else { PrWrite::Skip }))
    });
    if let Err(e) = written {
        log::warn!("pr_merge: {card_id}: couldn't record auto-merge: {e}");
    }
}

// ── G1–G3 Challenger (1, 3): auto-merge waits for a review ─────────────

/// What `gh pr view <url> --json autoMergeRequest --jq '.autoMergeRequest !=
/// null'` answered: whether GitHub merges it by itself. None when it didn't
/// say (an old gh without the field, offline).
pub fn auto_merge_on_from(answer: &Result<GhAnswer, String>) -> Option<bool> {
    match answer {
        Ok(a) if a.ok => match a.stdout.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// `gh pr view <url> --json autoMergeRequest --jq '.autoMergeRequest != null'`.
pub fn auto_merge_on_args(url: &str) -> Vec<&str> {
    vec!["pr", "view", url, "--json", "autoMergeRequest", "--jq", ".autoMergeRequest != null"]
}

/// The pull request `url` now holds a commit nobody reviewed (Ship anyway,
/// Ship with follow-up, Push update of an unreviewed round): GitHub must not
/// merge it by itself. Auto-merge that is on (`auto_on`) is turned off
/// (`--disable-auto`, the workspace's account as `gh` runs) and the card
/// says so; a press that wanted it (`wanted`) is recorded, so Plyloft turns
/// it on once the commit is reviewed ([`resume_due`]). Returns whether it
/// was turned off.
pub fn hold_for_review(
    kanban: &crate::kanban::KanbanStore,
    workspace_id: &str,
    card_id: &str,
    url: &str,
    auto_on: bool,
    wanted: bool,
    gh: impl Fn(&[&str]) -> Result<GhAnswer, String>,
) -> bool {
    // Walk fix: Plyloft's own "Merge when checks pass" is held the same way.
    let plyloft_on = kanban
        .get_card(workspace_id, card_id)
        .ok()
        .filter(|c| c.pr_url.as_deref() == Some(url))
        .and_then(|c| c.pr)
        .is_some_and(|p| p.plyloft_auto_merge);
    let github_off = auto_on
        && match gh(&disable_auto_merge_args(url)) {
            Ok(a) if a.ok => true,
            Ok(a) => {
                log::warn!("pr_merge: {card_id}: auto-merge on an unreviewed commit couldn't be turned off: {}", a.said());
                false
            }
            Err(e) => {
                log::warn!("pr_merge: {card_id}: auto-merge on an unreviewed commit couldn't be turned off: {e}");
                false
            }
        };
    let turned_off = github_off || plyloft_on;
    if !turned_off && !wanted {
        return false;
    }
    let written = kanban.update_card_pr(workspace_id, card_id, |c| {
        if c.pr_url.as_deref() != Some(url) {
            return Ok(((), PrWrite::Skip));
        }
        let Some(pr) = c.pr.as_mut() else { return Ok(((), PrWrite::Skip)) };
        pr.auto_merge_wanted = Some(if turned_off {
            if github_off {
                pr.auto_merge = false;
            }
            pr.plyloft_auto_merge = false;
            AutoMergeWanted::TurnedOff
        } else {
            pr.auto_merge_wanted.filter(|w| w.waiting()).unwrap_or(AutoMergeWanted::Held)
        });
        Ok(((), PrWrite::Stamp))
    });
    if let Err(e) = written {
        log::warn!("pr_merge: {card_id}: couldn't record the auto-merge hold: {e}");
    }
    turned_off
}

/// 1.175.0 (round 4, T4; owner's prudent option): `cards` come from a board
/// opened from its last saved copy, which is one save behind. If the lost
/// save was the person turning "Merge when checks pass" off, the copy says
/// on, Plyloft merges when the checks pass, and a merge can't be taken back.
/// So what Plyloft itself would do later is cleared on every restored card
/// whose pull request is open, and the person presses again:
///
/// - Plyloft's own merge when the checks pass (`plyloft_auto_merge`, which
///   [`merge_due`] reads);
/// - a press still waiting for the commit to be reviewed
///   (`auto_merge_wanted` held or turned off), which [`resume_due`] would
///   turn into GitHub's auto-merge by itself.
///
/// GitHub's own auto-merge lives on GitHub and is not touched: the next
/// read says what it is. Returns how many cards had something to turn off.
pub fn turn_off_on_restore(cards: &mut [KanbanCard]) -> usize {
    let mut turned_off = 0;
    for card in cards.iter_mut() {
        let Some(pr) = card.pr.as_mut() else { continue };
        let waiting = pr.auto_merge_wanted.is_some_and(|wanted| wanted.waiting());
        if !pr.plyloft_auto_merge && !waiting {
            continue;
        }
        pr.plyloft_auto_merge = false;
        if waiting {
            pr.auto_merge_wanted = None;
        }
        turned_off += 1;
        log::warn!("pr_merge: {}: Merge when checks pass was turned off: the card's board was opened from its last saved copy", card.id);
    }
    turned_off
}

/// G1–G3 Challenger (3): the card's held auto-merge can be turned on now —
/// a press wanted it (`auto_merge_wanted` held or turned off), the pull
/// request is open with auto-merge off, at the commit Plyloft pushed, that
/// commit is the card's last round and it is reviewed: approved, or a
/// human's decision (`builder::ship_review_record` says nothing). Returns
/// the pull request and the head to merge only while GitHub has it.
pub fn resume_due(card: &KanbanCard) -> Option<(String, String)> {
    let url = card.pr_url.clone()?;
    let pr = card.pr.as_ref()?;
    if !crate::pr_status::card_pr_open(card) || pr.auto_merge || !pr.auto_merge_wanted.is_some_and(|w| w.waiting()) {
        return None;
    }
    let head = pr.pushed_head.clone().filter(|h| !h.is_empty())?;
    if pr.head_moved() {
        return None;
    }
    let last = card.builder.as_ref()?.snapshots.last()?;
    if !crate::pr_status::same_commit(&last.sha, &head) {
        return None;
    }
    if crate::builder::changes_requested_on_current(card) || crate::builder::ship_review_record(card, &last.sha, false).is_some() {
        return None;
    }
    Some((url, head))
}

/// G1–G3 Challenger (3): turn the card's held auto-merge on, when
/// [`resume_due`] — with the repository's method, only while GitHub's head
/// is the reviewed commit — and say so on the card (`Resumed`). GitHub's
/// refusal is kept as any auto-merge refusal is. Returns whether it is on.
pub fn resume_held(
    kanban: &crate::kanban::KanbanStore,
    workspace_id: &str,
    card_id: &str,
    methods_of: impl Fn(&str, bool) -> Vec<MergeMethod>,
    checks_required: impl Fn(&str) -> Option<bool>,
    gh: impl Fn(&[&str]) -> Result<GhAnswer, String>,
) -> bool {
    let Ok(card) = kanban.get_card(workspace_id, card_id) else { return false };
    let Some((url, head)) = resume_due(&card) else { return false };
    // Walk fix: no required checks (or unknown) — Plyloft keeps it.
    if checks_required(&url) != Some(true) {
        let written = kanban.update_card_pr(workspace_id, card_id, |c| {
            if c.pr_url.as_deref() != Some(url.as_str()) {
                return Ok(((), PrWrite::Skip));
            }
            let Some(pr) = c.pr.as_mut() else { return Ok(((), PrWrite::Skip)) };
            keep_on_plyloft(pr);
            Ok(((), PrWrite::Stamp))
        });
        return match written {
            Ok(_) => true,
            Err(e) => {
                log::warn!("pr_merge: {card_id}: couldn't record merge when checks pass again: {e}");
                false
            }
        };
    }
    let answer = ask_with_method(&|reread| methods_of(&url, reread), &|method| gh(&auto_merge_args(&url, method, Some(&head)))).map(|(a, _)| a);
    let on = matches!(&answer, Ok(a) if a.ok);
    if answer.is_err() {
        return false;
    }
    let written = kanban.update_card_pr(workspace_id, card_id, |c| {
        if c.pr_url.as_deref() != Some(url.as_str()) {
            return Ok(((), PrWrite::Skip));
        }
        if !record_after_ship(c, &url, &answer) {
            return Ok(((), PrWrite::Skip));
        }
        if let Some(pr) = c.pr.as_mut() {
            pr.auto_merge_wanted = on.then_some(AutoMergeWanted::Resumed);
        }
        Ok(((), PrWrite::Stamp))
    });
    if let Err(e) = written {
        log::warn!("pr_merge: {card_id}: couldn't record auto-merge turned on again: {e}");
    }
    on
}

/// G1–G3 Challenger (3): after the Challenger's review of a card settles —
/// off its thread — turn on the auto-merge a press wanted, when the review
/// made the pushed commit a reviewed one ([`resume_due`]); then read the
/// pull request again. Nothing when nothing is held.
pub fn kick_resume_held<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, card_id: &str) {
    use tauri::Manager;
    let Some(kanban) = app.try_state::<crate::kanban::KanbanStore>() else { return };
    let Ok(card) = kanban.get_card(workspace_id, card_id) else { return };
    if resume_due(&card).is_none() {
        return;
    }
    let (app, workspace_id, card_id) = (app.clone(), workspace_id.to_string(), card_id.to_string());
    std::thread::spawn(move || {
        let env = AppEnv { app: &app, workspace_id: &workspace_id, card_id: &card_id, source: crate::pr_status::RefreshSource::CardPage };
        let kanban = app.state::<crate::kanban::KanbanStore>();
        let on = resume_held(
            &kanban,
            &workspace_id,
            &card_id,
            |url, reread| env.methods(url, reread),
            |url| env.checks_required(url),
            |args| env.gh(args),
        );
        crate::kanban::emit_kanban_changed(&app, &workspace_id);
        if on {
            if let Err(e) = env.refresh() {
                log::debug!("pr_merge: read after turning auto-merge on again for {card_id}: {e}");
            }
        }
    });
}

// ── 1.170.0 walk fix: Plyloft merges it once its checks passed ─────────

/// Plyloft's "Merge when checks pass" is due on the card: it is on
/// (`plyloft_auto_merge`, GitHub's own off), and the card's Merge would
/// merge it now — the pull request is open and read, its checks on GitHub
/// passed (or it has none, after the wait following the opening or a
/// push), GitHub says it is mergeable and not blocked, behind or a draft,
/// no review stands in the way, nothing on Plyloft's side does
/// (`pr_status::card_pr_mergeable_now`: the Challenger's request for
/// changes, a fix waiting for Push update, commits Plyloft didn't push) —
/// and what Plyloft pushed is reviewed: the card's last round, approved or
/// a human's decision. Returns the pull request and the head to merge only
/// while GitHub has it (`--match-head-commit`).
pub fn merge_due(card: &KanbanCard) -> Option<(String, String)> {
    let url = card.pr_url.clone()?;
    let pr = card.pr.as_ref()?;
    if !pr.plyloft_auto_merge || pr.auto_merge || !crate::pr_status::card_pr_open(card) {
        return None;
    }
    if !crate::pr_status::card_pr_mergeable_now(card, pr) {
        return None;
    }
    let head = pr.pushed_head.clone().filter(|h| !h.is_empty())?;
    if let Some(last) = card.builder.as_ref().and_then(|b| b.snapshots.last()) {
        if !crate::pr_status::same_commit(&last.sha, &head) {
            return None;
        }
    }
    if crate::builder::changes_requested_on_current(card) || crate::builder::ship_review_record(card, &head, false).is_some() {
        return None;
    }
    Some((url, merge_head(pr)?))
}

/// Merge the card's pull request when [`merge_due`] — the repository's
/// method, `--match-head-commit` the pushed head, never `--admin` — then
/// read it again (SL-1's merged transition). GitHub's refusal turns
/// Plyloft's "Merge when checks pass" off and is kept on the card as an
/// auto-merge refusal (its line and Try again). No answer from GitHub:
/// nothing recorded, the next read tries again. None when nothing was due
/// or GitHub didn't answer.
pub fn merge_when_due(env: &dyn MergeEnv, card: &KanbanCard) -> Option<PrMergeResult> {
    let (url, head) = merge_due(card)?;
    let pr = card.pr.clone()?;
    let answer = ask_with_method(&|reread| env.methods(&url, reread), &|method| {
        env.gh(&merge_args(&url, method, Some(&head)))
    });
    let answer = match answer {
        Ok((answer, _)) => answer,
        Err(e) => {
            log::info!("pr_merge: {}: merge when checks pass: no answer from GitHub: {e}", card.id);
            return None;
        }
    };
    match read_merge_answer(&answer) {
        MergeAnswer::Refused(github) => {
            log::info!("pr_merge: {}: merge when checks pass refused: {github}", card.id);
            let kept = github.clone();
            let card = env
                .record(&move |p| {
                    p.plyloft_auto_merge = false;
                    p.auto_merge_refused = Some(kept.clone());
                })
                .unwrap_or_else(|_| card.clone());
            Some(result(card, Some(refused_merge_words(&github, &pr)), Some(github)))
        }
        MergeAnswer::Merged | MergeAnswer::AlreadyMerged => {
            let card = env.refresh().unwrap_or_else(|_| card.clone());
            Some(PrMergeResult { card, merged: true, refused: None, github: None })
        }
    }
}

/// The poller's half: after its read of `card`, Plyloft's "Merge when
/// checks pass" when due ([`merge_when_due`]); the read after the merge is
/// the poller's own (its notification).
pub fn merge_if_due<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str, card: &KanbanCard) {
    if merge_due(card).is_none() {
        return;
    }
    let env = AppEnv { app, workspace_id, card_id: &card.id, source: crate::pr_status::RefreshSource::Poller };
    if let Some(done) = merge_when_due(&env, card) {
        if !done.merged {
            crate::kanban::emit_kanban_changed(app, workspace_id);
        }
    }
}

/// Whether a ship's card should be read again once the ship returns: it
/// just asked GitHub for auto-merge, and GitHub may have merged a PR that was
/// ready at once (real: a `CLEAN` PR is merged by `--auto`).
pub fn read_after_ship(outcome_kind: &str, card: &KanbanCard) -> bool {
    outcome_kind == "pr"
        && card
            .pr
            .as_ref()
            .is_some_and(|p| p.auto_merge && p.state == PrState::Open)
}

/// After a ship that turned auto-merge on: one read of the card's PR, off
/// the ship's thread and outside its lock, so a PR GitHub merged at once
/// shows as merged, not "Will merge when checks pass".
pub fn kick_read_after_ship<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    outcome_kind: &str,
) {
    use tauri::Manager;
    let Some(kanban) = app.try_state::<crate::kanban::KanbanStore>() else { return };
    let Ok(card) = kanban.get_card(workspace_id, card_id) else { return };
    if !read_after_ship(outcome_kind, &card) {
        return;
    }
    let (app, workspace_id, card_id) = (app.clone(), workspace_id.to_string(), card_id.to_string());
    std::thread::spawn(move || {
        if let Err(e) = crate::pr_status::refresh_card(
            &app,
            &workspace_id,
            &card_id,
            crate::pr_status::RefreshSource::CardPage,
        ) {
            log::debug!("pr_merge: read after ship of {card_id}: {e}");
        }
    });
}

// ── Tauri glue ──────────────────────────────────────────────────────────

struct AppEnv<'a, R: tauri::Runtime> {
    app: &'a tauri::AppHandle<R>,
    workspace_id: &'a str,
    card_id: &'a str,
    /// Who reads the pull request again (the poller notifies).
    source: crate::pr_status::RefreshSource,
}

impl<R: tauri::Runtime> MergeEnv for AppEnv<'_, R> {
    fn gh(&self, args: &[&str]) -> Result<GhAnswer, String> {
        let gh = crate::doctor::require("gh")?;
        let _github = crate::github_account::enter_for_app(self.app, self.workspace_id);
        let out = crate::github::gh_output(&gh, None, args, crate::shared_config::GH_TIMEOUT)?;
        Ok(GhAnswer::from_output(&out))
    }

    fn refresh(&self) -> Result<KanbanCard, String> {
        crate::pr_status::refresh_card(
            self.app,
            self.workspace_id,
            self.card_id,
            self.source,
        )
    }

    fn checks_required(&self, url: &str) -> Option<bool> {
        checks_required(url, None, &|args| self.gh(args))
    }

    fn local_tip(&self, card: &KanbanCard) -> Option<String> {
        let branch = card.branch_name.as_deref().filter(|b| !b.is_empty())?;
        let (_, cwd) = crate::commands::workspace_checkout(self.app, self.workspace_id).ok()?;
        crate::git::capture(&cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")])
            .ok()
            .map(|sha| sha.trim().to_string())
            .filter(|sha| !sha.is_empty())
    }

    fn methods(&self, url: &str, reread: bool) -> Vec<MergeMethod> {
        use tauri::Manager;
        let Some(workspaces) = self.app.try_state::<crate::workspace::WorkspaceStore>() else {
            return crate::merge_method::ALL_METHODS.to_vec();
        };
        crate::merge_method::methods_for_pr(&workspaces, self.workspace_id, url, reread, |args| self.gh(args))
    }

    fn record(&self, f: &dyn Fn(&mut PrStatus)) -> Result<KanbanCard, String> {
        use tauri::Manager;
        let kanban = self.app.state::<crate::kanban::KanbanStore>();
        let (card, ()) = kanban.update_card_pr(self.workspace_id, self.card_id, |c| {
            let pr = c.pr.as_mut().ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
            f(pr);
            Ok(((), PrWrite::Stamp))
        })?;
        crate::kanban::emit_kanban_changed(self.app, self.workspace_id);
        Ok(card)
    }
}

pub fn merge_card<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    github_head: Option<&str>,
) -> Result<PrMergeResult, String> {
    merge(&AppEnv { app, workspace_id, card_id, source: crate::pr_status::RefreshSource::CardPage }, github_head)
}

pub fn set_card_auto_merge<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    card_id: &str,
    on: bool,
) -> Result<PrMergeResult, String> {
    set_auto_merge(&AppEnv { app, workspace_id, card_id, source: crate::pr_status::RefreshSource::CardPage }, on)
}

#[cfg(test)]
#[path = "pr_merge_tests.rs"]
mod tests;
