//! 1.176.0 R4: the engine of the guided Repair of Claude Code and Codex
//! (`~/ply-build/cli-repair/PLAN.md` §2, owner decisions D1–D3, measured
//! facts in `R0-FINDINGS.md`). This file is the pure planner: from one fresh
//! look at the tool ([`crate::cli_health::inspect`]) and what else Plyloft
//! knows ([`RepairContext`]), [`plan`] says what is wrong ([`Situation`]s,
//! not sentences: the window words them), what stays as it is ([`Note`]s),
//! the ordered [`Step`]s Plyloft would take, the exact commands for doing it
//! by hand, and whether something stops it ([`Block`]).
//!
//! The planner is stateless and is run again after every step from a new
//! look (plan → run the first step → plan again). It ends: a step kind that
//! was already tried in this repair and is still the next one means its
//! problem is still there, so the plan stops with
//! [`GiveUp::StillThereAfter`] and the evidence of the last run
//! (`setup_last_run`) instead of trying again.
//!
//! Rules it keeps:
//!
//! - **Never the broken binary.** The fix is the official installer
//!   (`doctor::install_cmd_on`), never `claude update`/`codex update`: R0
//!   measured both failing from a broken copy, and an npm copy's `claude
//!   update` writing to another prefix.
//! - **A corrupt Claude version file goes first** (R0 C4: the installer says
//!   it installed and leaves the 4 KB file). Codex's installer heals its own
//!   (R0 X3), so nothing of Codex is removed for it.
//! - **Ownership (D1)**: one `sudo chown -R <user> <folders>` in the visible
//!   terminal, only for the tool's own folders `cli_health` lists inside the
//!   home and found to be someone else's; never a system folder. A folder
//!   that is the user's but read-only (mode 555, R0 C5/X4) needs no password:
//!   Plyloft adds the owner's bits itself ([`StepKind::FixPermissions`]).
//!   Windows has neither step: such folders are named as work by hand.
//! - **Sessions in use (D2)**: before anything that writes, a
//!   [`StepKind::CloseSessions`] step the person (or the window) takes; the
//!   engine never closes a tile or stops a run itself.
//! - **Copies (D3)**: the native (Claude) or standalone (Codex) copy is the
//!   one Repair installs. An npm copy is removed only when the person opted
//!   in and its folders are writable (no sudo), by the npm of its own prefix
//!   with `--prefix` (R0 incident 2); Homebrew, WinGet, bun, pnpm and other
//!   copies are only named.
//! - **"Healthy enough"**: a machine whose copy a tile runs starts and the
//!   snapshot points at it is not migrated to another channel, unless that
//!   copy can't be updated (its folders aren't writable) and the tool's own
//!   install doesn't work yet, or the person ticked the npm removal. Leftovers
//!   (a second copy, a broken link off the way) are notes, not steps.
//!
//! Nothing here touches the disk; `cli_repair_run.rs` gathers the context,
//! re-checks every path it acts on and runs the steps.

use serde::{Deserialize, Serialize};

use crate::cli_health::{
    self as health, CliCopy, CliHealth, CliTool, Finding, FolderCheck, FolderRole, InstallChannel, StartFailure,
};
use crate::setup_actions::Reach;
use crate::setup_last_run::LastRun;

/// The free space an install needs on the home's volume. Claude's native
/// build is one ~364 MB file, downloaded to `~/.cache/claude/staging` and
/// then written into `versions/` (two copies at the peak, R0 C1); Codex's
/// ~265 MB archive is unpacked beside itself. 1 GiB covers either with room
/// for the old version that stays (Claude keeps every `versions/*`).
pub const NEEDED_FREE_BYTES: u64 = 1024 * 1024 * 1024;

/// What the window may say it has open: at most this many tiles, each label
/// cut to [`MAX_LABEL_CHARS`] (the labels are only echoed back).
pub const MAX_TILES: usize = 64;
pub const MAX_LABEL_CHARS: usize = 80;

/// The line that puts the official installers' folder first on PATH.
pub const PATH_LINE: &str = "export PATH=\"$HOME/.local/bin:$PATH\"";

// ---------------------------------------------------------------- the words of the plan

/// The kinds of step, in the order a plan takes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepKind {
    CloseSessions,
    FixOwnership,
    FixSharedOwnership,
    FixPermissions,
    RemoveBrokenPayload,
    RemoveDanglingLauncher,
    RunInstaller,
    RemoveNpmCopy,
    /// 1.176.1: the folder of a copy that works, added to the Program
    /// folders setting (by Plyloft, through the setting's own save).
    AddProgramFolder,
    /// 1.176.1 (review 1): the setting emptied, so Plyloft follows what the
    /// shell reports — which already holds the working copy's folder.
    EmptyProgramFolders,
    Reread,
    Verify,
}

impl StepKind {
    pub fn wire(self) -> &'static str {
        match self {
            Self::CloseSessions => "close-sessions",
            Self::FixOwnership => "fix-ownership",
            Self::FixSharedOwnership => "fix-shared-ownership",
            Self::FixPermissions => "fix-permissions",
            Self::RemoveBrokenPayload => "remove-broken-payload",
            Self::RemoveDanglingLauncher => "remove-dangling-launcher",
            Self::RunInstaller => "run-installer",
            Self::RemoveNpmCopy => "remove-npm-copy",
            Self::AddProgramFolder => "add-program-folder",
            Self::EmptyProgramFolders => "empty-program-folders",
            Self::Reread => "reread",
            Self::Verify => "verify",
        }
    }

    /// It changes the disk (and so waits for the tool's sessions to close).
    pub fn writes(self) -> bool {
        !matches!(self, Self::CloseSessions | Self::Reread | Self::Verify)
    }

    /// It runs in the visible Setup terminal.
    pub fn in_terminal(self) -> bool {
        matches!(self, Self::FixOwnership | Self::FixSharedOwnership | Self::RunInstaller | Self::RemoveNpmCopy)
    }

    pub fn by(self) -> StepBy {
        match self {
            Self::CloseSessions => StepBy::You,
            k if k.in_terminal() => StepBy::Terminal,
            _ => StepBy::Plyloft,
        }
    }
}

/// Who takes a step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StepBy {
    /// The person (or the window on their word): closing sessions.
    You,
    /// The visible Setup terminal (`setup_run`).
    Terminal,
    /// Plyloft itself, in Rust.
    Plyloft,
}

/// What a step needs from the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Need {
    /// Close (or stop) the listed sessions first.
    CloseSessions,
    /// The person types their Mac password in the terminal (sudo). Plyloft
    /// never asks for it, sees it or keeps it.
    Password,
}

/// Where a session that uses the tool comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionSource {
    /// A tile the window has open (it says so), or a provider tile the
    /// backend recorded.
    Tile,
    AgentRun,
    Swarm,
    /// A card's Chat or Plan exchange, or Intake.
    Chat,
    /// A review, a Challenger, a discussion leg, a reviewer probe.
    Review,
    /// A `codex app-server` (a `codex-chat` tile, a Codex chat lane).
    CodexAppServer,
    /// The hidden Codex update (`commands::codex_update`) is under way.
    CodexUpdate,
    Other,
}

/// One session that uses the tool now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInUse {
    pub source: SessionSource,
    pub id: String,
    /// The window's own label for its tile; a run's agent name, a card id.
    pub label: Option<String>,
    pub pty_id: Option<String>,
}

