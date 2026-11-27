//! Thin wrapper over the `gh` CLI for the GitHub-Issues-backed kanban
//! (Cycle 3). Every call shells out to an authenticated `gh` resolved through
//! the dependency doctor — the same pattern as the card-ship PR flow
//! (`commands::card_ship`). No in-process API token; `gh` owns auth.
//!
//! Two halves:
//!   - **pure body marshalling** (`build_issue_body` / `parse_issue_body`) that
//!     round-trips a card's `notes` + `knowledge` through an issue body's
//!     marker blocks, preserving any free-form text a human added on GitHub;
//!   - **`gh`-invoking issue operations** (list / create / edit / close /
//!     comment / label / current-user).
//!
//! Claim note: GitHub issue assignees are **logins**, not emails. The claim
//! check (increment 3) compares an issue's assignee logins against
//! [`current_login`], NOT against `git config user.email`.

use serde::Deserialize;

#[cfg(test)]
thread_local! {
    /// Per-test-thread observation of the production `gh` subprocess seam.
    /// Keeping this thread-local avoids changing the process-wide cached PATH
    /// (and therefore avoids coupling otherwise-parallel Rust tests).
    static TEST_GH_INVOCATIONS: std::cell::RefCell<Vec<Vec<String>>> = const {
        std::cell::RefCell::new(Vec::new())
    };
    /// Per-test-thread deterministic results returned at the exact production
    /// subprocess seam. Tests still invoke the registered command and the
    /// public GitHub operation; only the external `gh` process is replaced.
    static TEST_GH_RESPONSES: std::cell::RefCell<Option<std::collections::VecDeque<Result<String, String>>>> =
        const { std::cell::RefCell::new(None) };
    /// GH #204: when armed, the seam runs this real program (a stalled stub)
    /// through the production bounded runner instead of answering from the
    /// queue: `(program, cwd, bound)`.
    /// GH #204 review 2: the bound each seam call was given, in order.
    static TEST_GH_TIMEOUTS: std::cell::RefCell<Vec<std::time::Duration>> =
        const { std::cell::RefCell::new(Vec::new()) };
    static TEST_GH_STUB: std::cell::RefCell<Option<(String, std::path::PathBuf, std::time::Duration)>> =
        const { std::cell::RefCell::new(None) };
    /// 1.173.0 (C2): what each stdin-fed call handed gh, in order.
    static TEST_GH_STDIN: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
    /// 1.175.0 (R2): the repository whose issue writes this thread's test
    /// holds ([`issue_writes_held`]).
    static TEST_HELD_REPO: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// 1.175.0 (R2): what an issue write answers while its board was opened from
/// its last saved copy and GitHub's issues haven't been read since. The
/// callers treat it as any write that didn't go through (the card stays
/// pending, a press says it failed with this under Details).
pub const ISSUE_WRITES_HELD: &str =
    "Plyloft opened this board from its last saved copy. It reads the board's issues from GitHub once before it sends anything there.";

type IssueWriteHold = Box<dyn Fn(&str) -> bool + Send + Sync>;

/// R2: asked before every write to an issue of `repo` (`setup` gives it:
/// `github_sync::restored_board_holds` over the boards and the project list).
static ISSUE_WRITE_HOLD: std::sync::OnceLock<IssueWriteHold> = std::sync::OnceLock::new();

/// R2: issue writes to a repository are refused while `held` says so for it.
/// Set once, at launch.
pub fn hold_issue_writes_while(held: IssueWriteHold) {
    let _ = ISSUE_WRITE_HOLD.set(held);
}

/// R2: a board opened from its last saved copy is one save behind, so what
/// its cards would send — a pending edit, a status label, a whole body built
/// from older notes — may be older than what GitHub has. Every write to an
/// issue (create, edit, body, close, assignee, comment, labels) asks here
/// first and is refused until the board's issues were read once
/// (`github_sync::refresh`, or the pull a Sync starts with). Reads and
/// everything that isn't an issue are never held.
fn issue_writes_held(repo: &str) -> Result<(), String> {
    #[cfg(test)]
    let held = TEST_HELD_REPO.with(|slot| slot.borrow().as_deref() == Some(repo));
    #[cfg(not(test))]
    let held = ISSUE_WRITE_HOLD.get().is_some_and(|held| held(repo));
    if held {
        log::info!("github: an issue write to {repo} waits for the first read of its restored board");
        return Err(ISSUE_WRITES_HELD.to_string());
    }
    Ok(())
}

/// 1.175.0 (round 4, T1): a write to an issue that is asked once and never
/// again. Every other issue write is retried by itself (a pending card, a
/// pending label, a press the person repeats); these two were simply lost
/// when [`issue_writes_held`] refused them, on a board whose project the
/// person might not open all session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HeldWrite {
    /// A card's outcome, as an issue comment (`github_sync::post_card_outcome_comment`).
    Comment { number: u64, body: String },
    /// This computer's claim marker taken off the issue (`device_claim::release_card`).
    ReleaseClaim { number: u64 },
}

/// The one-shot writes refused while their repository was held, by
/// repository (lower case), in the order they were asked. In memory: a quit
/// before the board's first read loses them, as the refusal did.
static HELD_WRITES: std::sync::Mutex<Option<std::collections::HashMap<String, Vec<HeldWrite>>>> = std::sync::Mutex::new(None);

fn held_writes() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, Vec<HeldWrite>>>> {
    HELD_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// T1: whether `error` is the hold's refusal ([`ISSUE_WRITES_HELD`]).
pub(crate) fn is_held_refusal(error: &str) -> bool {
    error == ISSUE_WRITES_HELD
}

/// T1: keep `write` for `repo` until its board was read
/// (`github_sync::send_held_writes`). A claim release is kept once per issue.
pub(crate) fn queue_held_write(repo: &str, write: HeldWrite) {
    let mut held = held_writes();
    let queue = held.get_or_insert_with(Default::default).entry(repo.trim().to_ascii_lowercase()).or_default();
    if !queue.contains(&write) {
        queue.push(write);
    }
}

/// T1: a claim on issue `number` is being asked again (the card was started
/// again), so a release still waiting for it must not go out after it.
pub(crate) fn forget_held_release(repo: &str, number: u64) {
    if let Some(queue) = held_writes().as_mut().and_then(|held| held.get_mut(&repo.trim().to_ascii_lowercase())) {
        queue.retain(|write| *write != HeldWrite::ReleaseClaim { number });
    }
}

/// T1: the writes kept for `repo`, taken out of the queue.
pub(crate) fn take_held_writes(repo: &str) -> Vec<HeldWrite> {
    held_writes().as_mut().and_then(|held| held.remove(&repo.trim().to_ascii_lowercase())).unwrap_or_default()
}

/// Tests: hold (or, with `None`, release) this thread's issue writes to `repo`.
#[cfg(test)]
pub(crate) fn set_test_issue_write_hold(repo: Option<&str>) {
    TEST_HELD_REPO.with(|slot| *slot.borrow_mut() = repo.map(str::to_string));
}

// ── marker blocks ────────────────────────────────────────────────────────────

pub(crate) const NOTES_OPEN: &str = "<!-- atelier:notes -->";
pub(crate) const NOTES_CLOSE: &str = "<!-- /atelier:notes -->";
pub(crate) const KNOWLEDGE_OPEN: &str = "<!-- atelier:knowledge -->";
pub(crate) const KNOWLEDGE_CLOSE: &str = "<!-- /atelier:knowledge -->";
/// 1.175.0 (B3): the four marks of a card's blocks in an issue body.
pub(crate) const BLOCK_MARKS: [&str; 4] = [NOTES_OPEN, NOTES_CLOSE, KNOWLEDGE_OPEN, KNOWLEDGE_CLOSE];

/// A card's two long-text fields parsed back out of an issue body, plus any
/// free-form text outside the markers (e.g. someone edited the body on GitHub).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedIssueBody {
    pub notes: Option<String>,
    pub knowledge: Option<String>,
    /// Text outside the marker blocks, preserved verbatim so a human edit on
    /// GitHub isn't silently dropped. Surfaced in card detail as a footer.
    pub raw_remainder: Option<String>,
}

/// Build an issue body from a card's notes + knowledge using marker blocks so
/// the two fields round-trip cleanly. Empty/blank fields are omitted.
///
/// `raw_remainder` is free-form text a human typed into the issue body outside
/// the marker blocks (cached on the card by [`parse_issue_body`]). It is
/// re-appended below the markers so a card edit from Ply doesn't silently erase
/// it — the write-back is then `parse_issue_body`-idempotent.
pub fn build_issue_body(
    notes: Option<&str>,
    knowledge: Option<&str>,
    raw_remainder: Option<&str>,
) -> String {
    let mut out = String::new();
    if let Some(n) = notes.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str(NOTES_OPEN);
        out.push('\n');
        out.push_str(n);
        out.push('\n');
        out.push_str(NOTES_CLOSE);
        out.push('\n');
    }
    if let Some(k) = knowledge.map(str::trim).filter(|s| !s.is_empty()) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(KNOWLEDGE_OPEN);
        out.push('\n');
        out.push_str(k);
        out.push('\n');
        out.push_str(KNOWLEDGE_CLOSE);
        out.push('\n');
    }
    if let Some(r) = raw_remainder.map(str::trim).filter(|s| !s.is_empty()) {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(r);
        out.push('\n');
    }
    out
}

/// Extract a card's notes + knowledge from an issue body, preserving any
/// free-form text outside the marker blocks.
pub fn parse_issue_body(body: &str) -> ParsedIssueBody {
    let notes = extract_block(body, NOTES_OPEN, NOTES_CLOSE);
    let knowledge = extract_block(body, KNOWLEDGE_OPEN, KNOWLEDGE_CLOSE);

    // 1.173.0 (C2): the claim marker is the claim's, never issue text.
    let mut remainder = crate::device_claim::without_marker(body);
    for (open, close) in [
        (NOTES_OPEN, NOTES_CLOSE),
        (KNOWLEDGE_OPEN, KNOWLEDGE_CLOSE),
    ] {
        if let (Some(s), Some(e)) = (remainder.find(open), remainder.find(close)) {
            if e > s {
                remainder.replace_range(s..e + close.len(), "");
            }
        }
    }
    let remainder = remainder.trim();
    ParsedIssueBody {
        notes,
        knowledge,
        raw_remainder: (!remainder.is_empty()).then(|| remainder.to_string()),
    }
}

/// An issue filed on GitHub the normal way — a plain body, no Ply marker
/// blocks — adopted as the card's brief. Applies only when the body carries
/// neither marker block and `local_notes` is empty: the unmarked text becomes
/// `notes` and the remainder is cleared (the text moves, nothing is lost).
/// `None` means "leave `parsed` as is". A Ply-built body whose notes and
/// knowledge are both empty looks the same as an unmarked one, so its
/// remainder is adopted too; that only surfaces text as the brief.
pub fn adopt_unmarked_body(
    parsed: &ParsedIssueBody,
    local_notes: Option<&str>,
) -> Option<ParsedIssueBody> {
    if parsed.notes.is_some() || parsed.knowledge.is_some() {
        return None;
    }
    if local_notes.is_some_and(|n| !n.trim().is_empty()) {
        return None;
    }
    let remainder = parsed.raw_remainder.clone()?;
    Some(ParsedIssueBody {
        notes: Some(remainder),
        knowledge: None,
        raw_remainder: None,
    })
}

/// "Use as brief": the issue text outside the markers joins the card's notes
/// below what is already there (blank notes → just the remainder).
pub fn notes_with_remainder(notes: Option<&str>, remainder: &str) -> String {
    let remainder = remainder.trim();
    match notes.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => format!("{n}\n\n{remainder}"),
        None => remainder.to_string(),
    }
}

fn extract_block(body: &str, open: &str, close: &str) -> Option<String> {
    let s = body.find(open)? + open.len();
    let e = body[s..].find(close)? + s;
    Some(body[s..e].trim().to_string())
}

// ── gh invocation ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct GhIssue {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub assignees: Vec<GhUser>,
    #[serde(default)]
    pub labels: Vec<GhLabel>,
    /// "OPEN" / "CLOSED".
    #[serde(default)]
    pub state: String,
    /// Deserialized from `gh` but not yet consumed — reserved for the
    /// incremental-since reconcile (deferred past the "minimal scheduling"
    /// scope of v1.57.0). Kept on the struct so the `--json` field list and
    /// the type stay in lockstep.
    #[serde(rename = "updatedAt", default)]
    #[allow(dead_code)]
    pub updated_at: String,
    /// N14 (item 6): who opened the issue. `null` from GitHub for a deleted
    /// account; absent from answers read before it was asked for.
    #[serde(default)]
    pub author: Option<GhUser>,
    /// U10: when the issue was opened (RFC 3339), so a card first read later
    /// doesn't say it was described at the moment of that read.
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
    /// U33: why a closed issue is closed: "COMPLETED", "NOT_PLANNED". Absent
    /// from answers read before it was asked for.
    #[serde(rename = "stateReason", default)]
    pub state_reason: Option<String>,
    /// 1.175.0 (B3): where the issue's text comes from — the author's
    /// association with the repository and who edited it last. Not part of
    /// `gh issue list`'s answer: filled by [`issue_origins`] for the open
    /// issues a board read asks about; `None` when GitHub wasn't asked or
    /// didn't say.
    #[serde(skip)]
    pub origin: Option<crate::issue_text::Origin>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhUser {
    pub login: String,
}

/// v1.62.0 (Phase 6): a pull request surfaced by the read-only "PRs awaiting
/// your review" widget. `author` is flattened to its login for the FE.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GhPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    /// QoL 14.2 (F7): when the pull request was opened (unix ms), so the
    /// Inbox row says how old it is instead of always "now". GitHub's list
    /// doesn't say when the review was asked; `None` when unreadable.
    pub created_at: Option<i64>,
}

/// Raw shape `gh pr list --json …` returns (author is a nested object).
#[derive(Debug, Clone, Deserialize)]
struct GhPrRaw {
    number: u64,
    title: String,
    url: String,
    #[serde(default)]
    author: Option<GhUser>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
}

/// An RFC 3339 time from `gh --json` as unix ms; `None` when unreadable.
pub(crate) fn rfc3339_ms(text: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text?.trim())
        .ok()
        .map(|t| t.timestamp_millis())
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhLabel {
    pub name: String,
}

/// v1.86.0 (team tier cycle 3): an open PR with its changed file paths —
/// the teammate half of the pre-merge overlap warning.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhPrWithFiles {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub head_ref_name: String,
    #[serde(default)]
    pub files: Vec<GhPrFile>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhPrFile {
    pub path: String,
}

/// Open PRs in `repo` with their changed files. Caveat: gh's `files`
/// field caps at 100 entries per PR — fine for an advisory warning.
pub fn pr_list_open_with_files(repo: &str) -> Result<Vec<GhPrWithFiles>, String> {
    let out = run_gh(&[
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title,headRefName,files",
    ])?;
    serde_json::from_str(&out).map_err(|e| format!("parse `gh pr list --json files`: {e}"))
}

/// GH #204: how long one GitHub API call through `gh` may take — `gh api`,
/// `gh issue …`, `gh pr list`, `gh label …`, `gh repo create`. Each is one
/// small HTTPS request (two for a paginated list) that answers in a second or
/// two; 30 s is well past a slow network yet short enough that a stalled `gh`
/// inside the claim gate releases `CARD_START_LOCK` (and with it every
/// queued Start build, Trash and worktree delete) in half a minute. It sits
/// next to the 20 s `git fetch` bound and under Ship's 60 s
/// ([`crate::shared_config::GH_TIMEOUT`]) for a PR create.
pub const GH_API_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// GH #204 review 1: `gh issue create`. One request too, but one stopped at
/// its bound may have been made anyway, so it gets twice the room before Ply
/// gives up on it ([`issue_create`] then looks for the issue before creating
/// another). No `CARD_START_LOCK` is held across it. It runs on a Sync worker,
/// and (review 2) on the main thread for a card just created on the board —
/// there it is the only wait: the lookup is left to Sync. `gh label create
/// --force` is idempotent and stays at [`GH_API_TIMEOUT`].
pub const GH_CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// GH #204 review 1: `gh issue list` pages through a GraphQL request per
/// hundred issues, with every issue's body (five for `--limit 500`; up to
/// twenty for a board of [`OPEN_ISSUES_LIMIT`] open issues) — the board pull,
/// not a single round trip.
pub const GH_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// GH #204: `gh repo clone` transfers the whole repository, so its bound is
/// the size of a large clone on a slow link, not a request's round trip.
/// Nothing holds `CARD_START_LOCK` across a clone.
pub const GH_CLONE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

/// The start of every timeout error a bounded `gh` call returns, so a caller
/// can tell "GitHub didn't answer" from GitHub's own refusal.
pub const GH_TIMED_OUT: &str = "GitHub didn't answer in time";

/// The bound for one `gh` call, by what it does.
pub fn gh_timeout_for(args: &[&str]) -> std::time::Duration {
    match args {
        ["repo", "clone", ..] => GH_CLONE_TIMEOUT,
        ["issue", "list", ..] => GH_LIST_TIMEOUT,
        ["issue", "create", ..] => GH_CREATE_TIMEOUT,
        _ => GH_API_TIMEOUT,
    }
}

/// True when `err` is a bounded `gh` call that was stopped at its timeout.
pub fn is_gh_timeout(err: &str) -> bool {
    err.starts_with(GH_TIMED_OUT)
}

/// GH #204: run `gh` (the doctor-resolved path, or a stub in tests) bounded by
/// `timeout`, in its own process group registered for exit cleanup, like a
/// `git fetch`: on timeout the whole group is killed and the error says so
/// plainly. The exit status and output are the caller's to read.
pub(crate) fn gh_output(
    gh: &str,
    cwd: Option<&std::path::Path>,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    gh_output_fed(gh, cwd, args, timeout, None)
}

