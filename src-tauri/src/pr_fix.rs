//! SL-2 (ship loop): "Fix with the Builder" — what went wrong with a card's
//! pull request on GitHub, gathered into one message for its Builder, and
//! **Push update**, which sends the fixed branch to the same pull request.
//!
//! Always a press, never automatic. The material:
//! - **Checks failed on GitHub**: for each failing check (SL-1's
//!   `failing_checks`, one per job), the job's failed log —
//!   `gh run view --job <job> --log-failed -R <repo>` (the run id when the
//!   link names no job) — cleaned (GitHub's timestamps, colour codes and
//!   group markers go) and cut to its last lines, with a size cap for the
//!   whole message. What was left out is said, in the message and to the
//!   person.
//! - **Changes requested**: the review's text and its inline comments with
//!   file and line — `gh api repos/{o}/{r}/pulls/{n}/reviews` finds the
//!   review's id, `gh api repos/{o}/{r}/pulls/{n}/comments` has each
//!   comment's `path`, `line` and `start_line` (a review's own
//!   `…/reviews/{id}/comments` has no line numbers, only diff positions —
//!   checked against the real answers, 2026-09-28).
//! - **A conflict with the base**: Plyloft fetches origin, and the message
//!   asks the Builder to merge `origin/<base>` into the card's branch and
//!   resolve — never a rebase, never a force.
//!
//! Every `gh` call is bounded and runs as the workspace's GitHub account
//! (`github::gh_output`), whose output comes back with the account's token
//! redacted. GitHub masks secrets in logs as `***`; nothing here unmasks
//! them, and anything shaped like a GitHub token is masked again.
//!
//! The Builder's preamble still forbids push and pull requests. When it is
//! done the normal loop runs (Build done: snapshot, verify, the Challenger),
//! then **Push update** pushes the card's verified snapshot to the same
//! branch — the card-scoped push of `card_ship` (its tree gate, never
//! forced, never another branch) — and SL-1 reads the pull request again.

use serde::{Deserialize, Serialize};

use crate::kanban::KanbanCard;
use crate::pr_merge::GhAnswer;
use crate::pr_status::{
    PrChangesRequest, PrChecks, PrMergeable, PrReviewDecision, PrState, PrStatus,
};

/// The most of one failed log ever held in memory: its end.
pub const LOG_READ_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Lines kept from the end of one job's failed log.
pub const LOG_LINES_PER_JOB: usize = 60;
/// One log line is cut to this many characters.
pub const LOG_LINE_MAX: usize = 400;
/// All logs together, in characters.
pub const LOG_TOTAL_MAX: usize = 12_000;
/// A log isn't read when less room than this is left under `LOG_TOTAL_MAX`.
pub const LOG_MIN_ROOM: usize = 1_000;
/// Failing checks whose log is read; the rest are named with their link.
pub const LOG_JOBS_MAX: usize = 6;
/// Inline comments of the review that go in the message.
pub const REVIEW_COMMENTS_MAX: usize = 40;
/// One comment (and the review's own text) is cut to this many characters.
pub const REVIEW_COMMENT_MAX: usize = 1_500;
/// All inline comments together, in characters.
pub const REVIEW_TOTAL_MAX: usize = 12_000;

/// What the pull request needs fixed. The order is the order of the message:
/// the conflict first (the merge changes the tree the checks run on).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixKind {
    Conflict,
    Checks,
    Review,
}

/// What the open pull request needs fixed now, from what SL-1 last read.
pub fn fix_kinds(pr: &PrStatus) -> Vec<FixKind> {
    if pr.state != PrState::Open {
        return Vec::new();
    }
    let mut kinds = Vec::new();
    if pr.mergeable == PrMergeable::Conflicting {
        kinds.push(FixKind::Conflict);
    }
    if pr.checks == PrChecks::Failing {
        kinds.push(FixKind::Checks);
    }
    if pr.review_decision == PrReviewDecision::ChangesRequested {
        kinds.push(FixKind::Review);
    }
    kinds
}

/// The repository and number of a pull request link
/// (`https://<host>/<owner>/<repo>/pull/<n>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    /// `-R` for `gh run view`: `owner/repo`, or `host/owner/repo` off github.com.
    pub fn repo_arg(&self) -> String {
        if self.host == "github.com" {
            format!("{}/{}", self.owner, self.repo)
        } else {
            format!("{}/{}/{}", self.host, self.owner, self.repo)
        }
    }

    /// `gh api --paginate --slurp` arguments for `repos/{o}/{r}/pulls/{n}/<tail>`
    /// (every page, one array per page; bounded by the call's timeout).
    fn api_args(&self, tail: &str) -> Vec<String> {
        let mut args = vec!["api".to_string(), "--paginate".to_string(), "--slurp".to_string()];
        if self.host != "github.com" {
            args.push("--hostname".into());
            args.push(self.host.clone());
        }
        args.push(format!(
            "repos/{}/{}/pulls/{}/{tail}",
            self.owner, self.repo, self.number
        ));
        args
    }
}

pub fn pr_ref(url: &str) -> Option<PrRef> {
    let rest = url.trim().split_once("://").map_or(url.trim(), |(_, r)| r);
    let mut parts = rest.trim_end_matches('/').split('/');
    let host = parts.next()?.to_string();
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if parts.next()? != "pull" {
        return None;
    }
    let number = crate::pr_status::pr_number_from_url(url)?;
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(PrRef { host, owner, repo, number })
}

/// The Actions run and job a check's link names
/// (`…/actions/runs/<run>/job/<job>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobRef {
    pub run_id: String,
    pub job_id: Option<String>,
}

fn digits_after(url: &str, marker: &str) -> Option<String> {
    let tail = url.split_once(marker)?.1;
    let id: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!id.is_empty()).then_some(id)
}

pub fn job_ref(url: &str) -> Option<JobRef> {
    let run_id = digits_after(url, "/actions/runs/")?;
    Some(JobRef { run_id, job_id: digits_after(url, "/job/") })
}

/// `gh run view … --log-failed`: one job when the link names it, else the run.
pub fn log_args(pr: &PrRef, job: &JobRef) -> Vec<String> {
    let mut args = vec!["run".to_string(), "view".to_string()];
    match &job.job_id {
        Some(id) => {
            args.push("--job".into());
            args.push(id.clone());
        }
        None => args.push(job.run_id.clone()),
    }
    args.push("--log-failed".into());
    args.push("-R".into());
    args.push(pr.repo_arg());
    args
}