/// What a step does, with what it needs to say so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StepAction {
    CloseSessions { sessions: Vec<SessionInUse> },
    /// `sudo chown -R -P -- <user> <paths>` in the terminal (macOS's BSD
    /// `/usr/sbin/chown`: with `-R`, `-P` follows no symbolic link, and the
    /// links inside keep their owner; GNU's differs and isn't used). Only for
    /// folders that are only the tool's (`~/.local/share/claude`, the default
    /// `~/.claude` or `~/.codex`, …). `-R` hands over every inode in the tree,
    /// a hard link to a file elsewhere included: before it runs, a regular
    /// file inside with more than one link that isn't the user's refuses the
    /// step (`cli_repair_run::check_hard_links`, then by hand).
    FixOwnership { user: String },
    /// `sudo chown -h -- <user> <paths>`, not recursive: a folder other
    /// programs share (the install folder `~/.local/bin`, `~/.claude.json`)
    /// and the tool's own launcher entries in it, by exact name (`-h`: a
    /// launcher link's own owner, not its target's).
    FixSharedOwnership { user: String },
    /// The owner's bits added (`u+rwx`, a file `u+rw`), one folder at a time,
    /// not recursive; by Plyloft (unix only).
    FixPermissions,
    /// Claude's corrupt `versions/<v>` file removed, so the installer writes
    /// it again.
    RemoveBrokenPayload,
    /// A launcher link in the install folder whose target is gone.
    RemoveDanglingLauncher,
    RunInstaller { channel: InstallChannel },
    /// `npm uninstall -g --prefix <prefix> <package>` with the npm of that
    /// prefix (optional: only when the person ticked it).
    RemoveNpmCopy { prefix: String, package: String },
    /// 1.176.1: `folder` added to the Program folders setting — at the end,
    /// or in front (`front`) when a copy of the tool earlier in the list would
    /// still win. `was`: the setting the plan saw (re-checked when it runs).
    AddProgramFolder { folder: String, front: bool, was: String },
    /// 1.176.1 (review 1): the setting emptied; `was` as above.
    EmptyProgramFolders { was: String },
    /// Plyloft looks for its programs again (`re_probe_and_forget`).
    Reread,
    /// A fresh look: the tool starts, and what a tile runs is the new copy.
    Verify,
}

impl StepAction {
    pub fn kind(&self) -> StepKind {
        match self {
            Self::CloseSessions { .. } => StepKind::CloseSessions,
            Self::FixOwnership { .. } => StepKind::FixOwnership,
            Self::FixSharedOwnership { .. } => StepKind::FixSharedOwnership,
            Self::FixPermissions => StepKind::FixPermissions,
            Self::RemoveBrokenPayload => StepKind::RemoveBrokenPayload,
            Self::RemoveDanglingLauncher => StepKind::RemoveDanglingLauncher,
            Self::RunInstaller { .. } => StepKind::RunInstaller,
            Self::RemoveNpmCopy { .. } => StepKind::RemoveNpmCopy,
            Self::AddProgramFolder { .. } => StepKind::AddProgramFolder,
            Self::EmptyProgramFolders { .. } => StepKind::EmptyProgramFolders,
            Self::Reread => StepKind::Reread,
            Self::Verify => StepKind::Verify,
        }
    }
}

/// One step of the plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    /// Stable while the step stays the same: its kind and a hash of what it
    /// acts on (paths, command, sessions). A step whose paths changed since
    /// the person read the plan has another id, and is refused.
    pub id: String,
    #[serde(flatten)]
    pub action: StepAction,
    pub by: StepBy,
    pub needs: Option<Need>,
    pub optional: bool,
    pub writes: bool,
    /// The command as Details shows it (terminal steps).
    pub command: Option<String>,
    /// The exact paths it acts on.
    pub paths: Vec<String>,
    /// R4 (review 2): this step asks for the password again: it runs in a
    /// terminal of its own after another sudo step, and macOS's sudo
    /// remembers a password per terminal. The window says "you'll be asked
    /// twice" up front.
    pub password_again: bool,
}

impl Step {
    pub fn kind(&self) -> StepKind {
        self.action.kind()
    }
}

/// What is wrong, most important first. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Situation {
    Healthy,
    /// What a tile runs starts and the snapshot points at it; what is left
    /// (another copy, a link off the way) doesn't need a repair.
    HealthyEnough { runs: Option<String> },
    Missing,
    DanglingLauncher { path: String, target: Option<String> },
    BrokenBinary { path: String, failure: StartFailure },
    NotExecutable { path: String },
    StartInconclusive { path: String },
    /// The tool's folders in the home that are someone else's (a `sudo`
    /// install or update).
    FoldersNotOwned { paths: Vec<String> },
    /// Folders that are the user's (or whose owner can't be told) but can't
    /// be written.
    FoldersNotWritable { paths: Vec<String> },
    /// Folders outside the home that can't be written: not the user's to fix.
    SystemFolders { paths: Vec<String> },
    CachedPathStale { cached: Option<String>, now: Option<String> },
    WrongCopyFirst { first: Option<String>, working: String },
    /// The copy that runs works, but the folders its own updater writes
    /// can't be written: it can't be updated (R0's npm prefix of root).
    CannotUpdate { path: String, channel: InstallChannel },
    SeveralCopies { paths: Vec<String> },
    Unreadable { paths: Vec<String> },
    /// The last install or update found a file in use (Windows: an open
    /// Claude or Codex holds its own program).
    FileInUseLastTime { path: Option<String> },
    /// 1.176.0 seams: the PATH set in Settings puts `first` (which doesn't
    /// start) before `working`; tiles run `first`, by design.
    PathOverrideFirst { first: String, working: String },
    /// 1.176.1: the tool works (`copy` starts), but it is in `folder`, which
    /// the Program folders setting doesn't hold, and nothing on that list
    /// starts. `problems`: what is wrong with the setting as written (a file
    /// named, `~`, a variable…); empty when it is only that folder missing.
    OutsideProgramFolders { copy: String, folder: String, problems: Vec<crate::program_folders::Problem> },
    /// 1.176.1 (Windows walk): the copy on the Program folders list doesn't
    /// start there, but does with the folders the shell reports: the list
    /// leaves out what it needs (`needs`: "node" for an npm copy, when it
    /// can be told).
    ProgramFoldersLeaveOutWhatItNeeds { path: String, needs: Option<String> },
    /// 1.176.1 (review 1): the Program folders setting can't work as written
    /// (`problems`) and no working copy was found elsewhere either.
    ProgramFoldersMalformed { problems: Vec<crate::program_folders::Problem> },
}

/// Why an npm copy stays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NpmStay {
    /// Its folders aren't writable: removing it would need an administrator.
    NeedsAdmin,
    /// No npm to remove it with.
    NoNpm,
    /// Its prefix couldn't be told from where it is.
    UnknownPrefix,
}

/// What stays as it is, named so the person knows. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Note {
    NpmCopyStays { path: String, reason: NpmStay },
    /// Ticking "remove the npm copy" would let Plyloft remove it.
    NpmCopyCanBeRemoved { path: String, prefix: String },
    /// A copy of another channel (Homebrew, WinGet, bun, pnpm, the legacy
    /// folder, unknown): never removed.
    OtherCopyStays { path: String, channel: InstallChannel },
    /// Plyloft's tiles and the Terminal still start this copy first (PATH
    /// order); `manual` has the line that changes it.
    OtherCopyFirst { path: String, channel: InstallChannel },
    /// A Terminal window opened before the repair may still start the old
    /// copy until it is opened again.
    TerminalMayPickOld,
    /// R4 (B2): Plyloft runs `plyloft`; a Terminal window starts `terminal`
    /// first (PATH order), which doesn't start. `manual` has the PATH line.
    TerminalRunsOther { terminal: String, plyloft: String, failure: Option<StartFailure> },
    /// R4 (B2): the copy that runs (`runs`) works but can't be updated; the
    /// tool's own copy (`native`) takes the updates. Tiles and the Terminal
    /// keep starting `runs` until the PATH line is added and Look again.
    UpdatesGoToNative { runs: String, native: String },
    /// A folder of the tool Plyloft won't give back or change by itself: a
    /// config folder that is the home, above it or a general folder
    /// (`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`), or one other programs share.
    FolderByHand { path: String },
    /// The Plyloft copy's version file can't be run: its owner bits are added.
    PayloadNotExecutable { path: String },
    /// R4 (review 2, R0 C8): Plyloft runs an npm copy while a native one
    /// exists; that npm copy's own updater (`claude update` from it) may
    /// change the config or remove the native launcher. Removing the npm
    /// copy is the advice.
    NpmUpdaterMayTouchNative { npm: String, native: String },
    /// Windows: folders that can't be written; their permissions are changed
    /// by hand (Properties › Security).
    ByHandOnWindows { paths: Vec<String> },
    /// A folder the installer would create can't be: the folder above it
    /// isn't the user's (or can't be written). Only by hand.
    ParentNotYours { path: String },
    ParentNotWritable { path: String },
    /// The copy's own file is someone else's; its folder takes updates, so
    /// nothing needs doing.
    CopyNotYours { path: String },
    /// A copy that doesn't start but isn't what runs (left as it is on a
    /// machine that works).
    BrokenCopyLeft { path: String },
    /// The installer's folder isn't on the PATH the shell gives.
    InstallDirNotOnPath { dir: String },
    Unreadable { paths: Vec<String> },
    /// 1.176.1 walk: the tool is fine, but the Program folders setting still
    /// leaves out git or gh (`missing`), or can't work as written
    /// (`problems`): said at the end, with the way to the setting.
    ProgramFoldersStillShort { missing: Vec<String>, problems: Vec<crate::program_folders::Problem> },
}

