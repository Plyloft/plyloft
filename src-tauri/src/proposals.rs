//! UX language card 8 (GH #104, ADR 0005 "improvement proposal";
//! `docs/ux-language/boards/BOARDS.md` §4 "Improvement proposal, state C").
//!
//! After a card that **met friction**, the Challenger writes at most one
//! improvement proposal: one change to a repository skill or to the root
//! instruction files, in one more short read-only pass on the same restricted
//! harness a review uses, on the same model row.
//!
//! This module owns the whole of it and nothing else owns any of it:
//!
//! - [`met_friction`] — the rule, pure, the only place that decides whether
//!   anything runs at all.
//! - [`proposal_prompt`] — what the pass reads: exactly the card's list.
//! - [`parse_answer`] — `NONE`, a proposal, or a discard with the reason.
//! - [`allowed_path`] / [`diff_sections`] — what a diff may name and touch.
//! - [`applies_cleanly`] — `git apply --check` against the checkout, read-only.
//! - [`ProposalFile`] — one proposal per workspace on This Mac, atomic JSON.
//! - [`stale_reason`] — 30 days, or the target changed since.
//! - [`after_last_review`] — the one entry point from the Builder's loop.
//! - [`approve_change_full`] — the change the shared channel publishes, built
//!   through the **existing** public entry points and nothing new.
//!
//! **It never blocks Ship.** The pass runs on the Challenger's own thread
//! after the last review has settled; every failure — no provider, a timeout,
//! an unparsable answer, a diff that does not apply — is dropped in silence,
//! with one log line and no retry. A card with no proposal is the normal case.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `projects/<ws>/improvement_proposal.json`.
pub const PROPOSAL_FILENAME: &str = "improvement_proposal.json";
const SCHEMA_VERSION: u32 = 1;

/// The two skill roots a proposal may name — the Claude one and the Codex
/// equivalent the card admits.
///
/// GH #104 review 2 (N1): both are carried **as themselves**, end to end. The
/// first version folded the Codex root onto the Claude one everywhere, because
/// the channel used to carry only `.claude/skills/`; #105 made it carry both
/// (`shared_library_sync::MIRROR_ROOTS`), and the fold then quoted a
/// Codex-only skill under a Claude path that does not exist — so `git apply
/// --check` could never pass and the prompt's promise ("quoted whole, exactly as
/// on disk") was false.
pub const CLAUDE_SKILLS_ROOT: &str = ".claude/skills/";
pub const CODEX_SKILLS_ROOT: &str = ".agents/skills/";

/// A proposal older than this is dropped unread (the card).
pub const MAX_AGE_MS: i64 = 30 * 24 * 3600 * 1000;

/// How long the pass may run. Shorter than a review's ten minutes: it reads
/// no diff, only the card's own record and a few short documents, and a pass
/// that has not answered by then has nothing anyone is waiting for.
pub const PASS_TIMEOUT_SECS: u64 = 5 * 60;

/// Bytes of skill and instruction text the prompt carries.
///
/// GH #104 review 1 (NIT): a file is quoted **whole or not at all**. The prompt
/// demands a diff that applies to the quoted text exactly, so quoting a cut copy
/// guaranteed a wasted pass — the model would write context lines from a `…` that
/// is not in the file. Files are offered shortest first, and one that does not
/// fit is left out and **named**, so the pass knows it may not propose there.
const LIBRARY_BUDGET: usize = 96 * 1024;
/// A single file this long is not quoted at all: it is left out and named.
const FILE_BUDGET: usize = 32 * 1024;
/// The reason and the words a proposal may carry.
const SENTENCE_MAX: usize = 600;
/// The diff a proposal may carry.
const DIFF_MAX: usize = 32 * 1024;

// ── The friction rule ────────────────────────────────────────────────

/// Why a card met friction — the sentence the proposal's reason is tied to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrictionReason {
    /// Two or more `changes_requested` rounds.
    ChangesRequested(u32),
    /// A Verify run on this card failed.
    VerifyFailed,
    /// The human typed a correction into the Builder session after its first
    /// answer.
    UserCorrections(u32),
    /// Findings filter: the member dismissed findings of the Challenger's
    /// as not a real issue.
    FindingsDismissed(u32),
}

impl FrictionReason {
    /// What the prompt tells the Challenger about the friction it is
    /// answering to. Not shown in the interface: the proposal's own reason
    /// sentence is, and the Challenger writes that.
    pub fn line(self) -> String {
        match self {
            Self::ChangesRequested(n) => {
                format!("The Reviewer asked for changes {n} times on this card.")
            }
            Self::VerifyFailed => "Verify failed on this card.".to_string(),
            Self::UserCorrections(1) => {
                "The human typed one correction into the Builder session after its first answer."
                    .to_string()
            }
            Self::UserCorrections(n) => format!(
                "The human typed {n} corrections into the Builder session after its first answer."
            ),
            Self::FindingsDismissed(1) => {
                "The human dismissed one of your findings on this card as not a real issue."
                    .to_string()
            }
            Self::FindingsDismissed(n) => format!(
                "The human dismissed {n} of your findings on this card as not a real issue."
            ),
        }
    }
}

/// What the rule reads. Every field comes off the card; nothing here reads
/// anything, so the rule is tested without a window, a repository or a CLI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrictionInput {
    /// `BuilderState::changes_requested_count`.
    pub changes_requested_rounds: u32,
    /// Any entry of `card.verify_history` with `VerifyStatus::Failed`.
    pub verify_failed: bool,
    /// `BuilderState::user_corrections` (GH #104).
    pub user_corrections: u32,
    /// Findings filter: findings of the card's ledger the member dismissed
    /// as not a real issue (`review_ledger::Dismissal`).
    pub findings_dismissed: u32,
    /// A proposal for this card is already recorded: **at most one per card**,
    /// so nothing runs again — not even after another review.
    pub already_proposed: bool,
}

/// The card's rule: two or more `changes_requested` rounds, **or** a failed
/// Verify, **or** at least one correction the human typed after the Builder's
/// first answer. `None` — and nothing runs — otherwise, and always once this
/// card already has its one proposal.
///
/// The reasons are weighed in the card's own order, so a card that met
/// friction three ways says the first of them.
pub fn met_friction(input: &FrictionInput) -> Option<FrictionReason> {
    if input.already_proposed {
        return None;
    }
    if input.changes_requested_rounds >= 2 {
        return Some(FrictionReason::ChangesRequested(input.changes_requested_rounds));
    }
    if input.verify_failed {
        return Some(FrictionReason::VerifyFailed);
    }
    if input.user_corrections >= 1 {
        return Some(FrictionReason::UserCorrections(input.user_corrections));
    }
    if input.findings_dismissed >= 1 {
        return Some(FrictionReason::FindingsDismissed(input.findings_dismissed));
    }
    None
}

// ── What a proposal may name ─────────────────────────────────────────

/// The card's allow-list: a file under the repository's `.claude/skills/` or
/// the Codex `.agents/skills/`, or a root instruction file. Everything else
/// — a source file, a test, a document, anything absolute, anything that
/// climbs out with `..` — is refused.
pub fn allowed_path(path: &str) -> bool {
    let path = path.trim();
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    if path.split('/').any(|part| part == ".." || part == ".") {
        return false;
    }
    if crate::shared_config::INSTRUCTION_FILES.contains(&path) {
        return true;
    }
    for root in [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT] {
        if let Some(rest) = path.strip_prefix(root) {
            // `.claude/skills/` itself, or `.claude/skills/deploy` with no file
            // in it, names no file to change.
            return rest.split('/').filter(|part| !part.is_empty()).count() >= 2;
        }
    }
    false
}

/// The skill directory a path under either skills root belongs to.
pub fn skill_of(path: &str) -> Option<String> {
    for root in [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT] {
        if let Some(rest) = path.strip_prefix(root) {
            return rest.split('/').find(|part| !part.is_empty()).map(str::to_string);
        }
    }
    None
}

/// One section of a unified diff: the file it reads and the file it writes.
///
/// GH #104 review 1 (MAJOR): the first version read only `+++` and the `b/` side
/// of `diff --git`, and skipped `/dev/null`. A patch whose **second** section was
/// `--- a/src-tauri/src/lib.rs` / `+++ /dev/null` therefore passed the allow-list
/// with one path, rendered as one file, and deleted a source file on approval.
/// Every name on both sides of every section is a name this change touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSection {
    /// The `---` / `a/` side. `None` for `/dev/null` — the section creates a file.
    pub old: Option<String>,
    /// The `+++` / `b/` side. `None` for `/dev/null` — the section deletes one.
    pub new: Option<String>,
}

impl DiffSection {
    /// Every name this section touches, creations and deletions included.
    pub fn names(&self) -> Vec<&str> {
        [self.old.as_deref(), self.new.as_deref()].into_iter().flatten().collect()
    }
}

fn clean_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    // `+++ b/x\t2026-09-22` — a timestamp is not part of the path.
    let raw = raw.split('\t').next().unwrap_or(raw).trim();
    // Quoted when the name has spaces or odd bytes; git's own form.
    let raw = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(raw);
    if raw.is_empty() {
        return None;
    }
    if raw == "/dev/null" {
        return None;
    }
    Some(
        raw.strip_prefix("a/")
            .or_else(|| raw.strip_prefix("b/"))
            .unwrap_or(raw)
            .to_string(),
    )
}

/// Every section of a unified diff, in order.
///
/// `diff --git a/x b/y` opens a section; `--- `, `+++ `, `rename from/to` and
/// `copy from/to` fill it. A bare patch with no `diff --git` header still opens
/// one on its `--- `, because a proposal is not required to write git-style
/// headers.
pub fn diff_sections(diff: &str) -> Vec<DiffSection> {
    let mut out: Vec<DiffSection> = Vec::new();
    let mut open: Option<DiffSection> = None;
    let mut seen_old = false;
    let flush = |open: &mut Option<DiffSection>, out: &mut Vec<DiffSection>| {
        if let Some(section) = open.take() {
            out.push(section);
        }
    };
    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush(&mut open, &mut out);
            seen_old = false;
            // `a/x b/y`. Split on " b/" so a name containing a space still works
            // for the common case; when it does not, both sides stay None and the
            // `---`/`+++` lines below fill them.
            let (left, right) = match rest.split_once(" b/") {
                Some((left, right)) => (clean_path(left), clean_path(&format!("b/{right}"))),
                None => (None, None),
            };
            open = Some(DiffSection { old: left, new: right });
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            // A second `---` without a `diff --git` between them is a second
            // section of a bare patch.
            if open.is_none() || seen_old {
                flush(&mut open, &mut out);
                open = Some(DiffSection { old: None, new: None });
            }
            if let Some(section) = open.as_mut() {
                section.old = clean_path(rest);
            }
            seen_old = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            if open.is_none() {
                open = Some(DiffSection { old: None, new: None });
            }
            if let Some(section) = open.as_mut() {
                section.new = clean_path(rest);
            }
            continue;
        }
        // A rename or a copy names two files without a hunk between them.
        for (prefix, side) in [
            ("rename from ", 0u8),
            ("copy from ", 0),
            ("rename to ", 1),
            ("copy to ", 1),
        ] {
            if let Some(rest) = line.strip_prefix(prefix) {
                if open.is_none() {
                    open = Some(DiffSection { old: None, new: None });
                }
                if let Some(section) = open.as_mut() {
                    let name = clean_path(rest);
                    if side == 0 {
                        section.old = name;
                    } else {
                        section.new = name;
                    }
                }
            }
        }
    }
    flush(&mut open, &mut out);
    // A section that named nothing at all is not a file operation.
    out.retain(|section| section.old.is_some() || section.new.is_some());
    out
}

// ── The answer ───────────────────────────────────────────────────────

/// Where a proposal's target lives. The block is drawn on that target's own
/// Library page, so this is also the routing.
/// Where a skill Ply may not write lives, in the Library's own vocabulary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ElsewhereScope {
    /// A personal skill in the member's own CLI folders. The default, so a
    /// record written before the scope was carried still loads (Tier 2) and
    /// lands on the one scope Ply may not write either way.
    #[default]
    ThisMac,
    /// The team library.
    Team,
    /// One of Ply's own.
    Ply,
}