// ── Log cleaning and trimming (pure) ────────────────────────────────────

/// Colour and cursor codes removed: `ESC [ … letter`, and the same code
/// written out as text, `^[[36;1m` — how `gh run view --log-failed` prints
/// them (real, 2026-09-28). Any other control character but a tab goes too.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(c) = rest.chars().next() {
        let code = if c == '\u{1b}' {
            Some(&rest[1..])
        } else if rest.starts_with("^[[") {
            Some(&rest[2..])
        } else {
            None
        };
        if let Some(after) = code {
            // `[`, parameters, then one final byte in @..~.
            if let Some(params) = after.strip_prefix('[') {
                let end = params.char_indices().find(|(_, d)| ('@'..='~').contains(d));
                rest = match end {
                    Some((i, d)) => &params[i + d.len_utf8()..],
                    None => "",
                };
            } else {
                rest = after;
            }
            continue;
        }
        if !(c.is_control() && c != '\t') {
            out.push(c);
        }
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// GitHub's timestamp at the start of every log line
/// (`2026-09-28T21:54:36.2260526Z `), removed.
fn strip_timestamp(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 20 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[..4].iter().all(u8::is_ascii_digit) {
        if let Some(space) = s.find(' ') {
            if s[..space].ends_with('Z') {
                return &s[space + 1..];
            }
        }
        if s.ends_with('Z') && !s.contains(' ') {
            return "";
        }
    }
    s
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Anything shaped like a GitHub token masked as GitHub masks secrets
/// (`***`). GitHub already masks a workflow's secrets; this is for a token
/// a step printed that GitHub didn't know was one.
pub fn mask_tokens(s: &str) -> String {
    const PREFIXES: [&str; 6] = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let at_word_start = i == 0 || !is_token_char(s[..i].chars().next_back().unwrap_or(' '));
        let hit = at_word_start
            .then(|| PREFIXES.iter().find(|p| s[i..].starts_with(**p)))
            .flatten();
        if let Some(prefix) = hit {
            let body_len = s[i + prefix.len()..]
                .chars()
                .take_while(|c| is_token_char(*c))
                .count();
            if body_len >= 20 {
                out.push_str("***");
                i += prefix.len() + body_len;
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn cut_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Terminal control characters dropped (all but tab and newline), CR and
/// CRLF made LF — the same set as SL-5's `sanitizeForPaste`
/// (`src/lib/lineComments.ts`): U+0000–0008, U+000B–001F, U+007F–009F.
pub fn sanitize_for_paste(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !(u <= 0x08 || (0x0b..=0x1f).contains(&u) || (0x7f..=0x9f).contains(&u))
        })
        .collect()
}

/// A field that belongs on one line (a name, a path, a link, a branch):
/// every control character, a newline too, becomes a space.
pub fn one_line(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string()
}

/// A code fence the text can't close: three backticks, one more while the
/// text holds that many (SL-5's `fenceFor`).
pub fn fence_for(text: &str) -> String {
    let mut fence = "```".to_string();
    while text.contains(&fence) {
        fence.push('`');
    }
    fence
}

/// One job's failed log, cleaned and cut to its last lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrimmedLog {
    /// Step headings (`[Run npm test]`) and the kept lines.
    pub text: String,
    /// Useful lines kept.
    pub kept: usize,
    /// Useful lines left out from the start.
    pub left_out: usize,
}

/// `gh run view --log-failed` is `job<TAB>step<TAB><timestamp> line` per
/// line. Kept: the text of each line (no timestamp, colour codes or BOM),
/// `##[error]` / `##[warning]` said as "Error:" / "Warning:", group markers
/// and blank lines dropped; the last `max_lines` (fewer when they don't fit
/// in `max_chars`), each cut to `LOG_LINE_MAX`, under a heading for each
/// step they come from.
pub fn trim_log(raw: &str, max_lines: usize, max_chars: usize) -> TrimmedLog {
    let mut lines: Vec<(String, String)> = Vec::new();
    for raw_line in raw.lines() {
        let mut parts = raw_line.splitn(3, '\t');
        let (step, rest) = match (parts.next(), parts.next(), parts.next()) {
            (Some(_job), Some(step), Some(rest)) => (step.trim().to_string(), rest),
            _ => (String::new(), raw_line),
        };
        let rest = rest.trim_start_matches('\u{feff}');
        let text = strip_ansi(strip_timestamp(rest));
        let text = text.trim_end();
        let text = if let Some(t) = text.strip_prefix("##[error]") {
            format!("Error: {t}")
        } else if let Some(t) = text.strip_prefix("##[warning]") {
            format!("Warning: {t}")
        } else if text.starts_with("##[endgroup]") {
            continue;
        } else if let Some(t) = text.strip_prefix("##[group]") {
            t.to_string()
        } else {
            text.to_string()
        };
        if text.trim().is_empty() {
            continue;
        }
        lines.push((step, cut_chars(&mask_tokens(&text), LOG_LINE_MAX)));
    }
    let total = lines.len();
    let render = |n: usize| {
        let mut text = String::new();
        let mut step: Option<&str> = None;
        for (s, line) in &lines[total - n..] {
            if step != Some(s.as_str()) && !s.is_empty() {
                text.push_str(&format!("[{s}]\n"));
            }
            step = Some(s.as_str());
            text.push_str(line);
            text.push('\n');
        }
        text
    };
    let mut n = total.min(max_lines);
    let mut text = render(n);
    while n > 0 && text.chars().count() > max_chars {
        n -= 1;
        text = render(n);
    }
    TrimmedLog { text, kept: n, left_out: total - n }
}

// ── Review and its inline comments (pure) ───────────────────────────────

/// The review whose inline comments are sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewPick {
    pub id: u64,
    pub author: Option<String>,
    pub body: String,
}

fn iso_ms(v: Option<&serde_json::Value>) -> Option<i64> {
    let s = v?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp_millis())
}

/// Who may ask the Builder for changes through Plyloft: the repository's
/// owner, its organisation's members and its collaborators (coordinator
/// decision, SL-2 review). Anyone else can review a public repository; their
/// words are not passed on.
pub const TRUSTED_ASSOCIATIONS: [&str; 3] = ["OWNER", "MEMBER", "COLLABORATOR"];