/// R12 (Challenger): [`gh_output`] with `input` on gh's stdin — a pull
/// request's body as `--body-file -`, never an argument (Windows caps a
/// command line at 32,767 characters).
pub(crate) fn gh_output_with_stdin(
    gh: &str,
    cwd: Option<&std::path::Path>,
    args: &[&str],
    timeout: std::time::Duration,
    input: &str,
) -> Result<std::process::Output, String> {
    use std::io::{Seek, Write};
    let mut file = tempfile::tempfile().map_err(|e| format!("couldn't hand gh its input: {e}"))?;
    file.write_all(input.as_bytes())
        .and_then(|()| file.rewind())
        .map_err(|e| format!("couldn't hand gh its input: {e}"))?;
    gh_output_fed(gh, cwd, args, timeout, Some(file))
}

fn gh_output_fed(
    gh: &str,
    cwd: Option<&std::path::Path>,
    args: &[&str],
    timeout: std::time::Duration,
    stdin: Option<std::fs::File>,
) -> Result<std::process::Output, String> {
    use crate::worktrees::BoundedFailure;
    let mut cmd = crate::platform::new_command(gh);
    // OB-7b: the workspace's chosen GitHub account when the caller's scope
    // has one (its output comes back redacted, `run_bounded_output`).
    crate::github_account::apply_to_gh(&mut cmd)?;
    // Never an interactive prompt: there is no terminal to answer it.
    cmd.args(args).env("GH_PROMPT_DISABLED", "1");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let verb = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let ran = match stdin {
        Some(file) => crate::worktrees::run_bounded_output_with_stdin(&mut cmd, timeout, file),
        None => crate::worktrees::run_bounded_output(&mut cmd, timeout),
    };
    ran.map_err(|failure| match failure {
        BoundedFailure::Spawn(e) => format!("couldn't run GitHub CLI (`gh`): {e}"),
        BoundedFailure::Quitting => "couldn't run GitHub CLI: Plyloft is quitting".to_string(),
        BoundedFailure::TimedOut => format!(
            "{GH_TIMED_OUT}: `gh {verb}` was stopped after {}s. Check the connection and try again.",
            timeout.as_secs()
        ),
        BoundedFailure::Truncated => format!(
            "couldn't read GitHub CLI's whole answer (`gh {verb}`); try again"
        ),
    })
}

/// SL-2: [`gh_output`] for a long answer whose end is what matters (a
/// failed CI log): only its last `max_tail` bytes are ever held; the number
/// of bytes dropped before them comes back beside it.
pub(crate) fn gh_output_tail(
    gh: &str,
    cwd: Option<&std::path::Path>,
    args: &[&str],
    timeout: std::time::Duration,
    max_tail: usize,
) -> Result<(std::process::Output, usize), String> {
    use crate::worktrees::BoundedFailure;
    let mut cmd = crate::platform::new_command(gh);
    crate::github_account::apply_to_gh(&mut cmd)?;
    cmd.args(args).env("GH_PROMPT_DISABLED", "1");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let verb = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    crate::worktrees::run_bounded_output_tail(&mut cmd, timeout, max_tail).map_err(|failure| match failure {
        BoundedFailure::Spawn(e) => format!("couldn't run GitHub CLI (`gh`): {e}"),
        BoundedFailure::Quitting => "couldn't run GitHub CLI: Plyloft is quitting".to_string(),
        BoundedFailure::TimedOut => format!(
            "{GH_TIMED_OUT}: `gh {verb}` was stopped after {}s. Check the connection and try again.",
            timeout.as_secs()
        ),
        BoundedFailure::Truncated => format!("couldn't read GitHub CLI's whole answer (`gh {verb}`); try again"),
    })
}

/// [`gh_output`] read the way every GitHub wrapper here reads `gh`: trimmed
/// stdout on success, trimmed stderr as the Err.
fn run_gh_bounded(
    gh: &str,
    cwd: Option<&std::path::Path>,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String, String> {
    let out = gh_output(gh, cwd, args, timeout)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 1.173.0 (C2): [`run_gh`] with `input` on gh's stdin (`--body-file -`):
/// a body is never an argument (Windows caps a command line at 32,767
/// characters).
fn run_gh_with_input(args: &[&str], input: &str) -> Result<String, String> {
    let timeout = gh_timeout_for(args);
    #[cfg(not(test))]
    {
        let gh = crate::doctor::require("gh")?;
        let out = gh_output_with_stdin(&gh, None, args, timeout, input)?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
    #[cfg(test)]
    {
        TEST_GH_STDIN.with(|fed| fed.borrow_mut().push(input.to_string()));
        run_gh_within(args, timeout)
    }
}

/// What this thread's stdin-fed `gh` calls were handed since the last take.
#[cfg(test)]
pub(crate) fn take_test_gh_stdin() -> Vec<String> {
    TEST_GH_STDIN.with(|fed| std::mem::take(&mut *fed.borrow_mut()))
}

/// Run `gh <args>`; trimmed stdout on success, trimmed stderr as the Err.
/// Bounded by [`gh_timeout_for`] (GH #204).
fn run_gh(args: &[&str]) -> Result<String, String> {
    run_gh_within(args, gh_timeout_for(args))
}

/// [`run_gh`] with an explicit bound.
#[cfg(not(test))]
fn run_gh_within(args: &[&str], timeout: std::time::Duration) -> Result<String, String> {
    let gh = crate::doctor::require("gh")?;
    run_gh_bounded(&gh, None, args, timeout)
}

/// Tests fail closed unless they explicitly arm deterministic responses. This
/// prevents a future test from reaching a developer's live `gh` credentials.
/// GH #204: a test may instead arm a stub program, which then runs through
/// the production bounded runner.
#[cfg(test)]
fn run_gh_within(args: &[&str], timeout: std::time::Duration) -> Result<String, String> {
    record_test_gh_invocation(args);
    TEST_GH_TIMEOUTS.with(|bounds| bounds.borrow_mut().push(timeout));
    if let Some((program, cwd, timeout)) = TEST_GH_STUB.with(|stub| stub.borrow().clone()) {
        return run_gh_bounded(&program, Some(&cwd), args, timeout);
    }
    TEST_GH_RESPONSES.with(|responses| match responses.borrow_mut().as_mut() {
        Some(queued) => queued.pop_front().unwrap_or_else(|| {
            Err(format!(
                "unexpected test gh invocation: gh {}",
                args.join(" ")
            ))
        }),
        None => Err(format!(
            "test gh seam is not armed: gh {}",
            args.join(" ")
        )),
    })
}

/// The bounds this thread's `gh` calls were given since the last take.
#[cfg(test)]
pub(crate) fn take_test_gh_timeouts() -> Vec<std::time::Duration> {
    TEST_GH_TIMEOUTS.with(|bounds| std::mem::take(&mut *bounds.borrow_mut()))
}

/// GH #204: route this thread's `gh` calls to `program` run in `cwd`, bounded
/// by `timeout`; `None` restores the queued responses.
#[cfg(test)]
pub(crate) fn set_test_gh_stub(stub: Option<(String, std::path::PathBuf, std::time::Duration)>) {
    TEST_GH_STUB.with(|slot| *slot.borrow_mut() = stub);
}

#[cfg(test)]
pub(crate) fn take_test_gh_invocations() -> Vec<Vec<String>> {
    TEST_GH_INVOCATIONS.with(|calls| std::mem::take(&mut *calls.borrow_mut()))
}

#[cfg(test)]
pub(crate) fn record_test_gh_invocation(args: &[&str]) {
    TEST_GH_INVOCATIONS.with(|calls| {
        calls
            .borrow_mut()
            .push(args.iter().map(|arg| (*arg).to_string()).collect());
    });
}

#[cfg(test)]
pub(crate) fn set_test_gh_responses(responses: Vec<Result<String, String>>) {
    TEST_GH_RESPONSES.with(|queued| {
        *queued.borrow_mut() = Some(responses.into());
    });
}

/// Serializes every test that arms the `gh` seam or touches the
/// process-global login cache — including the team-module tests, which go
/// through the same two.
#[cfg(test)]
static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub(crate) fn test_serial_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
pub(crate) fn clear_test_gh_responses() {
    TEST_GH_RESPONSES.with(|queued| {
        *queued.borrow_mut() = None;
    });
}

/// Cache for [`current_login`]. The claim gate reads the login on every
/// move, so the first success is reused instead of a `gh api user`
/// round-trip per claim. v1.105.0 (milestone B, P0-5): the cache expires
/// after [`LOGIN_CACHE_TTL`] instead of living for the whole process. A
/// `gh auth switch` (the two-account dogfood) used to leave a stale login
/// for the rest of the session, so claims were checked against the wrong
/// person. A failure (e.g. offline) is still never cached.
static LOGIN_CACHE: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);

/// How long a resolved login stays authoritative. Bounded staleness after an
/// account switch; still one `gh api user` per minute at most under load.
const LOGIN_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// The authenticated user's GitHub login — for claim checks (assignees are
/// logins, not emails). Cached for [`LOGIN_CACHE_TTL`] after a success.
pub fn current_login() -> Result<String, String> {
    current_login_at(std::time::Instant::now())
}

fn current_login_at(now: std::time::Instant) -> Result<String, String> {
    // OB-7b: inside a workspace's scope with a chosen account, that account
    // is who the calls act as — never the cached active login.
    if let Some(login) = crate::github_account::scoped_login() {
        return login;
    }
    if let Ok(guard) = LOGIN_CACHE.lock() {
        if let Some((login, at)) = guard.as_ref() {
            if now.duration_since(*at) < LOGIN_CACHE_TTL {
                return Ok(login.clone());
            }
        }
    }
    let login = run_gh(&["api", "user", "--jq", ".login"])?;
    if let Ok(mut guard) = LOGIN_CACHE.lock() {
        *guard = Some((login.clone(), now));
    }
    Ok(login)
}

/// Launch T2: a GitHub account's numeric id (the Plyloft server keys seats by
/// it; logins can change), read as the caller's gh account. The login is
/// checked before it is joined into the path.
pub fn user_id(login: &str) -> Result<String, String> {
    let login = login.trim();
    if !crate::team_admin::is_valid_login(login) {
        return Err(format!("{login:?} is not a GitHub login."));
    }
    let id = run_gh(&["api", &format!("users/{login}"), "--jq", ".id"])?;
    let id = id.trim().to_string();
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("GitHub didn't give a numeric id for {login}."));
    }
    Ok(id)
}

/// OB-6: `gh api user` as JSON (`id`, `login`, `name`, `email`), for Setup's
/// identity prefill. Bounded like every `gh` call; an error when gh is
/// missing or not signed in.
pub fn api_user_json() -> Result<String, String> {
    run_gh(&["api", "user"])
}

/// What GitHub says this account may do with a repo.
///
/// `push` is an `Option` on purpose: a token shape that answers with no
/// `permissions` block tells us nothing about writing, and that is not the
/// same as "no". v1.117.0 offers Promote on an unknown answer (GitHub is the
/// enforcement) and refuses it only on a measured `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoAccess {
    pub pull: bool,
    pub push: Option<bool>,
}

impl RepoAccess {
    /// GitHub answered and refused the repo outright.
    pub fn denied() -> Self {
        Self {
            pull: false,
            push: Some(false),
        }
    }
}

/// v1.114.0 (team sharing rung 1): can this GitHub account read `slug`?
/// Half of the membership rule (`team::evaluate_membership`); the other
/// half is the team manifest.
///
/// v1.117.0 (rung 4) reads write access in the **same** call, because
/// sharing into the team library needs it (`DESIGN.md`, "Permissions") and a
/// second round trip would answer the same question twice.
///
/// `Ok(denied())` means GitHub answered and said no (404 for a private repo
/// you cannot see, 403 for one you are blocked from). Anything else —
/// offline, `gh` not installed, a rate limit — stays an `Err`, because
/// "we could not ask" must never render as "you are not in the team".
pub fn repo_access(slug: &str) -> Result<RepoAccess, String> {
    let endpoint = format!("repos/{slug}");
    match run_gh(&["api", &endpoint, "--jq", ".permissions.pull, .permissions.push"]) {
        Ok(out) => {
            let mut lines = out.lines().map(str::trim);
            let pull = lines.next().unwrap_or_default();
            let push = lines.next().unwrap_or_default();
            Ok(RepoAccess {
                // A repo you can see but whose `permissions` block is absent
                // (some token shapes) is still readable — you just read it.
                pull: pull != "false",
                push: match push {
                    "true" => Some(true),
                    "false" => Some(false),
                    // `null`, or no second line at all: GitHub answered
                    // without saying. Not a refusal.
                    _ => None,
                },
            })
        }
        Err(e) => match classify_gh_error(&e) {
            GhErrorKind::Denied => Ok(RepoAccess::denied()),
            GhErrorKind::RateLimited => Err(format!(
                "GitHub is rate-limiting this account; try again in a few minutes ({e})"
            )),
            GhErrorKind::Unreachable => Err(e),
        },
    }
}

/// What a failed `gh` call actually means for an access question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhErrorKind {
    /// GitHub answered and refused: this account cannot see the repo.
    Denied,
    /// GitHub answered, but only to throttle us. It says nothing about
    /// access — telling a member to go ask for an invitation because the
    /// API was busy would be a lie.
    RateLimited,
    /// We never got an answer: offline, no `gh`, a broken token.
    Unreachable,
}

/// Classify a `gh` error. A 403 is the ambiguous one — GitHub uses it both
/// for "you may not" and for "you are asking too often" — so throttling is
/// matched first, on the wording and headers GitHub uses for it.
pub fn classify_gh_error(err: &str) -> GhErrorKind {
    let lower = err.to_ascii_lowercase();
    let throttled = lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("ratelimit-remaining: 0")
        || lower.contains("x-ratelimit-remaining: 0")
        // The secondary limit GitHub applies to bursts.
        || lower.contains("abuse detection")
        || lower.contains("retry-after");
    if throttled {
        return GhErrorKind::RateLimited;
    }
    if lower.contains("http 404")
        || lower.contains("http 403")
        || lower.contains("not found")
        || lower.contains("must have admin rights")
    {
        return GhErrorKind::Denied;
    }
    GhErrorKind::Unreachable
}

/// `gh repo clone <slug> <dest>` — the member's own `gh` auth decides
/// whether the clone is allowed, exactly as for a workspace repo.
pub fn repo_clone(slug: &str, dest: &std::path::Path) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().to_string();
    run_gh(&["repo", "clone", slug, &dest_str]).map(|_| ())
}

/// [`repo_clone`] for a library clone (the team repo): `git clone -c
/// core.longpaths=true`, so the clone's own config carries it from the first
/// checkout on (H1 Windows walk; [`crate::team::LIBRARY_GIT_CONFIG`]).
pub fn library_repo_clone(slug: &str, dest: &std::path::Path) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().to_string();
    let mut args = vec!["repo", "clone", slug, &dest_str, "--"];
    args.extend(crate::team::LIBRARY_GIT_CONFIG);
    run_gh(&args).map(|_| ())
}

// ── Owner-side team administration (v1.118.0 — team sharing rung 5) ──
//
// Creating the team repo, granting people access to it and to the team
// workspaces, and finding repositories that already look like Ply
// workspaces. Every one of these is the *owner* acting on GitHub, so each
// wrapper says exactly what GitHub answered and never turns "could not ask"
// into "no" — the rule `repo_access` established in rung 1.

/// What GitHub says a login may already do with a repo, from
/// `repos/{slug}/collaborators/{login}/permission`. GitHub's `.permission`
/// is the coarse field on purpose: `maintain` answers `write` and `triage`
/// answers `read`, which is exactly the granularity an invite plan needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CollaboratorAccess {
    /// GitHub answered: not a collaborator at all.
    None,
    /// Can read, cannot push.
    Read,
    /// Can push (`write` or `maintain`).
    Write,
    Admin,
    /// GitHub answered that no account has this login: a person to refuse,
    /// not a question to ask again.
    NoSuchAccount,
    /// GitHub could not be asked, or answered something unrecognised. Never
    /// a refusal and never a grant — the plan shows it as "unknown" and
    /// still offers the invite, because an idempotent PUT is the safe move.
    Unknown,
}

impl CollaboratorAccess {
    fn from_permission(raw: &str) -> Self {
        match raw.trim() {
            "admin" => Self::Admin,
            "write" | "maintain" => Self::Write,
            "read" | "triage" => Self::Read,
            "none" => Self::None,
            _ => Self::Unknown,
        }
    }

    /// Does this already satisfy a `push` grant?
    pub fn can_push(&self) -> bool {
        matches!(self, Self::Write | Self::Admin)
    }

    /// The word the confirmation screen shows.
    pub fn label(&self) -> &'static str {
        match self {
            Self::None => "no access",
            Self::Read => "read",
            Self::Write => "write",
            Self::Admin => "admin",
            Self::NoSuchAccount => "no account",
            Self::Unknown => "unknown",
        }
    }
}

/// `gh repo create <slug> --private`. The description matches the one
/// `scripts/team-init.sh` writes, so a team created either way looks the
/// same on GitHub.
pub fn repo_create_private(slug: &str, description: &str) -> Result<(), String> {
    run_gh(&["repo", "create", slug, "--private", "--description", description]).map(|_| ())
}

/// Does `slug` already exist *as far as this account can see*?
///
/// A private repo owned by someone else answers 404, so `Ok(false)` is
/// "nothing here that you can see" rather than "the name is free". That is
/// why creating still goes ahead and lets `gh repo create` be the authority:
/// it fails with GitHub's own "already exists" message, which is the one the
/// owner needs to read.
pub fn repo_exists(slug: &str) -> Result<bool, String> {
    let endpoint = format!("repos/{slug}");
    match run_gh(&["api", &endpoint, "--jq", ".full_name"]) {
        Ok(_) => Ok(true),
        Err(e) => match classify_gh_error(&e) {
            GhErrorKind::Denied => Ok(false),
            GhErrorKind::RateLimited => Err(format!(
                "GitHub is rate-limiting this account; try again in a few minutes ({e})"
            )),
            GhErrorKind::Unreachable => Err(e),
        },
    }
}

