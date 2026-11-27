//! Agent collaboration Phase 1C — workspace instruction-file convention.
//!
//! Shared provider instructions live in `AGENTS.md`; `CLAUDE.md` imports them
//! with `@AGENTS.md` as its first non-blank line. Inspection is read-only.
//! Repairs are deterministic, fingerprint-gated, and atomically replace only
//! the two fixed files under the configured workspace root.
//!
//! # GH #101 — the Library's Instructions page
//!
//! The same doctor now answers a page instead of a panel
//! (`docs/ux-language/boards/BOARDS.md` §5 "A procedure" and "The flow"):
//!
//! - [`procedure`] turns every state the doctor knows into **one sentence and
//!   at most one step**. The step is the doctor's own first proposal, so the
//!   page can never offer a repair this module would not make.
//! - [`plan`] is what the flow draws: the before/after, `What changes on disk`,
//!   the reach line — and the blob ids the two files had **when the flow was
//!   read**, which is what "never override" is judged against later.
//! - [`file_rows`] reads the files the same way for a checkout and for the
//!   integration branch's mirror, so a shared workspace's page is about what
//!   the branch carries and an unshared one's is about the checkout.
//!
//! Where the step writes is decided once, by the caller's `shared` flag: a
//! shared workspace publishes through [`crate::shared_library_sync`] and this
//! module's [`apply`] is never reached, so the checkout is not touched.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic;
use crate::workspace::WorkspaceStore;

const AGENTS_FILE: &str = "AGENTS.md";
const CLAUDE_FILE: &str = "CLAUDE.md";
const CLAUDE_IMPORT: &str = "@AGENTS.md";
const MAX_INSTRUCTION_BYTES: u64 = 256 * 1024;
const STARTER_AGENTS: &str =
    "# Project instructions\n\n<!-- Shared project instructions for Claude Code and Codex. -->\n";
const CLAUDE_SHIM: &str = "@AGENTS.md\n";

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstructionConventionStatus {
    Compliant,
    BothMissing,
    AgentsMissing,
    ClaudeMissing,
    ClaudeImportMissing,
    ClaudeImportNotFirst,
    ClaudeImportDuplicated,
    ManualOnly,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstructionFileKind {
    Absent,
    Regular,
    Symlink,
    Directory,
    Other,
    Oversized,
    NonUtf8,
    Unreadable,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFileState {
    pub path: String,
    pub exists: bool,
    pub kind: InstructionFileKind,
    pub content: Option<String>,
    pub fingerprint: String,
    pub detail: Option<String>,
}

impl InstructionFileState {
    fn is_regular_text(&self) -> bool {
        self.kind == InstructionFileKind::Regular
    }

    fn is_absent(&self) -> bool {
        self.kind == InstructionFileKind::Absent
    }
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstructionFileTarget {
    Agents,
    Claude,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstructionFileOperation {
    Create,
    Replace,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFileChange {
    pub target: InstructionFileTarget,
    pub path: String,
    pub operation: InstructionFileOperation,
    pub before: Option<String>,
    pub after: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFixProposal {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub changes: Vec<InstructionFileChange>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionConventionReport {
    pub workspace_id: String,
    pub workspace_root: String,
    pub status: InstructionConventionStatus,
    pub compliant: bool,
    pub detail: String,
    pub agents: InstructionFileState,
    pub claude: InstructionFileState,
    pub proposals: Vec<InstructionFixProposal>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFilesExpected {
    pub agents_fingerprint: String,
    pub claude_fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ImportState {
    Compliant,
    Missing,
    NotFirst,
    Duplicated,
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn read_file_state(path: &Path) -> InstructionFileState {
    let display = path.to_string_lossy().into_owned();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return InstructionFileState {
                path: display,
                exists: false,
                kind: InstructionFileKind::Absent,
                content: None,
                fingerprint: "absent".into(),
                detail: None,
            };
        }
        Err(error) => {
            return InstructionFileState {
                path: display,
                exists: true,
                kind: InstructionFileKind::Unreadable,
                content: None,
                fingerprint: format!("unreadable:{error}"),
                detail: Some(format!("Plyloft could not inspect this path: {error}")),
            };
        }
    };

    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::Symlink,
            content: None,
            fingerprint: "symlink".into(),
            detail: Some("Symlinked instruction files require manual review.".into()),
        };
    }
    if metadata.is_dir() {
        return InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::Directory,
            content: None,
            fingerprint: "directory".into(),
            detail: Some("The instruction path is a directory, not a text file.".into()),
        };
    }
    if !metadata.is_file() {
        return InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::Other,
            content: None,
            fingerprint: "other".into(),
            detail: Some("The instruction path is not a regular file.".into()),
        };
    }
    if metadata.len() > MAX_INSTRUCTION_BYTES {
        return InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::Oversized,
            content: None,
            fingerprint: format!("oversized:{}", metadata.len()),
            detail: Some(format!(
                "Instruction file is larger than {} KiB and requires manual review.",
                MAX_INSTRUCTION_BYTES / 1024
            )),
        };
    }

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return InstructionFileState {
                path: display,
                exists: true,
                kind: InstructionFileKind::Unreadable,
                content: None,
                fingerprint: format!("unreadable:{error}"),
                detail: Some(format!("Plyloft could not read this file: {error}")),
            };
        }
    };
    let fingerprint = format!("sha256:{}", hex_sha256(&bytes));
    match String::from_utf8(bytes) {
        Ok(content) => InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::Regular,
            content: Some(content),
            fingerprint,
            detail: None,
        },
        Err(_) => InstructionFileState {
            path: display,
            exists: true,
            kind: InstructionFileKind::NonUtf8,
            content: None,
            fingerprint,
            detail: Some("Instruction file is not UTF-8 text and requires manual review.".into()),
        },
    }
}

fn import_state(content: &str) -> ImportState {
    let mut first_nonblank = None;
    let mut imports = Vec::new();
    for (index, line) in content.split('\n').enumerate() {
        let logical = line.strip_suffix('\r').unwrap_or(line);
        if first_nonblank.is_none() && !logical.trim().is_empty() {
            first_nonblank = Some(index);
        }
        if logical == CLAUDE_IMPORT {
            imports.push(index);
        }
    }
    if imports.len() > 1 {
        return ImportState::Duplicated;
    }
    let Some(import_index) = imports.first().copied() else {
        return ImportState::Missing;
    };
    if first_nonblank == Some(import_index) {
        ImportState::Compliant
    } else {
        ImportState::NotFirst
    }
}

fn without_exact_import_lines(content: &str) -> String {
    let mut retained = String::with_capacity(content.len());
    for chunk in content.split_inclusive('\n') {
        let logical = chunk.strip_suffix('\n').unwrap_or(chunk);
        let logical = logical.strip_suffix('\r').unwrap_or(logical);
        if logical != CLAUDE_IMPORT {
            retained.push_str(chunk);
        }
    }
    retained
}

fn normalized_claude(content: &str) -> String {
    let retained = without_exact_import_lines(content);
    if retained.is_empty() {
        return CLAUDE_SHIM.into();
    }
    if retained.starts_with('\n') || retained.starts_with("\r\n") {
        format!("{CLAUDE_IMPORT}\n{retained}")
    } else {
        format!("{CLAUDE_IMPORT}\n\n{retained}")
    }
}

fn change(
    target: InstructionFileTarget,
    state: &InstructionFileState,
    after: impl Into<String>,
) -> InstructionFileChange {
    InstructionFileChange {
        target,
        path: state.path.clone(),
        operation: if state.is_absent() {
            InstructionFileOperation::Create
        } else {
            InstructionFileOperation::Replace
        },
        before: state.content.clone(),
        after: after.into(),
    }
}

fn proposal(
    id: &str,
    title: &str,
    summary: &str,
    changes: Vec<InstructionFileChange>,
) -> InstructionFixProposal {
    InstructionFixProposal {
        id: id.into(),
        title: title.into(),
        summary: summary.into(),
        changes,
    }
}

fn manual_detail(agents: &InstructionFileState, claude: &InstructionFileState) -> String {
    [agents, claude]
        .iter()
        .filter_map(|state| state.detail.clone())
        .collect::<Vec<_>>()
        .join(" ")
}