/// Why the plan gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GiveUp {
    /// The step was tried in this repair and its problem is still there.
    StillThereAfter,
    /// What is left can only be done by hand (`manual`).
    OnlyByHand,
    /// A choice (removing the npm copy) would let Plyloft go on.
    NeedsChoice,
    /// R4 (B2): only the PATH order is left (`manual` has the line).
    PathOrder,
    /// 1.176.0 seams: the PATH set in Settings runs a copy that doesn't
    /// start; only the person changes that (Settings), nothing is installed.
    PathOverride,
    /// 1.176.1: the Program folders setting is written in a way that can't
    /// work (a file, `~`, a variable…): only the person corrects it, in
    /// Settings; nothing is installed.
    ProgramFolders,
    /// sudo said this user isn't an administrator of this Mac.
    NeedsAdmin,
    /// sudo didn't accept the password (three tries).
    PasswordRefused,
}

/// What the last run of the tool left (`setup_last_run`), for a plan that
/// gave up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairEvidence {
    pub action_id: String,
    pub outcome: Option<String>,
    pub cause: Option<String>,
    pub cause_path: Option<String>,
    pub exit_code: Option<i32>,
    pub finished_at: Option<String>,
    pub version_before: Option<String>,
    pub version_after: Option<String>,
}

impl RepairEvidence {
    pub fn of(run: &LastRun) -> Self {
        Self {
            action_id: run.action_id.clone(),
            outcome: run.outcome.clone(),
            cause: run.cause.clone(),
            cause_path: run.cause_path.clone(),
            exit_code: run.exit_code,
            finished_at: run.finished_at.clone(),
            version_before: run.version_before.clone(),
            version_after: run.version_after.clone(),
        }
    }
}

/// What stops the plan. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Block {
    /// Healthy (`healthy_enough: false`), or healthy enough.
    NothingToRepair { healthy_enough: bool },
    /// The installer's host can't be reached.
    Offline { proxy: bool, details: Option<String> },
    DiskFull { free_bytes: u64, needed_bytes: u64 },
    /// R4 (M1): a copy that matters didn't answer in time and none failed for
    /// certain: slow is not broken. Try again in a moment; nothing is written.
    NotSureYet { paths: Vec<String> },
    CouldNotRepair { reason: GiveUp, step: Option<StepKind>, evidence: Option<RepairEvidence> },
}

/// What a by-hand command is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManualPurpose {
    Ownership,
    Permissions,
    RemovePayload,
    RemoveLauncher,
    Install,
    RemoveNpmCopy,
    PathOrder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCommand {
    pub purpose: ManualPurpose,
    pub command: String,
}

/// The whole answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    pub tool: CliTool,
    pub situations: Vec<Situation>,
    pub notes: Vec<Note>,
    /// In order. With a block, what Plyloft would do (nothing runs).
    pub steps: Vec<Step>,
    pub block: Option<Block>,
    /// The id `cli_repair_run` accepts now; `None` with a block or when the
    /// person must close sessions first.
    pub next_step: Option<String>,
    /// The same repair done by hand, exact commands.
    pub manual: Vec<ManualCommand>,
    /// R4b: a quick read (`RepairRequest.quick`): no reach check, the short
    /// `--version` bound only, no `nextStep`. Never a plan to run: an install
    /// in it says nothing about the network.
    pub quick: bool,
    /// 1.176.0 seams: the copy Plyloft runs can't be updated by its own
    /// updater (`cli_health::update_folders_writable` is `Some(false)`, the
    /// test Setup's Update refuses by). Diagnostics offers Repair instead of
    /// Update. Filled by `cli_repair_run::gather_as`; false elsewhere.
    pub update_blocked: bool,
}

impl RepairPlan {
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// The installer is part of the plan: its host is worth a check.
    pub fn installs(&self) -> bool {
        self.steps.iter().any(|s| s.kind() == StepKind::RunInstaller)
    }
}

/// Everything the planner knows besides the look. Read by Rust
/// (`cli_repair_run::gather`); only `sessions` carries the window's own
/// (tiles), and only `remove_npm_copy` is the person's choice.
#[derive(Debug, Clone, Default)]
pub struct RepairContext {
    pub windows: bool,
    pub home: Option<String>,
    /// The user name (or uid) a `chown` gives the folders back to.
    pub user: Option<String>,
    /// Tiles the window has open plus the backend's sessions of the tool.
    pub sessions: Vec<SessionInUse>,
    /// Free bytes on the home's volume; `None`: unknown (never a block).
    pub free_bytes: Option<u64>,
    /// The installer's host; `None`: not checked (never a block).
    pub reach: Option<Reach>,
    pub last_run: Option<LastRun>,
    pub remove_npm_copy: bool,
    /// Each npm copy's prefix with the npm that owns it (`<prefix>/bin/npm`,
    /// else the one on PATH).
    pub npms: Vec<(String, String)>,
    /// R4 (review 2): version files a removal didn't confirm broken at its
    /// run (a second probe, `codesign --verify`): never removed; the plan
    /// says "not sure yet" instead.
    pub unconfirmed: Vec<String>,
    /// The step kinds already run in this repair.
    pub attempted: Vec<StepKind>,
    /// R4b: "Reinstall anyway" (`RepairRequest.reinstall`).
    pub reinstall: bool,
    /// 1.176.1: the Program folders setting, when it is set. `None` without.
    pub program_folders: Option<ProgramFoldersCtx>,
}

/// 1.176.1: what the planner knows of the Program folders setting.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProgramFoldersCtx {
    /// The setting as stored (a step binds it, and is refused if it moved).
    pub value: String,
    /// What is wrong with it as written; empty: nothing.
    pub problems: Vec<crate::program_folders::Problem>,
    /// What the login shell reported (`shell_env::shell_reported_path`, with
    /// the installers' folders): where Plyloft looks once the setting is empty.
    pub shell_path: Option<String>,
    /// Of claude, codex, git and gh, what the setting as written doesn't
    /// find (`program_folders::Verdict::missing`).
    pub missing: Vec<String>,
}

// ---------------------------------------------------------------- pure helpers

/// The channel a Repair installs.
pub fn target_channel(tool: CliTool) -> InstallChannel {
    match tool {
        CliTool::Claude => InstallChannel::Native,
        CliTool::Codex => InstallChannel::Standalone,
    }
}

/// npm's package for the tool.
pub fn npm_package(tool: CliTool) -> &'static str {
    match tool {
        CliTool::Claude => "@anthropic-ai/claude-code",
        CliTool::Codex => "@openai/codex",
    }
}

/// `path` is `dir` or inside it (compared as `cli_health::norm` does).
pub fn inside(path: &str, dir: &str, windows: bool) -> bool {
    let (p, d) = (health::norm(path, windows), health::norm(dir, windows));
    p == d || p.starts_with(&format!("{}/", d.trim_end_matches('/')))
}

/// Strictly inside `dir`.
fn below(path: &str, dir: &str, windows: bool) -> bool {
    inside(path, dir, windows) && health::norm(path, windows) != health::norm(dir, windows)
}

fn same(a: &str, b: &str, windows: bool) -> bool {
    health::norm(a, windows) == health::norm(b, windows)
}

/// The copy found at `path` (or that is the same real file).
pub fn copy_of<'a>(h: &'a CliHealth, path: &str, windows: bool) -> Option<&'a CliCopy> {
    h.copies.iter().find(|c| {
        same(&c.path, path, windows)
            || c.also_at.iter().any(|a| same(a, path, windows))
            || c.real_path.as_deref().is_some_and(|r| same(r, path, windows))
    })
}

fn starts(c: &CliCopy) -> bool {
    c.start.as_ref().is_some_and(|s| s.starts)
}

/// Claude's versions folder.
pub fn claude_versions_dir(home: &str, windows: bool) -> String {
    health::join(home, &[".local", "share", "claude", "versions"], windows)
}