/// What a Create-team resume needs to know about a repository that already
/// exists: is it private, and is it empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteRepoState {
    pub private: bool,
    /// No commits at all — the state `gh repo create` leaves behind, and the
    /// state a creation that died before its push leaves it in.
    pub empty: bool,
    /// The repository's `team.json`, raw, when it has history and carries
    /// one. `None` when there is no such file (a 404). Read only to decide
    /// whether this is *already* the owner's finished team — a push GitHub
    /// accepted whose acknowledgement never reached Ply.
    pub manifest: Option<String>,
}

/// Ask GitHub whether `slug` is private and whether it has any commits.
///
/// Emptiness is read from the commit list: GitHub documents that listing the
/// commits of a repository with none answers **409 "Git Repository is
/// empty."**, and a repository with history answers a non-empty list
/// (measured: `1` for `per_page=1`). Only that exact 409 reads as empty.
/// Anything else stays an `Err`, because "could not tell" must never be the
/// reason Ply writes into somebody's repository.
pub fn repo_resume_state(slug: &str) -> Result<RemoteRepoState, String> {
    let private = run_gh(&["api", &format!("repos/{slug}"), "--jq", ".private"])?;
    let private = match private.trim() {
        "true" => true,
        "false" => false,
        other => return Err(format!("GitHub did not say whether {slug} is private ({other:?})")),
    };
    let endpoint = format!("repos/{slug}/commits?per_page=1");
    let empty = match run_gh(&["api", &endpoint, "--jq", "length"]) {
        Ok(count) => count.trim() == "0",
        Err(e) if is_empty_repository_error(&e) => true,
        Err(e) => return Err(e),
    };
    let manifest = if empty {
        None
    } else {
        // Measured: the raw media type returns the file's own bytes, and a
        // file that is not there answers 404.
        let file = format!("repos/{slug}/contents/team.json");
        match run_gh(&["api", "-H", "Accept: application/vnd.github.raw", &file]) {
            Ok(text) => Some(text),
            Err(e) => match classify_gh_error(&e) {
                GhErrorKind::Denied => None,
                _ => return Err(e),
            },
        }
    };
    Ok(RemoteRepoState { private, empty, manifest })
}

/// GitHub's documented answer to listing the commits of an empty repository.
pub fn is_empty_repository_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("http 409") && lower.contains("empty")
        || lower.contains("git repository is empty")
}

/// GitHub's own words when the permission read names a login nobody has:
/// `gh: octo-nobody is not a user (HTTP 404)`. A plain 404 (a repository this
/// account can't see) isn't one.
pub fn is_not_a_user(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("is not a user") && lower.contains("http 404")
}

/// What `login` may already do with `slug`.
///
/// The endpoint needs push access on `slug` to answer at all, so a refusal
/// is [`CollaboratorAccess::Unknown`] rather than "no access": the owner
/// asking about their own repo gets a real answer, and anyone else gets an
/// honest shrug instead of a plan built on a permission error.
pub fn collaborator_access(slug: &str, login: &str) -> Result<CollaboratorAccess, String> {
    let endpoint = format!("repos/{slug}/collaborators/{login}/permission");
    match run_gh(&["api", &endpoint, "--jq", ".permission"]) {
        Ok(out) => Ok(CollaboratorAccess::from_permission(&out)),
        Err(e) if is_not_a_user(&e) => Ok(CollaboratorAccess::NoSuchAccount),
        Err(e) => match classify_gh_error(&e) {
            GhErrorKind::Denied => Ok(CollaboratorAccess::Unknown),
            GhErrorKind::RateLimited => Err(format!(
                "GitHub is rate-limiting this account; try again in a few minutes ({e})"
            )),
            GhErrorKind::Unreachable => Err(e),
        },
    }
}

/// Invite `login` to `slug` at `permission`. `Ok(true)` when GitHub created
/// an invitation, `Ok(false)` when it answered 204 — the person was already
/// a collaborator (or an org member the repo already covers), which is a
/// success, not a failure, and is what makes a retry of a half-finished
/// invite safe.
pub fn repo_invite_collaborator(
    slug: &str,
    login: &str,
    permission: &str,
) -> Result<bool, String> {
    let endpoint = format!("repos/{slug}/collaborators/{login}");
    let permission_arg = format!("permission={permission}");
    run_gh(&["api", "-X", "PUT", &endpoint, "-f", &permission_arg])
        .map(|out| !out.trim().is_empty())
}

// ── N14 items 1, 3 and 9: invitations as a state, Remove from team ──

/// How many entries one read of a repository's invitations or collaborators
/// asks for: one page, GitHub's largest. A team is a handful of people; a
/// full page is said as possibly incomplete by the caller, never read past.
pub const TEAM_LIST_PAGE: usize = 100;

/// One pending invitation to a repository, from `repos/:o/:r/invitations`
/// (readable by the repository's admins only).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInvitation {
    pub id: u64,
    /// The invitee's login; empty for an invitation sent to an email.
    #[serde(default)]
    pub login: String,
    /// RFC 3339, as GitHub gives it.
    #[serde(default)]
    pub created_at: String,
    /// GitHub's own word: the invitation can no longer be accepted.
    #[serde(default)]
    pub expired: bool,
}

/// Pure: [`repo_invitations`]' `--jq` answer.
pub fn parse_repo_invitations(json: &str) -> Result<Vec<RepoInvitation>, String> {
    serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's list of invitations: {e}"))
}

/// The pending invitations to `slug`, one page ([`TEAM_LIST_PAGE`]).
pub fn repo_invitations(slug: &str) -> Result<Vec<RepoInvitation>, String> {
    let endpoint = format!("repos/{slug}/invitations?per_page={TEAM_LIST_PAGE}");
    let json = run_gh(&[
        "api",
        &endpoint,
        "--jq",
        "[.[] | {id: .id, login: (.invitee.login // \"\"), createdAt: (.created_at // \"\"), \
         expired: (.expired // false)}]",
    ])?;
    parse_repo_invitations(&json)
}

/// Withdraw one invitation to `slug` (`DELETE …/invitations/:id`, 204).
pub fn repo_cancel_invitation(slug: &str, id: u64) -> Result<(), String> {
    let endpoint = format!("repos/{slug}/invitations/{id}");
    run_gh(&["api", "-X", "DELETE", &endpoint]).map(|_| ())
}

/// Pure: [`repo_collaborator_logins`]' `--jq` answer.
pub fn parse_logins(json: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's list of collaborators: {e}"))
}

/// Who can reach `slug` (collaborators, organisation members included —
/// GitHub's default `affiliation=all`), one page ([`TEAM_LIST_PAGE`]).
pub fn repo_collaborator_logins(slug: &str) -> Result<Vec<String>, String> {
    let endpoint = format!("repos/{slug}/collaborators?per_page={TEAM_LIST_PAGE}");
    let json = run_gh(&["api", &endpoint, "--jq", "[.[].login]"])?;
    parse_logins(&json)
}

/// Who owns a repository and whether it is private (`repos/:o/:r`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoOwnerFacts {
    /// The owner is an organisation (not a user).
    pub organisation: bool,
    pub private: bool,
}

/// Pure: [`repo_owner_facts`]' `--jq` answer (`"<owner type> <private>"`).
pub fn parse_repo_owner_facts(out: &str) -> Result<RepoOwnerFacts, String> {
    let mut words = out.split_whitespace();
    match (words.next(), words.next()) {
        (Some(kind), Some(private @ ("true" | "false"))) => Ok(RepoOwnerFacts {
            organisation: kind.eq_ignore_ascii_case("Organization"),
            private: private == "true",
        }),
        _ => Err(format!("GitHub didn't say who owns the repository ({out:?})")),
    }
}

/// N14 review: whether an organisation owns `slug`, and whether it is private.
pub fn repo_owner_facts(slug: &str) -> Result<RepoOwnerFacts, String> {
    let endpoint = format!("repos/{slug}");
    let out = run_gh(&["api", &endpoint, "--jq", ".owner.type + \" \" + (.private | tostring)"])?;
    parse_repo_owner_facts(&out)
}

/// Take `login` off `slug`'s collaborators (`DELETE …/collaborators/:login`,
/// 204 — also when they weren't one). Access through an organisation team
/// is not a collaborator's and stays; the caller checks afterwards.
pub fn repo_remove_collaborator(slug: &str, login: &str) -> Result<(), String> {
    let endpoint = format!("repos/{slug}/collaborators/{login}");
    run_gh(&["api", "-X", "DELETE", &endpoint]).map(|_| ())
}

/// One repository this account can reach, as assisted discovery sees it.
#[derive(Debug, Clone, Deserialize)]
pub struct GhRepoSummary {
    #[serde(rename = "nameWithOwner")]
    pub name_with_owner: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "isArchived")]
    pub is_archived: bool,
    #[serde(default, rename = "isPrivate")]
    pub is_private: bool,
}

/// The repositories this account can reach, most recently pushed first.
///
/// `user/repos` rather than `gh repo list`, because the owner's team
/// workspaces are routinely repos they collaborate on or reach through an
/// organisation, and `gh repo list` shows only the ones they own. Bounded
/// deliberately at one page: discovery probes each result for a marker file,
/// and an unbounded scan would spend hundreds of round trips on repositories
/// nobody was looking for. The panel says how many were scanned.
pub fn repos_accessible(limit: usize) -> Result<Vec<GhRepoSummary>, String> {
    let endpoint = format!(
        "user/repos?per_page={}&sort=pushed&affiliation=owner,collaborator,organization_member",
        limit.clamp(1, 100)
    );
    let json = run_gh(&[
        "api",
        &endpoint,
        "--jq",
        "[.[] | {nameWithOwner: .full_name, description: .description, \
         isArchived: .archived, isPrivate: .private}]",
    ])?;
    serde_json::from_str(&json).map_err(|e| format!("parse `gh api user/repos`: {e}"))
}

/// The text of `path` on `slug`'s default branch, read through the API (no
/// clone). `Ok(None)` when GitHub refuses or has no such file — the caller
/// asks about access separately; `Err` when GitHub couldn't be asked.
/// Skills hub H2 (Windows walk): an ex-member's read asks for `team.json`
/// alone instead of cloning the whole library again to find it.
pub fn repo_file_text(slug: &str, path: &str) -> Result<Option<String>, String> {
    let endpoint = format!("repos/{slug}/contents/{path}");
    match run_gh(&["api", "-H", "Accept: application/vnd.github.raw", &endpoint]) {
        Ok(text) => Ok(Some(text)),
        Err(e) => match classify_gh_error(&e) {
            GhErrorKind::Denied => Ok(None),
            _ => Err(e),
        },
    }
}

/// Does `slug` carry `path` on its default branch? A 404 is a real "no" here
/// — the repo came out of [`repos_accessible`], so this account can see it.
pub fn repo_has_file(slug: &str, path: &str) -> Result<bool, String> {
    let endpoint = format!("repos/{slug}/contents/{path}");
    match run_gh(&["api", &endpoint, "--jq", ".sha"]) {
        Ok(out) => Ok(!out.trim().is_empty()),
        Err(e) => match classify_gh_error(&e) {
            GhErrorKind::Denied => Ok(false),
            GhErrorKind::RateLimited => Err(format!(
                "GitHub is rate-limiting this account; try again in a few minutes ({e})"
            )),
            GhErrorKind::Unreachable => Err(e),
        },
    }
}

/// How many `gh` processes discovery runs at once. One `gh api` per repo is
/// the only way to ask whether a file exists, and a hundred of them in
/// sequence is a minute of staring at a spinner.
pub(crate) const PROBE_LANES: usize = 8;

/// Ask [`repo_has_file`] for every slug, a few at a time.
///
/// The answer per repo is a `Result` on purpose: a probe that could not be
/// answered must not join the "no marker" pile, or a dropped connection
/// halfway through a scan would quietly report a team's repositories as
/// having nothing to offer.
pub fn repos_carrying(slugs: &[String], path: &str) -> Vec<(String, Result<bool, String>)> {
    if slugs.is_empty() {
        return Vec::new();
    }
    let next = std::sync::atomic::AtomicUsize::new(0);
    let out: std::sync::Mutex<Vec<(String, Result<bool, String>)>> =
        std::sync::Mutex::new(Vec::with_capacity(slugs.len()));
    // N14 (OB-7b): a spawned thread starts as gh's active account, so each
    // lane opens the caller's account (the team's, for discovery).
    let account = crate::github_account::handoff();
    let (next, out) = (&next, &out);
    std::thread::scope(|scope| {
        for _ in 0..PROBE_LANES.min(slugs.len()) {
            let account = account.clone();
            scope.spawn(move || {
                let _scope = account.enter();
                loop {
                    let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(slug) = slugs.get(index) else { return };
                    let answer = repo_has_file(slug, path);
                    out.lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .push((slug.clone(), answer));
                }
            });
        }
    });
    let answers = std::mem::take(&mut *out.lock().unwrap_or_else(|e| e.into_inner()));
    answers
}

/// Forget the cached login. Called when the app learns the GitHub identity
/// may have changed (a failed claim, a Settings refresh) and by tests.
pub fn invalidate_login_cache() {
    if let Ok(mut guard) = LOGIN_CACHE.lock() {
        *guard = None;
    }
}

/// TM-5 (1.175.0): how many open issues one board read asks for. Every open
/// issue is a card, so this is the largest board Plyloft reads whole; a read
/// that comes back this long may have been cut (`github_sync::read_issues`).
pub const OPEN_ISSUES_LIMIT: usize = 2000;

/// TM-5: how many closed issues one board read asks for, newest first. Closed
/// issues matter only to the cards a board already has; one further back is
/// looked up by its number when a card needs it (`github_sync::read_issues`).
pub const CLOSED_ISSUES_LIMIT: usize = 500;

/// List the issues of `repo` in one `state` ("open" or "closed"), at most
/// `limit` of them, newest first, with the fields kanban sync reconciles
/// against.
///
/// TM-5: it used to be one read of `--state all --limit 500`, so in a
/// repository with more than 500 issues, closed ones included, the older
/// open issues never arrived.
pub fn issue_list(repo: &str, state: &str, limit: usize) -> Result<Vec<GhIssue>, String> {
    let limit = limit.to_string();
    let json = run_gh(&[
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        state,
        "--limit",
        &limit,
        "--json",
        "number,title,body,assignees,labels,state,stateReason,updatedAt,author,createdAt",
    ])?;
    serde_json::from_str(&json).map_err(|e| format!("gh issue list: bad JSON: {e}"))
}

/// TM-5: whether `err`, from a read of one issue by its number
/// ([`issue_view`]), is GitHub saying the repository has no such issue
/// ("Could not resolve to an issue or pull request with the number of 42").
/// Not a repository GitHub can't resolve, and not a network failure: those
/// say nothing about the issue.
pub fn is_issue_not_found(err: &str) -> bool {
    err.to_ascii_lowercase().contains("could not resolve to an issue")
}

/// Fetch a single issue with the same fields as [`issue_list`]. Used by the
/// claim gate, which must read the issue's **current** assignees live (a stale
/// local cache can't authorize a claim).
pub fn issue_view(repo: &str, number: u64) -> Result<GhIssue, String> {
    let n = number.to_string();
    let json = run_gh(&[
        "issue",
        "view",
        &n,
        "--repo",
        repo,
        "--json",
        "number,title,body,assignees,labels,state,stateReason,updatedAt,author,createdAt",
    ])?;
    serde_json::from_str(&json).map_err(|e| format!("gh issue view: bad JSON: {e}"))
}

/// 1.175.0 (D1): one assignment on an issue's timeline — `login` was put
/// on it (`assigned`) or taken off, at `at_ms`. GitHub gives the second.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub login: String,
    pub at_ms: i64,
    pub assigned: bool,
}

/// The newest assignments of an issue; two people who press Start build
/// within seconds are both in them.
const ASSIGNMENTS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(last:40,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT]){nodes{__typename ... on AssignedEvent{createdAt assignee{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login}}} ... on UnassignedEvent{createdAt assignee{__typename ... on User{login} ... on Bot{login} ... on Mannequin{login}}}}}}}}";

/// The GraphQL arguments naming `repo`'s issue `number`.
fn issue_query_args(repo: &str, number: u64) -> Result<[String; 3], String> {
    let (owner, name) = repo
        .split_once('/')
        .filter(|(o, n)| !o.is_empty() && !n.is_empty())
        .ok_or_else(|| format!("'{repo}' is not an owner/name repository"))?;
    Ok([format!("owner={owner}"), format!("name={name}"), format!("number={number}")])
}