fn inspect_root(root: &Path, workspace_id: &str) -> InstructionConventionReport {
    let agents = read_file_state(&root.join(AGENTS_FILE));
    let claude = read_file_state(&root.join(CLAUDE_FILE));
    let workspace_root = root.to_string_lossy().into_owned();

    if !(agents.is_absent() || agents.is_regular_text())
        || !(claude.is_absent() || claude.is_regular_text())
    {
        return InstructionConventionReport {
            workspace_id: workspace_id.into(),
            workspace_root,
            status: InstructionConventionStatus::ManualOnly,
            compliant: false,
            detail: manual_detail(&agents, &claude),
            agents,
            claude,
            proposals: Vec::new(),
        };
    }

    let (status, detail, proposals) = match (
        agents.is_absent(),
        claude.is_absent(),
        claude.content.as_deref(),
    ) {
        (true, true, _) => (
            InstructionConventionStatus::BothMissing,
            "Neither shared instruction file exists.".into(),
            vec![proposal(
                "create-both",
                "Create shared instruction files",
                "Create a starter AGENTS.md and the Claude import shim.",
                vec![
                    change(InstructionFileTarget::Agents, &agents, STARTER_AGENTS),
                    change(InstructionFileTarget::Claude, &claude, CLAUDE_SHIM),
                ],
            )],
        ),
        (false, true, _) => (
            InstructionConventionStatus::ClaudeMissing,
            "AGENTS.md exists, but Claude has no import shim.".into(),
            vec![proposal(
                "create-claude-import",
                "Create Claude import shim",
                "Create CLAUDE.md with the canonical AGENTS.md import.",
                vec![change(InstructionFileTarget::Claude, &claude, CLAUDE_SHIM)],
            )],
        ),
        (true, false, Some(claude_content)) => {
            if import_state(claude_content) == ImportState::Compliant {
                (
                    InstructionConventionStatus::AgentsMissing,
                    "CLAUDE.md imports AGENTS.md, but the shared file is missing.".into(),
                    vec![proposal(
                        "create-agents-starter",
                        "Create shared instruction file",
                        "Create a starter AGENTS.md and preserve CLAUDE.md.",
                        vec![change(
                            InstructionFileTarget::Agents,
                            &agents,
                            STARTER_AGENTS,
                        )],
                    )],
                )
            } else {
                let promoted = without_exact_import_lines(claude_content);
                let promoted = if promoted.is_empty() {
                    STARTER_AGENTS.to_string()
                } else {
                    promoted
                };
                (
                    InstructionConventionStatus::AgentsMissing,
                    "Legacy CLAUDE.md exists without a usable shared AGENTS.md. Choose which content is shared.".into(),
                    vec![
                        proposal(
                            "promote-claude-shared",
                            "Share current Claude instructions",
                            "Move the current Claude instructions into AGENTS.md and leave only the import shim.",
                            vec![
                                change(InstructionFileTarget::Agents, &agents, promoted),
                                change(InstructionFileTarget::Claude, &claude, CLAUDE_SHIM),
                            ],
                        ),
                        proposal(
                            "keep-claude-specific",
                            "Keep current Claude instructions provider-specific",
                            "Create a starter AGENTS.md and preserve the current Claude content after the import.",
                            vec![
                                change(InstructionFileTarget::Agents, &agents, STARTER_AGENTS),
                                change(
                                    InstructionFileTarget::Claude,
                                    &claude,
                                    normalized_claude(claude_content),
                                ),
                            ],
                        ),
                    ],
                )
            }
        }
        (false, false, Some(claude_content)) => {
            let state = import_state(claude_content);
            match state {
                ImportState::Compliant => (
                    InstructionConventionStatus::Compliant,
                    "Claude and Codex share AGENTS.md; Claude imports it first.".into(),
                    Vec::new(),
                ),
                ImportState::Missing => (
                    InstructionConventionStatus::ClaudeImportMissing,
                    "CLAUDE.md does not import the shared AGENTS.md.".into(),
                    vec![proposal(
                        "normalize-claude-import",
                        "Add Claude import",
                        "Prepend the canonical import and preserve all current Claude-specific content.",
                        vec![change(
                            InstructionFileTarget::Claude,
                            &claude,
                            normalized_claude(claude_content),
                        )],
                    )],
                ),
                ImportState::NotFirst => (
                    InstructionConventionStatus::ClaudeImportNotFirst,
                    "The AGENTS.md import is present but is not Claude's first instruction.".into(),
                    vec![proposal(
                        "normalize-claude-import",
                        "Move Claude import first",
                        "Move one canonical import to the first line and preserve the remaining content.",
                        vec![change(
                            InstructionFileTarget::Claude,
                            &claude,
                            normalized_claude(claude_content),
                        )],
                    )],
                ),
                ImportState::Duplicated => (
                    InstructionConventionStatus::ClaudeImportDuplicated,
                    "CLAUDE.md imports AGENTS.md more than once.".into(),
                    vec![proposal(
                        "normalize-claude-import",
                        "Deduplicate Claude import",
                        "Keep one canonical first import and preserve the remaining content.",
                        vec![change(
                            InstructionFileTarget::Claude,
                            &claude,
                            normalized_claude(claude_content),
                        )],
                    )],
                ),
            }
        }
        _ => unreachable!("regular/absent states exhaust the instruction matrix"),
    };

    InstructionConventionReport {
        workspace_id: workspace_id.into(),
        workspace_root,
        compliant: status == InstructionConventionStatus::Compliant,
        status,
        detail,
        agents,
        claude,
        proposals,
    }
}

fn workspace_root(store: &WorkspaceStore, workspace_id: &str) -> Result<PathBuf, String> {
    let workspace = store
        .snapshot()
        .workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| format!("workspace '{workspace_id}' not found"))?;
    let root = crate::platform::canonicalize(&workspace.cwd)
        .map_err(|error| format!("canonicalize workspace '{}': {error}", workspace.cwd))?;
    if !root.is_dir() {
        return Err(format!("workspace '{}' is not a directory", workspace.cwd));
    }
    Ok(root)
}

fn apply_root(
    root: &Path,
    workspace_id: &str,
    proposal_id: &str,
    expected: &InstructionFilesExpected,
) -> Result<InstructionConventionReport, String> {
    let report = inspect_root(root, workspace_id);
    if report.agents.fingerprint != expected.agents_fingerprint
        || report.claude.fingerprint != expected.claude_fingerprint
    {
        return Err("Instruction files changed after review. Check again before applying.".into());
    }
    let selected = report
        .proposals
        .iter()
        .find(|candidate| candidate.id == proposal_id)
        .cloned()
        .ok_or_else(|| "The reviewed instruction proposal is no longer available.".to_string())?;

    for change in selected.changes {
        let path = match change.target {
            InstructionFileTarget::Agents => root.join(AGENTS_FILE),
            InstructionFileTarget::Claude => root.join(CLAUDE_FILE),
        };
        atomic::write_atomic_text(&path, &change.after)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(inspect_root(root, workspace_id))
}

pub fn apply(
    store: &WorkspaceStore,
    workspace_id: &str,
    proposal_id: &str,
    expected: &InstructionFilesExpected,
) -> Result<InstructionConventionReport, String> {
    let root = workspace_root(store, workspace_id)?;
    apply_root(&root, workspace_id, proposal_id, expected)
}

// ── GH #101: the page, the Procedure row and the flow ─────────────────
//
// BOARDS.md §5 "A procedure" and "The flow". Everything below reads; the only
// writer in this module is still `apply_root`, and a shared workspace never
// reaches it (the step's files go to the channel instead).

/// The two files, at the root, in the order the page lists them.
pub const INSTRUCTION_FILE_NAMES: [&str; 2] = [AGENTS_FILE, CLAUDE_FILE];
/// The flow's eyebrow (BOARDS.md §5). The step's button is `Set up` in every
/// state, which is the page's own string (`src/lib/libraryInstructions.ts`).
pub const FLOW_EYEBROW: &str = "Set up · 1 step";

const HOUSE_RULES: &str = "The house rules for this repository";
const SHARED_RULES: &str = "The house rules every agent reads, Claude and Codex alike";
const IMPORT_ONLY: &str = "One line pointing Claude at AGENTS.md";

/// Inspect any directory laid out like a repository root — the member's
/// checkout, or the integration branch's mirror.
///
/// GH #101: the mirror carries the branch's `AGENTS.md` and `CLAUDE.md`
/// (`shared_library_sync::build_mirror`), so a shared workspace's page and flow
/// are about what the branch holds, judged by the very same reader that judges
/// a checkout. One doctor, two roots — never two implementations of "what state
/// are the instructions in".
pub fn inspect(root: &Path, workspace_id: &str) -> InstructionConventionReport {
    inspect_root(root, workspace_id)
}

/// What the `Agent instructions` Procedure row says, and the one step it offers.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionProcedure {
    pub status: InstructionConventionStatus,
    /// The row's one sentence.
    pub sentence: String,
    /// The proposal `Set up` runs — the doctor's **own first** proposal, so the
    /// page can never offer a repair this module would not make. `None`: the
    /// procedure is quiet and the row has no action.
    pub step: Option<String>,
}