/// The prefix an npm copy belongs to: `<prefix>/bin/<name>` on unix (its
/// package in `<prefix>/lib/node_modules`), `<prefix>\<name>.cmd` on Windows
/// (its package in `<prefix>\node_modules`). `None` when the copy's place
/// and its package's don't agree.
pub fn npm_prefix(tool: CliTool, copy: &CliCopy, windows: bool) -> Option<String> {
    let bin = health::parent(&copy.path, windows)?;
    let package = health::npm_package_parent(tool, copy, windows)?;
    let (prefix, modules) = if windows {
        (bin.to_string(), health::join(bin, &["node_modules"], true))
    } else {
        let bin_name = bin.rsplit('/').next().unwrap_or_default();
        if bin_name != "bin" {
            return None;
        }
        let prefix = health::parent(bin, false)?.to_string();
        let modules = health::join(&prefix, &["lib", "node_modules"], false);
        (prefix, modules)
    };
    below(&package, &modules, windows).then_some(prefix)
}

/// The npm copy's own folders as `cli_health` listed them (its bin folder,
/// its package's folder).
fn npm_folders<'a>(h: &'a CliHealth, tool: CliTool, copy: &CliCopy, w: bool) -> Vec<&'a FolderCheck> {
    let bin = health::parent(&copy.path, w).map(str::to_string);
    let package = health::npm_package_parent(tool, copy, w);
    h.folders
        .iter()
        .filter(|f| f.role == FolderRole::Copy && f.channel == InstallChannel::Npm)
        .filter(|f| [bin.as_deref(), package.as_deref()].into_iter().flatten().any(|p| same(&f.path, p, w)))
        .collect()
}

/// A folder changes hands or bits without a password: writable, and not
/// another account's.
fn takes_writes(f: &FolderCheck) -> bool {
    f.writable && f.owned_by_user != Some(false)
}

/// Single-quoted for a POSIX shell when it needs it.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+:@%~".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// PowerShell's quoting.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// FNV-1a, 32 bits: a step id's stable hash (not a security property: the
/// step is re-derived and re-checked when it runs).
fn fnv32(parts: &[&str]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for part in parts {
        for byte in part.bytes().chain(std::iter::once(0u8)) {
            hash ^= byte as u32;
            hash = hash.wrapping_mul(0x0100_0193);
        }
    }
    hash
}

fn step(action: StepAction, command: Option<String>, paths: Vec<String>, optional: bool) -> Step {
    let kind = action.kind();
    let mut parts: Vec<String> = paths.clone();
    parts.extend(command.clone());
    match &action {
        StepAction::CloseSessions { sessions } => parts.extend(sessions.iter().map(|s| s.id.clone())),
        StepAction::FixOwnership { user } | StepAction::FixSharedOwnership { user } => parts.push(user.clone()),
        StepAction::RemoveNpmCopy { prefix, package } => parts.extend([prefix.clone(), package.clone()]),
        StepAction::RunInstaller { channel } => parts.push(format!("{channel:?}")),
        StepAction::AddProgramFolder { folder, front, was } => parts.extend([folder.clone(), front.to_string(), was.clone()]),
        StepAction::EmptyProgramFolders { was } => parts.push(was.clone()),
        _ => {}
    }
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    Step {
        id: format!("{}-{:08x}", kind.wire(), fnv32(&refs)),
        needs: match kind {
            StepKind::CloseSessions => Some(Need::CloseSessions),
            StepKind::FixOwnership | StepKind::FixSharedOwnership => Some(Need::Password),
            _ => None,
        },
        by: kind.by(),
        writes: kind.writes(),
        optional,
        command,
        paths,
        action,
        password_again: false,
    }
}

/// Remove paths that another one in the list already covers (`chown -R`).
fn outermost(mut paths: Vec<String>, w: bool) -> Vec<String> {
    paths.sort_by_key(|p| health::norm(p, w).len());
    let mut kept: Vec<String> = Vec::new();
    for p in paths {
        if !kept.iter().any(|k| inside(&p, k, w)) {
            kept.push(p);
        }
    }
    kept
}

fn push_unique(list: &mut Vec<String>, path: &str, w: bool) {
    if !list.iter().any(|p| same(p, path, w)) {
        list.push(path.to_string());
    }
}

/// The `sudo chown -R` argv tail and display for these folders (validated
/// again by `cli_repair_run` before it runs).
pub fn chown_display(user: &str, paths: &[String]) -> String {
    let quoted: Vec<String> = paths.iter().map(|p| sh_quote(p)).collect();
    format!("sudo chown -R -P -- {} {}", sh_quote(user), quoted.join(" "))
}

pub fn npm_display(npm: &str, prefix: &str, package: &str, windows: bool) -> String {
    let q = |s: &str| if windows { ps_quote(s) } else { sh_quote(s) };
    let program = if windows { "npm".to_string() } else { q(npm) };
    format!("{program} uninstall -g --prefix {} {package}", q(prefix))
}

/// `sudo chown -h -- <user> <paths>`: not recursive, a link changed itself.
pub fn chown_shared_display(user: &str, paths: &[String]) -> String {
    let quoted: Vec<String> = paths.iter().map(|p| sh_quote(p)).collect();
    format!("sudo chown -h -- {} {}", sh_quote(user), quoted.join(" "))
}

/// B1: a user `chown` may give folders to: never root, never empty.
pub fn user_may_own(user: &str) -> bool {
    !user.is_empty() && user != "root" && user != "0"
}

/// The names a folder that is only the tool's ends with.
fn own_names(tool: CliTool) -> [&'static str; 2] {
    match tool {
        CliTool::Claude => [".claude", "claude"],
        CliTool::Codex => [".codex", "codex"],
    }
}

fn last_name(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_ascii_lowercase()
}

/// B1: the folders that are only the tool's, so `chown -R` may take them
/// whole: Claude's `~/.local/share/claude`, `~/.local/state/claude`,
/// `~/.cache/claude`, and the config home at its default place
/// (`~/.claude`, `~/.codex`) when the look listed it.
pub fn own_roots(h: &CliHealth, home: Option<&str>, w: bool) -> Vec<String> {
    let Some(home) = home else { return Vec::new() };
    let mut roots: Vec<String> = Vec::new();
    if h.tool == CliTool::Claude {
        for parts in [&[".local", "share", "claude"][..], &[".local", "state", "claude"], &[".cache", "claude"]] {
            roots.push(health::join(home, parts, w));
        }
    }
    // Review 2: only the config home at its default place; one moved by
    // `$CLAUDE_CONFIG_DIR`/`$CODEX_HOME` (`~/work/codex`) is by hand.
    let default = health::join(home, &[own_names(h.tool)[0]], w);
    for f in h.folders.iter().filter(|f| f.role == FolderRole::Config && f.kind == health::FolderKind::Dir) {
        if same(&f.path, &default, w) {
            roots.push(f.path.clone());
        }
    }
    roots
}

/// B1: how far a folder of the tool may be handed back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// Only the tool's: `chown -R`.
    Own,
    /// Shared with other programs (the install folder, `.claude.json`):
    /// the folder itself only, and the tool's own entries by name.
    Shared,
    /// A general folder (a config folder that isn't named for the tool):
    /// by hand only.
    Broad,
}

pub fn place_of(f: &FolderCheck, h: &CliHealth, home: Option<&str>, roots: &[String], w: bool) -> Place {
    if roots.iter().any(|r| inside(&f.path, r, w)) {
        return Place::Own;
    }
    let install = h.install_dir.as_deref().is_some_and(|d| same(&f.path, d, w));
    let state_file = f.kind == health::FolderKind::File
        && last_name(&f.path) == ".claude.json"
        && health::parent(&f.path, w).is_some_and(|p| home.is_some_and(|h| same(p, h, w)) || roots.iter().any(|r| same(p, r, w)));
    if install || state_file {
        Place::Shared
    } else {
        Place::Broad
    }
}

/// R9: a native copy's version file as a path in the versions folder of the
/// home as the look spells it. The link's textual end comes first: the real
/// path is canonical, and a home reached through a link (`~/ply-build` →
/// `/Volumes/…`, found by the sandbox run) spells it otherwise.
fn payload_in(c: &CliCopy, versions: &str, w: bool) -> Option<String> {
    [c.link_end.as_deref(), c.real_path.as_deref(), Some(c.path.as_str())]
        .into_iter()
        .flatten()
        .find(|p| health::parent(p, w).is_some_and(|d| same(d, versions, w)))
        .map(str::to_string)
}

/// M1: copies that matter didn't answer in time and none failed for certain.
fn not_sure_yet(h: &CliHealth, runs: Option<&CliCopy>, w: bool) -> Option<Vec<String>> {
    let matters: Vec<&CliCopy> = h
        .copies
        .iter()
        .filter(|c| c.path_rank.is_some() || c.in_install_dir || runs.is_some_and(|r| same(&r.path, &c.path, w)))
        .collect();
    let slow: Vec<String> = matters
        .iter()
        .filter(|c| c.start.as_ref().is_some_and(|s| s.inconclusive))
        .map(|c| c.path.clone())
        .collect();
    let certain = matters.iter().any(|c| health::fails_for_certain(c) || c.dangling);
    (!slow.is_empty() && !certain).then_some(slow)
}