/// 1.175.0 (D1): when each name was put on `repo`'s issue `number`, oldest
/// first — `gh issue view --json assignees` gives the names, not the times.
/// One bounded GraphQL read; nothing is written.
pub fn issue_assignments(repo: &str, number: u64) -> Result<Vec<Assignment>, String> {
    let [owner, name, number] = issue_query_args(repo, number)?;
    let query = format!("query={ASSIGNMENTS_QUERY}");
    let json = run_gh(&["api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number])?;
    assignments_from_issue(&json)
}

/// Pure: the assignments of the answer, in GitHub's order (oldest first).
/// An event without a login or a time GitHub can't be read from is left out.
pub fn assignments_from_issue(json: &str) -> Result<Vec<Assignment>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let nodes = v["data"]["repository"]["issue"]["timelineItems"]["nodes"]
        .as_array()
        .ok_or_else(|| "gh api graphql: the issue's assignments are missing from the answer".to_string())?;
    Ok(nodes
        .iter()
        .filter_map(|node| {
            let assigned = match node["__typename"].as_str()? {
                "AssignedEvent" => true,
                "UnassignedEvent" => false,
                _ => return None,
            };
            Some(Assignment {
                login: node["assignee"]["login"].as_str()?.to_string(),
                at_ms: rfc3339_ms(node["createdAt"].as_str())?,
                assigned,
            })
        })
        .collect())
}

/// 1.175.0 (B3): how many issues one [`issue_origins`] read asks about.
pub const ORIGINS_PER_READ: usize = 100;

#[cfg(test)]
thread_local! {
    /// B3: whether this thread's test lets [`issue_origins`] reach the gh
    /// seam. Off by default, so the hundreds of tests that queue a board
    /// read's answers one by one aren't each asked for one more.
    static TEST_ORIGINS_READ: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn set_test_origins_read(on: bool) {
    TEST_ORIGINS_READ.with(|flag| flag.set(on));
}

/// 1.175.0 (B3): where the text of `repo`'s issues `numbers` comes from —
/// each one's author association and last editor — in one bounded GraphQL
/// read (at most [`ORIGINS_PER_READ`] issues; the rest are left to the next
/// call). `gh issue list` gives neither. An issue GitHub doesn't answer for
/// is left out. Nothing is written.
pub fn issue_origins(repo: &str, numbers: &[u64]) -> Result<Vec<(u64, crate::issue_text::Origin)>, String> {
    if numbers.is_empty() {
        return Ok(Vec::new());
    }
    #[cfg(test)]
    if !TEST_ORIGINS_READ.with(|flag| flag.get()) {
        return Ok(Vec::new());
    }
    let (owner, name) = repo
        .split_once('/')
        .filter(|(o, n)| !o.is_empty() && !n.is_empty())
        .ok_or_else(|| format!("'{repo}' is not an owner/name repository"))?;
    let asked: String = numbers
        .iter()
        .take(ORIGINS_PER_READ)
        .map(|n| format!("i{n}:issue(number:{n}){{number authorAssociation editor{{login}}}}"))
        .collect::<Vec<_>>()
        .join(" ");
    let query = format!("query=query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{asked}}}}}");
    let (owner, name) = (format!("owner={owner}"), format!("name={name}"));
    let json = run_gh(&["api", "graphql", "-f", &query, "-f", &owner, "-f", &name])?;
    issue_origins_from(&json)
}

/// Pure: [`issue_origins`]'s answer. One issue GitHub couldn't resolve
/// comes back as an error beside the others' data: the others are kept.
pub fn issue_origins_from(json: &str) -> Result<Vec<(u64, crate::issue_text::Origin)>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    let Some(repository) = v["data"]["repository"].as_object() else {
        return Err(v["errors"][0]["message"].as_str().unwrap_or("gh api graphql: the repository is missing from the answer").to_string());
    };
    Ok(repository
        .values()
        .filter_map(|issue| {
            Some((
                issue["number"].as_u64()?,
                crate::issue_text::Origin {
                    association: issue["authorAssociation"].as_str().map(str::to_string),
                    editor: issue["editor"]["login"].as_str().map(str::to_string),
                },
            ))
        })
        .collect())
}

/// 1.175.0 (D1): a pull request that closes an issue, as Ship reads it
/// before it sends anything — with the branch it comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosingPullRequest {
    pub number: u64,
    pub url: String,
    /// "open", "closed" or "merged".
    pub state: String,
    /// Who opened it; None for a deleted account.
    pub author: Option<String>,
    pub head_ref: Option<String>,
    /// Round 2: the author's association with the repository, as GitHub
    /// names it (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, …).
    pub association: Option<String>,
    /// Round 3: whether its branch is in another repository (a fork).
    /// `None` when GitHub didn't say.
    pub cross_repository: Option<bool>,
}

/// 1.175.0 (D1): whether an issue is closed, and the pull requests that
/// close it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IssueDelivery {
    pub closed: bool,
    pub prs: Vec<ClosingPullRequest>,
    /// Team walk (TEAMFIX 6): the repository's default branch, as the same
    /// read gives it; `None` when GitHub didn't say.
    pub default_branch: Option<String>,
}

const ISSUE_DELIVERY_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name} issue(number:$number){state closedByPullRequestsReferences(first:25,includeClosedPrs:true){nodes{number url state headRefName isCrossRepository authorAssociation author{login} repository{nameWithOwner}}}}}}";

/// 1.175.0 (D1): the state of `repo`'s issue `number` and the pull requests
/// of the same repository that close it. One bounded GraphQL read.
///
/// Team walk (TEAMFIX 6): GitHub links "Closes #N" only for pull requests
/// to the default branch. When the cards go to another branch (`base`),
/// a second bounded read finds the pull requests to `base` whose title or
/// description closes the issue ([`base_pull_requests_from`]). Reads only.
pub fn issue_delivery(repo: &str, number: u64, base: Option<&str>) -> Result<IssueDelivery, String> {
    let [owner, name, number_arg] = issue_query_args(repo, number)?;
    let query = format!("query={ISSUE_DELIVERY_QUERY}");
    let json = run_gh(&["api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number_arg])?;
    let mut delivery = issue_delivery_from(&json, repo)?;
    let Some(base) = base.filter(|b| !b.is_empty() && delivery.default_branch.as_deref() != Some(*b)) else {
        return Ok(delivery);
    };
    let search = format!("q=repo:{repo} is:pr base:{base} {number} in:title,body");
    let query = format!("query={BASE_PULL_REQUESTS_QUERY}");
    // A second read that fails keeps what the first found (TEAMFIX 6 review).
    let found = run_gh(&["api", "graphql", "-f", &query, "-f", &search])
        .and_then(|json| base_pull_requests_from(&json, repo, number, base));
    let found = match found {
        Ok(found) => found,
        Err(e) => {
            log::warn!("github: the pull requests of {repo} to {base} for #{number} couldn't be read ({e}); the issue's own links stand");
            return Ok(delivery);
        }
    };
    for pr in found {
        if !delivery.prs.iter().any(|p| p.number == pr.number) {
            delivery.prs.push(pr);
        }
    }
    Ok(delivery)
}

const BASE_PULL_REQUESTS_QUERY: &str = "query($q:String!){search(query:$q,type:ISSUE,first:25){nodes{... on PullRequest{number url state headRefName baseRefName isCrossRepository authorAssociation author{login} repository{nameWithOwner} title body}}}}";

/// Pure: the second read's answer — the pull requests of `repo` to `base`
/// whose title or description closes issue `number` ("Closes #N", "Fixes
/// owner/repo#N", "Resolves https://github.com/owner/repo/issues/N"), as
/// GitHub would link them on the default branch. A mention alone doesn't.
pub fn base_pull_requests_from(json: &str, repo: &str, number: u64, base: &str) -> Result<Vec<ClosingPullRequest>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let nodes = v["data"]["search"]["nodes"].as_array().ok_or_else(|| "gh api graphql: the search is missing from the answer".to_string())?;
    Ok(nodes
        .iter()
        .filter(|pr| pr["repository"]["nameWithOwner"].as_str().is_some_and(|r| r.eq_ignore_ascii_case(repo)))
        .filter(|pr| pr["baseRefName"].as_str() == Some(base))
        .filter(|pr| {
            [pr["title"].as_str(), pr["body"].as_str()].into_iter().flatten().any(|t| closes_issue(t, number, repo))
        })
        .filter_map(|pr| {
            Some(ClosingPullRequest {
                number: pr["number"].as_u64()?,
                url: pr["url"].as_str()?.to_string(),
                state: pr["state"].as_str().unwrap_or("OPEN").to_ascii_lowercase(),
                author: pr["author"]["login"].as_str().map(str::to_string),
                head_ref: pr["headRefName"].as_str().map(str::to_string),
                association: pr["authorAssociation"].as_str().map(str::to_string),
                cross_repository: pr["isCrossRepository"].as_bool(),
            })
        })
        .collect())
}

/// Whether `text` closes issue `number` of `repo` with one of GitHub's
/// closing keywords, as GitHub reads them.
pub fn closes_issue(text: &str, number: u64, repo: &str) -> bool {
    const KEYWORDS: [&str; 9] = ["closes", "closed", "close", "fixes", "fixed", "fix", "resolves", "resolved", "resolve"];
    let lower = text.to_ascii_lowercase();
    let repo = repo.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut i = 0;
    while i < bytes.len() {
        if i == 0 || !word(bytes[i - 1]) {
            if let Some(k) = KEYWORDS.iter().find(|k| lower[i..].starts_with(*k)) {
                let mut j = i + k.len();
                if j >= bytes.len() || !word(bytes[j]) {
                    if j < bytes.len() && bytes[j] == b':' {
                        j += 1;
                    }
                    let rest = &lower[j..];
                    let reference = rest.trim_start_matches([' ', '\t']);
                    if reference.len() < rest.len() {
                        let n = reference
                            .strip_prefix('#')
                            .or_else(|| reference.strip_prefix(&format!("{repo}#")))
                            .or_else(|| reference.strip_prefix(&format!("https://github.com/{repo}/issues/")));
                        if let Some(n) = n {
                            let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
                            if digits.parse::<u64>().ok() == Some(number) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        i += lower[i..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

/// Pure: [`issue_delivery`]'s answer. A pull request in another repository
/// is not this board's.
pub fn issue_delivery_from(json: &str, repo: &str) -> Result<IssueDelivery, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let issue = &v["data"]["repository"]["issue"];
    let state = issue["state"].as_str().ok_or_else(|| "gh api graphql: the issue is missing from the answer".to_string())?;
    let default_branch = v["data"]["repository"]["defaultBranchRef"]["name"].as_str().map(str::to_string);
    let prs = issue["closedByPullRequestsReferences"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|pr| pr["repository"]["nameWithOwner"].as_str().is_none_or(|r| r.eq_ignore_ascii_case(repo)))
        .filter_map(|pr| {
            Some(ClosingPullRequest {
                number: pr["number"].as_u64()?,
                url: pr["url"].as_str()?.to_string(),
                state: pr["state"].as_str().unwrap_or("OPEN").to_ascii_lowercase(),
                author: pr["author"]["login"].as_str().map(str::to_string),
                head_ref: pr["headRefName"].as_str().map(str::to_string),
                association: pr["authorAssociation"].as_str().map(str::to_string),
                cross_repository: pr["isCrossRepository"].as_bool(),
            })
        })
        .collect();
    Ok(IssueDelivery { closed: state.eq_ignore_ascii_case("CLOSED"), prs, default_branch })
}

/// 1.175.0 (D1): the GitHub login of whoever wrote the newest commit of
/// `repo`'s branch, when GitHub knows the account; `None` when it doesn't.
/// One bounded read, asked only after a push the branch refused.
pub fn branch_tip_author(repo: &str, branch: &str) -> Result<Option<String>, String> {
    let endpoint = format!("repos/{repo}/commits/heads/{branch}");
    let login = run_gh(&["api", &endpoint, "--jq", ".author.login // \"\""])?;
    Ok(Some(login.trim().to_string()).filter(|l| !l.is_empty()))
}

/// N14 (item 4): a pull request linked to an issue — one that says "Closes
/// #21" (or "Fixes", "Resolves"), or one linked to it by hand on GitHub.
/// A teammate's pull request on the owner's
/// card; never the card's own ship PR.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPullRequest {
    pub number: u64,
    pub url: String,
    /// "open", "closed" or "merged".
    pub state: String,
    pub draft: bool,
    /// Who opened it; None for a deleted account.
    pub author: Option<String>,
}

/// U28: an open pull request that closes one of the board's issues, as the
/// Board tile shows it. Display only and not stored.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPrLink {
    pub issue: u64,
    pub number: u64,
    /// Who opened it; None for a deleted account.
    pub author: Option<String>,
}

/// U28: how many open pull requests the Board reads at once, newest first. Past
/// it, the older ones' cards just show no line on the tile; the card page reads
/// its own links.
const OPEN_PR_LINKS_LIMIT: &str = "100";

/// U28: the open pull requests of `repo` that close an issue of its own: one
/// read for the whole Board, through the `gh` chokepoint.
pub fn open_pr_links(repo: &str) -> Result<Vec<OpenPrLink>, String> {
    let json = run_gh(&[
        "pr", "list", "--repo", repo, "--state", "open", "--limit", OPEN_PR_LINKS_LIMIT,
        "--json", "number,author,closingIssuesReferences",
    ])?;
    open_pr_links_from(&json, repo)
}

/// Pure: one link per issue a pull request closes, newest pull request first
/// for an issue with several. An issue in another repository isn't this
/// board's.
pub fn open_pr_links_from(json: &str, repo: &str) -> Result<Vec<OpenPrLink>, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("gh pr list: bad JSON: {e}"))?;
    let mut out: Vec<OpenPrLink> = Vec::new();
    for pr in v.as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(number) = pr["number"].as_u64() else { continue };
        let author = pr["author"]["login"].as_str().map(str::to_string);
        for issue in pr["closingIssuesReferences"].as_array().map(Vec::as_slice).unwrap_or_default() {
            let Some(n) = issue["number"].as_u64() else { continue };
            let r = &issue["repository"];
            let here = match (r["owner"]["login"].as_str(), r["name"].as_str()) {
                (Some(owner), Some(name)) => format!("{owner}/{name}").eq_ignore_ascii_case(repo),
                _ => true,
            };
            if here && !out.iter().any(|l| l.issue == n) {
                out.push(OpenPrLink { issue: n, number, author: author.clone() });
            }
        }
    }
    Ok(out)
}

/// How many pull requests [`issue_linked_pull_requests`] reads from each
/// source: the issue's closing references, and its newest timeline events
/// for links made by hand. An issue with more links than this is not a card.
pub const LINKED_PR_LIMIT: u32 = 25;

/// Challenger P1: `closedByPullRequestsReferences` is GitHub's own list of
/// the pull requests that close the issue — "Closes #21" and the
/// Development links — and keeps a merged one (`includeClosedPrs`), where a
/// cross-reference's `willCloseTarget` reads false once its PR merged. The
/// timeline's connected/disconnected events are a second source for a link
/// made by hand, deduped.
const LINKED_PRS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:25,includeClosedPrs:true){nodes{number url state isDraft author{login} repository{nameWithOwner}}} timelineItems(last:25,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){nodes{__typename ... on ConnectedEvent{subject{__typename ... on PullRequest{number url state isDraft author{login} repository{nameWithOwner}}}} ... on DisconnectedEvent{subject{__typename ... on PullRequest{number repository{nameWithOwner}}}}}}}}}";

/// N14 (item 4): the pull requests linked to `repo`'s issue `number` (one
/// bounded GraphQL read through the `gh` chokepoint, as the workspace's
/// GitHub account when the caller entered its scope).
pub fn issue_linked_pull_requests(repo: &str, number: u64) -> Result<Vec<LinkedPullRequest>, String> {
    let (owner, name) = repo
        .split_once('/')
        .filter(|(o, n)| !o.is_empty() && !n.is_empty())
        .ok_or_else(|| format!("'{repo}' is not an owner/name repository"))?;
    debug_assert!(LINKED_PRS_QUERY.contains(&format!("first:{LINKED_PR_LIMIT}")));
    let query = format!("query={LINKED_PRS_QUERY}");
    let owner_arg = format!("owner={owner}");
    let name_arg = format!("name={name}");
    let number_arg = format!("number={number}");
    let json = run_gh(&[
        "api", "graphql", "-f", &query, "-f", &owner_arg, "-f", &name_arg, "-F", &number_arg,
    ])?;
    linked_prs_from_issue(&json, repo)
}

/// Pure: the linked pull requests of the answer, once each — the closing
/// references first (open, closed or merged), then pull requests linked by
/// hand and not unlinked since. One in another repository is not this
/// board's.
pub fn linked_prs_from_issue(json: &str, repo: &str) -> Result<Vec<LinkedPullRequest>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let issue = &v["data"]["repository"]["issue"];
    let same_repo = |pr: &serde_json::Value| {
        pr["repository"]["nameWithOwner"]
            .as_str()
            .is_none_or(|r| r.eq_ignore_ascii_case(repo))
    };
    let linked = |pr: &serde_json::Value| -> Option<LinkedPullRequest> {
        Some(LinkedPullRequest {
            number: pr["number"].as_u64()?,
            url: pr["url"].as_str()?.to_string(),
            state: pr["state"].as_str().unwrap_or("OPEN").to_ascii_lowercase(),
            draft: pr["isDraft"].as_bool().unwrap_or(false),
            author: pr["author"]["login"].as_str().map(str::to_string),
        })
    };
    let mut out: Vec<LinkedPullRequest> = Vec::new();
    for pr in issue["closedByPullRequestsReferences"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if !same_repo(pr) {
            continue;
        }
        if let Some(p) = linked(pr) {
            if !out.iter().any(|o| o.number == p.number) {
                out.push(p);
            }
        }
    }
    let closing = out.len();
    for node in issue["timelineItems"]["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let pr = &node["subject"];
        if pr["__typename"].as_str() != Some("PullRequest") || !same_repo(pr) {
            continue;
        }
        let Some(number) = pr["number"].as_u64() else {
            continue;
        };
        match node["__typename"].as_str() {
            Some("ConnectedEvent") => {
                if let Some(p) = linked(pr) {
                    if !out.iter().any(|o| o.number == number) {
                        out.push(p);
                    }
                }
            }
            // Unlinked by hand since: drop a hand link; a closing
            // reference stays (GitHub's own list says it still closes it).
            Some("DisconnectedEvent") => {
                let mut i = 0;
                out.retain(|o| {
                    i += 1;
                    i <= closing || o.number != number
                });
            }
            _ => {}
        }
    }
    Ok(out)
}

/// v1.62.0 (Phase 6): open PRs in `repo` where the authenticated user is a
/// requested reviewer (`review-requested:@me`, resolved server-side like the
/// claim gate's `@me`). READ-ONLY — pure awareness, no git porcelain.
pub fn pr_list_review_requested(repo: &str) -> Result<Vec<GhPr>, String> {
    let json = run_gh(&[
        "pr",
        "list",
        "--repo",
        repo,
        "--search",
        "review-requested:@me",
        "--state",
        "open",
        "--json",
        "number,title,url,author,createdAt",
    ])?;
    let raw: Vec<GhPrRaw> =
        serde_json::from_str(&json).map_err(|e| format!("gh pr list: bad JSON: {e}"))?;
    Ok(raw
        .into_iter()
        .map(|p| GhPr {
            number: p.number,
            title: p.title,
            url: p.url,
            author: p.author.map(|a| a.login).unwrap_or_default(),
            created_at: rfc3339_ms(p.created_at.as_deref()),
        })
        .collect())
}