/// Every state the doctor knows, as one sentence and at most one step
/// (BOARDS.md §5; the card's "Every state the doctor knows today gets its
/// sentence and at most one step").
///
/// The board's own two strings are verbatim: `Only CLAUDE.md — Codex reads
/// nothing here.` before the step, `Shared through AGENTS.md — both CLIs read
/// the same file.` after it.
///
/// A legacy `CLAUDE.md` without a usable `AGENTS.md` is the one state the doctor
/// offers two repairs for. The row takes the first — `promote-claude-shared`,
/// the one the board draws — because a row has at most one step; the other
/// (`keep-claude-specific`) is not offered by this page.
pub fn procedure(report: &InstructionConventionReport) -> InstructionProcedure {
    use InstructionConventionStatus as S;
    let step = report.proposals.first().map(|p| p.id.clone());
    let sentence = match (report.status, step.as_deref()) {
        (S::Compliant, _) => "Shared through AGENTS.md — both CLIs read the same file.".to_string(),
        (S::BothMissing, _) => {
            "Neither file is here — the agents start with nothing to read.".to_string()
        }
        // `CLAUDE.md` imports a file that isn't there: the import leads nowhere,
        // which is a different trouble from having no shared file at all.
        (S::AgentsMissing, Some("create-agents-starter")) => {
            "CLAUDE.md imports AGENTS.md, which isn't here — the import leads nowhere.".to_string()
        }
        (S::AgentsMissing, _) => "Only CLAUDE.md — Codex reads nothing here.".to_string(),
        (S::ClaudeMissing, _) => "Only AGENTS.md — Claude reads nothing here.".to_string(),
        (S::ClaudeImportMissing, _) => {
            "Both files are here, and CLAUDE.md doesn't import AGENTS.md — the two CLIs read different instructions."
                .to_string()
        }
        (S::ClaudeImportNotFirst, _) => {
            "CLAUDE.md imports AGENTS.md, but not first — Claude reads its own lines before the shared ones."
                .to_string()
        }
        (S::ClaudeImportDuplicated, _) => {
            "CLAUDE.md imports AGENTS.md more than once.".to_string()
        }
        // Ply will not rewrite a symlink, a directory, non-UTF-8 or an
        // oversized file, so there is no step to offer — only the reason.
        (S::ManualOnly, _) => format!("Plyloft doesn't change these files. {}", report.detail),
    };
    InstructionProcedure {
        status: report.status,
        sentence,
        step,
    }
}

/// The instruction files the mirror left off the branch because they are
/// symlinks there, in the board's order.
///
/// GH #101: the mirror refuses a symlink, so the doctor reading it would see the
/// file as **absent** and offer to create one — over somebody's link, and against
/// the Phase 1C rule that Ply never replaces a symlinked instruction file. The
/// page asks this first and says so instead.
pub fn symlinked_on_branch(skipped: &[String]) -> Vec<String> {
    INSTRUCTION_FILE_NAMES
        .iter()
        .filter(|name| skipped.iter().any(|line| line == &format!("{name} is a symlink")))
        .map(|name| name.to_string())
        .collect()
}

/// The Procedure row for files the branch keeps as symlinks: the reason, and no
/// step — the words [`procedure`] uses for a checkout Ply will not touch.
pub fn manual_on_branch(files: &[String], branch: &str) -> InstructionProcedure {
    InstructionProcedure {
        status: InstructionConventionStatus::ManualOnly,
        sentence: format!(
            "Plyloft doesn't change these files. {} on {branch} {} a symlink, and Plyloft does not replace one.",
            files.join(" and "),
            if files.len() == 1 { "is" } else { "are" },
        ),
        step: None,
    }
}

/// Where a row's file is, once the branch and the checkout can disagree
/// (GH #101 review 1).
///
/// An unshared workspace reads one directory as both, so every row is
/// [`Self::Both`] there.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstructionFileWhere {
    /// In the checkout and on the branch, byte for byte the same.
    Both,
    /// In both, and they differ — the agents here read something else.
    BothDiffering,
    /// On the branch only: nothing in this checkout to open, and the CLIs here
    /// do not read it until the member pulls.
    BranchOnly,
    /// In the checkout only: it reaches nobody else until it is on the branch.
    CheckoutOnly,
    /// GH #161: here only through a **queued** change, which the mirror lays over
    /// the branch's tree as soon as it is enqueued, **and the branch has no copy
    /// of this file at all**. It is publishing, or waiting in a pull request, so
    /// the row says that in the procedure's own transient vocabulary and never
    /// `On <branch> only — pull it to get it here.`, which would send the member
    /// to pull a file that is not there.
    Queued,
    /// GH #161 review 1 (MAJOR): a queued change laid over a file the branch
    /// **does** carry — the `Set up` step writes the `CLAUDE.md` shim over the
    /// house rules that are already there. `Queued`'s words would say `CLAUDE.md`
    /// is not on the branch until the pull request merges, and it is: the branch
    /// keeps the copy it has until then, and that is what the row says.
    QueuedOverBranch,
}

/// One `In this repository` Value row (BOARDS.md §5).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFileRow {
    pub name: String,
    /// GH #101 review 1 (MINOR): the length of **the copy the row describes**,
    /// which is the one `›` opens whenever there is one. Mixing the branch's
    /// count with the checkout's file would have the member open a file of a
    /// different length than the hint promised.
    pub lines: usize,
    /// The hint, whole: the purpose in words and the line count — the board's
    /// `The house rules for this repository — 212 lines.` The page adds the
    /// sentence that says where the copy is, when that is not just "here".
    pub hint: String,
    /// The checkout path `›` opens in Code, `None` when the checkout has no
    /// regular copy of it (the branch has it and this checkout does not, a
    /// symlink, anything Ply would not write).
    pub open_in_code: Option<String>,
    /// GH #142: the path `›` opens **read-only** when there is no checkout copy
    /// to write — the file in Ply's mirror of the branch, which is the copy this
    /// row is then describing.
    ///
    /// Produced here and not composed in the window, for the reason
    /// `personal_skill_reveal` takes a listed path and not a built one: the only
    /// paths Ply hands to Code for a tree it must not write are paths Ply itself
    /// read. `None` whenever `open_in_code` is `Some` (there is a real local file
    /// to edit, and offering both would be two ways to the same row), and `None`
    /// for an unshared workspace, where the mirror **is** the checkout — one
    /// directory read as both, so a row with no local copy has no copy at all.
    ///
    /// Set for [`InstructionFileWhere::BranchOnly`] and nothing else, which is
    /// what makes it exactly "the branch's own copy" (review 1, MINOR). A
    /// **queued** row is the case that forced the narrowing: the mirror carries
    /// the queue laid over the branch's tree, so those bytes are the pending
    /// change's and not the branch's, and the reading view's line — `Ply's own
    /// copy of <branch>… pull <branch> and edit it in your checkout` — would have
    /// been false twice over about a file the branch has not got. Saying it
    /// properly would mean carrying the queued fact through to the editor's
    /// banner, which is a sentence the Procedure row and the row's own hint
    /// already carry; until something asks for it, the row keeps the `›` it had
    /// before this card, which is none.
    pub read_only_path: Option<String>,
    /// Which copy this row describes, and whether the two agree.
    pub located: InstructionFileWhere,
}

fn line_count(text: &str) -> usize {
    text.lines().count()
}

fn lines_phrase(text: &str) -> String {
    if text == CLAUDE_SHIM {
        return "1 line, an import".to_string();
    }
    let n = line_count(text);
    format!("{n} line{}", if n == 1 { "" } else { "s" })
}

fn purpose(name: &str, content: &str) -> &'static str {
    if content.trim() == CLAUDE_IMPORT {
        return IMPORT_ONLY;
    }
    if name == AGENTS_FILE {
        SHARED_RULES
    } else {
        HOUSE_RULES
    }
}