impl ElsewhereScope {
    /// The `SCOPE:` word the prompt asks for.
    fn from_word(word: &str) -> Option<Self> {
        match word {
            "personal" => Some(Self::ThisMac),
            "team" => Some(Self::Team),
            "ply" => Some(Self::Ply),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProposalTarget {
    /// A skill in this repository. `path` is repository-relative and under
    /// [`CLAUDE_SKILLS_ROOT`] or [`CODEX_SKILLS_ROOT`] — whichever the diff
    /// names; a Codex-only skill is changed and published under its own root
    /// (GH #104 review 2).
    Skill { name: String, path: String },
    /// `AGENTS.md` or `CLAUDE.md` at the repository root.
    Instructions { file: String },
    /// A personal, Team or Ply skill: Ply never writes those, so the proposal is
    /// words only and suggests bringing a copy into the repository.
    ///
    /// `scope` is the Library's own scope id (`uxScope::Scope`), because a name
    /// alone is not a target: GH #104 review 1 (MINOR) — the block matched by
    /// name, so a proposal about the *personal* `deploy` was drawn on the
    /// **repository** `deploy`'s page, over a file it was not about.
    Elsewhere {
        name: String,
        #[serde(default)]
        scope: ElsewhereScope,
    },
}

impl ProposalTarget {
    /// The file the proposal is about, as the block's diff header names it.
    pub fn path(&self) -> String {
        match self {
            Self::Skill { path, .. } => path.clone(),
            Self::Instructions { file } => file.clone(),
            Self::Elsewhere { name, .. } => name.clone(),
        }
    }

    /// The Library scope whose page carries the block. A repository skill and an
    /// instruction file are the repository's.
    pub fn scope(&self) -> &'static str {
        match self {
            Self::Skill { .. } | Self::Instructions { .. } => "repository",
            Self::Elsewhere { scope, .. } => match scope {
                ElsewhereScope::ThisMac => "this-mac",
                ElsewhereScope::Team => "team",
                ElsewhereScope::Ply => "ply",
            },
        }
    }

    /// The word the three surfaces use for it (`deploy`, `AGENTS.md`).
    pub fn label(&self) -> String {
        match self {
            Self::Skill { name, .. } | Self::Elsewhere { name, .. } => name.clone(),
            Self::Instructions { file } => file.clone(),
        }
    }
}

/// What [`parse_answer`] made of the pass's final message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// `NONE`: the Challenger has nothing to propose. The normal answer.
    None,
    /// One proposal, ready to be checked against the repository.
    Proposal(Proposal),
    /// Nothing is recorded, and this is why. Logged, never shown: a proposal
    /// nobody asked for that could not be read is not news.
    Discarded(String),
}

/// A proposal as the answer carries it, before the repository has been asked
/// whether the diff applies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub target: ProposalTarget,
    /// One sentence, tied to the card.
    pub reason: String,
    /// The change in plain words.
    pub words: String,
    /// The unified diff, normalized. `None` for a target Ply may not write.
    pub diff: Option<String>,
    /// GH #104 walk (C2): where the lesson comes from, in the Challenger's
    /// words (`the human's correction: "…"`, `review round 2`). `None` when the
    /// answer carried no `SOURCE:` line — the proposal still stands, and says
    /// no source.
    pub source: Option<String>,
}

/// The block format the prompt asks for and this reads. Deliberately flat and
/// line-based: a schema would have to travel as `--json-schema`, and the
/// review's schema is the review's.
pub fn parse_answer(answer: &str) -> Answer {
    let answer = answer.trim();
    if answer.is_empty() {
        return Answer::Discarded("the pass answered nothing".into());
    }
    // `NONE` on its own line, wherever it sits: a Challenger that explains
    // itself first has still said NONE.
    if answer
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case("none"))
        && field(answer, "TARGET").is_none()
    {
        return Answer::None;
    }
    let Some(raw_target) = field(answer, "TARGET") else {
        return Answer::Discarded("the answer named no target".into());
    };
    let Some(reason) = field(answer, "REASON").filter(|s| !s.is_empty()) else {
        return Answer::Discarded("the answer carried no reason".into());
    };
    let Some(words) = field(answer, "CHANGE").filter(|s| !s.is_empty()) else {
        return Answer::Discarded("the answer did not say the change in words".into());
    };
    let scope = field(answer, "SCOPE").unwrap_or_default().to_ascii_lowercase();
    let diff = fenced_diff(answer);
    // GH #104 walk (C2): optional — a proposal without it is kept, sourceless.
    let source = field(answer, "SOURCE")
        .filter(|s| !s.is_empty())
        .map(|s| cap(&s, SENTENCE_MAX));

    // A personal, Team or Ply skill: words only, never a diff, because Ply
    // does not write those files (ADR 0005, BOARDS.md §4 state D).
    if let Some(elsewhere) = ElsewhereScope::from_word(&scope) {
        let Some(name) = skill_of(&raw_target).or_else(|| bare_name(&raw_target)) else {
            return Answer::Discarded(format!(
                "a {scope} proposal named no skill: {raw_target:?}"
            ));
        };
        return Answer::Proposal(Proposal {
            target: ProposalTarget::Elsewhere { name, scope: elsewhere },
            reason: cap(&reason, SENTENCE_MAX),
            words: cap(&words, SENTENCE_MAX),
            diff: None,
            source,
        });
    }

    if !allowed_path(&raw_target) {
        return Answer::Discarded(format!(
            "the target is outside the repository's skills and instructions: {raw_target:?}"
        ));
    }
    let Some(diff) = diff else {
        return Answer::Discarded(format!("a repository proposal for {raw_target:?} carried no diff"));
    };
    if diff.len() > DIFF_MAX {
        return Answer::Discarded(format!(
            "the diff is {} KiB, more than a proposal carries ({} KiB)",
            diff.len().div_ceil(1024),
            DIFF_MAX / 1024
        ));
    }
    // GH #104 review 2 (N2): a patch with no hunk changes no content — a
    // mode-only or binary patch would otherwise pass, be stored with a diff, and
    // put an enabled `Approve and publish` under the words-only sentence.
    if !diff.lines().any(|line| line.starts_with("@@")) {
        return Answer::Discarded("the diff has no hunk, so it changes no content".into());
    }
    let path = raw_target.trim().to_string();
    let sections = diff_sections(&diff);
    if sections.is_empty() {
        return Answer::Discarded("the diff names no file".into());
    }
    // Every name on **both** sides of **every** section: a deletion
    // (`+++ /dev/null`) is a file operation whose only name is on the `---` side,
    // and a rename touches two. Review 1 (MAJOR) found the first version reading
    // the written side only, so a second section deleting a source file passed.
    for section in &sections {
        for name in section.names() {
            if !allowed_path(name) {
                return Answer::Discarded(format!(
                    "the diff touches something outside the repository's skills and instructions: {name:?}"
                ));
            }
        }
    }
    if sections.len() > 1 {
        return Answer::Discarded(format!(
            "a proposal is one change to one file; this diff has {} file sections",
            sections.len()
        ));
    }
    let section = &sections[0];
    // One file, changed in place: no creation, no deletion, no rename. A
    // proposal adds a sentence to a document that already exists.
    let (Some(old_name), Some(new_name)) = (section.old.as_deref(), section.new.as_deref()) else {
        return Answer::Discarded(
            "a proposal changes a file that is already there; it never creates, deletes or renames one"
                .into(),
        );
    };
    if old_name != new_name {
        return Answer::Discarded(format!(
            "the diff renames {old_name:?} to {new_name:?}; a proposal changes one file in place"
        ));
    }
    if new_name != path {
        return Answer::Discarded(format!(
            "the diff writes {new_name:?}, not the target {path:?}"
        ));
    }
    let target = if crate::shared_config::INSTRUCTION_FILES.contains(&path.as_str()) {
        ProposalTarget::Instructions { file: path }
    } else {
        match skill_of(&path) {
            Some(name) => ProposalTarget::Skill { name, path },
            None => return Answer::Discarded(format!("{path:?} is in no skill")),
        }
    };
    Answer::Proposal(Proposal {
        target,
        reason: cap(&reason, SENTENCE_MAX),
        words: cap(&words, SENTENCE_MAX),
        diff: Some(diff),
        source,
    })
}

/// `FIELD: value`, case-insensitive, first occurrence, with a value that may
/// run on over the following indented or unlabelled lines.
fn field(answer: &str, name: &str) -> Option<String> {
    let mut lines = answer.lines();
    let mut value = String::new();
    let mut found = false;
    for line in lines.by_ref() {
        let Some((head, rest)) = line.split_once(':') else {
            continue;
        };
        if head.trim().eq_ignore_ascii_case(name) {
            value.push_str(rest.trim());
            found = true;
            break;
        }
    }
    if !found {
        return None;
    }
    // A continuation is a plain line: another `FIELD:` or a fence ends it.
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("```") {
            break;
        }
        if let Some((head, _)) = line.split_once(':') {
            let head = head.trim();
            if !head.is_empty()
                && head.chars().all(|c| c.is_ascii_uppercase() || c == ' ' || c == '_')
            {
                break;
            }
        }
        if !value.is_empty() {
            value.push(' ');
        }
        value.push_str(trimmed);
    }
    Some(value.trim().to_string())
}

/// The first **diff** fenced block.
///
/// A diff outside a fence is not read: a unified diff's own `---` and `+++`
/// lines are indistinguishable from prose about a file otherwise.
///
/// GH #104 review 1 (NIT): the first version scanned for an opening fence
/// without tracking whether it was already **inside** one, so a ```markdown
/// block before the diff had its closing ``` read as the diff's opening fence
/// and the whole proposal was discarded. Fences are now paired.
fn fenced_diff(answer: &str) -> Option<String> {
    let mut lines = answer.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("```") {
            continue;
        }
        let tag = trimmed.trim_start_matches('`').trim().to_ascii_lowercase();
        // Collect this block whatever its tag, so the closing fence is consumed
        // with it and the next `\u{60}\u{60}\u{60}` is an opening one again.
        let mut body = String::new();
        let mut closed = false;
        for inner in lines.by_ref() {
            if inner.trim_start().starts_with("```") {
                closed = true;
                break;
            }
            body.push_str(inner);
            body.push('\n');
        }
        let is_diff = tag.is_empty() || tag == "diff" || tag == "patch";
        let body = body.trim_end_matches('\n').to_string();
        if is_diff && !body.trim().is_empty() {
            return Some(body);
        }
        // An unterminated fence ends the answer: there is no next block.
        if !closed {
            return None;
        }
    }
    None
}

/// `deploy` out of `deploy`, `the deploy skill`, `personal:deploy`.
fn bare_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { ' ' })
        .collect();
    cleaned
        .split_whitespace()
        .find(|word| !matches!(*word, "the" | "skill" | "personal" | "team" | "ply"))
        .map(str::to_string)
}

fn cap(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", text[..end].trim_end())
}

// ── Does it apply? ───────────────────────────────────────────────────