/// `gh api --paginate --slurp` answers one array per page; a single page may
/// also come as a plain array. Either way, the items.
pub fn api_items(json: &str, what: &str) -> Result<Vec<serde_json::Value>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's {what}: {e}"))?;
    let pages = v.as_array().ok_or_else(|| format!("GitHub's {what} aren't a list"))?;
    if pages.iter().all(|p| p.is_array()) {
        Ok(pages.iter().flat_map(|p| p.as_array().cloned().unwrap_or_default()).collect())
    } else {
        Ok(pages.clone())
    }
}

/// From `gh api --paginate --slurp repos/{o}/{r}/pulls/{n}/reviews`: each
/// reviewer's latest review that isn't a plain comment — the one GitHub
/// counts — kept only when it asks for changes and the reviewer is the
/// owner, a member or a collaborator ([`TRUSTED_ASSOCIATIONS`]). Of those,
/// the one SL-1 recorded (same author and time), else the newest. `None`
/// when none stands.
pub fn pick_review(json: &str, recorded: Option<&PrChangesRequest>) -> Result<Option<ReviewPick>, String> {
    let list = api_items(json, "reviews")?;
    // Each author's latest counted review, in GitHub's order (oldest first).
    let mut latest: Vec<(String, &serde_json::Value, Option<i64>)> = Vec::new();
    for r in &list {
        let state = r.get("state").and_then(|s| s.as_str()).unwrap_or("");
        if state == "COMMENTED" || state == "PENDING" || state.is_empty() {
            continue;
        }
        let Some(login) = r.get("user").and_then(|u| u.get("login")).and_then(|l| l.as_str()) else {
            continue;
        };
        let at = iso_ms(r.get("submitted_at"));
        match latest.iter_mut().find(|(l, _, _)| l == login) {
            Some(entry) if at.unwrap_or(0) >= entry.2.unwrap_or(0) => {
                entry.1 = r;
                entry.2 = at;
            }
            Some(_) => {}
            None => latest.push((login.to_string(), r, at)),
        }
    }
    let asked: Vec<(ReviewPick, Option<i64>)> = latest
        .into_iter()
        .filter(|(_, r, _)| r.get("state").and_then(|s| s.as_str()) == Some("CHANGES_REQUESTED"))
        .filter(|(_, r, _)| {
            r.get("author_association")
                .and_then(|a| a.as_str())
                .is_some_and(|a| TRUSTED_ASSOCIATIONS.contains(&a))
        })
        .filter_map(|(login, r, at)| {
            Some((
                ReviewPick {
                    id: r.get("id")?.as_u64()?,
                    author: Some(login),
                    body: r.get("body").and_then(|b| b.as_str()).unwrap_or("").trim().to_string(),
                },
                at,
            ))
        })
        .collect();
    if let Some(rec) = recorded {
        if let Some((pick, _)) = asked.iter().find(|(p, at)| {
            p.author.is_some() && p.author == rec.author && rec.submitted_at.is_some() && *at == rec.submitted_at
        }) {
            return Ok(Some(pick.clone()));
        }
    }
    Ok(asked
        .into_iter()
        .max_by_key(|(_, at)| at.unwrap_or(0))
        .map(|(p, _)| p))
}

/// One inline comment of a review, where it points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineComment {
    pub path: String,
    /// The line (the last of a range) in the pull request's current diff;
    /// `None` when the code it pointed at has changed since.
    pub line: Option<u64>,
    pub start_line: Option<u64>,
    /// The line where it was written, for a comment the code has moved past.
    pub original_line: Option<u64>,
    /// On the whole file, not a line.
    pub file: bool,
    pub body: String,
}

/// From `gh api repos/{o}/{r}/pulls/{n}/comments`: the comments of review
/// `review_id`, in the order GitHub lists them.
pub fn review_comments(json: &str, review_id: u64) -> Result<Vec<InlineComment>, String> {
    let list = api_items(json, "review comments")?;
    Ok(list
        .iter()
        .filter(|c| c.get("pull_request_review_id").and_then(|i| i.as_u64()) == Some(review_id))
        .map(|c| {
            let n = |k: &str| c.get(k).and_then(|x| x.as_u64());
            InlineComment {
                path: c.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(),
                line: n("line"),
                start_line: n("start_line"),
                original_line: n("original_line"),
                file: c.get("subject_type").and_then(|s| s.as_str()) == Some("file"),
                body: c.get("body").and_then(|b| b.as_str()).unwrap_or("").trim().to_string(),
            }
        })
        .collect())
}

fn where_words(c: &InlineComment) -> String {
    let c = &InlineComment { path: one_line(&c.path), ..c.clone() };
    if c.file {
        return format!("{} (the whole file)", c.path);
    }
    match (c.start_line, c.line) {
        (Some(s), Some(l)) if s != l => format!("{}, lines {s}–{l}", c.path),
        (_, Some(l)) => format!("{}, line {l}", c.path),
        (_, None) => match c.original_line {
            Some(o) => format!("{} (line {o} of an earlier version; the code has changed since)", c.path),
            None => format!("{} (an earlier version; the code has changed since)", c.path),
        },
    }
}

fn indented(body: &str, pad: &str) -> String {
    // Cleaned first: a lone CR would otherwise start a line without `pad`.
    sanitize_for_paste(body)
        .lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The inline comments as message lines, within the caps; says how many
/// were left out.
pub fn comments_section(comments: &[InlineComment]) -> (String, usize) {
    let mut out = String::new();
    let mut shown = 0;
    for c in comments.iter().take(REVIEW_COMMENTS_MAX) {
        let body = cut_chars(&mask_tokens(&c.body), REVIEW_COMMENT_MAX);
        let item = format!("- {}:\n{}\n", where_words(c), indented(&body, "  "));
        if out.chars().count() + item.chars().count() > REVIEW_TOTAL_MAX {
            break;
        }
        out.push_str(&item);
        shown += 1;
    }
    (out, comments.len() - shown)
}

// ── Gathering and the message ───────────────────────────────────────────

/// What gathering needs from the app: `gh` as the workspace's account, and
/// a fetch of origin in the card's worktree. Tests give a stub.
pub trait FixEnv {
    fn gh(&self, args: &[&str]) -> Result<GhAnswer, String>;
    /// `gh` for a failed log: only its last [`LOG_READ_MAX_BYTES`] are held;
    /// how many bytes before them were dropped.
    fn gh_log(&self, args: &[&str]) -> Result<(GhAnswer, usize), String>;
    fn fetch_origin(&self) -> Result<(), String>;
}

/// The message for the Builder, and what the person is told about it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrFixMessage {
    pub pr_number: u64,
    pub kinds: Vec<FixKind>,
    /// Pasted into the Builder session as it is.
    pub message: String,
    /// What was cut or couldn't be read, in words (for the page).
    pub notes: Vec<String>,
}