/// Challenger on a pull request: the repository's open pull requests, as
/// `gh pr list --json` gives them ([`crate::pr_review::PR_LIST_FIELDS`]),
/// for the Board's "Review a pull request". READ-ONLY. Run inside the
/// workspace's GitHub account scope.
pub fn pr_list_for_review(repo: &str) -> Result<String, String> {
    run_gh(&[
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        crate::pr_review::PR_LIST_FIELDS,
    ])
}

/// Challenger on a pull request: one pull request of `repo`
/// ([`crate::pr_review::PR_VIEW_FIELDS`]). READ-ONLY.
pub fn pr_view_for_review(repo: &str, number: u64) -> Result<String, String> {
    run_gh(&[
        "pr",
        "view",
        &number.to_string(),
        "--repo",
        repo,
        "--json",
        crate::pr_review::PR_VIEW_FIELDS,
    ])
}

/// Challenger on a pull request (walk 3 of #386): the repository's default
/// branch as GitHub says it (a read). `Err` when GitHub couldn't be asked.
pub fn repo_default_branch(repo: &str) -> Result<String, String> {
    run_gh(&["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])
        .map(|s| s.trim().to_string())
}

/// R9: `branch`'s classic protection on `repo` as GitHub says it (a read,
/// `GET repos/{repo}/branches/{branch}/protection`). GitHub answers it only
/// to an account that administers the repository; a 404 or 403 — and any
/// other failure — is `Err`, which the caller reads as "unknown", never as
/// "unprotected".
pub fn branch_protection(repo: &str, branch: &str) -> Result<String, String> {
    run_gh(&["api", &format!("repos/{repo}/branches/{branch}/protection")])
}

/// C9 round 1: the rulesets on `branch` of `repo` (a read, `GET
/// repos/{repo}/rules/branches/{branch}`, readable with read access).
pub fn branch_rules(repo: &str, branch: &str) -> Result<String, String> {
    run_gh(&["api", &format!("repos/{repo}/rules/branches/{branch}")])
}

/// R9: whether [`branch_protection`]'s answer refuses a direct push from the
/// account that read it. Only an administrator can read it, and an
/// administrator bypasses protection unless *Do not allow bypassing* is on
/// (`enforce_admins`); then a required pull request, required status checks
/// or a locked branch refuse a plain push. Anything else (only force pushes
/// or deletions blocked, an answer that can't be read) is `false`: the push
/// then says.
pub fn protection_refuses_push(json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return false;
    };
    let on = |key: &str| v[key]["enabled"].as_bool() == Some(true);
    let present = |key: &str| v.get(key).is_some_and(|x| !x.is_null());
    // Status checks refuse a push only when some are named.
    let named = |key: &str| v["required_status_checks"][key].as_array().is_some_and(|a| !a.is_empty());
    on("enforce_admins")
        && (present("required_pull_request_reviews") || named("contexts") || named("checks") || on("lock_branch"))
}

/// Create an issue for card `card_id`; returns its number, parsed from the
/// URL `gh` prints. For a Sync worker: see [`issue_create_with`].
pub fn issue_create(repo: &str, card_id: &str, title: &str, body: &str) -> Result<u64, String> {
    issue_create_with(repo, card_id, title, body, LookFor::Now)
}

/// [`issue_create`] for the main thread (GH #204 review 2: a card just
/// created on the board): the create is the only wait. A timeout is
/// remembered and left to Sync, which looks for the issue before retrying.
pub fn issue_create_without_waiting(
    repo: &str,
    card_id: &str,
    title: &str,
    body: &str,
) -> Result<u64, String> {
    issue_create_with(repo, card_id, title, body, LookFor::OnSync)
}

/// When a timed-out create is looked for on GitHub.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LookFor {
    /// Here, before reporting the timeout or creating again.
    Now,
    /// Not on this thread: the attempt is remembered for Sync.
    OnSync,
}

/// GH #204 review 1–2: a create stopped at its bound may have been made on
/// GitHub anyway. Every such attempt is remembered for its card as a window
/// of creation times (from just before it started to its bound, with room
/// for the two clocks). Before any later create of that card — and, with
/// [`LookFor::Now`], right after the timeout — the issue is looked for: this
/// account's, this title and body, created inside one of the card's windows.
/// Found, it is the answer; GitHub says it isn't there, the windows are
/// cleared and the create goes ahead; GitHub can't be asked, nothing is
/// created. The memory lasts for this session.
fn issue_create_with(
    repo: &str,
    card_id: &str,
    title: &str,
    body: &str,
    look_for: LookFor,
) -> Result<u64, String> {
    issue_writes_held(repo)?;
    let key = (repo.to_string(), card_id.to_string());
    let earlier = unconfirmed_windows(&key);
    if !earlier.is_empty() {
        if look_for == LookFor::OnSync {
            return Err(
                "an earlier create of this issue timed out; Sync checks for it before creating again"
                    .to_string(),
            );
        }
        match find_created_issue(repo, title, body, &earlier) {
            Ok(Some(number)) => {
                forget_unconfirmed(&key);
                return Ok(number);
            }
            Ok(None) => forget_unconfirmed(&key),
            Err(e) => {
                return Err(format!(
                    "couldn't check whether an earlier, timed-out create made this issue: {e}"
                ))
            }
        }
    }
    let window = CreateWindow::starting_now();
    // 1.175.0 D4 (TM-9): the body on stdin, never an argument — Windows caps
    // a command line at 32,767 characters, and a brief can be longer.
    match run_gh_with_input(&["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"], body) {
        Ok(url) => issue_number_from_url(&url)
            .ok_or_else(|| format!("gh issue create: couldn't parse issue number from `{url}`")),
        Err(e) if is_gh_timeout(&e) => {
            if look_for == LookFor::Now {
                if let Ok(Some(number)) = find_created_issue(repo, title, body, &[window]) {
                    return Ok(number);
                }
            }
            // Not found yet (GitHub may still be finishing it), not looked
            // for on this thread, or GitHub couldn't be asked.
            remember_unconfirmed(key, window);
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// When a timed-out create's issue can have been created.
#[derive(Debug, Clone, Copy, PartialEq)]
struct CreateWindow {
    from: chrono::DateTime<chrono::Utc>,
    to: chrono::DateTime<chrono::Utc>,
}

impl CreateWindow {
    /// Two minutes either side for GitHub's clock against this Mac's.
    fn starting_now() -> Self {
        let slack = chrono::Duration::minutes(2);
        let now = chrono::Utc::now();
        let bound = chrono::Duration::from_std(GH_CREATE_TIMEOUT).unwrap_or(slack);
        Self { from: now - slack, to: now + bound + slack }
    }

    /// R2: from `since_ms` (Unix ms) to now, with the same room either side.
    fn since(since_ms: i64) -> Self {
        let slack = chrono::Duration::minutes(2);
        let now = chrono::Utc::now();
        let from = chrono::DateTime::from_timestamp_millis(since_ms).unwrap_or(now);
        Self { from: from - slack, to: now + slack }
    }

    fn holds(&self, at: chrono::DateTime<chrono::Utc>) -> bool {
        self.from <= at && at <= self.to
    }
}

/// 1.175.0 (R2): card `card_id`'s board was opened from its last saved copy,
/// written at `since_ms`, and the card has no issue number there. The save
/// that was lost may be the one that stamped it: its issue would then be on
/// GitHub already. So the card is treated like one whose create timed out —
/// before any create, the issue is looked for ([`find_created_issue`]: this
/// account's, this title and body, created since that copy was written), and
/// found, it is the card's. No new kind of read: the one a timed-out create
/// already makes, once per card. Kept for this session, like those.
pub(crate) fn expect_lost_create(repo: &str, card_id: &str, since_ms: i64) {
    let key = (repo.to_string(), card_id.to_string());
    if unconfirmed_windows(&key).is_empty() {
        remember_unconfirmed(key, CreateWindow::since(since_ms));
    }
}

/// (repo, card id) → the windows of its timed-out creates, oldest first.
type CreateKey = (String, String);

static UNCONFIRMED_CREATES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<CreateKey, Vec<CreateWindow>>>,
> = std::sync::LazyLock::new(Default::default);

fn remember_unconfirmed(key: CreateKey, window: CreateWindow) {
    UNCONFIRMED_CREATES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key)
        .or_default()
        .push(window);
}

fn unconfirmed_windows(key: &CreateKey) -> Vec<CreateWindow> {
    UNCONFIRMED_CREATES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(key)
        .cloned()
        .unwrap_or_default()
}

fn forget_unconfirmed(key: &CreateKey) {
    UNCONFIRMED_CREATES.lock().unwrap_or_else(|p| p.into_inner()).remove(key);
}

/// An issue body as compared here: line endings and outer whitespace
/// normalised (GitHub may hand back `\r\n`).
fn normalised_body(body: &str) -> String {
    body.replace("\r\n", "\n").trim().to_string()
}

#[derive(Deserialize)]
struct CreatedIssue {
    number: u64,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(rename = "createdAt")]
    created_at: String,
}

/// The newest issue on `repo` by this account with exactly this title and
/// body, created inside one of `windows` — the one a timed-out create made.
/// One page, so the API bound (not the board pull's).
fn find_created_issue(
    repo: &str,
    title: &str,
    body: &str,
    windows: &[CreateWindow],
) -> Result<Option<u64>, String> {
    let json = run_gh_within(
        &[
            "issue", "list", "--repo", repo, "--state", "all", "--author", "@me", "--limit", "30",
            "--json", "number,title,body,createdAt",
        ],
        GH_API_TIMEOUT,
    )?;
    let issues: Vec<CreatedIssue> =
        serde_json::from_str(&json).map_err(|e| format!("gh issue list: bad JSON: {e}"))?;
    let body = normalised_body(body);
    Ok(issues
        .into_iter()
        .filter(|i| i.title == title && normalised_body(&i.body) == body)
        .filter(|i| {
            chrono::DateTime::parse_from_rfc3339(&i.created_at).is_ok_and(|at| {
                let at = at.with_timezone(&chrono::Utc);
                windows.iter().any(|w| w.holds(at))
            })
        })
        .map(|i| i.number)
        .max())
}

/// 1.173.0 (C2): rewrite only an issue's body (the claim marker's write;
/// the title stays as GitHub has it). The body goes on stdin (1.175.0 D4,
/// TM-9). 1.175.0 (D3): there is no write of a title and a body together
/// any more — a title goes alone ([`issue_edit_title`]).
pub fn issue_edit_body(repo: &str, number: u64, body: &str) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh_with_input(&["issue", "edit", &n, "--repo", repo, "--body-file", "-"], body).map(|_| ())
}

/// 1.175.0 (D3): rewrite only an issue's title — the body stays as GitHub
/// has it, so a renamed card never writes over a teammate's text.
pub fn issue_edit_title(repo: &str, number: u64, title: &str) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh(&["issue", "edit", &n, "--repo", repo, "--title", title]).map(|_| ())
}

/// 1.175.0 (D3): who last changed an issue's text and its title, and when
/// (ms) — for the question a card asks when both sides changed a part.
/// `None` where GitHub doesn't say (never edited, a deleted account).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IssueLastChange {
    pub body_by: Option<String>,
    pub body_at: Option<i64>,
    pub title_by: Option<String>,
    pub title_at: Option<i64>,
}

const LAST_CHANGE_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){lastEditedAt editor{login} timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT]){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}}}}";

/// One bounded GraphQL read, asked only when a card is about to raise a
/// question. Nothing is written.
pub fn issue_last_change(repo: &str, number: u64) -> Result<IssueLastChange, String> {
    let [owner, name, number] = issue_query_args(repo, number)?;
    let query = format!("query={LAST_CHANGE_QUERY}");
    let json = run_gh(&["api", "graphql", "-f", &query, "-f", &owner, "-f", &name, "-F", &number])?;
    issue_last_change_from(&json)
}

/// Pure: [`issue_last_change`]'s answer.
pub fn issue_last_change_from(json: &str) -> Result<IssueLastChange, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("gh api graphql: bad JSON: {e}"))?;
    if let Some(msg) = v["errors"][0]["message"].as_str() {
        return Err(msg.to_string());
    }
    let issue = &v["data"]["repository"]["issue"];
    if !issue.is_object() {
        return Err("gh api graphql: the issue is missing from the answer".to_string());
    }
    let renamed = &issue["timelineItems"]["nodes"][0];
    Ok(IssueLastChange {
        body_by: issue["editor"]["login"].as_str().map(str::to_string),
        body_at: rfc3339_ms(issue["lastEditedAt"].as_str()),
        title_by: renamed["actor"]["login"].as_str().map(str::to_string),
        title_at: rfc3339_ms(renamed["createdAt"].as_str()),
    })
}

/// Close an issue. Used by the GH-backed card-delete flow (v1.77.0,
/// `kanban_card_delete_github`): close the issue, then delete the card.
pub fn issue_close(repo: &str, number: u64) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh(&["issue", "close", &n, "--repo", repo]).map(|_| ())
}

/// Add an assignee to an issue. Pass `@me` to claim for the authenticated user
/// (the one-click Claim path — assignees are logins, and `@me` resolves to the
/// current login server-side, matching the claim gate's [`current_login`]).
pub fn issue_add_assignee(repo: &str, number: u64, login: &str) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh(&[
        "issue",
        "edit",
        &n,
        "--repo",
        repo,
        "--add-assignee",
        login,
    ])
    .map(|_| ())
}

/// 1.175.0 (D2, D1; owner 2026-11-09): take the member's own name off an
/// issue. `@me` is resolved by `gh` as the account signed in; there is no
/// login to pass, so nobody else's name can ever be taken off from here.
/// The other assignees stay, and an issue that doesn't carry the name is
/// left as it is (GitHub answers the same).
pub fn issue_remove_assignee_me(repo: &str, number: u64) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh(&["issue", "edit", &n, "--repo", repo, "--remove-assignee", "@me"]).map(|_| ())
}

/// Post a comment on an issue (Phase 4: card-outcome posting). 1.175.0 G6:
/// the body is on gh's stdin, as create and edit pass theirs — an outcome
/// longer than a Windows command line still posts.
pub fn issue_comment(repo: &str, number: u64, body: &str) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    run_gh_with_input(&["issue", "comment", &n, "--repo", repo, "--body-file", "-"], body).map(|_| ())
}

/// Add and/or remove labels on an issue (e.g. swap status labels on a move).
pub fn issue_set_labels(
    repo: &str,
    number: u64,
    add: &[&str],
    remove: &[&str],
) -> Result<(), String> {
    issue_writes_held(repo)?;
    let n = number.to_string();
    let mut args: Vec<&str> = vec!["issue", "edit", &n, "--repo", repo];
    for &l in add {
        args.push("--add-label");
        args.push(l);
    }
    for &l in remove {
        args.push("--remove-label");
        args.push(l);
    }
    run_gh(&args).map(|_| ())
}

/// Idempotently ensure each `(name, hex_color)` label exists. `--force` updates
/// an existing label instead of erroring, so this is safe to call on every
/// flip to GitHubIssues mode.
pub fn ensure_labels(repo: &str, labels: &[(&str, &str)]) -> Result<(), String> {
    for (name, color) in labels {
        run_gh(&[
            "label", "create", name, "--repo", repo, "--color", color, "--force",
        ])?;
    }
    Ok(())
}

fn issue_number_from_url(url: &str) -> Option<u64> {
    url.rsplit('/').next()?.trim().parse().ok()
}

// ── kanban ↔ GitHub mapping (pure) ───────────────────────────────────────────

use crate::kanban::KanbanColumnId;

/// The status labels (name, hex color) Ply manages on a GitHub-backed board.
/// Created idempotently (`ensure_labels`) when a workspace flips to
/// GitHubIssues mode. One label per kanban column.
pub const STATUS_LABELS: [(&str, &str); 3] = [
    ("status:todo", "ededed"),
    ("status:in-progress", "fbca04"),
    ("status:done", "0e8a16"),
];

/// Skills hub H3a (Windows walk): the label a skill card's issue carries
/// (§4.2, R2 edge "Board backed by GitHub Issues"). It tells every other
/// board that the issue is a skill card held on the Mac that made it — never
/// work to start there (`github_sync::reconcile_plan` makes no card for it).
pub const SKILL_CARD_LABEL: (&str, &str) = ("plyloft:skill", "5319e7");

/// Whether an issue carries [`SKILL_CARD_LABEL`].
pub fn is_skill_card_issue(issue: &GhIssue) -> bool {
    issue.labels.iter().any(|l| l.name == SKILL_CARD_LABEL.0)
}

/// The status label that represents a column.
pub fn label_for_column(col: &KanbanColumnId) -> &'static str {
    match col {
        KanbanColumnId::Todo => "status:todo",
        KanbanColumnId::InProgress => "status:in-progress",
        KanbanColumnId::Complete => "status:done",
    }
}

/// Derive a card's column from an issue's state + labels. A **closed** issue is
/// always `Complete` (a merged PR with `Closes #N` lands the card in Done).
/// Otherwise the status label wins; with none present, default `Todo`.
pub fn column_from_issue(issue: &GhIssue) -> KanbanColumnId {
    if issue.state.eq_ignore_ascii_case("closed") {
        return KanbanColumnId::Complete;
    }
    for l in &issue.labels {
        match l.name.as_str() {
            "status:in-progress" => return KanbanColumnId::InProgress,
            "status:done" => return KanbanColumnId::Complete,
            "status:todo" => return KanbanColumnId::Todo,
            _ => {}
        }
    }
    KanbanColumnId::Todo
}

/// GH #66: an issue's assignee logins, in GitHub's order — what a card keeps
/// in `gh_assignees`.
pub fn assignee_logins(issue: &GhIssue) -> Vec<String> {
    issue.assignees.iter().map(|a| a.login.clone()).collect()
}