/// `git apply --check` in `repo`, read-only: git is told to report whether the
/// patch would apply and never to apply it, so nothing in the checkout, its
/// index or its branch is touched. The patch goes to a temporary file, which
/// is removed with it.
///
/// A proposal whose diff does not apply cleanly to the tree it will be
/// published from is discarded (the card): approving it later would publish
/// content nobody read.
/// [`applies_cleanly_with`] with git resolved from the cached probe.
///
/// The `_with` form takes git already resolved, so the check is tested without
/// the global probe cache (the `pinned_read::git_capture_with` shape).
pub fn applies_cleanly_with(git: &str, repo: &Path, diff: &str) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("temporary directory: {e}"))?;
    let patch = dir.path().join("proposal.patch");
    // The trailing newline git wants at the end of a patch.
    let text = if diff.ends_with('\n') { diff.to_string() } else { format!("{diff}\n") };
    std::fs::write(&patch, text.as_bytes()).map_err(|e| format!("write the patch: {e}"))?;
    let output = crate::platform::new_command(git)
        .args(["apply", "--check", "--whitespace=nowarn"])
        .arg(&patch)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("spawn git apply: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "the diff does not apply to this repository: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// The bytes `diff` produces from `repo`'s copy of the one file it writes.
///
/// Applied in a throwaway copy of that single file, so nothing under `repo` is
/// written — `Approve` publishes to the shared channel and writes no working
/// tree, the same rule `library_instructions_set_up` follows. `repo` is the
/// **mirror** for a file the branch carries (GH #104 review 1, BLOCKER).
pub fn patched_bytes_with(
    git: &str,
    repo: &Path,
    path: &str,
    diff: &str,
) -> Result<Vec<u8>, String> {
    let source = repo.join(path);
    let before = std::fs::read(&source).map_err(|e| format!("read {path}: {e}"))?;
    let dir = tempfile::tempdir().map_err(|e| format!("temporary directory: {e}"))?;
    let root = dir.path();
    let target = root.join(path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("temporary {path}: {e}"))?;
    }
    std::fs::write(&target, &before).map_err(|e| format!("temporary {path}: {e}"))?;
    let patch = root.join("proposal.patch");
    let text = if diff.ends_with('\n') { diff.to_string() } else { format!("{diff}\n") };
    std::fs::write(&patch, text.as_bytes()).map_err(|e| format!("write the patch: {e}"))?;
    let mut command = crate::platform::new_command(git);
    // The bytes are published as they come out: Git for Windows' default
    // `core.autocrlf` must not turn the file's LF into CRLF on the way.
    #[cfg(windows)]
    command.args(["-c", "core.autocrlf=false"]);
    let output = command
        .args(["apply", "--whitespace=nowarn"])
        .arg(&patch)
        .current_dir(root)
        .output()
        .map_err(|e| format!("spawn git apply: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "the diff no longer applies: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    std::fs::read(&target).map_err(|e| format!("read the patched {path}: {e}"))
}

/// The target's content, as the staleness rule identifies it.
pub fn content_id(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// The recorded content id of `path` in `repo`, or `None` when Ply cannot
/// read it (it was removed, or it never was a file).
pub fn target_content_id(repo: &Path, path: &str) -> Option<String> {
    std::fs::read(repo.join(path)).ok().map(|bytes| content_id(&bytes))
}

/// Git's own blob id for the bytes at `repo/path` — what the integration
/// branch calls that content.
///
/// GH #104 review 1 (BLOCKER): "never override" is a question about a **blob on
/// the branch** (`shared_library_sync::moved_instruction_files`), so the base a
/// proposal records has to be one. Computed here rather than read from the
/// mirror's manifest, because the base must be the blob of what the **Challenger
/// read**: when the checkout is stale, that blob is not the tip's, `prepare`
/// sees the difference and the change goes into a pull request instead of over
/// somebody's rule. Read-only: `hash-object` without `-w` writes nothing.
///
/// SP-5 review (Windows parity): a tracked file with no changes is the
/// index's blob, read as git records it. Hashing it again would put it through
/// today's filters — with `core.autocrlf=true` a file committed with CRLF
/// hashes to an LF blob the branch has never had, though `git status` is clean.
pub fn target_blob_with(git: &str, repo: &Path, path: &str) -> Option<String> {
    let file = repo.join(path);
    if !file.is_file() {
        return None;
    }
    let unchanged = crate::platform::new_command(git)
        .args(["diff", "--quiet", "--"])
        .arg(path)
        .current_dir(repo)
        .output()
        .is_ok_and(|out| out.status.success());
    if unchanged {
        if let Ok(out) = crate::platform::new_command(git)
            .args(["rev-parse", "--verify", "--quiet", &format!(":./{path}")])
            .current_dir(repo)
            .output()
        {
            let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !id.is_empty() {
                return Some(id);
            }
        }
    }
    let output = crate::platform::new_command(git)
        .args(["hash-object", "-t", "blob", "--"])
        .arg(&file)
        .current_dir(repo)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!id.is_empty()).then_some(id)
}

// ── What is kept ─────────────────────────────────────────────────────

/// One workspace's improvement proposal, on This Mac.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProposal {
    pub target: ProposalTarget,
    /// The card it came out of, so the Inbox can say `After card #88`.
    pub card_id: String,
    /// How the card is named to a human: `#88`, or its title.
    pub card_ref: String,
    pub reason: String,
    pub words: String,
    /// `None` for a target Ply may not write (words only).
    #[serde(default)]
    pub diff: Option<String>,
    /// The target's content when the proposal was written. A different one on
    /// read means the file moved on under it, and the proposal is dropped.
    /// `None` for a words-only proposal, which has no content to compare.
    #[serde(default)]
    pub target_content_id: Option<String>,
    /// GH #104 review 1 (BLOCKER): git's blob id for the very bytes the
    /// Challenger read. This is the `bases` entry an instructions publish
    /// carries, so a checkout that was stale when the proposal was written can
    /// never be committed over the branch: `prepare` compares this against the
    /// freshly fetched tip and opens a pull request on any difference. `None` on
    /// a words-only proposal and on records written before this.
    #[serde(default)]
    pub target_blob: Option<String>,
    /// Unix ms.
    pub created_at: i64,
    /// GH #104 walk (C2): the answer's `SOURCE:` line. `None` when it carried
    /// none, and on records written before it.
    #[serde(default)]
    pub source: Option<String>,
}

/// `projects/<ws>/improvement_proposal.json`.
///
/// **One proposal per workspace, not one per card.** The card fixes "at most one
/// proposal per card" (`proposed_cards`, which survives a `Dismiss` and a
/// restart), and the board draws one block, one Inbox row and one Ship line — so
/// a later card's proposal replaces an earlier one that nobody answered. That is
/// the honest reading of a suggestion nobody asked for: the newest is the one
/// tied to what just went wrong, and a queue of them would be a backlog the
/// member never agreed to keep.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalFile {
    pub schema_version: u32,
    #[serde(default)]
    pub proposal: Option<StoredProposal>,
    /// Cards that already had their pass, so `at most one per card` survives a
    /// `Dismiss` and a restart. Newest last, capped.
    #[serde(default)]
    pub proposed_cards: Vec<String>,
    /// The card whose last pass stopped at Claude's trust question
    /// (`claude_session::FOLDER_TRUST_REFUSAL`): the one silent failure the
    /// card shows, as the trust step, where its proposal would appear.
    /// Cleared by the next pass that gets past the question. Absent in files
    /// written before it (`None`), and not written while `None`, so an older
    /// Plyloft reads the file as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_stopped_card: Option<String>,
}

const PROPOSED_CARDS_CAP: usize = 200;

impl Default for ProposalFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            proposal: None,
            proposed_cards: Vec::new(),
            trust_stopped_card: None,
        }
    }
}

pub fn proposal_path(workspace_dir: &Path) -> PathBuf {
    workspace_dir.join(PROPOSAL_FILENAME)
}

/// Read the file. A missing or unreadable one is "no proposal": this is a
/// suggestion nobody asked for, and a parse error must not stop the Library
/// from drawing (the queue's own rule, `load_queue`).
pub fn load(workspace_dir: &Path) -> ProposalFile {
    let path = proposal_path(workspace_dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return ProposalFile::default();
    };
    match serde_json::from_slice::<ProposalFile>(&bytes) {
        Ok(file) if file.schema_version <= SCHEMA_VERSION => file,
        Ok(file) => {
            log::warn!(
                "proposals: {} was written by a newer Plyloft (schema {}); leaving it alone",
                path.display(),
                file.schema_version
            );
            ProposalFile::default()
        }
        Err(e) => {
            log::warn!("proposals: unreadable {}: {e}", path.display());
            ProposalFile::default()
        }
    }
}

/// Write it atomically (tempfile plus rename — AGENTS.md hard rule 3).
pub fn save(workspace_dir: &Path, file: &ProposalFile) -> Result<(), String> {
    std::fs::create_dir_all(workspace_dir)
        .map_err(|e| format!("create {}: {e}", workspace_dir.display()))?;
    crate::atomic::write_atomic_json(&proposal_path(workspace_dir), file)
}

/// What the three surfaces read: the proposal, or nothing at all.
///
/// Built by [`current`], which is the **one** reader: the staleness rules are
/// applied there and a dropped proposal is forgotten on disk at the same time,
/// so the block, the Inbox item and the Ship step can never disagree about
/// whether there is one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub target: ProposalTarget,
    /// `deploy`, `AGENTS.md` — the word the three surfaces use.
    pub label: String,
    /// The Library scope whose page carries the block, so the block cannot land
    /// on another copy of the same name (review 1, MINOR).
    pub scope: String,
    /// Repository-relative, for the diff's header.
    pub path: String,
    pub card_id: String,
    pub card_ref: String,
    pub reason: String,
    pub words: String,
    #[serde(default)]
    pub diff: Option<String>,
    pub created_at: i64,
    /// A read-only collaborator is not offered `Approve and publish`.
    pub can_approve: bool,
    /// SP-5: the branch an approval commits to on this Mac — a workspace with
    /// no shared definition whose repository has no remote. The button then
    /// says `Approve and commit to <branch>`; `None`: `Approve and publish`.
    pub commit_to: Option<String>,
    /// SP-5 review: why `Approve and commit to <branch>` can't work here, said
    /// in place of the button (which is then not offered).
    pub approve_blocked: Option<String>,
    /// SP-5 walk: what Approve does to the skill's other CLI's copy — it
    /// changes too, or only this one changes — said before the press.
    pub copies_note: Option<String>,
    /// GH #104 walk (C2): where the lesson comes from; `None` says nothing.
    pub source: Option<String>,
}

/// What a read of the workspace's proposal found.
#[derive(Debug, Clone)]
pub struct CurrentProposal {
    pub view: Option<ProposalView>,
    /// This read dropped a stale proposal, so the other surfaces are now wrong
    /// and have to be told (`PROPOSAL_CHANGED_EVENT`).
    pub dropped: bool,
}

/// The workspace's proposal as it stands now, with the staleness rules
/// applied. `None` — and the file forgotten — when it is older than 30 days,
/// when its target changed under it, or when there never was one.
pub fn current(
    workspace_dir: &Path,
    cwd: &Path,
    can_approve: bool,
    now_ms: i64,
) -> CurrentProposal {
    let file = load(workspace_dir);
    let Some(proposal) = file.proposal.as_ref() else {
        return CurrentProposal { view: None, dropped: false };
    };
    let path = proposal.target.path();
    let now = match &proposal.target {
        ProposalTarget::Elsewhere { .. } => None,
        _ => target_content_id(cwd, &path),
    };
    if let Some(reason) = stale_reason(proposal, now_ms, now.as_deref()) {
        log::info!(
            "proposals: dropping the proposal for {path} ({})",
            match reason {
                StaleReason::TooOld => "older than 30 days",
                StaleReason::TargetChanged => "its target changed since",
            }
        );
        if let Err(e) = with_file(workspace_dir, |file| {
            file.proposal = None;
        }) {
            log::warn!("proposals: could not forget the stale proposal: {e}");
        }
        return CurrentProposal { view: None, dropped: true };
    }
    CurrentProposal {
        dropped: false,
        view: Some(ProposalView {
            target: proposal.target.clone(),
            label: proposal.target.label(),
            scope: proposal.target.scope().to_string(),
            path,
            card_id: proposal.card_id.clone(),
            card_ref: proposal.card_ref.clone(),
            reason: proposal.reason.clone(),
            words: proposal.words.clone(),
            // A proposal Ply may not publish carries no diff, and `Approve` is not
            // offered for one (`approve_change_full` refuses it in words as well).
            diff: proposal.diff.clone(),
            created_at: proposal.created_at,
            can_approve: can_approve && proposal.diff.is_some(),
            commit_to: None,
            approve_blocked: None,
            copies_note: None,
            source: proposal.source.clone(),
        }),
    }
}

/// `Dismiss`: forget it. The card is still remembered, so no second pass runs.
pub fn dismiss(workspace_dir: &Path) -> Result<(), String> {
    with_file(workspace_dir, |file| {
        file.proposal = None;
    })
}

/// Why a stored proposal is not shown any more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReason {
    /// Older than 30 days.
    TooOld,
    /// The target's content changed since, or the target is gone.
    TargetChanged,
}

/// The card's two staleness rules, pure. `current` is the target's content id
/// now, `None` when Ply cannot read the target at all.
pub fn stale_reason(
    proposal: &StoredProposal,
    now_ms: i64,
    current: Option<&str>,
) -> Option<StaleReason> {
    if now_ms.saturating_sub(proposal.created_at) > MAX_AGE_MS {
        return Some(StaleReason::TooOld);
    }
    match (&proposal.target_content_id, current) {
        // A words-only proposal has no target content to compare.
        (None, _) => None,
        (Some(recorded), Some(now)) if recorded == now => None,
        _ => Some(StaleReason::TargetChanged),
    }
}

// ── The prompt ───────────────────────────────────────────────────────

/// One file the pass may change, as the prompt quotes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryFileText {
    /// Repository-relative.
    pub path: String,
    pub text: String,
}

/// What [`library_files`] found: the files quoted whole, and the ones too long
/// to quote, which the prompt names so the pass does not propose there.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryQuote {
    pub quoted: Vec<LibraryFileText>,
    /// Repository-relative paths left out, with why in the prompt's words.
    pub left_out: Vec<String>,
}

/// Exactly the card's list of inputs.
#[derive(Debug, Clone, Default)]
pub struct PromptInput<'a> {
    /// How the card is named to a human (`#88`), for the reason sentence.
    pub card_ref: &'a str,
    /// The card's brief, as the Builder received it (`review_context::brief_of`).
    pub brief: &'a str,
    /// Each review round's verdict with its findings, newest first.
    pub verdicts: Vec<String>,
    /// The Verify failures' summaries.
    pub verify_failures: Vec<String>,
    /// The repository's skills and instruction files it may change, quoted
    /// whole, plus the ones too long to quote.
    pub library: LibraryQuote,
    /// Why this card counted as friction.
    pub friction: Option<FrictionReason>,
    /// GH #104 walk (B3): the human's own corrections to the Builder, in their
    /// words, oldest first (`BuilderState::correction_texts`).
    pub corrections: Vec<String>,
    /// `BuilderState::user_corrections`: how many were typed, which is more
    /// than `corrections` holds on a card recorded before the words were kept
    /// (or past the last five).
    pub corrections_typed: u32,
    /// GH #104 walk (B3): how each request for changes ended, in words
    /// ([`decision_lines`]).
    pub decisions: Vec<String>,
}