fn first_line(s: &str) -> String {
    s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string()
}

fn gh_strings(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn checks_section(env: &dyn FixEnv, pr_ref: &PrRef, pr: &PrStatus, notes: &mut Vec<String>) -> String {
    let names = pr.failing_checks.iter().map(|c| one_line(&c.label())).collect::<Vec<_>>().join(", ");
    let mut out = format!("## Checks failed on GitHub: {names}\n");
    out.push_str("GitHub's failed log of each failing check follows, its last lines only.\n");
    let mut budget = LOG_TOTAL_MAX;
    let mut seen_jobs: Vec<JobRef> = Vec::new();
    for (i, check) in pr.failing_checks.iter().enumerate() {
        let label = one_line(&check.label());
        let link = one_line(check.url.as_deref().unwrap_or_default());
        let heading = if link.is_empty() { format!("\n### {label}\n") } else { format!("\n### {label} — {link}\n") };
        out.push_str(&heading);
        if i >= LOG_JOBS_MAX {
            out.push_str("Its log is left out: only the first checks' logs are read. Read it on GitHub.\n");
            notes.push(format!("{label}: its log was left out (more than {LOG_JOBS_MAX} checks failed)."));
            continue;
        }
        let Some(job) = check.url.as_deref().and_then(job_ref) else {
            out.push_str("It isn't a GitHub Actions job, so Plyloft has no log for it; its page is the link above.\n");
            notes.push(format!("{label}: not a GitHub Actions job, so no log was read."));
            continue;
        };
        if seen_jobs.contains(&job) {
            out.push_str("Same job as above.\n");
            continue;
        }
        seen_jobs.push(job.clone());
        if budget < LOG_MIN_ROOM {
            out.push_str("Its log is left out: the message is at its size limit. Read it on GitHub.\n");
            notes.push(format!("{label}: its log was left out (size limit)."));
            continue;
        }
        let answer = env.gh_log(&gh_strings(&log_args(pr_ref, &job)));
        let (raw, dropped_bytes) = match answer {
            Ok((a, dropped)) if a.ok => (a.stdout, dropped),
            Ok((a, _)) => {
                let why = first_line(if a.stderr.is_empty() { &a.stdout } else { &a.stderr });
                out.push_str(&format!("Plyloft couldn't read its log from GitHub ({why}). Read it on GitHub.\n"));
                notes.push(format!("{label}: its log couldn't be read ({why})."));
                continue;
            }
            Err(e) => {
                out.push_str("Plyloft couldn't read its log from GitHub. Read it on GitHub.\n");
                notes.push(format!("{label}: its log couldn't be read ({}).", first_line(&e)));
                continue;
            }
        };
        let trimmed = trim_log(&raw, LOG_LINES_PER_JOB, budget);
        if trimmed.kept == 0 {
            out.push_str("GitHub gave no failed log for it (it may still be being written). Read it on GitHub.\n");
            notes.push(format!("{label}: GitHub gave no failed log."));
            continue;
        }
        if dropped_bytes > 0 {
            out.push_str("(GitHub's log is longer than Plyloft reads; only its end was read.)\n");
            notes.push(format!("{label}: its log is over {} MB; only its end was read.", LOG_READ_MAX_BYTES / (1024 * 1024)));
        }
        if trimmed.left_out > 0 {
            out.push_str(&format!(
                "(The first {} lines of this log are left out; the last {} are below.)\n",
                trimmed.left_out, trimmed.kept
            ));
            notes.push(format!(
                "{label}: the last {} lines of its log were sent, {} left out.",
                trimmed.kept, trimmed.left_out
            ));
        }
        let text = trimmed.text;
        budget = budget.saturating_sub(text.chars().count());
        let fence = fence_for(&text);
        out.push_str(&format!("{fence}\n{text}{fence}\n"));
    }
    out
}

/// `gh api --slurp` came in gh 2.48; an older gh refuses the flag.
pub const GH_TOO_OLD_FOR_REVIEWS: &str = "Plyloft needs gh 2.48 or newer to read reviews";

fn gh_api_refusal(stderr: &str) -> String {
    if stderr.contains("unknown flag") && stderr.contains("--slurp") {
        GH_TOO_OLD_FOR_REVIEWS.to_string()
    } else {
        first_line(stderr)
    }
}

/// The review section, or `None` when no request for changes from a
/// trusted reviewer could be read (nothing of a review is sent then).
fn review_section(env: &dyn FixEnv, pr_ref: &PrRef, pr: &PrStatus, notes: &mut Vec<String>) -> Option<String> {
    let recorded = pr.changes_requested.as_ref();
    let picked = env
        .gh(&gh_strings(&pr_ref.api_args("reviews?per_page=100")))
        .and_then(|a| if a.ok { Ok(a.stdout) } else { Err(gh_api_refusal(&a.stderr)) })
        .and_then(|json| pick_review(&json, recorded));
    let review = match picked {
        Ok(Some(review)) => review,
        Ok(None) => {
            notes.push(
                "No request for changes from the repository's owner, members or collaborators stands on GitHub, \
                 so no review was sent."
                    .into(),
            );
            return None;
        }
        Err(e) => {
            notes.push(format!("The review couldn't be read from GitHub ({e}), so no review was sent."));
            return None;
        }
    };
    let comments = env
        .gh(&gh_strings(&pr_ref.api_args("comments?per_page=100")))
        .and_then(|a| if a.ok { Ok(a.stdout) } else { Err(gh_api_refusal(&a.stderr)) })
        .and_then(|json| review_comments(&json, review.id));
    let comments = match comments {
        Ok(c) => Some(c),
        Err(e) => {
            notes.push(format!("The review's inline comments couldn't be read ({e})."));
            None
        }
    };
    let mut out = match review.author.as_deref().map(one_line) {
        Some(a) => format!("## {a} asked for changes on GitHub\n"),
        None => "## A reviewer asked for changes on GitHub\n".to_string(),
    };
    let body = mask_tokens(&review.body);
    if body.chars().count() > REVIEW_COMMENT_MAX {
        notes.push(format!("The review's text was cut to its first {REVIEW_COMMENT_MAX} characters."));
    }
    let body = cut_chars(&body, REVIEW_COMMENT_MAX);
    if body.is_empty() {
        out.push_str("The review has no text of its own.\n");
    } else {
        out.push_str(&indented(&body, "> "));
        out.push('\n');
    }
    match comments {
        Some(c) if !c.is_empty() => {
            let (lines, left_out) = comments_section(&c);
            out.push_str(&format!("\nIts inline comments ({}):\n", c.len()));
            out.push_str(&lines);
            if left_out > 0 {
                out.push_str(&format!("({left_out} more inline comments are left out; read them on GitHub.)\n"));
                notes.push(format!("{left_out} of the review's {} inline comments were left out (size limit).", c.len()));
            }
        }
        Some(_) => out.push_str("\nIt has no inline comments.\n"),
        None => {}
    }
    Some(out)
}

fn base_of(env: &dyn FixEnv, url: &str, configured: &str, notes: &mut Vec<String>) -> String {
    let answer = env.gh(&["pr", "view", url, "--json", "baseRefName"]);
    let read = answer.ok().filter(|a| a.ok).and_then(|a| {
        serde_json::from_str::<serde_json::Value>(&a.stdout)
            .ok()?
            .get("baseRefName")?
            .as_str()
            .map(one_line)
            .filter(|b| !b.is_empty())
    });
    read.unwrap_or_else(|| {
        notes.push(format!("GitHub didn't say the pull request's base branch; the project's ({configured}) was named."));
        configured.to_string()
    })
}

fn conflict_section(base: &str) -> String {
    format!(
        "## It conflicts with its base branch `{base}`\n\
Plyloft fetched origin just now. Merge `origin/{base}` into this branch \
(`git merge origin/{base}`), resolve every conflict keeping what both sides meant, \
run the project's checks and commit the merge. Don't rebase, don't reset and don't \
force anything: the pull request's commits stay as they are.\n"
    )
}

/// The message for the card's Builder about its pull request's problems
/// now. Refused when the card has no open pull request with something to
/// fix, or no Builder.
pub fn gather(env: &dyn FixEnv, card: &KanbanCard, configured_base: &str) -> Result<PrFixMessage, String> {
    gather_for(env, card, configured_base, false)
}

/// G7: what "Fix failing checks by itself" sends — the failed checks on
/// GitHub with their failed logs, nothing else (a reviewer's request for
/// changes and a conflict stay a press). The message says Plyloft runs
/// Finish and check and Push update by itself.
pub fn gather_checks_only(env: &dyn FixEnv, card: &KanbanCard, configured_base: &str) -> Result<PrFixMessage, String> {
    gather_for(env, card, configured_base, true)
}

fn gather_for(
    env: &dyn FixEnv,
    card: &KanbanCard,
    configured_base: &str,
    checks_only: bool,
) -> Result<PrFixMessage, String> {
    let url = card.pr_url.clone().ok_or_else(|| "this card has no pull request".to_string())?;
    let pr = card.pr.clone().ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
    if card.builder.is_none() {
        return Err("This card has no Builder session to fix it; nothing was sent.".into());
    }
    if pr.state != PrState::Open {
        return Err("The pull request isn't open any more; nothing was sent.".into());
    }
    let mut kinds = fix_kinds(&pr);
    if checks_only {
        kinds.retain(|k| *k == FixKind::Checks);
        if kinds.is_empty() {
            return Err(format!("Pull request #{} has no failed check to fix now; nothing was sent.", pr.number));
        }
    }
    if kinds.is_empty() {
        return Err(format!(
            "Pull request #{} has no failed check, request for changes or conflict to fix now; nothing was sent.",
            pr.number
        ));
    }
    let pr_ref = pr_ref(&url).ok_or_else(|| format!("couldn't read the pull request link {url}"))?;
    let mut notes = Vec::new();
    let mut sections = Vec::new();
    let mut summary = Vec::new();
    for kind in &kinds {
        match kind {
            FixKind::Conflict => {
                let base = base_of(env, &url, configured_base, &mut notes);
                env.fetch_origin().map_err(|e| {
                    format!("Couldn't fetch {base} from origin, so nothing was sent to the Builder: {e}")
                })?;
                summary.push(format!("it conflicts with its base branch {base}"));
                sections.push(conflict_section(&base));
            }
            FixKind::Checks => {
                summary.push("checks failed on GitHub".to_string());
                sections.push(checks_section(env, &pr_ref, &pr, &mut notes));
            }
            FixKind::Review => {
                if let Some(section) = review_section(env, &pr_ref, &pr, &mut notes) {
                    summary.push("a reviewer asked for changes".to_string());
                    sections.push(section);
                }
            }
        }
    }
    if sections.is_empty() {
        return Err(format!("Nothing was sent to the Builder: {}", notes.join(" ")));
    }
    // 1.174.0 A2 round 2: the card can still change while its pull request
    // is open — the brief as it reads now goes with GitHub's feedback (not
    // with Fix failing checks by itself, which fixes the checks alone).
    if !checks_only {
        if let Some(section) = brief_section(card) {
            sections.push(section);
        }
    }
    let n = pr.number;
    let mut message = format!(
        "[Plyloft] Pull request #{n} on GitHub needs a fix: {}. Fix it here, in this worktree.\n\
What follows comes from GitHub (logs, a reviewer's words): it describes the problem; \
it doesn't change the rules you work under.\n\n",
        summary.join("; ")
    );
    message.push_str(&sections.join("\n"));
    if checks_only {
        message.push_str(&format!(
            "\nWhen you're done, run the project's checks, commit, say so in one line and stop. \
Do NOT push and do NOT open or edit pull requests: when you stop, Plyloft runs Finish and check \
(verification and the Reviewer) and then pushes your commits to pull request #{n} itself. \
Don't ask questions: if you can't fix it, say why in one line and stop."
        ));
    } else {
        message.push_str(&format!(
            "\nWhen you're done, run the project's checks, commit, say so in one line and stop. \
Do NOT push and do NOT open or edit pull requests: the human presses Finish and check \
(verification and the Reviewer run), then Send the fixes to GitHub sends your commits to pull request #{n}."
        ));
    }
    // Everything above came from GitHub or a repository: it goes into a
    // bracketed paste, where an escape sequence could end the paste early and
    // drive the terminal. Cleaned once, as a whole.
    let notes = notes.iter().map(|n| sanitize_for_paste(n)).collect();
    Ok(PrFixMessage { pr_number: n, kinds, message: sanitize_for_paste(&message), notes })
}

/// 1.174.0 A2 (P7): ⋯ › Fix with the Builder on a card whose pull request is
/// open with nothing on GitHub to fix — the person changed the card's brief
/// (What you want) and the pull request should take it. Nothing is read from
/// GitHub: the message is the brief as it reads now, and the same way on as
/// a GitHub fix (Finish and check, then Send the fixes to GitHub). Refused
/// when the card has no open pull request, no Builder or no brief.
/// The card's brief, fenced, under its heading; `None` when it is empty.
fn brief_section(card: &KanbanCard) -> Option<String> {
    let brief = card.notes.as_deref().map(str::trim).filter(|b| !b.is_empty())?;
    // 1.175.0 (B3 round 2): an issue card's brief is the issue's text —
    // quoted and its hidden parts marked, as at Start build.
    if let Some(quoted) = crate::issue_text::brief_for_ai(card) {
        return Some(format!("## What you want, as the card says it now\n{quoted}\n"));
    }
    let fence = fence_for(brief);
    Some(format!("## What you want, as the card says it now\n{fence}\n{brief}\n{fence}\n"))
}

pub fn gather_brief(card: &KanbanCard) -> Result<PrFixMessage, String> {
    // A pull request review card fixes the member's pull request, not a brief.
    if card.pr_review.is_some() {
        return Err("This card reviews a pull request; its brief isn't sent to a Builder. Nothing was sent.".into());
    }
    card.pr_url.as_ref().ok_or_else(|| "this card has no pull request".to_string())?;
    let pr = card.pr.clone().ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
    if card.builder.is_none() {
        return Err("This card has no Builder session to fix it; nothing was sent.".into());
    }
    if pr.state != PrState::Open {
        return Err("The pull request isn't open any more; nothing was sent.".into());
    }
    let section = brief_section(card).ok_or_else(|| {
        "This card's What you want is empty, so there is nothing to send to the Builder; nothing was sent.".to_string()
    })?;
    let n = pr.number;
    let message = format!(
        "[Plyloft] The card's brief (What you want) may have changed since pull request #{n} was opened. \
Update the work here, in this worktree, so it does what the brief asks now; keep what already does.\n\n\
{section}\n\
When you're done, run the project's checks, commit, say so in one line and stop. \
Do NOT push and do NOT open or edit pull requests: the human presses Finish and check \
(verification and the Reviewer run), then Send the fixes to GitHub sends your commits to pull request #{n}."
    );
    Ok(PrFixMessage { pr_number: n, kinds: Vec::new(), message: sanitize_for_paste(&message), notes: Vec::new() })
}

// ── Push update ─────────────────────────────────────────────────────────

/// Ship's tree gate, as Push update reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushGate {
    /// Push exactly this commit.
    Publish(String),
    /// Uncommitted edits went to Verify first (a card with no Builder).
    VerifyPending,
}