/// N14 (item 6): the login of who opened the issue — what a card keeps in
/// `gh_author`. None when GitHub named nobody (a deleted account) or the
/// answer did not carry it.
pub fn author_login(issue: &GhIssue) -> Option<String> {
    issue
        .author
        .as_ref()
        .map(|a| a.login.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// GH #66: who holds a claim, seen from `login`. Assignees are GitHub
/// **logins**, not emails — pass [`current_login`], not a git email, and they
/// compare case-insensitively. GitHub allows several
/// assignees, so "mine" wins over anyone else also assigned: co-owners
/// already agreed to share.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClaimHolder {
    Unclaimed,
    Mine,
    Others { logins: Vec<String> },
}

pub fn claim_holder(assignees: &[String], login: &str) -> ClaimHolder {
    if assignees.is_empty() {
        ClaimHolder::Unclaimed
    } else if assignees.iter().any(|a| a.eq_ignore_ascii_case(login)) {
        ClaimHolder::Mine
    } else {
        ClaimHolder::Others {
            logins: assignees.to_vec(),
        }
    }
}

/// The label add/remove pair for moving a card into `col`: the target column's
/// status label added, the other status labels removed. (`issue_set_labels`
/// tolerates removing a label that isn't present.)
pub fn labels_for_move(col: &KanbanColumnId) -> (Vec<&'static str>, Vec<&'static str>) {
    let target = label_for_column(col);
    let remove = STATUS_LABELS
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| *n != target)
        .collect();
    (vec![target], remove)
}

/// GH #204: a `gh` that never answers. Run as `/bin/sh` in [`Self::dir`], so
/// `gh issue view …` runs the plain file `issue` there (the GH #90 pattern: no
/// fresh executable for macOS to assess on first exec). Each verb file
/// backgrounds a long `sleep`, records its pid and its own, and waits. On
/// Windows the stub is a `gh.cmd` there ([`gh_stub_program`]) whose verb runs
/// PowerShell, which starts a long `ping` and records both pids.
#[cfg(test)]
pub(crate) struct StalledGh {
    dir: tempfile::TempDir,
    pids: std::path::PathBuf,
}