/// The Value rows for `In this repository`: the instruction files the CLIs
/// read, from `source` (the checkout, or the branch's mirror) and from the
/// member's own `checkout`.
///
/// A file neither of them has plainly has no row — the section lists what the
/// agents read, and an absent file is what the Procedure row is about.
///
/// GH #101 review 1: a row appears when **either** side has it, and describes the
/// copy `›` opens whenever there is one, so its length is the length of the file
/// the member would see. `located` says whether the two agree, which is what the
/// page needs to stop promising that a branch-only file is already here.
///
/// GH #161: `queued` names the instruction files a pending change laid over
/// `source` ([`crate::shared_library_sync::queued_instruction_files`]). `source`
/// is the mirror, and the mirror carries the queue over the branch's tree, so
/// what one of those rows shows is **not** what the branch carries — the page
/// says where the change waits instead of reading the mirror as the branch. Empty
/// for a checkout read (an unshared workspace has no queue).
///
/// `bases` is each file's blob id **on the branch** as of this build
/// (`InstructionSource::bases`, `None`: the branch has no such file), and it is
/// what tells the two queued cases apart: a file the branch has not got at all,
/// and one the change is laid over (review 1, MAJOR).
///
/// A `QueuedOverBranch` row says the branch keeps its own copy and **does not**
/// say whether this checkout's copy is that one: the queue has overwritten the
/// mirror's bytes for that path, and this function reads only the two
/// directories. It is not that it could not be answered (review 2) — it would
/// take one of two things per row, and neither is free:
///
/// - `proposals::target_blob_with` on the checkout's file (`git hash-object`
///   without `-w`, so nothing is written) compared against `bases[name]`. The
///   subtlety `worktrees.rs`'s `same_as_blob` handles: with clean/smudge filters
///   or CRLF conversion in play, the filtered and unfiltered ids differ, and only
///   a file that hashes to the blob **both** with `--no-filters` and without is
///   really the branch's bytes — so it is two subprocesses, not one.
/// - or `Plumbing::read_at(manifest.commit, name)` for the branch's own bytes at
///   this build's commit, compared to the file here.
///
/// Either would run per row on every read of the page, for a sentence the
/// Procedure row's transient is already carrying while anything is queued. If the
/// rows ever need to say it, that is the cost and that is the trap.
pub fn file_rows(
    source: &Path,
    checkout: &Path,
    queued: &[String],
    bases: &BTreeMap<String, Option<String>>,
) -> Vec<InstructionFileRow> {
    let mut rows = Vec::new();
    for name in INSTRUCTION_FILE_NAMES {
        let on_branch = read_file_state(&source.join(name));
        let branch_text = on_branch
            .content
            .as_deref()
            .filter(|_| on_branch.is_regular_text());
        // Only a regular file in the member's own checkout is ever handed to
        // Code: the mirror is Ply's, and a symlink is not ours to write.
        let local = read_file_state(&checkout.join(name));
        let local_text = local.content.as_deref().filter(|_| local.is_regular_text());
        let located = match (branch_text, local_text) {
            // The queue's copy, not the branch's — whatever the checkout has
            // beside it (GH #161). A copy the member also happens to have here is
            // still not the branch's, and that is what this row is about.
            (Some(_), _) if queued.iter().any(|path| path == name) => {
                // …and whether the branch has a copy of its own underneath it,
                // which decides which of the two things is true (review 1).
                if bases.get(name).is_some_and(|blob| blob.is_some()) {
                    InstructionFileWhere::QueuedOverBranch
                } else {
                    InstructionFileWhere::Queued
                }
            }
            (Some(branch), Some(here)) if branch == here => InstructionFileWhere::Both,
            (Some(_), Some(_)) => InstructionFileWhere::BothDiffering,
            (Some(_), None) => InstructionFileWhere::BranchOnly,
            (None, Some(_)) => InstructionFileWhere::CheckoutOnly,
            (None, None) => continue,
        };
        // The copy the row is about: the member's own whenever they have one.
        let content = local_text.or(branch_text).unwrap_or("");
        rows.push(InstructionFileRow {
            name: name.to_string(),
            lines: line_count(content),
            hint: format!("{} — {}.", purpose(name, content), lines_phrase(content)),
            open_in_code: local_text.map(|_| local.path.clone()),
            read_only_path: match located {
                InstructionFileWhere::BranchOnly => Some(on_branch.path.clone()),
                _ => None,
            },
            located,
        });
    }
    rows
}

/// What the `Set up` flow draws (BOARDS.md §5 "The flow").
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstructionFlowPlan {
    pub proposal_id: String,
    pub eyebrow: String,
    pub title: String,
    pub lede: String,
    /// The file whose before and after sit side by side — the board's
    /// `Before · CLAUDE.md` / `After · CLAUDE.md`.
    pub compared: String,
    pub before: Option<String>,
    pub after: String,
    /// The board's sentence under the two panels — `The 212 lines move to
    /// AGENTS.md, unchanged.` — said only when that is what happens.
    pub note: Option<String>,
    /// `What changes on disk`, one line per file.
    pub disk: Vec<String>,
    /// `Reaches everyone who opens this repo, after you publish.` — or `after
    /// you commit it.` when the workspace has no shared definition.
    pub reach: String,
    /// GH #101: each file's blob id on the integration branch **as this plan was
    /// read** (`None`: absent). Handed back to the step and compared against the
    /// fresh tip at publish time, so a file that moved meanwhile gets a pull
    /// request instead of being written over. Empty for an unshared workspace,
    /// where `expected` is the gate instead.
    pub bases: std::collections::BTreeMap<String, Option<String>>,
    /// The two fingerprints the checkout path revalidates before writing.
    pub expected: InstructionFilesExpected,
}

fn flow_words(
    proposal_id: &str,
    status: InstructionConventionStatus,
) -> (&'static str, &'static str) {
    // GH #101 review 1 (MINOR): `normalize-claude-import` serves three states,
    // and for one of them — the import written twice — the step **does** remove
    // lines, possibly below the flow's three-line preview. `Nothing is deleted.`
    // would have been false there, so that state gets its own words and says
    // what goes.
    if status == InstructionConventionStatus::ClaudeImportDuplicated {
        return (
            "Let both CLIs read the same instructions",
            "CLAUDE.md points at AGENTS.md more than once. Plyloft will keep one of those lines, first, and leave every other line where it is — the extra import lines are the only thing removed.",
        );
    }
    match proposal_id {
        // The board's own case and its own words.
        "promote-claude-shared" => (
            "Let both CLIs read the same instructions",
            "Plyloft will put the instructions in AGENTS.md, which both Claude and Codex read, and leave one line in CLAUDE.md pointing at it. Nothing is deleted.",
        ),
        "create-both" => (
            "Let both CLIs read the same instructions",
            "Plyloft will create AGENTS.md, which both Claude and Codex read, and leave one line in CLAUDE.md pointing at it. Nothing is deleted.",
        ),
        "create-claude-import" => (
            "Let Claude read the shared instructions",
            "AGENTS.md is already here and Claude doesn't read it. Plyloft will create CLAUDE.md with one line pointing at it. Nothing is deleted.",
        ),
        "create-agents-starter" => (
            "Give the import something to read",
            "CLAUDE.md already points at AGENTS.md, which isn't here. Plyloft will create AGENTS.md, which both Claude and Codex read. Nothing is deleted.",
        ),
        // `normalize-claude-import`: the import is missing, not first, or there
        // twice. One line moves; every other line stays where it is.
        _ => (
            "Let both CLIs read the same instructions",
            "Plyloft will put one line pointing at AGENTS.md first in CLAUDE.md and leave every other line where it is. Nothing is deleted.",
        ),
    }
}

fn file_name(target: InstructionFileTarget) -> &'static str {
    match target {
        InstructionFileTarget::Agents => AGENTS_FILE,
        InstructionFileTarget::Claude => CLAUDE_FILE,
    }
}

/// The board's sentence under the two panels — `The 212 lines move to AGENTS.md,
/// unchanged.` — said only when that is what happens: `CLAUDE.md`'s bytes become
/// `AGENTS.md`'s, byte for byte, and `CLAUDE.md` is left as the import alone.
fn moved_note(proposal: &InstructionFixProposal) -> Option<String> {
    let agents = proposal
        .changes
        .iter()
        .find(|c| c.target == InstructionFileTarget::Agents)?;
    let claude = proposal
        .changes
        .iter()
        .find(|c| c.target == InstructionFileTarget::Claude)?;
    if claude.after != CLAUDE_SHIM || claude.before.as_deref() != Some(agents.after.as_str()) {
        return None;
    }
    let n = line_count(&agents.after);
    Some(format!(
        "The {n} line{} move{} to AGENTS.md, unchanged.",
        if n == 1 { "" } else { "s" },
        if n == 1 { "s" } else { "" },
    ))
}

fn disk_line(change: &InstructionFileChange) -> String {
    let name = file_name(change.target);
    let what = lines_phrase(&change.after);
    match change.operation {
        InstructionFileOperation::Create => format!("+ {name} (new, {what})"),
        InstructionFileOperation::Replace => format!("~ {name} ({what})"),
    }
}

/// The `<what changed>` of the card's commit message `instructions: <what
/// changed>` — the step's outcome in words, not its proposal's id.
pub fn commit_subject(proposal_id: &str) -> String {
    match proposal_id {
        "promote-claude-shared" | "create-both" => "both CLIs read AGENTS.md",
        "create-claude-import" => "Claude reads the shared AGENTS.md",
        "create-agents-starter" => "AGENTS.md is there for CLAUDE.md's import",
        // `normalize-claude-import`, whichever of its three states it came from.
        _ => "CLAUDE.md imports AGENTS.md first",
    }
    .to_string()
}

/// `Reaches everyone who opens this repo, after you publish.` — and the card's
/// `after you commit it` when there is no shared definition to publish to.
pub fn reach_line(shared: bool) -> String {
    if shared {
        "Reaches everyone who opens this repo, after you publish.".to_string()
    } else {
        "Reaches everyone who opens this repo, after you commit it.".to_string()
    }
}