// ---------------------------------------------------------------- the planner

/// What to do about `h` (one fresh look) on the machine `ctx` describes.
pub fn plan(h: &CliHealth, ctx: &RepairContext) -> RepairPlan {
    let w = ctx.windows;
    let tool = h.tool;
    let target = target_channel(tool);
    let mut situations: Vec<Situation> = Vec::new();
    let mut notes: Vec<Note> = Vec::new();
    let mut manual: Vec<ManualCommand> = Vec::new();
    let mut steps: Vec<Step> = Vec::new();

    let runs = h.runs_today.as_deref().and_then(|p| copy_of(h, p, w));
    let runs_starts = runs.is_some_and(starts);
    let cached_ok = h.cached.as_ref().is_none_or(|c| c.usable && c.matches_now);
    let needed_ok = h.folders.iter().filter(|f| f.needed_now).all(|f| f.writable);
    let native_ok = h.copies.iter().any(|c| c.channel == target && starts(c));
    let real_copies: Vec<&CliCopy> = h.copies.iter().filter(|c| !c.dangling).collect();

    diagnose(h, ctx, runs, &mut situations, &mut notes);

    if let Some(done) = outside_program_folders(h, ctx, runs_starts, &mut situations, &mut notes) {
        return done;
    }
    // 1.176.1 walk: never "repaired" in silence while the same setting still
    // breaks other things.
    if let Some(pf) = ctx.program_folders.as_ref() {
        let missing: Vec<String> = pf.missing.iter().filter(|m| *m == "git" || *m == "gh").cloned().collect();
        if !missing.is_empty() || !pf.problems.is_empty() {
            notes.push(Note::ProgramFoldersStillShort { missing, problems: pf.problems.clone() });
        }
    }

    // 1.176.0 seams: the PATH override set in Settings runs a copy that
    // doesn't start, while a later one would. Tiles keep running it (an
    // override is never second-guessed), so no reread or install here can
    // change what they run: the plan ends by hand, naming the override.
    if let Some(p) = h.passed_over.as_ref().filter(|p| p.kept_by_override && !runs_starts) {
        situations.retain(|s| !matches!(s, Situation::CachedPathStale { .. } | Situation::WrongCopyFirst { .. }));
        situations.insert(0, Situation::PathOverrideFirst { first: p.path.clone(), working: p.instead.clone() });
        return RepairPlan {
            tool,
            situations,
            notes,
            steps,
            block: Some(Block::CouldNotRepair { reason: GiveUp::PathOverride, step: None, evidence: None }),
            next_step: None,
            manual,
            quick: false,
            update_blocked: false,
        };
    }

    // R4b: "Reinstall anyway" adds the official installer, even on a
    // healthy machine, until it has been run once in this repair (then the
    // ordinary plan takes over, so the repair ends). It removes nothing.
    let reinstall = ctx.reinstall && !ctx.attempted.contains(&StepKind::RunInstaller);
    if h.healthy && !reinstall {
        return RepairPlan {
            tool,
            situations: vec![Situation::Healthy],
            notes,
            steps,
            block: Some(Block::NothingToRepair { healthy_enough: false }),
            next_step: None,
            manual,
            quick: false,
            update_blocked: false,
        };
    }
    if h.healthy {
        situations.insert(0, Situation::Healthy);
    }

    // The npm copies, and whether one may go.
    let mut npm_removals: Vec<(String, String, String)> = Vec::new(); // (copy path, prefix, npm)
    let mut npm_removable_any = false;
    for copy in real_copies.iter().filter(|c| c.channel == InstallChannel::Npm) {
        let prefix = npm_prefix(tool, copy, w);
        let folders = npm_folders(h, tool, copy, w);
        let writable = !folders.is_empty() && folders.iter().all(|f| takes_writes(f));
        let npm = prefix
            .as_deref()
            .and_then(|p| ctx.npms.iter().find(|(q, _)| same(q, p, w)).map(|(_, n)| n.as_str()));
        match (prefix.clone(), writable, npm) {
            (None, _, _) => notes.push(Note::NpmCopyStays { path: copy.path.clone(), reason: NpmStay::UnknownPrefix }),
            (Some(_), false, _) => notes.push(Note::NpmCopyStays { path: copy.path.clone(), reason: NpmStay::NeedsAdmin }),
            (Some(_), true, None) => notes.push(Note::NpmCopyStays { path: copy.path.clone(), reason: NpmStay::NoNpm }),
            (Some(prefix), true, Some(npm)) => {
                npm_removable_any = true;
                manual.push(ManualCommand {
                    purpose: ManualPurpose::RemoveNpmCopy,
                    command: npm_display(npm, &prefix, npm_package(tool), w),
                });
                if ctx.remove_npm_copy {
                    npm_removals.push((copy.path.clone(), prefix, npm.to_string()));
                } else {
                    notes.push(Note::NpmCopyCanBeRemoved { path: copy.path.clone(), prefix });
                }
            }
        }
    }

    // The copy that runs stays when it starts and can update itself; the
    // person's tick (remove the npm copy) asks for the tool's own install.
    let keep_current = runs_starts && needed_ok && !(ctx.remove_npm_copy && !npm_removals.is_empty());
    let needs_install = !keep_current && !native_ok;
    let installs = needs_install || reinstall;

    // The tool's own folders an install writes (or the running copy needs).
    let home = ctx.home.as_deref();
    let roots = own_roots(h, home, w);
    let mut chown: Vec<String> = Vec::new();
    let mut shared: Vec<String> = Vec::new();
    let mut chmod: Vec<String> = Vec::new();
    let mut by_hand: Vec<String> = Vec::new();
    let mut installer_blocked = false;
    for f in h.folders.iter().filter(|f| {
        f.channel == target && matches!(f.role, FolderRole::InstallTarget | FolderRole::Config)
    }) {
        // The config home is needed by any copy; the install folders by the
        // tool's own copy when it runs, or by the installer.
        if !(installs || f.needed_now) {
            continue;
        }
        let not_owned = f.owned_by_user == Some(false);
        if f.writable && !not_owned {
            continue;
        }
        let in_home = home.is_some_and(|h| below(&f.path, h, w));
        if f.system_folder {
            continue; // named in the situations
        }
        let place = place_of(f, h, home, &roots, w);
        if !in_home || place == Place::Broad {
            // A config folder that is the home or above it, or a general one.
            notes.push(Note::FolderByHand { path: f.path.clone() });
            installer_blocked = true;
            continue;
        }
        if !f.exists {
            let parent = f.checked.clone().unwrap_or_else(|| f.path.clone());
            if !home.is_some_and(|h| below(&parent, h, w)) {
                installer_blocked |= f.role == FolderRole::InstallTarget;
                continue;
            }
            if not_owned {
                notes.push(Note::ParentNotYours { path: parent.clone() });
                if !w {
                    manual.push(ManualCommand {
                        purpose: ManualPurpose::Ownership,
                        command: format!("sudo chown -h -- {} {}", sh_quote(ctx.user.as_deref().unwrap_or("$USER")), sh_quote(&parent)),
                    });
                }
            } else {
                notes.push(Note::ParentNotWritable { path: parent.clone() });
                if !w {
                    manual.push(ManualCommand { purpose: ManualPurpose::Permissions, command: format!("chmod u+rwx {}", sh_quote(&parent)) });
                }
            }
            installer_blocked = true;
            continue;
        }
        match (w, f.owned_by_user) {
            (true, _) | (false, None) => {
                push_unique(&mut by_hand, &f.path, w);
                installer_blocked |= f.role == FolderRole::InstallTarget;
            }
            (false, Some(false)) if place == Place::Own => push_unique(&mut chown, &f.path, w),
            (false, Some(false)) => push_unique(&mut shared, &f.path, w),
            (false, Some(true)) => push_unique(&mut chmod, &f.path, w),
        }
    }
    let chown = outermost(chown, w);
    // The tool's own launcher entries in a shared folder handed back, by name.
    if let Some(dir) = h.install_dir.as_deref().filter(|d| shared.iter().any(|s| same(s, d, w))) {
        for c in h.copies.iter().filter(|c| c.channel == target) {
            if health::parent(&c.path, w).is_some_and(|p| same(p, dir, w)) {
                push_unique(&mut shared, &c.path, w);
            }
        }
    }
    // A folder chown takes over may still be read-only after it: the next
    // look says so, and fix-permissions follows then.
    chmod.retain(|p| !chown.iter().any(|c| inside(p, c, w)) && !shared.iter().any(|c| same(p, c, w)));
    if !by_hand.is_empty() {
        notes.push(Note::ByHandOnWindows { paths: by_hand.clone() });
    }

    // Claude's version file that can't be run (its mode, not its content):
    // the owner's bits, never a deletion.
    if tool == CliTool::Claude && needs_install && !w {
        if let Some(versions) = home.map(|h| claude_versions_dir(h, w)) {
            for c in h.copies.iter().filter(|c| c.channel == InstallChannel::Native && !c.executable) {
                if c.real_path.is_none() {
                    continue;
                }
                let Some(real) = payload_in(c, &versions, w) else { continue };
                if c.owned_by_user == Some(true) {
                    notes.push(Note::PayloadNotExecutable { path: real.clone() });
                    push_unique(&mut chmod, &real, w);
                }
            }
        }
    }

    let user = ctx.user.clone().filter(|u| user_may_own(u));
    if !chown.is_empty() || !shared.is_empty() {
        match user.as_deref() {
            Some(user) => {
                if !chown.is_empty() {
                    let display = chown_display(user, &chown);
                    manual.push(ManualCommand { purpose: ManualPurpose::Ownership, command: display.clone() });
                    steps.push(step(StepAction::FixOwnership { user: user.to_string() }, Some(display), chown.clone(), false));
                }
                if !shared.is_empty() {
                    let display = chown_shared_display(user, &shared);
                    manual.push(ManualCommand { purpose: ManualPurpose::Ownership, command: display.clone() });
                    steps.push(step(
                        StepAction::FixSharedOwnership { user: user.to_string() },
                        Some(display),
                        shared.clone(),
                        false,
                    ));
                }
            }
            None => installer_blocked = true,
        }
    }
    if !chmod.is_empty() {
        for p in &chmod {
            manual.push(ManualCommand { purpose: ManualPurpose::Permissions, command: format!("chmod u+rwx {}", sh_quote(p)) });
        }
        steps.push(step(StepAction::FixPermissions, None, chmod.clone(), false));
    }

    // Claude's corrupt version file, and dangling launchers in the install
    // folder, go before the installer.
    if needs_install {
        let mut payloads: Vec<String> = Vec::new();
        if tool == CliTool::Claude {
            if let Some(versions) = home.map(|h| claude_versions_dir(h, w)) {
                for c in h.copies.iter().filter(|c| c.channel == InstallChannel::Native) {
                    if c.real_path.is_none() {
                        continue;
                    }
                    let Some(real) = payload_in(c, &versions, w) else { continue };
                    // M2: only a binary the system refused or killed at start
                    // (R0 C4). A run that printed no version, or a spawn
                    // refused for want of memory or a busy file, may be an
                    // intact binary.
                    let broken = c.start.as_ref().is_some_and(|s| !s.starts && s.failure == Some(StartFailure::BadBinary));
                    if broken {
                        push_unique(&mut payloads, &real, w);
                    }
                }
            }
        }
        if !payloads.is_empty() {
            for p in &payloads {
                manual.push(ManualCommand { purpose: ManualPurpose::RemovePayload, command: remove_command(p, w) });
            }
            steps.push(step(StepAction::RemoveBrokenPayload, None, payloads, false));
        }
        let mut launchers: Vec<String> = Vec::new();
        if let Some(dir) = h.install_dir.as_deref() {
            for c in h.copies.iter().filter(|c| c.dangling && c.channel == target) {
                if health::parent(&c.path, w).is_some_and(|p| same(p, dir, w)) {
                    push_unique(&mut launchers, &c.path, w);
                }
            }
        }
        if !launchers.is_empty() {
            for p in &launchers {
                manual.push(ManualCommand { purpose: ManualPurpose::RemoveLauncher, command: remove_command(p, w) });
            }
            steps.push(step(StepAction::RemoveDanglingLauncher, None, launchers, false));
        }
    }
    if installs {
        if let Some(cmd) = crate::doctor::install_cmd_on(tool.program(), w) {
            manual.push(ManualCommand { purpose: ManualPurpose::Install, command: cmd.to_string() });
            steps.push(step(StepAction::RunInstaller { channel: target }, Some(cmd.to_string()), Vec::new(), false));
        }
    }

    // The ticked npm copy goes once the tool's own copy works (or is about
    // to be installed: the plan runs again before this step comes up).
    if native_ok || installs {
        for (path, prefix, npm) in &npm_removals {
            let package = npm_package(tool).to_string();
            let display = npm_display(npm, prefix, &package, w);
            steps.push(step(
                StepAction::RemoveNpmCopy { prefix: prefix.clone(), package },
                Some(display),
                vec![path.clone()],
                true,
            ));
        }
    }

    // What still runs first after the repair, when it isn't the tool's own.
    let removed = |path: &str| npm_removals.iter().any(|(p, _, _)| same(p, path, w));
    if let Some(r) = runs.filter(|r| r.channel != target && !removed(&r.path)) {
        if native_ok || installs {
            notes.push(Note::OtherCopyFirst { path: r.path.clone(), channel: r.channel });
            if !w {
                manual.push(ManualCommand { purpose: ManualPurpose::PathOrder, command: PATH_LINE.to_string() });
            }
        }
    }
    // B2: the copy a Terminal starts first (lowest PATH rank), when it isn't
    // what Plyloft runs and it doesn't start.
    let terminal = h
        .copies
        .iter()
        .filter(|c| c.path_rank.is_some() && c.executable)
        .min_by_key(|c| c.path_rank);
    if let (Some(t), Some(r)) = (terminal, runs) {
        if !same(&t.path, &r.path, w) && health::fails_for_certain(t) && starts(r) && !removed(&t.path) {
            notes.push(Note::TerminalRunsOther {
                terminal: t.path.clone(),
                plyloft: r.path.clone(),
                failure: t.start.as_ref().and_then(|s| s.failure),
            });
            if !w {
                manual.push(ManualCommand { purpose: ManualPurpose::PathOrder, command: PATH_LINE.to_string() });
            }
        }
    }
    // B2: a working copy that can't update itself, beside a working copy of
    // the tool's own: only the PATH order is left.
    let path_order = runs.filter(|r| {
        r.channel != target
            && starts(r)
            && native_ok
            && !removed(&r.path)
            && h.folders.iter().any(|f| f.needed_now && f.channel == r.channel && !f.writable)
    });
    if let Some(r) = path_order {
        let native = h.copies.iter().find(|c| c.channel == target && starts(c)).map(|c| c.path.clone()).unwrap_or_default();
        if r.channel == InstallChannel::Npm {
            notes.push(Note::NpmUpdaterMayTouchNative { npm: r.path.clone(), native: native.clone() });
        }
        notes.push(Note::UpdatesGoToNative { runs: r.path.clone(), native });
    }
    if real_copies.len() > 1 {
        for c in real_copies.iter().filter(|c| {
            !matches!(c.channel, InstallChannel::Npm) && c.channel != target
        }) {
            notes.push(Note::OtherCopyStays { path: c.path.clone(), channel: c.channel });
        }
    }
    if !needs_install {
        for c in h.copies.iter().filter(|c| {
            c.start.as_ref().is_some_and(|s| !s.starts && !s.inconclusive)
                && runs.is_none_or(|r| !same(&r.path, &c.path, w))
        }) {
            notes.push(Note::BrokenCopyLeft { path: c.path.clone() });
        }
    }

    let writes = steps.iter().any(|s| s.writes);
    let stale = h.cached.as_ref().is_some_and(|c| !(c.usable && c.matches_now));
    if writes || stale {
        steps.push(step(StepAction::Reread, None, Vec::new(), false));
    }
    if !steps.is_empty() {
        steps.push(step(StepAction::Verify, None, Vec::new(), false));
        if writes {
            notes.push(Note::TerminalMayPickOld);
        }
    }
    if writes && !ctx.sessions.is_empty() {
        steps.insert(0, step(StepAction::CloseSessions { sessions: ctx.sessions.clone() }, None, Vec::new(), false));
    }

    // One terminal per sudo step: the second one asks again.
    if steps.iter().any(|s| s.kind() == StepKind::FixOwnership) {
        for st in steps.iter_mut().filter(|s| s.kind() == StepKind::FixSharedOwnership) {
            st.password_again = true;
        }
    }
    let unconfirmed: Vec<String> = steps
        .iter()
        .filter(|s| s.kind() == StepKind::RemoveBrokenPayload)
        .flat_map(|s| s.paths.iter())
        .filter(|p| ctx.unconfirmed.iter().any(|u| same(u, p, w)))
        .cloned()
        .collect();
    // R4b: under "Reinstall anyway", a copy of the tool's own channel that
    // didn't answer in time is the one the installer replaces: that alone
    // is no reason to wait. Any other slow copy still is.
    let slow = not_sure_yet(h, runs, w).filter(|paths| {
        !(reinstall
            && paths.iter().all(|p| copy_of(h, p, w).is_some_and(|c| c.channel == target)))
    });
    let not_sure = slow.or_else(|| (!unconfirmed.is_empty()).then_some(unconfirmed));
    let block = match not_sure {
        Some(paths) => {
            steps.clear();
            Some(Block::NotSureYet { paths })
        }
        None => decide_block(ctx, &steps, runs_starts && cached_ok, npm_removable_any, installer_blocked, path_order.is_some()),
    };
    if matches!(block, Some(Block::NothingToRepair { healthy_enough: true })) {
        situations.insert(0, Situation::HealthyEnough { runs: h.runs_today.clone() });
    }
    let next_step = match (&block, steps.first()) {
        (None, Some(first)) if first.kind() != StepKind::CloseSessions => Some(first.id.clone()),
        _ => None,
    };
    RepairPlan { tool, situations, notes, steps, block, next_step, manual, quick: false, update_blocked: false }
}