/// Findings filter: each finding the member dismissed as not a real issue,
/// in words, for the proposal's Challenger to read as the human's decision.
pub fn dismissal_lines(ledger: &crate::review_ledger::CardLedger) -> Vec<String> {
    ledger
        .findings
        .iter()
        .filter_map(|finding| {
            let dismissal = finding.dismissal.as_ref()?;
            let reason = match dismissal.reason.as_deref() {
                Some(reason) => format!(", because: \"{}\"", reason.replace('"', "'")),
                None => " (no reason given)".to_string(),
            };
            Some(format!(
                "The Reviewer raised {} ({} — {}); the human dismissed it as not a real issue{reason}.",
                finding.id,
                finding.severity.as_deref().unwrap_or("Unrated"),
                finding.title.trim()
            ))
        })
        .collect()
}

/// The skills and instruction files the prompt carries, each **whole**.
///
/// Both skill roots are read (GH #104 review 1, NIT): the allow-list admits the
/// Codex `.agents/skills/`, so a repository that carries only the Codex copy of a
/// skill must be able to have it changed. A name present under both roots is
/// quoted once, under the Claude path, because that is the one the channel
/// publishes and the one a diff is folded onto.
pub fn library_files(repo: &Path) -> LibraryQuote {
    let mut found: Vec<LibraryFileText> = Vec::new();
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for name in crate::shared_config::INSTRUCTION_FILES {
        if let Ok(text) = std::fs::read_to_string(repo.join(name)) {
            found.push(LibraryFileText { path: name.to_string(), text });
        }
    }
    // Only `SKILL.md`: it is what a skill tells the agent, and the whole point of
    // the change. A skill's other files are reachable with the harness's `Read`.
    for root in [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT] {
        let skills = repo.join(root.trim_end_matches('/'));
        let Ok(entries) = std::fs::read_dir(&skills) else {
            continue;
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        names.sort();
        for name in names {
            // One entry per skill name, at the path it really has: the Claude
            // root when the repository carries it there, the Codex root when
            // that is the only copy. A skill at both roots is offered — and so
            // changed — at the Claude one, so a proposal never leaves the two
            // copies drifting (#105's `Align` is the answer to drift, not this).
            if !seen.insert(name.clone()) {
                continue;
            }
            let path = format!("{root}{name}/SKILL.md");
            if let Ok(text) = std::fs::read_to_string(repo.join(&path)) {
                found.push(LibraryFileText { path, text });
            }
        }
    }
    found.sort_by_key(|file| file.text.len());
    let mut budget = LIBRARY_BUDGET;
    let mut out = LibraryQuote::default();
    for file in found {
        // Whole or not at all: a cut quote and "the diff must apply to it
        // exactly" cannot both be true.
        if file.text.len() > FILE_BUDGET || file.text.len() > budget {
            out.left_out.push(file.path);
            continue;
        }
        budget -= file.text.len();
        out.quoted.push(file);
    }
    out.quoted.sort_by(|a, b| a.path.cmp(&b.path));
    out.left_out.sort();
    out
}

/// The pass's one prompt. Read-only by construction: it asks for a diff, and
/// the harness denies every write (`read_only_provider`).
pub fn proposal_prompt(input: &PromptInput<'_>) -> String {
    let mut out = String::new();
    out.push_str(
        "You are the Reviewer. This card met friction, and you get one short, \
read-only pass to propose at most ONE improvement to this repository's own \
instructions — the thing that would have stopped the friction happening again.\n\n\
You are NOT reviewing the code. You are asking: which sentence, missing from a \
skill or from the agent instructions, let this card go wrong?\n\n",
    );
    if let Some(friction) = input.friction {
        out.push_str(&format!("## The friction\n\n{}\n\n", friction.line()));
    }
    out.push_str(&format!("## The card ({})\n\n{}\n\n", input.card_ref, input.brief.trim()));
    out.push_str(&human_section(&input.corrections, input.corrections_typed, &input.decisions));
    if input.verdicts.is_empty() {
        out.push_str("## The reviews\n\nNo verdict was recorded.\n\n");
    } else {
        out.push_str("## The reviews, newest first\n\n");
        for verdict in &input.verdicts {
            out.push_str(verdict.trim());
            out.push_str("\n\n");
        }
    }
    if input.verify_failures.is_empty() {
        out.push_str("## Verify\n\nNo Verify failure was recorded on this card.\n\n");
    } else {
        out.push_str("## The Verify failures\n\n");
        for failure in &input.verify_failures {
            out.push_str(&format!("- {}\n", failure.trim()));
        }
        out.push('\n');
    }
    out.push_str(
        "## What you may change\n\n\
Only these files, and only one of them:\n\n",
    );
    if input.library.quoted.is_empty() {
        out.push_str(
            "This repository carries no skills and no agent instructions short enough to \
quote here, so there is nothing you may change. Answer NONE.\n\n",
        );
    } else {
        for file in &input.library.quoted {
            out.push_str(&format!("===== {} =====\n{}\n\n", file.path, file.text.trim_end()));
        }
        out.push_str(
            "Each file above is quoted **whole**, exactly as it is on disk, so a diff \
against it can be trusted to apply.\n\n",
        );
    }
    if !input.library.left_out.is_empty() {
        out.push_str(&format!(
            "These are too long to quote here, so you may **not** propose a change to \
them — a diff you wrote without seeing the file would not apply and would be \
discarded:\n{}\n\n",
            input
                .library
                .left_out
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n"),
        ));
    }
    out.push_str(&format!(
        "Nothing else. A change to a source file, a test, a document, or anything \
outside `{CLAUDE_SKILLS_ROOT}`, `{CODEX_SKILLS_ROOT}`, `{}` and `{}` is discarded \
unread.\n\n",
        crate::shared_config::INSTRUCTION_FILES[0],
        crate::shared_config::INSTRUCTION_FILES[1],
    ));
    out.push_str(
        "## How to answer\n\n\
If nothing here is worth changing — the friction was this card's own, not the \
repository's — answer with the single word:\n\n\
NONE\n\n\
Most cards get NONE, and NONE is a good answer. Propose something only when a \
named file is missing a specific instruction that would have prevented this.\n\n\
Otherwise answer in exactly this shape, and nothing else:\n\n\
SCOPE: repository\n\
TARGET: <one repository-relative path from the list above>\n\
REASON: <one sentence, naming this card and what went wrong>\n\
SOURCE: <where the lesson comes from — the human's correction: \"<their words, \
quoted>\", or review round <N>, or the Verify failure>\n\
CHANGE: <the change in plain words, two or three sentences, saying what is \
added and what is removed>\n\
DIFF:\n\
```diff\n\
--- a/<the same path>\n\
+++ b/<the same path>\n\
@@ ... @@\n\
 <context>\n\
+<the added lines>\n\
```\n\n\
Rules the answer must hold to, or it is discarded:\n\n\
- One file. One diff. The diff's path is the TARGET.\n\
- A real unified diff with real context lines, that applies to the text quoted \
above exactly as it stands.\n\
- Small: a few lines. A rewrite is not a proposal.\n\
- REASON is one sentence and names the card.\n\
- SOURCE names the correction (quoted), the review round or the Verify failure \
the lesson comes from.\n\
- The change goes the way the human decided, never against it.\n\n\
If the trouble sits in a **personal**, **Team** or **Plyloft** skill instead — one \
this repository does not carry — say so in words and carry NO diff:\n\n\
SCOPE: personal\n\
TARGET: <the skill's name>\n\
REASON: <one sentence naming this card>\n\
SOURCE: <where the lesson comes from, as above>\n\
CHANGE: <what would have to change, and that bringing a copy of it into this \
repository is how it gets there>\n",
    );
    out
}

/// GH #104 walk (B3): the section that gives the Challenger the human's side,
/// and the rule that keeps a proposal from going against it.
///
/// Found by a Tier 4 walk: the human told the Builder "every new function is
/// named with a calc prefix", the Challenger asked for the brief's name back,
/// and the proposal pass — which saw only a correction **count** — proposed
/// "use the exact function name requested by the card", the opposite of the
/// human's rule.
pub fn human_section(corrections: &[String], typed: u32, decisions: &[String]) -> String {
    let mut out = String::from("## What the human decided (authoritative)\n\n");
    let unkept = (typed as usize).saturating_sub(corrections.len());
    if corrections.is_empty() && unkept == 0 && decisions.is_empty() {
        out.push_str("No correction or decision by the human was recorded on this card.\n\n");
    }
    // Challenger minor 1: a card recorded before the words were kept (or past
    // the last five) still had corrections — say so, rather than "none".
    if unkept > 0 {
        out.push_str(&format!(
            "The human typed {} into the Builder session whose words were not kept. \
They are still authoritative: where the reviews and the outcomes below show which way \
the human went, a proposal goes that way.\n\n",
            if unkept == 1 { "one correction".to_string() } else { format!("{unkept} corrections") },
        ));
    }
    if !corrections.is_empty() {
        out.push_str(
            "The human typed these corrections into the Builder session, in their own words, \
oldest first:\n\n",
        );
        for (i, text) in corrections.iter().enumerate() {
            let quoted = text.trim().lines().collect::<Vec<_>>().join("\n   > ");
            out.push_str(&format!("{}. > {quoted}\n", i + 1));
        }
        out.push('\n');
    }
    if !decisions.is_empty() {
        out.push_str("How each request for changes ended:\n\n");
        for line in decisions {
            out.push_str(&format!("- {}\n", line.trim()));
        }
        out.push('\n');
    }
    out.push_str(
        "These are the human's decisions, and they are authoritative: they outrank the \
card's brief and every review, including yours. A proposal must go in the direction \
of the human's corrections and decisions. If the only lesson you can draw would \
contradict a correction or a decision above, answer NONE. Where the human overruled \
a request of yours (the Reviewer's), the lesson may target the instruction that \
would have kept you from asking for it — never one that repeats the request.\n\n",
    );
    out
}

/// GH #104 walk (B3): how each changes-requested round ended, as the card
/// recorded it, in the prompt's words — oldest first, then where the last
/// review leaves the card.
pub fn decision_lines(builder: &crate::kanban::BuilderState) -> Vec<String> {
    use crate::kanban::RequestOutcome;
    let mut out: Vec<String> = builder
        .review_decisions
        .iter()
        .map(|decision| match decision.outcome {
            RequestOutcome::PushbackAccepted => format!(
                "The Reviewer asked for changes on snapshot {}; the Builder pushed back, and \
the human accepted the Builder's pushback — the code stayed as it was and the \
Reviewer's request was overruled.",
                decision.snapshot_n
            ),
            RequestOutcome::BuilderChanged => format!(
                "The Reviewer asked for changes on snapshot {}; the Builder changed the code{}.",
                decision.snapshot_n,
                decision
                    .next_snapshot_n
                    .map(|n| format!(" (snapshot {n})"))
                    .unwrap_or_default()
            ),
        })
        .collect();
    if let Some(review) = builder.review.as_ref() {
        // Challenger minor 2: a pushback accepted before `review_decisions`
        // existed is still on the card, as its last review overridden.
        let recorded = builder.review_decisions.iter().any(|decision| {
            decision.snapshot_n == review.snapshot_n
                && decision.outcome == RequestOutcome::PushbackAccepted
        });
        if review.status == "skipped" && review.note.is_some() && !recorded {
            out.push(format!(
                "The Reviewer asked for changes on snapshot {}; the Builder pushed back, and \
the human accepted the Builder's pushback — the code stayed as it was and the \
Reviewer's request was overruled.",
                review.snapshot_n
            ));
        }
        if review.status == "done" && review.verdict.as_deref() == Some("approve") {
            out.push(format!(
                "The last review, of snapshot {}, approved the change.",
                review.snapshot_n
            ));
        }
    }
    out
}

/// GH #104 walk (A2): whether the card is **settled** — the only moment the
/// pass may run. `Err` says what it still waits for.
///
/// Settled: the last review approved, **or** its request for changes was
/// overruled by the human (the Builder's pushback accepted); and nothing else
/// waits — no review running or waiting, no request for changes nobody
/// re-checked, no request for changes on the card's `review_status`. A request
/// for changes standing on the card is a decision the human has not made yet:
/// the Builder may be pushing back, and a pass that ran then read the
/// Challenger's side alone (the Tier 4 walk's proposal went against the
/// human's rule four minutes before the human accepted the pushback).
pub fn card_settled(card: &crate::kanban::KanbanCard) -> Result<(), String> {
    let builder = card
        .builder
        .as_ref()
        .ok_or_else(|| "the card has no Builder session".to_string())?;
    if builder.waiting_review.is_some() {
        return Err("a review is still waiting to run".into());
    }
    if builder.handed_over.is_some() {
        return Err("a request for changes has not been re-checked".into());
    }
    // Not a copy of the review check below: the per-hunk review's follow-up
    // (`mark_review_followup`) sets it too, with the Challenger's review
    // approved — a request for changes the human made and is waiting on.
    if matches!(card.review_status, Some(crate::kanban::ReviewStatus::ChangesRequested)) {
        return Err("a request for changes waits for the human's decision".into());
    }
    let review = builder
        .review
        .as_ref()
        .ok_or_else(|| "no review has settled on the card".to_string())?;
    match (review.status.as_str(), review.verdict.as_deref()) {
        ("done", Some("approve")) => Ok(()),
        // The human accepted the Builder's pushback (`override_changes_requested`).
        ("skipped", _) if review.note.is_some() => Ok(()),
        ("done", Some("changes_requested")) => {
            Err("the Reviewer's request for changes waits for the human's decision".into())
        }
        ("running", _) => Err("a review is still running".into()),
        _ => Err("the last review neither approved nor was overruled by the human".into()),
    }
}

// ── The pass ─────────────────────────────────────────────────────────

/// GH #104: the Challenger's improvement-proposal pass, after the last review
/// of a card has settled.
///
/// Called from `builder::challenger_loop` when no further review waits. It is
/// already on the Challenger's own thread, so it blocks nothing: Ship, the
/// board and the Library carry on whatever happens here, and every failure
/// returns quietly — except Claude's trust question, which the card shows as
/// the trust step (`trustStoppedCard`). There is no automatic retry: a pass
/// that could not run leaves the card as a card with no friction leaves it,
/// except that one that never started, or stopped at the trust question,
/// gives its claim back, so the card's next settled review runs it again.
pub fn after_last_review(app: &tauri::AppHandle, workspace_id: &str, card_id: &str) {
    use tauri::Emitter;
    match run_pass(app, workspace_id, card_id) {
        Ok(Some(target)) => {
            log::info!("proposals: {card_id} proposes a change to {}", target.path());
            let _ = app.emit(PROPOSAL_CHANGED_EVENT, workspace_id);
        }
        // #104 walk 2026-09-30: said, so a pass that answered NONE is not
        // mistaken for one that stalled.
        Ok(None) => log::info!(
            "proposals: {card_id} (workspace {workspace_id}) answered NONE, no proposal"
        ),
        Err(reason) => log::info!("proposals: no proposal for {card_id}: {reason}"),
    }
}

/// GH #104 walk (A2): the human settled the card — accepted the Builder's
/// pushback — so the pass that the last review could not run (a request for
/// changes still stood) runs now, on a thread of its own, exactly as
/// [`after_last_review`] does: never blocking the press, dropped in silence.
pub fn after_human_decision(app: &tauri::AppHandle, workspace_id: &str, card_id: &str) {
    let (app, workspace_id, card_id) = (app.clone(), workspace_id.to_string(), card_id.to_string());
    let spawned = std::thread::Builder::new()
        .name(format!("proposal-{card_id}"))
        .spawn(move || after_last_review(&app, &workspace_id, &card_id));
    if let Err(e) = spawned {
        log::info!("proposals: could not start the pass after a decision: {e}");
    }
}

/// The event the Library, the Inbox and the Ship step listen for.
pub const PROPOSAL_CHANGED_EVENT: &str = "improvement-proposal://changed";

/// Everything the pass needs off the card and the registry, read before the
/// CLI is started so the friction rule can say "nothing runs" without one.
fn run_pass(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
) -> Result<Option<ProposalTarget>, String> {
    use tauri::Manager;

    let workspace_dir = app
        .state::<crate::project_config::ProjectConfigStore>()
        .workspace_dir(workspace_id);
    let kanban = app.state::<crate::kanban::KanbanStore>();
    let card = kanban.get_card(workspace_id, card_id)?;
    let builder = card
        .builder
        .as_ref()
        .ok_or_else(|| "the card has no Builder session".to_string())?;
    // Findings filter: the member's dismissals are human corrections of the
    // Challenger, read off the card's ledger.
    let ledger = app
        .state::<crate::reviewer::ReviewerRegistry>()
        .ledger(workspace_id, card_id);
    let dismissed = ledger.as_ref().map(dismissal_lines).unwrap_or_default();
    let friction = met_friction(&FrictionInput {
        findings_dismissed: dismissed.len() as u32,
        changes_requested_rounds: builder.changes_requested_count,
        verify_failed: card
            .verify_history
            .iter()
            .any(|entry| entry.status == crate::kanban::VerifyStatus::Failed),
        user_corrections: builder.user_corrections,
        already_proposed: load(&workspace_dir).proposed_cards.iter().any(|id| id == card_id),
    })
    .ok_or_else(|| "the card met no friction".to_string())?;
    // GH #104 walk (A2): only once the card is settled. Not claimed, so the
    // decision that settles it runs the pass (`after_human_decision`), or the
    // approving review does.
    card_settled(&card).map_err(|why| format!("not settled yet: {why}"))?;

    let workspaces = app.state::<crate::workspace::WorkspaceStore>();
    let cwd = workspaces
        .snapshot()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .map(|workspace| PathBuf::from(workspace.cwd))
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;

    // The pass reads the **checkout's** skills and instructions, because that
    // is what a publish sends (`LibraryChange::skill_files` reads the checkout
    // too) and what `git apply --check` is answered against: one source of
    // truth for the quoted text, the apply check, the content id and the bytes
    // `Approve` publishes.
    let library = library_files(&cwd);
    if library.quoted.is_empty() {
        return Err(
            "this repository carries no skills and no agent instructions short enough to quote"
                .into(),
        );
    }

    // The Challenger's vendor, exactly as a review picks it: the other one,
    // falling back to the Builder's own when that is not eligible (the
    // review's `degraded` path). A pass Ply cannot run at all is dropped.
    let (provider, capability) = challenger_capability(app, &builder.vendor)?;
    let level = capability
        .level
        .ok_or_else(|| "the Reviewer's capability has no level".to_string())?;
    let executable = capability
        .executable_path
        .clone()
        .ok_or_else(|| "the Reviewer's capability has no executable".to_string())?;
    let model = crate::settings::model_for_card(
        app,
        workspace_id,
        card.models.as_ref(),
        match provider {
            ply_collab::Provider::Codex => "codex",
            _ => "claude",
        },
        crate::settings::AgentRole::Challenger,
    );

    // Kept for the check below: the pass may only propose where it was shown.
    let library_paths: Vec<String> =
        library.quoted.iter().map(|file| file.path.clone()).collect();
    let prompt = proposal_prompt(&PromptInput {
        card_ref: &card_ref(&card),
        brief: &crate::review_context::brief_of(&card),
        verdicts: verdict_blocks(app, workspace_id, card_id, &builder.snapshots),
        verify_failures: verify_failures(&card),
        library,
        friction: Some(friction),
        corrections: builder.correction_texts.clone(),
        corrections_typed: builder.user_corrections,
        decisions: decision_lines(builder).into_iter().chain(dismissed).collect(),
    });

    // The CLI's own cwd is a throwaway detached worktree at the checkout's
    // HEAD, exactly as a review's is: the harness is advisory, so a write
    // escape must land somewhere Ply owns and removes.
    let head = crate::pinned_read::git_capture(&cwd, &["rev-parse", "HEAD"])?
        .trim()
        .to_string();
    let root = crate::claude_session::session_worktrees(
        &app
            .path()
            .app_config_dir()
            .map_err(|e| format!("resolve Plyloft config directory: {e}"))?,
        "proposals",
    );
    let isolated = root.join(uuid::Uuid::new_v4().to_string());
    // A plain tree for Claude, which then inherits the session root's trust.
    let worktree = if provider == ply_collab::Provider::Claude {
        crate::pinned_read::DetachedReadWorktree::create_plain(&cwd, isolated, root, &head)?
    } else {
        crate::pinned_read::DetachedReadWorktree::create(&cwd, isolated, root, &head)?
    };
    // GH #216 review 3: the pass follows the integration branch tip's skills,
    // as a review does — not whatever the checkout's HEAD carries.
    let target_branch = app
        .state::<crate::project_config::ProjectConfigStore>()
        .get(workspace_id)
        .map(|config| config.target_branch);
    // CL-10: local-only, only the card's recorded fork commit; none recorded,
    // no repository skills.
    let (source, _) = crate::reviewer::branch_skill_source(
        app,
        workspace_id,
        &cwd,
        target_branch.as_deref().unwrap_or(""),
        crate::reviewer::card_skill_base(&card),
    );
    crate::pinned_read::pin_skills_to(worktree.path(), &source, None)?;

    // GH #104 review 1 (MINOR): the card is claimed **before** the pass starts,
    // not after it answers. `Review again` during those minutes would otherwise
    // reach `challenger_loop` again, find no record, and run a second pass.
    if !claim_card(&workspace_dir, card_id)? {
        return Err("another pass has already claimed this card".into());
    }
    let pty = app.state::<crate::pty::PtyRegistry>();
    let run = crate::reviewer::run_read_only_pass(
        app,
        &pty,
        provider,
        level,
        &executable,
        workspace_id,
        card_id,
        worktree.path(),
        &prompt,
        &model,
        PASS_TIMEOUT_SECS,
        &format!("Suggested skill change: {}", card.title),
    );
    // A provider failure is dropped in silence (the card): no retry loop, no
    // toast, nothing on the card. `run_pass`'s own wording explains it in the
    // log and that is the whole of it.
    let failure = run.failure();
    // The one exception to the silence: Claude stopped at its trust question,
    // which only the member can answer. The card shows the trust step where
    // its proposal would appear; any other outcome clears that.
    let claude = provider == ply_collab::Provider::Claude;
    let trust_stopped = claude && failure.as_deref().is_some_and(stopped_at_trust_question);
    note_trust_stop(&workspace_dir, card_id, claude, trust_stopped);
    if trust_stopped {
        app_emit_changed(app, workspace_id);
    }
    if let Some(failure) = failure {
        // A pass that never started is not a pass the card has had: give the
        // claim back so a later Build done can try once. Nor is one Claude
        // stopped at its trust question before any turn. Everything else — a
        // timeout, another refusal, an empty answer — was a real attempt and
        // keeps it.
        if trust_stopped
            || run.error.as_deref().is_some_and(|e| e.starts_with("could not start"))
        {
            release_card(&workspace_dir, card_id);
        }
        return Err(failure);
    }
    let artifact = run
        .artifact
        .as_deref()
        .ok_or_else(|| "the pass produced no answer".to_string())?;

    // The card is already claimed, so `NONE` and a discard have nothing left to
    // write. GH #104 review 1 (MAJOR): the first version wrote a `ProposalFile`
    // it had read up to five minutes earlier, which resurrected a `Dismiss` made
    // while the pass ran and clobbered a newer card's proposal.
    let proposal = match parse_answer(artifact) {
        Answer::None => return Ok(None),
        Answer::Discarded(why) => return Err(why),
        Answer::Proposal(proposal) => proposal,
    };

    let (target_content_id, target_blob) = match &proposal.diff {
        Some(diff) => {
            let path = proposal.target.path();
            // GH #104 review 2 (N1): the target must be a file the prompt quoted
            // **whole**. That one rule closes three doors at once — a file too
            // long to quote (it is named as off limits), a file the prompt never
            // showed, and the other CLI's copy of a skill quoted at its Claude
            // root, whose change would have left the two drifting.
            if !library_paths.iter().any(|quoted| *quoted == path) {
                return Err(format!(
                    "the target {path:?} is not one of the files the prompt quoted"
                ));
            }
            let git = crate::doctor::require("git")?;
            applies_cleanly_with(&git, &cwd, diff)?;
            (
                Some(target_content_id(&cwd, &path).ok_or_else(|| format!("{path} is not a file"))?),
                target_blob_with(&git, &cwd, &path),
            )
        }
        None => (None, None),
    };

    let target = proposal.target.clone();
    let stored = StoredProposal {
        target: proposal.target,
        card_id: card_id.to_string(),
        card_ref: card_ref(&card),
        reason: proposal.reason,
        words: proposal.words,
        diff: proposal.diff,
        target_content_id,
        target_blob,
        created_at: now_millis(),
        source: proposal.source,
    };
    // Read again under the lock, and change only the one field this pass owns.
    with_file(&workspace_dir, |file| {
        file.proposal = Some(stored);
        remember_card(file, card_id);
    })?;
    Ok(Some(target))
}

/// A pass's failure is Claude's trust question (the refusal, wrapped).
pub fn stopped_at_trust_question(failure: &str) -> bool {
    failure.contains(crate::claude_session::FOLDER_TRUST_REFUSAL)
}

/// Pure: the trust-stopped card after a pass of `card_id` (`claude`: by
/// Claude; `stopped`: at the trust question). A stop records that card. A
/// Claude pass that got past the question clears any card (the folder is
/// trusted now); any other pass of the recorded card clears it too (it has
/// had its pass). Another provider's pass of another card changes nothing.
pub fn trust_stop_after(
    recorded: Option<&str>,
    card_id: &str,
    claude: bool,
    stopped: bool,
) -> Option<String> {
    if stopped {
        return Some(card_id.to_string());
    }
    if claude || recorded == Some(card_id) {
        return None;
    }
    recorded.map(str::to_string)
}

/// Record (or clear) the trust stop after a pass that ran
/// ([`trust_stop_after`]). Written only when it changes, so the usual pass
/// leaves the file as it was.
pub fn note_trust_stop(workspace_dir: &Path, card_id: &str, claude: bool, stopped: bool) {
    let before = load(workspace_dir).trust_stopped_card;
    if trust_stop_after(before.as_deref(), card_id, claude, stopped) == before {
        return;
    }
    if let Err(e) = with_file(workspace_dir, |file| {
        file.trust_stopped_card =
            trust_stop_after(file.trust_stopped_card.as_deref(), card_id, claude, stopped);
    }) {
        log::warn!("proposals: could not note the trust question for {card_id}: {e}");
    }
}

fn app_emit_changed(app: &tauri::AppHandle, workspace_id: &str) {
    use tauri::Emitter;
    let _ = app.emit(PROPOSAL_CHANGED_EVENT, workspace_id);
}

/// The card whose last pass stopped at Claude's trust question, if any.
pub fn trust_stopped_card(workspace_dir: &Path) -> Option<String> {
    load(workspace_dir).trust_stopped_card
}

/// One writer at a time per workspace's proposal file.
///
/// GH #104 review 2 (R7): `claim_card` is a read-modify-write, and two
/// Challenger threads — two cards of the same repository finishing their last
/// review at the same moment — could both read "not claimed" and both start a
/// pass. Keyed by the workspace's own directory, which is what the file belongs
/// to, and held only across the load and the save.
fn file_lock(workspace_dir: &Path) -> std::sync::Arc<std::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<
        std::sync::Mutex<
            std::collections::HashMap<PathBuf, std::sync::Arc<std::sync::Mutex<()>>>,
        >,
    > = std::sync::OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(workspace_dir.to_path_buf())
        .or_default()
        .clone()
}