/// The program a stub `gh` in `dir` runs as: `/bin/sh`, reading the file
/// named by the verb; on Windows `dir\gh.cmd`, which calls `<verb>.cmd`.
#[cfg(test)]
pub(crate) fn gh_stub_program(dir: &std::path::Path) -> String {
    #[cfg(unix)]
    {
        let _ = dir;
        "/bin/sh".into()
    }
    #[cfg(windows)]
    {
        let gh = dir.join("gh.cmd");
        if !gh.exists() {
            std::fs::write(&gh, "@call \"%~dp0%~1.cmd\"\r\n@exit /b %errorlevel%\r\n").unwrap();
        }
        gh.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
impl StalledGh {
    pub(crate) fn new(verbs: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pids = dir.path().join("pids");
        #[cfg(unix)]
        for verb in verbs {
            std::fs::write(
                dir.path().join(verb),
                format!(
                    "sleep 60 &\necho $! >> \"{p}\"\necho $$ >> \"{p}\"\nwait\n",
                    p = pids.display()
                ),
            )
            .unwrap();
        }
        #[cfg(windows)]
        {
            std::fs::write(
                dir.path().join("stall.ps1"),
                format!(
                    "$child = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru\r\n\
                     Add-Content -LiteralPath '{p}' -Value $child.Id\r\n\
                     Add-Content -LiteralPath '{p}' -Value $PID\r\n\
                     $child.WaitForExit()\r\n",
                    p = pids.display()
                ),
            )
            .unwrap();
            for verb in verbs {
                std::fs::write(
                    dir.path().join(format!("{verb}.cmd")),
                    "@powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0stall.ps1\"\r\n",
                )
                .unwrap();
            }
        }
        Self { dir, pids }
    }

    pub(crate) fn dir(&self) -> std::path::PathBuf {
        self.dir.path().to_path_buf()
    }

    /// Arm this thread's `gh` seam with the stub, bounded by `timeout`.
    pub(crate) fn arm(&self, timeout: std::time::Duration) {
        set_test_gh_stub(Some((gh_stub_program(self.dir.path()), self.dir(), timeout)));
    }

    /// The stub and its child both recorded their pids before the timeout;
    /// otherwise the orphan check below would prove nothing.
    pub(crate) fn started(&self) -> bool {
        self.recorded().len() == 2
    }

    pub(crate) fn recorded(&self) -> Vec<String> {
        std::fs::read_to_string(&self.pids)
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    /// Every recorded pid is gone: the stub and its child were killed.
    pub(crate) fn assert_gone(&self) {
        std::thread::sleep(std::time::Duration::from_millis(200));
        for pid in self.recorded() {
            assert!(!pid_alive(&pid), "pid {pid} outlived the timeout");
        }
    }
}

#[cfg(all(test, unix))]
fn pid_alive(pid: &str) -> bool {
    crate::platform::new_command("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// A pid that can't be opened, or whose process has an exit code, is gone.
#[cfg(all(test, windows))]
fn pid_alive(pid: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let pid: u32 = pid.parse().expect("a recorded pid");
    // SAFETY: a query-only handle, closed below.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if h.is_null() {
        return false;
    }
    let mut code = 0u32;
    // SAFETY: `h` is an open process handle, closed once.
    unsafe {
        let running = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
        CloseHandle(h);
        running
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::KanbanColumnId;

    /// R2: while a repository's issue writes are held, every write to an
    /// issue is refused in the hold's words before `gh` is reached; reads,
    /// and another repository's writes, go on.
    #[test]
    fn held_issue_writes_never_reach_gh() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();
        clear_test_gh_responses();
        set_test_issue_write_hold(Some("o/held"));
        let held = Err(ISSUE_WRITES_HELD.to_string());
        assert_eq!(issue_create("o/held", "held-card", "T", "b"), held.clone().map(|()| 0));
        assert_eq!(issue_create_without_waiting("o/held", "held-card", "T", "b"), held.clone().map(|()| 0));
        assert_eq!(issue_edit_body("o/held", 1, "b"), held);
        assert_eq!(issue_edit_title("o/held", 1, "T"), held);
        assert_eq!(issue_close("o/held", 1), held);
        assert_eq!(issue_add_assignee("o/held", 1, "@me"), held);
        assert_eq!(issue_remove_assignee_me("o/held", 1), held);
        assert_eq!(issue_comment("o/held", 1, "c"), held);
        assert_eq!(issue_set_labels("o/held", 1, &["status:todo"], &[]), held);
        assert!(take_test_gh_invocations().is_empty(), "gh was never asked");
        assert!(take_test_gh_stdin().is_empty());

        // A read of the held repository, and a write to another one, reach gh.
        set_test_gh_responses(vec![Ok("[]".into()), Ok(String::new())]);
        assert!(issue_list("o/held", "open", 10).unwrap().is_empty());
        assert_eq!(issue_close("o/other", 1), Ok(()));
        set_test_issue_write_hold(None);
        set_test_gh_responses(vec![Ok(String::new())]);
        assert_eq!(issue_close("o/held", 1), Ok(()), "released");
        clear_test_gh_responses();
        take_test_gh_invocations();
    }

    #[test]
    fn review_requested_prs_carry_their_opening_time() {
        // QoL 14.2 (F7): the Inbox row's time is the pull request's own.
        let raw: Vec<GhPrRaw> = serde_json::from_str(
            r#"[{"number":7,"title":"T","url":"u","author":{"login":"a"},"createdAt":"2026-10-20T08:00:00Z"},
                {"number":8,"title":"T","url":"u"}]"#,
        )
        .unwrap();
        assert_eq!(rfc3339_ms(raw[0].created_at.as_deref()), Some(1_792_483_200_000));
        assert_eq!(rfc3339_ms(raw[1].created_at.as_deref()), None);
        assert_eq!(rfc3339_ms(Some("not a time")), None);
    }

    fn issue(state: &str, labels: &[&str], assignees: &[&str]) -> GhIssue {
        GhIssue {
            number: 1,
            title: "t".into(),
            body: String::new(),
            assignees: assignees
                .iter()
                .map(|l| GhUser { login: l.to_string() })
                .collect(),
            labels: labels
                .iter()
                .map(|n| GhLabel { name: n.to_string() })
                .collect(),
            state: state.into(),
            updated_at: String::new(),
            author: None,
            created_at: None,
            state_reason: None,
            origin: None,
        }
    }

    #[test]
    fn claim_holder_for_none_mine_and_someone_else() {
        let logins = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(claim_holder(&[], "me"), ClaimHolder::Unclaimed);
        assert_eq!(claim_holder(&logins(&["Me"]), "me"), ClaimHolder::Mine);
        assert_eq!(claim_holder(&logins(&["other", "me"]), "me"), ClaimHolder::Mine);
        assert_eq!(
            claim_holder(&logins(&["test-owner"]), "me"),
            ClaimHolder::Others { logins: logins(&["test-owner"]) }
        );
        let i = issue("OPEN", &[], &["a", "b"]);
        assert_eq!(assignee_logins(&i), logins(&["a", "b"]));
    }

    #[test]
    fn label_for_each_column() {
        assert_eq!(label_for_column(&KanbanColumnId::Todo), "status:todo");
        assert_eq!(
            label_for_column(&KanbanColumnId::InProgress),
            "status:in-progress"
        );
        assert_eq!(label_for_column(&KanbanColumnId::Complete), "status:done");
    }

    #[test]
    fn closed_issue_is_always_complete() {
        assert_eq!(
            column_from_issue(&issue("CLOSED", &[], &[])),
            KanbanColumnId::Complete
        );
        // closed wins even over an in-progress label
        assert_eq!(
            column_from_issue(&issue("closed", &["status:in-progress"], &[])),
            KanbanColumnId::Complete
        );
    }

    #[test]
    fn open_issue_column_from_status_label() {
        assert_eq!(
            column_from_issue(&issue("OPEN", &["status:in-progress"], &[])),
            KanbanColumnId::InProgress
        );
        assert_eq!(
            column_from_issue(&issue("OPEN", &["status:done"], &[])),
            KanbanColumnId::Complete
        );
        assert_eq!(
            column_from_issue(&issue("OPEN", &["status:todo"], &[])),
            KanbanColumnId::Todo
        );
        // no status label → Todo
        assert_eq!(
            column_from_issue(&issue("OPEN", &["bug"], &[])),
            KanbanColumnId::Todo
        );
    }

    #[test]
    fn claim_predicate_is_case_insensitive() {
        let a = assignee_logins(&issue("OPEN", &[], &["DevUser", "other"]));
        assert_eq!(claim_holder(&a, "devuser"), ClaimHolder::Mine);
        assert_eq!(claim_holder(&a, "other"), ClaimHolder::Mine);
        assert_eq!(claim_holder(&a, "nobody"), ClaimHolder::Others { logins: a.clone() });
    }

    #[test]
    fn labels_for_move_swaps_status() {
        let (add, remove) = labels_for_move(&KanbanColumnId::InProgress);
        assert_eq!(add, vec!["status:in-progress"]);
        assert!(remove.contains(&"status:todo"));
        assert!(remove.contains(&"status:done"));
        assert!(!remove.contains(&"status:in-progress"));
    }

    #[test]
    fn body_round_trips_notes_and_knowledge() {
        let body = build_issue_body(Some("the notes"), Some("the knowledge"), None);
        let parsed = parse_issue_body(&body);
        assert_eq!(parsed.notes.as_deref(), Some("the notes"));
        assert_eq!(parsed.knowledge.as_deref(), Some("the knowledge"));
        assert_eq!(parsed.raw_remainder, None);
    }

    #[test]
    fn body_omits_empty_fields() {
        let body = build_issue_body(Some("just notes"), None, None);
        assert!(body.contains("just notes"));
        assert!(!body.contains("atelier:knowledge"));
        let parsed = parse_issue_body(&body);
        assert_eq!(parsed.notes.as_deref(), Some("just notes"));
        assert_eq!(parsed.knowledge, None);
    }

    #[test]
    fn blank_fields_produce_empty_body() {
        assert_eq!(build_issue_body(Some("   "), Some(""), None), "");
    }

    #[test]
    fn body_round_trips_raw_remainder() {
        // A human's free-form text must survive a Ply write-back: build with
        // the remainder re-appended, then re-parse and confirm all three
        // fields come back intact (idempotent round-trip — decision 10).
        let body = build_issue_body(
            Some("the notes"),
            Some("the knowledge"),
            Some("Someone typed this on GitHub."),
        );
        let parsed = parse_issue_body(&body);
        assert_eq!(parsed.notes.as_deref(), Some("the notes"));
        assert_eq!(parsed.knowledge.as_deref(), Some("the knowledge"));
        assert_eq!(
            parsed.raw_remainder.as_deref(),
            Some("Someone typed this on GitHub.")
        );
        // Building again from the parsed fields yields the same body.
        let rebuilt = build_issue_body(
            parsed.notes.as_deref(),
            parsed.knowledge.as_deref(),
            parsed.raw_remainder.as_deref(),
        );
        assert_eq!(rebuilt, body);
    }

    #[test]
    fn parse_preserves_freeform_text_outside_markers() {
        let body = format!(
            "Someone typed this on GitHub.\n\n{NOTES_OPEN}\nthe notes\n{NOTES_CLOSE}\n"
        );
        let parsed = parse_issue_body(&body);
        assert_eq!(parsed.notes.as_deref(), Some("the notes"));
        assert_eq!(
            parsed.raw_remainder.as_deref(),
            Some("Someone typed this on GitHub.")
        );
    }

    #[test]
    fn parse_empty_body_is_all_none() {
        assert_eq!(parse_issue_body(""), ParsedIssueBody::default());
    }

    #[test]
    fn parse_unmarked_body_is_all_remainder() {
        // An issue filed on GitHub the normal way: no markers at all.
        let body = "## What happened\n\nThe brief is empty.\n";
        let parsed = parse_issue_body(body);
        assert_eq!(parsed.notes, None);
        assert_eq!(parsed.knowledge, None);
        assert_eq!(
            parsed.raw_remainder.as_deref(),
            Some("## What happened\n\nThe brief is empty.")
        );
    }

    #[test]
    fn unmarked_body_is_adopted_as_notes_when_card_has_none() {
        let parsed = parse_issue_body("Plain issue text.\n");
        for local in [None, Some(""), Some("  \n")] {
            let adopted = adopt_unmarked_body(&parsed, local).expect("adopted");
            assert_eq!(adopted.notes.as_deref(), Some("Plain issue text."));
            assert_eq!(adopted.knowledge, None);
            assert_eq!(adopted.raw_remainder, None, "the text moves, not copies");
        }
    }

    #[test]
    fn unmarked_body_is_not_adopted_over_existing_notes_or_markers() {
        let parsed = parse_issue_body("Plain issue text.");
        assert_eq!(adopt_unmarked_body(&parsed, Some("mine")), None);
        // A body with a marker block is Ply's: its remainder stays a remainder.
        let marked = parse_issue_body(&build_issue_body(None, Some("k"), Some("extra")));
        assert_eq!(adopt_unmarked_body(&marked, None), None);
        let noted = parse_issue_body(&build_issue_body(Some("n"), None, Some("extra")));
        assert_eq!(adopt_unmarked_body(&noted, None), None);
        // Nothing to adopt.
        assert_eq!(adopt_unmarked_body(&parse_issue_body(""), None), None);
    }

    #[test]
    fn adopted_body_round_trips_with_markers_written_once() {
        let original = "Plain issue text.\n\n- a list\n";
        let adopted = adopt_unmarked_body(&parse_issue_body(original), None).unwrap();
        let body = build_issue_body(
            adopted.notes.as_deref(),
            adopted.knowledge.as_deref(),
            adopted.raw_remainder.as_deref(),
        );
        assert_eq!(body.matches(NOTES_OPEN).count(), 1);
        assert_eq!(body.matches(NOTES_CLOSE).count(), 1);
        let reparsed = parse_issue_body(&body);
        assert_eq!(reparsed.notes.as_deref(), Some(original.trim()));
        assert_eq!(reparsed.raw_remainder, None);
        // The marked body is no longer adoptable, and rebuilding is stable.
        assert_eq!(adopt_unmarked_body(&reparsed, None), None);
        let rebuilt = build_issue_body(
            reparsed.notes.as_deref(),
            reparsed.knowledge.as_deref(),
            reparsed.raw_remainder.as_deref(),
        );
        assert_eq!(rebuilt, body);
    }

    #[test]
    fn notes_with_remainder_appends_below_existing_notes() {
        assert_eq!(notes_with_remainder(Some("mine"), " theirs \n"), "mine\n\ntheirs");
        assert_eq!(notes_with_remainder(None, "theirs"), "theirs");
        assert_eq!(notes_with_remainder(Some("  "), "theirs"), "theirs");
    }

    #[test]
    fn issue_number_parsed_from_url() {
        assert_eq!(
            issue_number_from_url("https://github.com/o/r/issues/42"),
            Some(42)
        );
        assert_eq!(issue_number_from_url("garbage"), None);
    }

    // ── GH #204: every gh call is bounded ─────────────────────────────

    /// Run `call` against a stalled stub with growing bounds until the stub
    /// has started its child before the bound (GH #130: a loaded machine
    /// can delay the stub's start); returns the error and the stub.
    fn against_a_stalled_gh(
        verbs: &[&str],
        call: impl Fn() -> Result<String, String>,
    ) -> (String, std::time::Duration, StalledGh) {
        let mut last = None;
        for secs in [2, 5, 15] {
            let timeout = std::time::Duration::from_secs(secs);
            let stub = StalledGh::new(verbs);
            stub.arm(timeout);
            let started = std::time::Instant::now();
            let result = call();
            set_test_gh_stub(None);
            let elapsed = started.elapsed();
            let err = result.expect_err("a stalled gh can't answer");
            assert!(
                elapsed < timeout + std::time::Duration::from_secs(5),
                "returned after {elapsed:?} for a {timeout:?} bound"
            );
            stub.assert_gone();
            if stub.started() {
                return (err, timeout, stub);
            }
            last = Some(stub);
        }
        panic!(
            "test setup failure: the stub never recorded its child before the timeout: {:?}",
            last.map(|s| s.recorded())
        );
    }

    #[test]
    fn a_stalled_gh_api_call_is_stopped_at_its_bound_with_its_children() {
        let _guard = test_serial_lock();
        invalidate_login_cache();
        let (err, timeout, _stub) = against_a_stalled_gh(&["api"], current_login);
        assert!(is_gh_timeout(&err), "{err}");
        assert!(err.contains("`gh api user`"), "{err}");
        assert!(err.contains(&format!("stopped after {}s", timeout.as_secs())), "{err}");
        // A timeout is "could not ask", never a refusal.
        assert_eq!(classify_gh_error(&err), GhErrorKind::Unreachable);
        assert!(LOGIN_CACHE.lock().unwrap().is_none(), "a timeout is never cached");
    }

    #[test]
    fn a_stalled_gh_issue_call_is_stopped_at_its_bound_with_its_children() {
        let _guard = test_serial_lock();
        let (err, _, _stub) = against_a_stalled_gh(&["issue"], || {
            issue_view("o/r", 62).map(|issue| issue.title)
        });
        assert!(is_gh_timeout(&err) && err.contains("`gh issue view`"), "{err}");
    }

    /// The ship path's reader ([`gh_output`], behind `commands::ship_gh`)
    /// is the same bounded runner.
    #[test]
    fn a_stalled_gh_pr_create_is_stopped_at_its_bound_with_its_children() {
        let _guard = test_serial_lock();
        let (err, _, _stub) = against_a_stalled_gh(&["pr"], || {
            // The stub and bound the helper armed, called directly.
            let (program, dir, timeout) = TEST_GH_STUB.with(|s| s.borrow().clone().unwrap());
            gh_output(&program, Some(&dir), &["pr", "create", "--title", "t"], timeout)
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        });
        assert!(is_gh_timeout(&err) && err.contains("`gh pr create`"), "{err}");
    }

    /// A gh that answers — with a refusal — is read exactly as before: its
    /// stderr, trimmed, is the error; its stdout, trimmed, the answer.
    #[test]
    fn a_bounded_gh_that_answers_is_read_as_before() {
        let _guard = test_serial_lock();
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            std::fs::write(dir.path().join("api"), "echo '  me  '\n").unwrap();
            std::fs::write(
                dir.path().join("issue"),
                "echo 'GraphQL: Could not resolve (HTTP 404)' >&2\nexit 1\n",
            )
            .unwrap();
        }
        #[cfg(windows)]
        {
            std::fs::write(dir.path().join("api.cmd"), "@echo   me  \r\n").unwrap();
            std::fs::write(
                dir.path().join("issue.cmd"),
                "@echo GraphQL: Could not resolve (HTTP 404)>&2\r\n@exit /b 1\r\n",
            )
            .unwrap();
        }
        set_test_gh_stub(Some((
            gh_stub_program(dir.path()),
            dir.path().to_path_buf(),
            std::time::Duration::from_secs(20),
        )));
        invalidate_login_cache();
        let login = current_login();
        let refused = issue_view("o/r", 1).map(|i| i.title);
        set_test_gh_stub(None);
        invalidate_login_cache();
        assert_eq!(login.unwrap(), "me");
        assert_eq!(refused.unwrap_err(), "GraphQL: Could not resolve (HTTP 404)");
    }

    // ── GH #204 review 1–2: a timed-out create never makes a second issue ──

    fn create_timed_out() -> Result<String, String> {
        Err(format!(
            "{GH_TIMED_OUT}: `gh issue create` was stopped after 60s. Check the connection and try again."
        ))
    }

    fn created_list(entries: &[(u64, &str, &str, chrono::DateTime<chrono::Utc>)]) -> Result<String, String> {
        let issues: Vec<_> = entries
            .iter()
            .map(|(n, t, b, at)| {
                serde_json::json!({"number": n, "title": t, "body": b, "createdAt": at.to_rfc3339()})
            })
            .collect();
        Ok(serde_json::to_string(&issues).unwrap())
    }

    fn verbs(calls: &[Vec<String>]) -> Vec<String> {
        calls.iter().map(|c| c[..2].join(" ")).collect()
    }

    /// The create timed out but GitHub made the issue: the lookup (one page,
    /// the 30 s API bound) finds it — this title and body (`\r\n` or not),
    /// created inside the attempt's window — and that is the answer.
    #[test]
    fn a_timed_out_create_that_github_made_is_found_not_made_again() {
        let _guard = test_serial_lock();
        let now = chrono::Utc::now();
        take_test_gh_invocations();
        take_test_gh_timeouts();
        set_test_gh_responses(vec![
            create_timed_out(),
            created_list(&[
                (7, "Found card", "old body", now), // same title, other body
                (41, "Found card", "the\nbody", now - chrono::Duration::days(3)), // an older twin
                (40, "Found card", "the\nbody", now + chrono::Duration::minutes(30)), // after the window
                (42, "Found card", "the\r\nbody\r\n", now),
            ]),
        ]);
        let number = issue_create("o/r", "card-found", "Found card", "the\nbody");
        let calls = take_test_gh_invocations();
        let bounds = take_test_gh_timeouts();
        clear_test_gh_responses();
        assert_eq!(number.unwrap(), 42);
        assert_eq!(verbs(&calls), ["issue create", "issue list"]);
        assert!(calls[1].join(" ").contains("--author @me"), "{calls:?}");
        assert_eq!(bounds, [GH_CREATE_TIMEOUT, GH_API_TIMEOUT], "the lookup is one page");
    }

    /// Not there yet (or GitHub couldn't be asked): the timeout is reported,
    /// and the next create of the same card looks again before creating.
    #[test]
    fn a_timed_out_create_is_looked_for_again_before_a_second_create() {
        let _guard = test_serial_lock();
        let now = chrono::Utc::now();
        take_test_gh_invocations();
        set_test_gh_responses(vec![create_timed_out(), created_list(&[])]);
        let first = issue_create("o/r", "card-late", "Late card", "b");
        assert!(is_gh_timeout(&first.unwrap_err()));
        // Sync retries: the issue has appeared meanwhile.
        set_test_gh_responses(vec![created_list(&[(43, "Late card", "b", now)])]);
        let second = issue_create("o/r", "card-late", "Late card", "b");
        let calls = take_test_gh_invocations();
        assert_eq!(second.unwrap(), 43);
        assert_eq!(verbs(&calls), ["issue create", "issue list", "issue list"], "no second create");

        // The lookup can't reach GitHub: still no create, and the next try
        // looks again.
        set_test_gh_responses(vec![create_timed_out(), Err("error connecting to api.github.com".into())]);
        assert!(issue_create("o/r", "card-offline", "Offline card", "b").is_err());
        set_test_gh_responses(vec![Err("error connecting to api.github.com".into())]);
        let err = issue_create("o/r", "card-offline", "Offline card", "b").unwrap_err();
        assert!(err.contains("timed-out create"), "{err}");
        // GitHub answers: it was never made, so now it is created once.
        set_test_gh_responses(vec![
            created_list(&[]),
            Ok("https://github.com/o/r/issues/44".into()),
        ]);
        assert_eq!(issue_create("o/r", "card-offline", "Offline card", "b").unwrap(), 44);
        let calls = take_test_gh_invocations();
        clear_test_gh_responses();
        assert_eq!(
            verbs(&calls),
            ["issue create", "issue list", "issue list", "issue list", "issue create"]
        );
        // Settled: a later create of that card is an ordinary create.
        set_test_gh_responses(vec![Ok("https://github.com/o/r/issues/45".into())]);
        assert_eq!(issue_create("o/r", "card-offline", "Offline card", "b").unwrap(), 45);
        clear_test_gh_responses();
    }

    /// 1.175.0 D4 (TM-9): a brief longer than a Windows command line
    /// (32,767 characters) still becomes an issue and is still edited: the
    /// body is on gh's stdin, and no argument holds it.
    #[test]
    fn a_forty_thousand_character_body_goes_to_gh_on_stdin_for_create_and_edit() {
        let _guard = test_serial_lock();
        let body = "log line\n".repeat(4_445);
        assert!(body.len() >= 40_000);
        take_test_gh_invocations();
        take_test_gh_stdin();
        set_test_gh_responses(vec![Ok("https://github.com/o/r/issues/61".into()), Ok(String::new())]);
        assert_eq!(issue_create("o/r", "card-long", "Long card", &body).unwrap(), 61);
        issue_edit_body("o/r", 61, &body).unwrap();
        let calls = take_test_gh_invocations();
        let fed = take_test_gh_stdin();
        clear_test_gh_responses();
        assert_eq!(
            calls,
            [
                vec!["issue", "create", "--repo", "o/r", "--title", "Long card", "--body-file", "-"],
                vec!["issue", "edit", "61", "--repo", "o/r", "--body-file", "-"],
            ]
        );
        assert_eq!(fed, [body.clone(), body]);
        for call in &calls {
            assert!(call.iter().map(String::len).sum::<usize>() < 200, "no argument carries the body");
        }
    }

    /// 1.175.0 G6: a card's outcome is posted the same way.
    #[test]
    fn a_forty_thousand_character_comment_goes_to_gh_on_stdin() {
        let _guard = test_serial_lock();
        let body = "log line\n".repeat(4_445);
        take_test_gh_invocations();
        take_test_gh_stdin();
        set_test_gh_responses(vec![Ok(String::new())]);
        issue_comment("o/r", 61, &body).unwrap();
        let calls = take_test_gh_invocations();
        let fed = take_test_gh_stdin();
        clear_test_gh_responses();
        assert_eq!(calls, [vec!["issue", "comment", "61", "--repo", "o/r", "--body-file", "-"]]);
        assert_eq!(fed, [body]);
    }

    /// Review 2: the memory is the card's. Another card with the same title
    /// and an empty body creates normally; and the card's own lookup never
    /// takes the other card's issue made outside its windows.
    #[test]
    fn a_timed_out_create_is_remembered_for_its_card_only() {
        let _guard = test_serial_lock();
        let now = chrono::Utc::now();
        take_test_gh_invocations();
        set_test_gh_responses(vec![create_timed_out(), created_list(&[])]);
        assert!(issue_create("o/r", "card-a", "Same title", "").is_err());
        set_test_gh_responses(vec![Ok("https://github.com/o/r/issues/50".into())]);
        assert_eq!(issue_create("o/r", "card-b", "Same title", "").unwrap(), 50);
        assert_eq!(verbs(&take_test_gh_invocations()), ["issue create", "issue list", "issue create"]);
        // Card A's retry: B's #50 is an hour later than A's window.
        set_test_gh_responses(vec![
            created_list(&[(50, "Same title", "", now + chrono::Duration::hours(1))]),
            Ok("https://github.com/o/r/issues/51".into()),
        ]);
        assert_eq!(issue_create("o/r", "card-a", "Same title", "").unwrap(), 51);
        clear_test_gh_responses();
    }

    /// Review 2: every timed-out attempt of a card keeps its own window; an
    /// issue made during the first attempt is still found after a second
    /// timed out.
    #[test]
    fn each_timed_out_attempt_keeps_its_window() {
        let _guard = test_serial_lock();
        let first_attempt = chrono::Utc::now();
        take_test_gh_invocations();
        set_test_gh_responses(vec![create_timed_out(), created_list(&[])]);
        assert!(issue_create("o/r", "card-twice", "Twice", "b").is_err());
        let first = unconfirmed_windows(&("o/r".into(), "card-twice".into()));
        assert_eq!(first.len(), 1);
        assert!(first[0].holds(first_attempt));
        // A second attempt whose lookup can't reach GitHub keeps the first
        // window, and a third, later attempt finds the issue the first made.
        set_test_gh_responses(vec![Err("offline".into())]);
        assert!(issue_create("o/r", "card-twice", "Twice", "b").is_err());
        assert_eq!(unconfirmed_windows(&("o/r".into(), "card-twice".into())), first);
        set_test_gh_responses(vec![created_list(&[(60, "Twice", "b", first_attempt)])]);
        assert_eq!(issue_create("o/r", "card-twice", "Twice", "b").unwrap(), 60);
        assert!(unconfirmed_windows(&("o/r".into(), "card-twice".into())).is_empty());
        clear_test_gh_responses();
        take_test_gh_invocations();
    }

    /// Review 2: on the main thread (a card just created on the board) the
    /// create is the only wait — no lookup there; the attempt is left to
    /// Sync, and a second main-thread create of that card doesn't run.
    #[test]
    fn the_main_thread_create_leaves_the_lookup_to_sync() {
        let _guard = test_serial_lock();
        let now = chrono::Utc::now();
        take_test_gh_invocations();
        set_test_gh_responses(vec![create_timed_out()]);
        assert!(issue_create_without_waiting("o/r", "card-main", "Main", "b").is_err());
        assert!(issue_create_without_waiting("o/r", "card-main", "Main", "b").is_err());
        assert_eq!(verbs(&take_test_gh_invocations()), ["issue create"], "no lookup, no second create");
        // Sync (a worker) looks, finds it, and doesn't create.
        set_test_gh_responses(vec![created_list(&[(70, "Main", "b", now)])]);
        assert_eq!(issue_create("o/r", "card-main", "Main", "b").unwrap(), 70);
        assert_eq!(verbs(&take_test_gh_invocations()), ["issue list"]);
        clear_test_gh_responses();
    }

    /// GitHub's own refusal is not a timeout: no lookup, nothing remembered.
    #[test]
    fn a_refused_create_is_not_looked_for() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();
        set_test_gh_responses(vec![Err("HTTP 410: Issues are disabled".into())]);
        assert!(issue_create("o/r", "card-refused", "Refused card", "b").is_err());
        set_test_gh_responses(vec![Ok("https://github.com/o/r/issues/46".into())]);
        assert_eq!(issue_create("o/r", "card-refused", "Refused card", "b").unwrap(), 46);
        let calls = take_test_gh_invocations();
        clear_test_gh_responses();
        assert_eq!(verbs(&calls), ["issue create", "issue create"]);
    }

    /// GH #204 review 1: a gh whose answer can't be read to the end (a
    /// process outside its group holds the pipe) is an error — never "", which
    /// would be cached as the login. Unix only, as `worktrees`' own test of
    /// this: on Windows a holder has to break away from the Job Object with
    /// the pipe inherited, which no stock tool does.
    #[cfg(unix)]
    #[test]
    fn a_gh_answer_that_cant_be_read_whole_is_an_error_not_empty() {
        let _guard = test_serial_lock();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("api"),
            // The answer only once the holder is in its own session, so the
            // group kill after exit can't reach it first.
            "perl -e 'use POSIX; POSIX::setsid(); open(my $f, \">\", \"ready\"); close $f; sleep 6' &\n\
             while [ ! -f ready ]; do sleep 0.05; done\necho me\n",
        )
        .unwrap();
        set_test_gh_stub(Some((
            "/bin/sh".into(),
            dir.path().to_path_buf(),
            std::time::Duration::from_secs(20),
        )));
        invalidate_login_cache();
        let login = current_login();
        set_test_gh_stub(None);
        let err = login.unwrap_err();
        assert!(err.contains("whole answer"), "{err}");
        assert!(LOGIN_CACHE.lock().unwrap().is_none(), "nothing cached");
    }

    /// Network API calls get [`GH_API_TIMEOUT`]; a clone, which moves the
    /// whole repository, [`GH_CLONE_TIMEOUT`]. The app's `run_gh` bounds
    /// every call by this choice.
    #[test]
    fn each_gh_call_kind_has_its_bound() {
        assert_eq!(gh_timeout_for(&["repo", "clone", "o/r", "/tmp/x"]), GH_CLONE_TIMEOUT);
        assert_eq!(gh_timeout_for(&["issue", "list", "--repo", "o/r"]), GH_LIST_TIMEOUT);
        assert_eq!(gh_timeout_for(&["issue", "create", "--repo", "o/r"]), GH_CREATE_TIMEOUT);
        assert_eq!(gh_timeout_for(&["label", "create", "x"]), GH_API_TIMEOUT);
        for args in [
            &["api", "user", "--jq", ".login"][..],
            &["issue", "view", "1", "--repo", "o/r"],
            &["issue", "edit", "1"],
            &["pr", "list", "--repo", "o/r"],
            &["repo", "create", "o/r", "--private"],
        ] {
            assert_eq!(gh_timeout_for(args), GH_API_TIMEOUT, "{args:?}");
        }
        assert_eq!(GH_API_TIMEOUT, std::time::Duration::from_secs(30));
        assert_eq!(GH_CREATE_TIMEOUT, std::time::Duration::from_secs(60));
        assert_eq!(GH_LIST_TIMEOUT, std::time::Duration::from_secs(90));
        assert_eq!(GH_CLONE_TIMEOUT, std::time::Duration::from_secs(600));
        let module = include_str!("github.rs");
        let run = &module[module.find("\nfn run_gh(").unwrap()..];
        assert!(run[..200].contains("run_gh_within(args, gh_timeout_for(args))"));
        let live = &module[module.find("#[cfg(not(test))]\nfn run_gh_within(").unwrap()..];
        assert!(live[..300].contains("run_gh_bounded(&gh, None, args, timeout)"));
    }

    /// No `gh` Ply runs is spawned unbounded (GH #204 review 1: every source
    /// file). Every `new_command(…)` outside tests whose program is a `gh`
    /// (named so, `self.path` in `shared_config::Gh`, or the doctor's
    /// `tool_path` in `probe_command_version_within`) goes to the process-group runner within the next lines:
    /// `worktrees::run_bounded_output` (or SL-2's `run_bounded_output_tail`,
    /// or `run_bounded_output_with_stdin`, the same runner with stdin fed)
    /// or `run_bounded`. The direct-child
    /// `shell_env::output_with_timeout` does not count.
    #[test]
    fn no_gh_is_spawned_without_a_bound() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut seen = 0;
        for entry in std::fs::read_dir(&src).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let code = source.split("#[cfg(test)]\nmod tests").next().unwrap();
            for (at, _) in code.match_indices("new_command(") {
                let arg = &code[at + "new_command(".len()..];
                let arg = &arg[..arg.find(')').unwrap_or(0)];
                let lower = arg.to_ascii_lowercase();
                let before = &code[..at];
                let enclosing = before[before.rfind("fn ").unwrap_or(0)..]
                    .split('(')
                    .next()
                    .unwrap_or_default();
                // `tool_path` is `gh` (or `git`) in the doctor's version probe;
                // the claude / codex probe (`probe_command_version`) is not gh.
                let is_gh = lower.contains("gh")
                    || arg == "&self.path"
                    || (arg == "tool_path" && enclosing == "fn probe_command_version_within");
                if !is_gh {
                    continue;
                }
                seen += 1;
                let after = &code[at..(at + 700).min(code.len())];
                // `run_bounded_output_with_stdin` is the same runner with the
                // child's stdin fed from a file (a pull request's body):
                // `shared_config::Gh::run_with_body` uses it alone.
                let bounded = after.contains("run_bounded_output(")
                    || after.contains("run_bounded_output_tail(")
                    || after.contains("run_bounded_output_with_stdin(")
                    || after.contains("crate::worktrees::run_bounded(");
                assert!(bounded, "{name}: unbounded `new_command({arg})`:\n{after}");
            }
        }
        assert!(seen >= 4, "the scan found the known gh spawns: {seen}");
        let commands = include_str!("commands.rs");
        let ship_gh = &commands[commands.find("fn ship_gh(").unwrap()..];
        assert!(ship_gh[..300].contains("gh_output(gh, Some(wt), args, crate::shared_config::GH_TIMEOUT)"));
        // 1.170.0: every call below goes through `ship_gh` (gh_output +
        // GH_TIMEOUT) inside the workspace's account scope
        // (`github_account::enter_for_workspace`). New since 1.169.1: G1's
        // sign-in preflight (`pr_github_preflight`: `gh auth token`), G1–G3's
        // hold/resume of auto-merge after Push update (`gh_answer` closure),
        // G4's read of the PR text (`card_pr_text`) and its re-read before an
        // edit (`card_pr_edit`). G4 moved the PR body edit to
        // `ship_gh_with_body` (stdin), so that `ship_gh(` site left.
        // 1.174.0 X1: the card pull request commands moved to
        // `card_pr_commands.rs`, a child of `commands`; counted with it.
        let card_pr = include_str!("card_pr_commands.rs");
        assert_eq!(
            commands.matches("ship_gh(").count() + card_pr.matches("ship_gh(").count(),
            11,
            "PR-flow reads (head, default branch, Ship's view, PR body), the comment, SL-3's auto-merge after ship, G1's sign-in preflight, G1–G3's hold after Push update, G4's PR text read and re-read, and the helper"
        );
        // R12 (Challenger): `gh pr create` takes its body on stdin, through
        // the same bounded runner.
        let with_body = &commands[commands.find("fn ship_gh_with_body(").unwrap()..];
        assert!(with_body[..300].contains("crate::github::gh_output_with_stdin(gh, Some(wt), args, crate::shared_config::GH_TIMEOUT, body)"));
        assert_eq!(
            commands.matches("let out = ship_gh_with_body(").count() + card_pr.matches("let out = ship_gh_with_body(").count(),
            2,
            "the pull request's create (`open_branch_pr`, 1.173.0 A3) and G4's edit of its title and description (`card_pr_edit`)"
        );
    }

}