/// 1.176.1: the Program folders setting is where the trouble is — the owner's
/// MacBook: `~/.local/bin/claude` in the setting, Claude fine in
/// `~/.local/bin`. An install runs with the same list and can't help, so the
/// setting goes first, whatever the copies (review 1):
///
/// - written so it can't work (a file, `~`, a variable…): when the working
///   copy's folder is among what the shell reports, one optional step empties
///   the setting (Plyloft then follows the shell); otherwise the person
///   corrects it in Settings. No install while it stays malformed.
/// - well-formed, the tool working outside it: one optional step adds that
///   folder, at the end, or in front when a broken copy earlier in the list
///   would still win.
fn outside_program_folders(
    h: &CliHealth,
    ctx: &RepairContext,
    runs_starts: bool,
    situations: &mut Vec<Situation>,
    notes: &mut Vec<Note>,
) -> Option<RepairPlan> {
    let pf = ctx.program_folders.as_ref()?;
    let w = ctx.windows;
    let on_list_starts = h.copies.iter().any(|c| c.path_rank.is_some() && starts(c));
    let malformed = !pf.problems.is_empty();
    if h.healthy || runs_starts || on_list_starts {
        return None;
    }
    let tool = h.tool;
    // 1.176.1 (Windows walk): a copy on the list that starts with the
    // shell's folders: the list leaves out what it needs. Emptying the
    // setting is the step; never an install.
    if let Some(c) = h.copies.iter().find(|c| c.path_rank.is_some() && c.starts_with_shell == Some(true)) {
        let needs = (c.channel == InstallChannel::Npm
            || c.start.as_ref().and_then(|s| s.tail.as_deref()).is_some_and(|t| t.to_ascii_lowercase().contains("node")))
        .then(|| "node".to_string());
        let path = c.path.clone();
        situations.retain(|s| !matches!(s, Situation::BrokenBinary { path: p, .. } if same(p, &path, w)));
        situations.retain(|s| !matches!(s, Situation::Missing | Situation::CachedPathStale { .. } | Situation::WrongCopyFirst { .. }));
        situations.insert(0, Situation::ProgramFoldersLeaveOutWhatItNeeds { path, needs });
        notes.retain(|n| !matches!(n, Note::InstallDirNotOnPath { .. }));
        let empty = step(StepAction::EmptyProgramFolders { was: pf.value.clone() }, None, Vec::new(), true);
        let block = ctx.attempted.contains(&StepKind::EmptyProgramFolders).then_some(Block::CouldNotRepair {
            reason: GiveUp::StillThereAfter,
            step: Some(StepKind::EmptyProgramFolders),
            evidence: None,
        });
        let next_step = block.is_none().then(|| empty.id.clone());
        return Some(RepairPlan {
            tool,
            situations: std::mem::take(situations),
            notes: std::mem::take(notes),
            steps: vec![empty, step(StepAction::Verify, None, Vec::new(), false)],
            block,
            next_step,
            manual: Vec::new(),
            quick: false,
            update_blocked: false,
        });
    }
    // An outside copy that couldn't be asked as it would run (the shell's
    // folders unknown): not sure yet — never an install meanwhile.
    let unsure: Vec<String> = h
        .copies
        .iter()
        .filter(|c| c.path_rank.is_none() && c.start.as_ref().is_some_and(|s| s.inconclusive))
        .map(|c| c.path.clone())
        .collect();
    let copy = h.copies.iter().find(|c| c.path_rank.is_none() && starts(c));
    if copy.is_none() && !unsure.is_empty() {
        return Some(RepairPlan {
            tool,
            situations: std::mem::take(situations),
            notes: std::mem::take(notes),
            steps: Vec::new(),
            block: Some(Block::NotSureYet { paths: unsure }),
            next_step: None,
            manual: Vec::new(),
            quick: false,
            update_blocked: false,
        });
    }
    if copy.is_none() && !malformed {
        return None; // the ordinary plan (an install); its next look comes back here
    }
    let folder = copy.and_then(|c| health::parent(&c.path, w)).map(str::to_string);
    situations.retain(|s| !matches!(s, Situation::CachedPathStale { .. } | Situation::WrongCopyFirst { .. } | Situation::Missing));
    situations.insert(
        0,
        match (copy, folder.clone()) {
            (Some(c), Some(f)) => Situation::OutsideProgramFolders { copy: c.path.clone(), folder: f, problems: pf.problems.clone() },
            _ => Situation::ProgramFoldersMalformed { problems: pf.problems.clone() },
        },
    );
    // Said against the setting, not a Terminal's PATH: not this case's.
    notes.retain(|n| !matches!(n, Note::InstallDirNotOnPath { .. }));
    let ends = |steps: Vec<Step>, block: Option<Block>, situations: &mut Vec<Situation>, notes: &mut Vec<Note>| {
        let next_step = if block.is_none() { steps.first().map(|s| s.id.clone()) } else { None };
        RepairPlan {
            tool,
            situations: std::mem::take(situations),
            notes: std::mem::take(notes),
            steps,
            block,
            next_step,
            manual: Vec::new(),
            quick: false,
            update_blocked: false,
        }
    };
    let tried = |kind: StepKind| {
        ctx.attempted.contains(&kind).then_some(Block::CouldNotRepair { reason: GiveUp::StillThereAfter, step: Some(kind), evidence: None })
    };
    let verify = || step(StepAction::Verify, None, Vec::new(), false);
    // Emptying the setting makes the tool found when its folder is among what
    // the shell reports (the row's own test for "Empty it" first).
    let in_shell = folder.as_deref().is_some_and(|f| {
        pf.shell_path.as_deref().is_some_and(|p| health::split_path(p, w).iter().any(|(_, d)| same(d, f, w)))
    });
    let empty_step = || step(StepAction::EmptyProgramFolders { was: pf.value.clone() }, None, Vec::new(), true);
    if malformed {
        if !in_shell {
            let give_up = Block::CouldNotRepair { reason: GiveUp::ProgramFolders, step: None, evidence: None };
            return Some(ends(Vec::new(), Some(give_up), situations, notes));
        }
        return Some(ends(vec![empty_step(), verify()], tried(StepKind::EmptyProgramFolders), situations, notes));
    }
    let (Some(_), Some(folder)) = (copy, folder) else { return None };
    // 1.176.1 walk: a well-formed list that misses the tool — emptying it
    // (the shell reports the folder) brings back git and gh too; adding the
    // folder is the way only when the shell doesn't report it.
    if in_shell {
        return Some(ends(vec![empty_step(), verify()], tried(StepKind::EmptyProgramFolders), situations, notes));
    }
    // A copy of the tool on the list (one that doesn't start) would still
    // come first if the folder went at the end.
    let front = h.copies.iter().any(|c| c.path_rank.is_some() && !c.dangling);
    let add = step(
        StepAction::AddProgramFolder { folder: folder.clone(), front, was: pf.value.clone() },
        None,
        vec![folder],
        true,
    );
    Some(ends(vec![add, verify()], tried(StepKind::AddProgramFolder), situations, notes))
}