/// Read the file, change it, write it — with nobody else in between.
pub fn with_file<T>(
    workspace_dir: &Path,
    change: impl FnOnce(&mut ProposalFile) -> T,
) -> Result<T, String> {
    let lock = file_lock(workspace_dir);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = load(workspace_dir);
    let out = change(&mut file);
    save(workspace_dir, &file)?;
    Ok(out)
}

/// Record that this card has had its pass. Answers `false` when another thread
/// had already claimed it, so exactly one pass ever runs for one card.
fn claim_card(workspace_dir: &Path, card_id: &str) -> Result<bool, String> {
    with_file(workspace_dir, |file| {
        if file.proposed_cards.iter().any(|id| id == card_id) {
            return false;
        }
        remember_card(file, card_id);
        true
    })
}

/// Give the claim back: the pass never started, so the card has not had one.
fn release_card(workspace_dir: &Path, card_id: &str) {
    if let Err(e) = with_file(workspace_dir, |file| {
        file.proposed_cards.retain(|id| id != card_id);
    }) {
        log::warn!("proposals: could not give {card_id}'s claim back: {e}");
    }
}

/// The provider the pass runs on, with its capability proof: the Challenger's
/// vendor first (`builder::challenger_for` — the one that did **not** build),
/// then the Builder's own, which is the review's `degraded` fallback. `Err`
/// when neither is eligible, and then nothing runs, in silence.
fn challenger_capability(
    app: &tauri::AppHandle,
    builder_vendor: &str,
) -> Result<(ply_collab::Provider, crate::review_capabilities::ReviewerCapabilityView), String> {
    use tauri::Manager;
    let env = crate::shell_env::get();
    let registry = app.state::<crate::review_capabilities::ReviewerCapabilityRegistry>();
    let challenger = crate::builder::challenger_for(builder_vendor);
    let mut last = String::new();
    for vendor in [challenger, builder_vendor] {
        let provider = if vendor == "codex" {
            ply_collab::Provider::Codex
        } else {
            ply_collab::Provider::Claude
        };
        match registry.require_current(provider, &env) {
            Ok(capability) => return Ok((provider, capability)),
            Err(why) => last = why,
        }
    }
    Err(last)
}