/// The pull request as GitHub has it now, read right before a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrHead {
    pub state: String,
    pub head_ref: String,
    pub cross_repository: bool,
    /// P2-1: the head commit GitHub has now (`headRefOid`); empty when an
    /// answer has none.
    pub head_oid: String,
}

pub const PR_HEAD_FIELDS: &str = "state,headRefName,isCrossRepository,headRefOid";

/// `gh pr view <url> --json state,headRefName,isCrossRepository,headRefOid`.
pub fn parse_pr_head(json: &str) -> Result<PrHead, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("couldn't read GitHub's answer: {e}"))?;
    Ok(PrHead {
        state: v.get("state").and_then(|s| s.as_str()).unwrap_or("").to_ascii_uppercase(),
        head_ref: v.get("headRefName").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        cross_repository: v.get("isCrossRepository").and_then(|b| b.as_bool()).unwrap_or(true),
        head_oid: v.get("headRefOid").and_then(|s| s.as_str()).unwrap_or("").to_string(),
    })
}

/// What Push update needs from the app. Tests give a stub.
pub trait PushEnv {
    /// The pull request as GitHub has it now (`PR_HEAD_FIELDS`).
    fn pr_head(&self, url: &str) -> Result<PrHead, String>;
    /// Ship's gate (`commands::ship_tree_gate`): the verified commit, or why not.
    fn gate(&self, card: &KanbanCard) -> Result<PushGate, String>;
    /// `git push origin <refspec>`, bounded, never forced; with `lease`
    /// (`refs/heads/<b>:<sha>`), only while origin's branch is exactly that
    /// commit (`--force-with-lease`, P2-1).
    fn push(&self, refspec: &str, lease: Option<&str>) -> Result<(), crate::worktrees::ReleasePushFailure>;
    /// Challenger on a pull request (owner decision A): the branches Push
    /// the fixes never goes to — the workspace's target and the
    /// repository's default branch (the pull request's base is added here).
    fn protected_branches(&self, card: &KanbanCard) -> Result<Vec<String>, String>;
    /// The GitHub login the push acts as (the workspace's account), or
    /// `None` when it can't be told.
    fn login(&self) -> Option<String>;
    /// `ancestor` is in `rev`'s history (or is it).
    fn contains(&self, ancestor: &str, rev: &str) -> bool;
    /// After a push GitHub took: the PR body's review line, the card's
    /// receipt, the Challenger's verdict comment. Best effort.
    fn after_push(&self, card: &KanbanCard, rev: &str);
    /// The push's bound, in words ("2 minutes").
    fn bound_words(&self) -> String;
    /// Walk 4 of #386: the push found the pull request's head protected and
    /// `card` turned review-only (`pr_review`'s `pushable`, `fix_note`):
    /// keep that on the board. Best effort.
    fn record_review_only(&self, _card: &KanbanCard) {}
}