/// The flow for `report`'s one step, or `None` when the procedure is quiet.
///
/// `bases` is what the branch held when this was read; it travels with the plan
/// so the publish can refuse to override a file that moved since.
pub fn plan(
    report: &InstructionConventionReport,
    shared: bool,
    bases: std::collections::BTreeMap<String, Option<String>>,
) -> Option<InstructionFlowPlan> {
    let proposal = report.proposals.first()?;
    let (title, lede) = flow_words(&proposal.id, report.status);
    // The board compares `CLAUDE.md`; a step that doesn't touch it compares the
    // one file it does.
    let shown = proposal
        .changes
        .iter()
        .find(|c| c.target == InstructionFileTarget::Claude)
        .or_else(|| proposal.changes.first())?;
    Some(InstructionFlowPlan {
        proposal_id: proposal.id.clone(),
        eyebrow: FLOW_EYEBROW.to_string(),
        title: title.to_string(),
        lede: lede.to_string(),
        compared: file_name(shown.target).to_string(),
        before: shown.before.clone(),
        after: shown.after.clone(),
        note: moved_note(proposal),
        disk: proposal.changes.iter().map(disk_line).collect(),
        reach: reach_line(shared),
        bases,
        expected: InstructionFilesExpected {
            agents_fingerprint: report.agents.fingerprint.clone(),
            claude_fingerprint: report.claude.fingerprint.clone(),
        },
    })
}

/// The files a step writes and their new contents, read out of `root` — how a
/// **shared** workspace's `Set up` reaches the channel.
///
/// Nothing is written here, and nothing the window sent decides the contents:
/// the proposal is recomputed from `root` and refused unless both files still
/// carry the fingerprints the plan was read with. The same gate
/// [`apply_root`] applies before it writes a checkout.
pub fn channel_files(
    root: &Path,
    proposal_id: &str,
    expected: &InstructionFilesExpected,
) -> Result<Vec<(String, String)>, String> {
    let report = inspect_root(root, "");
    if report.agents.fingerprint != expected.agents_fingerprint
        || report.claude.fingerprint != expected.claude_fingerprint
    {
        return Err("Instruction files changed after review. Check again before applying.".into());
    }
    let selected = report
        .proposals
        .iter()
        .find(|candidate| candidate.id == proposal_id)
        .ok_or_else(|| "The reviewed instruction proposal is no longer available.".to_string())?;
    Ok(selected
        .changes
        .iter()
        .map(|change| (file_name(change.target).to_string(), change.after.clone()))
        .collect())
}