fn remember_card(file: &mut ProposalFile, card_id: &str) {
    file.proposed_cards.retain(|id| id != card_id);
    file.proposed_cards.push(card_id.to_string());
    if file.proposed_cards.len() > PROPOSED_CARDS_CAP {
        let drop = file.proposed_cards.len() - PROPOSED_CARDS_CAP;
        file.proposed_cards.drain(0..drop);
    }
}

/// `#88`, else the card's title in quotes — how the Inbox and the reason name
/// the card it came from.
pub fn card_ref(card: &crate::kanban::KanbanCard) -> String {
    match card.gh_issue_number {
        Some(number) => format!("#{number}"),
        None => format!("“{}”", card.title),
    }
}

/// Each completed review round, with its verdict and its findings — the
/// card's own record, newest first.
///
/// GH #104 walk (C2): each is numbered as a round, oldest = 1, with the
/// snapshot it read, so the answer's `SOURCE:` can name it.
fn verdict_blocks(
    app: &tauri::AppHandle,
    workspace_id: &str,
    card_id: &str,
    snapshots: &[crate::kanban::BuildSnapshot],
) -> Vec<String> {
    use tauri::Manager;
    let registry = app.state::<crate::reviewer::ReviewerRegistry>();
    let records: Vec<_> = registry
        .list_for_card(workspace_id, card_id)
        .into_iter()
        .filter(|record| record.verdict.is_some())
        .collect();
    let total = records.len();
    records
        .into_iter()
        .enumerate()
        .map(|(i, record)| {
            let snapshot = snapshots
                .iter()
                .find(|s| s.sha == record.reviewed_revision)
                .map(|s| format!(", snapshot {}", s.n))
                .unwrap_or_default();
            let mut out = format!(
                "### Review round {}: {} ({}{snapshot})\n",
                total - i,
                record.verdict.as_deref().unwrap_or("no verdict"),
                kind_word(record.kind),
            );
            for finding in &record.findings {
                out.push_str(&format!(
                    "- [{}] {}{}\n  {}\n",
                    finding.severity.as_deref().unwrap_or("P?"),
                    finding.title,
                    finding
                        .location
                        .as_deref()
                        .map(|at| format!(" ({at})"))
                        .unwrap_or_default(),
                    cap(&finding.body, 800),
                ));
            }
            out
        })
        .collect()
}

/// Which round a verdict came from, in the prompt's words.
fn kind_word(kind: crate::review_passes::ReviewKind) -> &'static str {
    match kind {
        crate::review_passes::ReviewKind::Sweep => "the first sweep",
        crate::review_passes::ReviewKind::Review => "an independent review",
        crate::review_passes::ReviewKind::FollowUp => "a follow-up",
    }
}

/// The Verify failures' summaries, oldest first.
fn verify_failures(card: &crate::kanban::KanbanCard) -> Vec<String> {
    card.verify_history
        .iter()
        .filter(|entry| entry.status == crate::kanban::VerifyStatus::Failed)
        .map(|entry| {
            let mut out = entry
                .summary
                .clone()
                .unwrap_or_else(|| "Verify failed (no summary recorded).".into());
            for step in entry.steps.iter().filter(|step| !step.passed) {
                out.push_str(&format!(
                    "\n  - `{}` failed{}",
                    step.kind,
                    step.reason
                        .as_deref()
                        .map(|reason| format!(": {}", cap(reason, 400)))
                        .unwrap_or_default(),
                ));
            }
            out
        })
        .collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

// ── Approve and publish ──────────────────────────────────────────────

/// The change `Approve and publish` sends, built for the shared channel's
/// **existing** paths and nothing new:
///
/// - a skill: the same `LibraryChange::new(ItemKind::Skill, …)` that
///   `project_skill_publish` — the `Update on <branch>` action — builds, with
///   the diffed file's patched bytes in place of the checkout's;
/// - an instruction file: `LibraryChange::instructions`, GH #101's
///   never-override path, with `bases` from the mirror's manifest, so a file
///   that moved on the branch opens a pull request or is reported `blocked`
///   and is never written over.
///
/// `mirror` and `cwd` are both read, never written. Nothing here publishes:
/// `workspace_definition::app_library_change` queues and drains, as every
/// other caller does. `git` is the resolved git program.
///
/// **The bytes published come from the mirror, never from the working tree.**
/// GH #104 review 1 (BLOCKER and MAJOR): the first version patched the
/// checkout's copy while the base came from the mirror's manifest, so a stale
/// checkout published old bytes with a base that said "not moved" — a direct
/// commit that deleted a teammate's rule, straight through GH #101's
/// never-override rule. And a skill published the whole checkout directory, so
/// unrelated uncommitted edits travelled with the four approved lines and
/// `prepare` deleted branch files the checkout happened to lack.
///
/// So: the diff is applied to the **mirror's** copy — the integration branch's
/// own bytes — and refused when it does not apply there; a skill's other files
/// come from the mirror too, with only the target patched; and the base recorded
/// is the blob the **Challenger read**, so a checkout that was behind the branch
/// sends the change into a pull request rather than over anybody.
///
/// SP-5 walk: [`approve_change_full`] is this with what it decided about the
/// skill's other CLI's copy; every caller outside the tests uses that.
#[cfg(test)]
pub fn approve_change_with(
    git: &str,
    proposal: &StoredProposal,
    cwd: &Path,
    mirror: &Path,
) -> Result<crate::shared_library_sync::LibraryChange, String> {
    approve_change_full(git, proposal, cwd, mirror).map(|approval| approval.change)
}

/// What [`approve_change_full`] built: the change, and what it decided about
/// the skill's other CLI's copy — decided once, and said from that decision.
pub struct Approval {
    pub change: crate::shared_library_sync::LibraryChange,
    pub copies: Copies,
}

/// SP-5 walk: a skill's copy under the other CLI's root, as the change found it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Copies {
    /// An instruction file, or no other copy (or one behind a symlink).
    One,
    /// The other root held the same files, so it takes the change too.
    Same { root: &'static str, other: &'static str },
    /// The other root already held something else, so it is left as it is.
    Differs { root: &'static str, other: &'static str },
}

/// When the sentence about the other copy is said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tense {
    /// On the proposal, before Approve is pressed.
    Before,
    /// The change is queued on the shared channel.
    Queued,
    /// The change was committed, published or sent to a pull request.
    Done,
}

/// The sentence about the skill's other copy — both change, or only one — so
/// two copies never drift apart in silence. `None` for one copy.
pub fn copies_note(proposal: &StoredProposal, copies: Copies, tense: Tense) -> Option<String> {
    let ProposalTarget::Skill { name, .. } = &proposal.target else {
        return None;
    };
    let cli = |root: &str| if root == CLAUDE_SKILLS_ROOT { "Claude" } else { "Codex" };
    match copies {
        Copies::One => None,
        Copies::Same { other, .. } => {
            let theirs = cli(other);
            Some(match tense {
                Tense::Before => format!("{theirs}'s copy ({other}{name}) is the same file, so it changes too."),
                Tense::Queued => {
                    format!("{theirs}'s copy ({other}{name}) is the same file, so it will change too.")
                }
                Tense::Done => format!("{theirs}'s copy ({other}{name}) was the same, so it changed too."),
            })
        }
        Copies::Differs { root, other } => {
            let (mine, theirs) = (cli(root), cli(other));
            Some(match tense {
                Tense::Before => format!(
                    "Only {mine}'s copy of {name} ({root}{name}) changes. {theirs}'s copy ({other}{name}) \
is already different, so it is left as it is — compare the two and align them."
                ),
                Tense::Queued => format!(
                    "Only {mine}'s copy of {name} ({root}{name}) will change. {theirs}'s copy ({other}{name}) \
is already different, so it is left as it is — compare the two and align them."
                ),
                Tense::Done => format!(
                    "Only {mine}'s copy of {name} ({root}{name}) changed. {theirs}'s copy ({other}{name}) \
was already different, so it was left as it is — compare the two and align them."
                ),
            })
        }
    }
}