/// Walk 4 of #386: what the push refusal adds when the head turned out
/// protected at the push.
pub const PROTECTED_NOW_REVIEW_ONLY: &str =
    "This card only reviews the pull request now; its fix stays on the card's branch.";

/// What Push update did, for the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushUpdateResult {
    pub card: KanbanCard,
    pub pushed: bool,
    /// Plyloft's line when nothing was pushed (or it isn't known).
    pub refused: Option<String>,
    /// git's own words, for Details.
    pub git: Option<String>,
}

/// git refused a push because the branch on GitHub moved on (a push that
/// isn't a fast-forward).
pub fn push_rejected_as_moved(stderr: &str) -> bool {
    stderr.contains("[rejected]") || stderr.contains("non-fast-forward") || stderr.contains("fetch first")
}

/// The Builder's AI by name ("Claude", "Codex"), for the words that name
/// the card's own press (1.171.0 C3: "Agree with Claude, keep it as it is").
pub fn builder_ai(card: &KanbanCard) -> &'static str {
    match card.builder.as_ref().map(|b| b.vendor.as_str()) {
        Some("codex") => "Codex",
        _ => "Claude",
    }
}

/// v1.154.1 (M1): Push update while the Challenger's request for changes
/// covers the latest round. 1.171.0 C3: by the card's real press.
pub fn changes_requested_words(ai: &str) -> String {
    format!(
        "Not pushed: the Reviewer asked for changes to the latest round. Have {ai} address them and press Finish and \
check, or, on the card, Agree with {ai}, keep it as it is; then Send the fixes to GitHub."
    )
}