/// The blob ids `items` records for the two instruction files, keyed by file
/// name — the shape [`plan`] and the channel both speak.
pub fn bases_from(items: &BTreeMap<String, String>) -> BTreeMap<String, Option<String>> {
    INSTRUCTION_FILE_NAMES
        .iter()
        .map(|name| {
            (
                name.to_string(),
                items.get(&format!("instructions/{name}")).cloned(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> TempDir {
        TempDir::new().unwrap()
    }

    fn write(root: &Path, name: &str, content: &[u8]) {
        fs::write(root.join(name), content).unwrap();
    }

    fn inspect(root: &Path) -> InstructionConventionReport {
        inspect_root(root, "ws")
    }

    fn expected(report: &InstructionConventionReport) -> InstructionFilesExpected {
        InstructionFilesExpected {
            agents_fingerprint: report.agents.fingerprint.clone(),
            claude_fingerprint: report.claude.fingerprint.clone(),
        }
    }

    #[test]
    fn both_missing_proposes_two_file_creation() {
        let dir = fixture();
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::BothMissing);
        assert_eq!(report.proposals.len(), 1);
        assert_eq!(report.proposals[0].changes.len(), 2);
    }

    #[test]
    fn compliant_requires_one_first_nonblank_import() {
        let dir = fixture();
        write(dir.path(), AGENTS_FILE, b"# Shared\n");
        write(dir.path(), CLAUDE_FILE, b"\n@AGENTS.md\n\n# Claude\n");
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::Compliant);
        assert!(report.compliant);
        assert!(report.proposals.is_empty());
    }

    #[test]
    fn import_directive_must_be_exact_but_accepts_crlf() {
        let dir = fixture();
        write(dir.path(), AGENTS_FILE, b"# Shared\n");

        write(dir.path(), CLAUDE_FILE, b" @AGENTS.md\n");
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::ClaudeImportMissing
        );

        write(dir.path(), CLAUDE_FILE, b"@AGENTS.md \n");
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::ClaudeImportMissing
        );

        write(dir.path(), CLAUDE_FILE, b"@AGENTS.md\r\n# Claude\r\n");
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::Compliant
        );
    }

    #[test]
    fn missing_agents_with_import_proposes_only_starter() {
        let dir = fixture();
        write(dir.path(), CLAUDE_FILE, CLAUDE_SHIM.as_bytes());
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::AgentsMissing);
        assert_eq!(report.proposals[0].id, "create-agents-starter");
        assert_eq!(report.proposals[0].changes.len(), 1);
    }

    #[test]
    fn legacy_claude_offers_share_or_provider_specific() {
        let dir = fixture();
        write(dir.path(), CLAUDE_FILE, b"# Legacy\nClaude only?\n");
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::AgentsMissing);
        assert_eq!(report.proposals.len(), 2);
        assert_eq!(report.proposals[0].id, "promote-claude-shared");
        assert_eq!(report.proposals[1].id, "keep-claude-specific");
    }

    #[test]
    fn missing_claude_proposes_import_shim() {
        let dir = fixture();
        write(dir.path(), AGENTS_FILE, b"# Shared\n");
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::ClaudeMissing);
        assert_eq!(report.proposals[0].id, "create-claude-import");
    }

    #[test]
    fn missing_not_first_and_duplicate_imports_are_distinct() {
        let dir = fixture();
        write(dir.path(), AGENTS_FILE, b"# Shared\n");

        write(dir.path(), CLAUDE_FILE, b"# Claude\n");
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::ClaudeImportMissing
        );

        write(dir.path(), CLAUDE_FILE, b"# Claude\n@AGENTS.md\n");
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::ClaudeImportNotFirst
        );

        write(
            dir.path(),
            CLAUDE_FILE,
            b"@AGENTS.md\n# Claude\n@AGENTS.md\n",
        );
        assert_eq!(
            inspect(dir.path()).status,
            InstructionConventionStatus::ClaudeImportDuplicated
        );
    }

    #[test]
    fn normalize_preserves_crlf_and_no_final_newline_content() {
        let original = "# Claude\r\nKeep this";
        let normalized = normalized_claude(original);
        assert_eq!(normalized, "@AGENTS.md\n\n# Claude\r\nKeep this");
        assert!(normalized.ends_with("Keep this"));
    }

    #[test]
    fn promote_preserves_legacy_bytes() {
        let dir = fixture();
        let legacy = b"# Rules\r\nKeep every byte";
        write(dir.path(), CLAUDE_FILE, legacy);
        let before = inspect(dir.path());
        let after = apply_root(
            dir.path(),
            "ws",
            "promote-claude-shared",
            &expected(&before),
        )
        .unwrap();
        assert!(after.compliant);
        assert_eq!(fs::read(dir.path().join(AGENTS_FILE)).unwrap(), legacy);
        assert_eq!(
            fs::read_to_string(dir.path().join(CLAUDE_FILE)).unwrap(),
            CLAUDE_SHIM
        );
    }

    #[test]
    fn provider_specific_choice_preserves_legacy_as_substring() {
        let dir = fixture();
        let legacy = "# Claude only\nKeep me\n";
        write(dir.path(), CLAUDE_FILE, legacy.as_bytes());
        let before = inspect(dir.path());
        let after =
            apply_root(dir.path(), "ws", "keep-claude-specific", &expected(&before)).unwrap();
        assert!(after.compliant);
        let claude = fs::read_to_string(dir.path().join(CLAUDE_FILE)).unwrap();
        assert!(claude.starts_with(CLAUDE_IMPORT));
        assert!(claude.contains(legacy));
    }

    #[test]
    fn stale_preview_refuses_without_writing_either_file() {
        let dir = fixture();
        let before = inspect(dir.path());
        write(dir.path(), CLAUDE_FILE, b"external edit\n");
        let error = apply_root(dir.path(), "ws", "create-both", &expected(&before)).unwrap_err();
        assert!(error.contains("changed after review"));
        assert!(!dir.path().join(AGENTS_FILE).exists());
        assert_eq!(
            fs::read_to_string(dir.path().join(CLAUDE_FILE)).unwrap(),
            "external edit\n"
        );
    }

    #[test]
    fn apply_uses_fixed_root_paths_and_cleans_atomic_temps() {
        let dir = fixture();
        let before = inspect(dir.path());
        let after = apply_root(dir.path(), "ws", "create-both", &expected(&before)).unwrap();
        assert!(after.compliant);
        assert_eq!(
            after.agents.path,
            dir.path().join(AGENTS_FILE).to_string_lossy()
        );
        assert!(!dir.path().join("AGENTS.md.atelier-tmp").exists());
        assert!(!dir.path().join("CLAUDE.md.atelier-tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_manual_only_and_has_no_proposals() {
        use std::os::unix::fs::symlink;
        let dir = fixture();
        write(dir.path(), "target.md", b"# target\n");
        symlink(dir.path().join("target.md"), dir.path().join(AGENTS_FILE)).unwrap();
        let report = inspect(dir.path());
        assert_eq!(report.status, InstructionConventionStatus::ManualOnly);
        assert_eq!(report.agents.kind, InstructionFileKind::Symlink);
        assert!(report.proposals.is_empty());
    }

    #[test]
    fn oversized_and_non_utf8_files_are_manual_only() {
        let oversized = fixture();
        write(
            oversized.path(),
            AGENTS_FILE,
            &vec![b'x'; MAX_INSTRUCTION_BYTES as usize + 1],
        );
        assert_eq!(
            inspect(oversized.path()).agents.kind,
            InstructionFileKind::Oversized
        );

        let non_utf8 = fixture();
        write(non_utf8.path(), AGENTS_FILE, &[0xff, 0xfe]);
        assert_eq!(
            inspect(non_utf8.path()).agents.kind,
            InstructionFileKind::NonUtf8
        );
    }

    #[test]
    fn unknown_or_no_longer_available_proposal_is_refused() {
        let dir = fixture();
        write(dir.path(), AGENTS_FILE, b"# Shared\n");
        write(dir.path(), CLAUDE_FILE, CLAUDE_SHIM.as_bytes());
        let report = inspect(dir.path());
        let error = apply_root(dir.path(), "ws", "create-both", &expected(&report)).unwrap_err();
        assert!(error.contains("no longer available"));
    }
    // ── GH #101: the page's row, its one step, and the flow ───────────────

    /// The whole tree, so "it wrote nothing" is a claim about bytes.
    fn snapshot(root: &Path) -> Vec<(PathBuf, bool, Vec<u8>)> {
        fn walk(root: &Path, at: &Path, out: &mut Vec<(PathBuf, bool, Vec<u8>)>) {
            let mut entries = std::fs::read_dir(at)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect::<Vec<_>>();
            entries.sort();
            for path in entries {
                let metadata = std::fs::symlink_metadata(&path).unwrap();
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                if metadata.file_type().is_dir() {
                    out.push((relative, true, Vec::new()));
                    walk(root, &path, out);
                } else {
                    out.push((relative, false, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, root, &mut out);
        out
    }

    /// Every state the doctor can be in, built from files.
    fn states() -> Vec<(&'static str, Option<&'static [u8]>, Option<&'static [u8]>)> {
        vec![
            ("both missing", None, None),
            ("only CLAUDE.md", None, Some(b"# Rules\nBe careful.\n")),
            ("only the import", None, Some(b"@AGENTS.md\n")),
            ("only AGENTS.md", Some(b"# Shared\n"), None),
            ("no import", Some(b"# Shared\n"), Some(b"# Claude\n")),
            (
                "import not first",
                Some(b"# Shared\n"),
                Some(b"# Claude\n@AGENTS.md\n"),
            ),
            (
                "import twice",
                Some(b"# Shared\n"),
                Some(b"@AGENTS.md\n# Claude\n@AGENTS.md\n"),
            ),
            ("compliant", Some(b"# Shared\n"), Some(b"@AGENTS.md\n")),
        ]
    }

    fn planted(agents: Option<&[u8]>, claude: Option<&[u8]>) -> TempDir {
        let dir = fixture();
        if let Some(bytes) = agents {
            write(dir.path(), AGENTS_FILE, bytes);
        }
        if let Some(bytes) = claude {
            write(dir.path(), CLAUDE_FILE, bytes);
        }
        dir
    }

    /// The card: "Every state the doctor knows today gets its sentence and at
    /// most one step." Asserted over the whole matrix, so a state added to the
    /// doctor without a sentence fails here.
    #[test]
    fn every_doctor_state_has_one_sentence_and_at_most_one_step() {
        let mut seen = std::collections::BTreeSet::new();
        for (what, agents, claude) in states() {
            let dir = planted(agents, claude);
            let report = inspect(dir.path());
            let row = procedure(&report);
            seen.insert(format!("{:?}", row.status));
            assert!(!row.sentence.is_empty(), "{what} has no sentence");
            assert!(row.sentence.ends_with('.'), "{what}: {}", row.sentence);
            // At most one step, and it is one the doctor itself would make.
            if let Some(step) = &row.step {
                assert!(
                    report.proposals.iter().any(|p| &p.id == step),
                    "{what}: the step is not one of the doctor's proposals",
                );
                assert!(plan(&report, true, BTreeMap::new()).is_some(), "{what}");
            } else {
                assert!(report.compliant || report.proposals.is_empty(), "{what}");
            }
        }
        // A symlink: Ply will not change it, so there is a sentence and no step.
        // Windows without Developer Mode cannot make one; the rest still counts.
        let symlinks = crate::test_env::can_symlink();
        if !symlinks {
            crate::test_env::skip("the symlink state: this process may not create symlinks (Windows error 1314)");
        } else {
            let dir = fixture();
            write(dir.path(), "target.md", b"# target\n");
            crate::platform::symlink(&dir.path().join("target.md"), &dir.path().join(AGENTS_FILE))
                .unwrap();
            let report = inspect(dir.path());
            let row = procedure(&report);
            seen.insert(format!("{:?}", row.status));
            assert_eq!(row.step, None, "Plyloft offers no step for a file it won't write");
            assert!(row.sentence.starts_with("Plyloft doesn't change these files."), "{}", row.sentence);
        }
        // Every variant of the status enum is covered by the matrix above.
        assert_eq!(
            seen.len(),
            if symlinks { 8 } else { 7 },
            "a doctor state without a row sentence: {seen:?}",
        );
    }

    /// The board's two strings, verbatim.
    #[test]
    fn the_boards_own_sentences_are_the_boards_words() {
        let dir = planted(None, Some(b"# Rules\nBe careful.\n"));
        assert_eq!(
            procedure(&inspect(dir.path())).sentence,
            "Only CLAUDE.md — Codex reads nothing here.",
        );
        let dir = planted(Some(b"# Shared\n"), Some(b"@AGENTS.md\n"));
        let row = procedure(&inspect(dir.path()));
        assert_eq!(
            row.sentence,
            "Shared through AGENTS.md — both CLIs read the same file.",
        );
        assert_eq!(row.step, None, "the procedure goes quiet");
    }

    /// The flow the board draws, for the repository the board drew it for.
    #[test]
    fn the_flow_is_the_board_for_a_repository_with_only_claude_md() {
        let body: String = (1..=212)
            .map(|n| format!("line {n}\n"))
            .collect();
        let dir = planted(None, Some(body.as_bytes()));
        let report = inspect(dir.path());
        let flow = plan(&report, true, BTreeMap::new()).unwrap();
        assert_eq!(flow.proposal_id, "promote-claude-shared");
        assert_eq!(flow.eyebrow, "Set up · 1 step");
        assert_eq!(flow.title, "Let both CLIs read the same instructions");
        assert_eq!(
            flow.lede,
            "Plyloft will put the instructions in AGENTS.md, which both Claude and Codex read, and leave one line in CLAUDE.md pointing at it. Nothing is deleted.",
        );
        assert_eq!(flow.compared, "CLAUDE.md");
        assert_eq!(flow.before.as_deref(), Some(body.as_str()));
        assert_eq!(flow.after, "@AGENTS.md\n");
        assert_eq!(
            flow.note.as_deref(),
            Some("The 212 lines move to AGENTS.md, unchanged."),
        );
        assert_eq!(
            flow.disk,
            vec![
                "+ AGENTS.md (new, 212 lines)".to_string(),
                "~ CLAUDE.md (1 line, an import)".to_string(),
            ],
        );
        assert_eq!(flow.reach, "Reaches everyone who opens this repo, after you publish.");
        // The card: `after you commit it` when there is nothing to publish to.
        let unshared = plan(&report, false, BTreeMap::new()).unwrap();
        assert_eq!(
            unshared.reach,
            "Reaches everyone who opens this repo, after you commit it.",
        );
        // Both files, in one step, with the card's commit subject.
        assert_eq!(commit_subject(&flow.proposal_id), "both CLIs read AGENTS.md");
    }

    /// `In this repository`: a row per file the CLIs read, with the board's hint.
    #[test]
    fn the_file_rows_say_what_each_file_is_for_and_how_long_it_is() {
        let body: String = (1..=212).map(|n| format!("line {n}\n")).collect();
        let dir = planted(None, Some(body.as_bytes()));
        let rows = file_rows(dir.path(), dir.path(), &[], &BTreeMap::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "CLAUDE.md");
        assert_eq!(rows[0].lines, 212);
        assert_eq!(rows[0].hint, "The house rules for this repository — 212 lines.");
        assert_eq!(rows[0].open_in_code.as_deref(), Some(dir.path().join(CLAUDE_FILE).to_string_lossy().as_ref()));
        assert_eq!(rows[0].located, InstructionFileWhere::Both);

        // After the step: AGENTS.md holds the rules, CLAUDE.md is the import.
        let dir = planted(Some(body.as_bytes()), Some(CLAUDE_SHIM.as_bytes()));
        let rows = file_rows(dir.path(), dir.path(), &[], &BTreeMap::new());
        assert_eq!(
            rows.iter().map(|r| r.hint.as_str()).collect::<Vec<_>>(),
            vec![
                "The house rules every agent reads, Claude and Codex alike — 212 lines.",
                "One line pointing Claude at AGENTS.md — 1 line, an import.",
            ],
        );
    }

    /// The branch's copy, with a checkout that has not caught up: the row is
    /// there, and there is no path for Code to **write** — Ply offers to edit
    /// only a regular file in the member's own checkout.
    ///
    /// GH #142: it does get a path to read. The copy the row describes is the
    /// one in Ply's mirror of the branch, and that is the one the `›` opens,
    /// read-only — the board's `›` was missing from these rows for want of a
    /// reading view, not for want of a file.
    #[test]
    fn a_file_only_the_branch_has_is_read_from_the_mirror_and_never_written() {
        let branch = planted(Some(b"# Shared\n"), Some(CLAUDE_SHIM.as_bytes()));
        let checkout = fixture();
        let rows = file_rows(branch.path(), checkout.path(), &[], &BTreeMap::new());
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .all(|r| r.open_in_code.is_none() && r.located == InstructionFileWhere::BranchOnly));
        for row in &rows {
            assert_eq!(
                row.read_only_path.as_deref(),
                Some(branch.path().join(&row.name).to_string_lossy().as_ref()),
                "the path is the mirror's own, produced here and not composed in the window",
            );
        }
    }

    /// GH #142: the two paths are never both set, and an unshared workspace has
    /// no read-only path at all.
    ///
    /// One row is one file and one press. A row with a copy in the checkout is
    /// edited there; a row with none is read from the mirror; and where the
    /// mirror **is** the checkout — an unshared workspace reads one directory as
    /// both — a row with no local copy has no copy at all, so there is nothing to
    /// open either way.
    #[test]
    fn a_row_offers_one_path_and_an_unshared_workspace_offers_no_reading_view() {
        let branch = planted(Some(b"one\ntwo\nthree\n"), Some(CLAUDE_SHIM.as_bytes()));
        let checkout = planted(Some(b"one\n"), None);
        let rows = file_rows(branch.path(), checkout.path(), &[], &BTreeMap::new());
        for row in &rows {
            assert!(
                row.open_in_code.is_none() || row.read_only_path.is_none(),
                "{}: two ways to open one row",
                row.name,
            );
        }
        let agents = rows.iter().find(|r| r.name == AGENTS_FILE).unwrap();
        assert!(agents.open_in_code.is_some() && agents.read_only_path.is_none());
        let claude = rows.iter().find(|r| r.name == CLAUDE_FILE).unwrap();
        assert_eq!(
            claude.read_only_path.as_deref(),
            Some(branch.path().join(CLAUDE_FILE).to_string_lossy().as_ref()),
        );

        let one = planted(Some(b"# Shared\n"), Some(CLAUDE_SHIM.as_bytes()));
        assert!(file_rows(one.path(), one.path(), &[], &BTreeMap::new())
            .iter()
            .all(|r| r.read_only_path.is_none() && r.open_in_code.is_some()));
    }

    /// GH #101 review 1 (MINOR): the count is the copy `›` opens.
    ///
    /// The branch and the checkout can hold different lengths of the same file,
    /// and a row that read `212 lines` while its `›` opened a 3-line file would
    /// be about neither. Every shape of disagreement is named.
    #[test]
    fn a_rows_length_is_the_copy_it_opens_and_it_says_where_that_is() {
        let branch = planted(Some(b"one\ntwo\nthree\n"), Some(CLAUDE_SHIM.as_bytes()));
        let checkout = planted(Some(b"one\n"), None);

        let rows = file_rows(branch.path(), checkout.path(), &[], &BTreeMap::new());
        let agents = rows.iter().find(|r| r.name == AGENTS_FILE).unwrap();
        // The member has their own AGENTS.md: it is the one described and opened.
        assert_eq!(agents.located, InstructionFileWhere::BothDiffering);
        assert_eq!(agents.lines, 1, "the checkout's copy, which `›` opens");
        assert!(agents.hint.ends_with("1 line."));
        assert_eq!(
            agents.open_in_code.as_deref(),
            Some(checkout.path().join(AGENTS_FILE).to_string_lossy().as_ref()),
        );
        // CLAUDE.md is on the branch only: described from there, nothing to open.
        let claude = rows.iter().find(|r| r.name == CLAUDE_FILE).unwrap();
        assert_eq!(claude.located, InstructionFileWhere::BranchOnly);
        assert_eq!(claude.open_in_code, None);

        // A file the checkout has and the branch does not still gets a row: it
        // reaches nobody else, and silence about it would read as Ply not seeing
        // it.
        let empty = fixture();
        let local = planted(None, Some(b"# Mine, uncommitted\n"));
        let rows = file_rows(empty.path(), local.path(), &[], &BTreeMap::new());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].located, InstructionFileWhere::CheckoutOnly);
        assert!(rows[0].open_in_code.is_some());

        // An unshared workspace reads one directory as both, so nothing differs.
        let one = planted(Some(b"# Shared\n"), Some(CLAUDE_SHIM.as_bytes()));
        assert!(file_rows(one.path(), one.path(), &[], &BTreeMap::new())
            .iter()
            .all(|r| r.located == InstructionFileWhere::Both));
    }

    /// GH #161: the mirror carries the queue laid over the branch, so a file a
    /// queued change wrote is **not** on the branch — and the row must not say
    /// `On staging only — pull it to get it here.` about it.
    ///
    /// The Tier 4 walk of 1.144.0: `AGENTS.md` waited in pull request #375 and
    /// the row sent the member to pull it from `staging`, which did not have it.
    #[test]
    fn a_file_only_a_queued_change_wrote_is_not_read_as_the_branchs() {
        // The build as `enqueue` leaves it after the `Set up` step of a repository
        // that had only `CLAUDE.md`: the queued change's `AGENTS.md` (which the
        // branch has **not** got) and its `CLAUDE.md` shim, laid over the house
        // rules the branch **does** carry.
        let mirror = planted(Some(b"# House rules\nBe careful.\n"), Some(CLAUDE_SHIM.as_bytes()));
        let checkout = planted(None, Some(b"# House rules\nBe careful.\n"));
        let queued = [AGENTS_FILE.to_string(), CLAUDE_FILE.to_string()];
        let bases: BTreeMap<String, Option<String>> = [
            (AGENTS_FILE.to_string(), None),
            (CLAUDE_FILE.to_string(), Some("b1".to_string())),
        ]
        .into_iter()
        .collect();

        let rows = file_rows(mirror.path(), checkout.path(), &queued, &bases);
        assert_eq!(rows.len(), 2);
        let agents = rows.iter().find(|r| r.name == AGENTS_FILE).unwrap();
        let claude = rows.iter().find(|r| r.name == CLAUDE_FILE).unwrap();
        // Neither row is the branch's copy; they are not the same case, and the
        // words for one would be false about the other (review 1, MAJOR).
        assert_eq!(agents.located, InstructionFileWhere::Queued);
        assert_eq!(claude.located, InstructionFileWhere::QueuedOverBranch);
        // The checkout's own copy is still what `›` opens, and a file only the
        // queue has still has nothing to open.
        assert_eq!(agents.open_in_code, None);
        assert_eq!(
            claude.open_in_code.as_deref(),
            Some(checkout.path().join(CLAUDE_FILE).to_string_lossy().as_ref()),
        );
        // GH #142 review 1 (MINOR): and no reading view either. The mirror's
        // bytes for these two paths are the queue's, so opening them read-only
        // would put `Ply's own copy of staging … pull staging` above a file the
        // branch has not got — the same lie in the editor that #161 took off the
        // row.
        assert_eq!(agents.read_only_path, None);
        assert_eq!(claude.read_only_path, None);

        // Once the drain has landed it, the queue is empty and the same build
        // reads as the branch's again: `AGENTS.md` really is on `staging` only.
        let landed: BTreeMap<String, Option<String>> = [
            (AGENTS_FILE.to_string(), Some("b2".to_string())),
            (CLAUDE_FILE.to_string(), Some("b3".to_string())),
        ]
        .into_iter()
        .collect();
        let rows = file_rows(mirror.path(), checkout.path(), &[], &landed);
        let agents = rows.iter().find(|r| r.name == AGENTS_FILE).unwrap();
        assert_eq!(agents.located, InstructionFileWhere::BranchOnly);
        // …and its reading view comes back with it: the bytes in the mirror are
        // the branch's own now, which is what the banner says they are.
        assert_eq!(
            agents.read_only_path.as_deref(),
            Some(mirror.path().join(AGENTS_FILE).to_string_lossy().as_ref()),
        );
        // A file the queue does not write is untouched by this rule.
        let rows = file_rows(
            mirror.path(),
            checkout.path(),
            &[CLAUDE_FILE.to_string()],
            &bases,
        );
        let agents = rows.iter().find(|r| r.name == AGENTS_FILE).unwrap();
        assert_eq!(agents.located, InstructionFileWhere::BranchOnly);
        assert_eq!(
            rows.iter().find(|r| r.name == CLAUDE_FILE).unwrap().located,
            InstructionFileWhere::QueuedOverBranch,
        );
        // And a workspace whose bases are not known at all (nothing shared, so
        // nothing queued either) is untouched: no row is a queued one.
        assert!(file_rows(mirror.path(), checkout.path(), &[], &BTreeMap::new())
            .iter()
            .all(|r| r.located != InstructionFileWhere::Queued
                && r.located != InstructionFileWhere::QueuedOverBranch));
    }

    /// GH #101 review 1 (MINOR): `Nothing is deleted.` was false for the one
    /// state whose step removes lines.
    #[test]
    fn the_duplicated_import_says_what_it_removes_and_does_not_promise_otherwise() {
        // The second import is below the flow's three-line preview, which is why
        // the words have to carry it.
        let mut claude = String::from("@AGENTS.md\n");
        for n in 1..=8 {
            claude.push_str(&format!("line {n}\n"));
        }
        claude.push_str("@AGENTS.md\n");
        let dir = planted(Some(b"# Shared\n"), Some(claude.as_bytes()));
        let report = inspect(dir.path());
        assert_eq!(
            report.status,
            InstructionConventionStatus::ClaudeImportDuplicated
        );
        let flow = plan(&report, true, BTreeMap::new()).unwrap();
        assert_eq!(flow.proposal_id, "normalize-claude-import");
        assert!(
            !flow.lede.contains("Nothing is deleted"),
            "the step removes a line: {}",
            flow.lede,
        );
        assert!(
            flow.lede.contains("the extra import lines are the only thing removed"),
            "{}",
            flow.lede,
        );
        // Its two siblings keep the board's promise, because they keep every line.
        for claude in ["# Claude\n", "# Claude\n@AGENTS.md\n"] {
            let dir = planted(Some(b"# Shared\n"), Some(claude.as_bytes()));
            let flow = plan(&inspect(dir.path()), true, BTreeMap::new()).unwrap();
            assert_eq!(flow.proposal_id, "normalize-claude-import");
            assert!(flow.lede.contains("Nothing is deleted."), "{}", flow.lede);
        }
    }

    /// The card's boundary: in a shared workspace the step writes **nothing** to
    /// the checkout. `channel_files` is the whole of that path, and it is
    /// read-only — over the mirror it reads and over any root it is given.
    #[test]
    fn the_shared_step_writes_nothing_and_answers_with_both_files() {
        let dir = planted(None, Some(b"# Rules\nBe careful.\n"));
        let report = inspect(dir.path());
        let flow = plan(&report, true, BTreeMap::new()).unwrap();
        let before = snapshot(dir.path());
        let files = channel_files(dir.path(), &flow.proposal_id, &flow.expected).unwrap();
        assert_eq!(
            files,
            vec![
                ("AGENTS.md".to_string(), "# Rules\nBe careful.\n".to_string()),
                ("CLAUDE.md".to_string(), "@AGENTS.md\n".to_string()),
            ],
        );
        assert_eq!(
            snapshot(dir.path()),
            before,
            "the shared path must not write one byte of the checkout",
        );
    }

    /// The card's boundary, as one test: the **same** report and the **same**
    /// proposal, taken both ways.
    ///
    /// - no shared definition → the checkout is written, and the repository ends
    ///   compliant with the old bytes moved byte for byte;
    /// - a shared definition → the checkout is byte-identical afterwards, and the
    ///   two files come back as contents for the channel to commit.
    ///
    /// The second half fails on **any** write, which is the claim the card asks
    /// for. Which half runs is decided by `library_instructions_set_up`'s
    /// `if !source.shared`, and `libraryShell.test.ts` holds that shape — `apply`
    /// has exactly one caller, inside that branch, above its `return Ok(false)`.
    #[test]
    fn the_two_paths_of_one_step_differ_only_in_whether_the_checkout_is_written() {
        let legacy = b"# Rules\r\nEvery byte of them\n";

        // No shared definition: the checkout is the thing that changes.
        let unshared = planted(None, Some(legacy));
        let report = inspect(unshared.path());
        let flow = plan(&report, false, BTreeMap::new()).unwrap();
        assert_eq!(
            flow.reach,
            "Reaches everyone who opens this repo, after you commit it.",
        );
        let after = apply_root(unshared.path(), "ws", &flow.proposal_id, &flow.expected).unwrap();
        assert!(after.compliant, "{after:?}");
        assert_eq!(fs::read(unshared.path().join(AGENTS_FILE)).unwrap(), legacy);
        assert_eq!(
            fs::read_to_string(unshared.path().join(CLAUDE_FILE)).unwrap(),
            CLAUDE_SHIM,
        );

        // Shared: the same step, and not one byte of the checkout.
        let shared = planted(None, Some(legacy));
        let report = inspect(shared.path());
        let flow = plan(&report, true, BTreeMap::new()).unwrap();
        assert_eq!(
            flow.reach,
            "Reaches everyone who opens this repo, after you publish.",
        );
        let before = snapshot(shared.path());
        let files = channel_files(shared.path(), &flow.proposal_id, &flow.expected).unwrap();
        assert_eq!(
            files,
            vec![
                (AGENTS_FILE.to_string(), String::from_utf8_lossy(legacy).into_owned()),
                (CLAUDE_FILE.to_string(), CLAUDE_SHIM.to_string()),
            ],
            "the same two files the checkout path wrote, as contents",
        );
        assert_eq!(
            snapshot(shared.path()),
            before,
            "the shared path must not write one byte of the checkout",
        );
        // The proposal is the same one either way: the step does not change,
        // only where its result goes.
        assert_eq!(flow.proposal_id, "promote-claude-shared");
    }

    /// And it refuses a step planned against bytes that have since changed,
    /// rather than applying it to newer ones.
    #[test]
    fn the_shared_step_refuses_a_plan_read_from_older_bytes() {
        let dir = planted(None, Some(b"# Rules\n"));
        let flow = plan(&inspect(dir.path()), true, BTreeMap::new()).unwrap();
        write(dir.path(), CLAUDE_FILE, b"# Rules, edited\n");
        let error = channel_files(dir.path(), &flow.proposal_id, &flow.expected).unwrap_err();
        assert!(error.contains("changed after review"), "{error}");
        // And an id nobody offered is refused too.
        let fresh = plan(&inspect(dir.path()), true, BTreeMap::new()).unwrap();
        assert!(channel_files(dir.path(), "create-both", &fresh.expected).is_err());
    }

    /// A file the branch keeps as a symlink is missing from the mirror, so the
    /// doctor reads it as **absent** — and would offer to create one over the
    /// link. The page asks this first and offers no step.
    #[test]
    fn a_symlink_on_the_branch_has_a_sentence_and_no_step() {
        assert!(symlinked_on_branch(&[]).is_empty());
        assert!(symlinked_on_branch(&[".claude/skills/x contains a symlink".into()]).is_empty());
        let skipped = vec![
            "CLAUDE.md is a symlink".to_string(),
            ".claude/skills/x contains a symlink".to_string(),
            "AGENTS.md is a symlink".to_string(),
        ];
        // The board's order, not the manifest's.
        assert_eq!(symlinked_on_branch(&skipped), vec!["AGENTS.md", "CLAUDE.md"]);
        let row = manual_on_branch(&symlinked_on_branch(&skipped), "staging");
        assert_eq!(row.step, None);
        assert_eq!(
            row.sentence,
            "Plyloft doesn't change these files. AGENTS.md and CLAUDE.md on staging are a symlink, and Plyloft does not replace one.",
        );
        let one = manual_on_branch(&["CLAUDE.md".to_string()], "staging");
        assert!(one.sentence.contains("CLAUDE.md on staging is a symlink"), "{}", one.sentence);
        // Without the guard, the doctor on such a mirror offers to create it.
        let mirror = fixture();
        write(mirror.path(), AGENTS_FILE, b"# Shared\n");
        let report = inspect(mirror.path());
        assert!(procedure(&report).step.is_some(), "which is the bug this guards");
    }

    /// The blob ids the flow travels with come from the mirror's manifest, in
    /// the shape the never-override check reads.
    #[test]
    fn bases_are_read_per_file_out_of_the_manifest() {
        let items: BTreeMap<String, String> = [
            ("instructions/CLAUDE.md".to_string(), "abc".to_string()),
            ("skill/deploy".to_string(), "zzz".to_string()),
        ]
        .into_iter()
        .collect();
        let bases = bases_from(&items);
        assert_eq!(bases.len(), 2);
        assert_eq!(bases["CLAUDE.md"].as_deref(), Some("abc"));
        assert_eq!(bases["AGENTS.md"], None);
    }
}