/// The change `Approve` sends (the rules above), with what it decided about
/// the skill's other CLI's copy.
pub fn approve_change_full(
    git: &str,
    proposal: &StoredProposal,
    cwd: &Path,
    mirror: &Path,
) -> Result<Approval, String> {
    let Some(diff) = proposal.diff.as_deref() else {
        return Err(
            "This proposal is words only: the file it is about does not live in this repository."
                .into(),
        );
    };
    if matches!(proposal.target, ProposalTarget::Elsewhere { .. }) {
        return Err(
            "This proposal is words only: the file it is about does not live in this repository."
                .into(),
        );
    }
    let path = proposal.target.path();
    // The proposal is only ever drawn while it is not stale, so this is a race,
    // not a state: the member pressed Approve as the file changed under them.
    if target_content_id(cwd, &path).as_deref() != proposal.target_content_id.as_deref() {
        return Err(format!(
            "{path} changed since the Reviewer read it. Nothing was published."
        ));
    }

    // Where the published bytes come from: the branch's copy when it has one, and
    // the checkout's only when the branch has never carried this file at all — a
    // first publish, which overrides nothing because there is nothing there.
    let from_branch = mirror.join(&path).is_file();
    let source = if from_branch { mirror } else { cwd };
    let patched = patched_bytes_with(git, source, &path, diff).map_err(|why| {
        if from_branch {
            format!(
                "The change no longer fits {}'s copy of {path}: {why} Nothing was published — \
somebody has changed it since the Reviewer read it.",
                "the integration branch"
            )
        } else {
            why
        }
    })?;

    match &proposal.target {
        ProposalTarget::Elsewhere { .. } => unreachable!("refused above"),
        ProposalTarget::Instructions { file } => {
            let text = String::from_utf8(patched)
                .map_err(|_| format!("{file} is not text after the change"))?;
            // GH #101's key: the blob the edit started from. For a proposal that
            // is the blob the Challenger read — not the mirror's current one, and
            // not the manifest's — so a stale checkout can only ever reach a pull
            // request. The other instruction file is not written and so is not
            // compared (`moved_instruction_files` filters by written path).
            let mut bases = BTreeMap::new();
            bases.insert(file.clone(), proposal.target_blob.clone());
            let change = crate::shared_library_sync::LibraryChange::instructions(
                &format!("the Reviewer's change to {file}"),
                vec![crate::shared_library_sync::LibraryFile::new(
                    file.clone(),
                    text.as_bytes(),
                    false,
                )],
                bases,
            )?;
            Ok(Approval { change, copies: Copies::One })
        }
        ProposalTarget::Skill { name, path } => {
            // The root the target really lives under (GH #104 review 2, N1): a
            // Codex-only skill is changed and published as `.agents/skills/…`,
            // because #105 made the channel carry that root too.
            let root = skill_root_of(path)
                .ok_or_else(|| format!("{path} is under no skill root"))?;
            let claimed = format!("{}/{name}", root.trim_end_matches('/'));
            // The skill as the **branch** holds it, with the one file the
            // proposal changes. `prepare` removes branch files a change does not
            // carry **within the paths it claims**, so taking the other files
            // from the checkout would delete whatever the checkout happens to
            // lack — and claiming one root leaves the other root's copy alone.
            let mut files = skill_copy(git, cwd, mirror, from_branch, root, name)?;
            // SP-5 walk: the same skill in the other CLI's root, byte for byte
            // the same as this one where the change is made from. Codex reads
            // that copy, so it takes the change too, in the same commit — or the
            // repository is left with two copies that disagree. A copy that
            // already differed is left as it is ([`copies_note`] says so).
            let copies = other_copy(mirror, from_branch, root, name)?;
            let twin = match copies {
                Copies::Same { other, .. } => Some(other),
                Copies::One | Copies::Differs { .. } => None,
            };
            let entry = files
                .iter_mut()
                .find(|file| file.path == *path)
                .ok_or_else(|| {
                    format!(
                        "{path} is not one of {name}'s files on the integration branch any more. \
Nothing was published."
                    )
                })?;
            *entry = crate::shared_library_sync::LibraryFile::new(
                path.clone(),
                &patched,
                entry.executable,
            );
            let mut paths = vec![claimed];
            if let Some(other_root) = twin {
                let copies: Vec<_> = files
                    .iter()
                    .map(|file| {
                        crate::shared_library_sync::LibraryFile {
                            path: format!("{other_root}{}", &file.path[root.len()..]),
                            ..file.clone()
                        }
                    })
                    .collect();
                files.extend(copies);
                paths.push(format!("{}/{name}", other_root.trim_end_matches('/')));
            }
            let change = crate::shared_library_sync::LibraryChange {
                // This root — and the other CLI's copy only when it was the same
                // file; otherwise it is left exactly as it is (GH #105).
                paths,
                ..crate::shared_library_sync::LibraryChange::new(
                    crate::shared_library_sync::ItemKind::Skill,
                    name,
                    name,
                    Some(files),
                )
            };
            Ok(Approval { change, copies })
        }
    }
}

/// A skill's files under `root`, as the change is made from them: the
/// branch's (mirror) copy, or — for a skill the branch has never carried — the
/// checkout's, which must then be clean.
fn skill_copy(
    git: &str,
    cwd: &Path,
    mirror: &Path,
    from_branch: bool,
    root: &str,
    name: &str,
) -> Result<Vec<crate::shared_library_sync::LibraryFile>, String> {
    if from_branch {
        return mirror_skill_files(mirror, root, name);
    }
    // A skill the branch has never carried: this is its first publish, and the
    // checkout is the only copy there is. Its working tree must be clean, or
    // bytes nobody reviewed travel.
    require_clean_skill(git, cwd, root, name)?;
    // Windows parity: as git records them (line endings, modes).
    crate::shared_library_sync::as_git_records(
        &crate::shared_config::Plumbing { cwd: cwd.to_path_buf() },
        checkout_skill_files(cwd, root, name)?,
        None,
    )
}

/// SP-5 walk: what the other CLI's root holds of skill `name`, compared with
/// `root`'s copy where the change is made from — before the change.
///
/// Only ever read from the **mirror** (the branch's copies), the same place the
/// change's own bytes come from: a first publish (`from_branch` false) takes
/// its own root from the checkout, but never the other root's checkout copy,
/// which may be stale against the branch — the other root there is `Differs`
/// when the branch has it (said, never written) and `One` when it doesn't.
/// A root reached through a symlink, at any level, counts as absent.
fn other_copy(
    mirror: &Path,
    from_branch: bool,
    root: &'static str,
    name: &str,
) -> Result<Copies, String> {
    let other = if root == CLAUDE_SKILLS_ROOT { CODEX_SKILLS_ROOT } else { CLAUDE_SKILLS_ROOT };
    if through_symlink(mirror, root, name) || through_symlink(mirror, other, name) {
        return Ok(Copies::One);
    }
    if !mirror.join(other).join(name).is_dir() {
        return Ok(Copies::One);
    }
    if !from_branch {
        return Ok(Copies::Differs { root, other });
    }
    let shape = |files: Vec<crate::shared_library_sync::LibraryFile>, at: &str| {
        files
            .into_iter()
            .map(|file| {
                let rel = file.path[at.len()..].to_string();
                (rel, (file.bytes, file.executable))
            })
            .collect::<BTreeMap<_, _>>()
    };
    let mine = shape(mirror_skill_files(mirror, root, name)?, root);
    // A copy that can't be read as one differs: it is never written over.
    let theirs = match mirror_skill_files(mirror, other, name) {
        Ok(files) => shape(files, other),
        Err(_) => return Ok(Copies::Differs { root, other }),
    };
    Ok(if mine == theirs { Copies::Same { root, other } } else { Copies::Differs { root, other } })
}

/// Any of `<base>/<first dir of root>`, `<base>/<root>` and
/// `<base>/<root><name>` is a symlink.
fn through_symlink(base: &Path, root: &str, name: &str) -> bool {
    let root = root.trim_end_matches('/');
    let first = root.split('/').next().unwrap_or(root);
    [base.join(first), base.join(root), base.join(root).join(name)]
        .iter()
        .any(|path| std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()))
}

/// SP-5 walk: the sentence for the proposal's block, before Approve: what the
/// approval would do to the skill's other copy, from `mirror` (the branch's
/// copies). `None` when it says nothing, or the change can't be built here.
pub fn copies_hint(git: &str, proposal: &StoredProposal, cwd: &Path, mirror: &Path) -> Option<String> {
    let approval = approve_change_full(git, proposal, cwd, mirror).ok()?;
    copies_note(proposal, approval.copies, Tense::Before)
}

/// [`copies_hint`] against `rev` (a workspace with no shared definition: its
/// local or its last fetched integration branch).
pub fn copies_hint_at(
    git_bin: &str,
    git: &crate::shared_config::Plumbing,
    rev: &str,
    proposal: &StoredProposal,
    cwd: &Path,
) -> Option<String> {
    if !matches!(proposal.target, ProposalTarget::Skill { .. }) {
        return None;
    }
    let scratch = lay_out(git, rev, proposal).ok()?;
    copies_hint(git_bin, proposal, cwd, scratch.path())
}

/// Which skill root a repository-relative path is under, with its trailing
/// slash, or `None` for an instruction file.
pub fn skill_root_of(path: &str) -> Option<&'static str> {
    [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT]
        .into_iter()
        .find(|root| path.starts_with(root))
}

/// The skill's files as the mirror (the integration branch's tip) holds them,
/// under the one root the proposal is about.
///
/// The mirror is Ply's own build and already refuses a symlink on the branch
/// (`build_mirror`, `manifest.skipped`); `read_tree` refuses one again here.
fn mirror_skill_files(
    mirror: &Path,
    root: &str,
    name: &str,
) -> Result<Vec<crate::shared_library_sync::LibraryFile>, String> {
    let dir = mirror.join(root).join(name);
    skill_files_under(&dir, root, name).map_err(|why| {
        format!("The integration branch's copy of {name}: {why} Nothing was published.")
    })
}

/// The same, out of the checkout — only for a skill the branch has never
/// carried, and only from a clean directory.
fn checkout_skill_files(
    cwd: &Path,
    root: &str,
    name: &str,
) -> Result<Vec<crate::shared_library_sync::LibraryFile>, String> {
    // Round 3 (S3): the gate of every path a skill leaves for GitHub — a
    // private name stops it, a file git ignores is left out.
    let dir = cwd.join(root).join(name);
    let left = crate::project_skills::refuse_unpublishable(name, &dir, true, "nothing was published")?;
    let lead = format!("{root}{name}/");
    Ok(skill_files_under(&dir, root, name)?
        .into_iter()
        .filter(|file| file.path.strip_prefix(&lead).is_none_or(|rel| !left.contains(rel)))
        .collect())
}

fn skill_files_under(
    dir: &Path,
    root: &str,
    name: &str,
) -> Result<Vec<crate::shared_library_sync::LibraryFile>, String> {
    crate::shared_library_sync::check_name(name)?;
    let tree = crate::project_skills::read_tree(dir)?;
    if tree.is_empty() {
        return Err(format!("{} has no files.", dir.display()));
    }
    Ok(tree
        .into_iter()
        .filter(|file| !crate::shared_library_sync::is_os_junk(&file.path))
        .map(|file| {
            crate::shared_library_sync::LibraryFile::new(
                format!("{}{name}/{}", root, file.path),
                &file.bytes,
                file.executable,
            )
        })
        .collect())
}

/// Refuse a first publish out of a dirty skill directory (GH #104 review 1,
/// MAJOR): uncommitted edits nobody reviewed must not ride out behind four
/// approved lines. Read-only — `git status --porcelain` on one path.
///
/// Fails closed: a git that gives no answer (a config it can't read, a
/// checkout it won't trust) proves nothing clean, and this gate is the only
/// thing between the checkout's working tree and the branch.
fn require_clean_skill(git: &str, cwd: &Path, root: &str, name: &str) -> Result<(), String> {
    let rel = format!("{root}{name}");
    let output = crate::platform::new_command(git)
        .args(["status", "--porcelain", "--"])
        .arg(&rel)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn git status: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Plyloft couldn't ask git whether {rel} has uncommitted changes, and the integration \
branch has no copy of {name} to publish from. Nothing was published. ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let dirty: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    if dirty.is_empty() {
        return Ok(());
    }
    Err(format!(
        "{rel} has uncommitted changes, and the integration branch has no copy of {name} to \
publish from. Commit or discard them first, so only what you have read travels. Nothing was \
published. ({})",
        dirty.join(", ")
    ))
}

// ── Approve without a shared definition (SP-5) ───────────────────────

/// What `Approve` says when it fails because git cannot name the author.
pub const IDENTITY_MISSING: &str =
    "Git doesn't know who you are yet, so Plyloft can't make the commit. Set your name and email \
in Setup → Git, then approve again. Nothing was committed.";

/// What an `Approve` of an unshared workspace did, in the toast's words.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    pub title: String,
    pub body: String,
}

/// SP-5: `Approve` for a workspace whose repository carries **no** shared
/// definition — the solo user's case (ADR 0003, 2026-10-01 amendment).
///
/// The change is the one [`approve_change_full`] builds — the bytes from the
/// integration branch's tip, the diff applied there, the base the blob the
/// Challenger read — with the tip's files laid out in a scratch directory in
/// place of the shared mirror. Then it is a commit on `branch`, made with
/// plumbing and a scratch index:
///
/// - **with an origin**: [`crate::shared_library_sync::publish_change`], run
///   here and now — fetch, never over a file that moved (a pull request
///   instead), push — and then a best-effort fast-forward of the local branch;
/// - **without one**: [`crate::shared_library_sync::commit_change_locally`],
///   which refuses rather than overrides.
///
/// The checkout is read for the staleness check and, for a skill the branch
/// has never carried, its clean copy; it is written only where the local
/// branch is checked out there, and only at the claimed paths. The caller
/// holds the workspace lock.
pub fn approve_unshared(
    git_bin: &str,
    gh: Option<&crate::shared_config::Gh>,
    proposal: &StoredProposal,
    cwd: &Path,
    branch: &str,
    now_secs: i64,
) -> Result<Approved, String> {
    approve_unshared_hooked(git_bin, gh, proposal, cwd, branch, now_secs, &mut || {})
}