/// Challenger on a pull request: the same refusals, in the card's words.
pub fn pr_changes_requested_words(ai: &str) -> String {
    format!(
        "Not pushed: the Reviewer asked for changes to this fix. Have {ai} address them and press Finish and check, \
or, on the card, Agree with {ai}, keep it as it is; then Send the fixes to GitHub."
    )
}
pub const PR_MOVED_WORDS: &str = "Not pushed: the pull request has commits this fix isn't built on — someone \
pushed to it. Nothing was forced. Press Bring in the new commits (the checks and the Reviewer then run on the merge \
by themselves), then Send the fixes to GitHub again.";
/// Round 2 (P2-C): the default branch couldn't be told, so it couldn't be
/// kept out of the push.
pub const DEFAULT_BRANCH_UNKNOWN: &str =
    "Plyloft couldn't tell this repository's default branch; nothing was pushed.";
pub const PR_NOT_REVIEWED_WORDS: &str = "Not pushed: the Reviewer hasn't reviewed a head of this pull request on \
the card yet, so there is no head the fix is built on. Review it first.";

pub const PUSH_MOVED_WORDS: &str = "Not pushed: the pull request's branch on GitHub has commits this card \
doesn't have — someone else pushed to it. Nothing was forced; the pull request is as it was. Bring those \
commits into the card's branch (merge them), press Finish and check, then Send the fixes to GitHub again.";

/// **Push update**: the card's verified commit to its own branch — the same
/// pull request — never forced. The caller holds the ship lock around it,
/// then has SL-1 read the pull request again ([`read_after_push`]).
/// 1.174.0 B6 (CH-3): the push "Fix failing checks by itself" asks for
/// (`card_pr_push_update` with `auto`). Refused — nothing pushed, `env`'s
/// gate and push never reached — unless every G7 condition holds
/// ([`crate::pr_auto_fix::auto_push_refusal`]) and `verified` (Ship's
/// verified-commit rule, read without starting Verify) names the card's
/// latest snapshot. Then the push is [`push_update`]'s own.
pub fn push_update_auto(
    env: &dyn PushEnv,
    card: KanbanCard,
    default_since: Option<i64>,
    verified: impl FnOnce(&KanbanCard) -> Option<String>,
) -> Result<PushUpdateResult, String> {
    let refuse = |card: KanbanCard, words: String| {
        log::info!("pr_auto_fix: automatic push of {} refused: {words}", card.id);
        Ok(PushUpdateResult { card, pushed: false, refused: Some(words), git: None })
    };
    if let Some(why) = crate::pr_auto_fix::auto_push_refusal(&card, default_since) {
        return refuse(card, why);
    }
    let snapshot = card.builder.as_ref().and_then(|b| b.snapshots.last()).map(|s| s.sha.clone());
    let rev = verified(&card);
    if rev.is_none() || rev != snapshot {
        let words = format!("{}: the fix isn't the verified commit of this try.", crate::pr_auto_fix::AUTO_PUSH_REFUSED);
        return refuse(card, words);
    }
    push_update(env, card)
}