fn remove_command(path: &str, windows: bool) -> String {
    if windows {
        format!("Remove-Item -LiteralPath {}", ps_quote(path))
    } else {
        format!("rm {}", sh_quote(path))
    }
}

fn decide_block(
    ctx: &RepairContext,
    steps: &[Step],
    works_now: bool,
    npm_removable: bool,
    installer_blocked: bool,
    path_order: bool,
) -> Option<Block> {
    let first = steps.iter().find(|s| s.kind() != StepKind::CloseSessions);
    let Some(first) = first else {
        return Some(if path_order {
            Block::CouldNotRepair { reason: GiveUp::PathOrder, step: None, evidence: None }
        } else if works_now {
            Block::NothingToRepair { healthy_enough: true }
        } else {
            Block::CouldNotRepair {
                reason: if npm_removable && !ctx.remove_npm_copy { GiveUp::NeedsChoice } else { GiveUp::OnlyByHand },
                step: None,
                evidence: None,
            }
        });
    };
    // The loop guard: the next step was already run in this repair, and a
    // fresh look still asks for it.
    if ctx.attempted.contains(&first.kind()) {
        let evidence = first
            .kind()
            .in_terminal()
            .then(|| ctx.last_run.as_ref().map(RepairEvidence::of))
            .flatten();
        // A chown sudo refused says why: not an administrator, or the
        // password wasn't accepted — not "still there".
        let sudo = matches!(first.kind(), StepKind::FixOwnership | StepKind::FixSharedOwnership);
        let reason = match evidence.as_ref().and_then(|e| e.cause.as_deref()) {
            Some("not-admin") if sudo => GiveUp::NeedsAdmin,
            Some("password-refused") if sudo => GiveUp::PasswordRefused,
            _ => GiveUp::StillThereAfter,
        };
        return Some(Block::CouldNotRepair { reason, step: Some(first.kind()), evidence });
    }
    let installs = steps.iter().any(|s| s.kind() == StepKind::RunInstaller);
    if installs && installer_blocked {
        return Some(Block::CouldNotRepair { reason: GiveUp::OnlyByHand, step: Some(StepKind::RunInstaller), evidence: None });
    }
    if installs {
        if let Some(reach) = ctx.reach.as_ref().filter(|r| !r.reachable) {
            return Some(Block::Offline { proxy: reach.proxy, details: reach.details.clone() });
        }
        if let Some(free) = ctx.free_bytes.filter(|&f| f < NEEDED_FREE_BYTES) {
            return Some(Block::DiskFull { free_bytes: free, needed_bytes: NEEDED_FREE_BYTES });
        }
    }
    None
}