#[cfg(test)]
mod login_cache_tests {
    use super::*;
    use std::time::{Duration, Instant};

    // The cache is process-global; serialize these tests against each other
    // (and against the team-module tests) and start each from a
    // known-empty state.
    use super::test_serial_lock;

    #[test]
    fn login_is_reused_inside_the_ttl_without_calling_gh() {
        let _guard = test_serial_lock();
        invalidate_login_cache();
        set_test_gh_responses(vec![Ok("octocat".into())]);
        let t0 = Instant::now();
        assert_eq!(current_login_at(t0).unwrap(), "octocat");
        // Queue is now empty: a second gh call would fail loudly.
        assert_eq!(
            current_login_at(t0 + LOGIN_CACHE_TTL - Duration::from_secs(1)).unwrap(),
            "octocat"
        );
        clear_test_gh_responses();
        invalidate_login_cache();
    }

    #[test]
    fn login_is_refreshed_after_the_ttl_so_an_account_switch_is_seen() {
        let _guard = test_serial_lock();
        invalidate_login_cache();
        set_test_gh_responses(vec![Ok("octocat".into()), Ok("hubot".into())]);
        let t0 = Instant::now();
        assert_eq!(current_login_at(t0).unwrap(), "octocat");
        assert_eq!(current_login_at(t0 + LOGIN_CACHE_TTL).unwrap(), "hubot");
        clear_test_gh_responses();
        invalidate_login_cache();
    }

    #[test]
    fn invalidation_forces_a_fresh_lookup_and_failures_are_not_cached() {
        let _guard = test_serial_lock();
        invalidate_login_cache();
        set_test_gh_responses(vec![Err("offline".into()), Ok("octocat".into())]);
        let t0 = Instant::now();
        assert!(current_login_at(t0).is_err());
        assert_eq!(current_login_at(t0).unwrap(), "octocat");
        invalidate_login_cache();
        set_test_gh_responses(vec![Ok("hubot".into())]);
        assert_eq!(current_login_at(t0).unwrap(), "hubot");
        clear_test_gh_responses();
        invalidate_login_cache();
    }

    /// v1.114.0 (team sharing rung 1): the GitHub half of the membership
    /// rule. "GitHub said no" and "we could not ask GitHub" must not
    /// collapse into one another — the first locks a member out, the
    /// second is a train tunnel.
    #[test]
    fn repo_access_separates_a_refusal_from_an_unreachable_gh() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();

        set_test_gh_responses(vec![Ok("true\ntrue".into())]);
        let access = repo_access("owner/team").unwrap();
        assert!(access.pull);
        assert_eq!(access.push, Some(true));
        let calls = take_test_gh_invocations();
        assert_eq!(
            calls[0],
            vec![
                "api",
                "repos/owner/team",
                "--jq",
                ".permissions.pull, .permissions.push"
            ]
        );

        // A repo the account cannot see: gh reports the HTTP status.
        set_test_gh_responses(vec![Err("gh: Not Found (HTTP 404)".into())]);
        assert_eq!(repo_access("owner/team").unwrap(), RepoAccess::denied());

        set_test_gh_responses(vec![Err("gh: Forbidden (HTTP 403)".into())]);
        assert_eq!(repo_access("owner/team").unwrap(), RepoAccess::denied());

        // Explicit `pull: false` is a refusal too.
        set_test_gh_responses(vec![Ok("false\nfalse".into())]);
        assert!(!repo_access("owner/team").unwrap().pull);

        // v1.117.0: read access without write access — the common case for a
        // member who may use the team library but not share into it.
        set_test_gh_responses(vec![Ok("true\nfalse".into())]);
        let access = repo_access("owner/team").unwrap();
        assert!(access.pull);
        assert_eq!(access.push, Some(false));

        // A `permissions` block GitHub did not send says nothing about
        // writing, which is not the same as saying no.
        set_test_gh_responses(vec![Ok("null\nnull".into())]);
        let access = repo_access("owner/team").unwrap();
        assert!(access.pull);
        assert_eq!(access.push, None);

        // Offline stays an error — never a "you are not in the team".
        set_test_gh_responses(vec![Err(
            "dial tcp: lookup api.github.com: no such host".into(),
        )]);
        assert!(repo_access("owner/team").is_err());

        clear_test_gh_responses();
        take_test_gh_invocations();
    }

    #[test]
    fn only_githubs_own_words_mean_no_such_account() {
        assert!(is_not_a_user("gh: plyloft-walk-no-such-login-7f3k is not a user (HTTP 404)"));
        assert!(!is_not_a_user("gh: Not Found (HTTP 404)"), "a repository out of reach");
        assert!(!is_not_a_user("is not a user (HTTP 500)"));
        assert!(!is_not_a_user("dial tcp: no such host"));
        assert!(!CollaboratorAccess::NoSuchAccount.can_push());
    }

    /// v1.114.0: GitHub answers 403 both for "you may not read this" and
    /// for "you are asking too often". Only the first is an access answer;
    /// the second must not tell a member to go ask for an invitation.
    #[test]
    fn a_rate_limited_403_is_not_a_denial() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();

        // The primary limit, as `gh` prints it.
        set_test_gh_responses(vec![Err(
            "gh: API rate limit exceeded for user ID 4242. (HTTP 403)".into(),
        )]);
        let err = repo_access("owner/team").unwrap_err();
        assert!(err.contains("rate-limiting"), "{err}");
        assert!(err.contains("try again"), "{err}");

        // The header shape, and the secondary (burst) limit.
        set_test_gh_responses(vec![Err(
            "HTTP 403: x-ratelimit-remaining: 0, x-ratelimit-reset: 1780000000".into(),
        )]);
        assert!(repo_access("owner/team")
            .unwrap_err()
            .contains("rate-limiting"));
        set_test_gh_responses(vec![Err(
            "gh: You have exceeded a secondary rate limit. Retry-After: 60 (HTTP 403)".into(),
        )]);
        assert!(repo_access("owner/team")
            .unwrap_err()
            .contains("rate-limiting"));

        // A plain 403 is still a denial.
        set_test_gh_responses(vec![Err("gh: Forbidden (HTTP 403)".into())]);
        assert_eq!(repo_access("owner/team").unwrap(), RepoAccess::denied());

        assert_eq!(
            classify_gh_error("gh: Not Found (HTTP 404)"),
            GhErrorKind::Denied
        );
        assert_eq!(
            classify_gh_error("dial tcp: no such host"),
            GhErrorKind::Unreachable
        );

        clear_test_gh_responses();
        take_test_gh_invocations();
    }

    #[test]
    fn repo_clone_passes_slug_and_destination_to_gh() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();
        set_test_gh_responses(vec![Ok(String::new())]);
        repo_clone("owner/team", std::path::Path::new("/tmp/ply-team")).unwrap();
        let calls = take_test_gh_invocations();
        assert_eq!(
            calls[0],
            vec!["repo", "clone", "owner/team", "/tmp/ply-team"]
        );
        clear_test_gh_responses();
    }

    /// H1 Windows walk: a library clone's own config carries `core.longpaths`
    /// from its first checkout (`git clone -c`, after gh's `--`).
    #[test]
    fn library_repo_clone_sets_core_longpaths_in_the_clone() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();
        set_test_gh_responses(vec![Ok(String::new())]);
        library_repo_clone("owner/team", std::path::Path::new("/tmp/ply-team")).unwrap();
        let calls = take_test_gh_invocations();
        assert_eq!(
            calls[0],
            vec!["repo", "clone", "owner/team", "/tmp/ply-team", "--", "-c", "core.longpaths=true"]
        );
        assert_eq!(gh_timeout_for(&["repo", "clone", "o/r", "/tmp/x", "--", "-c", "x"]), GH_CLONE_TIMEOUT);
        clear_test_gh_responses();
    }
}

#[cfg(test)]
mod linked_pr_tests {
    use super::*;

    fn pr(number: u64, state: &str, author: &str, repo: &str) -> serde_json::Value {
        serde_json::json!({
            "number": number,
            "url": format!("https://github.com/{repo}/pull/{number}"),
            "state": state, "isDraft": false,
            "author": {"login": author}, "repository": {"nameWithOwner": repo}
        })
    }

    fn typed(mut v: serde_json::Value) -> serde_json::Value {
        v["__typename"] = "PullRequest".into();
        v
    }

    fn answer(closing: Vec<serde_json::Value>, events: Vec<serde_json::Value>) -> String {
        serde_json::json!({"data": {"repository": {"issue": {
            "closedByPullRequestsReferences": {"nodes": closing},
            "timelineItems": {"nodes": events}
        }}}})
        .to_string()
    }

    #[test]
    fn a_merged_closing_pull_request_stays_linked() {
        // Challenger P1: the real answer's shape for an issue whose
        // "Closes #21" PR merged — it is still in GitHub's closing list.
        let repo = "test-owner/plyloft-ci-sandbox";
        let json = r#"{"data":{"repository":{"issue":{
            "closedByPullRequestsReferences":{"nodes":[
              {"number":23,"url":"https://github.com/test-owner/plyloft-ci-sandbox/pull/23","state":"MERGED","isDraft":false,"author":{"login":"test-user"},"repository":{"nameWithOwner":"test-owner/plyloft-ci-sandbox"}}
            ]},
            "timelineItems":{"nodes":[]}}}}}"#;
        let prs = linked_prs_from_issue(json, repo).unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 23);
        assert_eq!(prs[0].state, "merged");
        assert_eq!(prs[0].author.as_deref(), Some("test-user"));
        assert_eq!(prs[0].url, format!("https://github.com/{repo}/pull/23"));
    }

    /// U28: one link per issue, the newest pull request (first in the list)
    /// for an issue with two, and none for another repository's issue.
    #[test]
    fn open_pr_links_read_the_closing_issues_of_this_repository() {
        let here = serde_json::json!({"owner": {"login": "O"}, "name": "r"});
        let json = serde_json::json!([
            {"number": 9, "author": {"login": "ana"}, "closingIssuesReferences": [
                {"number": 21, "repository": here},
                {"number": 7, "repository": {"owner": {"login": "o"}, "name": "other"}},
            ]},
            {"number": 8, "author": {"login": "bob"}, "closingIssuesReferences": [{"number": 21, "repository": here}]},
            {"number": 6, "author": null, "closingIssuesReferences": [{"number": 30}]},
            {"number": 5, "author": {"login": "bob"}, "closingIssuesReferences": []},
        ])
        .to_string();
        assert_eq!(
            open_pr_links_from(&json, "o/r").unwrap(),
            vec![
                OpenPrLink { issue: 21, number: 9, author: Some("ana".into()) },
                OpenPrLink { issue: 30, number: 6, author: None },
            ]
        );
        assert!(open_pr_links_from("not json", "o/r").is_err());
    }

    #[test]
    fn closing_and_hand_links_once_each_and_this_repository_only() {
        let repo = "o/r";
        let json = answer(
            vec![
                pr(23, "OPEN", "test-user", repo),
                pr(5, "OPEN", "hubot", "someone/else"),
                pr(24, "CLOSED", "hubot", repo),
            ],
            vec![
                // Linked by hand, then merged.
                serde_json::json!({"__typename": "ConnectedEvent", "subject": typed(pr(25, "MERGED", "test-owner", repo))}),
                // Already a closing reference: one link.
                serde_json::json!({"__typename": "ConnectedEvent", "subject": typed(pr(23, "OPEN", "test-user", repo))}),
                serde_json::json!({"__typename": "ConnectedEvent", "subject": typed(pr(6, "OPEN", "hubot", "someone/else"))}),
                serde_json::json!({"__typename": "ConnectedEvent", "subject": {"__typename": "Issue", "number": 30}}),
            ],
        );
        let prs = linked_prs_from_issue(&json, repo).unwrap();
        assert_eq!(
            prs.iter().map(|p| (p.number, p.state.as_str())).collect::<Vec<_>>(),
            vec![(23, "open"), (24, "closed"), (25, "merged")]
        );
    }

    #[test]
    fn a_hand_link_unlinked_since_is_dropped_and_a_closing_one_stays() {
        let repo = "o/r";
        let unlink = |n: u64| {
            serde_json::json!({"__typename": "DisconnectedEvent",
                "subject": {"__typename": "PullRequest", "number": n, "repository": {"nameWithOwner": repo}}})
        };
        let json = answer(
            vec![pr(8, "OPEN", "a", repo)],
            vec![
                serde_json::json!({"__typename": "ConnectedEvent", "subject": typed(pr(7, "OPEN", "a", repo))}),
                unlink(7),
                unlink(8),
            ],
        );
        let prs = linked_prs_from_issue(&json, repo).unwrap();
        assert_eq!(prs.iter().map(|p| p.number).collect::<Vec<_>>(), vec![8]);
    }

    #[test]
    fn graphql_errors_and_a_missing_issue_are_said_as_such() {
        let err = serde_json::json!({"errors": [{"message": "Could not resolve to an Issue"}]}).to_string();
        assert_eq!(linked_prs_from_issue(&err, "o/r").unwrap_err(), "Could not resolve to an Issue");
        assert!(linked_prs_from_issue("{\"data\":{}}", "o/r").unwrap().is_empty());
        assert!(linked_prs_from_issue("not json", "o/r").is_err());
    }

    #[test]
    fn the_read_is_one_bounded_graphql_call_for_the_issue() {
        let _guard = test_serial_lock();
        take_test_gh_invocations();
        take_test_gh_timeouts();
        set_test_gh_responses(vec![Ok(answer(vec![], vec![]))]);
        let prs = issue_linked_pull_requests("o/r", 21).unwrap();
        let calls = take_test_gh_invocations();
        let bounds = take_test_gh_timeouts();
        clear_test_gh_responses();
        assert!(prs.is_empty());
        assert_eq!(calls.len(), 1);
        let call = &calls[0];
        assert_eq!(&call[..2], &["api".to_string(), "graphql".to_string()]);
        assert!(call.iter().any(|a| a.contains("closedByPullRequestsReferences") && a.contains("includeClosedPrs:true")));
        assert!(call.contains(&"owner=o".to_string()) && call.contains(&"name=r".to_string()));
        assert!(call.contains(&"number=21".to_string()));
        assert_eq!(bounds, vec![GH_API_TIMEOUT]);
        assert!(issue_linked_pull_requests("no-slash", 21).is_err());
    }
}