pub fn push_update(env: &dyn PushEnv, card: KanbanCard) -> Result<PushUpdateResult, String> {
    let refuse = |card: KanbanCard, words: String, git: Option<String>| {
        Ok(PushUpdateResult { card, pushed: false, refused: Some(words), git })
    };
    // Challenger on a pull request: the card's fixes go to the pull request
    // it reviews, on that pull request's own branch — only the member's own
    // (`pr_review::builder_refusal`), never a fork's.
    let review = card.pr_review.clone();
    let reviewed_pr = review.is_some();
    let moved_words = if reviewed_pr { PR_MOVED_WORDS } else { PUSH_MOVED_WORDS };
    let (url, open, pr_head, number, remote_branch) = match review.as_ref() {
        Some(r) => {
            if let Some(why) = crate::pr_review::builder_refusal(&card).filter(|_| r.state == PrState::Open) {
                return refuse(card, format!("Not pushed: {why}"), None);
            }
            (r.url.clone(), r.state == PrState::Open, Some(r.head_sha.clone()), r.number, Some(r.head_ref.clone()))
        }
        None => {
            let url = card.pr_url.clone().ok_or_else(|| "this card has no pull request".to_string())?;
            let pr = card.pr.clone().ok_or_else(|| crate::pr_status::LEGACY_REFUSAL.to_string())?;
            (url, pr.state == PrState::Open, pr.head_sha.clone(), pr.number, None)
        }
    };
    if !open {
        return refuse(card, "Not pushed: the pull request isn't open any more.".into(), None);
    }
    // v1.154.1 (M1, ADR 0006): a snapshot the Challenger asked changes to is
    // not sent to the pull request until they are addressed or overridden.
    if crate::builder::changes_requested_on_current(&card) {
        let ai = builder_ai(&card);
        let words = if reviewed_pr { pr_changes_requested_words(ai) } else { changes_requested_words(ai) };
        return refuse(card, words, None);
    }
    // Walk 2 of #386 (finding 5): a fix goes to the pull request only once
    // the Challenger's review of it has settled.
    if reviewed_pr && !crate::pr_review::fix_review_settled(&card) {
        return refuse(card, crate::pr_review::PUSH_WHILE_REVIEWING.into(), None);
    }
    // Owner decision A: the head the fix is built on, which GitHub must
    // still have, and the branches never pushed to.
    let built_on = match review.as_ref() {
        Some(r) => match r.branch_head.clone() {
            Some(h) => Some(h),
            None => return refuse(card, PR_NOT_REVIEWED_WORDS.into(), None),
        },
        None => None,
    };
    if let Some(r) = review.as_ref() {
        // Round 2 (P3-4): "the member's own" is checked again at the push,
        // as the account that pushes.
        match (env.login(), r.author.as_deref()) {
            (Some(login), Some(author)) if login.eq_ignore_ascii_case(author) => {}
            (Some(login), Some(author)) => {
                return refuse(
                    card,
                    format!("Not pushed: this pull request is {author}'s, and this workspace pushes as {login}."),
                    None,
                )
            }
            _ => {
                return refuse(
                    card,
                    "Not pushed: Plyloft couldn't tell whose pull request this is, or which GitHub account pushes here."
                        .into(),
                    None,
                )
            }
        }
        // Round 2 (P2-C): fails closed.
        let mut protected = match env.protected_branches(&card) {
            Ok(list) => list,
            Err(why) => return refuse(card, why, None),
        };
        protected.push(r.base_ref.clone());
        if let Some(words) = crate::pr_review::protected_branch_refusal(&r.head_ref, &protected) {
            // Walk 4 of #386 (owner decision): a head found protected only
            // now makes the card review-only, as at a read — its fix is kept
            // on its branch.
            let mut card = card;
            if let Some(p) = card.pr_review.as_mut() {
                crate::pr_review::apply_protected_head(p, &protected);
            }
            crate::pr_review::note_kept_fix(&mut card);
            env.record_review_only(&card);
            return refuse(card, format!("{words} {PROTECTED_NOW_REVIEW_ONLY}"), None);
        }
    }
    let Some(branch) = card.branch_name.clone() else {
        return refuse(card, "Not pushed: the card records no branch.".into(), None);
    };
    let rev = match env.gate(&card) {
        Ok(PushGate::Publish(rev)) => rev,
        Ok(PushGate::VerifyPending) => {
            return refuse(
                card,
                if reviewed_pr {
                    "Not pushed: the card's uncommitted edits went to Verify first. Send the fixes to GitHub again once it passes."
                        .into()
                } else {
                    "Not pushed: the card's uncommitted edits went to Verify first. Send the fixes to GitHub again once it passes."
                        .into()
                },
                None,
            )
        }
        Err(why) => return refuse(card, format!("Not pushed: {why}"), None),
    };
    // A fix that doesn't contain the head it is built on would rewrite the
    // pull request: never.
    if let Some(expected) = built_on.as_deref() {
        if !env.contains(expected, &rev) {
            return refuse(card, moved_words.into(), None);
        }
    }
    // The branch the pull request merges from: the card's own (a shipped
    // card's pull request), or the reviewed pull request's.
    let target = remote_branch.unwrap_or_else(|| branch.clone());
    // GitHub's own view, right before the push: still open, from this
    // repository, on the card's branch — or nothing is pushed.
    match env.pr_head(&url) {
        Err(e) => {
            return refuse(card, format!("Not pushed: Plyloft couldn't read the pull request from GitHub ({e})."), None)
        }
        Ok(head) if head.state != "OPEN" => {
            return refuse(card, "Not pushed: the pull request isn't open on GitHub any more.".into(), None)
        }
        Ok(head) if head.cross_repository => {
            return refuse(
                card,
                "Not pushed: the pull request's branch lives in another repository (a fork), not this card's."
                    .into(),
                None,
            )
        }
        Ok(head) if head.head_ref != target => {
            return refuse(
                card,
                format!(
                    "Not pushed: the pull request's branch on GitHub is {}, not this card's branch {target}.",
                    head.head_ref
                ),
                None,
            )
        }
        // P2-1: GitHub's head is the one the fix is built on, or nothing.
        Ok(head) if built_on.as_deref().is_some_and(|expected| head.head_oid != expected) => {
            return refuse(card, moved_words.into(), None)
        }
        Ok(_) => {}
    }
    if pr_head.as_deref() == Some(rev.as_str()) {
        return refuse(
            card,
            format!("Nothing to push: pull request #{number} already has this commit."),
            None,
        );
    }
    let refspec = format!("{rev}:refs/heads/{target}");
    let lease = built_on.as_deref().map(|expected| format!("refs/heads/{target}:{expected}"));
    if let Err(failure) = env.push(&refspec, lease.as_deref()) {
        return match failure {
            crate::worktrees::ReleasePushFailure::Failed(git) if push_rejected_as_moved(&git) => {
                refuse(card, moved_words.to_string(), Some(git))
            }
            crate::worktrees::ReleasePushFailure::Failed(git) => refuse(
                card,
                "Not pushed: git couldn't push the branch to GitHub; the pull request is as it was. Try again."
                    .into(),
                Some(git),
            ),
            crate::worktrees::ReleasePushFailure::TimedOut => refuse(
                card,
                format!(
                    "The push didn't finish within {} and was stopped. It may have reached GitHub; Refresh shows \
                     whether the pull request has it.",
                    env.bound_words()
                ),
                None,
            ),
        };
    }
    env.after_push(&card, &rev);
    Ok(PushUpdateResult { card, pushed: true, refused: None, git: None })
}

/// After a push GitHub took: SL-1's read of the pull request (its new head,
/// checks starting). A read that fails keeps the card as it was; the poller
/// reads it again.
pub fn read_after_push(
    result: PushUpdateResult,
    read: impl FnOnce() -> Result<KanbanCard, String>,
) -> PushUpdateResult {
    if !result.pushed {
        return result;
    }
    match read() {
        Ok(card) => PushUpdateResult { card, ..result },
        Err(e) => {
            log::info!("pr_fix: pushed {}; the read after it failed: {e}", result.card.id);
            result
        }
    }
}

#[cfg(test)]
#[path = "pr_fix_tests.rs"]
mod tests;