/// [`approve_unshared`] with the local commit's race seam.
pub(crate) fn approve_unshared_hooked(
    git_bin: &str,
    gh: Option<&crate::shared_config::Gh>,
    proposal: &StoredProposal,
    cwd: &Path,
    branch: &str,
    now_secs: i64,
    before_ref: &mut dyn FnMut(),
) -> Result<Approved, String> {
    use crate::shared_library_sync::ChangeOutcome;
    let git = crate::shared_config::Plumbing { cwd: cwd.to_path_buf() };
    // N14 review (P3-7): the identity is resolved once, so the check below
    // and the commit it allows name the same account.
    let _identity = crate::commit_identity::hold(cwd);
    if !git.has_identity() {
        return Err(IDENTITY_MISSING.to_string());
    }
    if !git.has_origin() {
        let tip = git
            .rev_parse_commit(&format!("refs/heads/{branch}"))
            .ok_or_else(|| format!("This repository has no branch {branch} to commit to."))?;
        // Never over a newer change: the branch's copy must still be the one the
        // Challenger read. There is no pull request to send it to instead. The
        // same words the state shows in place of the button, re-asked here
        // because the branch may have moved since it was drawn.
        if let Some(why) = local_commit_blocker(&git, proposal, branch) {
            return Err(format!("{why} Nothing was committed."));
        }
        let (change, note) = change_at(git_bin, &git, &tip, proposal, cwd)
            .map_err(|why| why.replace("Nothing was published.", "Nothing was committed."))?;
        let commit = crate::shared_library_sync::commit_change_locally(
            &git, branch, &change, now_secs, before_ref,
        )?;
        let body = match commit {
            Some(sha) => format!(
                "Commit {} is on {branch} in this repository. It has no remote, so nothing was pushed.",
                &sha[..sha.len().min(8)]
            ),
            None => format!("{branch} already had exactly this change."),
        };
        let body = with_note(body, note.as_deref());
        return Ok(Approved { title: format!("Committed the change to {branch}"), body });
    }

    // Git's own words go to the log, never into the toast (GH #160).
    let stays = "Nothing was published; the proposal stays here.";
    git.fetch(branch).map_err(|e| {
        log::warn!("proposals: fetching {branch} for an approval failed: {e:?}");
        match e {
            crate::shared_config::FetchFailure::BranchMissing { .. }
            | crate::shared_config::FetchFailure::SignIn(_) => format!("{e} {stays}"),
            crate::shared_config::FetchFailure::Unreachable(_) => {
                format!("Plyloft couldn't reach origin. {stays}")
            }
        }
    })?;
    let tip = git
        .tip(branch)
        .ok_or_else(|| format!("origin has no branch {branch} to publish to. {stays}"))?;
    // A copy the branch never had, or one the checkout differs from, would read
    // as "moved" and open a pull request on a claim that isn't true. Only a real
    // move goes on to `publish_change`'s never-override pull request.
    if let Some(blocked) = branch_copy_blocker(&git, proposal, branch, &tip, true) {
        if !blocked.moved {
            return Err(format!("{} {stays}", blocked.words));
        }
    }
    let (change, note) = change_at(git_bin, &git, &tip, proposal, cwd)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let pull_request_branch = format!(
        "atelier/proposal-{}-{}-{}",
        crate::shared_config::kebab(&change.name),
        now_secs,
        &id[..8]
    );
    match crate::shared_library_sync::publish_change(
        &git,
        gh,
        branch,
        &change,
        &pull_request_branch,
        now_secs,
    ) {
        ChangeOutcome::Published { .. } => {
            // Best effort: the change is on origin either way.
            let local = crate::worktrees::fast_forward_local(cwd, branch);
            let body = if local.fast_forwarded() {
                "Your checkout has it too.".to_string()
            } else {
                format!("Pull {branch} to see it locally.")
            };
            let body = with_note(body, note.as_deref());
            Ok(Approved { title: format!("Published the change to {branch}"), body })
        }
        ChangeOutcome::PullRequest { pull_request, reason, never_override, .. } => {
            // Only the never-override reason is a sentence for a person; a
            // refused push's is git's stderr (GH #160).
            let why = if never_override {
                reason
            } else {
                format!("{branch} refused the push.")
            };
            Ok(Approved {
                title: format!("The change waits in pull request #{}", pull_request.number),
                body: with_note(
                    format!("{why} Merge it on GitHub to bring it in: {}", pull_request.url),
                    note.as_deref(),
                ),
            })
        }
        ChangeOutcome::Unreachable(e) => {
            log::warn!("proposals: publishing to {branch} could not reach origin: {e}");
            Err(format!("Plyloft couldn't reach origin. {stays}"))
        }
        ChangeOutcome::Failed(e) => {
            log::warn!("proposals: publishing the approved change to {branch} failed: {e}");
            let moved = git.tip(branch).and_then(|tip| {
                crate::shared_library_sync::never_override_on(&git, branch, &tip, &change, now_secs)
            });
            Err(match moved {
                Some(moved) if gh.is_none() => format!(
                    "{moved} Plyloft doesn't commit over it, and without the GitHub CLI it can't open a pull request. {stays}"
                ),
                Some(moved) => format!(
                    "{moved} Plyloft doesn't commit over it, and it couldn't open a pull request either. {stays}"
                ),
                None => format!("Plyloft couldn't publish the change to {branch}. {stays}"),
            })
        }
        ChangeOutcome::PullRequestUncertain(e) => {
            log::warn!("proposals: the approved change's pull request is uncertain: {e}");
            Err(format!(
                "A pull request may have been opened; check GitHub before approving again. {stays}"
            ))
        }
    }
}

/// SP-5 review: why a commit to the local `branch` (no remote) cannot carry
/// this proposal, in the words the block shows instead of the button — or
/// `None` when it can. The Challenger read the checkout's copy
/// (`target_blob`); a local commit is made from the branch's, so the two must
/// be the same blob:
///
/// - the branch has no such file: it isn't on `branch` yet;
/// - the Challenger's blob is in the branch's history but not its tip: the
///   branch truly moved since — the one case that sentence is said for;
/// - otherwise the checkout's copy simply isn't the branch's (uncommitted
///   edits, or another branch checked out).
pub fn local_commit_blocker(
    git: &crate::shared_config::Plumbing,
    proposal: &StoredProposal,
    branch: &str,
) -> Option<String> {
    let Some(tip) = git.rev_parse_commit(&format!("refs/heads/{branch}")) else {
        return Some(format!("This repository has no branch {branch} to commit to."));
    };
    branch_copy_blocker(git, proposal, branch, &tip, false).map(|blocked| blocked.words)
}

/// Why the branch's copy at `tip` is not the one the Challenger read.
pub struct BranchCopyBlocked {
    pub words: String,
    /// The branch truly moved since (the Challenger's blob is in its history):
    /// with a remote this is the pull request's case, not a refusal.
    pub moved: bool,
}

/// [`local_commit_blocker`] against any `tip`; `remote` — the tip is
/// `origin/<branch>`, and the words say GitHub's branch.
pub fn branch_copy_blocker(
    git: &crate::shared_config::Plumbing,
    proposal: &StoredProposal,
    branch: &str,
    tip: &str,
    remote: bool,
) -> Option<BranchCopyBlocked> {
    let path = proposal.target.path();
    let now = blob_at(git, tip, &path);
    if now.is_some() && now == proposal.target_blob {
        return None;
    }
    if now.is_none() {
        return Some(BranchCopyBlocked {
            words: if remote {
                format!("{path} isn't on {branch} on GitHub yet. Commit it to {branch} and push, then approve.")
            } else {
                format!("{path} isn't on {branch} yet. Commit it to {branch} first, then approve.")
            },
            moved: false,
        });
    }
    let moved = proposal
        .target_blob
        .as_ref()
        .is_some_and(|read| git.blobs_in_history(tip, &path).contains(read));
    Some(BranchCopyBlocked {
        words: if moved {
            format!("{path} changed on {branch} since the Reviewer read it.")
        } else if remote {
            format!(
                "Your checkout's {path} isn't the {branch} on GitHub (uncommitted or unpushed changes, or another branch is checked out)."
            )
        } else {
            format!(
                "Your checkout's {path} isn't {branch}'s copy (uncommitted changes, or another branch is checked out)."
            )
        },
        moved,
    })
}

/// `body`, then the other-copy sentence when there is one.
fn with_note(body: String, note: Option<&str>) -> String {
    match note {
        Some(note) => format!("{body} {note}"),
        None => body,
    }
}

/// The blob `path` has at `rev`, `None` when absent.
fn blob_at(git: &crate::shared_config::Plumbing, rev: &str, path: &str) -> Option<String> {
    git.ls_tree(rev, path, false)
        .into_iter()
        .find(|entry| entry.path == path && entry.kind == "blob")
        .map(|entry| entry.sha)
}

/// The tree `path` has at `rev`, `None` when absent.
fn tree_at(git: &crate::shared_config::Plumbing, rev: &str, path: &str) -> Option<String> {
    git.ls_tree(rev, path, false)
        .into_iter()
        .find(|entry| entry.path == path && entry.kind == "tree")
        .map(|entry| entry.sha)
}

/// [`approve_change_full`] against `tip`: the files the proposal is about,
/// laid out as the mirror lays them out, in a scratch directory.
///
/// A skill's change also gets its root's base: the tip's tree when the target
/// there is still the blob the Challenger read, so only a move **after** this
/// read reaches a pull request; otherwise the Challenger's own blob id, which
/// no tree id equals, so `prepare` never commits it over the newer copy.
fn change_at(
    git_bin: &str,
    git: &crate::shared_config::Plumbing,
    tip: &str,
    proposal: &StoredProposal,
    cwd: &Path,
) -> Result<(crate::shared_library_sync::LibraryChange, Option<String>), String> {
    let scratch = lay_out(git, tip, proposal)?;
    let approval = approve_change_full(git_bin, proposal, cwd, scratch.path())?;
    let mut change = approval.change;
    let note = copies_note(proposal, approval.copies, Tense::Done);
    if let ProposalTarget::Skill { path, .. } = &proposal.target {
        // Every root the change claims — the other CLI's copy too, when it was
        // the same file — with the same rule.
        let unmoved = blob_at(git, tip, path) == proposal.target_blob;
        for root in change.claimed() {
            let base = if unmoved { tree_at(git, tip, &root) } else { proposal.target_blob.clone() };
            change.bases.insert(root, base);
        }
    }
    Ok((change, note))
}

/// The files the proposal is about at `rev`, laid out as the mirror lays them
/// out, in a scratch directory — a skill under both roots.
fn lay_out(
    git: &crate::shared_config::Plumbing,
    tip: &str,
    proposal: &StoredProposal,
) -> Result<tempfile::TempDir, String> {
    let scratch = tempfile::tempdir().map_err(|e| format!("temporary directory: {e}"))?;
    // SP-5 walk: a skill is laid out under both roots, so its other CLI's copy
    // is there to compare and, when it is the same, to change too.
    let laid_out: Vec<String> = match &proposal.target {
        ProposalTarget::Elsewhere { .. } => Vec::new(),
        ProposalTarget::Instructions { file } => vec![file.clone()],
        ProposalTarget::Skill { name, .. } => [CLAUDE_SKILLS_ROOT, CODEX_SKILLS_ROOT]
            .iter()
            .map(|root| format!("{}/{name}", root.trim_end_matches('/')))
            .collect(),
    };
    for at in &laid_out {
        for entry in git.ls_tree(tip, at, true) {
            // The mirror's own rule: a symlink on the branch is never read.
            if entry.kind != "blob" || entry.mode == "120000" {
                continue;
            }
            let bytes = git
                .read_blob(&entry.sha)
                .ok_or_else(|| format!("Plyloft couldn't read {} on the branch.", entry.path))?;
            crate::shared_library_sync::write_file(
                scratch.path(),
                &entry.path,
                &bytes,
                entry.mode == "100755",
            )?;
        }
    }
    Ok(scratch)
}

/// SP-5: who may approve, and with which words. `shared` — the workspace has
/// a shared definition (and `read_only` — this Mac may not write it);
/// `target_branch` — the project's integration branch; `has_origin` — the
/// repository has a remote.
///
/// Returns `(can_approve, commit_to)`: `commit_to` is the branch an approval
/// commits to on this Mac (`Approve and commit to main`), `None` when it
/// publishes (`Approve and publish`).
pub fn approve_offer(
    shared: bool,
    read_only: bool,
    target_branch: Option<&str>,
    has_origin: bool,
) -> (bool, Option<String>) {
    if shared {
        // The channel publishes, and a read-only collaborator is offered no
        // button the channel would refuse.
        return (!read_only, None);
    }
    // No definition: a commit on the project's integration branch, pushed only
    // when there is a remote to push to.
    match target_branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(branch) => (true, (!has_origin).then(|| branch.to_string())),
        None => (false, None),
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod unshared_tests;