/// The situations, from the look's findings and the last run.
fn diagnose(h: &CliHealth, ctx: &RepairContext, runs: Option<&CliCopy>, out: &mut Vec<Situation>, notes: &mut Vec<Note>) {
    let w = ctx.windows;
    let mut not_owned: Vec<String> = Vec::new();
    for f in &h.findings {
        match f {
            Finding::Missing => out.push(Situation::Missing),
            Finding::NoWorkingCopy => {}
            Finding::CachedPathStale { cached, now, .. } => {
                out.push(Situation::CachedPathStale { cached: cached.clone(), now: now.clone() })
            }
            Finding::FirstOnPathIsNotTheWorkingOne { first, working, .. } => {
                out.push(Situation::WrongCopyFirst { first: first.clone(), working: working.clone() })
            }
            Finding::DoesNotStart { path, failure, .. } => {
                out.push(Situation::BrokenBinary { path: path.clone(), failure: *failure })
            }
            Finding::StartInconclusive { path } => out.push(Situation::StartInconclusive { path: path.clone() }),
            Finding::DanglingLink { path, target, .. } => {
                out.push(Situation::DanglingLauncher { path: path.clone(), target: target.clone() })
            }
            Finding::NotExecutable { path } => out.push(Situation::NotExecutable { path: path.clone() }),
            Finding::Unreadable { paths } => {
                out.push(Situation::Unreadable { paths: paths.clone() });
                notes.push(Note::Unreadable { paths: paths.clone() });
            }
            Finding::CopyNotOwned { path, system_folder } => {
                if !system_folder {
                    notes.push(Note::CopyNotYours { path: path.clone() });
                }
            }
            Finding::FoldersNotOwned { folders } => {
                not_owned = folders.iter().map(|f| f.path.clone()).collect();
                out.push(Situation::FoldersNotOwned { paths: not_owned.clone() });
            }
            Finding::FoldersNotWritable { folders } => {
                let system: Vec<String> = folders.iter().filter(|f| f.system_folder).map(|f| f.path.clone()).collect();
                let mine: Vec<String> = folders
                    .iter()
                    .filter(|f| !f.system_folder && !not_owned.iter().any(|n| same(n, &f.path, w)))
                    .map(|f| f.path.clone())
                    .collect();
                if !mine.is_empty() {
                    out.push(Situation::FoldersNotWritable { paths: mine });
                }
                if !system.is_empty() {
                    out.push(Situation::SystemFolders { paths: system });
                }
            }
            Finding::SeveralCopies { paths } => out.push(Situation::SeveralCopies { paths: paths.clone() }),
            Finding::NativeDirNotOnPath { dir } => notes.push(Note::InstallDirNotOnPath { dir: dir.clone() }),
        }
    }
    // `FoldersNotOwned` may come after `FoldersNotWritable` in the findings:
    // a folder that is both is named once, as not owned.
    if !not_owned.is_empty() {
        for s in out.iter_mut() {
            if let Situation::FoldersNotWritable { paths } = s {
                paths.retain(|p| !not_owned.iter().any(|n| same(n, p, w)));
            }
        }
        out.retain(|s| !matches!(s, Situation::FoldersNotWritable { paths } if paths.is_empty()));
    }
    if let Some(r) = runs.filter(|r| starts(r)) {
        let stuck = h.folders.iter().any(|f| f.needed_now && f.channel == r.channel && !f.writable);
        if stuck && r.channel != target_channel(h.tool) {
            out.push(Situation::CannotUpdate { path: r.path.clone(), channel: r.channel });
        }
    }
    if let Some(run) = ctx.last_run.as_ref().filter(|r| r.cause.as_deref() == Some("file-in-use")) {
        out.push(Situation::FileInUseLastTime { path: run.cause_path.clone() });
    }
}

/// The window's tiles, bounded, as sessions.
pub fn tiles_as_sessions(tiles: &[TileInUse]) -> Vec<SessionInUse> {
    tiles
        .iter()
        .take(MAX_TILES)
        .filter(|t| !t.pty_id.trim().is_empty())
        .map(|t| SessionInUse {
            source: SessionSource::Tile,
            id: t.pty_id.chars().take(MAX_LABEL_CHARS).collect(),
            label: t.label.as_ref().map(|l| l.chars().take(MAX_LABEL_CHARS).collect()),
            pty_id: Some(t.pty_id.chars().take(MAX_LABEL_CHARS).collect()),
        })
        .collect()
}

/// The window's sessions plus the backend's, one per terminal.
pub fn merge_sessions(window: Vec<SessionInUse>, backend: Vec<SessionInUse>) -> Vec<SessionInUse> {
    let mut all = window;
    for s in backend {
        let dup = s.pty_id.as_deref().is_some_and(|p| all.iter().any(|a| a.pty_id.as_deref() == Some(p)))
            || all.iter().any(|a| a.source == s.source && a.id == s.id);
        if !dup {
            all.push(s);
        }
    }
    all
}

/// One tile the window has open that runs the tool.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TileInUse {
    pub pty_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// What the window sends with a plan or a step.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", default)]
pub struct RepairRequest {
    /// Its open tiles of this tool (it owns them; Plyloft never closes one).
    pub tiles: Vec<TileInUse>,
    /// The person ticked "remove the npm copy" (D3).
    pub remove_npm_copy: bool,
    /// A new repair: the steps already tried are forgotten.
    pub start_over: bool,
    /// R4b: "Reinstall anyway": the official installer even when the tool
    /// looks healthy (once per repair).
    pub reinstall: bool,
    /// R4b: a cheap read for Diagnostics' status rows — no reach check, the
    /// short `--version` bound only, no side effects; `cli_repair_run`
    /// refuses it.
    pub quick: bool,
}

#[cfg(test)]
#[path = "cli_repair_tests.rs"]
mod tests;
