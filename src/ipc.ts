import type { DirEntry } from "./types";
import type { FieldProvenanceLike, LibraryReportLike, LibraryStateLike } from "./lib/sharedLibrary";
import type { SetupRunEvidence } from "./lib/setupEvidence";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { markPtyClosing } from "./lib/ptyGone";
import { normalizeCopyEntry, normalizeCopyStartPoint, normalizeCopyView, type ChangedFiles, type CopyEntry, type CopyStartPoint, type CopyView } from "./lib/copies";
export type { ChangedFiles, CopyEntry, CopyPr, CopyStartPoint, CopyView, ProjectCopyState } from "./lib/copies";
import type { TargetDirtyState } from "./lib/shipPreflight";
// GH #104: the Challenger's improvement proposal, as `proposals::ProposalView`
// serializes it. Its words live in `lib/proposals.ts`, with its tests.
import type { ProposalApproved, ProposalView } from "./lib/proposals";
import type { AdoptionStatus, ShareOutcome } from "./lib/adoption";
import type { MyLibraryPublished } from "./lib/myLibraryPublished";
import type { WorkMode } from "./lib/settingsShape";
import type { WorkspaceModels } from "./lib/workspaceModels";
import type { ShipMode } from "./lib/shipVia";
import type { EditConflict } from "./lib/editConflict";
import type { ResponsivenessStatus } from "./lib/responsiveness";

export {
  decodeTargetDirtyError,
  targetDirtyMessage,
  type TargetDirtyState,
} from "./lib/shipPreflight";

export type ShellEnvInfo = {
  path: string;
  shell: string;
  claudePath: string | null;
  claudeVersion: string | null;
  codexPath: string | null;
  codexVersion: string | null;
  /**
   * Derived backend-side: codex resolved on PATH *and* answered `--version`.
   * `codexPath` alone only proves the file exists — a half-finished install
   * leaves the wrapper behind and every spawn dies instantly.
   */
  codexHealthy: boolean;
  /** v1.32.0 dependency doctor. */
  gitPath: string | null;
  gitVersion: string | null;
  ghPath: string | null;
  ghVersion: string | null;
  supportsStreamJson: boolean;
  probeError: string | null;
};

export function shellEnvInfo() {
  return invoke<ShellEnvInfo>("shell_env_info");
}

export function shellEnvRetry() {
  return invoke<ShellEnvInfo>("shell_env_retry");
}

/** The backend replaced its cached shell environment on its own (a changed
 *  Settings PATH override, re-probed in the background). */
export function onShellEnvChanged(handler: (env: ShellEnvInfo) => void) {
  return listen<ShellEnvInfo>("shell-env://changed", (e) => handler(e.payload));
}

// ── Structured Codex sessions + approval memory ─────────

export type CodexApprovalRule = {
  id: string;
  workspaceId: string;
  workspaceCwd: string;
  root: string;
  createdAt: number;
};

export type CodexAppMessageEvent = {
  sessionId: string;
  processId: number;
  message: Record<string, unknown>;
};

export type CodexAppStderrEvent = {
  sessionId: string;
  processId: number;
  text: string;
};

export type CodexAppExitEvent = {
  sessionId: string;
  processId: number;
  exitCode: number | null;
};

export function codexAppStart(sessionId: string, cwd: string) {
  return invoke<number>("codex_app_start", { sessionId, cwd });
}

export function codexAppWrite(
  sessionId: string,
  message: Record<string, unknown>,
) {
  return invoke<void>("codex_app_write", { sessionId, message });
}

export function codexAppStop(sessionId: string) {
  return invoke<void>("codex_app_stop", { sessionId });
}

export function onCodexAppMessage(
  handler: (event: CodexAppMessageEvent) => void,
): Promise<UnlistenFn> {
  return listen<CodexAppMessageEvent>("codex-app://message", (event) =>
    handler(event.payload),
  );
}

export function onCodexAppStderr(
  handler: (event: CodexAppStderrEvent) => void,
): Promise<UnlistenFn> {
  return listen<CodexAppStderrEvent>("codex-app://stderr", (event) =>
    handler(event.payload),
  );
}

export function onCodexAppExit(
  handler: (event: CodexAppExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<CodexAppExitEvent>("codex-app://exit", (event) =>
    handler(event.payload),
  );
}

export function codexApprovalList(workspaceId: string, workspaceCwd: string) {
  return invoke<CodexApprovalRule[]>("codex_approval_list", {
    workspaceId,
    workspaceCwd,
  });
}

export function codexApprovalAdd(
  workspaceId: string,
  workspaceCwd: string,
  root: string,
) {
  return invoke<CodexApprovalRule>("codex_approval_add", {
    workspaceId,
    workspaceCwd,
    root,
  });
}

export function codexApprovalMatches(
  workspaceId: string,
  workspaceCwd: string,
  root: string,
) {
  return invoke<boolean>("codex_approval_matches", {
    workspaceId,
    workspaceCwd,
    root,
  });
}

export function codexApprovalRemove(
  workspaceId: string,
  workspaceCwd: string,
  ruleId: string,
) {
  return invoke<void>("codex_approval_remove", {
    workspaceId,
    workspaceCwd,
    ruleId,
  });
}

// ── Installed P3-1 self-check (v1.95.0 SC-1) ───────────

export type InstalledSelfCheckId =
  | "draft_primary_action"
  | "empty_intake_host_measurable"
  | "intake_backend_pty_continuity"
  | "intake_mount_continuity"
  | "intake_scroll_continuity"
  | "intake_step_transition"
  | "intake_mode_transition"
  | "intake_workspace_transition"
  | "intake_card_close_reopen"
  | "intake_disclosure_transitions"
  | "all_card_states_observed"
  | "one_primary_action_per_state"
  | "cmd_enter_focus_guards"
  | "cmd_enter_never_ships";

export type InstalledSelfCheckStatus =
  | "passed"
  | "failed"
  | "not_observed";

export type InstalledSelfCheckFailureReason =
  | "missing_host"
  | "zero_geometry"
  | "display_none_ancestor"
  | "closed_details_ancestor"
  | "intake_registry_missing"
  | "pty_mismatch"
  | "pty_not_live"
  | "mount_changed"
  | "scroll_reset"
  | "buffer_kind_missing"
  | "buffer_kind_changed"
  | "grid_missing"
  | "grid_changed"
  | "resize_epoch_missing"
  | "resize_epoch_changed"
  | "state_missing"
  | "store_dom_mismatch"
  | "missing_primary_action"
  | "multiple_primary_actions"
  | "guarded_action_invoked"
  | "keyboard_ship_invoked"
  | "observation_cap_reached";

export type CardPresentationState =
  | "archived"
  | "shipped"
  | "shipping"
  | "running"
  /** GH #244: a Builder run whose session is closed or lost — nobody is
   *  running it; Resume is the next step. */
  | "session-closed"
  | "paused"
  | "queued"
  | "challenger-reviewing"
  | "changes-requested"
  | "checking"
  | "verify-failed"
  | "failed"
  | "review-stale"
  | "no-changes"
  | "ready-to-ship"
  | "result-ready"
  | "intake-live"
  /** GH #243: in Complete with no run and not landed — closed on GitHub
   *  (sync pulls a closed issue there) or finished by hand. Done. */
  | "closed"
  | "ready"
  | "draft";

export interface InstalledSelfCheckDraftCheck {
  id: InstalledSelfCheckId;
  status: InstalledSelfCheckStatus;
  reasons: InstalledSelfCheckFailureReason[];
}

export interface IntakeHostFact {
  sequence: number;
  checkpoint:
    | "initial"
    | "step"
    | "mode"
    | "workspace"
    | "card_close_reopen"
    | "disclosure"
    | "scroll";
  transitionId: string | null;
  ptyId: string;
  mountId: string;
  viewportRow: number;
  scrollbackRows: number;
  scrollObserved: boolean;
  bufferKind: "normal" | "alternate" | null;
  cols: number;
  rows: number;
  resizeEpoch: number | null;
  width: number;
  height: number;
  connected: boolean;
  displayNoneAncestor: boolean;
  closedDetailsAncestor: boolean;
}

export interface CardStateFact {
  sequence: number;
  cardId: string;
  evidenceOrigin: "seeded" | "reached";
  storeState: CardPresentationState | null;
  renderedState: CardPresentationState;
  actionId: string | null;
  tone: "accent" | "quiet" | null;
  actionEnabled: boolean;
  primaryActionCount: number;
}

export interface UiCapabilityFact {
  sequence: number;
  standaloneContenteditable: boolean;
}

export interface ActionTraceFact {
  sequence: number;
  state: CardPresentationState;
  actionId: string | null;
  source: "pointer" | "keyboard";
  focusCategory:
    | "card_background"
    | "input"
    | "textarea"
    | "contenteditable"
    | "code_mirror"
    | "xterm"
    | "outside_card";
  primaryActionInvocations: number;
  shipInvocations: number;
}

export interface IntakeAuthorityFact {
  sequence: number;
  checkpoint: IntakeHostFact["checkpoint"];
  observedPtyId: string;
  authoritativePtyId: string | null;
  intakeRegistered: boolean;
  ptyIdsMatch: boolean;
  observedPtyLive: boolean;
}

export type InstalledSelfCheckObservation =
  | { kind: "intake_host"; fact: IntakeHostFact }
  | { kind: "intake_authority"; fact: IntakeAuthorityFact }
  | { kind: "card_state"; fact: CardStateFact }
  | { kind: "ui_capability"; fact: UiCapabilityFact }
  | { kind: "action_trace"; fact: ActionTraceFact };

export interface InstalledSelfCheckDraftV1 {
  workspaceId: string;
  cardId: string;
  checks: InstalledSelfCheckDraftCheck[];
  observations: InstalledSelfCheckObservation[];
}

export interface InstalledSelfCheckReportV1 {
  schemaVersion: number;
  reportId: string;
  reportKind: "p3_1_installed_walk";
  createdAt: number;
  appVersion: string;
  bundleFingerprint: string | null;
  bundleFingerprintAlgorithm: string;
  overall: "passed" | "failed" | "incomplete" | "provenance_error";
  workspaceId: string;
  cardId: string;
  checks: InstalledSelfCheckDraftCheck[];
  observations: InstalledSelfCheckObservation[];
  observationCount: number;
  observationCapReached: boolean;
  diagnostics: string[];
}

export interface InstalledSelfCheckReportReceipt {
  reportPath: string;
  report: InstalledSelfCheckReportV1;
}

export interface IntakeAuthorityCheckpoint {
  cardId: string;
  observedPtyId: string;
  intakeRegistered: boolean;
  authoritativePtyId: string | null;
  ptyIdsMatch: boolean;
  observedPtyLive: boolean;
}

export function installedSelfCheckIntakeAuthority(
  cardId: string,
  observedPtyId: string,
) {
  return invoke<IntakeAuthorityCheckpoint>(
    "installed_self_check_intake_authority",
    { cardId, observedPtyId },
  );
}

export function installedSelfCheckWriteReport(
  draft: InstalledSelfCheckDraftV1,
) {
  return invoke<InstalledSelfCheckReportReceipt>(
    "installed_self_check_write_report",
    { draft },
  );
}

// ── Dependency doctor (v1.32.0) ─────────────────────────

/** OB-2: `git-bash` (Windows) and `node` (Windows, while Codex is there). */
export type ToolId = "git" | "git-bash" | "claude" | "codex" | "node" | "gh";

/** OB-2 (D6): a newer release of a found tool. Mirrors `doctor::ToolUpdate`;
 *  only a Diagnostics read looks for one, and offline there is none. */
export interface ToolUpdate {
  latest: string;
  /** `Version 2.1.290 is available.` */
  detail: string;
  /** What `Update` runs (`claude update`, `brew upgrade gh`, …). */
  command: string;
}

/** OB-2: `git config --global --get user.name` / `user.email`, read only.
 *  Mirrors `doctor::GitIdentityStatus`. */
export interface GitIdentityStatus {
  name: string | null;
  email: string | null;
  set: boolean;
  detail: string;
}

/**
 * GH #103: whether a tool has an account signed in. Mirrors
 * `doctor::ToolAuth`, and only `gh` carries one — `signedIn: null` means Ply
 * asked and could not read the answer, never "signed out".
 */
export interface ToolAuth {
  signedIn: boolean | null;
  detail: string;
  /** What the person runs: `gh auth login` / `claude auth login`, or
   *  `gh auth status` / `claude auth status` to look. */
  command: string;
  /** `Sign in`, or `Check`. */
  action: string;
  /** GH #169 review 1: the step is offered, not asked for — the row stays
   *  neutral and the step is secondary. Only on claude's "could not see". */
  optionalStep?: boolean;
}

/** One tool row of the dependency report. Mirrors `doctor::ToolStatus`. */
export interface ToolStatus {
  id: ToolId;
  name: string;
  /** True for git (and Git Bash on Windows). OB-2: Claude and Codex are each
   *  optional — one AI is enough (`DoctorReport.aiReady`). */
  required: boolean;
  found: boolean;
  path: string | null;
  version: string | null;
  /** Found *and* recent enough. For non-claude tools this equals `found`. */
  versionOk: boolean;
  detail: string;
  installCmd: string;
  docsUrl: string;
  /** Phase 4: behavioral read-only proof. Present only for Claude/Codex. */
  reviewer: ReviewerCapability | null;
  /** GH #103: sign-in — `gh`, `claude` (GH #169) and, from its files, `codex`
   *  (OB-2). */
  auth?: ToolAuth | null;
  /** OB-2 (D6): a newer release, offered with a quiet `Update`. */
  update?: ToolUpdate | null;
}

export type ReviewerCapabilityLevel =
  | "os-sandboxed"
  | "harness-enforced"
  | "prompt-only";

export type ReviewerProbeOutcome =
  | "passed"
  | "write-escaped"
  | "inconclusive"
  | "quota-blocked"
  | "auth-blocked"
  | "timed-out"
  | "failed";

export interface ReviewerCapability {
  provider: CoordinationProvider;
  installed: boolean;
  executablePath: string | null;
  version: string | null;
  level: ReviewerCapabilityLevel | null;
  outcome: ReviewerProbeOutcome | null;
  eligible: boolean;
  stale: boolean;
  proof: string;
  probedAt: number | null;
  /** A probe of this provider is running, or an automatic one is waiting to. */
  probing: boolean;
}

/** Payload of `reviewer-capability://auto-probe`: Ply re-probed a provider
 *  CLI that updated itself since its last reviewer proof. */
export interface ReviewerAutoProbeEvent {
  provider: CoordinationProvider;
  providerName: string;
  version: string;
  result: "reverified" | "failed" | "skipped";
  level: ReviewerCapabilityLevel | null;
  detail: string;
}

export function onReviewerAutoProbe(
  handler: (event: ReviewerAutoProbeEvent) => void,
) {
  return listen<ReviewerAutoProbeEvent>(
    "reviewer-capability://auto-probe",
    (e) => handler(e.payload),
  );
}

/** v1.116.0 (team sharing rung 3): the "N team skills loaded" row.
 *  Mirrors `doctor::TeamSkillsStatus`. */
export interface TeamSkillsStatus {
  /** Skills both CLIs can load — the headline number. */
  loaded: number;
  /** Published to only one half of the library. Non-zero means half the
   *  team's sessions are missing it. */
  claudeOnly: number;
  codexOnly: number;
  /** Plugins refused for carrying hooks or unusable names. */
  refused: number;
  /** Why team skills reach no session on this Mac. A library can be in
   *  perfect order and still load into nothing — no Codex home, or a
   *  marketplace of the member's own in the way. */
  blocked: string | null;
  detail: string;
}

/** v1.117.0 (team sharing rung 4): the "N project skills loaded" row.
 *  Mirrors `doctor::ProjectSkillsStatus`. */
export interface ProjectSkillsStatus {
  /** Skills both CLIs load, so every session Ply starts in this repo gets
   *  them — the same rule as the team-skills row. */
  loaded: number;
  /** In one vendor's root only. Measured: no single directory serves both
   *  CLIs, so this is the normal shape of a repo set up for one of them. */
  claudeOnly: number;
  codexOnly: number;
  /** Skill directories neither CLI loads — almost always a missing
   *  description. */
  unloadable: number;
  /** Copies in two roots that are not the same file, so the two CLIs read
   *  different instructions under one name. */
  diverged: number;
  /** Skill roots git ignores in this repo, so a card never carries them. */
  gitignored: string[];
  /** GH #227: links (a skill directory or a whole root) whose skill no card
   *  carries — git ignores the link, or the files it points to. Explained in
   *  `detail`; not something Un-ignore fixes. */
  ignoredLinks: string[];
  /** Paths (a root, one skill's copy, a link) git gave no answer for —
   *  said as unknown in `detail`, never as carried. */
  unanswered: string[];
  /** Git's own words for what it would not answer: Details, not the row. */
  gitDetails: string[];
  /** The workspace the counts are about; the doctor is machine-wide. */
  workspace: string;
  detail: string;
}

/** Ply's microphone authorization — what Claude Code's `/voice`
 *  dictation inherits inside a tile, and what Ply's own dictation in Codex
 *  and shell tiles uses. Mirrors `microphone::MicrophoneAccess`. */
export type MicrophoneAccess = "not-asked" | "granted" | "denied";

/** The Microphone row. Mirrors `doctor::MicrophoneStatus`. */
export interface MicrophoneStatus {
  access: MicrophoneAccess;
  detail: string;
  /** System Settings → Privacy & Security → Microphone; set only when
   *  denied, since no prompt from Ply can undo a denial. */
  settingsUrl: string | null;
}

/** Structured dependency-doctor report. Mirrors `doctor::DoctorReport`. */
export interface DoctorReport {
  tools: ToolStatus[];
  /** null off a team — the row is absent rather than reading "0 loaded",
   *  which would look like a fault. */
  teamSkills: TeamSkillsStatus | null;
  /** null when the open workspace has no skill directory at all, which is
   *  most repositories. */
  projectSkills: ProjectSkillsStatus | null;
  /** null when AVFoundation could not answer — no row rather than a guess. */
  microphone: MicrophoneStatus | null;
  /** #47: whether the dictation model Settings selects is downloaded. */
  whisperModel: WhisperModelStatus | null;
  /** GH #68: whether the shell new tiles run can take dictated text. */
  dictationShell: DictationShellStatus | null;
  /** GH #79: the open workspace's `.atelier/workspace.json`; null when the
   *  workspace has no shared definition. */
  sharedDefinition: SharedDefinitionStatus | null;
  /** 1.173.0 (D1): the open workspace's Railway row; null without the
   *  Railway program (and from older backends). Optional: never an error. */
  railway?: RailwayDoctorStatus | null;
  probeError: string | null;
  /** OB-2 (§13.1): git works (and Git Bash on Windows) and one AI is ready. */
  allRequiredOk: boolean;
  /** OB-2: Claude Code or Codex is found, usable and not signed out. */
  aiReady?: boolean;
  /** OB-2: the Git identity row; null while git doesn't work. */
  gitIdentity?: GitIdentityStatus | null;
}

/** 1.173.0 (D1): the Doctor's Railway row (`deploy_map::RailwayDoctorStatus`). */
export interface RailwayDoctorStatus {
  workspace: string;
  /** `unknown`: Railway didn't answer. None of them is an error. */
  state: "ok" | "notLinked" | "signedOut" | "unknown";
  /** "signed in · project acme-project", "not linked here". */
  summary: string;
  /** Plain words; a `backticked` part is a command, drawn as code. */
  detail: string;
  /** Railway's own words when it failed — for Copy details only. */
  technical?: string | null;
}

/** GH #79: the Doctor's "Shared workspace definition" row. */
export interface SharedDefinitionStatus {
  workspace: string;
  /** 1.173.0 (B1): `kept` — the repository's areas break the rules and
   *  this Mac keeps its last good ones (warning); `held` — it has none, so
   *  no card may start, ship or release (error). */
  state: "ok" | "pending" | "unreadable" | "kept" | "held";
  /** "unreadable (line N)", "Pending sync", "from main". */
  summary: string;
  detail: string;
}

/**
 * v1.32.0: structured dependency report from the cached probe. Pair with
 * `shellEnvRetry` to re-probe before re-fetching.
 *
 * GH #103 review 1: `withAuth` asks `gh` whether it is signed in, which is a
 * network round trip. Only a read that shows that row passes it — Diagnostics
 * and its watch — and the backend reuses an answer younger than ninety seconds
 * either way. GH #169: it also looks for Claude Code's credential (the keychain
 * item's attributes and `.credentials.json`'s presence — local, no process),
 * behind the same flag and the same ninety seconds.
 *
 * Review 2: `forceAuth` ignores that remembered answer. Only `Look again, from
 * scratch` passes it, because it is the press that means "look properly".
 */
export function dependencyDoctor(withAuth = false, forceAuth = false) {
  return invoke<DoctorReport>("dependency_doctor", { withAuth, forceAuth });
}

/** The Doctor's "Build cache" row: the open workspace's shared Cargo
 *  target (`.plyloft-worktrees/.cargo-target`). */
export interface BuildCacheRow {
  workspaceId: string;
  workspaceName: string;
  /** `sharedBuildCache` in the project config. */
  enabled: boolean;
  status: { path: string; bytes: number; exists: boolean };
}

/** Sized on a worker; null with no workspace open. */
/** H1 (1.173.0): the window's heartbeat for the watchdog (`lib/heartbeat.ts`). */
export function watchdogBeat(visible: boolean) {
  return invoke<void>("watchdog_beat", { visible });
}

/** H1 (1.173.0): Diagnostics › Responsiveness (`lib/responsiveness.ts`). */
export function watchdogStatus() {
  return invoke<ResponsivenessStatus>("watchdog_status");
}

export function buildCacheStatus() {
  return invoke<BuildCacheRow | null>("build_cache_status");
}

/** Delete the shared Cargo target; refused while a build holds it.
 *  Resolves to the bytes freed. */
export function buildCacheClear(workspaceId: string) {
  return invoke<number>("build_cache_clear", { workspaceId });
}

/** GH #215: lines to append to one ignore file so git carries a skill root. */
export interface IgnoreEdit {
  /** Relative to the top of the work tree (`.gitignore`, `.claude/.gitignore`,
   *  `.git/info/exclude`). */
  file: string;
  /** `repository`: a tracked `.gitignore`, everyone's once committed.
   *  `untracked`: a `.gitignore` git doesn't track yet — once added and
   *  committed. `checkout`: a `.gitignore` git ignores itself, never
   *  committed. `clone`: `.git/info/exclude`, this clone only. */
  reach: "repository" | "untracked" | "checkout" | "clone";
  roots: string[];
  /** Exactly what is appended, the comment line first. */
  lines: string[];
  /** The rules they answer, `file:line: pattern`. */
  rules: string[];
}

/** A gitignored skill root Ply offers no lines for, and why. */
export interface IgnoreRefusal {
  root: string;
  /** In words: what ignores it and why Ply adds nothing. */
  reason: string;
  /** The edit to make by hand, when there is a safe one to name. */
  suggestion: string | null;
  /** `file:line: pattern`, for Details. */
  rule: string;
}

export interface IgnorePlan {
  roots: string[];
  edits: IgnoreEdit[];
  refused: IgnoreRefusal[];
}

export interface IgnoreFixOutcome {
  written: IgnoreEdit[];
  /** What the doctor's own check still reports ignored after the write. */
  stillIgnored: string[];
  sentence: string;
}

/** What un-ignoring the workspace's skill roots would append. Writes nothing. */
export function skillRootIgnorePlan(workspaceId: string) {
  return invoke<IgnorePlan>("skill_root_ignore_plan", { workspaceId });
}

/** Append exactly `edits` — the ones the confirmation showed — or nothing. */
export function skillRootIgnoreFix(workspaceId: string, edits: IgnoreEdit[]) {
  return invoke<IgnoreFixOutcome>("skill_root_ignore_fix", { workspaceId, edits });
}

/** Ask macOS for microphone access so its prompt names Ply.
 *  Resolves once the user answers (at once when already decided). */
export function microphoneRequestAccess() {
  return invoke<MicrophoneStatus>("microphone_request_access");
}

/** Open System Settings → Privacy & Security → Microphone. */
export function microphoneOpenSettings() {
  return invoke<void>("microphone_open_settings");
}

/** SP-6: open an http(s) link from a finding's or a comparison's text in
 *  the default browser; any other scheme is refused by the backend. */
export function openWebLink(url: string) {
  return invoke<void>("open_web_link", { url });
}

/** Getting started TU-8 (§3.3): Get help's new email to support, opened by
 *  the system's mail app. Only `mailto:support@plyloft.com?…`. */
export function openSupportMail(url: string) {
  return invoke<void>("open_support_mail", { url });
}

// ── #47 dictation (Codex and shell tiles) ────────────────

export type DictationModel = "small" | "base";
export type DictationLanguage = "auto" | "it" | "en";

/** The doctor's Whisper model row. Mirrors `doctor::WhisperModelStatus`. */
export interface WhisperModelStatus {
  model: DictationModel;
  present: boolean;
  path: string;
  detail: string;
}

/** GH #68: the "Dictation in shell tiles" row. Mirrors
 *  `doctor::DictationShellStatus`. */
export interface DictationShellStatus {
  shell: string;
  label: string;
  found: boolean;
  ok: boolean;
  detail: string;
}

/** Mirrors `dictation::ModelStatus`. */
export interface DictationModelStatus {
  id: DictationModel;
  fileName: string;
  path: string;
  present: boolean;
  sizeBytes: number | null;
  approxBytes: number;
  downloading: boolean;
}

/** Mirrors `dictation::DictationStatus`. */
export interface DictationStatus {
  whisperCli: string | null;
  models: DictationModelStatus[];
}

/** Mirrors `dictation::DictationErrorKind`; what a toast branches on. */
export type DictationErrorKind =
  | "whisper-missing"
  | "model-missing"
  | "invalid-audio"
  | "timeout"
  | "cancelled"
  | "busy"
  | "quitting"
  | "failed";

export interface DictationError {
  kind: DictationErrorKind;
  message: string;
}

export function isDictationError(value: unknown): value is DictationError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DictationError).kind === "string" &&
    typeof (value as DictationError).message === "string"
  );
}

export function dictationStatus() {
  return invoke<DictationStatus>("dictation_status");
}

/** Transcribe a 16 kHz mono WAV with the model and language Settings
 *  selects. Rejects with a `DictationError`. The caller inserts the text;
 *  nothing is ever sent. */
export function dictationTranscribe(wav: Uint8Array, requestId: string) {
  return invoke<string>("dictation_transcribe", {
    wav: Array.from(wav),
    requestId,
  });
}

/** Kill a running transcription (Esc while "Transcribing…"). */
export function dictationCancel(requestId: string) {
  return invoke<boolean>("dictation_cancel", { requestId });
}

/** Download a model; resolves with the refreshed status once installed.
 *  Progress arrives on `onDictationDownloadProgress`. */
export function dictationModelDownload(model: DictationModel) {
  return invoke<DictationStatus>("dictation_model_download", { model });
}

export function dictationModelDownloadCancel(model: DictationModel) {
  return invoke<boolean>("dictation_model_download_cancel", { model });
}

export interface DictationDownloadProgress {
  model: DictationModel;
  received: number;
  total: number | null;
}

export function onDictationDownloadProgress(
  handler: (progress: DictationDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DictationDownloadProgress>("dictation://download-progress", (e) =>
    handler(e.payload),
  );
}

/** Try it TI-4: the shell of `id` is running a command (another process
 *  holds its terminal, or is in its job on Windows); null when it can't say. */
export function ptyCommandRunning(id: string) {
  return invoke<boolean | null>("pty_command_running", { id });
}

/** QoL 1.168 (D4, H1): a shell tile's shell is alone — nothing in the
 *  foreground or the background of its session (Windows: its job). `null`
 *  when the PTY cannot say. */
export function ptyShellAlone(id: string) {
  return invoke<boolean | null>("pty_shell_alone", { id });
}

/** A shell tile's prompt is idle: the shell itself holds the terminal's
 *  foreground and its line editor is editing the prompt (not a command, not
 *  a builtin `read`). null when the PTY cannot say. */
export function ptyPromptIdle(id: string) {
  return invoke<boolean | null>("pty_prompt_idle", { id });
}

/** Windows: the clipboard's text, read by Plyloft itself, for a terminal's
 *  right-click paste — the page's own read sits behind WebView2's
 *  clipboard permission prompt. null when it holds no text. */
export function clipboardReadText() {
  return invoke<string | null>("clipboard_read_text");
}

/** GH #70: what a shell tile's PTY says for its header chip. `running`: a
 *  job holds the foreground. `editing`: the shell's line editor has the
 *  prompt. `canonical`: the shell holds the foreground with canonical input
 *  — a builtin `read` waiting for input, or the prompt of a shell with no
 *  line editor. null when the PTY cannot answer at all. */
export type ShellPromptState = "running" | "editing" | "canonical";

export function ptyPromptState(id: string) {
  return invoke<ShellPromptState | null>("pty_prompt_state", { id });
}

export function reviewerCapabilityProbe(provider: "claude" | "codex") {
  return invoke<ReviewerCapability>("reviewer_capability_probe", { provider });
}

/** Mirrors `commands::ClaudeReviewTrust`: the folder Claude must trust once
 *  for Plyloft's read-only Claude sessions, and whether it does (null:
 *  Claude's state could not be read). Read-only. */
export interface ClaudeReviewTrust {
  folder: string;
  trusted: boolean | null;
}

export function claudeReviewTrustStatus() {
  return invoke<ClaudeReviewTrust>("claude_review_trust_status");
}

export type ReviewerRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface ReviewerRecord {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  cardId: string;
  provider: CoordinationProvider;
  capability: ReviewerCapabilityLevel | null;
  capabilityProof: string;
  providerExecutable: string;
  providerVersion: string;
  baseRevision: string;
  /** Review integrity: why `baseRevision` was not checked against origin's
   *  real tip, or a local ref was not used. Absent otherwise. */
  baseNote?: string | null;
  reviewedRevision: string;
  endRevision: string | null;
  branchName: string;
  sourceWorktree: string;
  isolatedWorktree: string;
  sourceDirtyPaths: string[];
  dirtyPathsTruncated: boolean;
  status: ReviewerRunStatus;
  artifact: string | null;
  exitCode: number | null;
  timedOut: boolean;
  writeEscaped: boolean;
  error: string | null;
  diagnostics: string[];
  startedAt: number;
  endedAt: number | null;
  /** GH #58: passes the complete diff was reviewed in (0 before passes). */
  passCount: number;
  fileCount: number;
  verdict: "approve" | "changes_requested" | "incomplete" | null;
  incompleteReason: string | null;
  /** ADR 0006 (optional so older fixtures stay valid). */
  kind?: ReviewKind;
  synthesisPass?: boolean;
  findings?: ReviewFinding[];
  nonBlocking?: ReviewFinding[];
  checklist?: string[];
  failedPassNames?: string[];
}

export interface ReviewerView {
  record: ReviewerRecord;
  currentRevision: string | null;
  stale: boolean;
  valid: boolean;
}

export function reviewerRun(
  workspaceId: string,
  cardId: string,
  provider: "claude" | "codex",
) {
  return invoke<ReviewerView>("reviewer_run", {
    workspaceId,
    cardId,
    provider,
  });
}

export function reviewerList(workspaceId: string, cardId: string) {
  return invoke<ReviewerView[]>("reviewer_list", { workspaceId, cardId });
}

export type DiscussionStatus =
  | "preparing"
  | "running"
  | "paused_provider_unavailable"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";
export type DiscussionPhase =
  | "preparing"
  | "independent_analyses"
  | "cross_reviews"
  | "synthesis"
  | "completed";
export type DiscussionLegKind =
  | "analysis_a"
  | "analysis_b"
  | "cross_review_a"
  | "cross_review_b"
  | "synthesis";
export type DiscussionLegStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface DiscussionUnavailable {
  kind: "quota" | "authentication";
  reason: string;
  resetAt: number | null;
}

export interface DiscussionAttempt {
  number: number;
  status: DiscussionLegStatus;
  executable: string;
  version: string;
  capability: ReviewerCapabilityLevel | null;
  artifact: unknown | null;
  exitCode: number | null;
  timedOut: boolean;
  writeEscaped: boolean;
  endRevision: string | null;
  unavailable: DiscussionUnavailable | null;
  error: string | null;
  diagnostics: string[];
  startedAt: number;
  endedAt: number | null;
}

export interface DiscussionLeg {
  kind: DiscussionLegKind;
  provider: "claude" | "codex";
  status: DiscussionLegStatus;
  executable: string;
  version: string;
  capability: ReviewerCapabilityLevel | null;
  attemptCount: number;
  promptDigest: string;
  artifact: unknown | null;
  exitCode: number | null;
  timedOut: boolean;
  writeEscaped: boolean;
  endRevision: string | null;
  unavailable: DiscussionUnavailable | null;
  attemptHistory: DiscussionAttempt[];
  diagnostics: string[];
  startedAt: number | null;
  endedAt: number | null;
}

export interface DisagreementEntry {
  id: string;
  raisedBy: DiscussionLegKind;
  statement: string;
  rationale: string;
  severity: string;
  evidenceRefs: string[];
  relatedIds: string[];
}

export interface DiscussionRecord {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  cardId: string | null;
  problem: string;
  source: {
    project: CoordinationIdentityPath;
    displayPath: string;
    sourceRef: string | null;
    baseRevision: string | null;
    pinnedRevision: string;
    dirtyPaths: string[];
    dirtyPathsTruncated: boolean;
  };
  participants: {
    analysisA: { provider: "claude" | "codex"; executable: string; version: string; capability: ReviewerCapabilityLevel | null };
    analysisB: { provider: "claude" | "codex"; executable: string; version: string; capability: ReviewerCapabilityLevel | null };
    synthesizer: { provider: "claude" | "codex"; executable: string; version: string; capability: ReviewerCapabilityLevel | null };
  };
  status: DiscussionStatus;
  currentPhase: DiscussionPhase;
  promptEnvelopeDigest: string;
  legs: {
    analysisA: DiscussionLeg;
    analysisB: DiscussionLeg;
    crossReviewA: DiscussionLeg;
    crossReviewB: DiscussionLeg;
    synthesis: DiscussionLeg;
  };
  ledgerReady: boolean;
  disagreementLedger: DisagreementEntry[];
  finalResult: unknown | null;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  /** OB-14 (D5): one vendor is installed, so both views come from it, in
   *  two separate sessions with different roles. Absent on older records. */
  singleVendor?: boolean;
}

export interface DiscussionView {
  record: DiscussionRecord;
  currentRevision: string | null;
  stale: boolean;
}

export function discussionPrepare(
  workspaceId: string,
  cardId: string | null,
  problem: string,
  synthesizer: "claude" | "codex",
) {
  return invoke<DiscussionRecord>("discussion_prepare", {
    workspaceId,
    cardId,
    problem,
    synthesizer,
  });
}

export function discussionLaunch(discussionId: string) {
  return invoke<void>("discussion_launch", { discussionId });
}

export function discussionList(workspaceId: string) {
  return invoke<DiscussionView[]>("discussion_list", { workspaceId });
}

export function discussionResume(discussionId: string) {
  return invoke<void>("discussion_resume", { discussionId });
}

export function discussionRetry(
  discussionId: string,
  leg: DiscussionLegKind,
) {
  return invoke<void>("discussion_retry", { discussionId, leg });
}

export function discussionAbort(discussionId: string) {
  return invoke<void>("discussion_abort", { discussionId });
}

export function onDiscussionChanged(
  handler: (event: { discussionId: string; error: string | null }) => void,
): Promise<UnlistenFn> {
  return listen<{ discussionId: string; error: string | null }>(
    "discussion://changed",
    (event) => handler(event.payload),
  );
}

// ── Library › Instructions (GH #101, BOARDS.md §5) ──────────────────────
//
// The Phase 1C instruction doctor behind a page. Its two old commands went with
// the panel that used them: a second way in was a second way to write the
// checkout of a **shared** workspace, which the card forbids.
// `librarySetUpInstructions` is the one entry point, and the backend — never the
// window — decides whether the step publishes or writes.

export type InstructionConventionStatus =
  | "compliant"
  | "both-missing"
  | "agents-missing"
  | "claude-missing"
  | "claude-import-missing"
  | "claude-import-not-first"
  | "claude-import-duplicated"
  | "manual-only";

export interface InstructionFilesExpected {
  agentsFingerprint: string;
  claudeFingerprint: string;
}

/**
 * Where a row's file is, once the branch and the checkout can disagree.
 * An unshared workspace reads one directory as both, so every row is `both`.
 *
 * GH #161: the last two are the mirror carrying a **pending** change laid over
 * the branch. `queued` is a file the branch has not got at all, so the row says
 * where the change waits instead of sending the member to pull a file that is not
 * there; `queuedOverBranch` is one the change is laid **over** — the branch keeps
 * the copy it has until the change lands (review 1).
 */
export type InstructionFileWhere =
  | "both"
  | "bothDiffering"
  | "branchOnly"
  | "checkoutOnly"
  | "queued"
  | "queuedOverBranch";

/** One `In this repository` Value row. */
export interface InstructionFileRow {
  name: string;
  /** The length of the copy this row describes, which is the one `›` opens
   *  whenever there is one (GH #101 review 1). */
  lines: number;
  hint: string;
  /** The checkout path `›` opens in Code; `null` when there is none to open. */
  openInCode: string | null;
  /**
   * GH #142: the path `›` opens **read-only** when there is no checkout copy —
   * the file in Ply's mirror of the branch, which is the copy the row describes.
   * Never set together with `openInCode`, and never for an unshared workspace.
   */
  readOnlyPath: string | null;
  located: InstructionFileWhere;
}

/** The `Agent instructions` Procedure row: one sentence, at most one step. */
export interface InstructionProcedure {
  status: InstructionConventionStatus;
  sentence: string;
  /** The proposal id `Set up` runs; `null` when the procedure is quiet. */
  step: string | null;
}

/** What the `Set up` flow draws (BOARDS.md §5 "The flow"). */
export interface InstructionFlowPlan {
  proposalId: string;
  eyebrow: string;
  title: string;
  lede: string;
  /** The file whose before/after sit side by side. */
  compared: string;
  before: string | null;
  after: string;
  /** The sentence under the two panels, when the bytes really move. */
  note: string | null;
  /** `What changes on disk`, one line per file. */
  disk: string[];
  reach: string;
  /** Each file's blob id on the branch as this plan was read; handed straight
   *  back so the publish can refuse to override a file that moved since. */
  bases: Record<string, string | null>;
  expected: InstructionFilesExpected;
}

/** One instruction file of this Mac: never writable; its `›` opens it read-only
 *  in Code (GH #174), from the `path` Rust listed here. */
export interface PersonalInstructionFile {
  rel: string;
  path: string;
  cli: string;
  lines: number;
}

export interface InstructionsView {
  shared: boolean;
  branch: string | null;
  readOnly: boolean;
  repository: string | null;
  workspaceRoot: string;
  files: InstructionFileRow[];
  procedure: InstructionProcedure;
  plan: InstructionFlowPlan | null;
  personal: PersonalInstructionFile[];
  errors: string[];
}

export function libraryInstructionsView(workspaceId: string) {
  return invoke<InstructionsView>("library_instructions_view", { workspaceId });
}

/**
 * Run the page's one step. Answers `true` when the change went to the shared
 * channel (so the row says it is publishing), `false` when the checkout was
 * written because the workspace has no shared definition.
 *
 * The plan goes back whole: its `bases` are the blob ids the member was shown,
 * and they are what "never override" is judged against on the fresh tip.
 */
export function librarySetUpInstructions(
  workspaceId: string,
  plan: InstructionFlowPlan,
) {
  return invoke<boolean>("library_instructions_set_up", {
    workspaceId,
    step: {
      proposalId: plan.proposalId,
      expected: plan.expected,
      bases: plan.bases,
    },
  });
}

/** `Reveal in Finder` on a personal instruction file. */
export function personalInstructionReveal(path: string) {
  return invoke<void>("personal_instruction_reveal", { path });
}

/**
 * GH #174: the text of a personal instruction file, for Code's read-only view.
 * `path` is the one `library_instructions_view` listed; Rust judges it with
 * `listed_instruction_file` before reading a byte.
 */
export function personalInstructionRead(path: string) {
  return invoke<string>("personal_instruction_read", { path });
}

// ── Agent collaboration Phase 2: advisory sessions + handoffs ─────────

export type CoordinationProvider = "system" | "shell" | "claude" | "codex";
export type CoordinationExecutionKind =
  | "internal"
  | "shell-tile"
  | "provider-tile"
  | "agent-repl"
  | "agent-oneshot"
  | "swarm-role"
  | "intake"
  | "verify-collector"
  | "memory-suggester"
  | "reviewer-probe"
  | "reviewer"
  | "discussion-analysis"
  | "discussion-cross-review"
  | "discussion-synthesis";
export type CoordinationAttendance = "human-attended" | "unattended";
export type CoordinationWriteIntent = "read-only" | "writer" | "unknown";
export type CoordinationEnforcement = "advisory" | "exclusive" | "exempt";
export type CoordinationSessionStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "interrupted";

export interface CoordinationIdentityPath {
  displayPath: string;
  comparisonKey: string;
}

export interface CoordinationProjectContext {
  workspaceId: string;
  git: boolean;
  project: CoordinationIdentityPath;
  worktree: CoordinationIdentityPath;
  displayCwd: string;
}

export type CoordinationProjectRelevance =
  | ({ kind: "project" } & CoordinationProjectContext)
  | { kind: "non-project"; reason: string };

export interface CoordinationWarning {
  code: string;
  peerSessionId: string;
  observedAt: number;
  summary: string;
}

export interface CoordinationSession {
  schemaVersion: number;
  id: string;
  provider: CoordinationProvider;
  executionKind: CoordinationExecutionKind;
  project: CoordinationProjectRelevance;
  attendance: CoordinationAttendance;
  writeIntent: CoordinationWriteIntent;
  enforcement: CoordinationEnforcement;
  capability: "os-sandboxed" | "harness-enforced" | "prompt-only" | null;
  cardId: string | null;
  swarmId: string | null;
  roleId: string | null;
  runId: string | null;
  handoffId: string | null;
  ptyId: string | null;
  processId: number | null;
  baseRevision: string | null;
  headRevision: string | null;
  status: CoordinationSessionStatus;
  exitCode: number | null;
  error: string | null;
  diagnostics: string[];
  startedAt: number;
  runningAt: number | null;
  endedAt: number | null;
  warningsObserved: CoordinationWarning[];
  retentionClass: "ephemeral" | "interactive" | "unattended";
  objective: string | null;
}

export interface CoordinationLiveWarning {
  sessionId: string;
  peerSessionId: string;
  code: string;
  summary: string;
}

export interface WorkspaceCoordinationStatus {
  trackingActive: boolean;
  state: string;
  workspaceId: string;
  activeSessions: CoordinationSession[];
  liveWarnings: CoordinationLiveWarning[];
  recentInterruptedCount: number;
}

export interface CoordinationHandoff {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  project: CoordinationProjectContext | null;
  sourceSessionId: string;
  sourceRunId: string | null;
  cardId: string | null;
  swarmId: string | null;
  roleId: string | null;
  provider: CoordinationProvider;
  objective: string;
  outcomeStatus: CoordinationSessionStatus;
  exitCode: number | null;
  failure: string | null;
  baseRevision: string | null;
  headRevision: string | null;
  snapshotRunId: string | null;
  changes: {
    total: number;
    paths: string[];
    truncated: boolean;
    swarmCollisions: number;
  };
  reviewerArtifact: unknown | null;
  evidenceWarnings: string[];
  verificationArtifacts: unknown[];
  followUps: string[];
  createdAt: number;
  protectedBy: string[];
}

export function coordinationStatus(workspaceId: string) {
  return invoke<WorkspaceCoordinationStatus>("coordination_status", {
    workspaceId,
  });
}

export function coordinationHandoffRecent(
  workspaceId: string,
  limit?: number,
) {
  return invoke<CoordinationHandoff[]>("coordination_handoff_recent", {
    workspaceId,
    limit: limit ?? null,
  });
}

export interface CoordinationChangedEvent {
  workspaceId: string | null;
}

export function onCoordinationChanged(
  handler: (event: CoordinationChangedEvent) => void,
) {
  return listen<CoordinationChangedEvent>("coordination://changed", (event) =>
    handler(event.payload),
  );
}

/** v1.49.0 (Team Mode Phase 0): cached identity email. Backfilled at app
 *  startup from `git config --global user.email`. Backend stamps this on
 *  every shared-library mutation; the frontend fetches it once at boot
 *  via `useIdentity` so future UI (PR-claim, attribution chips, etc.)
 *  can render the current user. Returns null if git is missing or no
 *  global email is set. */
export function identityGet() {
  return invoke<string | null>("identity_get");
}

// 1.176.0 R3: the PTY spawn's wrapper lives in lib/ptySpawnIpc.ts.
export { ptySpawn } from "./lib/ptySpawnIpc";

/** Try it (TI-2): the card copy a Try session belongs to (`PtyTryArg`). */
export interface TryTargetArg {
  cardId: string;
  lane?: "a" | "b" | null;
}

/** Try it (TI-2): the backend stopped a card's Try sessions — before its
 *  copy was removed (`try_session::TryStoppedEvent`). */
export interface TryStoppedEvent {
  workspaceId: string;
  cardId: string;
  lane: "a" | "b" | null;
  reason: "ship" | "archive" | "delete" | "discard" | "copy-removed" | "requested";
  ptyIds: string[];
  /** What the card says, when anything: a ship's `TRY_STOPPED_FOR_SHIP`. */
  words: string | null;
}

export function onTryStopped(handler: (e: TryStoppedEvent) => void): Promise<UnlistenFn> {
  return listen<TryStoppedEvent>("card://try-stopped", (e) => handler(e.payload));
}

/** Try it (TI-2, spec §7): which of `names` have a `<name>.cmd` shim on the
 *  cached PATH. */
export function tryCmdShimsAvailable(names: readonly string[]) {
  return invoke<string[]>("try_cmd_shims_available", { names: [...names] });
}

/** Try it (TI-2): whether a Try session's folder is still there (a Restart
 *  never starts in a copy that was removed). */
export function tryFolderExists(path: string) {
  return invoke<boolean>("try_folder_exists", { path });
}

/** Try it (TI-4, spec §4.4): the card copy at `path` needs its packages
 *  first — a `package.json` and nothing installed (no `node_modules`, no
 *  Yarn Plug'n'Play map). The install its lockfile calls for (the frozen
 *  form, `npm ci`…, so the copy's lockfile never changes; the plain install
 *  with none), or null when it needs nothing. */
export function tryCopyNeedsPackages(path: string) {
  return invoke<ProjectInstall | null>("try_copy_needs_packages", { path });
}

/** Try it walk fix (spec §4.1): the body of the `package.json` script
 *  `name` in the folder `path`, or null when there is none. */
export function tryPackageScript(path: string, name: string) {
  return invoke<string | null>("try_package_script", { path, name });
}

/** Try it (TI-4, spec §3.3): a plain website — the `index.html` at the top
 *  of the card's copy (that build's) opened in the default browser; no
 *  session starts. The backend finds the copy and checks the file. */
export function tryOpenIndexHtml(workspaceId: string, cardId: string, lane: "a" | "b" | null) {
  return invoke<void>("try_open_index_html", { workspaceId, cardId, lane });
}

/** Try it TI-5 (spec §3.2): Try it in <project> found the project folder
 *  without its packages — a package manager's plain install run there once,
 *  the way worktree setup runs; nothing saved. */
export function tryInstallPackagesInProject(workspaceId: string, command: string) {
  return invoke<WorktreeSetupRecord>("try_install_packages_in_project", { workspaceId, command });
}

/** TI-5 (`try_session::ProjectInstall`): the install Try it in <project>
 *  runs in the project folder — the lockfile's frozen form (`npm ci`…), or
 *  the plain install, which also creates `creates`. */
export interface ProjectInstall {
  command: string;
  creates: string | null;
}

/** TI-5: the project folder needs its packages first — and how they would be
 *  installed there; null when nothing is missing. */
export function tryProjectNeedsPackages(workspaceId: string) {
  return invoke<ProjectInstall | null>("try_project_needs_packages", { workspaceId });
}

/** TI-5: the project folder's checkout holds `sha` (a merged pull request's
 *  merge commit). */
export function tryProjectHasCommit(workspaceId: string, sha: string) {
  return invoke<boolean>("try_project_has_commit", { workspaceId, sha });
}

/** Try it (TI-4, spec §4.4): "Install them this time" — the copy's packages
 *  installed once, nothing saved (a Mac that can't save the setup). */
export function tryInstallPackagesOnce(
  workspaceId: string,
  cardId: string,
  lane: "a" | "b" | null,
  command: string,
) {
  return invoke<WorktreeSetupRecord>("try_install_packages_once", { workspaceId, cardId, lane, command });
}

/** Try it (TI-2): stop every Try session of the card, or of that build. */
export function stopCardTrySessions(workspaceId: string, cardId: string, lane?: "a" | "b" | null) {
  return invoke<number>("stop_card_try_sessions", { workspaceId, cardId, lane: lane ?? null });
}

/** Terminals block P2: a tile's title from the CLI's own files. */
export type TileTitle = {
  rowId: string;
  title: string | null;
  titleSource: "first-message" | "cli" | "user" | null;
  /** The CLI conversation the tile is in now. */
  cliSessionId?: string;
  /** This look followed the tile to another conversation (`/clear`). */
  followed?: boolean;
  /** The CLI's files give that conversation a title of its own. */
  conversationNamed?: boolean;
};

export function terminalTileTitle(ptyId: string) {
  return invoke<TileTitle | null>("terminal_tile_title", { ptyId });
}

export function terminalTileRename(ptyId: string, title: string) {
  return invoke<TileTitle | null>("terminal_tile_rename", { ptyId, title });
}

/** Walk of blocks A+B: the member's name was typed into the CLI and
 *  submitted (`/rename`). */
export function terminalTileNamePassed(ptyId: string, name: string) {
  return invoke<void>("terminal_tile_name_passed", { ptyId, name });
}

/** Challenger round 1: "Use the automatic name" — the member's name leaves
 *  the record; the next look takes the conversation's own title. */
export function terminalTileAutoName(ptyId: string) {
  return invoke<TileTitle | null>("terminal_tile_auto_name", { ptyId });
}

/** Terminals block P1: a row of a workspace's tile-session record. */
export type TerminalSession = {
  id: string;
  ptyId?: string;
  kind: "claude" | "codex";
  cwd: string;
  cliSessionId?: string;
  startedAt: number;
  endedAt?: number;
  title?: string;
  titleSource?: TileTitle["titleSource"];
  resumedFrom?: string;
  /** QoL 1.168 (D11): its tile was running when Plyloft quit, at this time. */
  openAtQuit?: number;
  /** Its tile runs in this launch. */
  live: boolean;
};

/** QoL 1.168 (block 4, D11): by workspace, the Claude and Codex sessions open
 *  when Plyloft last quit, in the order they were opened — the offer to
 *  reopen them, never automatic. Read once at launch. */
export function terminalReopenOffers() {
  return invoke<Record<string, TerminalSession[]>>("terminal_reopen_offers");
}

/** QoL 1.168 (D11): the offer was taken or put away. */
export function terminalReopenDismiss(workspaceId: string) {
  return invoke<void>("terminal_reopen_dismiss", { workspaceId });
}

/** QoL 1.168 (block 4, D6): a path printed in a tile, as Code opens it — a
 *  file inside the workspace — or null (no link there). */
export function terminalLinkTarget(workspaceId: string, cwd: string, path: string) {
  return invoke<string | null>("terminal_link_target", { workspaceId, cwd, path });
}

/** Terminals block P5: History › Sessions — a row, its workspace, and
 *  whether its conversation can still be resumed (`gone` says why not). */
export type TerminalHistorySession = TerminalSession & {
  workspaceId: string;
  resumable: boolean;
  gone?: "folder" | "conversation";
  /** 1.174.0 E9 round 1: when its conversation's transcript was last
   *  written (unix ms), from the lookup that decides `resumable`. */
  lastWriteAt?: number;
};

export type TerminalHistoryAll = {
  sessions: TerminalHistorySession[];
  /** Workspaces whose record doesn't parse. */
  unreadable: string[];
};

export function terminalSessionsHistoryAll() {
  return invoke<TerminalHistoryAll>("terminal_sessions_history_all");
}

/** Terminals block P4: a conversation of the project folder, for Resume…:
 *  its name and when it was last written, never what was said. */
export type TerminalConversation = {
  kind: "claude" | "codex";
  cliSessionId: string;
  title: string | null;
  titleSource: TileTitle["titleSource"];
  updatedAt: number;
  /** A tile of this workspace runs it now. */
  live: boolean;
  livePtyId?: string;
  /** QoL 1.168: its first message's short title, when the name shown is
   *  another — two of the same name can be told apart. */
  opening?: string;
  /** 1.174.0 walk G3b: the copy's folder it ran in, for a conversation of
   *  one of the project's copies; absent for the project folder's own. */
  cwd?: string;
};

export function terminalConversations(workspaceId: string) {
  return invoke<TerminalConversation[]>("terminal_conversations", { workspaceId });
}

/** What stops Resume from opening a conversation from `cwd`. */
export type ResumeCheck =
  | { kind: "ready" }
  | { kind: "inTile"; workspaceId: string; ptyId: string }
  | { kind: "elsewhere" }
  | { kind: "folderGone" }
  | { kind: "conversationGone" };

export function terminalResumeCheck(kind: "claude" | "codex", cliSessionId: string, cwd: string) {
  return invoke<ResumeCheck>("terminal_resume_check", { kind, cliSessionId, cwd });
}

/** Terminals block P3: what stops a tile's session, from its drawn screen. */
export type TileBlock = { kind: "trust" | "bypass" | "usageLimit"; resetsAt?: string };

export function tileScreenBlock(text: string) {
  return invoke<TileBlock | null>("tile_screen_block", { text });
}

export function ptyWrite(id: string, data: Uint8Array) {
  return invoke<void>("pty_write", { id, data: Array.from(data) });
}

export function ptyResize(id: string, cols: number, rows: number) {
  return invoke<void>("pty_resize", { id, cols, rows });
}

/** 1.168.1 (#6, Windows): the light/dark a live Claude session Plyloft
 *  themed started in, or null (not themed, or gone). */
export function ptySessionLightness(id: string) {
  return invoke<"light" | "dark" | null>("pty_session_lightness", { id });
}

/** 1.169.0 (B2): the ConPTY this run's PTYs use on Windows — "bundled"
 *  (Plyloft's own: Claude follows a light/dark switch live) or "system" —
 *  else null (the Mac). */
export function ptyConsoleHost() {
  return invoke<"bundled" | "system" | null>("pty_console_host");
}

export function ptyKill(id: string) {
  // A guarded terminal (`lib/ptyGone`) stops writing and resizing now, not
  // on the exit event that follows the kill.
  markPtyClosing(id);
  return invoke<void>("pty_kill", { id });
}

export function onPtyData(
  handler: (id: string, data: Uint8Array, offset?: number) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; data: number[]; offset?: number }>("pty://data", (e) => {
    // `offset`: where this batch's first byte sits in the session's output
    // (`lib/builderAttach.ts` lines a replayed capture up with it).
    handler(e.payload.id, new Uint8Array(e.payload.data), e.payload.offset);
  });
}

export function onPtyExit(
  handler: (id: string, code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ id: string; code: number | null }>("pty://exit", (e) => {
    handler(e.payload.id, e.payload.code);
  });
}

/**
 * v1.20.3: fired by the backend's intake idle sweeper right before it
 * kills a swept session. The FE uses this to render a friendlier
 * "auto-cancelled" banner instead of the generic "exited unexpectedly"
 * error that the subsequent `pty://exit` would otherwise produce.
 */
export interface IntakeSweptEvent {
  ptyId: string;
  workspaceId: string;
  cardId: string;
  idleMinutes: number;
}

export function onIntakeSwept(
  handler: (e: IntakeSweptEvent) => void,
): Promise<UnlistenFn> {
  return listen<IntakeSweptEvent>("intake://swept", (e) => {
    handler(e.payload);
  });
}

// ── OB-3: Setup's guided terminal ──────────────────────────────────────
// The frontend sends only an action id (spec §6) — never a command. Rust
// builds the argv from its allowlist (`setup_actions.rs`).

/** Every action id `setup_run` / `setup_check` accept. */
export type SetupActionId =
  | "install.claude"
  | "update.claude"
  | "login.claude"
  | "status.claude"
  /** Claude's TUI in Plyloft's review folder, for the member to answer its
   *  trust question once (`setup_actions::ActionId::TrustClaude`). */
  | "trust.claude"
  | "install.codex"
  | "update.codex"
  | "login.codex"
  | "login-device.codex"
  | "status.codex"
  | "install.gh"
  | "update.gh"
  | "login.gh"
  | "add-account.gh"
  | "setupgit.gh"
  | "refresh.gh"
  | "install.git"
  | "install.node";

/** A terminal run (`status.*` are `setupCheck` reads). */
export type SetupRunActionId = Exclude<SetupActionId, "status.claude" | "status.codex">;

/** OB-12: every run the guided terminal shows — `setup_run`'s, and step 8's
 *  clone (`project.clone`, started only by `projectClone`, never accepted by
 *  `setup_run`). `setup_active` and `setup://progress` carry either. */
export type SetupGuidedActionId = SetupRunActionId | "project.clone";

/** The one structured argument: gh's host, which must be github.com. */
export interface SetupArgs {
  hostname?: "github.com";
}

export type SetupTool = "claude" | "codex" | "gh" | "git" | "node";

/** How Rust decides the action worked (`setup_actions::Watch`). */
export type SetupWatch =
  | { kind: "tool-works"; tool: SetupTool }
  | { kind: "claude-sign-in" }
  | { kind: "codex-sign-in" }
  | { kind: "gh-new-account" }
  | { kind: "gh-signed-in" }
  | { kind: "gh-git-helper" }
  | { kind: "gh-scopes" }
  | { kind: "command-line-tools" }
  /** `trust.claude`: Claude's own state says the review folder is trusted. */
  | { kind: "claude-folder-trust" }
  | { kind: "answer" }
  /** OB-11: a clone's `.git` appeared and `gh repo clone` exited cleanly. */
  | { kind: "cloned" };

export interface SetupStarted {
  runId: string;
  actionId: SetupGuidedActionId;
  ptyId: string;
  /** The command, as the consent sheet's Details names it. */
  display: string;
  watch: SetupWatch;
}

export type SetupPhase = "preparing" | "running" | "checking" | "waiting-long" | "done";
export type SetupOutcome =
  | "succeeded"
  | "not-observed"
  | "could-not-tell"
  | "failed"
  | "timed-out"
  /** OB-6: the macOS installer window closed without the tools. */
  | "installer-closed"
  /** 1.176.0 R2 (an update): the old version still answers; the updater found nothing newer; a lower one answers now. */
  | "still-on-old-version" | "nothing-newer" | "older-version-now"
  | "cancelled";

/** R2: the final event also carries its evidence (`lib/setupEvidence.ts`). */
export interface SetupProgressEvent extends SetupRunEvidence {
  runId: string;
  actionId: SetupGuidedActionId;
  ptyId: string | null;
  phase: SetupPhase;
  outcome: SetupOutcome | null;
  exitCode: number | null;
  /** The shell was re-probed: refresh the doctor. */
  reprobed: boolean;
  /** The last output lines (Done only), for the error block's Details. */
  tail: string[];
  /** OB-11: a clone's final event — what it got, or why not. */
  clone?: ProjectCloneResult | null;
}

/** The AI step's sign-in read (`status.claude` / `status.codex`). */
export interface SetupSignInAnswer {
  signedIn: boolean | null;
  method: string | null;
  plan: string | null;
  words: string | null;
}

export function setupRun(
  actionId: SetupRunActionId,
  args?: SetupArgs,
  size?: { cols: number; rows: number },
) {
  return invoke<SetupStarted>("setup_run", {
    actionId,
    args: args ?? null,
    cols: size?.cols ?? null,
    rows: size?.rows ?? null,
  });
}

export function setupStop(runId?: string) {
  return invoke<boolean>("setup_stop", { runId: runId ?? null });
}

export function setupActive() {
  return invoke<SetupStarted | null>("setup_active");
}

/** Only Setup's AI step calls this (D2, D4). */
export function setupCheck(actionId: "status.claude" | "status.codex") {
  return invoke<SetupSignInAnswer>("setup_check", { actionId });
}

/** OB-5: whether an installer's host answered one HEAD (spec §5 step 3,
 *  "Offline"). `proxy`: the failure looked like a proxy's. */
export interface SetupReach {
  reachable: boolean;
  proxy: boolean;
  details: string | null;
}

/** OB-5: checked before an install or update downloads anything. */
export function setupReach(actionId: SetupRunActionId) {
  return invoke<SetupReach>("setup_reach", { actionId });
}

/** OB-5: the pages Setup opens, by id — Rust holds the URLs. */
export type SetupPageId =
  | "get-claude"
  | "get-chatgpt"
  | "install-claude"
  | "install-codex"
  | "install-git-windows"
  /** OB-7a: `I don't have an account` → https://github.com/signup. */
  | "github-signup"
  /** OB-7a: the GitHub CLI's own page (`Do it yourself`). */
  | "install-gh"
  /** Launch A2: where the Plyloft sign-in's code is typed. */
  | "github-device";

export function setupOpenPage(page: SetupPageId) {
  return invoke<void>("setup_open_page", { page });
}

// ── OB-11: Setup's first project (step 8) ──────────────────────────────
// Rust holds every command (`project_setup.rs`); the frontend sends paths the
// folder picker gave, a name, an `owner/name` and a login — never a command.

export type RefusedFolder = "home" | "root" | "system" | "projects-folder" | "volume";

export interface ProjectWorkspaceRef {
  id: string;
  name: string;
  cwd: string;
}

export type ProjectGitState =
  | { kind: "not-repo" }
  | { kind: "inside-another"; topLevel: string; name: string; inPly: ProjectWorkspaceRef | null }
  | { kind: "unborn"; branch: string | null }
  | { kind: "branch"; branch: string; commit: string }
  | { kind: "detached"; commit: string };

/** The row of spec §5 step 8a's table the folder is. */
export type ProjectInspectOutcome =
  | "refused"
  | "already-in-ply"
  | "inside-another-repo"
  | "not-a-repo"
  | "no-commits"
  | "choose-branch"
  | "ready";

export interface ProjectFoundFile {
  /** Relative to the project, `/`-separated. */
  path: string;
  bytes: number;
}

export interface ProjectTopEntry {
  name: string;
  isDir: boolean;
  files: number;
  bytes: number;
}

export interface ProjectSaveSummary {
  files: number;
  bytes: number;
  /** False when the count stopped at 50 000 files or 5 s. */
  complete: boolean;
  /** Over 20 000 files or 1 GB (or the count stopped). */
  huge: boolean;
  /** Largest first ("Show what will be saved"). */
  topLevel: ProjectTopEntry[];
}

/** 1.171.0 D3: a new folder of build output or packages (`node_modules/`). */
export interface ProjectFoundFolder {
  path: string;
  files: number;
}

export interface ProjectInspection {
  path: string;
  name: string;
  outcome: ProjectInspectOutcome;
  refused: RefusedFolder | null;
  refusedWords: string | null;
  git: ProjectGitState;
  branches: string[];
  suggestedBranch: string | null;
  uncommittedChanges: boolean;
  /** 1.171.0 D3: how many files or folders have changes not saved in Git
   *  (0 = none; a new folder counts once). */
  uncommittedFiles: number;
  /** 1.171.0 D3: Git is mid-way combining changes: why saving can't be
   *  offered now. */
  workBlocked?: string | null;
  /** 1.171.0 D3, save-work look: large files / secrets Git already has (left
   *  out, they keep their saved version; no ignore line). */
  workTracked?: string[];
  /** 1.171.0 D3, save-work look: new build/package folders, left out unless
   *  unticked. */
  buildFolders?: ProjectFoundFolder[];
  /** 1.171.0 D3, save-work look: folders that are Git projects of their own,
   *  never saved here. */
  nestedProjects?: string[];
  /** 1.171.0 walk fix, save-work look: the first files the commit saves, by
   *  name (at most 20; `toSave.files` counts them all). */
  workFiles?: string[];
  toSave: ProjectSaveSummary | null;
  /** Over 50 MB: left out unless unticked. */
  largeFiles: ProjectFoundFile[];
  /** Likely passwords or keys: left out unless unticked. */
  secrets: ProjectFoundFile[];
  /** The default `.gitignore` lines `projectInit` adds (not there yet). */
  ignoreLines: string[];
  existingWorkspace: ProjectWorkspaceRef | null;
  sharedDefinition: boolean;
  identityReady: boolean;
  needsIdentity: boolean;
  /** `owner/name` when origin is on github.com (the account question). */
  githubOrigin: string | null;
  hasOrigin?: boolean; githubName?: string | null; // 1.175.0 F3: an origin at all; the name Put it on GitHub gives
  /** `.gitignore` can't be changed safely (a link, not UTF-8): init refuses. */
  ignoreProblem: string | null;
  /** More large files or secrets than listed: init refuses. */
  foundTruncated: boolean;
  /** Large files or secrets a `.gitignore` can't name: init refuses. */
  unnameable: string[];
  /** The sheet's warning when the list can't be vouched for. */
  scanWarning: string | null;
  /** A partial download from an earlier clone is in this folder. */
  partialDownload: boolean;
}

export interface ProjectInitChoices {
  /** Large files and secrets (paths from the inspection) left ticked. */
  leaveOut: string[];
  /** The count stopped at its bound and the person chose to go on. */
  acceptIncomplete?: boolean;
}

export interface ProjectInitDone {
  path: string;
  branch: string;
  commit: string;
  initialised: boolean;
  ignoreAdded: string[];
}

/** OB-12 (step 7): what is at a projects folder (tilde form). */
export interface ProjectsFolderLook {
  /** Expanded. */
  path: string;
  exists: boolean;
  notAFolder: boolean;
  /** Git projects directly inside ("Plyloft found 6 projects here."). */
  projects: number;
}

export function projectsFolderLook(folder: string) {
  return invoke<ProjectsFolderLook>("projects_folder_look", { folder });
}

/** Step 7's `[Use this folder]`: make it when missing; the expanded path. */
export function projectsFolderCreate(folder: string) {
  return invoke<string>("projects_folder_create", { folder });
}

/** Step 8a (read-only). */
export function projectInspect(path: string) {
  return invoke<ProjectInspection>("project_inspect", { path });
}

/** OB-13 (§5 step 9): what the Project settings step shows. */
export type SetupConfigState =
  | "existing"
  | "shared"
  | "proposal"
  | "needsBranch"
  | "noCommit"
  | "notRepo";

export interface SetupConfigView {
  state: SetupConfigState;
  /** existing / shared: the saved config (shared: null until the
   *  definition's refresh wrote it); proposal: the detected one with its
   *  branch; needsBranch: the detected one with an empty `targetBranch`. */
  config: ProjectConfig | null;
  /** Local branches with a commit, most recent first. */
  branches: string[];
  /** needsBranch: the ask's first choice (`master`, else the most recent). */
  suggestedBranch: string | null;
  branchFrom: "chosen" | "head" | "main" | null;
  head: "branch" | "detached" | "unborn" | "notRepo";
  headBranch: string | null;
  /** The check script the scan found (the Change form's switch). */
  detectedVerify: VerifyKind[] | null;
  /** What the version files say now (`1.4.2`). */
  version: string | null;
  readOnly: boolean;
}

/** Step 9 (read-only): never a silent `main` (C10) — the branch chosen in
 *  step 8, else HEAD's, else `main` when it exists, else `needsBranch`. */
export function projectDetectForSetup(workspaceId: string, chosenBranch: string | null) {
  return invoke<SetupConfigView>("project_detect_for_setup", { workspaceId, chosenBranch });
}

/** n16: origin as a start's automatic set-up checks it, from local refs
 *  only (never a fetch). `defaultBranch` is `refs/remotes/origin/HEAD`'s
 *  branch, `null` when there is no such ref. */
export interface LocalOrigin {
  hasOrigin: boolean;
  defaultBranch: string | null;
  /** N18: origin's `owner/repo` when it is on GitHub. */
  githubRepo?: string | null;
}

export function projectLocalOrigin(workspaceId: string) {
  return invoke<LocalOrigin>("project_local_origin", { workspaceId });
}

/** G1 Challenger (6): whether the workspace's Ship it can open a pull
 *  request — the card's `CardOutcome.hasRemote` reading (GitHub, or a host
 *  Plyloft can't tell isn't). */
export function workspaceShipOffersPr(id: string) {
  return invoke<boolean>("workspace_ship_offers_pr", { id });
}

/** Step 8a: `git init -b main` (when needed), `.gitignore`, `git add -A`,
 *  `git commit -m "chore: first commit"` — after the consent sheet. */
export function projectInit(path: string, choices: ProjectInitChoices) {
  return invoke<ProjectInitDone>("project_init", { path, choices });
}

/** 1.171.0 D3: "Save my current work first" — the sheet's look: the
 *  inspection with what saving the folder's changes would put in Git
 *  (read-only). */
export function projectInspectWork(path: string) {
  return invoke<ProjectInspection>("project_inspect_work", { path });
}

export interface ProjectSaveWorkDone {
  path: string;
  /** The folder's own branch: Plyloft never switches it. */
  branch: string;
  commit: string;
  ignoreAdded: string[];
}

/** 1.171.0 D3: one local commit of the folder's changes on its current
 *  branch, on the person's press. Never pushed. */
export function projectSaveWork(path: string, choices: ProjectInitChoices) {
  return invoke<ProjectSaveWorkDone>("project_save_work", { path, choices });
}

/** 1.171.0 D3: the `.gitignore` lines `projectSaveWork` would add for the
 *  new files and folders left out (read-only; never default lines). */
export function projectWorkIgnorePlan(path: string, leaveOut: string[]) {
  return invoke<string[]>("project_work_ignore_plan", { path, leaveOut });
}

export interface UnsavedInFolder {
  /** Files or folders with changes not saved in Git (0 when Git couldn't say). */
  files: number;
  /** The branch the folder is on; null when detached. */
  branch: string | null;
}

/** 1.171.0 D3: a project folder's changes not saved in Git (read-only). */
export function projectUnsavedFiles(path: string) {
  return invoke<UnsavedInFolder>("project_unsaved_files", { path });
}

/** OB-12: the `.gitignore` lines `projectInit` would add for these choices
 *  (read-only) — the sheet's Details show exactly these. `secrets` are the
 *  inspection's secrets' paths. */
export function projectIgnorePlan(path: string, secrets: string[], leaveOut: string[]) {
  return invoke<string[]>("project_ignore_plan", { path, secrets, leaveOut });
}

export type ProjectFolderState = "missing" | "empty" | "has-files" | "not-a-folder";

export interface ProjectNewPreview {
  name: string;
  slug: string | null;
  path: string | null;
  /** `~/Projects/my-app`. */
  displayPath: string | null;
  folder: ProjectFolderState | null;
  insideRepo: string | null;
  problem: string | null;
  placeRefused: boolean;
}

/** Step 8c: the live slug line under the name field. `parent` = the
 *  projects folder when omitted. */
export function projectNewPreview(name: string, parent?: string) {
  return invoke<ProjectNewPreview>("project_new_preview", { name, parent: parent ?? null });
}

export interface ProjectNewRequest {
  name: string;
  parent?: string | null;
  /** `Also keep a private copy on GitHub` (off by default, D10). */
  githubCopy?: { login: string } | null;
}

export type GithubCopyState = "created" | "name-taken" | "failed";

export interface GithubCopyResult {
  state: GithubCopyState;
  repo: string;
  words: string | null;
}

export type ProjectNewOutcome =
  | {
      kind: "created";
      path: string;
      name: string;
      slug: string;
      branch: string;
      commit: string;
      github: GithubCopyResult | null;
    }
  /** `Add that folder instead` (8a with `path`) · `Choose another name`. */
  | { kind: "folder-has-files"; path: string; slug: string; words: string }
  | { kind: "refused"; words: string }
  | { kind: "identity-needed"; words: string };

/** Step 8c: create the project (and, when asked, its private GitHub copy). */
export function projectNew(request: ProjectNewRequest) {
  return invoke<ProjectNewOutcome>("project_new", {
    request: {
      name: request.name,
      parent: request.parent ?? null,
      githubCopy: request.githubCopy ?? null,
    },
  });
}

export type ProjectRepoGroup = "team" | "yours" | "org" | "shared";

export interface ProjectRepoEntry {
  nameWithOwner: string;
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  /** `null` where GitHub's list doesn't say (never read from diskUsage). */
  isEmpty: boolean | null;
  updatedAt: string | null;
  /** KB, approximate. */
  diskUsageKb: number | null;
  defaultBranch: string | null;
  group: ProjectRepoGroup;
  groupOwner: string;
  inPly: ProjectWorkspaceRef | null;
}

export interface ProjectRepoList {
  login: string;
  repos: ProjectRepoEntry[];
  truncated: boolean;
  errors: { source: string; words: string }[];
}

/** Step 8b: the repositories `account` (else gh's active one) can get. */
export function projectRepoList(account?: string) {
  return invoke<ProjectRepoList>("project_repo_list", { account: account ?? null });
}

export type ProjectCloneFailureKind = "auth" | "sso" | "offline" | "cancelled" | "other";

export interface ProjectCloneResult {
  path: string;
  repo: string;
  cloned: boolean;
  /** No commit: the first-commit offer — or, with `remoteBranches`, the
   *  branch question. */
  empty: boolean;
  branch: string | null;
  remoteBranches: string[];
  failure: { kind: ProjectCloneFailureKind; words: string; ssoOrg: string | null } | null;
  /** The folder Plyloft made for the clone was removed. */
  removedPartial: boolean;
}

/** The guided run of a clone (`setup://progress` with this action id). */
export interface ProjectCloneStarted {
  runId: string;
  actionId: "project.clone";
  ptyId: string;
  display: string;
  watch: { kind: "cloned" };
}

/** A clone's `setup://progress` event; the final one carries `clone`. */
export type ProjectCloneProgressEvent = Omit<SetupProgressEvent, "actionId"> & {
  actionId: "project.clone";
  clone?: ProjectCloneResult;
};

export type ProjectCloneStart =
  | { kind: "started"; run: ProjectCloneStarted; path: string }
  | { kind: "destination-exists"; path: string; name: string; words: string }
  | { kind: "already-in-ply"; workspace: ProjectWorkspaceRef; words: string };

/** Step 8b: `gh repo clone` into `destParent` (else the projects folder) in
 *  the guided terminal. Stop with `setupStop(run.runId)`. */
export function projectClone(
  repo: string,
  options?: { destParent?: string; account?: string; size?: { cols: number; rows: number } },
) {
  return invoke<ProjectCloneStart>("project_clone", {
    repo,
    destParent: options?.destParent ?? null,
    account: options?.account ?? null,
    cols: options?.size?.cols ?? null,
    rows: options?.size?.rows ?? null,
  });
}

export interface ProjectFirstPushDone {
  path: string;
  branch: string;
  commit: string;
  pushed: boolean;
  words: string | null;
}

/** Step 8b, an empty repository: README + first commit + `git push -u
 *  origin main`, after the consent sheet. */
export function projectFirstCommitPush(path: string, account?: string) {
  return invoke<ProjectFirstPushDone>("project_first_commit_push", {
    path,
    account: account ?? null,
  });
}

/** SL-3: remember the workspace's "Merge when checks pass" (this Mac). */
export function workspaceSetMergeWhenChecksPass(id: string, on: boolean) {
  return invoke<void>("workspace_set_merge_when_checks_pass", { id, on });
}

/** CL-4: this workspace's own Builder/Challenger models (this Mac only),
 *  merged field by field over the app's `behavior.models`; `cliDefault`
 *  forces a field to the CLI's own default. `null`, or every field blank,
 *  clears them. */
export function workspaceSetModels(id: string, models: WorkspaceModels | null) {
  return invoke<void>("workspace_set_models", { id, models });
}

/** §8.4: the workspace's GitHub account (`null` = gh's active one). */
export function workspaceSetGithubAccount(id: string, login: string | null) {
  return invoke<void>("workspace_set_github_account", { id, login });
}

/** OB-7b: a workspace whose checkout's origin is on github.com, and the
 *  account Plyloft's own GitHub calls for it use (`github_account.rs`). */
export interface WorkspaceGithub {
  id: string;
  name: string;
  /** `owner/name`. */
  repo: string;
  /** origin is SSH: pushes and fetches use the SSH keys. */
  ssh: boolean;
  /** `Workspace.githubAccount`; null = gh's active account. */
  account: string | null;
}

/** OB-7b: Settings › Setup › GitHub accounts — every workspace with a
 *  GitHub origin. Never a token. */
export function githubAccountWorkspaces() {
  return invoke<WorkspaceGithub[]>("github_account_workspaces");
}

// ── OB-6: Setup's Git and identity step ────────────────────────────────

/** Where a prefilled value came from (`setup_identity::PrefillSource`). */
export type IdentityPrefillSource = "git" | "github" | "system" | "none";

/** What the Name and Email fields start with (spec §5 step 4 order). */
export interface IdentityPrefill {
  name: string;
  nameSource: IdentityPrefillSource;
  email: string;
  emailSource: IdentityPrefillSource;
  /** GitHub's private address, when the account's email is private. */
  githubNoreply: string | null;
  githubLogin: string | null;
}

export interface IdentityWritten {
  name: string;
  email: string;
}

export function setupIdentityPrefill() {
  return invoke<IdentityPrefill>("setup_identity_prefill");
}

/** After the consent sheet: `git config --global user.name/user.email`,
 *  values as argv, read back. Also sets `settings.identity.userEmail`. */
export function setupIdentityWrite(name: string, email: string) {
  return invoke<IdentityWritten>("setup_identity_write", { name, email });
}

/** `Do it yourself`: Git's downloads page (a fixed URL in Rust). */
export function setupOpenGitDownloads() {
  return invoke<void>("setup_open_git_downloads");
}

// ── OB-7a: Setup's GitHub step ─────────────────────────────────────────

/** One github.com account's state (`setup_github::AccountState`). */
export type GithubAccountState = "signed-in" | "refused" | "unknown";

/** One github.com account from `gh auth status --json hosts` — never a
 *  token. */
export interface GithubAccount {
  login: string;
  active: boolean;
  state: GithubAccountState;
  /** `"gist, read:org, repo"`, when gh says. */
  scopes: string | null;
}

/** Who git asks for github.com's password (`setup_github::HelperState`). */
export type GithubHelperState = "gh" | "gcm" | "other" | "none" | "unknown";

/** What the GitHub step reads (`setup_github_status`). */
export interface GithubStatus {
  ghFound: boolean;
  /** Null when gh's answer couldn't be read. */
  accounts: GithubAccount[] | null;
  helper: GithubHelperState;
  githubEmail: string | null;
  githubNoreply: string | null;
  /** A SAML single sign-on refusal, and the organisation when gh named it. */
  sso: { org: string | null } | null;
  /** N14 item 7: Git Credential Manager's github.com sign-in (Windows, the
   *  step's own read only), against the account Setup uses. Never a secret. */
  gcm?: GcmSignIn | null;
}

/** `setup_github::GcmSignIn`. */
export interface GcmSignIn {
  state: "same" | "other" | "none" | "unknown";
  /** The account GCM answered for, when it is a GitHub login. */
  login: string | null;
}

/** `details`: also ask GitHub for the account's address (the step itself). */
export function setupGithubStatus(details = false) {
  return invoke<GithubStatus>("setup_github_status", { details });
}

/** `Authorize`: the organisation's SSO page (Rust builds the URL from the
 *  validated login). */
export function setupOpenGithubSso(org: string) {
  return invoke<void>("setup_open_github_sso", { org });
}

export function onSetupProgress(
  handler: (e: SetupProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<SetupProgressEvent>("setup://progress", (e) => handler(e.payload));
}

export type FileChangeKind = "modified" | "created" | "removed";

export interface FileChangeEvent {
  workspaceId: string;
  path: string;
  kind: FileChangeKind;
}

/** QoL walk of block 6: Help › Keyboard Shortcuts was chosen (macOS menu). */
export function onMenuShortcuts(handler: () => void): Promise<UnlistenFn> {
  return listen("menu://shortcuts", () => handler());
}

/** QoL 1.168 S3: a menu item the page answers — the Mac's Plyloft › Check
 *  for Updates… and Help items, the Windows tray's Check for Updates…. */
export type MenuHelpAction = "check-updates" | "guide" | "whats-new" | "getting-started";

export function onMenuHelp(handler: (action: MenuHelpAction) => void): Promise<UnlistenFn> {
  return listen<MenuHelpAction>("menu://help", (e) => handler(e.payload));
}

export function onFileChange(
  handler: (e: FileChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<FileChangeEvent>("fs://changed", (e) => handler(e.payload));
}

/** 1.174.0 E1: which of `paths` git ignores in `cwd` (one batched
 *  `git check-ignore`; a folder git can't answer for ignores nothing). */
export function fsIgnoredPaths(cwd: string, paths: string[]) {
  return invoke<string[]>("fs_ignored_paths", { cwd, paths });
}

export function watchWorkspace(workspaceId: string, cwd: string) {
  return invoke<void>("fs_watch_workspace", { workspaceId, cwd });
}

export function unwatchWorkspace(workspaceId: string) {
  return invoke<void>("fs_unwatch_workspace", { workspaceId });
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeHidden: boolean;
  glob?: string;
}

export interface SearchMatch {
  workspaceId: string;
  path: string;
  lineNumber: number;
  lineText: string;
  matchText: string;
  columnStart: number;
  columnEnd: number;
}

export type SearchDoneStatus =
  | "completed"
  | "cancelled"
  | "capped"
  | "noRipgrep"
  | "error";

export interface SearchDoneEvent {
  workspaceId: string;
  status: SearchDoneStatus;
  message: string | null;
  total: number;
}

export function searchStart(
  workspaceId: string,
  cwd: string,
  query: string,
  options: SearchOptions,
) {
  return invoke<void>("search_start", { workspaceId, cwd, query, options });
}

export function searchCancel(workspaceId: string) {
  return invoke<void>("search_cancel", { workspaceId });
}

export function ripgrepAvailable() {
  return invoke<boolean>("ripgrep_available");
}

export function onSearchResult(
  handler: (m: SearchMatch) => void,
): Promise<UnlistenFn> {
  return listen<SearchMatch>("search://result", (e) => handler(e.payload));
}

export function onSearchDone(
  handler: (e: SearchDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<SearchDoneEvent>("search://done", (e) => handler(e.payload));
}

// ── v1.25.0 (Cycle G2): history search ──────────────────

export type HistoryKind =
  | "card"
  | "runRecord"
  | "runTranscript"
  | "snapshot"
  | "intakeTranscript"
  | "swarmMailbox";

/** Tagged enum matching `history_search.rs::HistoryScope`. */
export type HistoryScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "global"; workspaceId?: never };

export interface HistoryHit {
  kind: HistoryKind;
  workspaceId: string | null;
  artifactId: string;
  /** QoL 11.3: a card hit's card (the board line's card), when known. */
  cardId?: string | null;
  /** The card's title, for the row. */
  cardTitle?: string | null;
  path: string;
  lineNumber: number;
  lineText: string;
  matchText: string;
}

export type HistoryDoneStatus =
  | "completed"
  | "cancelled"
  | "capped"
  | "noRipgrep"
  | "error";

export interface HistoryDoneEvent {
  status: HistoryDoneStatus;
  message: string | null;
  total: number;
}

export function historySearchStart(query: string, scope: HistoryScope) {
  return invoke<void>("history_search_start", { query, scope });
}

export function historySearchCancel() {
  return invoke<void>("history_search_cancel");
}

export function onHistoryResult(
  handler: (hit: HistoryHit) => void,
): Promise<UnlistenFn> {
  return listen<HistoryHit>("history://result", (e) => handler(e.payload));
}

export function onHistoryDone(
  handler: (e: HistoryDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<HistoryDoneEvent>("history://done", (e) => handler(e.payload));
}

export interface WindowDropEvent {
  paths: string[];
  position: [number, number];
  windowLabel: string;
}

export function onWindowDrop(
  handler: (e: WindowDropEvent) => void,
): Promise<UnlistenFn> {
  return listen<WindowDropEvent>("window://drop", (e) => handler(e.payload));
}

/**
 * v1.5.7: emitted by the warm-path single-instance plugin callback after
 * the CLI shim's `atelier <path>` resolves to a focused/created workspace.
 * Without this signal, the backend mutates workspaces.json but the React
 * sidebar stays stale (Phase 2 Test 2 / Bug #1).
 */
export function onWorkspaceActivated(
  handler: (workspaceId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("workspace://activated", (e) => handler(e.payload));
}

export interface FileIndex {
  /** Workspace-relative paths, forward-slash separated. */
  paths: string[];
  /** True if the walker bailed early on the size or depth cap. */
  truncated: boolean;
}

/**
 * Recursive walk of `cwd`, returning a flat list of relative file paths.
 * QoL 6.1: leaves out what the project's `.gitignore` files leave out, the
 * noisy dirs (.git, node_modules, target…) and — unless `includeHidden`
 * (Settings › Code › Show hidden files) — dotfiles. Used by Go to file (⌘P),
 * which caches it per workspace (`PaletteScopes.tsx`).
 */
export function fsListFilesRecursive(cwd: string, includeHidden = false) {
  return invoke<FileIndex>("fs_list_files_recursive", { cwd, includeHidden });
}

// ── QoL 6.3: file operations from the Code tree ──────────────────────
// Every one is refused outside the workspace's own folder (`files.rs`).

/** New file: an empty `name` in `dir`; answers its path. */
export function fsCreateFile(workspaceId: string, dir: string, name: string) {
  return invoke<string>("fs_create_file", { workspaceId, dir, name });
}

/** New folder: `name` in `dir`; answers its path. */
export function fsCreateDir(workspaceId: string, dir: string, name: string) {
  return invoke<string>("fs_create_dir", { workspaceId, dir, name });
}

/** Rename in place; answers the new path. */
export function fsRenameEntry(workspaceId: string, path: string, newName: string) {
  return invoke<string>("fs_rename_entry", { workspaceId, path, newName });
}

/** Move to the Trash (the Recycle Bin on Windows); answers Undo's token. */
export function fsTrashEntry(workspaceId: string, path: string) {
  return invoke<string>("fs_trash_entry", { workspaceId, path });
}

/** Undo of `fsTrashEntry`; answers the path it is back at. */
export function fsUndoTrash(token: string) {
  return invoke<string>("fs_undo_trash", { token });
}

/** Reveal a file or a folder of the workspace in Finder / File Explorer. */
export function fsRevealEntry(workspaceId: string, path: string) {
  return invoke<void>("fs_reveal_entry", { workspaceId, path });
}

/** QoL 6.4: what a file dropped on the editor opens as. */
export interface DroppedOpen {
  path: string;
  /** The workspace's own file (`true`), or a read-only copy outside it. */
  inside: boolean;
}

/** QoL 6.4: a file dropped from Finder / File Explorer onto the editor —
 *  found in the workspace by its bytes, or kept as a copy. Call it through
 *  `openDroppedFile` (lib/droppedFile.ts), which reads the file whole. */
export function fsOpenDropped(
  workspaceId: string,
  name: string,
  bytes: Uint8Array,
  modifiedMs: number | null,
) {
  const headers: Record<string, string> = {
    "x-ply-workspace-id": workspaceId,
    "x-ply-file-name": droppedNameHeader(name),
    "x-ply-expected-len": String(bytes.length),
  };
  if (modifiedMs !== null) headers["x-ply-modified-ms"] = String(Math.trunc(modifiedMs));
  return invoke<DroppedOpen>("fs_open_dropped", bytes, { headers });
}

/** D3 (1.172.2): a dropped file's name as a header value. A header is
 *  ASCII, so the name goes percent-encoded (`encodeURIComponent`); a lone
 *  surrogate, which no UTF-8 can carry, becomes U+FFFD first — a drop is
 *  never refused for its name (Plyloft's copy is renamed anyway). */
export function droppedNameHeader(name: string): string {
  return encodeURIComponent(
    // No lookbehind: an older WebKit can't parse one, and the whole bundle fails.
    name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD")),
  );
}

/** QoL 6.4: "Copy into the project" — a dropped file's copy into the
 *  workspace folder, never over a file there; answers the new path. */
export function fsCopyIntoWorkspace(workspaceId: string, source: string, name: string) {
  return invoke<string>("fs_copy_into_workspace", { workspaceId, source, name });
}

/** One folder's entries, dotfiles left out unless `includeHidden` (the Files
 *  panel's own read). Getting started TU-5: the empty-project look reads a
 *  few folders this way and stops at the first source file. */
export function fsListDir(path: string, includeHidden = false) {
  return invoke<DirEntry[]>("fs_list_dir", { path, includeHidden });
}

/**
 * Persist bytes from a drag-dropped external file (Finder → tile) into the
 * app cache and return the resulting absolute path. The browser File API
 * doesn't expose `File.path` so the bytes have to round-trip through Rust.
 * GH #230: call it through `saveDroppedFile` (lib/droppedFile.ts), which
 * reads the file whole first; Rust refuses bytes that arrive short of
 * `expectedLen`. D3 (1.172.2): the bytes are the raw request body (never a
 * JSON number array, ~4× the file), the name and length are headers.
 */
export function fsSaveDroppedFile(name: string, bytes: Uint8Array) {
  return invoke<string>("fs_save_dropped_file", bytes, {
    headers: {
      "x-ply-file-name": droppedNameHeader(name),
      "x-ply-expected-len": String(bytes.length),
    },
  });
}

export function filesOrderGet(workspaceId: string, dir: string) {
  return invoke<string[] | null>("files_order_get", { workspaceId, dir });
}

export function filesOrderSet(
  workspaceId: string,
  dir: string,
  order: string[],
) {
  return invoke<void>("files_order_set", { workspaceId, dir, order });
}

export function filesOrderClear(workspaceId: string, dir: string) {
  return invoke<void>("files_order_clear", { workspaceId, dir });
}

// ── Agents ──────────────────────────────────────────────

export type AgentScope = "workspace" | "project";
export type RuntimeMode = "repl" | "oneshot";
export type AgentStatus = "pending" | "running" | "done" | "error" | "killed";
export type AgentTrigger = "manual" | "scheduled" | "event" | "swarm";

// GH #171: scheduled and triggered agents are retired. `schedule` and
// `triggers` still arrive on an old config and are never acted on; the
// `scheduled` / `event` triggers appear only on old run records.
export interface AgentScheduleConfig {
  /** 5-field POSIX cron: minute hour day-of-month month day-of-week */
  cron: string;
}

export type AgentTriggerEvent =
  | { type: "fileChanged"; glob: string }
  | { type: "agentFinished"; agentId: string };

export interface AgentConfig {
  schemaVersion: number;
  id: string;
  scope: AgentScope;
  workspaceId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  runtimeMode: RuntimeMode;
  promptTemplate: string;
  allowedTools: string[];
  schedule: AgentScheduleConfig | null;
  triggers: AgentTriggerEvent[];
  /** Free-form tags for grouping/filtering. Comma-separated in the UI. */
  tags: string[];
  /**
   * Whether to post a native notification when this agent's runs end.
   * AND'd with the global behavior.notifyOnAgentDone settings flag.
   */
  notifyOnDone: boolean;
  /** v1.0: stable id for swarm-seeded role configs ("scout"/"builder"/"reviewer"). null for user-created. */
  presetId?: string | null;
  /** v1.1: most recent pre-reseed snapshot of systemPrompt + promptTemplate. */
  previousVersion?: PreviousAgentVersion | null;
  createdAt: number;
  updatedAt: number;
  /** v1.49.0 (Team Mode Phase 0): provenance. Stamped by the backend
   *  on every mutation from the cached identity email. `author` is set
   *  once at create-time; `lastEditedBy` is rewritten on every update. */
  author?: string | null;
  lastEditedBy?: string | null;
}

export interface PreviousAgentVersion {
  systemPrompt: string;
  promptTemplate: string;
  replacedAt: number;
}

/** v0.9.0 G1: token totals from claude stream-json (oneshot only). */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** v1.21.0 (Phase 3): codex emits this as a separate `turn.completed.usage`
   * line item; claude leaves it 0. Default-0 on pre-Phase-3 records. */
  reasoningOutputTokens?: number;
}

export interface AgentRun {
  schemaVersion: number;
  id: string;
  agentId: string;
  agentName: string;
  workspaceId: string;
  trigger: AgentTrigger;
  runtimeMode: RuntimeMode;
  status: AgentStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  ptyId: string | null;
  transcriptPath: string;
  bytesWritten: number;
  error: string | null;
  /** v0.9.0: token totals (oneshot only). null on legacy runs. */
  usage?: RunUsage | null;
  /** v0.9.0: model claude reported (e.g. "claude-sonnet-4-7"). null on legacy. */
  model?: string | null;
  /** 1.168.1: the CLI the run went through ("claude" | "codex"); absent on
   *  runs recorded before it. */
  provider?: "claude" | "codex" | null;
  /** v0.9.0: total cost in USD reported by claude. null on legacy. */
  totalCostUsd?: number | null;
  /** v1.0: Swarm. Set when this run was spawned by SwarmRegistry. null otherwise. */
  swarmId?: string | null;
  /** v1.0: Swarm. Parsed `<cwd>/.atelier/swarm/<runId>/artifact.json` if present. null otherwise. */
  swarmArtifact?: unknown | null;
}

export function agentList(workspaceId: string, projectCwd: string) {
  return invoke<AgentConfig[]>("agent_list", { workspaceId, projectCwd });
}

export function agentGet(opts: {
  agentId: string;
  scope: AgentScope;
  workspaceId?: string | null;
  projectCwd?: string | null;
}) {
  return invoke<AgentConfig>("agent_get", {
    agentId: opts.agentId,
    scope: opts.scope,
    workspaceId: opts.workspaceId ?? null,
    projectCwd: opts.projectCwd ?? null,
  });
}

// GH #171: `agentCreate` / `agentUpdate` / `agentDelete` went with Settings ›
// Agents, their only caller. Agents already on disk still load and run.

export function agentRunStart(opts: {
  agentId: string;
  scope: AgentScope;
  workspaceId: string;
  projectCwd: string;
  promptOverride?: string | null;
}) {
  return invoke<AgentRun>("agent_run_start", {
    agentId: opts.agentId,
    scope: opts.scope,
    workspaceId: opts.workspaceId,
    projectCwd: opts.projectCwd,
    promptOverride: opts.promptOverride ?? null,
  });
}

export interface WriterConflict {
  worktreeKey: string;
  activeSessionId: string;
  activeExecutionKind: CoordinationExecutionKind;
}

export type AgentRunRequestResult =
  | { kind: "started"; run: AgentRun }
  | { kind: "busy"; conflict: WriterConflict };

export interface WriterQueueReceipt {
  id: string;
  position: number;
  duplicate: boolean;
}

export interface WriterQueueChangedEvent {
  id: string;
  workspaceId: string;
  label: string;
  status: "started" | "failed";
  error: string | null;
}

type AgentRunRequestOptions = {
  agentId: string;
  scope: AgentScope;
  workspaceId: string;
  projectCwd: string;
  promptOverride?: string | null;
  cardId?: string | null;
};

export function agentRunRequest(opts: AgentRunRequestOptions) {
  return invoke<AgentRunRequestResult>("agent_run_request", {
    agentId: opts.agentId,
    scope: opts.scope,
    workspaceId: opts.workspaceId,
    projectCwd: opts.projectCwd,
    promptOverride: opts.promptOverride ?? null,
    cardId: opts.cardId ?? null,
  });
}

export function agentRunQueue(opts: AgentRunRequestOptions) {
  return invoke<WriterQueueReceipt>("agent_run_queue", {
    agentId: opts.agentId,
    scope: opts.scope,
    workspaceId: opts.workspaceId,
    projectCwd: opts.projectCwd,
    promptOverride: opts.promptOverride ?? null,
    cardId: opts.cardId ?? null,
  });
}

export function onWriterQueueChanged(
  handler: (event: WriterQueueChangedEvent) => void,
) {
  return listen<WriterQueueChangedEvent>("writer-queue://changed", (event) =>
    handler(event.payload),
  );
}

export function agentRunList(opts: {
  agentId?: string | null;
  workspaceId?: string | null;
  limit?: number | null;
}) {
  return invoke<AgentRun[]>("agent_run_list", {
    agentId: opts.agentId ?? null,
    workspaceId: opts.workspaceId ?? null,
    limit: opts.limit ?? null,
  });
}

export function agentRunGet(runId: string) {
  return invoke<AgentRun>("agent_run_get", { runId });
}

export function agentRunKill(runId: string) {
  return invoke<void>("agent_run_kill", { runId });
}

export function agentTranscriptRead(runId: string, offset: number = 0) {
  return invoke<string>("agent_transcript_read", { runId, offset });
}

export interface AgentRunStartedEvent {
  runId: string;
  agentId: string;
  workspaceId: string;
  trigger: AgentTrigger;
}

export interface AgentOutputEvent {
  runId: string;
  agentId: string;
  data: number[];
  offset: number;
}

export interface AgentRunDoneEvent {
  runId: string;
  agentId: string;
  status: AgentStatus;
  exitCode: number | null;
  endedAt: number | null;
  /** v1.0: Swarm. Set when this run was spawned by SwarmRegistry. null otherwise. */
  swarmId?: string | null;
  /** v1.22.0: error transcript when status === "error". Frontend pattern-matches
   * codex quota-exhausted strings (rate_limit / quota / insufficient_quota)
   * to swap the generic toast for a quota-specific one. Undefined on success. */
  error?: string | null;
}

export function onAgentRunStarted(
  handler: (e: AgentRunStartedEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentRunStartedEvent>("agent://run-started", (e) =>
    handler(e.payload),
  );
}

export function onAgentOutput(
  handler: (e: AgentOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentOutputEvent>("agent://output", (e) => handler(e.payload));
}

export function onAgentRunDone(
  handler: (e: AgentRunDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentRunDoneEvent>("agent://run-done", (e) => handler(e.payload));
}

// ── Kanban ─────────────────────────────────────────────

export type KanbanColumnId =
  | "todo"
  | "in_progress"
  | "complete";

export type KanbanLastRunStatus =
  | "running"
  | "success"
  | "failed"
  | "aborted"
  /** v1.31.0 (Cycle 1): the linked swarm was rate-limited, not genuinely
   *  failed — the card stays queue-eligible for an auto-retry. */
  | "rate_limited";

/** v1.7.0: lifecycle state of a card's intake conversation. */
export type IntakeStatus = "none" | "active" | "ready";

/** v1.5.x: system-managed receipt for one completed run, attached to the
 *  originating kanban card. Never user-edited; never injected into the
 *  next run's prompt — see docs/PATTERNS.md. */
export interface RunHistoryEntry {
  runId: string;
  status: AgentStatus;
  endedAt: number;
  filesChangedCount: number;
  topPaths: string[];
  swarmId?: string | null;
  swarmTemplateId?: string | null;
  swarmCollisions: number;
  agentConfigId?: string | null;
  /** Number of legs aggregated into this entry; >1 for coordinator-mode
   *  swarms. Defaults to 1 when missing on legacy data. */
  legs?: number;
}

/** v1.10.0: per-card file attachment metadata. The bytes themselves
 *  live under `<app_config>/attachments/<workspace>/<card>/`. */
export interface CardAttachment {
  id: string;
  displayName: string;
  storedPath: string;
  sizeBytes: number;
  mimeType?: string | null;
  addedAt: number;
}

/** v1.106.0 (Builder/Challenger E1): one "Build done" snapshot commit. */
export interface BuildSnapshot {
  n: number;
  sha: string;
  at: number;
}

/** v1.106.0: the card's live Builder session. `ptyId` is runtime-only —
 *  cleared by the backend on load with `sessionLost: true`. */
/** v1.108.0 (Builder/Challenger D7/E2): the Challenger's review of the
 *  latest build snapshot. */
export interface BuilderReview {
  snapshotN: number;
  provider: "claude" | "codex";
  degraded: boolean;
  /** OB-14 (§13.2): the same-vendor review ran because the other vendor
   *  isn't installed — a one-AI setup, not a fault. Absent on older reviews. */
  singleVendor?: boolean;
  status: "running" | "done" | "failed" | "skipped";
  /** GH #58: "incomplete" — the reviewer could not see enough of the
   *  change to judge it. Its own outcome: not a request for changes. */
  verdict?: "approve" | "changes_requested" | "incomplete" | null;
  reviewId?: string | null;
  excerpt?: string | null;
  error?: string | null;
  at: number;
  /** On a `skipped` review: the human's recorded decision, e.g. "changes
   *  requested on snapshot 5, overridden by the human". */
  note?: string | null;
  /** Who overrode a changes-requested verdict (settings email); `at` is when. */
  overriddenBy?: string | null;
  /** GH #58: passes the complete diff was reviewed in; absent before passes. */
  passCount?: number | null;
  /** GH #58: files in the reviewed diff. */
  fileCount?: number | null;
  /** GH #58: why an incomplete review is incomplete ("diff too large"). */
  incompleteReason?: string | null;
  /** #74: the model the Challenger reviewed on ("gpt-6-astra medium").
   *  Absent when its row is blank, and on reviews recorded before #74. */
  model?: string | null;
  /** GH #99: the commit the review read. A verdict belongs to this
   *  revision. Absent while running, when the review failed before pinning
   *  one, and on reviews before GH #99 (the snapshot's sha stands in). */
  reviewedRevision?: string | null;
  /** GH #99: a failed review's reason in words ("The Challenger's model
   *  was at capacity."); `error` keeps the raw text. While `retryAt` is
   *  set, why the review is being retried. */
  failureReason?: string | null;
  /** GH #99: while running, the one automatic retry starts at this time. */
  retryAt?: number | null;
  /** GH #99: the review used its automatic retry. */
  retried?: boolean;
  /** GH #99: on a failed review, commits since the last completed one. */
  commitsSinceReview?: number | null;
  /** GH #99: on a done review, passes that failed even after the retry —
   *  their files were not reviewed, whatever the merged verdict says. */
  failedPasses?: number | null;
  /** ADR 0006: "sweep" for the card's first review, "follow-up" after
   *  ("review" on reviews before the follow-up card). Set when the review
   *  starts; a follow-up that falls back to a sweep becomes "sweep" while it
   *  runs. Absent before ADR 0006 (a review). */
  kind?: ReviewKind;
  /** ADR 0006: the sweep ran a synthesis pass after its passes. */
  synthesisPass?: boolean;
  /** ADR 0006: P1 and P2 findings, P1 first — what the verdict is about. */
  findings?: ReviewFinding[];
  /** ADR 0006: P3 and pre-existing findings. They never block, and the
   *  Builder gets them as optional. */
  nonBlocking?: ReviewFinding[];
  /** ADR 0006: the reviewer's risk checklist, one line per class. */
  checklist?: string[];
  /** The failed passes by name ("pass 2 of 3", "the synthesis pass"). */
  failedPassNames?: string[];
  /** Some findings could not be read into `findings`: the excerpt holds
   *  them in the reviewer's words. */
  findingsUnread?: boolean;
  /** On a request for changes, the complete message for the Builder, built
   *  by the backend from every blocking finding in full. */
  builderHandoff?: string | null;
  /** ADR 0006: why a follow-up review ran as a sweep, in words. */
  followUpFallback?: string | null;
  /** Review integrity: why the reviewed range's base is not the plain one
   *  checked against origin's real tip (origin unreachable, a local ref
   *  ahead of origin not used). Absent otherwise and on older reviews. */
  baseNote?: string | null;
  /** ADR 0006: why Ply requests changes although the reviewer wrote
   *  otherwise — earlier findings still open. */
  ledgerNote?: string | null;
  /** ADR 0006: the card's findings ledger as this review left it. Empty
   *  on reviews before it. */
  ledger?: LedgerFinding[];
  /** CL-2: the skills the Challenger says it followed (GH #216). Absent on
   *  reviews before CL-2 — `skillsFollowedOf` reads those from the
   *  excerpt's `Followed:` line. */
  skillsFollowed?: SkillFollowed[];
  /** CL-5: the ledger round this review was folded in as, with its counts.
   *  Absent while running, on reviews the ledger did not fold, and before CL-5. */
  round?: RoundCounts | null;
  /** Findings filter: the review did not read everything it was given, so
   *  a dismissal never turns it into an approval. Absent while false. */
  partial?: boolean;
}

/** CL-5: what one folded review round did to the card's ledger. */
export interface RoundCounts {
  round: number;
  /** Blocking findings raised for the first time. */
  new: number;
  /** Non-blocking findings raised for the first time. */
  notes?: number;
  closed: number;
  /** Blocking findings of earlier rounds still open after it. */
  stillOpen: number;
  /** CL-5 round 2: the ids behind the counts, as the fold saw them —
   *  what "See its findings" shows. `newIds` holds the notes too. */
  newIds?: string[];
  closedIds?: string[];
  stillOpenIds?: string[];
}

/** CL-5: one completed review round of a card, as the card keeps it. */
export interface ReviewRound extends RoundCounts {
  /** The ledger's own round number; `round` is the card's, which goes on
   *  when a ledger starts over. */
  ledgerRound?: number;
  /** The ledger started over at this round: earlier rounds' ids name
   *  findings that are gone. */
  ledgerRestart?: boolean;
  /** The rounds before this one were recorded and later dropped by the
   *  card's cap of 100. */
  trimmedBefore?: boolean;
  /** "approve" | "changes_requested" | "incomplete". */
  verdict: string;
  at: number;
  /** "claude" | "codex" — the vendor that reviewed. */
  provider: string;
  reviewId: string;
  snapshotN: number;
  /** 1.169.0 (A3): the model the round reviewed on, as recorded. */
  model?: string | null;
}

/** 1.169.0 (A3): one "Retry on…" of a round (`kanban.rs::ModelRetry`). */
export interface ModelRetry {
  role: "builder" | "challenger";
  vendor: "claude" | "codex";
  at: number;
  /** When the attempt it retried started. */
  fromStartedAt?: number | null;
  /** The attempt it retried ran on, when it said. */
  fromModel?: string | null;
  /** How that attempt ended: finished, stopped, ended, failed, or a verdict. */
  fromOutcome?: string | null;
  /** The model and effort it was retried on; absent = the tool's default. */
  model?: string | null;
  /** How the retry ended, once it has. */
  outcome?: string | null;
}

/** 1.169.0 (A3): a retry's choice — the round's own start carries it. */
export interface RetryChoice {
  model: string | null;
  reasoning: string | null;
}

/** 1.169.0 (A3): the vendor the Challenger's retry will review with. */
export function cardRetryPlan(workspaceId: string, cardId: string) {
  return invoke<{ vendor: "claude" | "codex" }>("card_retry_plan", { workspaceId, cardId });
}

/** 1.169.0 (A3): the Challenger reviews the current snapshot again on
 *  `retry`, this once — even after a verdict. `vendor` is the menu's: a
 *  review that runs on another drops the choice (`retry-on://dropped`). */
export function builderReviewRetry(workspaceId: string, cardId: string, vendor: "claude" | "codex", retry: RetryChoice) {
  return invoke<number>("builder_review_retry", { workspaceId, cardId, vendor, retry });
}

/** ADR 0006: which review a Challenger review is. */
export type ReviewKind = "sweep" | "review" | "follow-up";

/** ADR 0006: a finding's state in the card's ledger. */
export type FindingState = "open" | "closed" | "still-open";

/** ADR 0006: one finding in the card's ledger (`review_ledger.rs`). */
export interface LedgerFinding {
  /** "F3": unique within the card, never reused. */
  id: string;
  severity: string | null;
  preExisting: boolean;
  /** Reported as a note (an approving pass's, or under Non-blocking),
   *  whatever its severity: never blocks. Absent on ledgers before it. */
  note?: boolean;
  /** `path:line`, when the answer gave one. */
  location: string | null;
  title: string;
  /** The finding's complete text. */
  body: string;
  reviewId: string;
  /** The round that raised it; 1 is the card's first completed review. */
  round: number;
  state: FindingState;
  /** The reviewer's reason for the current state. */
  reason: string | null;
  updatedRound: number;
  /** ADR 0006 (third card): raised by a follow-up, which marked its defect
   *  as already in the code the sweep read. Absent on ledgers before it. */
  sweepSaw?: boolean;
  /** CL-6: the file and line it names, and the revision the line belongs
   *  to. Absent before CL-6 and when the reviewer named no path or line. */
  path?: string;
  line?: number;
  reviewedRevision?: string;
  /** Findings filter: whether it blocks under the workspace's threshold at
   *  the last fold, where that differs from the default rule. Absent
   *  otherwise, and on ledgers before it. */
  blocking?: boolean;
  /** Findings filter: the member dismissed it as not a real issue. */
  dismissal?: FindingDismissal | null;
}

/** Findings filter: a "Not a real issue" dismissal (`review_ledger.rs::Dismissal`). */
export interface FindingDismissal {
  reason?: string | null;
  by?: string | null;
  at: number;
  round: number;
}

/** ADR 0006 (third card): how a Builder's self-check ended. */
export type SelfCheckOutcome = "answered" | "skipped" | "timedOut";

/** ADR 0006 (third card): one self-check, as the card keeps it
 *  (`kanban.rs::SelfCheckRecord`). */
export interface SelfCheckRecord {
  outcome: SelfCheckOutcome;
  startedAt: number;
  durationMs: number;
  /** The snapshot Build done took after it. */
  snapshotN?: number | null;
}

/** ADR 0006 (third card): how long Build done waits for the Builder to come
 *  back from its self-check. Mirrors `builder.rs::SELF_CHECK_TIMEOUT_SECS`. */
export const SELF_CHECK_TIMEOUT_SECS = 600;

/** ADR 0006: the card `Ship with follow-up` made for a card's open
 *  findings. */
export interface FollowUpCard {
  cardId: string;
  /** "#140", or the title in quotes on a board without issues. */
  cardRef: string;
  findingIds: string[];
  /** The ship went through with it. */
  shipped: boolean;
}

/** ADR 0006: one finding the Challenger reported (`review_passes.rs`). */
/** GH #216 / CL-2: one skill the reviewer followed, and what it asked of
 *  the review (verbatim; "" when nothing). */
export interface SkillFollowed {
  skill: string;
  note: string;
}

export interface ReviewFinding {
  /** "P1" | "P2" | "P3"; null when the reviewer wrote none. */
  severity: string | null;
  title: string;
  /** The finding as the reviewer wrote it, bounded. */
  body: string;
  /** In code the change did not write or alter: never blocks. */
  preExisting: boolean;
  /** "pass 2 of 3" or "synthesis pass" when the review ran in passes. */
  pass: string | null;
  /** `path:line` from a JSON answer. */
  location?: string | null;
  /** The finding's id in the card's ledger ("F3"). */
  id?: string | null;
  /** ADR 0006 (third card): a follow-up's finding in code the sweep read. */
  sweepSaw?: boolean;
}

export interface BuilderState {
  vendor: "claude" | "codex";
  bypass: boolean;
  /** #74: the model this session was spawned on ("opus"). Absent when the
   *  Builder row is blank, and on sessions started before #74. */
  model?: string | null;
  /** CL-8 round 2: the model chosen at Build with both's start for the
   *  build this card continues from; its Resume runs on it. */
  chosenModel?: LaneModel | null;
  /** UX P-C: the permission mode this session was started in — only ever
   *  "acceptEdits", which Rust grants to the unedited guided first card
   *  while its guide runs. Resume keeps it. Absent on every other session
   *  and on cards written before P-C. */
  permissionMode?: string | null;
  /** 1.171.0 (D1): the choice this session started in, which Resume keeps
   *  (`builderPermissions.ts`). Absent on sessions started before it and
   *  on the tour card's own bounded start. */
  permissions?: "editsCopy" | "asks" | "neverAsks" | null;
  ptyId?: string | null;
  sessionLost: boolean;
  /** 1.169.0 (A3): lost because Plyloft quit or restarted (Resume's case). */
  lostOnRestart?: boolean;
  /** 1.171.0 C2: when Finish and check asked for the Builder's self-check,
   *  until that Finish and check went on (`builder::done` clears it). Left
   *  behind when Plyloft quit (or the session ended) during it: the card
   *  says so and offers Finish and check again. Absent on older cards. */
  selfCheckStartedAt?: number | null;
  /** 1.175.0 F6: the pull request draft asked during the review (`pr_draft.rs::PrDraftRecord`); absent: none. */
  prDraft?: { requestId: string; commit: string; askedAt: number } | null;
  /** v1.154.1 (F17): the last Resume ended at once — usually nothing to
   *  continue in this worktree. Absent on cards written before it. */
  resumeFailed?: boolean;
  startedAt: number;
  snapshots: BuildSnapshot[];
  review?: BuilderReview | null;
  /** GH #99: the revision the last completed Challenger review read. */
  lastReviewedRevision?: string | null;
  /** GH #99: the "Last commit not reviewed" line as it stood when the card
   *  shipped (what the PR body says); a later review does not change it. */
  shippedUnreviewed?: string | null;
  /** ADR 0006: a review of this card completed with a verdict, so later
   *  reviews are not the sweep. */
  firstReviewDone?: boolean;
  /** ADR 0006: changes-requested verdicts this card received. */
  changesRequestedCount?: number;
  /** ADR 0006: the card `Ship with follow-up` made for its open findings. */
  followUp?: FollowUpCard | null;
  /** ADR 0006 (third card): the self-check at the last Build done that ran
   *  one. Absent when none ran, and on cards before it. */
  selfCheck?: SelfCheckRecord | null;
  /** GH #124: a Build done that came while the Challenger was still
   *  reviewing this card — the snapshot reviewed next. A newer one replaces
   *  it. Absent when none waits, and on cards before it. */
  waitingReview?: WaitingReview | null;
  /** GH #129: a request for changes the Builder has not received — its
   *  review handed the card straight to a follow-up, which has given no
   *  verdict yet. Absent otherwise, and on cards before it. */
  handedOver?: HandedOverRequest | null;
  /** GH #135: the settled review whose verdict has not reached the
   *  Builder. A verdict used to be injected only by the Run step while it
   *  was mounted, so a review that settled with the card closed was never
   *  sent. Recorded when the review settles, cleared when the Builder
   *  receives it. Absent otherwise, and on cards before it. */
  undeliveredVerdict?: UndeliveredVerdict | null;
  /** CL-5: every review round the ledger folded for this card, oldest
   *  first. Absent on cards before it (Activity then shows the latest
   *  review alone). Failed, interrupted and skipped reviews are not rounds. */
  reviewRounds?: ReviewRound[];
}

/** GH #135: which settled review's verdict the Builder is still owed. */
export interface UndeliveredVerdict {
  snapshotN: number;
  /** `BuilderReview.at` of that review — which verdict this is. */
  at: number;
}

/** GH #129: the request for changes a hand-over left unsent. */
export interface HandedOverRequest {
  /** The snapshot whose review asked for changes. */
  snapshotN: number;
  /** The ledger's open blocking findings, by id. */
  findingIds: string[];
  /** What the Builder is sent: those findings as a follow-up quotes them. */
  handoff: string;
  at: number;
}

/** GH #124: the review a Build done asked for during a running review. */
export interface WaitingReview {
  snapshotN: number;
  requestedAt: number;
}

/** v1.109.0: the human's decision on one disagreement-ledger entry. */
export interface PlanDecision {
  disagreementId: string;
  statement: string;
  decision: string;
}

/** v1.109.0: a card's Plan challenge — the Discussion on its brief plus
 *  the human's decisions. `brief` is the brief as it read when saved. */
export interface PlanChallenge {
  discussionId: string;
  challengedAt: number;
  brief: string;
  decisions: PlanDecision[];
}

/** A card's copy kept on this machine after it shipped (`kept_copy.rs`). */
export interface KeptCopy {
  path: string;
  /** What the move to the trash said: the card's Details. */
  reason: string;
  at: number;
}

export interface KanbanCard {
  id: string;
  workspaceId: string;
  title: string;
  /** v1.106.0: live Builder session (Builder/Challenger model). Absent on
   *  legacy cards and on cards run through the swarm path. */
  builder?: BuilderState | null;
  /** v1.109.0: Plan challenge record; travels into the Builder prompt. */
  planChallenge?: PlanChallenge | null;
  notes?: string | null;
  /** v0.8.0: longer-form context attached to the card; appended to the
   *  card-driven prompt after `notes`. Optional/null on legacy cards. */
  knowledge?: string | null;
  columnId: KanbanColumnId;
  agentConfigId?: string | null;
  linkedRunId?: string | null;
  lastRunStatus?: KanbanLastRunStatus | null;
  /** v1.0: Swarm. Mutually exclusive with `agentConfigId` at the UI layer. */
  swarmTemplateId?: string | null;
  /** v1.0: Swarm. Mirrors `linkedRunId` for the swarm path. */
  linkedSwarmId?: string | null;
  /** v1.26.0 (Cycle H): durable pointer to the brainstorm swarm
   *  launched from this card's detail panel. Separate from
   *  `linkedSwarmId` so a kanban moveCard dispatch doesn't orphan
   *  the brainstorm by overwriting its id. Powers the
   *  LinkedBrainstormBanner and PromoteButton cross-restart fallback. */
  linkedBrainstormId?: string | null;
  /** v1.27.0 (Cycle H phase 2): banner keys the user has dismissed in
   *  the signal lane. Format: `<kind>:<id>` strings (e.g.
   *  `brainstorm:swarm-abc`). FE-only — no backend writer touches it.
   *  Cap at 16 entries (FIFO eviction on add). Defaults empty on
   *  legacy cards via the v6 → v7 migration. */
  dismissedBanners?: string[];
  /** v1.5.x: system-managed FIFO of run receipts (cap 5). Defaults empty. */
  runHistory?: RunHistoryEntry[];
  /** v1.5.x: per-card opt-out — when true, run completions skip the
   *  history append. */
  suppressRunHistory?: boolean;
  /** v1.7.0: finalized prompt produced by the intake conversation.
   *  When present, replaces the legacy `title + notes + knowledge` concat
   *  as the dispatch prompt for card-driven runs. Never overwrites
   *  user-edited title/notes/knowledge. */
  dispatchPrompt?: string | null;
  /** v1.7.0: unix-ms set when the user manually edits dispatchPrompt
   *  after intake finished. Drives the "edited since intake" UI marker. */
  dispatchPromptEditedAt?: number | null;
  /** v1.7.0: intake conversation lifecycle state. Defaults to "none" on
   *  legacy cards. Cards with "active" are force-reset to "none" on load. */
  intakeStatus?: IntakeStatus;
  /** v1.19.0 (Cycle E4): append-only intake history. FIFO-capped at 10
   *  records; evicting deletes the transcript file from disk. Empty for
   *  pre-v5 cards (schema migration v4 → v5). */
  intakeHistory?: IntakeRecord[];
  /** v1.8.0: one-way soft-archive flag. Only set true on cards in the
   *  Complete column. Archived cards are hidden from the main column list
   *  and surfaced inside the collapsible "Archived (N)" disclosure. */
  archived?: boolean;
  /** UX-5.8: when the card was last archived (unix ms). Kept on restore, so
   *  the auto-archive never takes a card the person brought back. Absent on
   *  cards not archived since C5. */
  archivedAt?: number;
  /** UX-5.8: Ply archived it on its own (shipped 14+ days ago); the archive
   *  offers Restore. Absent (false) otherwise. */
  autoArchived?: boolean;
  /** N14 walk F19: when the card was put back in To do (unix ms), oldest
   *  first — one Activity row each. Absent on cards never put back. */
  putBacks?: number[];
  /** 1.173.0 A3: the copy without a card *Make it a card* made this card
   *  from (its copy is that copy's folder). */
  fromCopy?: { id: string; name: string } | null;
  /** v1.9.0 (Phase D+): markdown the builder writes describing what
   *  changed and what the QA agent should check. Optional in Phase A. */
  verifyIntent?: string | null;
  /** v1.9.0: lifecycle state of the verify pipeline. */
  verifyStatus?: VerifyStatus;
  /** v1.9.0: capped FIFO of verify-pipeline receipts. */
  verifyHistory?: VerifyEntry[];
  /** v1.9.0: whether this card's content is live in
   *  /Applications/Ply.app. */
  shipStatus?: ShipStatus;
  /** v1.9.0: append-only history of every ship that included this card. */
  shipHistory?: ShipEntry[];
  /** v1.9.0: most recent per-card commit SHA. */
  commitSha?: string | null;
  /** v1.9.0: most recent version tag (e.g. "v1.9.3"). */
  shippedVersion?: string | null;
  /** v1.10.0: per-card file attachments. Empty by default. */
  attachments?: CardAttachment[];
  /** v1.10.0 (Cycle A): absolute path to this card's git worktree.
   *  Populated by the Todo→InProgress lifecycle hook
   *  (`kanbanCardAdvanceToInProgress`); cleared when the card is archived
   *  or shipped. `null` on cards from before the worktree feature shipped
   *  and on cards that have never left Todo. */
  worktreePath?: string | null;
  /** v1.10.0 (Cycle A): branch name captured at worktree-create time
   *  (`plyloft/card-<short_id>-<slug>`; `atelier/card-…` before SP-7). Stable identifier — does NOT
   *  rename if the card title is later edited. */
  branchName?: string | null;
  /** The commit the card's worktree branched from (fetched origin head,
   *  or local when offline / ahead / no remote). Captured with
   *  `worktreePath`, cleared with it; null on legacy cards. */
  worktreeBase?: WorktreeBase | null;
  /** v1.31.0 (Cycle 1 — Review surface): post-swarm review lifecycle.
   *  null until the card is first reviewed. */
  reviewStatus?: ReviewStatus | null;
  /** UX P1 point 7 (P-E): the last local ship's conflict, kept only beside
   *  `reviewStatus: conflict_blocked`. Absent on every other card. */
  shipConflict?: ShipConflict | null;
  /** v1.31.0 (Cycle 1): persisted per-hunk review verdicts. */
  reviewDecisions?: ReviewDecision[];
  /** v1.31.0 (Outcome screen, Phase 3): the GitHub PR URL when the card
   *  shipped as a pull request. null for local-merge / unshipped cards. */
  prUrl?: string | null;
  /** SL-1 (ship loop): what Plyloft last read of that pull request on
   *  GitHub. Absent on cards shipped before SL-1 (and on every card never
   *  shipped as a PR). Its checks are the PR's checks on GitHub — not the
   *  card's own Checks (`verifyStatus`). */
  pr?: PrStatus | null;
  /** v1.49.0 (Team Mode Phase 0): provenance. `author` is set at
   *  create-time and stable across edits. `lastEditedBy` is rewritten
   *  on every user-driven `kanban_card_patch`; system-driven
   *  bookkeeping (run history, ship state, intake-status flips) leaves
   *  it alone. Null on legacy cards and on cards created before
   *  identity was configured. */
  author?: string | null;
  lastEditedBy?: string | null;
  /** v1.57.0 (Cycle 3): the GitHub issue number this card mirrors when the
   *  workspace's `kanbanSyncMode` is `githubIssues`. null/undefined for
   *  local-only cards (no issue yet) and every legacy card. Drives the
   *  "Local only" badge (GH mode + no number) and the claim/sync affordances. */
  ghIssueNumber?: number | null;
  /** v1.57.0 (Cycle 3): a local edit not yet mirrored to the backing issue
   *  (offline / a failed sync hook). Drives the "Pending sync" badge; the next
   *  reconcile/Sync retries and clears it. Backend-owned. */
  syncPending?: boolean;
  /** v1.57.0 (Cycle 3): free-form text a human typed into the issue body
   *  outside the marker blocks, cached so a Ply edit re-appends rather than
   *  erases it. The Builder never gets it. Sync adopts it as `notes` when the
   *  card has none; otherwise the panel shows it under "From the issue" with
   *  "Use as brief" (`kanbanCardUseIssueRemainder`). */
  ghRawRemainder?: string | null;
  /** GH #66: the backing issue's assignee logins as last read from GitHub
   *  (Sync, Claim, the claim gate). Drives "Claimed by X" / "Yours" / Claim.
   *  Display only — every claim decision re-reads the live issue. */
  ghAssignees?: string[];
  /** N14 (item 6): the GitHub login of who opened the backing issue, as
   *  last read by Sync or Claim. The card page says "<login> described the
   *  card" when it is someone else. Absent on local cards and older ones. */
  ghAuthor?: string | null;
  /** 1.175.0 (B3): the author's association with the repository, as GitHub
   *  names it; not OWNER, MEMBER or COLLABORATOR = outside. Absent = unknown. */
  ghAuthorAssociation?: string | null;
  /** 1.175.0 (B3): who edited the issue's text last, when somebody has. */
  ghLastEditor?: string | null;
  /** 1.175.0 (D3): the parts of the issue (title, brief) both this computer
   *  and GitHub changed; the card asks which to keep. Absent = none. */
  editConflicts?: EditConflict[];
  /** 1.175.0 (D3): what GitHub had of a part when this computer's edit of
   *  it began, while that edit isn't on GitHub yet (the backend's own). */
  ghLastRead?: { title?: string; brief?: string; knowledge?: string; updatedAt?: string } | null;
  /** 1.173.0 (C2): which computer took the card — the hidden claim marker
   *  in its issue body, as last read from GitHub. Absent on local cards. */
  ghClaim?: DeviceClaim | null;
  /** 1.173.0 (C2): `ghClaim` names this computer (decided by the backend
   *  with this repository's id). */
  ghClaimHere?: boolean;
  /** 1.173.0 (C2): the computer that took the card over from this one —
   *  "Taken over by <name>"; cleared by this computer's next claim. */
  ghClaimLostTo?: string | null;
  /** GH #66: the status label has not reached the issue (a label-only push
   *  failed). The next Sync retries only the labels. Shown as pending sync. */
  ghLabelsPending?: boolean;
  /** 1.175.0 (D2): GitHub didn't take the member's own name off the issue
   *  when they left the card; the next Sync tries again. Absent = false. */
  unassignPending?: boolean;
  /** UX-5.3: where the person dragged the card within its Board column — a
   *  sort key in the same space as `createdAt` (the default). Board view
   *  state only; absent on cards never reordered. */
  boardOrder?: number;
  /** UX-7.1: the cards of this workspace this card waits for, by id. A card
   *  with a blocker that has not shipped cannot start; an archived or
   *  deleted blocker holds no one back. Absent on cards with none (and on
   *  every card before C7). Local only — never synced to GitHub. */
  blockedBy?: string[];
  /** The Builder vendor chosen on the card before any build (the card's
   *  Builder property, the Run step). Absent/null = the Settings default
   *  (`behavior.builderVendor`). Once a session exists `builder.vendor` is
   *  the fact. Saved through `kanbanCardSetBuilderVendorPref`; local only. */
  builderVendorPref?: "claude" | "codex" | null;
  /** 1.171.0 (D1): how this card's Builder asks before it changes things,
   *  chosen on the card before Start build. Absent/null = the Settings
   *  default (`behavior.builderPermissions`). Saved through
   *  `kanbanCardSetBuilderPermissions`; local only. */
  builderPermissions?: "editsCopy" | "asks" | "neverAsks" | null;
  /** 1.168.1 (E2): the models chosen for this card only, per role and
   *  vendor (a workspace's shape: `cliDefault` for "the tool's default").
   *  Over the workspace's and the app's at every spawn for the card.
   *  Absent = the workspace's. Saved through `kanbanCardSetModels`; local
   *  only, never synced to GitHub. */
  models?: WorkspaceModels | null;
  /** 1.169.0 (A3): each "Retry on…" of a round, oldest first. */
  modelRetries?: ModelRetry[];
  /** SL-4: what the setup of the card's worktree did — the files copied in
   *  and the setup command's outcome. `failed` holds the Builder back until
   *  Retry or Start anyway. Absent when the workspace configures no setup
   *  (and on every card before it). Written by the backend alone. */
  worktreeSetup?: WorktreeSetupRecord | null;
  /** The first of the card worktree's ten ports (`worktree_ports`), given
   *  as `PLYLOFT_PORT_BASE` to everything run in the worktree. Meaningful
   *  only while `worktreePath` is set. Absent on cards before it. */
  portBase?: number | null;
  /** SL-6: Build with both — Claude and Codex each built the card in their
   *  own worktree; the Challenger's comparison; once the owner picked (or
   *  stopped), what became of each. While undecided the card has no
   *  `builder`. Absent on cards built the normal way. Backend-owned. */
  buildBoth?: BuildBoth | null;
  /** SL-5: comments on lines of the card's review diff, for its Builder.
   *  Unsent ones are editable and removable; sent ones are history. Local
   *  only — never posted to GitHub. Absent on every card before it. */
  lineComments?: LineComment[];
  /** N18: the card's branch, waiting for its worktree's trash entry to
   *  expire, and what became of it (`branch_cleanup.rs`). Backend-owned;
   *  absent on every card before it. */
  branchCleanup?: BranchCleanup | null;
  /** Windows walk 2026-10-20 (Try it spec §4.5): the card's copy a Ship
   *  couldn't move to the trash, and why (`kept_copy.rs`); tried again when
   *  its Builder session closes and at launch. Backend-owned; absent on
   *  every card before it and whenever nothing was kept. */
  keptCopy?: KeptCopy | null;
  /** N19: the shipped card this one follows up (`Follow up` made it).
   *  Backend-owned; absent on every other card and every card before it. */
  followsUp?: CardFollowLink | null;
  /** N19: the cards made to follow this one up, oldest first. Backend-owned;
   *  absent on every card before it. */
  followedUpBy?: CardFollowLink[];
  /** Challenger on a pull request: the open pull request of this repository
   *  the card reviews (`pr_review.rs::PrReview`). Backend-owned; local only,
   *  nothing of it is posted to GitHub. Absent on every other card. */
  prReview?: PrReview | null;
  /** G7: "Fix failing checks by itself" on this card; absent follows `Workspace.fixFailingChecks`. */
  prAutoFix?: boolean | null;
  /** 1.175.0 F5: "After a fix round" (absent: the setting) and the checks started by itself in a row. */
  fixRoundCheck?: boolean | null;
  fixRoundSelfChecks?: number;
  /** Skills hub H3a (§4.2): a card Plyloft made carrying one skill change
   *  (`kanban::CardKind`). Backend-owned; absent on every ordinary card. A
   *  skill card stops being one once a Builder or a swarm works on it
   *  (`isSkillCard`). */
  kind?: CardKind | null;
  /** Skills hub H5 (R12): the skills whose other copy Plyloft brought in
   *  line with the one the Builder edited, at a Finish and check — the
   *  Verify step says so. Absent on every other card. */
  twinsAligned?: TwinAligned[];
  /** H5 (Challenger): the skills whose two copies stay apart on this card
   *  after its last Finish and check. Absent on every other card. */
  twinsApart?: string[];
  /** 1.172.0 (A1): what the person asked the Builder after the first
   *  result, oldest first (`later_requests.rs`). The card lists them under
   *  What you want; the Challenger's brief carries them. Absent on every
   *  card before it, and while there are none. */
  laterRequests?: LaterRequest[];
  /** 1.173.0 (B3): the repository area the card belongs to (an
   *  `AreaDef.id`); its start, Ship and Bring in read that area's branch.
   *  Absent on every card before it and in a repository without areas. */
  area?: string | null;
  /** 1.173.0 (C1): the area label the card's issue had when this Mac last
   *  read it or put it there (GitHub Issues boards). Absent on every card
   *  before it and on local boards. */
  ghAreaLabel?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 1.172.0 (A1): `later_requests::LaterRequestSource` — Not right on the
 *  result, Request changes on the review's lines, or Not right — tell the
 *  Builder in Ask about this card. "other": written by a newer app. */
export type LaterRequestSource = "notRight" | "changes" | "chat" | "other";

/** 1.172.0 (A1): `later_requests::LaterRequest`. */
export interface LaterRequest {
  id: string;
  text: string;
  /** When it was sent to the Builder (ms). */
  at: number;
  source: LaterRequestSource;
}

/** 1.172.0 (A1): keep a request sent to the card's Builder after the first
 *  result. Local card state. */
export function kanbanCardAddLaterRequest(
  workspaceId: string,
  cardId: string,
  text: string,
  source: Exclude<LaterRequestSource, "other">,
) {
  return invoke<KanbanCard>("kanban_card_add_later_request", { workspaceId, cardId, text, source });
}

/** 1.172.0 (A1): remove one; refused once the card has landed. */
export function kanbanCardRemoveLaterRequest(workspaceId: string, cardId: string, requestId: string) {
  return invoke<KanbanCard>("kanban_card_remove_later_request", { workspaceId, cardId, requestId });
}

/** Skills hub H3a: `kanban::CardKind`. */
export type CardKind = { type: "skill" } & SkillCardKind;

/** `skill_card::SkillCard`. */
export interface SkillCardKind {
  /** Skills hub H3b: `link` writes link records only (R-M). H4: the
   *  decisions — `keepMine` and `relink` write the link record only,
   *  `detach` removes it, `remove` removes the copies and it, `rename`
   *  moves them to `renamedTo`. */
  verb: "install" | "update" | "link" | "keepMine" | "detach" | "remove" | "rename" | "relink" | "align" | "copy" | "personalize" | "carry";
  /** Skills hub H8: the copy's link is kept on this Mac only — the commit
   *  holds the copies and no link record. Absent on every other card. */
  localLink?: boolean;
  /** H8: how the card names where its copy came from ("astra"). */
  fromWords?: string | null;
  /** Skills hub H5 (R12): the copy an Align card copies over the other. */
  alignWinner?: "claude" | "codex" | null;
  /** H4: the new name a Rename card moves the skill to. */
  renamedTo?: string | null;
  skill: string;
  prefix?: string;
  origin: SkillCardOrigin;
  /** What the card's commit writes, per copy; a copy it doesn't write is
   *  absent (a Claude-only team skill writes only Claude's — R2 edge). */
  content?: { claude?: string | null; codex?: string | null };
  /** Skills hub H3b: every copy a Link card links (`skill_card::LinkItem`);
   *  absent on Install and Update cards. */
  links?: { skill: string; origin: SkillCardOrigin }[];
}

/** `skill_links::LinkOrigin`. */
export interface SkillCardOrigin {
  kind: string;
  source: string;
  plugin?: string | null;
  name: string;
  path?: string | null;
  version: { commit: string; contentId: string };
}

/** Challenger on a pull request: what the card keeps of the pull request
 *  it reviews (`pr_review.rs::PrReview`). */
export interface PrReview {
  url: string;
  number: number;
  /** `owner/name`. */
  repo: string;
  title: string;
  author?: string | null;
  baseRef: string;
  headRef: string;
  /** The head GitHub last reported. */
  headSha: string;
  /** The head the card's branch was last brought to; differs from
   *  `headSha` when the pull request has commits the card hasn't reviewed. */
  branchHead?: string | null;
  crossRepository: boolean;
  /** The member's own, pushable: Fix with the Builder is offered. */
  pushable: boolean;
  /** Why not, when it isn't. */
  fixNote?: string | null;
  state: PrState;
  checkedAt: number;
  /** The card's snapshots that are heads of the pull request (the others
   *  are the Builder's fixes). */
  heads?: number[];
  readError?: string | null;
  /** The Challenger chosen in the sheet; it reviews whatever vendor fixes. */
  challenger?: "claude" | "codex" | null;
  /** How many snapshots the card had when `branchHead` was last set: only a
   *  later snapshot is a fix built on it. */
  headMark?: number;
  /** Bring in the new commits merged them; until a snapshot after the mark,
   *  the merge isn't built. */
  merged?: boolean;
  /** Walk 2 of #386: each Push the fixes GitHub took (`sha` pushed over
   *  `over`), oldest first — the card's Activity. */
  pushes?: { sha: string; over: string; at: number }[];
  /** When Plyloft first read it merged or closed (unix ms); 0 or absent: open. */
  closedAt?: number;
  /** Walk 3 of #386: when each Builder session on the card started, oldest first. */
  fixStarts?: number[];
  /** Walk 3 of #386: new commits read under an unpushed fix (`head`, `at`),
   *  oldest first; walk 4: `snapshot` is the card's snapshot that merged and
   *  built them (Bring in the new commits, or the Builder itself). */
  merges?: { head: string; at: number; snapshot?: number }[];
  /** Walk 3 of #386: the last Bring in the new commits conflicted — the head
   *  it tried and the fix (newest snapshot) it was under. */
  mergeConflict?: { head: string; fix: string } | null;
}

/** One open pull request in Review a pull request (`PrListItem`). */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  author?: string | null;
  headRef: string;
  baseRef: string;
  crossRepository: boolean;
  draft: boolean;
  updatedAt?: string | null;
  /** Opened by the member. */
  mine: boolean;
  /** The card already reviewing it. */
  cardId?: string | null;
}

export interface PrList {
  repo: string;
  prs: PrListItem[];
}

export interface PrReviewCreated {
  card: KanbanCard;
  /** The pull request already had a card: that one. */
  existing: boolean;
  /** The card was made but its review didn't start: why. */
  reviewError?: string | null;
}

/** Challenger on a pull request: the repository's open pull requests. */
export function prReviewList(workspaceId: string) {
  return invoke<PrList>("pr_review_list", { workspaceId });
}

/** Challenger on a pull request: the card for `input` (a link or a number)
 *  and its review by `challenger`. */
export function prReviewCreate(workspaceId: string, input: string, challenger: "claude" | "codex") {
  return invoke<PrReviewCreated>("pr_review_create", { workspaceId, input, challenger });
}

/** Read the card's pull request from GitHub again. */
export function prReviewRefresh(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("pr_review_refresh", { workspaceId, cardId });
}

/** Bring in the new commits: merge the pull request's new commits into
 *  the card's branch under an unpushed fix. */
export function prReviewMergeHead(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("pr_review_merge_head", { workspaceId, cardId });
}

/** Review / Review again: the pull request's current head. */
export function prReviewStart(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("pr_review_start", { workspaceId, cardId });
}

/** N19: one end of a follow-up link (`kanban.rs::CardFollowLink`). `title`
 *  is the other card's title when the link was made. */
export interface CardFollowLink {
  cardId: string;
  title: string;
  at: number;
}

/** N18: why a card's branch is up for deletion. `unknown`: a later build's. */
export type BranchCleanupReason = "shipped" | "landed" | "prMerged" | "merged" | "archived" | "copy" | "unknown";

/** N18: what became of it — deleted at its tip, kept for commits after it
 *  shipped, kept because the person said so, already gone, picked up again
 *  by the card starting again, or behind a merged pull request's head. */
export type BranchCleanupOutcome =
  | "deleted"
  | "movedOn"
  | "declined"
  | "gone"
  | "restarted"
  | "behind"
  | "restored"
  | "unknown";

export interface BranchCleanup {
  branch: string;
  /** The tip recorded when it shipped (or was archived): the only commit the
   *  delete may happen at. */
  tip: string;
  reason: BranchCleanupReason;
  since: number;
  trashEntry?: string | null;
  /** An archived card's branch is due: the Inbox asks. */
  asking?: boolean;
  askedAt?: number | null;
  approved?: boolean;
  outcome?: BranchCleanupOutcome | null;
  outcomeAt?: number | null;
}

/** N18: one archived card's branch the Inbox asks about. */
export interface BranchAskItem {
  cardId: string;
  title: string;
  branch: string;
  /** When the ask started. */
  at: number;
  /** The card shipped before, then started again and was archived. */
  shipped?: boolean;
}

/** N18: one branch the one-time backlog offer lists. */
export interface BranchBacklogItem {
  cardId: string;
  title: string;
  branch: string;
  tip: string;
  /** Archived without shipping: it goes to the Inbox ask instead. */
  archived: boolean;
  since: number;
}

/** N18: what the Inbox shows for one workspace. */
export interface PendingBranchCleanup {
  workspaceId: string;
  workspaceName: string;
  asks: BranchAskItem[];
  backlog: BranchBacklogItem[];
  /** When the backlog offer was found. */
  backlogAt?: number | null;
}

/** N18: what an answer did. */
export interface BranchAnswerResult {
  deleted: number;
  kept: number;
  queued: number;
}

export function branchCleanupPending() {
  return invoke<PendingBranchCleanup[]>("branch_cleanup_pending");
}

/** N18: the Inbox ask — Delete them (`del` true) or Keep them. */
export function branchCleanupAnswer(workspaceId: string, cardIds: string[], del: boolean) {
  return invoke<BranchAnswerResult>("branch_cleanup_answer", { workspaceId, cardIds, delete: del });
}

/** N18: the backlog offer — Delete N branches / Not now / Never. */
export function branchBacklogAnswer(workspaceId: string, answer: "delete" | "notNow" | "never") {
  return invoke<BranchAnswerResult>("branch_backlog_answer", { workspaceId, answer });
}

/** SL-6: `a` is Claude in the card's own worktree, `b` Codex in `<id>-b`. */
export type BuildLaneId = "a" | "b";

/** SL-6: one of the two builds of a card built by both. */
export interface BuildLane {
  lane: BuildLaneId;
  vendor: "claude" | "codex";
  worktreePath: string;
  branchName: string;
  bypass?: boolean;
  /** 1.171.0 (D1): the card's permissions choice this build started in. */
  permissions?: "editsCopy" | "asks" | "neverAsks" | null;
  /** How the model it runs on reads (`opus`, `gpt-5.5 high`), set at spawn. */
  model?: string | null;
  /** CL-8: the model chosen for this build when Build with both started,
   *  used on its spawn and every Resume. Absent on builds from before CL-8. */
  chosenModel?: LaneModel | null;
  ptyId?: string | null;
  sessionLost?: boolean;
  /** v1.154.1 round 2 (walk J1): Resume found no Codex conversation of this
   *  build's own; it offers Start fresh. */
  resumeFailed?: boolean;
  /** Absent while its setup holds it back. */
  startedAt?: number | null;
  /** Its Build done: the snapshot compared and picked. */
  done?: { sha: string; at: number } | null;
  /** `running` | `passed` | `failed` | `stalled` | `interrupted`. */
  verify?: { status: string; sha: string; summary?: string | null; at: number } | null;
  /** It ended without a result, in words. */
  failed?: string | null;
  /** Lane b's SL-4 setup record (lane a's is the card's `worktreeSetup`). */
  worktreeSetup?: WorktreeSetupRecord | null;
  /** Lane b's port block (lane a's is the card's `portBase`). */
  portBase?: number | null;
}

/** SL-6: the Challenger's comparison of the two builds. `status`: `running`,
 *  `done` (it recommends), `decided` (only one had a result; no pass),
 *  `failed`. `recommended`: the lane, or absent for neither. */
/** CL-8: one build's model, chosen at start for this card only; blank is
 *  the CLI's own default. `reasoning` is the effort (1.169.0: both vendors). */
export interface LaneModel {
  model?: string | null;
  reasoning?: string | null;
}

/** CL-8: `build_both_start`'s choice of each build's model. */
export interface BuildBothModels {
  claude: LaneModel;
  codex: LaneModel;
}

/** CL-8: the Challenger's verdict on one build. `findings`: absent when
 *  the answer had none for it, empty when it said there are none. */
export interface LaneVerdict {
  lane: BuildLaneId;
  summary?: string | null;
  findings?: string[] | null;
}

/** CL-8: one build's changes from the card's base to its Build done — read
 *  on demand, never stored; `sha` is the snapshot it was read at. */
export interface LaneDiffFile extends FileDiff {
  added: number;
  removed: number;
  /** Its lines were left out: they would pass the 4 MiB cap. */
  cut?: boolean;
}
export interface LaneDiff {
  lane: BuildLaneId;
  sha: string;
  base: string;
  files: LaneDiffFile[];
  added: number;
  removed: number;
  /** Longer than 4 MiB: the files past the cut carry no lines. */
  cut?: boolean;
}

export interface BuildCompare {
  status: "running" | "done" | "decided" | "failed";
  /** Who judged: `claude` or `codex` (the Challenger). */
  provider?: string | null;
  recommended?: BuildLaneId | null;
  reasons?: string[];
  /** CL-8: each build's summary and findings; absent on older ones. */
  lanes?: LaneVerdict[];
  excerpt?: string | null;
  error?: string | null;
  shaA?: string | null;
  shaB?: string | null;
  startedAt?: number;
  at?: number;
}

export interface ArchivedLane {
  lane: BuildLaneId;
  vendor: "claude" | "codex";
  branchName: string;
  trashPath?: string | null;
  problem?: string | null;
}

export interface BuildBothOutcome {
  kind: "picked" | "stopped";
  lane?: BuildLaneId | null;
  vendor?: "claude" | "codex" | null;
  followedRecommendation?: boolean | null;
  by?: string | null;
  at: number;
  archived?: ArchivedLane[];
}

export interface BuildBoth {
  startedAt: number;
  lanes: BuildLane[];
  compare?: BuildCompare | null;
  outcome?: BuildBothOutcome | null;
}

/** SL-5: one comment on a range of the card's review diff. Added and
 *  context lines are numbered in the card's version of the file
 *  (`newStart`–`newEnd`); removed lines, which exist only in the base
 *  version, are numbered there (`oldStart`–`oldEnd`). */
export interface LineComment {
  id: string;
  path: string;
  newStart?: number | null;
  newEnd?: number | null;
  oldStart?: number | null;
  oldEnd?: number | null;
  /** The selected diff lines as shown, `…` where the selection skips
   *  unchanged lines between two hunks. */
  quoted: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  /** When it was pasted into the Builder session; absent = not sent. */
  sentAt?: number | null;
}

/** SL-5: what `cardLineCommentAdd` takes; the id and times are the backend's. */
export interface LineCommentDraft {
  path: string;
  newStart: number | null;
  newEnd: number | null;
  oldStart: number | null;
  oldEnd: number | null;
  quoted: string;
  body: string;
}

/** SL-4: a path the worktree copy left alone, and why. */
export interface WorktreeCopySkip {
  path: string;
  reason: string;
}

/** SL-4: `worktree_setup::WorktreeSetupRecord`. File names only. */
export interface WorktreeSetupRecord {
  /** `running`: under way, the Builder waits; `failed`: Retry / Start anyway. */
  state: "running" | "done" | "failed" | "skipped";
  copied?: string[];
  skipped?: WorktreeCopySkip[];
  unmatched?: string[];
  command?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  reason?: string | null;
  /** The command was not run: this Mac hasn't allowed it ("Allow and run"). */
  approvalNeeded?: boolean;
  /** The end of the command's output. */
  log?: string;
  elapsedMs?: number;
  at: number;
}

/** v1.9.0: verify-pipeline lifecycle state. */
export type VerifyStatus =
  | "none"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "legacy";

/** v1.9.0: per-card ship lifecycle. */
export type ShipStatus = "unshipped" | "shipped";

/** Ship target.
 *  - `local` (v1.9.0): rebuilds + replaces /Applications only.
 *  - `push_only` (v1.13.4): commit + tag + push branch + push tag.
 *    Suits deploy-via-push targets like Railway watching a remote
 *    branch. No skip-verify guard — caller accepts the trade-off.
 *  - `github` (Phase F target): commit + tag + push + tauri-updater
 *    pipeline (Releases API + updater feed). skip-verify rejected. */
export type ReleaseKind = "local" | "push_only" | "github";

/** v1.9.0: one verify-pipeline run receipt. Steps populated as Phase B+
 *  pipelines materialize. */
export interface VerifyEntry {
  verifyRunId: string;
  status: VerifyStatus;
  endedAt: number;
  summary?: string | null;
  steps?: VerifyStepResult[];
  /** Git tree of the content this run examined; null on older entries. */
  treeSha?: string | null;
}

export interface VerifyStepResult {
  kind: string;
  passed: boolean;
  elapsedMs: number;
  reason?: string | null;
}

/** v1.9.0: append-only entry for one ship event of this card. */
/** SL-1: mirrors `pr_status.rs::PrStatus`. */
export type PrState = "open" | "merged" | "closed";
export type PrChecks = "none" | "pending" | "passing" | "failing";
export type PrMergeable = "unknown" | "mergeable" | "conflicting";
export type PrReviewDecision = "none" | "review_required" | "approved" | "changes_requested";

/** 1.170.0 G3: `gh pr merge --squash|--merge|--rebase`. */
export type MergeMethod = "squash" | "merge" | "rebase";

export interface PrStatus {
  number: number;
  state: PrState;
  /** 1.171.0 (D8): its title on GitHub; absent on cards read before. */
  title?: string | null;
  checks: PrChecks;
  checksTotal: number;
  checksPassed: number;
  checksPending: number;
  /** Failing checks on GitHub, each name once, with the page that shows it. */
  failingChecks: { name: string; workflow?: string | null; url?: string | null }[];
  mergeable: PrMergeable;
  /** GitHub's `mergeStateStatus`, lowercased (`clean`, `blocked`, `dirty`…). */
  mergeState?: string | null;
  reviewDecision: PrReviewDecision;
  changesRequested?: { author?: string | null; body: string; submittedAt?: number | null } | null;
  headSha?: string | null;
  mergeCommit?: string | null;
  openedAt?: number | null;
  mergedAt?: number | null;
  closedAt?: number | null;
  /** When GitHub was last read for it; null until the first read. */
  checkedAt?: number | null;
  /** After a merge: why the worktree or its branch was kept. */
  cleanupKept?: string | null;
  /** Since when checks on this head have been pending (cadence cap). */
  pendingSince?: number | null;
  /** SL-3: GitHub merges it once its checks pass (read from GitHub). */
  autoMerge?: boolean;
  /** SL-3: GitHub's answer when "Merge when checks pass" couldn't be turned
   *  on; kept until it is on. */
  autoMergeRefused?: string | null;
  /** v1.154.1 (walk I1): when Push update last sent a commit to it. */
  pushedAt?: number | null;
  /** v1.154.1 (walk I1): the commit Push update sent. */
  pushedHead?: string | null;
  /** v1.154.1 (walk I1): some read of it found checks on GitHub. */
  checksSeen?: boolean;
  /** v1.154.1 (walk I1): just opened or pushed to, and GitHub hasn't
   *  started the checks of that commit yet — "none" (or the old head's
   *  result) is not what they are. Read every minute, no Merge, for a
   *  bounded time (`pr_status.rs::awaiting_checks`). */
  awaitingChecks?: boolean;
  /** 1.170.0 G3: how Merge merges it — the method its repository allows
   *  (squash, else a merge commit, else rebase); absent until a read of the
   *  open pull request. */
  mergeMethod?: MergeMethod | null;
  /** 1.170.0 (G1–G3 Challenger): a press wanted "Merge when checks pass"
   *  but the last commit isn't reviewed — `held` at the ship, `turnedOff`
   *  when an unreviewed push turned it off — or Plyloft turned it on again
   *  once reviewed (`resumed`). Absent otherwise. */
  autoMergeWanted?: AutoMergeWanted | null;
  /** 1.170.0 (walk fix): "Merge when checks pass" kept by Plyloft, not
   *  GitHub — the base branch requires no checks (or Plyloft couldn't tell),
   *  where GitHub's own would merge at once. The poller merges it once its
   *  checks passed (`pr_merge.rs::merge_due`). Absent while off. */
  plyloftAutoMerge?: boolean;
  /** 1.171.0 (B1): the last read couldn't reach GitHub because the GitHub
   *  command isn't signed in (`pr_status.rs::read_needs_sign_in`); the next
   *  read that reaches GitHub clears it. Absent while false. */
  signInNeeded?: boolean;
  /** G5 (1.170.0): after the merge, why this computer's target branch
   *  couldn't be brought up to GitHub's; the Done card and the Inbox offer
   *  Bring this computer up to date while it is set. */
  upToDateRefused?: string | null;
  /** G5 (Challenger 4): the reason above is one only the person can settle
   *  (this computer's target has commits of its own): the words, no button. */
  upToDateNoPress?: boolean;
  /** G5 (Challenger 7): why the card's branch was left on GitHub after the
   *  merge, short; the Done card says it in a muted line. */
  branchKept?: string | null;
  /** G5 (Challenger 5): the pull request's head branch, from GitHub. */
  headRef?: string | null;
  /** G5 (Challenger 5): whether the pull request comes from another repository. */
  crossRepository?: boolean | null;
  /** G7 (1.170.0): what "Fix failing checks by itself" tried on this pull
   *  request (`pr_auto_fix.rs::PrAutoFix`). Absent until a first try. */
  autoFix?: PrAutoFix | null;
  /** G7 fixes (Minor 5): when Plyloft first read this head's checks as
   *  failing (`pr_status.rs::failing_since`). Absent on an older failure. */
  failingSince?: number | null;
}

/** G7: the record of "Fix failing checks by itself" on one pull request. */
export interface PrAutoFix {
  /** The heads a try started for, oldest first — one per head, three at most. */
  heads: string[];
  /** Where it stopped, for the head it stopped on. */
  stopped?: PrAutoFixStop | null;
  /** 1.174.0 B6: when the latest try began (ms); absent before 1.174.0. */
  startedAt?: number | null;
}

/** G7: why it stopped (`pr_auto_fix.rs::reason`); a later build's reason
 *  arrives as a plain string. `"card_slot"` and `"plan_required"` are no
 *  longer recorded; old records still carry them. */
export type PrAutoFixStopReason =
  | "exhausted"
  | "session_closed"
  | "session_busy"
  | "question"
  | "card_slot"
  | "gather_failed"
  | "not_delivered"
  | "no_change"
  | "finish_failed"
  | "verify_failed"
  | "changes_requested"
  | "push_refused"
  | "timed_out"
  // G7 fixes: the card isn't shown (a wait, M1); the plan's refusals
  // (Minor 3); the Challenger's review not settled as approved (Minor 1).
  | "not_shown"
  | "plan_required"
  | "team_account_mismatch"
  | "licence"
  | "network"
  | "review_failed";

export interface PrAutoFixStop {
  reason: PrAutoFixStopReason | string;
  head: string;
  at: number;
  detail?: string | null;
}

/** G7: what counting a try got (`pr_auto_fix.rs::Begin`). */
export type PrAutoFixBegin =
  | { kind: "started"; attempt: number }
  | { kind: "already_tried" }
  | { kind: "exhausted" }
  | { kind: "not_now"; why: string };

export interface PrAutoFixBegun {
  begin: PrAutoFixBegin;
  card: KanbanCard;
}

/** G7: the card's own "Fix failing checks by itself" switch. */
export function cardSetPrAutoFix(workspaceId: string, cardId: string, on: boolean) {
  return invoke<KanbanCard>("card_set_pr_auto_fix", { workspaceId, cardId, on });
}

/** G7: count a try for the pull request's failing `head` (once per head,
 *  three at most). Sends nothing. */
export function cardPrAutoFixBegin(workspaceId: string, cardId: string, head: string) {
  return invoke<PrAutoFixBegun>("card_pr_auto_fix_begin", { workspaceId, cardId, head });
}

/** G7: record why it stopped on `head` (the Inbox says it). */
export function cardPrAutoFixStop(
  workspaceId: string,
  cardId: string,
  head: string,
  reason: PrAutoFixStopReason,
  detail?: string | null,
) {
  return invoke<KanbanCard>("card_pr_auto_fix_stop", { workspaceId, cardId, head, reason, detail: detail ?? null });
}

export type AutoMergeWanted = "held" | "turnedOff" | "resumed";

export interface ShipEntry {
  commitSha: string;
  shippedVersion: string;
  releaseKind: ReleaseKind;
  shippedAt: number;
  /** 1.171.0 B2: the branch it shipped to, by name ("main") — kept after
   *  the ship cleared the card's `worktreeBase`. Absent on older entries. */
  target?: string | null;
  /** 1.173.0 (B4): the release's tag (`site-v3.0.2` for an area's). Absent
   *  on older entries, a Land and a merged pull request: read as
   *  `v<shippedVersion>`. */
  tag?: string | null;
}

export function kanbanLoad(workspaceId: string) {
  return invoke<KanbanCard[]>("kanban_load", { workspaceId });
}

/** v1.33.0: partial patch for one card's user-editable fields — the only
 *  card-edit path, replacing the whole-board `kanban_save` overwrite that
 *  lost cards. An omitted key leaves the field untouched; an explicit
 *  `null` clears a nullable field. Structurally cannot express a
 *  backend-owned field (run/verify/ship/review state) — that is the point. */
export interface CardPatch {
  title?: string;
  notes?: string | null;
  knowledge?: string | null;
  columnId?: KanbanColumnId;
  agentConfigId?: string | null;
  swarmTemplateId?: string | null;
  dispatchPrompt?: string | null;
  dispatchPromptEditedAt?: number | null;
  dismissedBanners?: string[];
  suppressRunHistory?: boolean;
  verifyIntent?: string | null;
  intakeStatus?: IntakeStatus;
  linkedBrainstormId?: string | null;
}

/** v1.33.0: patch for a card's backend-owned run-link fields. Written by
 *  the dispatch path and the run-done listener, never a user edit. */
export interface RunStatePatch {
  linkedRunId?: string | null;
  linkedSwarmId?: string | null;
  lastRunStatus?: KanbanLastRunStatus | null;
}

/** v1.33.0: create one card. Backend defaults every backend-owned field;
 *  the FE supplies only id/title/notes/column. Returns the created card. */
export function kanbanCardCreate(
  workspaceId: string,
  cardId: string,
  title: string,
  notes: string | null,
  columnId: KanbanColumnId,
  /** 1.173.0 (B3): the area it is made in (`currentAreaFor`); `null`: none. */
  area: string | null = null,
) {
  return invoke<KanbanCard>("kanban_card_create", {
    workspaceId,
    cardId,
    title,
    notes,
    columnId,
    area,
  });
}

/** N19: `Follow up` on a shipped card — a new To do card linked to it
 *  (`commands.rs::kanban_card_follow_up`). The normal new-card path: the
 *  Team gate, and an issue on a GitHub Issues board. */
export function kanbanCardFollowUp(
  workspaceId: string,
  originalCardId: string,
  cardId: string,
  title: string,
  notes: string | null,
) {
  return invoke<KanbanCard>("kanban_card_follow_up", {
    workspaceId,
    originalCardId,
    cardId,
    title,
    notes,
  });
}

/** GH #116: what deleting a card would do to its Builder worktree.
 *  `"remove"` — clean and nothing local-only, it goes without a question;
 *  `"ask"` — uncommitted changes or commits that exist nowhere else;
 *  `"keep"` — the card has no worktree of its own on disk. */
export type WorktreeDisposition = "keep" | "remove" | "ask";

/** GH #116: the confirm sheet's answer about the card's worktree. */
export type WorktreeChoice = "auto" | "keep" | "everything";

export type CardWorktreeState = {
  disposition: WorktreeDisposition;
  path: string | null;
  branch: string | null;
  dirtyFiles: number;
  unpushedCommits: number;
  liveSession: boolean;
  /** git couldn't read the checkout — the sheet asks rather than guess. */
  unreadable: boolean;
  /** Something is working in the folder: the delete refuses until it
   *  stops. `run` is the card's own agent run, which the sheet's own
   *  checkbox kills before it calls the delete; `verify` is nobody's to
   *  kill from here. */
  busy: { kind: "verify" | "run" | "setup" | "terminal"; reason: string } | null;
  /** The card branch the card records (`plyloft/card-…`, or a legacy
   *  `atelier/card-…`) — what `Delete
   *  everything` drops even when the folder itself proves no branch. */
  cardBranch: string | null;
  /** Commits on `cardBranch` that exist on no other ref — `null` when
   *  git could not be asked. */
  cardBranchCommits: number | null;
  /** n16: the workspace has an `origin` remote. Without one every commit
   *  is only on this Mac, so the sheet says they aren't on `targetBranch`.
   *  Absent from older answers: read as true. */
  hasOrigin?: boolean;
  /** n16: the branch the card's work lands on. */
  targetBranch?: string;
  /** n16: the counted local-only commits, newest first, `<short sha>
   *  <subject>`, at most 5 — never their contents. */
  localOnlySubjects?: string[];
  /** n16: the folder is the card's own, but nothing resolved to tell which
   *  of its commits are elsewhere — the sheet says so and asks. */
  commitsUnmeasured?: boolean;
};

/** GH #116: what a delete did beyond removing the card. */
export type CardDeleteOutcome = {
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  /** The folder still on disk, when one stayed. */
  keptPath: string | null;
  /** Why something stayed although the delete meant to remove it. */
  problem: string | null;
  /** GH #116: the folder left its path but is kept where no sweep will
   *  reap it — the staged copy did not read as the delete had judged
   *  it. Listed in the Worktrees panel until the human deals with it. */
  keptInTrash: string | null;
  /** Why it is kept, in the delete's own words. */
  keptReason: string | null;
};

/** GH #116: a staged checkout no sweep will reap. */
export type KeptTrashEntry = {
  path: string;
  dirName: string;
  cardId: string;
  stagedAtMs: number;
  bytes: number;
};

/** GH #116: the kept entries in this workspace's worktree trash. */
export function worktreeKeptList(workspaceId: string) {
  return invoke<KeptTrashEntry[]>("worktree_kept_list", { workspaceId });
}

/** GH #116: remove one kept entry for good — only the human can. */
export function worktreeKeptDelete(workspaceId: string, dirName: string) {
  return invoke<void>("worktree_kept_delete", { workspaceId, dirName });
}

/** GH #116: read the card's Builder worktree before the confirm sheet
 *  opens, so it can say what deleting the card would take with it. */
export function kanbanCardWorktreeState(workspaceId: string, cardId: string) {
  return invoke<CardWorktreeState>("kanban_card_worktree_state", {
    workspaceId,
    cardId,
  });
}

/** v1.33.0: delete one card by id. Idempotent.
 *  GH #116: `worktree` is the sheet's answer — omitted, the card's
 *  worktree goes only when that loses nothing. */
export function kanbanCardDelete(
  workspaceId: string,
  cardId: string,
  worktree?: WorktreeChoice,
) {
  return invoke<CardDeleteOutcome>("kanban_card_delete", {
    workspaceId,
    cardId,
    worktree: worktree ?? null,
  });
}

/** v1.77.0: the "Close issue & delete" path for GitHub-backed cards — closes
 *  the backing issue on GitHub, then hard-deletes the card. Errors with no
 *  local mutation if the close fails (offline, permissions); tolerates an
 *  already-closed or vanished issue. */
export function kanbanCardDeleteGithub(
  workspaceId: string,
  cardId: string,
  worktree?: WorktreeChoice,
) {
  return invoke<CardDeleteOutcome>("kanban_card_delete_github", {
    workspaceId,
    cardId,
    worktree: worktree ?? null,
  });
}

/** v1.33.0: apply a partial `CardPatch` to one card. Returns the patched
 *  card so the FE reconciles its optimistic update without a reload. */
export function kanbanCardPatch(
  workspaceId: string,
  cardId: string,
  patch: CardPatch,
) {
  return invoke<KanbanCard>("kanban_card_patch", {
    workspaceId,
    cardId,
    patch,
  });
}

/** v1.33.0: set a card's backend-owned run-link fields. */
export function kanbanCardSetRunState(
  workspaceId: string,
  cardId: string,
  patch: RunStatePatch,
) {
  return invoke<KanbanCard>("kanban_card_set_run_state", {
    workspaceId,
    cardId,
    patch,
  });
}

/** v1.33.0: fetch one card — single-card refresh after a backend change. */
export function kanbanGetCard(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("kanban_get_card", { workspaceId, cardId });
}

// ── GitHub-Issues-backed kanban (v1.57.0, Cycle 3) ──

/** v1.57.0: what a reconcile did, for the FE Sync indicator + the
 *  "issue missing" badge (numbers whose backing issue vanished on GitHub). */
export interface ReconcileSummary {
  created: number;
  patched: number;
  missing: number[];
  /** What the pass did to the local target branch (fast-forward to the
   *  fetched origin, or why not). Absent when the checkout couldn't be
   *  resolved. */
  localBranch?: LocalBranchReport;
  /** Card worktrees merged into the fetched origin that the pass moved to
   *  the `.trash/` of their worktree root (local branch deleted). */
  prunedWorktrees: number;
  /** Merged card worktrees the pass kept (dirty, busy, …), with why. */
  keptMergedWorktrees?: KeptWorktree[];
  /** Bytes the pass's trash sweep freed (build caches stripped from
   *  `.plyloft-worktrees/.trash/` and legacy `.atelier-worktrees/.trash/`
   *  entries, expired entries removed). */
  trashFreedBytes?: number;
  /** 1.173.0 (C1): cards whose area label didn't reach their issue this
   *  pass; each card's page says so and the next Sync tries again. */
  areaLabelsFailed?: number;
}

export interface KeptWorktree {
  cardId: string;
  reason: string;
}

/** Where a card worktree's base commit came from. */
export type BaseSource = "origin" | "localAhead" | "localOffline" | "localNoRemote";

/** The commit a card worktree started from (`KanbanCard.worktreeBase`). */
export interface WorktreeBase {
  /** Full SHA. */
  commit: string;
  /** `origin/<target>` or `<target>`. */
  refName: string;
  source: BaseSource;
  /** Fetch error (offline) or the unpushed commits left out (diverged). */
  note?: string | null;
  /** Origin's GitHub `owner/name` when the card started; absent for a
   *  non-GitHub or missing origin and on older cards. The base notice
   *  reads it to say "GitHub" only when origin is on GitHub. */
  originSlug?: string | null;
  /** Origin's URL when the card started on a network remote that isn't
   *  GitHub; absent otherwise. */
  originUrl?: string | null;
  /** UX P1 point 7 (P-E): the target commit Plyloft merged into the card to
   *  resolve a ship conflict — a trusted review base. */
  mergedTarget?: string | null;
}

/** UX P1 point 7 (P-E): a local ship that stopped on a git conflict. */
export interface ShipConflict {
  /** The files git reported conflicting. */
  paths: string[];
  /** The target branch's commit the card's work met. */
  targetSha: string;
  at: number;
  /** The target branch's name then; absent on a record without it. */
  branch?: string;
  /** When Plyloft started merging `targetSha` into the card's copy for the
   *  Builder to resolve; absent until then and after Undo the merge. */
  mergeStartedAt?: number | null;
  /** 1.170.0 (G6): met by Bring in the target's changes, not by a ship;
   *  absent on a ship's record. */
  sync?: boolean;
  /** 1.170.0 (G6): a bring-in's record — the review status before the
   *  press, put back by Undo the merge. */
  reviewBefore?: KanbanCard["reviewStatus"] | null;
}

/** Payload of `worktree://base-notice`. */
export interface WorktreeBaseNotice {
  workspaceId: string;
  cardId: string;
  cardTitle: string;
  base: WorktreeBase;
}

/** Outcome of fast-forwarding the local target branch to origin. */
export type LocalBranchSync =
  | { kind: "upToDate" }
  | { kind: "fastForwarded"; from: string; to: string; commits: number }
  | { kind: "dirty"; behind: number }
  | { kind: "diverged"; ahead: number; behind: number }
  | { kind: "ahead"; ahead: number }
  | { kind: "checkedOutElsewhere"; path: string; behind: number }
  /** Untracked files stand where origin adds different ones; nothing moved.
   *  `repeated`: already reported at these same tips. */
  | {
      kind: "untrackedDiffers";
      behind: number;
      from: string;
      to: string;
      paths: string[];
      /** GH #102: `paths` grouped by the thing they belong to, so the error
       *  block can name the skill and offer its own publish. Optional: a
       *  summary from a backend before #102 has only `paths`. */
      items?: UntrackedItem[];
      /** GH #102: git's own sentence, for the block's `Details`. */
      output?: string;
      repeated: boolean;
    }
  | { kind: "offline"; reason: string }
  | { kind: "noRemote" }
  | { kind: "noLocalBranch" }
  | { kind: "failed"; reason: string };

/** GH #102: what a refused untracked path belongs to — a project skill under
 *  `.claude/skills/`, a shared note under `.atelier/library/knowledge/`, or a
 *  plain file, which is its own path. */
export interface UntrackedItem {
  kind: "skill" | "note" | "file";
  name: string;
  paths: string[];
  /** GH #102 review 2: one of `paths` is a folder, which the Trash won't take. */
  directory?: boolean;
}

export interface LocalBranchReport {
  branch: string;
  outcome: LocalBranchSync;
  /** F1 (1.172.1): what the project folder itself is, read by the reconcile
   *  after its fetch (`project_folder::folder_facts`). Absent elsewhere, and
   *  when GitHub couldn't be read. */
  folder?: FolderFacts | null;
}

/** F1 (1.172.1): the project folder's true facts (`project_folder.rs`). */
export interface FolderFacts {
  /** The branch the folder has checked out; null when it has none. */
  branch: string | null;
  head: string | null;
  /** When the folder's last commit was made (unix seconds). */
  headAt: number | null;
  /** The target branch on this Mac; null when it doesn't exist here. */
  targetLocal: string | null;
  /** GitHub's target as last read. */
  targetRemote: string | null;
  /** Commits GitHub's target has that the folder doesn't. */
  newer: number;
  /** Commits the folder has that GitHub's target doesn't. */
  onlyHere: number;
  /** Files with changes not saved in Git (tracked files). */
  changedCount: number;
  changedPaths: string[];
}

/** F1: what *Bring it up to date* did (`project_folder::FolderUpdate`). */
export type FolderUpdate =
  | { kind: "target"; branch: string; outcome: LocalBranchSync }
  | { kind: "ownBranch"; branch: string; target: string; outcome: LocalBranchSync }
  /** The folder's branch exists only on this Mac. */
  | { kind: "noGitHubBranch"; branch: string; target: string }
  | { kind: "changes"; count: number }
  | { kind: "noBranch" };

/** F1: the changes sheet's files (`project_folder::FolderChanges`). */
export interface FolderChanges {
  totalCount: number;
  files: FileDiff[];
  truncated: boolean;
}

/**
 * GH #151: why Ship or Land stopped before merging anything — GH #88's
 * refusal, as a value. `ship_card`, `ship_batch`, `card_ship`,
 * `card_ship_with_follow_up` and `card_review_merge` reject with this object
 * (`worktrees::ShipError::LocalBranchRefused`); every other reason they stop
 * is still a plain string. Read it with `asLocalBranchRefused` (uxError.ts),
 * never by matching a sentence.
 */
export interface LocalBranchRefused {
  operation: "ship" | "land";
  /** Sync's own report: `outcome.kind` is always `untrackedDiffers`. */
  localBranch: LocalBranchReport;
  /** UX P-A (Windows walk 2): the files stood in the way of the card's
   *  squash-merge (git refused it), not of the fast-forward. Absent: false. */
  atMerge?: boolean;
}

/** GH #102: what `worktree_trash_untracked` did. */
export interface TrashedThenSynced {
  /** The paths that went to the Trash, as git named them. Empty when there was
   *  nothing left in the way. */
  trashed: string[];
  /** Where each one landed in the Trash — what "Put Back" would undo. */
  inTrash: string[];
  /** The refusal had already gone when the press arrived: nothing was moved,
   *  the fast-forward ran anyway, and the block goes by its outcome. */
  nothingInTheWay: boolean;
  branch: string;
  /** The fast-forward, once they were out of the way. */
  outcome: LocalBranchSync;
}

/** GH #102 review 1: why a trash changed nothing — or changed less than it
 *  meant to. `stuckInTrash` names the repo-relative paths whose copy is in the
 *  Trash although the move failed, so the block never claims that nothing was
 *  changed over a file that has left the checkout. */
export interface TrashRefusal {
  reason: string;
  stuckInTrash: string[];
}

/** A rejection from `worktreeTrashUntracked`, whatever shape it arrives in: a
 *  serialised `TrashRefusal` from the command, or an `Error` from the bridge. */
export function asTrashRefusal(cause: unknown): TrashRefusal {
  const maybe = cause as Partial<TrashRefusal> | null;
  if (maybe && typeof maybe === "object" && typeof maybe.reason === "string") {
    return {
      reason: maybe.reason,
      stuckInTrash: Array.isArray(maybe.stuckInTrash) ? maybe.stuckInTrash : [],
    };
  }
  return { reason: String((cause as Error)?.message ?? cause), stuckInTrash: [] };
}

/**
 * GH #102, BOARDS.md §5: `Move the local copy to Trash`, then the
 * fast-forward. The paths go to the **macOS Trash** — recoverable, never
 * deleted. The backend recomputes the refusal and refuses anything it does not
 * name, or that resolves outside the workspace, moving nothing.
 */
export function worktreeTrashUntracked(workspaceId: string, paths: string[], cardId?: string) {
  return invoke<TrashedThenSynced>("worktree_trash_untracked", {
    workspaceId,
    paths,
    // UX P-A (Windows walk 2): pressed on this card's Ship step — the files
    // in its merge's way may be moved too (recomputed by the backend).
    ...(cardId ? { cardId } : {}),
  });
}

/** v1.57.0: what a push-local did (the "push N existing cards?" flow). */
export interface PushSummary {
  pushed: number;
  failed: number;
}

/** v1.57.0: reconcile a GitHub-Issues-backed board against the live issues
 *  (push-then-pull). Errors if the workspace isn't in `githubIssues` mode. */
export function kanbanGithubReconcile(workspaceId: string) {
  return invoke<ReconcileSummary>("kanban_github_reconcile", { workspaceId });
}

/** QoL 14.1 (C19): the Board's read-only refresh of a GitHub-backed board —
 *  one issue list, applied locally; nothing is written to GitHub. */
export function kanbanGithubRefresh(workspaceId: string) {
  return invoke<ReconcileSummary>("kanban_github_refresh", { workspaceId });
}

/** GH #66: who held a card's issue before a Claim. Mirrors
 *  `github::ClaimHolder`. */
export type ClaimHolder =
  | { kind: "unclaimed" }
  | { kind: "mine" }
  | { kind: "others"; logins: string[] };

/** Mirrors `commands::ClaimOutcome`. `claimed` is false only when someone
 *  else holds the issue and the call was not `confirmed`. */
export interface ClaimOutcome {
  claimed: boolean;
  holder: ClaimHolder;
  card: KanbanCard;
  /** 1.175.0 (D1): a teammate claimed it a moment before; nothing was
   *  claimed, and this member's own name is off again unless `nameOff` is
   *  false (`second_claim::Raced`). */
  raced?: { first: string; nameOff: boolean } | null;
}

/** v1.57.0: one-click Claim — assign the current user to the card's backing
 *  issue so the subsequent move-to-In-Progress passes the claim gate.
 *  GH #66: reads the live assignees first; when someone else holds the
 *  issue, nothing is assigned unless `confirmed`. */
export function kanbanCardClaim(workspaceId: string, cardId: string, confirmed = false) {
  return invoke<ClaimOutcome>("kanban_card_claim", { workspaceId, cardId, confirmed });
}

/** GH #66: re-read who holds the card's issue and record it on the card,
 *  assigning nobody. The check before a start that creates a worktree. */
export function kanbanCardClaimState(workspaceId: string, cardId: string) {
  return invoke<ClaimOutcome>("kanban_card_claim_state", { workspaceId, cardId });
}

/** 1.173.0 (C2): mirrors `device_claim::DeviceClaim` — the computer a
 *  card's issue says it is being built on. */
export interface DeviceClaim {
  device: string;
  name: string;
  login?: string | null;
  /** RFC 3339. */
  at: string;
}

/** 1.173.0 (C2): write this computer's claim marker on the card's issue,
 *  read live. `takeOver` (*Take it over here*) writes it over another
 *  computer's; without it, another computer's stays. */
export function kanbanCardDeviceClaim(workspaceId: string, cardId: string, takeOver = false) {
  return invoke<KanbanCard>("kanban_card_device_claim", { workspaceId, cardId, takeOver });
}

/** N14 (item 4): a pull request linked to the card's issue on GitHub —
 *  mirrors `github::LinkedPullRequest`. */
export interface LinkedPullRequest {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string | null;
}

/** N14 (item 4): the pull requests linked to the card's issue ("Closes
 *  #21", or linked by hand on GitHub), from the issue's timeline, without
 *  the card's own ship PR. Read as the workspace's GitHub account; nothing
 *  is stored. */
export function kanbanCardLinkedPullRequests(workspaceId: string, cardId: string) {
  return invoke<LinkedPullRequest[]>("kanban_card_linked_pull_requests", { workspaceId, cardId });
}

/** GH #66: this Mac's GitHub login (cached by the backend), for the claim
 *  chip. null when `gh` can't say. */
export function githubCurrentLogin(fresh = false) {
  return invoke<string | null>("github_current_login", { fresh });
}

/** "Use as brief": move the card's issue text outside Ply's markers
 *  (`ghRawRemainder`) into its notes and mirror the issue body. */
export function kanbanCardUseIssueRemainder(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("kanban_card_use_issue_remainder", {
    workspaceId,
    cardId,
  });
}

/** v1.57.0: flip a workspace's kanban sync mode. Flipping to `githubIssues`
 *  requires a repo and ensures the status labels exist first; returns the
 *  count of local-only cards for the "push N existing cards?" prompt. */
export function workspaceSetKanbanSyncMode(
  workspaceId: string,
  mode: "local" | "githubIssues",
  repo?: string | null,
) {
  return invoke<number>("workspace_set_kanban_sync_mode", {
    workspaceId,
    mode,
    repo: repo ?? null,
  });
}

/** v1.57.0: bulk-create issues for every local-only card (confirmed half of
 *  the flip prompt). */
export function kanbanGithubPushLocal(workspaceId: string) {
  return invoke<PushSummary>("kanban_github_push_local", { workspaceId });
}

// v1.84.0: the v1.62.0 `githubReviewRequested` wrapper + `GhPr` type were
// removed with their only consumer (WorkspaceDetailPane's review widget).
// Review-requested PRs surface through the Inbox feed's `pr_review` events.

/** v1.62.0: result of `codeowners_check`. `flagged` ⇔ `owners.length > 0`. */
export interface CodeownersCheck {
  flagged: boolean;
  owners: string[];
}

// ── Team license (v1.85.0 — team-tier roadmap cycle 2) ──────────────

/** Mirrors `license.rs::LicenseStatus`. `grace` = past expiry but inside
 *  the 14-day window — features stay on, banner warns. */
export type LicenseStatus = "none" | "valid" | "grace" | "expired";

export interface LicenseInfo {
  status: LicenseStatus;
  team: string | null;
  seats: number | null;
  issuedAt: number | null;
  expiresAt: number | null;
  /** v1.114.0: `owner/name` of the team repo the key names, or null for a
   *  key minted without `--team-repo`. Launch G3: reported only — the team
   *  this Mac is in is `settings.team.teamRepo`, and a key unlocks nothing. */
  teamRepo: string | null;
}

// ── Team (v1.114.0 — team sharing rung 1) ───────────────────────────

/** Listed in the team manifest AND able to read the team repo on GitHub.
 *  Each failure names the half that is missing — they have different fixes
 *  and different people fix them. `unknown` = not evaluated yet (no
 *  refresh this session, or `gh` was unreachable). */
export type Membership = "member" | "not_listed" | "no_repo_access" | "unknown";

export interface TeamWorkspaceView {
  repo: string;
  name: string;
  /** A workspace already points at **this repo's** checkout, never another's. */
  registered: boolean;
  /** This repo's checkout exists under the clone root. */
  cloned: boolean;
  folderPresent?: boolean; // U31: the folder at `localPath` is there.
  localPath: string;
  /** Set when both candidate paths under the clone root hold other
   *  repositories: there is nowhere to clone this one until the user moves
   *  one aside. The row renders the reason instead of a button. */
  conflict: string | null;
}

/** One member of the team, from the manifest. Mirrors `team::TeamMember`. */
export interface TeamMember {
  login: string;
  /** Exactly one member is the owner: the only person who edits members and
   *  team workspaces. */
  owner: boolean;
}

export interface TeamStatus {
  /** null = no key, or a key that names no team. */
  teamRepo: string | null;
  teamName: string | null;
  ownerLogin: string | null;
  /** v1.118.0: the manifest's members. Empty with no clone to read. */
  members: TeamMember[];
  /** v1.118.0: this account is the manifest's owner. False whenever Ply
   *  cannot prove it, including when GitHub could not say who this is —
   *  the backend gate takes the same direction. */
  isOwner: boolean;
  /** v1.118.0: repos dismissed from assisted discovery on this Mac. */
  ignoredRepos: string[];
  login: string | null;
  membership: Membership;
  membershipReason: string | null;
  /** The membership shown is GitHub's last answer, not one from this call
   *  — GitHub could not be asked. Adds still work for a known member, but
   *  the UI says the check was not fresh. */
  membershipStale: boolean;
  cloneRoot: string;
  cloneRootIsDefault: boolean;
  hasClone: boolean;
  workspaces: TeamWorkspaceView[];
  /** v1.116.0: the team library's skills, one row per skill with the
   *  vendors that can load it. */
  skills: TeamSkill[];
  /** Plugins Ply will not load, and why. Shown, not swallowed. */
  refusedSkills: RefusedPlugin[];
  /** This Mac may change the team library — Promote's gate, read from the
   *  cached membership. Offers "Remove from team". */
  canWriteLibrary: boolean;
  /** The refusal when `canWriteLibrary` is false; otherwise a caveat when
   *  GitHub has not said whether this account may write. */
  writeLibraryReason: string | null;
  /** GH #226: the team clone on this Mac holds library changes GitHub lacks
   *  AND GitHub holds some it lacks (as of the last fetch). Every library
   *  write stops until "Reapply mine on top" resolves it. null otherwise. */
  libraryDivergence: LibraryDivergence | null;
  /** GH #226 review 1: a rebase or merge left under way in the team clone —
   *  Ply's own interrupted reapply (`own`, which "Reapply mine on top"
   *  finishes) or one Ply didn't start. null when the clone is at rest. */
  libraryInterruption: LibraryInterruption | null;
  /** QoL 13.3: a collision put together on this Mac with the member's
   *  choices, not published yet — Publish or Undo. Absent from an older
   *  backend. */
  libraryResolved?: LibraryResolved | null;
  /** Advisory — everything above still renders. */
  error: string | null;
}

/** GH #226: commits only this Mac has (`ahead`) and only GitHub has
 *  (`behind`). Mirrors `team::LibraryDivergence`. */
export interface LibraryDivergence {
  ahead: number;
  behind: number;
  /** The team clone, for Details. */
  cloneDir: string;
}

/** QoL 13.3. Mirrors `team::LibraryResolved`. */
export interface LibraryResolved {
  /** The files settled, repo-relative (Details). */
  paths: string[];
  /** The backup Undo goes back to (Details). */
  backupRef: string;
  /** Where Keep both saved this Mac's versions. */
  asideDir: string | null;
  cloneDir: string;
}

/** QoL 13.3: one file's choice. Mirrors `team::ReapplyChoice`. */
export type ReapplyChoice = "mine" | "theirs" | "both";

/** QoL 13.3: what Move them aside did. Mirrors `team::MovedAside`. */
export interface MovedAside {
  dir: string;
  paths: string[];
}

/** GH #226 review 1. Mirrors `team::LibraryInterruption`. */
export interface LibraryInterruption {
  own: boolean;
  cloneDir: string;
}

/** GH #226: how "Reapply mine on top" ended. Mirrors `team::ReapplyResult`. */
export type ReapplyResult =
  | "published"
  | "in_step"
  | "collision"
  | "stopped"
  | "dirty"
  | "foreign"
  | "fetch_failed"
  | "push_refused"
  | "push_denied"
  | "push_timed_out"
  | "unrecovered"
  /** QoL 13.3: settled on this Mac with the member's choices, not pushed. */
  | "resolved";

/** GH #226: the report of one "Reapply mine on top". Mirrors
 *  `team::ReapplyReport`. */
export interface ReapplyReport {
  result: ReapplyResult;
  /** This Mac's commits still to publish (after a rebase, those GitHub
   *  doesn't already have). */
  reapplied: number;
  /** GitHub's commits this Mac did not have. */
  broughtIn: number;
  /** `collision`: the files changed on both sides; `dirty`: the files Ply
   *  didn't commit. Repo-relative names. */
  paths: string[];
  /** The backup of this Mac's tip, when a rebase ran. */
  backupRef: string | null;
  cloneDir: string;
  /** What happened, what was left untouched, what to do — words only; paths,
   *  refs and git's output are the other fields, for Details. */
  message: string;
  /** Git's own words, for Details. */
  detail: string | null;
  /** QoL 13.3: where Keep both saved this Mac's versions. Absent from an
   *  older backend. */
  asideDir?: string | null;
}

/** One skill in the team library. Mirrors `team_skills::TeamSkill`. */
export interface TeamSkill {
  /** Its directory name, which is its identity — and, measured against both
   *  CLIs, the name Claude invokes it by. */
  name: string;
  /** What Codex calls it, when the frontmatter `name` disagrees with the
   *  directory. Measured: the two CLIs genuinely use different names. */
  codexName: string | null;
  /** Never empty: a SKILL.md without a description is not a skill either CLI
   *  loads, so it is never listed. */
  description: string;
  /** The plugin it lives in — the CLIs namespace it as `<plugin>:<name>`. */
  plugin: string;
  /** Loadable by Claude Code. */
  claude: boolean;
  /** Loadable by Codex. */
  codex: boolean;
}

/** A plugin Ply refuses to hand to a CLI. Mirrors
 *  `team_skills::RefusedPlugin`. */
export interface RefusedPlugin {
  plugin: string;
  vendor: "claude" | "codex";
  reason: string;
  /** Skills hub H6b walk: the skills it would have offered. */
  skills?: string[];
}

export interface AddedTeamWorkspace {
  repo: string;
  path: string;
  name: string;
  cloned: boolean;
  registered: boolean;
  /** The membership behind this add came from the last successful check,
   *  not from GitHub just now. The toast says so. */
  membershipFromCache: boolean;
}

/** Local read: the key, the local clone and the last membership answer.
 *  No network, so the panel renders immediately. */
export function teamStatus() {
  return invoke<TeamStatus>("team_status");
}

/** Onboarding §8.3: solo or team for this Mac, as Rust derives it
 *  (`team::effective_work_mode`): an explicit `settings.team.workMode` wins,
 *  except that a GitHub Issues board is always team; otherwise a key naming a
 *  team repo, `settings.team.teamRepo` or a team clone make it team. The
 *  frontend follows `mode` and never re-derives it. */
export interface WorkModeView {
  mode: WorkMode;
  /** `settings.team.workMode` holds a choice (else `mode` is derived). */
  chosen: boolean;
}

/** Offline: the key, the workspaces and a listing of the team clones. */
export function teamWorkMode() {
  return invoke<WorkModeView>("team_work_mode");
}

/** Clone-or-pull the team repo and re-ask GitHub who you are and whether
 *  you may read it. */
export function teamRefresh() {
  return invoke<TeamStatus>("team_refresh");
}

/** GH #226: "Reapply mine on top" — rebase this Mac's unpublished team
 *  library changes onto GitHub's and publish them. Never a force-push; a
 *  collision is aborted with the clone left as it was. */
export function teamLibraryReapply(choices?: Record<string, ReapplyChoice>) {
  return invoke<ReapplyReport>("team_library_reapply", choices ? { choices } : undefined);
}

/** QoL 13.3: Undo a settled reapply — the team clone goes back to the
 *  backup. Local only. Resolves with the sentence to say. */
export function teamLibraryUndoResolve() {
  return invoke<string>("team_library_undo_resolve");
}

/** QoL 13.3: Move the team clone's uncommitted edits into a dated folder on
 *  this Mac, then put them back to the clone's last commit. Local only. */
export function teamLibraryMoveAside() {
  return invoke<MovedAside>("team_library_move_aside");
}

/** QoL 13.3: show the folder the set-aside copies are in. */
export function teamLibraryRevealAside() {
  return invoke<void>("team_library_reveal_aside");
}

/** GH #226 review 1: show the team clone in Finder. */
export function teamLibraryReveal() {
  return invoke<void>("team_library_reveal");
}

/** Onboarding §11.1: this Mac stops following its team. Clears
 *  `settings.team.teamRepo` (and, while teams are free, a key naming the
 *  team); deletes no clone, workspace or file. Returns the licence as it is
 *  after. */
export function teamLeave() {
  return invoke<LicenseInfo>("team_leave");
}

/** Pick one team workspace: clone it under the clone root and register it
 *  through the `import_default` path. Idempotent. Rejects when GitHub does
 *  not confirm membership (manifest AND read access) and there is no
 *  earlier "member" answer to fall back on. */
export function teamWorkspaceAdd(repo: string) {
  return invoke<AddedTeamWorkspace>("team_workspace_add", { repo });
}

// ── Owner-side team administration (v1.118.0 — rung 5) ──────────────

/** What the Create-team form starts from. Mirrors
 *  `commands::CreateTeamDefaults`. */
export interface CreateTeamDefaults {
  /** null when `gh` could not say who this is. */
  login: string | null;
  /** The GitHub repos this Mac's registered workspaces point at. */
  workspaces: { repo: string; name: string }[];
}

/** Mirrors `team_admin::CreatedTeam`. */
export interface CreatedTeam {
  name: string;
  repo: string;
  clonePath: string;
  /** The team was already there, finished and owned by this account — a
   *  push whose acknowledgement was lost, or a result never read.
   *  Nothing on GitHub was changed. */
  alreadyExisted: boolean;
  /** Launch T1: the repository is bound to the owner's Team plan. */
  bound?: boolean;
  /** Why it isn't bound yet; "Finish creating your team" retries. */
  bindError?: string | null;
}

/** What Ply would do about one repository, for one person. Mirrors
 *  `team_admin::InviteAction`. */
export type InviteAction = "grant" | "already_has" | "unresolved" | "invited" | "no_such_account";

/** Mirrors `team_admin::InviteRepoKind`. */
export type InviteRepoKind = "team_repo" | "workspace";

/** One line of the confirmation screen. Mirrors `team_admin::InviteStep`. */
export interface InviteStep {
  repo: string;
  kind: InviteRepoKind;
  /** Always `push`: sharing into the team library is a push, and so is
   *  working a card. */
  permission: string;
  /** What GitHub says they have now, in a word. */
  current: string;
  action: InviteAction;
  /** N14 (item 1): with `invited`, the day (`YYYY-MM-DD`) the pending
   *  invitation expires. */
  invitationExpires: string | null;
  purpose: string;
}

/** Everything the owner reads before a single `gh api` call is made.
 *  Mirrors `team_admin::InvitePlan`. */
export interface InvitePlan {
  login: string;
  teamName: string;
  steps: InviteStep[];
  /** Applying this plan also commits and pushes a manifest listing them. */
  addsToManifest: boolean;
  /** Manifest entries Ply cannot grant, named rather than dropped. */
  warnings: string[];
  /** The exact grants, carried back on confirm so Ply can refuse to grant
   *  anything the owner did not read. */
  digest: string;
}

/** Mirrors `team_admin::InviteOutcome`. */
export interface InviteOutcome {
  login: string;
  /** The team repo **on GitHub** lists them — not merely the local clone.
   *  Only ever true after a push Ply watched succeed, which is the whole
   *  precondition for granting anything. */
  listed: boolean;
  /** This call committed the manifest. False when it was already listed,
   *  including when an earlier attempt committed it locally and only the
   *  push was completed now. */
  manifestWritten: boolean;
  invited: string[];
  alreadyHad: string[];
  /** N14 (item 1): repositories where an invitation was already waiting on
   *  them — not sent again. */
  alreadyInvited: string[];
  /** Grants GitHub refused. The member is listed either way and each grant
   *  is an idempotent PUT, so retrying is safe. */
  failed: string[];
}

/** N14 (items 1 and 9): what a manifest member has on a repository.
 *  Mirrors `team_admin::MemberAccessState`. `unknown` is "GitHub couldn't be
 *  asked", never "no access". */
export type MemberAccessState = "joined" | "invited" | "no_access" | "unknown";

/** One row of Members. Mirrors `team_admin::MemberStateView`. */
export interface MemberStateView {
  login: string;
  owner: boolean;
  /** On the team repository. */
  state: MemberAccessState;
  /** With `invited`: the day (`YYYY-MM-DD`) the invitation expires. */
  invitationExpires: string | null;
  /** With `no_access`: the day an invitation they never accepted expired. */
  invitationExpired: string | null;
  workspacesInvited: string[];
  workspacesMissing: string[];
}

/** Mirrors `team_admin::MemberStates`. */
export interface MemberStates {
  members: MemberStateView[];
  /** "repo: why" for each repository GitHub didn't answer for. */
  problems: string[];
  /** Every repository Remove from team acts on, in order. */
  repos: string[];
}

/** What Remove from team did. Mirrors `team_admin::RemoveOutcome`. */
export interface RemoveOutcome {
  login: string;
  removed: string[];
  cancelledInvitations: string[];
  /** Repositories they can still read (private, or ownership unknown) —
   *  no write access, but said, neutrally. */
  stillRead: string[];
  /** "repo: why" for each repository that failed. */
  failed: string[];
  /** `team.json` on GitHub no longer lists them — only ever after every
   *  repository succeeded. */
  manifestUpdated: boolean;
  manifestError: string | null;
  /** Launch T2: their seat on the team's plan is free again. */
  seatFreed?: boolean;
  /** Why their seat is still taken (freed again from Members). */
  seatError?: string | null;
}

/** One repository worth proposing as a team workspace. Mirrors
 *  `team_admin::DiscoveryProposal`. */
export interface DiscoveryProposal {
  repo: string;
  description: string | null;
  private: boolean;
}

/** What one assisted-discovery scan found. Mirrors
 *  `team_admin::Discovery`. */
export interface Discovery {
  proposals: DiscoveryProposal[];
  /** How many repos were looked at — "nothing found" and "nothing was
   *  looked at" are different answers. */
  scanned: number;
  /** How many could not be checked. Never folded into "no marker". */
  unchecked: number;
  alreadyListed: number;
}

/** Who you are and which of your workspaces are GitHub repositories. */
export function teamCreateDefaults() {
  return invoke<CreateTeamDefaults>("team_create_defaults");
}

/** Create the team: a private GitHub repo, the manifest that defines the
 *  team, and the empty library. Needs a team key. An empty `repo` takes
 *  Ply's suggestion. */
export function teamCreate(name: string, repo: string, workspaces: string[]) {
  return invoke<CreatedTeam>("team_create", { name, repo, workspaces });
}

/** The confirmation screen: every repo the team owns, the permission Ply
 *  would grant, and what GitHub already gives this person. Writes nothing. */
export function teamInvitePlan(login: string) {
  return invoke<InvitePlan>("team_invite_plan", { login });
}

/** Apply the plan the owner just confirmed. Ply rebuilds it from scratch
 *  and refuses to grant a repository `confirmed` does not cover. */
export function teamInviteApply(login: string, confirmed: string) {
  return invoke<InviteOutcome>("team_invite_apply", { login, confirmed });
}

/** N14 (items 1 and 9): each member as Joined, Invited or No access, read
 *  from GitHub as the team's account. Owner-only. */
export function teamMemberStates() {
  return invoke<MemberStates>("team_member_states");
}

/** N14 (item 3): Remove from team — GitHub access on the team repo and every
 *  team workspace first, then the manifest. Owner-only. */
export function teamMemberRemove(login: string) {
  return invoke<RemoveOutcome>("team_member_remove", { login });
}

/** Assisted discovery: accessible repos carrying
 *  `.atelier/workspace_default.json`. Proposes only. */
export function teamDiscover() {
  return invoke<Discovery>("team_discover");
}

/** Dismiss one proposal on this Mac. Returns the new ignore list. */
export function teamDiscoveryIgnore(repo: string) {
  return invoke<string[]>("team_discovery_ignore", { repo });
}

/** Put every dismissed repository back in front of the owner. */
export function teamDiscoveryClearIgnored() {
  return invoke<string[]>("team_discovery_clear_ignored");
}

/** Add a repository to the team manifest as a team workspace. Returns false
 *  when the manifest already listed it. */
export function teamWorkspaceListAdd(repo: string, name: string | null) {
  return invoke<boolean>("team_workspace_list_add", { repo, name });
}

/** QoL 14.4 (G25): take a repository off the team's workspaces (owner
 *  only; the manifest edit Add makes, undone). Members' GitHub access and
 *  clones stay. False when it wasn't listed. */
export function teamWorkspaceListRemove(repo: string) {
  return invoke<boolean>("team_workspace_list_remove", { repo });
}

// ── OB-10: Setup's Team step — joining, invitations, Copy invite ─────

/** Mirrors `team_join::ProblemKind`. */
export type JoinProblemKind =
  | "not-a-code"
  | "newer-version"
  | "no-access"
  | "not-listed"
  | "not-a-team"
  | "expired"
  | "invitation-gone"
  | "needs-replace"
  | "sso"
  | "offline"
  | "signed-out"
  | "rate-limited"
  | "other";

/** Why a join can't go on. Mirrors `team_join::JoinProblem`. */
export interface JoinProblem {
  kind: JoinProblemKind;
  words: string;
  /** The organisation a single sign-on refusal named. */
  org: string | null;
  repo: string | null;
  /** A GitHub invitation was accepted before this stopped. */
  accepted: boolean;
  /** gh's own words, for Details. */
  details: string | null;
}

/** A team this account can already read that lists it (§12.4). */
export interface DetectedTeam {
  repo: string;
  name: string;
  owner: string | null;
  current: boolean;
}

export interface JoinDetection {
  login: string;
  teams: DetectedTeam[];
  scanned: number;
  truncated: boolean;
  unanswered: number;
  /** The overall deadline stopped the look before every repository. */
  timedOut: boolean;
  problem: JoinProblem | null;
}

export interface JoinTeamFacts {
  repo: string;
  url: string;
  name: string | null;
  /** The repository's owner as GitHub says. */
  repoOwner: string | null;
  repoOwnerIsOrg: boolean;
  manifestOwner: string | null;
  private: boolean | null;
  login: string;
}

export interface JoinWorkspaceInvite {
  id: number;
  repo: string;
  inviter: string | null;
}

export interface JoinCurrentTeam {
  repo: string;
  name: string | null;
}

/** The Join sheet. Mirrors `team_join::JoinPreview`. */
export type JoinPreview =
  | {
      kind: "ready";
      team: JoinTeamFacts;
      workspaceInvites: JoinWorkspaceInvite[];
      replaces: JoinCurrentTeam | null;
      alreadyIn: boolean;
      calls: string[];
    }
  | {
      kind: "invited";
      team: JoinTeamFacts;
      invitation: { id: number; inviter: string | null; inviterNotOwner: boolean };
      replaces: JoinCurrentTeam | null;
      calls: string[];
    }
  | { kind: "problem"; problem: JoinProblem };

export interface JoinWorkspaceAccepts {
  accepted: string[];
  failed: { repo: string; words: string }[];
  pending: JoinWorkspaceInvite[];
}

export type JoinResult =
  | {
      kind: "joined";
      repo: string;
      name: string;
      acceptedInvitation: boolean;
      workspaces: JoinWorkspaceAccepts;
      replaced: string | null;
    }
  | { kind: "problem"; problem: JoinProblem };

export interface JoinRequest {
  repo: string;
  /** The team repository's invitation the sheet showed. */
  acceptInvitation: number | null;
  /** The team workspaces whose invitations the sheet listed. */
  acceptWorkspaces: string[];
  /** The one-team-per-Mac replacement was confirmed. */
  replace: boolean;
}

/** Teams this account can already read whose `team.json` lists it. Kept
 *  for the session per account; `refresh` looks again. */
export function teamJoinDetect(account: string | null = null, refresh = false) {
  return invoke<JoinDetection>("team_join_detect", { account, refresh });
}

/** The Join sheet for a pasted invite code (or a detected team's
 *  `owner/name`). Reads GitHub; changes nothing. */
export function teamJoinPreview(code: string, account: string | null = null) {
  return invoke<JoinPreview>("team_join_preview", { code, account });
}

/** The sheet's Join: accept the invitation it showed (only that one), check
 *  `team.json` lists this account, then record the team. */
export function teamJoinConfirm(request: JoinRequest, account: string | null = null) {
  return invoke<JoinResult>("team_join_confirm", { request, account });
}

/** Pending invitations to this Mac's team's workspaces. `account` null =
 *  the one the team was joined with (`settings.team.account`). */
export function teamJoinWorkspaceInvites(account: string | null = null) {
  return invoke<JoinWorkspaceAccepts>("team_join_workspace_invites", { account });
}

/** Accept the invitations to the named team workspaces (only ones the
 *  manifest lists). */
export function teamJoinAcceptWorkspaces(repos: string[], account: string | null = null) {
  return invoke<JoinWorkspaceAccepts>("team_join_accept_workspaces", { repos, account });
}

/** Copy invite (§12.2): this Mac's team's code and its message. */
export function teamInviteCode() {
  return invoke<{ code: string; message: string }>("team_invite_code");
}

// ── Project skills (v1.117.0 — team sharing rung 4) ──────────────────

/** What a copy would do, summed over its destinations. Mirrors
 *  `project_skills::CopyState`. */
export type CopyState = "absent" | "same" | "partial" | "differs";

/** One skill the repository carries. Mirrors `project_skills::ProjectSkill`
 *  plus the row fields the panel needs. */
export interface ProjectSkillRow {
  /** Its directory name: the identity, the path, and the name Claude uses. */
  name: string;
  /** What Codex calls it, when the frontmatter `name` disagrees. */
  codexName: string | null;
  description: string;
  /** Loaded by Claude Code — i.e. present in `.claude/skills`. */
  claude: boolean;
  /** Loaded by Codex — i.e. present in `.agents/skills` or `.codex/skills`. */
  codex: boolean;
  /** The repo-relative roots it was found in. */
  roots: string[];
  /** Two roots hold it with different bytes: both CLIs load it, and not the
   *  same instructions. */
  diverged: boolean;
  /** Its roots whose copy git ignores here: a card never carries them. */
  ignoredRoots: string[];
  /** The team library's copy, compared with this repo's. */
  team: CopyState;
  /** Why this one cannot be promoted as it stands. */
  promoteBlocked: string | null;
  /** Owner, 2026-10-19: `promoteBlocked` says only "isn't on <branch> yet,
   *  publish it first" — the way to a Promote, shown only where Promote is
   *  the next thing to offer. */
  promoteWaitsForBranch?: boolean;
  /** N14 item 2: Promote shares the branch's copy although this checkout's
   *  two differ — "your local changes aren't included". */
  promoteNote?: string | null;
}

/** One team-library skill, with what installing it here would do. */
export interface InstallableTeamSkill extends TeamSkill {
  /** This repo's copies, compared with the library's. */
  repo: CopyState;
  /** The roots an Install would write that git ignores here. */
  ignoredRoots: string[];
  /** GH #227: the roots an Install would write that git gave no answer for,
   *  with the reason. */
  unknownRoots: UnansweredPath[];
  /** GH #96: the library directory it is read from, absolute — what the
   *  Library's `Compare` reads the team's `SKILL.md` out of. */
  dir: string | null;
  /** Skills hub H6a: its scripts have no OK on this Mac. Absent from an
   *  older backend, null when it needs none. */
  needsOk?: SkillNeedsOk | null;
}

/** Skills hub H6a (R15): a team skill held for an OK. Mirrors
 *  `skill_scripts::NeedsOk`. */
export interface SkillNeedsOk {
  plugin: string;
  skill: string;
  /** No earlier version reaches sessions meanwhile. */
  firstTime: boolean;
  /** When the version sessions keep was approved; null when it was all text. */
  approvedAt: number | null;
  /** A script is among what asks; false when only extra files do. */
  bringsScript: boolean;
  scriptsIds: string[];
}

/** One file on the *Needs your OK* sheet. Mirrors `skill_scripts::ReviewFile`. */
export interface ScriptsReviewFile {
  path: string;
  kind: "script" | "extra" | "asks" | "text";
  executable: boolean;
  size: number;
  change: "new" | "changed" | "unchanged";
  /** Its text, when it is UTF-8 and small enough to show. */
  text: string | null;
  /** Over the size the sheet shows inline. */
  tooLarge: boolean;
  /** The CLIs whose copy holds it, when the two copies differ; else empty. */
  copies: ("claude" | "codex")[];
}

/** Mirrors `skill_scripts::ScriptsReview`. */
export interface ScriptsReview {
  skill: string;
  plugin: string;
  /** The library commit shown — an OK approves exactly this. */
  commit: string;
  scriptsIds: string[];
  firstTime: boolean;
  approvedAt: number | null;
  author: string | null;
  files: ScriptsReviewFile[];
}

/** A skill directory neither CLI loads, and why. */
export interface UnloadableSkill {
  name: string;
  root: string;
  reason: string;
}

/** Everything Settings → This workspace → Project shows about skills.
 *  Mirrors `project_skills::ProjectSkillsView`. */
export interface ProjectSkillsView {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  skills: ProjectSkillRow[];
  /** The team library's skills, for Install. Empty off a team. */
  team: InstallableTeamSkill[];
  unloadable: UnloadableSkill[];
  /** The skill roots that exist in this repo. */
  rootsPresent: string[];
  /** The skill roots git ignores in this repo (present ones and the two
   *  Install writes). */
  ignoredRoots: string[];
  /** A key naming a team repo is present. */
  configured: boolean;
  hasClone: boolean;
  /** A valid key *and* GitHub write access to the team repo. */
  canPromote: boolean;
  /** The refusal when `canPromote` is false; otherwise a caveat when Ply
   *  could not confirm write access and is letting GitHub be the answer. */
  promoteReason: string | null;
  /** Skills hub H4 step 8 c: `canPromote` is false because GitHub lets this
   *  member read the team repo and not write it — not the team gate, not a
   *  missing clone (switched off, left), not the absence of a team.
   *  `promoteReason` is then GitHub's refusal. Absent from an older backend. */
  promoteRefused?: boolean;
  /** The plugin a Promote writes into. */
  promotePlugin: string;
  errors: string[];
  /** Whether Codex sessions here get the team library's Codex half: the
   *  overlay can be refused (a colliding marketplace, a config Plyloft cannot
   *  parse, a Windows that cannot link the Codex home). Null when the library
   *  has no Codex half; absent from an older backend. */
  teamCodex?: { reaches: boolean; refused: string | null } | null;
}

/** A path git gave no answer for, and why in words. Mirrors
 *  `project_skills::Unanswered`. */
export interface UnansweredPath {
  path: string;
  reason: string;
}

/** What a copy actually did. Mirrors `project_skills::CopyOutcome`. */
export interface CopyOutcome {
  written: string[];
  unchanged: string[];
  /** Repo-relative roots among them that git ignores — a card cannot carry
   *  those copies. */
  ignored: string[];
  /** GH #227: roots among them git gave no answer for, with the reason
   *  (behind a link, inside a submodule, git too slow) — never promised to a
   *  card. */
  unknown: UnansweredPath[];
}

/** What a Promote did. Mirrors `commands::PromotedSkill`. */
export interface PromotedSkill {
  skill: string;
  plugin: string;
  copied: CopyOutcome;
  /** False when the library already held these exact bytes. */
  committed: boolean;
  /** The team repo on GitHub has it now. False only for a local-only team
   *  repo — nothing reached a teammate. */
  pushed: boolean;
  /** N14 item 2: the branch the shared copy was read from. */
  branch?: string;
  /** N14 item 2: "Your local changes … aren't included", when this checkout's
   *  copy differed from the branch's. */
  leftOut?: string | null;
  /** Skills hub H4 (R7): opened as a pull request instead of a push. */
  pullRequest?: PromotePullRequest | null;
}

/** Skills hub H4 (R7): a share that became a pull request in the team
 *  repository (`commands::PromotePullRequest`). */
export interface PromotePullRequest {
  url: string;
  number: number | null;
  /** "Ana changed it meanwhile — opened pull request #31 instead." */
  why: string;
}

/** The repo's own skills and the team library's, per workspace. Free: no
 *  key needed to look, and none to install. */
export function projectSkillsView(workspaceId: string) {
  return invoke<ProjectSkillsView>("project_skills_view", { workspaceId });
}

/** One skill of this Mac, read out of the member's own CLI folders. Mirrors
 *  `personal_skills::PersonalSkill`. */
export interface PersonalSkill {
  /** Its directory name: the identity, and the name Claude uses. */
  name: string;
  codexName: string | null;
  description: string;
  claude: boolean;
  codex: boolean;
  /** The home-relative roots it was found in. */
  roots: string[];
  /** The absolute directory of the first of those roots. */
  dir: string;
}

/** Everything the member's own skill directories hold. Mirrors
 *  `personal_skills::PersonalSkills`. */
export interface PersonalSkills {
  skills: PersonalSkill[];
  rootsPresent: string[];
  errors: string[];
}

/** GH #96 (ADR 0005): this Mac's own skills, for the Library's `On this Mac`
 *  section. Read-only — Ply lists and opens them and never writes there. */
export function personalSkillsView() {
  return invoke<PersonalSkills>("personal_skills_view");
}

/** GH #106: one skill that ships inside the app. Mirrors
 *  `commands::PlySkillRow`. */
export interface PlySkill {
  /** Its directory name, which is its identity in both CLIs (`ply:card-brief`). */
  name: string;
  /** The `SKILL.md`'s own first heading — the plain name the row shows. */
  title: string;
  description: string;
  /** The bundled directory, so the skill's page can read its text. */
  dir: string;
  claude: boolean;
  codex: boolean;
  /** Switched on on this Mac (`settings.library.plySkillsOff`). */
  on: boolean;
  /** Skills hub H9 (R9): the Plyloft version that last changed it. Absent or
   *  null from a build without `CHANGES.json`. */
  version?: string | null;
  /** …and every version, newest first. */
  changes?: PlySkillChange[];
  /** The switch at every level, in the workspace the view was read for. */
  switch?: PlySkillSwitch | null;
}

/** `ply_skills::SkillChange`. */
export interface PlySkillChange {
  version: string;
  contentId: string;
  summary: string;
}

/** `ply_skill_switch::Level`: who decided a Plyloft skill's switch. */
export type PlySwitchLevel = "workspace" | "fork" | "team" | "mac" | "default";

/** `ply_skill_ipc::PlySwitchView`. */
export interface PlySkillSwitch {
  /** What this workspace's next session gets. */
  on: boolean;
  level: PlySwitchLevel;
  /** This workspace's explicit choice, if any. */
  workspace: boolean | null;
  /** The repository holds a fork of it linked to Plyloft. */
  fork: boolean;
  /** The team switched it off. */
  teamOff: boolean;
  macOn: boolean;
}

/** `ply_skill_ipc::PlyPlace`: where the switch was read. */
export interface PlyPlace {
  workspaceName: string;
  /** `acme/web`, for "set in acme/web". */
  repository: string | null;
  /** The workspace has a shared definition. */
  shared: boolean;
  readOnly: boolean;
  team: { slug: string; name: string; owner: string | null; youOwn: boolean } | null;
}

/** GH #106: the `Comes with Ply` section. Mirrors `commands::PlySkillsView`. */
export interface PlySkillsView {
  skills: PlySkill[];
  /** Skills hub H9: the workspace this was read for, and its team. */
  place?: PlyPlace | null;
  /**
   * Why these skills reach nothing, when they reach nothing — a build that could
   * not be made, or one no CLI would load. Said once under the section heading.
   * `null` in the ordinary case, and also when every skill is switched off: that
   * is a choice, not a fault.
   */
  problem: string | null;
}

/**
 * GH #106 (ADR 0005, BOARDS.md §3): the skills that come with Ply, for the
 * `Comes with Ply` section and each one's page.
 *
 * Read-only: the bundle is the app's own directory and Ply never writes it. No
 * workspace — these are switched on per Mac, so the answer is the same from every
 * workspace. Empty on a build with no bundle, and the section is then absent
 * rather than drawn empty.
 */
export function plySkillsView(workspaceId?: string) {
  return invoke<PlySkillsView>("ply_skills_view", { workspaceId: workspaceId ?? null });
}

/**
 * Skills hub H9 (R9): a Plyloft skill's switch at the workspace or team level.
 * `choice`: `false` off, `true` on (workspace only — the team can only switch
 * off, Q27), `null` no choice at that level. The workspace level of a shared
 * workspace is a field of its definition (published like every field); the
 * team level is the owner's, written to `team.json`. This Mac's level stays
 * `settings.library.plySkillsOff`.
 */
export function plySkillSetting(
  level: "workspace" | "team",
  workspaceId: string,
  name: string,
  choice: boolean | null,
) {
  return invoke<void>("ply_skill_setting", { level, workspaceId, name, choice });
}

/** `ply_skill_ipc::Personalized`. */
export interface PlySkillPersonalized {
  card: KanbanCard | null;
  plugin: string | null;
  pushed: boolean;
  pullRequest: { url: string; number: number; why: string } | null;
  teamSwitched: boolean;
  owner: string | null;
  /** The owner's own team-default write failed after the fork was shared. */
  teamSwitchProblem?: string | null;
}

/** Skills hub H9 (R9): Personalize a Plyloft skill into this workspace's
 *  repository (a skill card) or into the team library. */
export function plySkillPersonalize(
  workspaceId: string,
  name: string,
  target: "repository" | "team",
  replace = false,
) {
  return invoke<PlySkillPersonalized>("ply_skill_personalize", { workspaceId, name, target, replace });
}

/**
 * GH #100 (BOARDS.md §4, state D): show a personal skill's folder in Finder.
 *
 * `dir` must be one `personalSkillsView` listed — the backend refuses every
 * other path in words (`personal_skills::listed_skill_dir`), so a stale page
 * whose skill has since moved gets a sentence rather than a Finder window on
 * somewhere else. Reveals; still never writes.
 */
export function personalSkillReveal(dir: string) {
  return invoke<void>("personal_skill_reveal", { path: dir });
}

/** GH #100: who last changed a skill, and when. Mirrors
 *  `skill_history::SkillHistory`; every field is absent rather than guessed. */
export interface SkillHistory {
  /** The branch the history was read from, for the `Details` line. */
  gitRef: string | null;
  author: string | null;
  /** The commit's author date, epoch **seconds**. */
  at: number | null;
  /** The abbreviated commit id. */
  commit: string | null;
}

/**
 * GH #100 (BOARDS.md §4): the fact line's `Last changed by X 7 weeks ago` and
 * the `Details` line's `staging · a3f9c21 · X · 2026-07-30 14:12`.
 *
 * Read with `git log`, which writes nothing: a repository skill from the
 * integration branch when the workspace shares one and from the checkout's own
 * `HEAD` otherwise, a team skill from the clone Ply keeps in step. The scope and
 * the name are all the window chooses — the revision and the paths are the
 * backend's, so neither can be pointed out of the tree. `this-mac` and `ply`
 * answer with every field empty: they are not repositories, and the page leaves
 * that part of the line out rather than inventing it.
 */
export function skillHistory(
  workspaceId: string,
  scope: "repository" | "team" | "this-mac" | "ply",
  skill: string,
  plugin: string | null,
) {
  return invoke<SkillHistory>("skill_history", {
    workspaceId,
    scope,
    skill,
    plugin,
  });
}

/** What promoting a personal skill did. Mirrors
 *  `commands::PromotedPersonalSkill`. */
export interface PromotedPersonalSkill {
  skill: string;
  /** The team plugin, when it went to the team library. */
  plugin: string | null;
  copied: CopyOutcome;
  committed: boolean;
  pushed: boolean;
  /** Skills hub H4 (R7): opened as a pull request instead of a push. */
  pullRequest?: PromotePullRequest | null;
}

/** GH #96: promote one of this Mac's skills into this repository (a copy in
 *  both CLIs' roots, committing nothing) or into the team library (one commit,
 *  pushed). The member's own copy is only ever read. */
export function personalSkillPromote(
  workspaceId: string,
  skill: string,
  target: "repository" | "team",
  replace: boolean,
) {
  return invoke<PromotedPersonalSkill>("personal_skill_promote", {
    workspaceId,
    skill,
    target,
    replace,
  });
}

/** Promote: copy one project skill into both halves of the team library,
 *  committed and pushed as one change. Needs a key and GitHub write access.
 *  `replace` overwrites a library copy that differs — ask first. */
export function projectSkillPromote(
  workspaceId: string,
  skill: string,
  replace: boolean, shown?: string | null,
) {
  return invoke<PromotedSkill>("project_skill_promote", {
    workspaceId,
    skill,
    replace, shown: shown ?? null,
  });
}

/**
 * Why Install or Promote wrote nothing because a destination holds a
 * different skill (`project_skills::NotTheSameSkill`) — the one refusal the
 * Skills page answers with the Replace question. `projectSkillInstall`,
 * `projectSkillPromote` and `personalSkillPromote` reject with this object;
 * every other reason is still a plain string. Read it with
 * `asNotTheSameSkill` (projectSkills.ts), never by matching the sentence.
 */
export interface NotTheSameSkill {
  /** The destination that holds something else. */
  notTheSameSkill: string;
  /** The refusal in words. */
  message: string;
}

/** Skills hub H3a: what an Install did (`commands::SkillInstalled`). */
export type SkillInstalled =
  /** The skill card, at its Ship step: its one commit holds both copies and
   *  the link record. */
  | { kind: "card"; card: KanbanCard }
  /** A workspace folder that is not a git repository: the copies were
   *  written straight into it. */
  | { kind: "written"; copied: CopyOutcome };

/** Skills hub H3a (R2): Install makes a skill card (§14 Q1 — the untracked
 *  install is retired). `replace` is *Link and update* over a different,
 *  unlinked copy of the same name. Rejects with `NotTheSameSkill` without it. */
export function skillsHubInstall(
  workspaceId: string,
  plugin: string,
  skill: string,
  replace: boolean,
  /** Skills hub H6b: the scripts ids the Install-time sheet's OK named. */
  scriptsOk?: string[],
  /** Skills hub H10: install from My library. */
  library?: "mine",
) {
  return invoke<SkillInstalled>("skills_hub_install", {
    workspaceId,
    plugin,
    skill,
    replace,
    ...(scriptsOk ? { scriptsOk } : {}),
    ...(library ? { library } : {}),
  });
}

/** Skills hub H3a (R2): Update a linked copy whose origin moved on —
 *  a skill card. Refused for a copy modified here — unless `takeUpstream` (H4, R3 *Take upstream*):
 *  then the card replaces this repository's copy with the library's. */
export function skillsHubUpdate(workspaceId: string, skill: string, takeUpstream = false, scriptsOk?: string[]) {
  return invoke<KanbanCard>("skills_hub_update", {
    workspaceId,
    skill,
    ...(takeUpstream ? { takeUpstream } : {}),
    ...(scriptsOk ? { scriptsOk } : {}),
  });
}

/** One file of the 3-way Compare (`skills_hub_decisions::Compare3File`). */
export interface Compare3File {
  path: string;
  /** `both` — both sides changed it; `here` — only this repository;
   *  `upstream` — only the library; `same` — the same change on both;
   *  `differs` — no base to say whose. */
  status: "both" | "here" | "upstream" | "same" | "differs";
  base: string | null;
  upstream: string | null;
  here: string | null;
  /** A side that isn't text or is over 1 MB. */
  notShown: boolean;
}

/** Skills hub H4 (R3): the 3-way Compare of a linked copy. */
export interface Compare3 {
  skill: string;
  originWords: string;
  baseLabel: string | null;
  upstreamLabel: string;
  hereLabel: string;
  files: Compare3File[];
  /** Why it is 2-way (the version it started from isn't on this Mac). */
  note: string | null;
  /** After Keep mine: why lines this repository never edited are marked. */
  keptNote?: string | null;
  state: SkillLinkState;
  /** Why *Propose mine upstream* can't be pressed, once known. */
  proposeBlocked: string | null;
}

/** Skills hub H4 (R3): base / upstream now / here, per file. */
export function skillsHubCompare3(workspaceId: string, skill: string) {
  return invoke<Compare3>("skills_hub_compare3", { workspaceId, skill });
}

/** Skills hub H4 (R3): *Keep mine* — a one-file skill card (the link
 *  record) that keeps this repository's copy, linked, over the library's
 *  version now. */
export function skillsHubKeepMine(workspaceId: string, skill: string) {
  return invoke<KanbanCard>("skills_hub_keep_mine", { workspaceId, skill });
}

/** What *Propose mine upstream* opened (`skills_hub_decisions::ProposedUpstream`). */
export interface ProposedUpstream {
  skill: string;
  url: string;
  number: number | null;
  /** A commit was added to this Mac's pull request already open for it. */
  addedToOpen: boolean;
}

/** Skills hub H4 (R3, R7; the team plan): a pull request in the
 *  team repository with this repository's copy. Never a push. */
export function skillsHubProposeUpstream(workspaceId: string, skill: string) {
  return invoke<ProposedUpstream>("skills_hub_propose_upstream", { workspaceId, skill });
}

/** Skills hub H4 (R8, free): a skill the library removed — `keep`
 *  detaches it (a card removes the link record), `remove` is a card that
 *  deletes both copies and the record. */
export function skillsHubRemovedChoice(workspaceId: string, skill: string, choice: "keep" | "remove") {
  return invoke<KanbanCard>("skills_hub_removed_choice", { workspaceId, skill, choice });
}

/** Skills hub H4 (R8 edge, free): a skill the library renamed — `rename`
 *  moves the copies here too, `keepName` keeps the name and stays linked. */
export function skillsHubRenamedChoice(workspaceId: string, skill: string, choice: "rename" | "keepName") {
  return invoke<KanbanCard>("skills_hub_renamed_choice", { workspaceId, skill, choice });
}

/** Skills hub H3a: *Refresh this card* — the origin changed the skill
 *  again while the card was open. */
export function skillsHubCardRefresh(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("skills_hub_card_refresh", { workspaceId, cardId });
}

/** `commands::SkillCardBehind`. */
export interface SkillCardBehindAnswer {
  behind: boolean;
  /** Windows walk (H6b step 9): Refresh card would be refused — the newer
   *  version brings a new or changed script (`"script"`) or file that is
   *  not text (`"file"`) the card's copies don't hold. */
  showsFirst: "script" | "file" | null;
}

/** Mac walk 2 (H3a): the skill card carries an older version than its
 *  origin has now (this Mac's team clone, no network) — the card offers
 *  Refresh card, or (H6b) says the newer version is shown first. Not behind
 *  for every other card. */
export function skillsHubCardBehind(workspaceId: string, cardId: string) {
  return invoke<SkillCardBehindAnswer>("skills_hub_card_behind", { workspaceId, cardId });
}

/** `skill_links::LinkState`. H4 adds `bothChanged`, `removed` and
 *  `renamed` (the H3 `notInOrigin` became `removed`). */
export type SkillLinkState =
  | "upToDate"
  | "updateAvailable"
  | "modifiedHere"
  | "bothChanged"
  | "notAvailable"
  | "removed"
  | "renamed";

/** One linked copy (`commands::SkillLinkRow`). */
export interface SkillLinkRow {
  skill: string;
  originKind: string;
  /** "the team library". */
  originWords: string;
  source: string;
  plugin: string | null;
  versionCommit: string;
  state: SkillLinkState;
  /** The origin has a newer version too (a *Modified here* row may say so). */
  upstreamMoved: boolean;
  /** Skills hub H4: the library's new name, when it renamed the skill. */
  renamedTo?: string | null;
  /** H4: the last decision was Keep mine. */
  keptMine?: boolean;
  /** H4: the copy here differs from the version it was last in step with. */
  modifiedHere?: boolean;
  /** H4: this Mac's pull request proposing this copy, while the copy is
   *  still what it proposed. */
  proposal?: { number: number | null; url: string } | null;
  /** Skills hub H8 (R5): the link is kept on this Mac only — "Linked on
   *  this Mac". Absent from an older backend. */
  local?: boolean;
  /** Skills hub H9: a fork of a Plyloft skill — the Plyloft version that last
   *  changed the original. */
  upstreamVersion?: string | null;
}

export interface SkillLinksView {
  links: SkillLinkRow[];
  /** `[skill, why]` for a link record that can't be read. */
  unreadable: [string, string][];
  /** Skills hub H3b (R-M): unlinked copies that equal a version of the
   *  team's same-named skill. Absent from an older backend. */
  offers?: SkillLinkOffer[];
  /** Skills hub H5 (R12): checkout skills whose Claude and Codex copies are
   *  not aligned, or whose legacy `.codex/skills` copy disagrees. Absent
   *  from an older backend. */
  twins?: SkillTwinRow[];
  /** QoL 13.1: checkout skills written into the project folder and not
   *  committed — the row offers Ship it with a card. Absent from an older
   *  backend. */
  uncommitted?: string[];
}

/** QoL 13.1: **Ship it with a card** — a skill card carrying `skill` as it
 *  is in the project folder (its copies, and its link record when the
 *  folder holds one). The folder is only read. Refused like every skill
 *  card, and when the target branch already holds it exactly. */
export function skillsHubCarry(workspaceId: string, skill: string) {
  return invoke<KanbanCard>("skills_hub_carry", { workspaceId, skill });
}

/** `skill_twins::Judgement`. */
export type TwinJudgement =
  | { state: "one" }
  | { state: "aligned" }
  | { state: "follows"; winner: "claude" | "codex" }
  | { state: "differ" };

/** `skills_hub_twins::TwinRow`. */
export interface SkillTwinRow {
  skill: string;
  twins: TwinJudgement;
  /** The row's sentence for that state ("" when only `legacy` speaks). */
  line: string;
  /** `.codex/skills/<skill>` disagrees with `.agents/skills/<skill>`. */
  legacy: boolean;
  /** The checkout's `HEAD` holds these two copies; otherwise the difference
   *  is only in this checkout and no card can carry an Align. */
  committed: boolean;
}

/** `skill_twins::Aligned`. */
export interface TwinAligned {
  skill: string;
  winner: "claude" | "codex";
}

/** `skills_hub_twins::AlignMade`. */
export interface AlignMade {
  card: KanbanCard;
  winner: "claude" | "codex";
  /** The legacy `.codex/skills` copy disagrees and stays as it is. */
  legacyNote: string | null;
}

/** Skills hub H5 (R12, free): **Align** by card — the losing copy becomes
 *  the winning one, file for file. `winner` null: the copy that changed
 *  alone wins (refused when both changed: the window asks). */
export function skillsHubAlign(workspaceId: string, skill: string, winner: "claude" | "codex" | null) {
  return invoke<AlignMade>("skills_hub_align", { workspaceId, skill, winner });
}

/** `commands::SkillLinkOffer`. */
export interface SkillLinkOffer {
  skill: string;
  plugin: string;
  /** "the team library". */
  originWords: string;
  /** The library commit of the version it equals. */
  versionCommit: string;
  /** It is the library's version now. */
  current: boolean;
  /** The checkout's copy is committed; otherwise there is nothing on the
   *  branch to link yet. */
  committed: boolean;
}

export function skillsHubLinks(workspaceId: string) {
  return invoke<SkillLinksView>("skills_hub_links", { workspaceId });
}

/** `commands::SkillsLinked`: the one Link card, and every skill asked for
 *  that it doesn't carry, `[skill, why]`. */
export interface SkillsLinked {
  card: KanbanCard;
  skipped: [string, string][];
}

/** Skills hub H3b (R-M): **Link** / **Link all** — one skill card that
 *  writes link records only, for copies that already equal a version of
 *  the team library. Free on every plan (§9). */
export function skillsHubLink(workspaceId: string, skills: string[]) {
  return invoke<SkillsLinked>("skills_hub_link", { workspaceId, skills });
}

/** One side of a linked copy's 2-way Compare. */
export interface LinkCompareSide {
  label: string;
  meaning: string;
  place: string;
  text: string | null;
}

export interface LinkCompare {
  left: LinkCompareSide;
  right: LinkCompareSide;
  /** Every other file that differs, by path inside the skill. */
  otherFiles: string[];
  /** H4 Mac walk: every file that differs, with whose change it is
   *  (`here` only you, `upstream` only the team, `differs` without a base). */
  files?: LinkCompareFile[];
  note: string | null;
}

/** One file that differs in a 2-way Compare. */
export interface LinkCompareFile {
  path: string;
  status: string;
  left: string | null;
  right: string | null;
  notShown: boolean;
}

/** Skills hub H3a: the 2-way Compare (free, read only). */
export function skillsHubCompare(workspaceId: string, skill: string) {
  return invoke<LinkCompare>("skills_hub_compare", { workspaceId, skill });
}

/** Group B decision §3: what `New skill…` wrote. Mirrors
 *  `project_skills::CreatedSkill`. */
export interface CreatedSkill {
  name: string;
  /** `.claude/skills/<name>/SKILL.md`, absolute — the copy opened in Code. */
  claudeFile: string;
  /** `.agents/skills/<name>/SKILL.md`, absolute. */
  codexFile: string;
}

/** Group B decision §3: `New skill…` — write the same `SKILL.md` into
 *  `.claude/skills/<name>` and `.agents/skills/<name>` in the checkout.
 *  Commits and publishes nothing. */
export function projectSkillCreate(workspaceId: string, name: string, description: string) {
  return invoke<CreatedSkill>("project_skill_create", { workspaceId, name, description });
}

/** What a Remove from team did. Mirrors `commands::RemovedTeamSkill`. */
export interface RemovedTeamSkill {
  skill: string;
  plugin: string;
  /** The library halves removed, repo-relative. */
  removed: string[];
  committed: boolean;
  /** The team repo on GitHub no longer has it. False only for a local-only
   *  team repo — nothing reached a teammate. */
  pushed: boolean;
}

/** Remove from team: retire one skill from both halves of the team library,
 *  committed and pushed as one change. Promote's gate. Copies installed in
 *  member repos are left alone. */
export function teamSkillRemove(plugin: string, skill: string) {
  return invoke<RemovedTeamSkill>("team_skill_remove", { plugin, skill });
}

export function licenseGet() {
  return invoke<LicenseInfo>("license_get");
}

// ── Plyloft account (launch A1 — account.rs) ─────────────────────────

/** Mirrors `account.rs::Plan`. Free whenever no valid entitlement is held. */
export type AccountPlan = "free" | "pro" | "team";

/** Mirrors `account.rs::AccountInfo`: the one place the plan is decided.
 *  Times are milliseconds since epoch. */
export interface AccountInfo {
  /** A session exists on this profile. */
  signedIn: boolean;
  login: string | null;
  /** GitHub numeric user id, as a string: the identity. */
  sub: string | null;
  plan: AccountPlan;
  teamRepo: string | null;
  teamRole: "owner" | "member" | null;
  /** Stripe status behind the plan; `past_due` = payment problem. */
  status: string | null;
  periodEnd: number | null;
  /** Launch A3: the subscription ends at `periodEnd` instead of renewing
   *  (always sent by the backend; optional for fixtures written before it). */
  cancelAtPeriodEnd?: boolean;
  /** The entitlement's expiry; null without a valid one. */
  exp: number | null;
  comp: boolean;
  /** A verified, unexpired entitlement is in hand. */
  entitlementValid: boolean;
  /** The last time the server answered. */
  lastCheckedAt: number | null;
  /** The last refresh could not reach the server (cached plan until `exp`). */
  offline: boolean;
  /** 1.178.0 (A3): the plan of the last verified entitlement, kept after it
   *  expires — the offline and "not checked" notices are said only when it
   *  was Team. Null: none was ever verified. */
  lastKnownPlan: AccountPlan | null;
  /** 1.178.0 (A3, A5): where the account's Team plan or seat is active, from
   *  the server's unsigned `team` field — shown only (notices, Use Team on
   *  this computer), never a gate: the signed `plan` decides what runs. */
  team: AccountTeam | null;
  deviceName: string | null;
}

/** `AccountInfo.team`. Null on the account: no Team plan or seat, signed
 *  out, or a server that predates the choice. */
export interface AccountTeam {
  /** `here`: active on this computer; `elsewhere`: on another one
   *  (`device`); `nowhere`: ready, and no computer has chosen it yet. */
  state: "here" | "elsewhere" | "nowhere";
  /** `elsewhere`: the other computer's generic label ("MacBook Pro"). */
  device: string | null;
  teamRepo: string | null;
  role: "owner" | "member" | null;
}

/** Mirrors `account.rs::ErrorCode`. */
export type AccountErrorCode =
  | "network"
  | "not_configured"
  | "bad_request"
  | "github_token_invalid"
  | "unauthorized"
  | "replaced"
  | "forbidden"
  | "seat_limit"
  | "seat_in_use"
  | "not_found"
  | "rate_limited"
  | "already_subscribed"
  | "already_bound"
  /** 1.178.0: Use Team on this computer on an account with no Team plan now. */
  | "no_team"
  | "server"
  | "bad_entitlement"
  | "keychain"
  | "expired_token"
  | "access_denied"
  | "device_flow"
  | "cancelled"
  | "internal";

/** What an account command rejects with. */
export interface AccountError {
  code: AccountErrorCode;
  message: string;
  /** `replaced` only: the device that took the plan. */
  deviceName?: string;
  /** A Stripe invoice page the refusal points to (a switch to Team waiting
   *  for its payment); the backend keeps only invoice.stripe.com. */
  url?: string;
}

/** What to show while GitHub's Device Flow waits: type `userCode` at
 *  `verificationUri`. */
export interface SignInStart {
  /** This sign-in's id; its `account://sign-in` events carry the same one. */
  attempt: number;
  userCode: string;
  verificationUri: string;
  /** Seconds the code stays valid. */
  expiresIn: number;
}

/** `account://sign-in` progress (`account.rs::SignInProgress`). */
export type SignInProgress =
  | { state: "waiting"; intervalSecs: number }
  | { state: "slow_down"; intervalSecs: number }
  | { state: "verifying" }
  | { state: "signed_in"; info: AccountInfo }
  | { state: "failed"; error: AccountError }
  | { state: "cancelled" };

/** Never touches the keychain or the network. */
export function accountGet() {
  return invoke<AccountInfo>("account_get");
}

/** Start the Device Flow; progress arrives on `account://sign-in`. */
export function accountSignInStart() {
  return invoke<SignInStart>("account_sign_in_start");
}

/** Launch A2: a debug build run with `PLYLOFT_DEV_SKIP_SIGNIN=1` never opens the
 *  keychain: Setup's account step reads Skipped (dev runs, the app tester's walks).
 *  Release builds always answer false. */
export function accountDevSkipSignIn() {
  return invoke<boolean>("account_dev_skip_sign_in");
}

export function accountSignInCancel() {
  return invoke<void>("account_sign_in_cancel");
}

/** Ask the server for the plan now. Offline resolves with `offline: true`. */
export function accountRefresh() {
  return invoke<AccountInfo>("account_refresh");
}

/** 1.178.0 (A3): the press of **Use Team on this computer** — the account's
 *  Team plan or seat becomes active here, and on the other computer at its
 *  next refresh; nobody is signed out. Rejects with an `AccountError`. */
export function accountUseTeam() {
  return invoke<AccountInfo>("account_use_team");
}

export function accountSignOut() {
  return invoke<AccountInfo>("account_sign_out");
}

/** Launch G3 (`license.rs::TeamAccess`): may team features run, and if not,
 *  why. */
export type TeamAccess =
  | { state: "allowed" }
  | { state: "no_team_plan" }
  | { state: "no_team" }
  | { state: "other_repo"; planRepo: string | null; teamRepo: string }
  | { state: "other_account"; login: string; teamLogin: string }
  /** Launch T3: the team's account without a seat on the owner's plan. */
  | { state: "no_seat"; owner: string; teamRepo: string }
  /** 1.178.0 (A3 D18): not signed in to Plyloft. */
  | { state: "signed_out" }
  /** 1.178.0 (A3 D19): the account's Team is active on another computer. */
  | { state: "team_elsewhere" }
  /** Review fix: the account's Team is ready on no computer yet. */
  | { state: "team_to_choose" };

/** Launch G1–G3 (`license.rs::PlanGates`): every plan decision, made by the
 *  backend. The frontend draws from it and never re-derives the policy. */
export interface PlanGates {
  plan: AccountPlan;
  entitlementValid: boolean;
  /** The entitlement's expiry; the window reads the gates again then. */
  exp: number | null;
  team: TeamAccess;
  teamAllowed: boolean;
  /** What a refused team action says; null when allowed. */
  teamRefusal: string | null;
}

// ── Team with seats and payment (launch T1–T3 — billing_client.rs, team_billing.rs)

export type BillingInterval = "month" | "year";

/** A GitHub account as plyloft-server names it. */
export interface TeamAccount {
  /** GitHub numeric id, as a string. */
  sub: string;
  login: string;
}

/** `GET /team` (`billing_client::TeamView`). */
export interface TeamView {
  teamRepo: string | null;
  owner: TeamAccount;
  /** Seats bought, the owner's included. */
  seats: number;
  /** Seat holders, the owner first. */
  assigned: TeamAccount[];
  /** Stripe status: active, trialing, past_due keep the plan. */
  status: string;
  periodEnd: number | null;
  /** The subscription's interval when the server says (Renew keeps it). */
  interval?: BillingInterval | null;
}

/** Where Create team stands (`team_billing::CreateStage`). */
export type CreateStage =
  | { stage: "sign_in" }
  | { stage: "choose" }
  | { stage: "create"; comp: boolean }
  | { stage: "bound"; teamRepo: string }
  | { stage: "member"; teamRepo: string | null }
  | { stage: "lapsed"; owner: boolean; ownerLogin: string; teamRepo: string | null; seats: number };

export interface TeamBilling {
  stage: CreateStage;
  team: TeamView | null;
  /** The server couldn't be asked (the page says so, with Look again). */
  error: AccountError | null;
}

/** `team_checkout_wait`'s answer. */
export type CheckoutWaitOutcome = { state: "paid"; info: AccountInfo } | { state: "pending" } | { state: "cancelled" };

export function teamBillingGet() {
  return invoke<TeamBilling>("team_billing_get");
}

/** Open Stripe Checkout for the Team plan in the browser, tied to this
 *  account. Rejects with an `AccountError` (`already_subscribed`, `network`, …). */
export function accountCheckout(plan: "team", interval: BillingInterval, seats: number | null = null) {
  return invoke<void>("account_checkout", { plan, interval, seats });
}

/** Open the Stripe Customer Portal (payment, invoices, cancel, seats).
 *  `not_found` when this account never had a subscription of its own. */
export function accountPortal() {
  return invoke<void>("account_portal");
}

/** Challenger H1: sign out every other computer of this account for good. */
export function accountSignOutOthers() {
  return invoke<number>("account_sign_out_others");
}

/** Ask for the plan every few seconds for up to two minutes. */
export function teamCheckoutWait() {
  return invoke<CheckoutWaitOutcome>("team_checkout_wait");
}

export function teamCheckoutWaitCancel() {
  return invoke<void>("team_checkout_wait_cancel");
}

/** "Finish creating your team": bind this Mac's team repo to the plan. */
export function teamBindCurrent() {
  return invoke<AccountInfo>("team_bind_current");
}

/** Free a seat held by somebody no longer in the team (owner only). */
export function teamSeatFree(sub: string) {
  return invoke<TeamView | null>("team_seat_free", { sub });
}

/** `team_billing::MemberIds`: the members with their GitHub ids, and the
 *  logins GitHub couldn't look up (then no seat is judged outside the team). */
export interface MemberIds {
  members: TeamAccount[];
  unresolved: string[];
}

/** The team's members with their GitHub ids (seats match by id). Owner only. */
export function teamMemberIds() {
  return invoke<MemberIds>("team_member_ids");
}

/** Give a seat to a listed member who holds none. Owner only. */
export function teamSeatGive(login: string) {
  return invoke<void>("team_seat_give", { login });
}

export function planGatesGet() {
  return invoke<PlanGates>("plan_gates_get");
}

/** Debug builds only (the command is compiled out of release builds): load a
 *  `PLY2-` token minted with the dev keypair as this profile's plan. */
export function accountDevLoadEntitlement(token: string) {
  return invoke<AccountInfo>("account_dev_load_entitlement", { token });
}

export function onAccountChanged(handler: (info: AccountInfo) => void): Promise<UnlistenFn> {
  return listen<AccountInfo>("account://changed", (event) => handler(event.payload));
}

/** `account://sign-in` payloads (`account.rs::SignInEvent`): the progress,
 *  tagged with its sign-in attempt. */
export type SignInEvent = SignInProgress & { attempt: number };

export function onAccountSignIn(handler: (event: SignInEvent) => void): Promise<UnlistenFn> {
  return listen<SignInEvent>("account://sign-in", (event) => handler(event.payload));
}

// ── Overlap warning (v1.86.0 — team-tier roadmap cycle 3) ───────────

/** One advisory overlap row: this card's changed files vs another card's
 *  live worktree (`local_card`, free) or an open PR in the workspace's
 *  repo (`teammate_pr`, team-gated backend-side). */
export interface OverlapWarning {
  kind: "local_card" | "teammate_pr";
  otherId: string;
  otherTitle: string;
  files: string[];
}

/** `teammates: false` (solo mode, onboarding §10 row 8) leaves the teammate
 *  half out: the open pull requests are not fetched at all. */
export function cardOverlapCheck(workspaceId: string, cardId: string, teammates = true) {
  return invoke<OverlapWarning[]>("card_overlap_check", {
    workspaceId,
    cardId,
    teammates,
  });
}

/** v1.62.0: does editing `absPath` require a CODEOWNERS reviewer in the
 *  workspace's repo? Backend makes the path repo-relative and reads
 *  `<cwd>/.github/CODEOWNERS`. Never throws on a missing file (returns
 *  not-flagged). Powers the editor ribbon. */
export function codeownersCheck(workspaceId: string, absPath: string) {
  return invoke<CodeownersCheck>("codeowners_check", { workspaceId, absPath });
}

// ── Inbox (v1.65.0 — UX revamp step 1) ─────────────────────────────
// docs/ux-revamp/STEP1.md. The feed is a backend-derived VIEW over state
// the app already persists; `seen` is the only persisted inbox state.

/** 1.173.0 (F1): Failed folded into Needs you (a failed card is the
 *  Board's Needs you card); a session Plyloft's quit left behind is On hold;
 *  a standalone run that finished is News. Not persisted — the seen store
 *  keeps row ids only, and no id changed. */
export type InboxGroup =
  | "needs_you"
  | "running"
  | "shipped"
  | "on_hold"
  | "news"
  | "scheduled";

export type InboxEventKind =
  | "review_needed"
  | "card_failed"
  | "verify_failed"
  // GH #104 (ADR 0005): the Challenger proposed one change to a skill or the
  // instructions. Replaced the retired post-ship lesson's `knowledge_decision`.
  | "skill_change_waiting"
  | "run_done"
  | "run_failed"
  | "pr_review"
  | "shipped"
  | "card_running"
  | "card_queued"
  | "run_running"
  | "schedule_upcoming"
  // SL-1: the card's pull request on GitHub.
  | "pr_checks_failed"
  | "pr_changes_requested"
  | "pr_conflict"
  // 1.169.1 (R1): a pull request ready to merge asks for its Merge.
  | "pr_ready_to_merge"
  /** G1–G3 Challenger (2): the pull request has commits Plyloft didn't push. */
  | "pr_head_moved"
  | "pr_merged"
  | "pr_closed"
  // G7: Fix failing checks by itself stopped (the detail is its reason).
  | "pr_auto_fix_stopped"
  // G5: merged, and this computer's target is still behind GitHub's.
  | "bring_up_to_date"
  // Skills hub H6a: a team skill whose scripts wait for an OK on this Mac.
  | "skill_needs_ok"
  // Skills hub H2 (R16): GitHub no longer lets this account read the team library.
  | "library_access_lost"
  // Skills hub H4 (R3, R8): a linked copy asks for a decision.
  | "skill_decision"
  // Skills hub H6b walk (R15): a team plugin Plyloft refuses for a CLI.
  | "team_plugin_refused"
  // 1.173.0 (C3): a shared setting both sides changed waits for a choice.
  | "shared_setting_conflict"
  // 1.173.0 (E3): a Next improvement round's ideas wait for a choice.
  | "next_improvement_ideas"
  // 1.174.0 (DR4): one row per release ("site-v3.0.2 released · 5 cards"),
  // and a recorded release stopped where only the person can move it on.
  | "released"
  | "release_stopped";

/** One feed row. `id` is stable across recomputes (keyed off run ids /
 *  commit SHAs / PR numbers) — it's the seen-store key. Rows with
 *  `seenEligible === false` (running/scheduled) are status, not
 *  notifications: never badged, never markable. */
export interface InboxEvent {
  id: string;
  kind: InboxEventKind;
  group: InboxGroup;
  workspaceId: string;
  workspaceName: string;
  cardId: string | null;
  runId: string | null;
  title: string;
  detail: string | null;
  url: string | null;
  /** unix-ms event time; null for live PR rows. */
  at: number | null;
  seenAt: number | null;
  seenEligible: boolean;
}

/** Per-workspace 4-week cost rollup for the Inbox footer (decision card #3). */
export interface WorkspaceCostRollup {
  workspaceId: string;
  workspaceName: string;
  totalUsd: number;
  /** Four 7-day buckets, oldest → newest. */
  weeklyUsd: number[];
}

export interface InboxProofCount {
  total: number;
  eligibleUnseen: number;
}

export interface InboxEligibilityProof {
  generatedAt: number;
  licensed: boolean;
  resolvedUserSha256: string;
  totalRows: number;
  eligibleUnseenRows: number;
  byKind: Record<InboxEventKind, InboxProofCount>;
  byGroup: Record<InboxGroup, InboxProofCount>;
  eligibleUnseenSetSha256: string;
  targetPresent: boolean | null;
  admittedPrTargets: number;
  successfulPrSources: number;
  failedPrSources: number;
  prSourcesComplete: boolean;
}

export interface InboxFeed {
  generatedAt: number;
  windowDays: number;
  events: InboxEvent[];
  costRollup: WorkspaceCostRollup[];
  eligibilityProof: InboxEligibilityProof;
  /** UX P1 point 2 (P-A): seen markers of the frontend's own card rows
   *  (`card:<rule>:<card>:<round>`, `lib/inboxReconcile.ts`). Absent from an
   *  older backend. */
  cardSeen?: Record<string, number>;
}

export function inboxFeed() {
  return invoke<InboxFeed>("inbox_feed");
}

// ── Activity (v1.80.0 — UX revamp Part 2, P2-2) ─────────────────────────
// Telemetry's single disclosure home (docs/ux-revamp/PART2.md Q4). Pure
// backend view; absorbs the retired SwarmTab run history.

export interface ActivityStats {
  /** The agent runs' median duration in the window (the workspace asked for). */
  medianRunSecs: number | null;
}

export interface ActivityRow {
  id: string;
  kind: "run" | "swarm" | "build" | "ship" | "verify" | "discussion" | "cleanup";
  state: string;
  title: string;
  detail: string;
  workspaceId: string;
  workspaceName: string;
  cardId: string | null;
  runId: string | null;
  at: number;
  /** QoL 11.1: the events this row stands for — a card is one row per kind
   *  (its ships, its checks, its Builder rounds). Absent on older feeds. */
  count?: number;
  /** 1.168.1 (A4): its card was deleted — the row stays, marked, and opens
   *  nothing (`cardId` is null). Absent on older feeds. */
  cardDeleted?: boolean;
}

export interface ActivityFeed {
  generatedAt: number;
  windowDays: number;
  stats: ActivityStats;
  rows: ActivityRow[];
  truncated: boolean;
  /** QoL 11.1: each tab's rows before the 200-row cap ("runs", "ships",
   *  "checks", "discussions", "cleanup"). Absent on an older backend. */
  tabTotals?: Record<string, number>;
}

/** QoL 11.1: `workspaceId` is History's workspace filter, applied before
 *  the cap; null for every workspace. */
export function activityFeed(workspaceId: string | null = null) {
  return invoke<ActivityFeed>("activity_feed", { workspaceId });
}

/** seen ≠ resolved: marking dims the row; it leaves the feed only when the
 *  underlying state changes (ship / archive / re-run). */
export function inboxMarkSeen(eventIds: string[]) {
  return invoke<number>("inbox_mark_seen", { eventIds });
}

// 1.173.0 (F1): Mark all seen is gone from the app; `inbox_mark_all_seen`
// stays a backend command for its proof tests (inbox_eligibility_ipc_tests).

/** v1.33.0: fires when a workspace's kanban board changed on the backend
 *  (any card mutation, run-history append, swarm completion, queue pump).
 *  Payload is the workspace id. */
export function onKanbanChanged(handler: (workspaceId: string) => void) {
  return listen<string>("kanban://changed", (e) => handler(e.payload));
}

/** Fires when a new card worktree did not start from a plain fetched
 *  origin head: offline fallback to local, or origin chosen over a
 *  diverged local branch. The FE toasts it. */
export function onWorktreeBaseNotice(
  handler: (notice: WorktreeBaseNotice) => void,
) {
  return listen<WorktreeBaseNotice>("worktree://base-notice", (e) =>
    handler(e.payload),
  );
}

export function kanbanClearRunHistory(workspaceId: string, cardId: string) {
  return invoke<void>("kanban_clear_run_history", { workspaceId, cardId });
}

// ── Card lifecycle hooks (v1.10.x Cycle A — worktrees) ──

/** v1.10.x Cycle A: Todo → InProgress transition. Backend creates a
 *  per-card git worktree and stamps the card's `worktreePath` +
 *  `branchName`. Returns the updated card so the FE can merge into
 *  local state without a refetch. Idempotent. */
export function kanbanCardAdvanceToInProgress(
  workspaceId: string,
  cardId: string,
  targetBranch?: string,
) {
  return invoke<KanbanCard>("kanban_card_advance_to_in_progress", {
    workspaceId,
    cardId,
    targetBranch: targetBranch ?? null,
  });
}

/** v1.10.x Cycle A: archive a Complete-column card. Backend prunes the
 *  card's worktree (best-effort) and flips `archived: true`, clearing
 *  `worktreePath` + `branchName`. Returns the updated card. */
/** UX-5.3: the Board's reorder. Writes only `boardOrder` (null clears it);
 *  never the column or any lifecycle field. */
export function kanbanCardSetBoardOrder(
  workspaceId: string,
  cardId: string,
  boardOrder: number | null,
) {
  return invoke<KanbanCard>("kanban_card_set_board_order", {
    workspaceId,
    cardId,
    boardOrder,
  });
}

/** UX-7.1: set the cards `cardId` waits for (the whole list; empty clears
 *  it). The backend refuses the card itself, a stranger and a cycle, with
 *  nothing written. */
export function kanbanCardSetBlockedBy(workspaceId: string, cardId: string, blockedBy: string[]) {
  return invoke<KanbanCard>("kanban_card_set_blocked_by", {
    workspaceId,
    cardId,
    blockedBy,
  });
}

/** Save (or clear with null, back to the Settings default) the Builder
 *  vendor chosen on the card before a build. Writes only
 *  `builderVendorPref`; refuses an unknown workspace or card. */
export function kanbanCardSetBuilderVendorPref(
  workspaceId: string,
  cardId: string,
  vendor: "claude" | "codex" | null,
) {
  return invoke<KanbanCard>("kanban_card_set_builder_vendor_pref", {
    workspaceId,
    cardId,
    vendor,
  });
}

/** 1.171.0 (D1): save (or clear with null, back to the Settings default)
 *  how the card's Builder asks before it changes things. Writes only
 *  `builderPermissions`; refuses an unknown workspace or card. */
export function kanbanCardSetBuilderPermissions(
  workspaceId: string,
  cardId: string,
  permissions: "editsCopy" | "asks" | "neverAsks" | null,
) {
  return invoke<KanbanCard>("kanban_card_set_builder_permissions", {
    workspaceId,
    cardId,
    permissions,
  });
}

/** 1.168.1 (E2): save (or clear with null, back to the workspace's) the
 *  card's own models. Writes only `models` (and drops a Build with both
 *  choice the new Builder choice replaces); refuses an unknown workspace or
 *  card. */
export function kanbanCardSetModels(workspaceId: string, cardId: string, models: WorkspaceModels | null) {
  return invoke<KanbanCard>("kanban_card_set_models", { workspaceId, cardId, models });
}

/** SL-5: add a line comment to the card; resolves with the card. */
export function cardLineCommentAdd(workspaceId: string, cardId: string, draft: LineCommentDraft) {
  return invoke<KanbanCard>("card_line_comment_add", { workspaceId, cardId, draft });
}

/** SL-5: change an unsent line comment's text (a sent one is refused). */
export function cardLineCommentUpdate(
  workspaceId: string,
  cardId: string,
  commentId: string,
  body: string,
) {
  return invoke<KanbanCard>("card_line_comment_update", { workspaceId, cardId, commentId, body });
}

/** SL-5: remove an unsent line comment (a sent one is history, refused). */
export function cardLineCommentRemove(workspaceId: string, cardId: string, commentId: string) {
  return invoke<KanbanCard>("card_line_comment_remove", { workspaceId, cardId, commentId });
}

/** SL-5: mark the comments whose message reached the Builder session sent. */
export function cardLineCommentsMarkSent(workspaceId: string, cardId: string, commentIds: string[]) {
  return invoke<KanbanCard>("card_line_comments_mark_sent", { workspaceId, cardId, commentIds });
}

export function kanbanCardArchive(
  workspaceId: string,
  cardId: string,
  auto = false,
) {
  return invoke<KanbanCard>("kanban_card_archive", {
    workspaceId,
    cardId,
    // UX-5.8: the auto-archive; the backend re-checks the card qualifies.
    ...(auto ? { auto: true } : {}),
  });
}

/** N14 F8: the card ⋯'s Put back in To do — its sessions stop, it is To do,
 *  its branch and worktree stay for the next Start build. Refuses an open
 *  pull request, and work it can't stop, in words. */
export function kanbanCardPutBack(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("kanban_card_put_back", { workspaceId, cardId });
}

/** UX-5.8: bring a card back from the archive — one the auto-archive took,
 *  or one that shipped. */
export function kanbanCardRestore(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("kanban_card_restore", { workspaceId, cardId });
}

/** v1.39.0 (Recon-fork cycle, Increment 2): partial-success return
 *  shape for `kanbanCardForkToImplementation`. The card is always
 *  persisted; `intakeStarted: false` + a non-null `intakeError` means
 *  the card exists in Todo but intake failed to start.
 *
 *  v1.39.2: `intakePtyId` propagates the live intake PTY id so the FE
 *  can write it into `useIntake.ptyByCard[cardId]`; without it, the
 *  `IntakeConversation` component wouldn't mount and the user would
 *  see a "no PTY attached" warning even though intake is running. */
export interface CardForkResult {
  card: KanbanCard;
  intakeStarted: boolean;
  intakeError?: string | null;
  intakePtyId?: string | null;
}

/** v1.39.0: one-click create an implementation card from a completed
 *  recon audit. New card lands in Todo with the audit's `summary_md`
 *  (or synthesized fallback) preloaded as `knowledge`. Worktree is NOT
 *  pre-created — it's branched from main on Todo→InProgress. */
export function kanbanCardForkToImplementation(
  workspaceId: string,
  parentCardId: string,
  cardId: string,
  options: {
    suggestedSwarmTemplateId?: string | null;
    runIntake: boolean;
    workspaceCwd: string;
  },
) {
  return invoke<CardForkResult>("kanban_card_fork_to_implementation", {
    workspaceId,
    parentCardId,
    cardId,
    suggestedSwarmTemplateId: options.suggestedSwarmTemplateId ?? null,
    runIntake: options.runIntake,
    workspaceCwd: options.workspaceCwd,
  });
}

/** v1.10.x Cycle A: reveal a card's worktree directory in Finder.
 *  Backend rejects any path that's not under one of the workspace's
 *  worktree roots (`.plyloft-worktrees/`, or the legacy
 *  `.atelier-worktrees/` where older cards keep theirs). */
export function worktreeReveal(workspaceId: string, path: string) {
  return invoke<void>("worktree_reveal", { workspaceId, path });
}

/** UX-8.5: `Reveal in Finder` for a file Code cannot open. The backend
 *  reveals only a file inside the workspace's own directory. */
export function fsRevealInWorkspace(workspaceId: string, path: string) {
  return invoke<void>("fs_reveal_in_workspace", { workspaceId, path });
}

/** v1.11.0 (Cycle B): one entry returned by the worktrees panel listing. */
export interface WorktreeInfo {
  /** Subdir name under its worktree root (`.plyloft-worktrees/`, or the
   *  legacy `.atelier-worktrees/`). Conventionally a card id. */
  dirName: string;
  /** Branch name as captured from `git rev-parse HEAD` inside the
   *  worktree; null if the worktree is broken. */
  branchName: string | null;
  /** Absolute path. */
  worktreePath: string;
  /** True if the directory still exists on disk. */
  exists: boolean;
}

/** v1.11.0 (Cycle B): list all live worktrees for a workspace. */
export function worktreeList(workspaceId: string) {
  return invoke<WorktreeInfo[]>("worktree_list", { workspaceId });
}

/** v1.11.0 (Cycle B): manual prune from the panel. Renames to
 *  `<root>/.trash/<dir>-<unix_ms>/` in the worktree's own root; the launch-time GC
 *  reaps trash older than 7 days. N16: keyed by the worktree's full path
 *  (`WorktreeInfo.worktreePath`), so a same-named folder under the other
 *  worktree root is never the one deleted. Resolves to the title of the card whose
 *  worktree handle was cleared (in any column, not archived), or null. */
export function worktreeDelete(workspaceId: string, path: string) {
  return invoke<string | null>("worktree_delete", { workspaceId, path });
}

// ── 1.173.0 A2: copies without a card (`copies.rs`) ──────────────────

/** Fires with the workspace id when a copy is made, set up, thrown away,
 *  restored or swept. */
export const COPIES_CHANGED_EVENT = "copies://changed";

export function onCopiesChanged(handler: (workspaceId: string) => void) {
  return listen<string>(COPIES_CHANGED_EVENT, (e) => handler(e.payload));
}

/** Make a copy of the project that belongs to no card, from `targetBranch`
 *  (an area's, from B1) or the workspace's target, fetched from GitHub
 *  first. Resolves once the folder exists; `setup.state` is `running` until
 *  `copies://changed` says the setup ended. Not counted as a card. */
export async function copyCreate(
  workspaceId: string,
  name: string,
  open: "claude" | "codex" | "shell" | null,
  targetBranch: string | null = null,
) {
  const row = await invoke<CopyView>("copy_create", { workspaceId, name, open, targetBranch });
  return normalizeCopyView(row);
}

/** The workspace's copies: active ones, then thrown-away ones that can
 *  still come back, newest first. */
export async function copyList(workspaceId: string) {
  const rows = await invoke<CopyView[]>("copy_list", { workspaceId });
  return rows.map(normalizeCopyView);
}

/** *Throw away*: the copy goes to the worktree Trash for 7 days. Refused
 *  while a terminal is open in it or its setup runs. */
export async function copyThrowAway(workspaceId: string, copyId: string) {
  return normalizeCopyEntry(await invoke<CopyEntry>("copy_throw_away", { workspaceId, copyId }));
}

/** The Undo of `copyThrowAway`: the copy comes back whole. */
export async function copyRestore(workspaceId: string, copyId: string) {
  return normalizeCopyEntry(await invoke<CopyEntry>("copy_restore", { workspaceId, copyId }));
}

/** Retry a copy's setup. `allow` is "Allow and run": the command the row
 *  showed, approved on this computer first (only while it is still the
 *  repository's). Resolves with `setup.state` running (or the record
 *  cleared); `copies://changed` says when it ends. */
export async function copySetupRetry(workspaceId: string, copyId: string, allow: string | null = null) {
  return normalizeCopyEntry(await invoke<CopyEntry>("copy_setup_retry", { workspaceId, copyId, allow }));
}

/** Where a new copy would start ("main on GitHub · read 2 min ago"), read
 *  without fetching. `target`: an area's branch (B1), else the workspace's. */
/** `skipChanged`: leave the project folder's changed files unread (the
 *  "Same folder" popover doesn't say them). */
export function copyStartPoint(workspaceId: string, target: string | null = null, skipChanged = false) {
  return invoke<Partial<CopyStartPoint> | null>("copy_start_point", {
    workspaceId,
    target,
    ...(skipChanged ? { skipChanged: true } : {}),
  }).then(normalizeCopyStartPoint);
}

/** 1.173.0 A3: what *Make it a card* made (`commands::CopyMadeCard`). */
export interface CopyMadeCard {
  card: KanbanCard;
  /** In Working on the copy; `false` on a GitHub Issues board (claim it
   *  first) or when the start was refused (`note`). */
  started: boolean;
  note?: string | null;
}

/** 1.173.0 A3: *Make it a card* — a new card (title = the copy's name)
 *  whose copy is this one; the copy leaves the list. */
export function copyMakeCard(workspaceId: string, copyId: string, title: string | null = null) {
  return invoke<CopyMadeCard>("copy_make_card", { workspaceId, copyId, title });
}

/** 1.173.0 A3: *Open a pull request* — the copy's changes committed, its
 *  branch sent to GitHub (never forced) and Ship's pull request opened for
 *  the branch it started from. Resolves with the entry and its `pr`. */
export async function copyOpenPr(workspaceId: string, copyId: string, title: string) {
  return normalizeCopyEntry(await invoke<CopyEntry>("copy_open_pr", { workspaceId, copyId, title }));
}

/** 1.173.0 A3 (Challenger 7): read the copies' open pull requests now
 *  (`gh pr view`); `copies://changed` follows when one changed. */
export function copyRefreshPrs(workspaceId: string) {
  return invoke<void>("copy_refresh_prs", { workspaceId });
}

/** 1.173.0 A3 (walk fix a): a card made from a copy — what its copy holds
 *  that its base doesn't; null for any other card. */
export function cardCopyChanges(workspaceId: string, cardId: string) {
  return invoke<ChangedFiles | null>("card_copy_changes", { workspaceId, cardId });
}

// ── Review surface (v1.31.0 Cycle 1) ──────────────────

/** v1.31.0 (Cycle 1 — Review surface): post-swarm review lifecycle of a
 *  card. `pending` = awaiting review; `changes_requested` = a follow-up
 *  swarm is in flight; `conflict_blocked` = a merge hit a git conflict;
 *  `merged` = landed locally. */
export type ReviewStatus =
  | "pending"
  | "changes_requested"
  | "conflict_blocked"
  | "merged";

export type ReviewDecisionStatus = "accepted" | "rejected";

/** A persisted per-hunk review verdict. */
export interface ReviewDecision {
  path: string;
  hunkHeader: string;
  status: ReviewDecisionStatus;
  feedback?: string | null;
}

export type DiffChangeKind = "added" | "modified" | "removed" | "renamed";

/** One `@@ … @@` hunk of a file diff. `body` is the raw +/-/context text. */
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string;
}

/** One file's worth of unified diff. */
export interface FileDiff {
  path: string;
  oldPath?: string | null;
  kind: DiffChangeKind;
  hunks: DiffHunk[];
}

/** Payload of `cardReviewDiff`: the git diff a card's worktree branch
 *  introduced. Empty `files` = the swarm changed nothing. */
export interface ReviewDiff {
  cardId: string;
  baseBranch: string;
  cardBranch: string;
  files: FileDiff[];
  generatedAt: number;
  /** CL-6: the card's Challenger findings that name a line, placed on the
   *  branch as it is now. Absent before CL-6. */
  anchors?: FindingAnchor[];
}

/** CL-6: what happened to a finding's line between its review and now. */
export type AnchorFate = "same" | "moved" | "changed" | "removed" | "file-removed" | "unknown";

/** CL-6: one Challenger finding placed on the review diff
 *  (`review_anchors.rs`). */
export interface FindingAnchor {
  id: string;
  severity: string | null;
  state: FindingState;
  /** Never asks for changes (P3, pre-existing, a note, below the
   *  workspace's threshold, or dismissed). */
  nonBlocking: boolean;
  /** Findings filter: the member dismissed it as not a real issue. */
  dismissed?: boolean;
  /** Who dismissed it and why; absent unless dismissed (and before the
   *  Tier 4 walk of 2026-10-14). */
  dismissal?: FindingDismissal | null;
  /** In code this change did not write. Absent before CL-6 round 2. */
  preExisting?: boolean;
  title: string;
  /** The finding's complete text. */
  body: string;
  reason: string | null;
  round: number;
  updatedRound: number;
  /** The file now (a rename's new path). */
  path: string;
  /** The line the review named, in the revision it read. */
  reviewedLine: number;
  /** Where to show it now: the line itself (same, moved) or the closest
   *  line (changed, removed); null when there is none or it isn't known. */
  line: number | null;
  fate: AnchorFate;
}

/** One reviewer rejection — element of `cardReviewRequestChanges`. */
export interface ReviewRejection {
  path: string;
  hunkHeader: string;
  feedback: string;
  hunkBody: string;
}

/** Result of `cardReviewMerge`. On a git conflict `merged` is false and
 *  `conflictingPaths` lists the unmerged files. */
export interface ReviewMergeResult {
  merged: boolean;
  conflictingPaths: string[];
  /** GH #183: the land's or release's fast-forward left the target branch at
   *  origin's tip (Rust `LocalBranchSync::fast_forwarded`: FastForwarded or
   *  UpToDate — never Offline, NoRemote or Ahead). The one proof GH #88's
   *  refusal is gone; absent reads as false. */
  fastForwarded?: boolean;
  /** PR #375 review: a Builder card's Merge — the human's decision on the
   *  review (accepted pushback, dismissed findings), as Ship's receipt
   *  says it. Absent when there is none. */
  reviewOverride?: string | null;
}

/** QoL 1.168 (C8): what a shipped card's commit changed, read in its
 *  project folder (`shipped_changes.rs`). */
export interface ShippedFile {
  path: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}
export interface ShippedChanges {
  commit: string;
  subject: string;
  files: ShippedFile[];
  totalFiles: number;
  /** The other cards the commit shipped (a batch release); `files` is then
   *  empty — the release's files are not this card's. */
  sharedWith: number;
}
export function cardShippedChanges(workspaceId: string, cardId: string) {
  return invoke<ShippedChanges>("card_shipped_changes", { workspaceId, cardId });
}

/** v1.31.0: the interactive review diff for a card's worktree branch.
 *  Commits pending swarm edits first; an empty `files` is a valid state. */
export function cardReviewDiff(workspaceId: string, cardId: string) {
  return invoke<ReviewDiff>("card_review_diff", { workspaceId, cardId });
}

/** v1.31.0: reject-with-feedback — dispatch a follow-up swarm into the
 *  card's worktree. Returns the new swarm id. */
export function cardReviewRequestChanges(
  workspaceId: string,
  cardId: string,
  rejections: ReviewRejection[],
) {
  return invoke<string>("card_review_request_changes", {
    workspaceId,
    cardId,
    rejections,
  });
}

/** G4 (launch D8): the changes a person asked for, in the words a
 *  follow-up swarm got — sent to a Builder card's session instead. */
export function cardReviewFollowupMessage(rejections: ReviewRejection[]) {
  return invoke<string>("card_review_followup_message", { rejections });
}

/** v1.31.0: land an accepted card — squash-merge its worktree branch into
 *  the workspace's target branch. */
export function cardReviewMerge(workspaceId: string, cardId: string, unreviewedOk = false) {
  // PR #375 review: `unreviewedOk` is the member's "Merge anyway" — a
  // Builder snapshot the Challenger has not approved is refused without it.
  return invoke<ReviewMergeResult>("card_review_merge", {
    workspaceId,
    cardId,
    unreviewedOk,
  });
}

/** v1.31.0 (Outcome screen): backend half of the outcome screen — the
 *  reviewer leg's verdict + critique and the changed-file count. The FE
 *  composes the rest (goal, swarm status, verify status) from its stores.
 *
 *  v1.38.0 (Recon-aware Outcome): adds `isRecon` + `reconSummaryMd` +
 *  `reconVerdictNegative` so the FE can branch on text-deliverable swarms
 *  (ux-audit, design) and render the agent's markdown report as primary
 *  content instead of the diff/ship/verify surface. */
export interface CardOutcome {
  reviewerVerdict?: string | null;
  reviewerCritique?: string | null;
  /** v1.108.0: "swarm" (role-chain reviewer, writer-capable) or
   *  "challenger" (independent read-only review by the other vendor). */
  reviewerSource?: "swarm" | "challenger" | null;
  reviewerProvider?: "claude" | "codex" | null;
  reviewerDegraded?: boolean;
  filesChanged: number;
  /** Whether the workspace has a verify pipeline configured — tells "no
   *  checks set up" apart from "checks not run yet". */
  verifyConfigured: boolean;
  /** v1.38.0: true when the card's swarm template has `output_kind: Recon`
   *  (ux-audit or design). Drives the recon-variant Outcome render. */
  isRecon: boolean;
  /** v1.38.0: the agent-authored markdown report from the latest recon
   *  run's artifact `summary_md`. For pre-v1.38 recon runs the backend
   *  synthesizes a fallback from the structured artifact fields. */
  reconSummaryMd?: string | null;
  /** v1.38.0: true when the latest recon run's verdict is reject-like.
   *  Used in v1.39.0 by the fork affordance to render a warning band
   *  above the fork buttons. Populated here so the field is stable. */
  reconVerdictNegative: boolean;
  /** Why Ship would refuse right now: a Builder worktree that moved past
   *  its last build snapshot. Null when Ship can proceed. */
  shipBlockedReason?: string | null;
  /** HEAD of a card with no Builder when it is a Ship recovery commit —
   *  published only after Verify passes on exactly that commit. */
  recoverySha?: string | null;
  /** GH #191: `origin/<target>` when the card changed nothing because its
   *  commits are already there. Only set when `filesChanged` is 0. */
  alreadyIn?: string | null;
  /** CL-11: whether the card's worktree has a remote — Ship as a PR needs
   *  one (R10: an `origin` on GitHub). Null or absent when unknown (no
   *  worktree, an older backend). */
  hasRemote?: boolean | null;
  /** R10: the host of an `origin` that isn't on GitHub ("this computer" for
   *  a local path); `hasRemote` is false then. Null otherwise. */
  originHost?: string | null;
  /** R10 (Challenger): an `origin` on GitHub whose address isn't a
   *  repository's, without credentials; `hasRemote` is false then. */
  originUnreadable?: string | null;
}

/** GH #99: a Builder card's branch tip and the commits on it since the
 *  last completed Challenger review, read live from its worktree. */
export interface ReviewTipFacts {
  branchTip?: string | null;
  commitsSinceReview?: number | null;
}

export function cardReviewTip(workspaceId: string, cardId: string) {
  return invoke<ReviewTipFacts>("card_review_tip", { workspaceId, cardId });
}

export function cardOutcome(workspaceId: string, cardId: string) {
  return invoke<CardOutcome>("card_outcome", { workspaceId, cardId });
}

/** Read-only advisory preflight. A clean observed checkout returns a
 * zero-count object; `null` means Git status was unavailable. Ship performs
 * the strict check again at mutation time. */
export function cardShipPreflight(workspaceId: string, cardId: string) {
  return invoke<TargetDirtyState | null>("card_ship_preflight", {
    workspaceId,
    cardId,
  });
}

/** F1 (1.172.1): the changes sheet — each changed file of the project folder
 *  with its lines (`project_folder_changes_detail`). `null`: Git couldn't
 *  read them. */
export function projectFolderChangesDetail(workspaceId: string) {
  return invoke<FolderChanges | null>("project_folder_changes_detail", { workspaceId });
}

/** F1 (1.172.1): *Bring it up to date* — forward-only, the folder's own
 *  branch, never a switch or a push (`project_folder_bring_up_to_date`). */
export function projectFolderBringUpToDate(workspaceId: string) {
  return invoke<FolderUpdate>("project_folder_bring_up_to_date", { workspaceId });
}

/** v1.31.0 (Outcome screen): result of `cardShip`.
 *  - `merged_live` — merged into the build branch + the go-live step ran.
 *  - `local_merge` — merged, but no go-live step configured (or a conflict
 *    when `merged` is false).
 *  - `pr` — a GitHub pull request was opened.
 *  - `verify_pending` — nothing published: Ship found uncommitted edits on a
 *    card with no Builder, committed them as `recoverySha` and started
 *    Verify on that commit. Ship again once it passes.
 *  `fellBack` is true when a PR was wanted but the workspace had no remote.
 *  `shippedSnapshot` is a Builder card's last build snapshot — exactly what
 *  was published. */
export interface ShipOutcome {
  kind:
    | "pr"
    | "local_merge"
    | "merged_live"
    | "verify_pending"
    /** Skills hub H3a: a skill card whose change the target already has. */
    | "skill_up_to_date"
    /** Skills hub H3a: the origin changed the skill again — refresh it. */
    | "skill_refresh"
    /** 1.169.1 (R2): Ship as a PR stopped before any push — the pull request
     *  would also carry `localCommits`, which aren't on GitHub yet. */
    | "carries_local_commits";
  /** Skills hub H3a: only skill files changed — Verify was not needed and
   *  no install script ran. */
  skillOnly?: boolean;
  /** Skills hub H3a: what the skill card's preflight said. */
  skillNote?: string | null;
  prUrl?: string | null;
  merged: boolean;
  conflictingPaths: string[];
  fellBack: boolean;
  /** GH #183: the land's or release's fast-forward left the target branch at
   *  origin's tip (Rust `LocalBranchSync::fast_forwarded`: FastForwarded or
   *  UpToDate — never Offline, NoRemote or Ahead). The one proof GH #88's
   *  refusal is gone; absent reads as false. */
  fastForwarded?: boolean;
  recoverySha?: string | null;
  shippedSnapshot?: BuildSnapshot | null;
  /** The shipped snapshot's last Challenger review was overridden: who,
   *  when, snapshot N. Also written into the PR body. */
  reviewOverride?: string | null;
  /** GH #99: the shipped commit was not reviewed by the Challenger, with
   *  the reason; GH #129: and the open findings of a request for changes
   *  nobody re-checked — one line each. Also written into the PR body. */
  unreviewed?: string | null;
  /** ADR 0006: shipped with follow-up — the card with the open findings. */
  followUp?: FollowUpCard | null;
  /** R2: kind `carries_local_commits` — what the pull request would carry. */
  localCommits?: LocalCommits | null;
  /** 1.169.1 (R13): the branch the card shipped to, its real name (the
   *  toast names it). Absent from an older backend. */
  target?: string | null;
  /** R13 (Challenger): the project's origin is a GitHub repository — the
   *  same reading as `projectLocalOrigin`'s `githubRepo`, which Ship
   *  history's receipt uses. Absent reads as false. */
  onGitHub?: boolean;
  /** 1.171.0 A3 (DL-30): kind `merged_live` — the go-live step is Plyloft's
   *  own install, which quits and relaunches Plyloft. Absent reads as false. */
  relaunches?: boolean;
}

/** 1.169.1 (R2): commits a card's start holds that GitHub's target doesn't
 *  — not the card's own (`commands::pr_carries_local_commits`). */
export interface LocalCommits {
  /** The target branch's real name. */
  target: string;
  count: number;
  /** Their subjects, newest first; at most 20 (`count` says the rest). */
  subjects: string[];
}

/** R2: *Include them and ship as a PR* — the commits `carries_local_commits` listed go
 *  into the pull request too. Sent only when chosen. */
export interface ShipOptions {
  carryLocalCommits?: boolean;
  /** G4 Challenger 1: the Builder's draft this press asked for. */
  prDraftRequest?: string;
}

function shipArgs(workspaceId: string, cardId: string, mode: string, opts?: ShipOptions) {
  return {
    workspaceId,
    cardId,
    mode,
    ...(opts?.carryLocalCommits ? { carryLocalCommits: true } : {}),
    ...(opts?.prDraftRequest ? { prDraftRequest: opts.prDraftRequest } : {}),
  };
}

/** R2: the commits the card's start holds that GitHub's target doesn't, read
 *  now (no fetch) — its "Started from … on this computer" line. */
export function cardLocalBaseCommits(workspaceId: string, cardId: string) {
  return invoke<LocalCommits | null>("card_local_base_commits", { workspaceId, cardId });
}

/** ADR 0006: ship a card whose Challenger still requests changes, from
 *  its fourth refusal and with no P1 open: its open findings become one new
 *  card, and the PR body says so. The backend checks the offer again. */
export function cardShipWithFollowUp(
  workspaceId: string,
  cardId: string,
  mode: ShipMode,
  opts?: ShipOptions,
) {
  return invoke<ShipOutcome>("card_ship_with_follow_up", shipArgs(workspaceId, cardId, mode, opts));
}

/** v1.31.0: ship a card. `mode: "merge_live"` lands it into the build
 *  branch and runs the project's go-live step; `mode: "pr"` opens a
 *  GitHub PR for team review. G1: `ship_it` is the card's Ship it (a pull
 *  request that merges when its checks pass where the workspace and the
 *  project say so, a land otherwise); `pr_only` a pull request without
 *  auto-merge (`lib/shipVia.ts`). */
/** SL-1: read the card's pull request from GitHub now (the card page's
 *  open and Refresh). Returns the card as written. */
export function cardPrRefresh(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("card_pr_refresh", { workspaceId, cardId });
}

/** 1.172.0 B2: read again now the cards whose last read asked for the
 *  GitHub sign-in (after a sign-in, and when Settings closes). Resolves with
 *  how many reads started; they run in the background. */
export function prReadSignedOutAgain() {
  return invoke<number>("pr_read_signed_out_again");
}

/** 1.172.0 B2: the quit note's count — pull requests (cards' and releases')
 *  waiting for Plyloft's own merge, in every workspace. */
export function quitPlyloftMerges() {
  return invoke<number>("quit_plyloft_merges");
}

/** SL-3: what the card's Merge (or its auto-merge switch) did. */
export interface PrMergeResult {
  card: KanbanCard;
  /** GitHub merged it (now or before). */
  merged: boolean;
  /** Plyloft's line when nothing was merged, turned on or turned off. */
  refused?: string | null;
  /** GitHub's own answer, as it is. */
  github?: string | null;
}

/** SL-3: merge the card's open pull request (`gh pr merge --squash`).
 *  G1–G3 Challenger (2): `githubHead` — Merge what's on GitHub now, with the
 *  head the card showed, when GitHub's isn't the one Plyloft pushed. */
export function cardPrMerge(workspaceId: string, cardId: string, githubHead?: string | null) {
  return invoke<PrMergeResult>("card_pr_merge", githubHead ? { workspaceId, cardId, githubHead } : { workspaceId, cardId });
}

/** G5: what Bring this computer up to date got (`after_merge.rs`). */
export interface UpToDateResult {
  card: KanbanCard;
  /** Why it still couldn't; null when this computer is up to date. */
  refused: string | null;
}

/** G5: Bring this computer up to date on a merged card — the project
 *  folder's target branch fast-forwarded to GitHub's when it can be. */
export function cardBringUpToDate(workspaceId: string, cardId: string) {
  return invoke<UpToDateResult>("card_bring_up_to_date", { workspaceId, cardId });
}

/** SL-3: turn "Merge when checks pass" on or off for the card's open PR. */
export function cardPrSetAutoMerge(workspaceId: string, cardId: string, on: boolean) {
  return invoke<PrMergeResult>("card_pr_set_auto_merge", { workspaceId, cardId, on });
}

/** SL-2: what an open pull request needs fixed, in the message's order. */
export type PrFixKind = "conflict" | "checks" | "review";

/** SL-2: the message for the card's Builder about its pull request. */
export interface PrFixMessage {
  prNumber: number;
  kinds: PrFixKind[];
  /** Pasted into the Builder session as it is. */
  message: string;
  /** What was cut or couldn't be read, in words. */
  notes: string[];
}

/** SL-2: gather what the card's open PR needs fixed (failed logs, the
 *  review and its inline comments, the conflict's base). Sends nothing. */
export function cardPrFixMessage(workspaceId: string, cardId: string, checksOnly = false) {
  // G7: Fix failing checks by itself asks for the failed checks alone.
  return invoke<PrFixMessage>(
    "card_pr_fix_message",
    checksOnly ? { workspaceId, cardId, checksOnly: true } : { workspaceId, cardId },
  );
}

/** 1.174.0 A2 (P7): ⋯ › Fix with the Builder on an open pull request — the
 *  card's brief as it reads now, for its Builder. Sends nothing. */
export function cardPrBriefFixMessage(workspaceId: string, cardId: string) {
  return invoke<PrFixMessage>("card_pr_fix_message", { workspaceId, cardId, brief: true });
}

/** UX P1 point 7 (P-E): what "Ask the Builder to resolve it" sends. */
export interface ShipConflictMessage {
  /** Pasted into the Builder session as it is. */
  message: string;
  /** The files with conflict marks now. */
  paths: string[];
  branch: string;
  /** The merge was already under way: the message is sent again. */
  alreadyStarted: boolean;
}

/** UX P1 point 7 (P-E): Plyloft starts merging the commit the failed ship
 *  met into the card's copy, and returns the message for the Builder. */
export function cardShipConflictStart(workspaceId: string, cardId: string) {
  return invoke<ShipConflictMessage>("card_ship_conflict_start", { workspaceId, cardId });
}

/** UX P1 point 7 (P-E): Undo the merge — the merge is aborted in the card's
 *  copy; the card reads Ship stopped on a conflict again. */
export function cardShipConflictUndo(workspaceId: string, cardId: string) {
  return invoke<void>("card_ship_conflict_undo", { workspaceId, cardId });
}

/** 1.170.0 (G6): one card's distance from GitHub's target branch. */
export interface CardTargetSync {
  /** Commits of GitHub's target the card's branch doesn't have. */
  behind: number;
  /** Bringing them in would conflict (a dry merge). */
  conflict: boolean;
  /** A merge is pending in the card's copy: Finish and check commits it. */
  merging: boolean;
  /** 1.173.0 (B3): the card's own target (its area's branch) when it isn't
   *  the report's; absent: `TargetSyncReport.target`. */
  target?: string;
}

/** 1.170.0 (G6): the workspace's target and each tracked card's reading. */
export interface TargetSyncReport {
  target: string;
  cards: Record<string, CardTargetSync>;
}

/** 1.170.0 (G6): how far each card is behind GitHub's target branch.
 *  `opened`: a card page opened (GitHub is read again sooner). Reads only. */
export function cardsTargetSync(workspaceId: string, opened: boolean) {
  return invoke<TargetSyncReport>("cards_target_sync", { workspaceId, opened });
}

/** 1.170.0 (G6): what Bring in the target's changes did. */
export interface BringInResult {
  kind: "merged" | "up_to_date" | "conflict";
  target: string;
  /** The conflicting files, on `conflict`. */
  paths: string[];
  /** The conflict was recorded for Ask the Builder to resolve it. */
  recorded: boolean;
  card: KanbanCard;
}

/** 1.170.0 (G6): Bring in the target's changes — GitHub's target merged
 *  into the card's copy, nothing committed; never a rebase or a push. */
export function cardBringInTarget(workspaceId: string, cardId: string) {
  return invoke<BringInResult>("card_bring_in_target", { workspaceId, cardId });
}

/** SL-2: what Push update did. */
export interface PushUpdateResult {
  card: KanbanCard;
  pushed: boolean;
  /** Plyloft's line when nothing was pushed. */
  refused?: string | null;
  /** git's own words. */
  git?: string | null;
}

/** SL-2: push the card's verified snapshot to its pull request's branch. */
/** `auto` (1.174.0 B6): the push "Fix failing checks by itself" asks for —
 *  refused by Rust (in `refused`, nothing pushed) unless every G7 condition
 *  holds (`pr_auto_fix::auto_push_refusal`). Absent: the person's press. */
export function cardPrPushUpdate(workspaceId: string, cardId: string, auto = false) {
  return invoke<PushUpdateResult>("card_pr_push_update", auto ? { workspaceId, cardId, auto } : { workspaceId, cardId });
}

/** G4: GitHub's current title and body of the card's open pull request. */
export function cardPrText(workspaceId: string, cardId: string) {
  return invoke<{ title: string; body: string }>("card_pr_text", { workspaceId, cardId });
}

/** G4: Edit title and description's Save (`gh pr edit`). `loaded`: GitHub's
 *  title and body as the sheet opened with them — Save is refused when
 *  GitHub's changed since (G4 Challenger 8). */
export function cardPrEdit(
  workspaceId: string,
  cardId: string,
  title: string,
  body: string,
  loaded: { title: string; body: string },
) {
  return invoke<void>("card_pr_edit", {
    workspaceId,
    cardId,
    title,
    body,
    loadedTitle: loaded.title,
    loadedBody: loaded.body,
  });
}

export function cardShip(
  workspaceId: string,
  cardId: string,
  mode: ShipMode,
  opts?: ShipOptions,
) {
  return invoke<ShipOutcome>("card_ship", shipArgs(workspaceId, cardId, mode, opts));
}

// ── Project config (v1.12.0–v1.12.5 Cycle C) ──────────

/** v1.12.0 (Cycle C): per-workspace ship-pipeline configuration.
 *  Ply's workspace gets bootstrapped from hardcoded defaults at
 *  launch; LYRA-or-other workspaces materialize their config via
 *  the FE Project tab's Detect button. */
export type VersionFileKind =
  | "package_json"
  | "cargo_toml"
  | "tauri_conf_json"
  /** v1.13.0: PEP 621 pyproject.toml — `[project] version = "..."`. */
  | "py_project_toml"
  /** v1.13.0: Python source-code string variable. Requires
   *  `variableName` on the entry. Captures `version="..."` patterns
   *  including FastAPI keyword arguments. */
  | "python_module_var";

export interface VersionFileEntry {
  /** Path relative to the workspace cwd. */
  path: string;
  kind: VersionFileKind;
  /** v1.13.0: required when `kind === "python_module_var"`; ignored
   *  for other kinds. Names the Python variable / keyword to find
   *  (most commonly `"version"`). */
  variableName?: string | null;
}

/** v1.13.5: one step in the verify pipeline. Ply's hardcoded
 *  invocation is `Script { path: "scripts/ppvp.sh" }`; LYRA's is
 *  `SlashCommand { name: "/ppvp", args: [] }`. The Vec at
 *  `ProjectConfig.verifyPipeline` lets a project express either
 *  shape (1-element for "one step", N-element for sequential
 *  fail-fast composition). The discriminant is `kind` (snake_case)
 *  to match the Rust serde tag. */
export type VerifyKind =
  | { kind: "script"; path: string }
  | { kind: "slash_command"; name: string; args: string[] };

export interface ProjectConfig {
  schemaVersion: number;
  /** Branch the ship pipeline lands on (e.g. "main", "staging"). */
  targetBranch: string;
  /** All files that carry the version. Order is significant; the
   *  first entry is canonical for read-back. All written in
   *  lockstep on a version bump. */
  versionFiles: VersionFileEntry[];
  /** Workspace-relative path; null means "no install/build step". */
  installScript?: string | null;
  /** Try it: the command that starts the app, as typed in a terminal
   *  (`npm run dev`). Absent = none. Shared as `tryCommand`. */
  tryCommand?: string | null;
  /** v1.13.5: how the verify pipeline runs. null/undefined means
   *  "skip verify is implicit"; non-empty array runs entries
   *  sequentially fail-fast. */
  verifyPipeline?: VerifyKind[] | null;
  /** Extra build-cache dirs (relative to a card checkout) stripped before
   *  a pruned worktree goes to the trash, on top of the defaults. Only
   *  git-ignored, untracked dirs are removed. Absent = none. */
  cachePaths?: string[];
  /** Card Verify runs share one Cargo target per workspace
   *  (`.plyloft-worktrees/.cargo-target`), reset for each run; Builders
   *  keep their own. Absent = on. */
  sharedBuildCache?: boolean;
  /** ADR 0006 (third card): Build done asks the Builder for a self-check
   *  first. Absent = on. */
  selfCheck?: boolean;
  /** ADR 0006 (third card): the repository's own risk classes, after the
   *  core (J, K…). Absent = none. */
  reviewChecklist?: ReviewChecklistClass[];
  createdAt: number;
  updatedAt: number;
}

/** ADR 0006 (third card): one class a repository adds to the checklist. */
export interface ReviewChecklistClass {
  name: string;
  sentence: string;
}

/** Mirrors `project_config.rs::REVIEW_CHECKLIST_MAX_CLASSES`. */
export const REVIEW_CHECKLIST_MAX_CLASSES = 12;
/** Mirrors `project_config.rs::REVIEW_CHECKLIST_CLASS_MAX_CHARS`: a class,
 *  name and sentence together. */
export const REVIEW_CHECKLIST_CLASS_MAX_CHARS = 300;

/** v1.12.1: free-form notes from the deterministic detection scan +
 *  CLAUDE.md presence hint. */
export interface ProjectConfigProposal {
  config: ProjectConfig;
  hasClaudeMd: boolean;
  notes: string[];
}

// ── Shared workspace definition (GH #79) ──────────────

export type RefreshMoment =
  | "open"
  | "sync"
  | "startBuild"
  | "periodic"
  | "publish" | "pageRead";

/** `.atelier/workspace.json`, as the repo carries it. Unknown keys are kept
 *  by the backend. Project fields are optional as a group. */
export interface WorkspaceDefinition {
  schemaVersion: number;
  name: string;
  accentColor?: string | null;
  board: "local" | "githubIssues";
  githubOwnerRepo?: string | null;
  /** Absent = the repo's default branch. */
  integrationBranch?: string | null;
  versionFiles?: VersionFileEntry[] | null;
  installScript?: string | null;
  /** Try it: the command that starts the app (D19: shared, allowed per machine). */
  tryCommand?: string | null;
  verifyPipeline?: VerifyKind[] | null;
  cachePaths?: string[] | null;
  sharedBuildCache?: boolean | null;
  selfCheck?: boolean | null;
  reviewChecklist?: ReviewChecklistClass[] | null;
  /** SL-4: git-ignored files copied into every new card worktree. */
  worktreeCopy?: string[] | null;
  /** SL-4: the command run in every new card worktree before its Builder. */
  worktreeSetup?: string | null;
  /** 1.169.0 (A2): the models and efforts the team suggests, in the shape
   *  of the app's rows (`team_models.rs`). Absent = none. */
  models?: import("./lib/roleModels").RoleModels | null;
  /** 1.173.0 (B1): the parts of the repository that ship on their own
   *  (`areas.rs`). Absent = one implicit area with the values above. */
  areas?: AreaDef[] | null;
  /** 1.173.0 (G1): how a release goes by default without areas (each area
   *  has its own); absent = not chosen (Release… starts on this Mac only). */
  releaseKind?: string | null;
  [extra: string]: unknown;
}

/** 1.173.0 (B1): one area, as `.atelier/workspace.json` writes it
 *  (`areas::AreaDef`). Every field after `path` falls back to the
 *  workspace's; unknown keys are kept. */
export interface AreaDef {
  /** Lowercase letters, digits and dashes; stable — cards keep it. */
  id: string;
  /** Empty reads as the id. */
  name: string;
  /** From the repository root, whatever folder the workspace was opened
   *  on; "" (or "/") is the root area: the whole repository except the
   *  other areas' folders. */
  path: string;
  /** Where its cards go; absent = the workspace's integration branch. */
  targetBranch?: string | null;
  /** Absent = the workspace's version files. Paths from the workspace's
   *  folder, like the workspace's own. */
  versionFiles?: VersionFileEntry[] | null;
  /** Wins wherever the area is listed. Absent = "" for the first area
   *  (vX.Y.Z), `<id>-` for the others — Settings writes the resolved one. */
  tagPrefix?: string | null;
  /** Absent = `area:<id>`. */
  label?: string | null;
  /** "Where to look at it": the web address (http/https) Next improvement opens. */
  lookAt?: string | null;
  /** 1.173.0 (G1): how its release goes by default (Settings › Shipping);
   *  absent = not chosen. Kept as written: a later Plyloft's kind survives,
   *  and readers take only the kinds they know (`asReleaseKind`). */
  releaseKind?: string | null;
  [extra: string]: unknown;
}

/** An area with its defaults filled in (`areas::ResolvedArea`). */
export interface ResolvedArea {
  id: string;
  name: string;
  /** Normalized; "" for the root area. */
  path: string;
  root: boolean;
  /** The first area listed. */
  first: boolean;
  /** Its own branch; `null` = the workspace's. */
  targetBranch: string | null;
  /** Where its cards go, resolved. */
  branch: string;
  versionFiles: VersionFileEntry[] | null;
  tagPrefix: string;
  label: string;
  lookAt: string | null;
  /** 1.173.0 (G1): its default release kind; absent from an older backend. */
  releaseKind?: string | null;
}

/** One thing `areas::check` found; `area` is the id it is about. */
export interface AreaProblem {
  area: string | null;
  field: string;
  message: string;
}

/** Errors refuse the list; warnings are said and the list stands. */
export interface AreaCheck {
  errors: AreaProblem[];
  warnings: AreaProblem[];
}

/** What the area picker and Settings › Areas read (`areas_get`). `areas`
 *  empty is the implicit area: show nothing about areas. */
export interface AreasView {
  shared: boolean;
  readOnly: boolean;
  defined: AreaDef[];
  areas: ResolvedArea[];
  /** The workspace's integration branch. */
  workspaceBranch: string;
  check: AreaCheck;
  /** Why the repository's list can't be used (the last good one is kept). */
  problem: string | null;
  /** `problem` and no good copy on this Mac: no card may start, ship or
   *  release until a valid list is published. */
  held: boolean;
  /** 1.173.0 (G1): the workspace's default release kind — the shared
   *  definition's, or this Mac's own where it shares none. Absent from an
   *  older backend; null = not chosen. */
  releaseKind?: string | null;
  /** 1.174.0 (C10, D6): nothing is shared and the areas are this Mac's own
   *  (saved here, they decide until the setup is shared). Absent from an
   *  older backend. */
  keptHere?: boolean;
  /** 1.174.0 (C10): this Mac's list, set aside when the setup came in with
   *  other areas — what the Board's sheet asks about. */
  setAside?: ResolvedArea[] | null;
}

/** 1.173.0 (B1): the workspace's areas, from this Mac's copy. Runs off the
 *  main thread: when an area has version files it asks git, once per
 *  folder, where the workspace sits in its repository. */
/** 1.173.0 (B4 follow-up): `ship::AreaRelease` — one published area's
 *  latest real tag and the version its files are at (`null` when unknown). */
export interface AreaRelease {
  id: string;
  tagPrefix: string;
  latestTag: string | null;
  version: string | null;
}

/** Read once when Settings › Areas opens (git, on a worker). Empty without
 *  areas or while they are held. */
export function areasReleases(workspaceId: string) {
  return invoke<AreaRelease[]>("areas_releases", { workspaceId });
}

export function areasGet(workspaceId: string) {
  return invoke<AreasView>("areas_get", { workspaceId });
}

/** 1.173.0 (G1): this Mac's default release kind, for a workspace that
 *  shares no definition (refused where it shares one: that one is published). */
export function releaseKindSet(workspaceId: string, kind: ReleaseKind | null) {
  return invoke<void>("release_kind_set", { workspaceId, kind });
}

/** 1.174.0 (C10, D6): Settings › Areas' Save where nothing is shared —
 *  the list decides on this Mac until the setup is shared (refused where
 *  it is: the areas are published there). The view as it is after. */
export function areasSaveLocal(workspaceId: string, areas: AreaDef[]) {
  return invoke<AreasView>("areas_save_local", { workspaceId, areas });
}

/** 1.174.0 (C10, D6): the Board's sheet about this Mac's set-aside areas.
 *  `publishMine` false is "Use the repository's": nothing is written to the
 *  repository. True is "Publish mine": one edit of the shared areas. */
export function areasAnswerSetAside(workspaceId: string, publishMine: boolean) {
  return invoke<void>("areas_answer_set_aside", { workspaceId, publishMine });
}

/** 1.173.0 (B1): the rules over a list being edited, before it is saved.
 *  With `workspaceId`, version files are read from the workspace's folder. */
export function areasCheck(areas: AreaDef[], workspaceId?: string) {
  return invoke<AreaCheck>("areas_check", { areas, workspaceId: workspaceId ?? null });
}

/** 1.173.0 (B3): the card page's reading of a card's area
 *  (`card_area::CardAreaState`). `none`: nothing to show (fewer than two
 *  areas, a pull request review); `needsArea`/`unknown`: "Which area is
 *  this?"; `held`: the areas can't be used. */
export interface CardAreaState {
  kind: "none" | "area" | "needsArea" | "unknown" | "held";
  areas: ResolvedArea[];
  area: ResolvedArea | null;
  /** 1.173.0 (C1): "Its area label hasn't reached GitHub yet." while a
   *  push of the issue's area label failed; `null` otherwise. */
  labelLine?: string | null;
  sentence: string | null;
  /** The area every changed file is in, when they are all in one. */
  suggested: string | null;
  /** The area can be chosen or changed now. */
  editable: boolean;
  /** The ids that may be chosen: all for a card with no copy; for a started
   *  card, the areas whose cards go to the branch its copy was cut from. */
  fits: string[];
}

export function cardAreaState(workspaceId: string, cardId: string) {
  return invoke<CardAreaState>("card_area_state", { workspaceId, cardId });
}

/** 1.173.0 (B3): choose or change a card's area (a listed id). Refused
 *  under held areas and once a card started with an area it has. */
export function kanbanCardSetArea(workspaceId: string, cardId: string, area: string) {
  return invoke<KanbanCard>("kanban_card_set_area", { workspaceId, cardId, area });
}

/** One file a card changed outside its area (`card_area::OutsideFile`). */
export interface OutsideFile {
  path: string;
  /** A rename's old path: leaving it out puts both back. */
  from?: string;
  area: string | null;
  /** "whole repository", or the other area's name. */
  belongs: string;
}

/** The sheet before Ship (`card_area::OutsideFiles`). */
export interface OutsideFiles {
  area: ResolvedArea;
  files: OutsideFile[];
  hint: string;
}

/** 1.173.0 (B3): the card's files outside its area; `null` when it has no
 *  area to be outside of (no areas, one area) or no copy. */
export function cardOutsideFiles(workspaceId: string, cardId: string) {
  return invoke<OutsideFiles | null>("card_outside_files", { workspaceId, cardId });
}

/** What *Leave those out* did (`card_area::LeaveOut`). */
export interface LeaveOut {
  leftOut: string[];
  sha: string | null;
  /** A Builder card: Finish and check records the commit and runs the
   *  checks; else the checks run on the commit. */
  builder: boolean;
}

/** 1.173.0 (B3): *Leave those out* — those files put back as they are on
 *  the card's base, in one commit. Ship then waits for the checks. */
export function cardLeaveOutFiles(workspaceId: string, cardId: string, paths: string[]) {
  return invoke<LeaveOut>("card_leave_out_files", { workspaceId, cardId, paths });
}

/** 1.173.0 (B2): one product Plyloft saw in the repository
 *  (`area_discovery::Product`). `path` "" is the root. */
export interface DiscoveredProduct {
  path: string;
  kind: "app" | "site";
}

/** 1.173.0 (B2): two products or more (`area_discovery::AreaDiscovery`). */
export interface AreaDiscovery {
  /** The root first, then the folders in path order. */
  products: DiscoveredProduct[];
  /** One area per product, in the same order: what *Set up areas…* fills
   *  in on Settings › Areas. */
  suggestion: AreaDef[];
  /** The Board's notice applies: a product at the root and one beside it. */
  notice: boolean;
}

/** 1.173.0 (B2): does the repository hold more than one product? Off the
 *  main thread (git lists its files), cached per repository and commit;
 *  `null` with fewer than two, or outside a git repository. */
export function areasDiscover(workspaceId: string) {
  return invoke<AreaDiscovery | null>("areas_discover", { workspaceId });
}

export interface DefinitionUnreadable {
  path: string;
  line: number | null;
  message: string;
  commit: string | null;
}

export interface DefinitionFieldChange {
  field: string;
  label: string;
  value: unknown;
  /** 1.173.0 (B1): the value this Mac had — sent for `areas` only. */
  previous?: unknown;
}

/** GH #80: `pendingSync` — queued for the integration branch, not published
 *  yet; `waitingForPr` — every pending field waits in a pull request. */
export type DefinitionPendingState = "pendingSync" | "waitingForPr";

/** A pull request a refused publish opened. */
export interface ConfigPullRequest {
  number: number;
  url: string;
  branch: string;
}

/** One shared field queued for the write channel. */
export interface QueuedConfigField {
  value: unknown;
  /** The repository's value it replaces. */
  base: unknown;
  baseCommit: string | null;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
  pullRequest: ConfigPullRequest | null;
  /** 1.173.0 (C3): the branch's value changed since this edit; it waits for
   *  the person's choice. Absent in queues written before. */
  conflict?: unknown;
  /** 1.173.0 (C3): *Use this Mac's* — the value it replaces. */
  useMine?: { over: unknown };
}

/** 1.173.0 (C3): what differs between the branch's value and this Mac's. */
export interface SettingDifference {
  /** Both are lists: `both`, `onlyMine`, `onlyTheirs`, `different` say it;
   *  otherwise `theirs` and `mine`. */
  list: boolean;
  both: string[];
  onlyMine: string[];
  onlyTheirs: string[];
  different: string[];
  theirs: string;
  mine: string;
  /** C3 Challenger 4: a value made of keys — only the keys set differently. */
  keys?: { name: string; theirs: string; mine: string }[];
}

/** 1.173.0 (C3): a shared setting both sides changed (`setting_conflict.rs`). */
export interface SettingConflict {
  field: string;
  label: string;
  author: string | null;
  /** The computer the other value came from (the commit's trailer). */
  device: string | null;
  /** The same person, on another computer. */
  samePerson: boolean;
  /** Seconds. */
  changedAt: number | null;
  /** C3 Challenger 2: from another folder of this repository on this very
   *  computer. */
  thisComputer?: boolean;
  /** C3 Challenger 1: the branch's value as shown, sent back with the answer. */
  theirs?: unknown;
  difference: SettingDifference;
}

/** 1.173.0 (C3): `theirs` — *Keep …'s*; `mine` — *Use this Mac's*. False:
 *  there was no question about that field any more. */
export function workspaceDefinitionResolveConflict(
  workspaceId: string,
  field: string,
  choice: "theirs" | "mine",
  /** C3 Challenger 1: the question as shown; an older one records nothing. */
  shown: { theirs: unknown; changedAt: number | null },
) {
  return invoke<boolean>("workspace_definition_resolve_conflict", { workspaceId, field, choice, shown });
}

/** `projects/<ws>/shared_config_queue.json`. */
export interface ConfigPublishQueue {
  schemaVersion: number;
  createDefinition: boolean;
  fields: Record<string, QueuedConfigField>;
  lastError: string | null;
  /** Card #94: that attempt failed because the remote could not be
   *  reached. A page opened later has no refresh report to read, and
   *  "you're offline" is a different thing to say from "it didn't land".
   *  Absent in queues written before this field. */
  lastOffline?: boolean;
  /** The PR carrying the file's creation, while it waits. */
  createPullRequest: ConfigPullRequest | null; creationOpen?: number | null; // C4: GitHub said it is open
  /** The fallback branch chosen for the change being published. */
  pullRequestBranch: string | null;
  /** PRs whose proposal was edited again or reverted, to be closed. */
  supersededPullRequests: ConfigPullRequest[];
}

export interface ConfigOverride {
  field: string;
  author: string | null;
  /** Seconds. */
  changedAt: number | null;
}

/** What one drain of the publish queue did. */
export interface ConfigPublishReport {
  branch: string;
  published: string[];
  commit: string | null;
  overrides: ConfigOverride[];
  pullRequest: ConfigPullRequest | null;
  pullRequestFields: string[];
  closedPullRequests: number[];
  /** Superseded PRs Ply closed. */
  withdrawnPullRequests: number[];
  error: string | null;
  offline: boolean;
  /** 1.173.0 (C3): fields held for the person's choice. */
  conflicts?: string[];
}

export interface DefinitionRefreshReport {
  workspaceId: string;
  moment: RefreshMoment;
  hasDefinition: boolean;
  source: "repo" | "legacy" | "seeded" | null;
  branch: string | null;
  author: string | null;
  commit: string | null;
  changes: DefinitionFieldChange[];
  unreadable: DefinitionUnreadable | null;
  fetchError: string | null;
  pendingFields: string[];
  pendingState: DefinitionPendingState | null;
  /** GH #80: the queue drain that ran before the read, if any. */
  publish: ConfigPublishReport | null;
  /** GH #82: this Mac can't write the shared definition. */
  readOnly?: boolean;
  /** GH #82: shared notes and project skills — drained, then read. */
  library?: LibraryReport | null;
  /** T6: no definition was cached before this read — it set this machine up. */
  firstRead?: boolean;
}

/** GH #82: what one sync of the shared library did. */
export type LibraryReport = LibraryReportLike;

export interface DefinitionCache {
  schemaVersion: number;
  definition: WorkspaceDefinition | null;
  /** GH #81: `seeded` — shared from this Mac, not on the branch yet. */
  source: "repo" | "legacy" | "seeded";
  branch: string | null;
  commit: string | null;
  author: string | null;
  /** Card #94: when that commit was made (seconds). Absent in caches written
   *  before it, and whenever git could not say. */
  changedAt?: number | null;
  refreshedAt: number;
  unreadable: DefinitionUnreadable | null;
  pending: Record<string, unknown>;
  pendingState: DefinitionPendingState | null;
  /** GH #82: GitHub's push permission, and a refused publish. */
  writeAccess?: {
    canPush: boolean | null;
    checkedAt: number;
    pushRefused: string | null;
  };
  /** 1.173.0 (B1): shared fields held on this Mac (today `areas` that break
   *  the rules): why, and the last good value it keeps (`null`: none). */
  fieldProblems?: Record<string, { message: string; kept: unknown }>;
}

export interface DefinitionView {
  cache: DefinitionCache;
  /** What this Mac runs with: the repo's definition plus pending edits. */
  effective: WorkspaceDefinition | null;
  defaultBranch: string;
  /** GH #80: what waits for the integration branch, per field. */
  queue: ConfigPublishQueue;
  /** GH #82: the shared fields are read-only on this Mac. */
  readOnly?: boolean;
  /** GH #82: who set each field in the repo (read only when read-only). */
  provenance?: Record<string, FieldProvenanceLike>;
  /** 1.173.0 (C3): shared settings both sides changed, waiting for a choice. */
  conflicts?: SettingConflict[];
}

/** Read the definition from the integration branch and make this Mac match. */
export function workspaceDefinitionRefresh(
  workspaceId: string,
  moment: RefreshMoment,
) {
  return invoke<DefinitionRefreshReport>("workspace_definition_refresh", {
    workspaceId,
    moment,
  });
}

export function workspaceDefinitionGet(workspaceId: string) {
  return invoke<DefinitionView | null>("workspace_definition_get", {
    workspaceId,
  });
}

/** The editor's Save. `base` is the definition the editor opened on; the
 *  backend takes from `draft` only what differs from it, merged over the
 *  definition as it is when the save runs. */
export function workspaceDefinitionSave(
  workspaceId: string,
  base: Record<string, unknown>,
  draft: Record<string, unknown>,
  /** SL-4: the setup row itself edited `worktreeSetup` — the only save that
   *  makes the command one this Mac agrees to run. */
  approveSetup = false,
) {
  return invoke<DefinitionView>("workspace_definition_save", {
    workspaceId,
    base,
    draft,
    approveSetup,
  });
}

/** Card #94: what Settings offers for `Integration branch`, and the branch a
 *  workspace falls back to when nothing else names one. `branches` is empty
 *  when git can't say (no origin, offline with no refs). */
export interface BranchChoices {
  /** Only what was really read from origin, never padded. */
  branches: string[];
  defaultBranch: string;
  /** Why they could not be read (offline, a refused fetch); null when the
   *  read went through — which for a repository without an origin still
   *  means there are none. */
  error: string | null;
  hasOrigin: boolean; trouble?: { kind: string; org?: string | null } | null; originHost?: string | null; // C4: the error's kind; F3 walk: a non-GitHub origin's host
  /** 1.174.0 (Areas round 1): this computer's own branches (no fetch);
   *  absent from an older backend. */
  localBranches?: string[];
}

export function workspaceDefinitionBranches(workspaceId: string) {
  return invoke<BranchChoices>("workspace_definition_branches", { workspaceId });
}

/** GH #80: publish the whole definition (a converted legacy file) to the
 *  integration branch. Never writes the checkout. */
export function workspaceDefinitionPublish(workspaceId: string) {
  return invoke<DefinitionView>("workspace_definition_publish", {
    workspaceId,
  });
}

/** GH #80: open a pull request the publish queue waits on, in the browser. */
export function workspaceDefinitionOpenPullRequest(
  workspaceId: string,
  number: number,
) {
  return invoke<void>("workspace_definition_open_pull_request", {
    workspaceId,
    number,
  });
}

/** GH #81: what the board's adoption banner shows for a workspace. */
export function workspaceAdoptionStatus(workspaceId: string, solo = false) {
  // 1.171.0 (X2): solo mode reads only the setup found elsewhere, from the
  // cache, without asking GitHub anything.
  return invoke<AdoptionStatus>("workspace_adoption_status", { workspaceId, solo });
}

/** GH #81: Share — seed `.atelier/workspace.json` from this Mac and publish
 *  it (with the `.gitignore` fix) to the integration branch. */
export function workspaceAdoptionShare(workspaceId: string) {
  return invoke<ShareOutcome>("workspace_adoption_share", { workspaceId });
}

/** GH #81: "Not on this Mac", remembered per Mac and repository. */
export function workspaceAdoptionDecline(workspaceId: string) {
  return invoke<void>("workspace_adoption_decline", { workspaceId });
}

/** 1.171.0 (X2): the answer to a shared setup found on another branch —
 *  `useIt` ("Use the shared setup"; a refresh then adopts it) or not ("Keep
 *  this folder's setup"; not asked again for that branch). */
export function workspaceAdoptionSetupElsewhere(
  workspaceId: string,
  useIt: boolean,
  /** 1.172.0 (B1): which of several branches "Use the one for …" chose. */
  branch: string | null = null,
) {
  return invoke<void>("workspace_adoption_setup_elsewhere", { workspaceId, useIt, branch });
}

/** OB-8: the board offer's answer — `moved` ("Move to GitHub Issues"; the
 *  automatic switch and migration then run) or not ("Keep it on this Mac";
 *  not offered again). Records the answer only. */
export function workspaceAdoptionBoardChoice(workspaceId: string, moved: boolean) {
  return invoke<void>("workspace_adoption_board_choice", { workspaceId, moved });
}

/** Every refresh, whichever moment ran it (Sync and Start build included). */
export function onWorkspaceDefinitionRefreshed(
  handler: (report: DefinitionRefreshReport) => void,
): Promise<UnlistenFn> {
  return listen<DefinitionRefreshReport>(
    "workspace-definition://refreshed",
    (e) => handler(e.payload),
  );
}

/** A local edit to a shared field was recorded as pending. */
/** GH #82: a shared note or project skill was queued on this Mac. */
export function onSharedLibraryEdited(
  handler: (workspaceId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("workspace-definition://library-edited", (e) =>
    handler(e.payload),
  );
}

/** GH #82: does this workspace's Shared · Project go through the channel,
 *  and may this Mac write it? */
export function knowledgeProjectState(workspaceId: string) {
  return invoke<LibraryStateLike>("knowledge_project_state", { workspaceId });
}

/** GH #82: create (no id) or edit a Shared · Project note. */
export function knowledgeProjectSave(
  workspaceId: string,
  input: { id: string | null; title: string; body: string; tags: string[] },
) {
  return invoke<Memory>("knowledge_project_save", { workspaceId, input });
}

export function knowledgeProjectDelete(workspaceId: string, id: string) {
  return invoke<void>("knowledge_project_delete", { workspaceId, id });
}

/** GH #82: publish the checkout's `.claude/skills/<skill>` to the
 *  integration branch. */
/** Group B §2 walk: what `Update on <branch>` did beyond publishing the
 *  checkout's copies — `follows` names the copy that followed the edited one. */
export interface SkillPublish {
  follows: "claude" | "codex" | null;
  /** Owner, 2026-10-19: `published` — the push went through; `queued` — it
   *  waits (offline, or retried on the next Sync); `said` — the drain's own
   *  toast already says what happened (a pull request, a refusal). */
  outcome?: "published" | "queued" | "said" | "current";
}

/** Owner, 2026-10-19 (R15): `scriptsOk` — the ids the scripts sheet's OK
 *  sent. A publish that brings a new or changed script (or a file that is not
 *  text) onto the branch is refused without them, with the scripts marker. */
export function projectSkillPublish(workspaceId: string, skill: string, scriptsOk?: string[]) {
  return invoke<SkillPublish | null>("project_skill_publish", { workspaceId, skill, scriptsOk: scriptsOk ?? null });
}

/** Owner, 2026-10-19 (R15): the scripts sheet before `Publish to <branch>` —
 *  every file the publish would write onto the shared branch, when it brings a
 *  new or changed script or a file that is not text. `null`: publish as
 *  before. */
export function projectSkillPublishReview(workspaceId: string, skill: string) {
  return invoke<ScriptsReview | null>("project_skill_publish_review", { workspaceId, skill });
}

/** GH #82: remove a project skill from the integration branch. Both copies of
 *  it (GH #105): half a skill left behind goes on being loaded. */
export function projectSkillUnpublish(
  workspaceId: string,
  skill: string,
  /** Group B §2: the branch's id of the skill the row showed. */
  shown: string | null = null,
) {
  return invoke<void>("project_skill_unpublish", { workspaceId, skill, shown });
}

/** 1.169.0 (C4): what `Undo` on a removal found. `withdrawn` taken back;
 *  `restored` taken back and the unpublished edit it replaced queued again;
 *  `notQueued` it had already gone to the branch; `replaced` something newer
 *  is queued for the skill; `noLibrary` the project has no shared library
 *  here any more. */
export type SkillRemovalUndo = "withdrawn" | "restored" | "notQueued" | "replaced" | "noLibrary";

/** 1.169.0 (C4): `Undo` on the removal's toast — takes the queued removal back
 *  while it still waits (10 s). */
export function projectSkillUnpublishUndo(workspaceId: string, skill: string) {
  return invoke<SkillRemovalUndo>("project_skill_unpublish_undo", { workspaceId, skill });
}

/** GH #105: one skill that could not be carried over to the other CLI, and why.
 *  Mirrors `skill_reach::SkippedSkill`. */
export interface SkippedSkill {
  name: string;
  reason: string;
}

/** GH #105: what `Make available to both` and `Align` did. Mirrors
 *  `skill_reach::ReachOutcome`. */
export interface ReachOutcome {
  /** The skills a copy was queued for — one commit carries all of them. */
  queued: string[];
  /** Those that could not be carried over, each with its reason. */
  skipped: SkippedSkill[];
  /** Those that already reached both CLIs: nothing to do. */
  already: string[];
  branch: string | null;
}

/**
 * GH #105: `Make available to both` / `Make all available to both` — create the
 * missing copy of each skill on the integration branch, one commit for the
 * action. The checkout is neither read nor written.
 */
export function projectSkillsAvailableToBoth(workspaceId: string, skills: string[]) {
  return invoke<ReachOutcome>("project_skills_available_to_both", { workspaceId, skills });
}

/** GH #105: `Align` — the copy of `winner` becomes the one both CLIs get on the
 *  branch, in one commit. */
export function projectSkillAlign(
  workspaceId: string,
  skill: string,
  winner: "claude" | "codex",
  /** Group B §2: the branch's id of the skill the Align flow showed. */
  shown: string | null = null,
) {
  return invoke<ReachOutcome>("project_skill_align", { workspaceId, skill, winner, shown });
}

// ── Improvement proposals (GH #104, ADR 0005; BOARDS.md §4 state C) ───

/** GH #104: this workspace's improvement proposal, or `null`. The staleness
 *  rules are applied in Rust, so all three surfaces ask one question once. */
export function improvementProposalState(workspaceId: string) {
  return invoke<ProposalView | null>("improvement_proposal_state", { workspaceId });
}

/** The card whose last improvement-proposal pass stopped at Claude's trust
 *  question, or null (`proposals::trust_stopped_card`). A file read. */
export function improvementProposalTrustStopped(workspaceId: string) {
  return invoke<string | null>("improvement_proposal_trust_stopped", { workspaceId });
}

/** GH #104: `Dismiss` — forget it. */
export function improvementProposalDismiss(workspaceId: string) {
  return invoke<void>("improvement_proposal_dismiss", { workspaceId });
}

/** GH #104: `Approve and publish` — onto the integration branch through the
 *  shared channel's existing paths. SP-5: a workspace with no shared
 *  definition commits (and pushes, with a remote) here and now, and answers
 *  with what it did; the shared channel answers `null`. */
export function improvementProposalApprove(workspaceId: string) {
  return invoke<ProposalApproved | null>("improvement_proposal_approve", { workspaceId });
}

/** GH #104: the Challenger wrote one, or one was dropped or published. */
export function onImprovementProposalChanged(
  handler: (workspaceId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("improvement-proposal://changed", (e) => handler(e.payload));
}

/** Skills hub H6a (§6 `skills-hub://decision`): an Inbox-worthy skill state
 *  appeared or resolved — a script OK, a refresh that brought a new script. */
export function onSkillsHubDecision(handler: () => void): Promise<UnlistenFn> {
  return listen<unknown>("skills-hub://decision", () => handler());
}

/** GH #104: the human typed a correction into the Builder session after its
 *  first answer — the friction rule's third condition. Answers the new count.
 *  GH #104 walk (B3): with its words, which the card keeps (bounded) for the
 *  improvement proposal's Challenger to read as the human's side. */
export function builderNoteCorrection(workspaceId: string, cardId: string, text: string | null) {
  return invoke<number>("builder_note_correction", { workspaceId, cardId, text });
}

export function onWorkspaceDefinitionEdited(
  handler: (workspaceId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("workspace-definition://edited", (e) =>
    handler(e.payload),
  );
}

/** v1.12.0: read this workspace's persisted project_config. Returns
 *  null when no config exists (workspace hasn't been onboarded). */
export function projectConfigGet(workspaceId: string) {
  return invoke<ProjectConfig | null>("project_config_get", { workspaceId });
}

/** v1.12.0: enumerate every workspace that has a config on disk. */
export function projectConfigList() {
  return invoke<Array<[string, ProjectConfig]>>("project_config_list");
}

/** v1.12.1: deterministic filesystem scan that proposes a config.
 *  Read-only — caller is expected to hand the result to the user
 *  for review before calling `projectConfigSet`. */
export function projectConfigDetect(workspaceId: string) {
  return invoke<ProjectConfigProposal>("project_config_detect", {
    workspaceId,
  });
}

/** v1.12.1: persist a per-workspace config. Atomic. */
export function projectConfigSet(workspaceId: string, config: ProjectConfig) {
  return invoke<void>("project_config_set", { workspaceId, config });
}

// ── Try it: how the app starts (TRY_IT_SPEC §3.3, §4.3, §5) ───────────

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** `project_config::TryDetection`: what a read of the project folder found. */
export type TryDetection =
  | { kind: "packageScript"; command: string; script: string; packageManager: PackageManager }
  | { kind: "django"; command: string }
  | { kind: "rails"; command: string }
  | { kind: "staticSite"; file: string }
  | { kind: "none" };

/** `project_config::TryCommandView`. */
export interface TryCommandView {
  /** The saved start command, if any. */
  command: string | null;
  /** This machine may run it without asking. */
  approved: boolean;
  /** It travels through the repository's shared definition. */
  shared: boolean;
  /** Shared, and this machine can't write the repository's definition. */
  readOnly: boolean;
  /** This repository's build settings exist here (a save needs them). */
  hasConfig: boolean;
  detection: TryDetection;
}

/** The saved start command and what the project folder suggests (read now). */
export function projectTryCommandGet(workspaceId: string) {
  return invoke<TryCommandView>("project_try_command_get", { workspaceId });
}

/** Save how the app starts (null or empty clears it). Saved here counts as
 *  allowed here; published like every shared build setting. */
export function projectTryCommandSave(workspaceId: string, command: string | null) {
  return invoke<TryCommandView>("project_try_command_save", { workspaceId, command });
}

/** "Allow and run" for a start command that came from the repository. */
export function projectTryCommandApprove(workspaceId: string, command: string) {
  return invoke<TryCommandView>("project_try_command_approve", { workspaceId, command });
}

/** v1.12.1: remove a workspace's config + its
 *  `<config_dir>/projects/<workspaceId>/` subdir entirely
 *  (including any per-workspace intake.md). Idempotent. */
/** ADR 0006 (third card): a workspace's review settings, with or without a
 *  project config (`project_config.rs::ReviewSettings`). */
export interface ReviewSettings {
  selfCheck: boolean;
  reviewChecklist: ReviewChecklistClass[];
  /** Findings filter: which findings block approval. Absent from backends
   *  before it, which read as "p1-p2". */
  blockingFindings?: BlockingThreshold;
}

/** Findings filter (`review_ledger.rs::BlockingThreshold`): "p1" = P1 only,
 *  "p1-p2" = P1 and P2 (the default, the rule before the setting), "all" =
 *  every finding in code the change wrote. */
export type BlockingThreshold = "p1" | "p1-p2" | "all";

/** Findings filter: set `Findings that block approval` for this workspace.
 *  It applies from the next review that settles. */
export function projectConfigSetBlockingFindings(workspaceId: string, threshold: BlockingThreshold) {
  return invoke<ReviewSettings>("project_config_set_blocking_findings", { workspaceId, threshold });
}

export function projectReviewGet(workspaceId: string) {
  return invoke<ReviewSettings>("project_review_get", { workspaceId });
}

/** ADR 0006 (third card): change `Self-check before review` and/or the
 *  repository's checklist classes. `baseChecklist` is the list the editor
 *  started from: a list that changed since (a Sync) is refused, never
 *  overwritten. Over-limit lists are refused with the reason. Published
 *  through the shared channel like any edit of the project config. */
export function projectConfigSetReview(
  workspaceId: string,
  change: {
    selfCheck?: boolean;
    reviewChecklist?: ReviewChecklistClass[];
    baseChecklist?: ReviewChecklistClass[];
  },
) {
  return invoke<ReviewSettings>("project_config_set_review", {
    workspaceId,
    selfCheck: change.selfCheck ?? null,
    reviewChecklist: change.reviewChecklist ?? null,
    baseChecklist: change.baseChecklist ?? null,
  });
}

export function projectConfigDelete(workspaceId: string) {
  return invoke<void>("project_config_delete", { workspaceId });
}

/** v1.18.0 (Cycle E3): builtin starter-pack template metadata. The 5
 *  templates had a picker in the old `ProjectConfigPanel`; card #94's page
 *  edits every field directly and offers what a scan of the repository
 *  finds, so nothing surfaces them today. The commands stay. */
export interface ProjectConfigTemplate {
  id: string;
  label: string;
  description: string;
  config: ProjectConfig;
}

/** v1.18.0: list the builtin starter-pack templates. Pure read; no
 *  workspace state consulted. */
export function projectConfigListTemplates() {
  return invoke<ProjectConfigTemplate[]>("project_config_list_templates");
}

/** v1.18.0: stamp a builtin template onto a workspace. Returns the
 *  persisted config so the caller can re-render the now-onboarded
 *  view without an extra `projectConfigGet` round-trip. */
export function projectConfigApplyTemplate(workspaceId: string, templateId: string) {
  return invoke<ProjectConfig>("project_config_apply_template", {
    workspaceId,
    templateId,
  });
}

// ── Card attachments (v1.10.0) ─────────────────────────

export function kanbanAttachmentAddFromBytes(
  workspaceId: string,
  cardId: string,
  name: string,
  bytes: Uint8Array,
) {
  // D3 (1.172.2): the raw bytes as the body, the rest as headers.
  return invoke<CardAttachment>("kanban_attachment_add_from_bytes", bytes, {
    headers: {
      "x-ply-workspace-id": workspaceId,
      "x-ply-card-id": cardId,
      "x-ply-file-name": droppedNameHeader(name),
    },
  });
}

export function kanbanAttachmentAddFromPath(
  workspaceId: string,
  cardId: string,
  sourcePath: string,
) {
  return invoke<CardAttachment>("kanban_attachment_add_from_path", {
    workspaceId,
    cardId,
    sourcePath,
  });
}

export function kanbanAttachmentRemove(
  workspaceId: string,
  cardId: string,
  attachmentId: string,
) {
  return invoke<void>("kanban_attachment_remove", {
    workspaceId,
    cardId,
    attachmentId,
  });
}

export function kanbanAttachmentReveal(storedPath: string) {
  return invoke<void>("kanban_attachment_reveal", { storedPath });
}

export function kanbanAttachmentOpen(storedPath: string) {
  return invoke<void>("kanban_attachment_open", { storedPath });
}

export function kanbanAttachmentGcCard(
  workspaceId: string,
  cardId: string,
) {
  return invoke<void>("kanban_attachment_gc_card", { workspaceId, cardId });
}

/**
 * v1.28.0 (Cycle I-2): per-card swarm cascade GC, called by `removeCard`
 * alongside `kanbanAttachmentGcCard`. The FE passes the union of
 * `card.linkedBrainstormId` + `card.linkedSwarmId` (both are swarm IDs).
 * The backend returns three disjoint id buckets:
 *  - `deleted`: ids successfully reaped.
 *  - `refusedRunning`: the actionable case — abort the swarm first.
 *  - `refusedOther`: silently-handled cases (Adhoc / missing / still linked
 *    elsewhere). The FE should not surface these.
 */
export interface GcCardResult {
  deleted: string[];
  refusedRunning: string[];
  refusedOther: string[];
}

export function kanbanSwarmGcCard(
  workspaceId: string,
  cardId: string,
  swarmIds: string[],
) {
  return invoke<GcCardResult>("kanban_swarm_gc_card", {
    workspaceId,
    cardId,
    swarmIds,
  });
}

// ── Ship pipeline (v1.9.0 Phase A) ─────────────────────

export interface InFlightSwarm {
  swarmId: string;
  workspaceId: string;
  goal: string;
}

export interface InFlightIntake {
  cardId: string;
  workspaceId: string;
}

/** Backend snapshot of in-flight work + branch + version state. The
 *  frontend overlays its own dirty-buffer / long-running-tile info
 *  before showing the audit modal. */
export interface ShipAuditReport {
  activeSwarms: InFlightSwarm[];
  activeIntakes: InFlightIntake[];
  /** Phase A only exposes a count; Phase A.5's drain coordinator will
   *  surface per-run details. */
  activeRunCount: number;
  branch: string;
  /** QoL 1.168 S1-4: `branch === targetBranch`. */
  branchOk: boolean;
  /** QoL 1.168 S1-4: the branch the audited workspace ships onto (its
   *  project settings; "main" when it has none). Absent from an older
   *  backend: read as "main". */
  targetBranch?: string;
  /** The audited workspace's own version: its version file, package.json,
   *  its latest vX.Y.Z tag, or 0.0.0. */
  currentVersion: string;
  /** Where `currentVersion` was read: a file path, "tag", or null (none). */
  versionSource?: string | null;
  /** Shipping it ends with Plyloft's own install (quit and relaunch). */
  relaunches?: boolean;
  suggestedNextVersion: string;
  /** True when another ship is in flight; Ship action must be disabled.
   *  GH #222 review 1: for the workspace the audit was asked about. */
  shipInFlight: boolean;
  /** GH #222 review 1: that workspace's release that is committed and tagged
   *  but not published. The dialog offers `Publish vX (already committed)`
   *  for exactly its cards instead of a new version. */
  pendingRelease?: PendingRelease | null;
  /** GH #222 review 3: why the workspace's record can't be read — Ship and
   *  Land wait until it is dismissed. */
  pendingRecordUnreadable?: string | null;
  /** GH #222 review 4: another workspace's recorded release on the same
   *  repository and branch holds this one back — said up front. */
  pendingElsewhere?: string | null;
  /** G8 (1.170.0): origin is on GitHub, so a release that pushes goes
   *  through a pull request — never onto this computer's target, whatever
   *  branch the project folder is on. Absent from an older backend: false. */
  releasesThroughPr?: boolean;
  /** G8 fixes (1.170.0): `currentVersion` is GitHub's target's, later than
   *  the project folder's (a release through a pull request is built from
   *  it). Absent from an older backend: false. */
  versionOnGithub?: boolean;
  /** 1.173.0 (B4): `ship::AuditArea` — the area this release is of. Absent
   *  from an older backend; empty without areas. */
  area?: AuditArea;
}

/** 1.173.0 (B4): `ship::AuditArea`. */
export interface AuditArea {
  /** `null` without areas. */
  name: string | null;
  /** The release tags' prefix: "" is `vX.Y.Z`, "site-" is `site-vX.Y.Z`. */
  tagPrefix: string;
  /** Why this area can't be released, in words; Ship stays off. */
  refusal: string | null;
}

/** 1.173.0 (B4): which area an audit is about — the card's (Ship now,
 *  Release…) or the one Ship batch releases. Neither: the workspace's. */
export interface AuditFor {
  cardId?: string | null;
  area?: string | null;
}

/** G8 (1.170.0): `release_record::PrReleaseStep`, in order. */
export type PrReleaseStep = "building" | "built" | "pushed" | "open" | "merging" | "merged" | "tagged";

/** G8 (1.170.0): `release_record::ReleasePr` — how far a release through a
 *  pull request got. */
export interface ReleasePrRecord {
  step: PrReleaseStep;
  /** `plyloft/release-vX.Y.Z` (1.173.0: `plyloft/release-site-vX.Y.Z` for
   *  an area's). */
  branch: string;
  head: string | null;
  number: number | null;
  url: string | null;
  /** Why it is still waiting, in words. */
  waiting: string | null;
  /** GitHub's target moved on under it: Update the release is offered. */
  outdated: boolean;
  checksRun: string[];
  checksNotRun: string[];
  /** 1.172.0 B2: Plyloft merges it itself (GitHub's auto-merge wasn't
   *  turned on), so only while Plyloft is open. Absent in an older record
   *  or when false. */
  plyloftMerges?: boolean;
  /** 1.171.0 F3: GitHub is on its way to merging it (its checks running,
   *  its auto-merge asked for). Absent when false. */
  mergeOnItsWay?: boolean;
  /** 1.174.0 (DR4 round 1): GitHub's checks failed on it — it waits for the
   *  person. Absent in an older record or when false. */
  checksFailed?: boolean;
}

/** G8 (1.170.0): `release_pr::ReleasePrResult` — what a release press did. */
export interface ReleasePrResult {
  step: PrReleaseStep;
  number: number | null;
  url: string | null;
  waiting: string | null;
  /** Merged, tagged and the cards marked shipped. */
  released: boolean;
}

/**
 * GH #222 review 2: `release_record::PendingReleaseView` — a release Ship
 * committed and tagged on this Mac and recorded before its first push, not
 * yet published. `stoppedAt` / `cause` are null while no push has reported
 * (read back later: Ply quit during them). `problem` is set when it can't be
 * published from here (its tag is gone or moved): only Dismiss then.
 */
export interface PendingReleaseView {
  /** `1.0.1`; the tag is `v1.0.1`. */
  version: string;
  tag: string;
  commitSha: string;
  /** The target branch. */
  branch: string;
  cardIds: string[];
  cardRevs?: Record<string, string>;
  /** The kind it was released as; publishing uses it (never `local`). */
  releaseKind: ReleaseKind;
  skipVerify?: boolean;
  stoppedAt: "branch" | "tag" | null;
  cause: "timedOut" | "refused" | "originMoved" | null;
  /** git's own words, for Details. */
  output: string | null;
  /** The push bound in words: "5 minutes". */
  bound: string | null;
  createdAt: number;
  /** GH #222 review 3–4: `committing` — Ply stopped mid-release; the commit
   *  and tag may not exist and a staged merge may be left. */
  stage?: "committing" | "tagged";
  problem: string | null;
  /** R9: the branch push was refused because the branch is protected on
   *  GitHub; the tag was not pushed. Absent in an older record: false. */
  protected?: boolean;
  /** R9: `Undo the local release` is offered (protected, nothing pushed,
   *  the start commit known). The backend checks GitHub again. */
  undo?: boolean;
  /** G8 (1.170.0): a release through a pull request; absent otherwise. */
  pr?: ReleasePrRecord | null;
  /** 1.174.0 (DR2): the cards already on the target that it carries (they
   *  get its tag once it is done); never in `cardIds`. Absent from an older
   *  backend. `cardIds` may be empty: a release of what is on the target. */
  mergedCardIds?: string[];
  /** 1.174.0 (DR2): the area's last release its counts are from. */
  sinceTag?: string | null;
  /** 1.174.0 (DR2): how many other changes since `sinceTag`. */
  otherChanges?: number;
  /** 1.174.0 (DR2): Stop was asked of the press making it. Absent when
   *  false. */
  stopRequested?: boolean;
}

/** Review 1's name for the audit's field, kept for its readers. */
export type PendingRelease = PendingReleaseView;
/** GH #222: what `ship_card` / `ship_batch` reject with (`{ unpublished }`). */
export type UnpublishedRelease = PendingReleaseView;

/** GH #222 review 3: `ShipError::RecordUnreadable`. */
export interface RecordUnreadable {
  recordUnreadable: string;
}

export interface ReleaseUnpublished {
  unpublished: UnpublishedRelease;
}

export interface ShipRequest {
  workspaceId: string;
  cardId: string;
  releaseKind: ReleaseKind;
  /** Version to ship as (e.g. "1.9.0"). UI defaults to
   *  `suggestedNextVersion` from the audit. */
  version: string;
  /** v1.13.x (Phase E, decision 20): skip the verify-pass gate. Tag will
   *  carry an `-unverified` suffix and the card flips to
   *  `verifyStatus: skipped`. Visible cost in the toolbar's red badge. */
  skipVerify?: boolean;
}

export interface ShipBatchRequest {
  workspaceId: string;
  cardIds: string[];
  releaseKind: ReleaseKind;
  version: string;
}

export interface ShipResult {
  commitSha: string;
  shippedVersion: string;
  releaseKind: ReleaseKind;
  /** Captured stdout/stderr from `install-local.sh`. The full build
   *  log lives at `/tmp/atelier-install.log` per the script. */
  installLog: string;
  /** GH #183: the land's or release's fast-forward left the target branch at
   *  origin's tip (Rust `LocalBranchSync::fast_forwarded`: FastForwarded or
   *  UpToDate — never Offline, NoRemote or Ahead). The one proof GH #88's
   *  refusal is gone; absent reads as false. */
  fastForwarded?: boolean;
  /** QoL 1.168 S1-4: the project's install script that was started. */
  installScript?: string | null;
  /** QoL 1.168 S1-4: that script is Plyloft's own install — Plyloft quits
   *  and relaunches once it is built. */
  relaunches?: boolean;
  /** G8 (1.170.0): a release through a pull request — absent for one made
   *  on the target branch here. */
  releasePr?: ReleasePrResult | null;
  /** 1.173.0 (B4): the release's tag (`site-v1.0.1` for an area's). Absent
   *  from an older backend. */
  tag?: string | null;
}

/** GH #222 review 1: `workspaceId` scopes `shipInFlight` and
 *  `pendingRelease` to the workspace the dialog ships from. */
export function shipAudit(workspaceId?: string, asked: AuditFor = {}) {
  return invoke<ShipAuditReport>("ship_audit", {
    workspaceId: workspaceId ?? null,
    cardId: asked.cardId ?? null,
    area: asked.area ?? null,
  });
}

/** GH #222 review 3: `release_record::PendingReleaseState`. */
export interface PendingReleaseState {
  release: PendingReleaseView | null;
  /** Why the record file can't be read (it names the file). */
  unreadable: string | null;
}

/** GH #222 review 2–3: the workspace's recorded unpublished release. */
export function shipPendingRelease(workspaceId: string) {
  return invoke<PendingReleaseState>("ship_pending_release", { workspaceId });
}

/** GH #222 review 2: Dismiss it — the commit and tag stay on this Mac. */
/** G8 fixes (1.170.0): resolves with what was done on GitHub (a release
 *  pull request's auto-merge turned off), empty when nothing was. */
export function shipPendingReleaseDismiss(workspaceId: string) {
  return invoke<string | null>("ship_pending_release_dismiss", { workspaceId });
}

/** R9: Undo the local release GitHub refused as protected — the target goes
 *  back to where the release began, the local tag is deleted, the record is
 *  cleared. Resolves with what was done, in words. */
export function shipPendingReleaseUndo(workspaceId: string) {
  return invoke<string>("ship_pending_release_undo", { workspaceId });
}

/** G8 (1.170.0): Update the release — GitHub's target moved on under the
 *  release pull request; merged into it, checked again and pushed (never
 *  forced). Resolves with what was done, in words. */
export function shipReleaseUpdate(workspaceId: string) {
  return invoke<string>("ship_release_update", { workspaceId });
}

/** GH #222 review 2: emitted with the workspace id when its record changes. */
export const PENDING_RELEASE_CHANGED = "ship-pending-release-changed";

/** G8 fixes (1.170.0, m2): `release_pr::ReleasedEvent` — the poller merged,
 *  tagged and marked a release while no press was waiting on it. */
export interface ReleasePrReleasedEvent {
  workspaceId: string;
  cardCount: number;
  result: ShipResult;
  /** The project's install step, offered (never run by the poller) when
   *  this computer's target is at the release. */
  installScript: string | null;
  /** That step is Plyloft's own install: it quits and relaunches. */
  relaunches: boolean;
}

export const RELEASE_PR_RELEASED = "release-pr-released";

export function onReleasePrReleased(handler: (event: ReleasePrReleasedEvent) => void) {
  return listen<ReleasePrReleasedEvent>(RELEASE_PR_RELEASED, (event) => handler(event.payload));
}

/** G8 fixes (m2): Run the install step of a release the poller finished —
 *  only while this computer's target is at it. Resolves with what started. */
export function shipReleaseInstall(workspaceId: string, tag: string) {
  return invoke<string>("ship_release_install", { workspaceId, tag });
}

export function shipCard(request: ShipRequest) {
  return invoke<ShipResult>("ship_card", { request });
}

export function shipPendingCount() {
  return invoke<number>("ship_pending_count");
}

/** QoL 1.168 C7: `ship::PendingShipCards` — the cards a batch can ship,
 *  per workspace on disk; the one source of every "Ship N". */
export interface PendingShipCards {
  workspaceId: string;
  cardIds: string[];
  /** 1.173.0 (B4): in a repository with areas, the same cards by the area
   *  a batch releases them as. Absent without areas. */
  areas?: PendingAreaCards[];
}

/** 1.173.0 (B4): `ship::PendingAreaCards`. */
export interface PendingAreaCards {
  /** `null`: the whole repository's, or refused. */
  area: string | null;
  name: string;
  cardIds: string[];
  /** Why no batch can release these cards yet. */
  refusal: string | null;
  /** Where its release goes, and its tags' prefix ("" when refused). */
  branch: string;
  tagPrefix: string;
}

export function shipPendingCards() {
  return invoke<PendingShipCards[]>("ship_pending_cards");
}

/** 1.174.0 (DR1): `release_scope::ScopeCard` — a card on the target since
 *  the area's last release. */
export interface ReleaseScopeCard {
  cardId: string;
  title: string;
  prNumber: number | null;
  /** When its last commit reached the target, Unix ms. */
  at: number;
  /** Its commits on the target, oldest first. */
  commits: string[];
}

/** 1.174.0 (DR1): `release_scope::OtherChange` — a change no card made
 *  (another pull request, a direct commit, a copy without a card). */
export interface ReleaseOtherChange {
  sha: string;
  title: string;
  prNumber: number | null;
  author: string;
  /** Unix ms. */
  at: number;
}

/** 1.174.0 (DR1): patch is the default (owner, 2026-10-31); `asIs` is the
 *  version file's own version (a first release, or a file ahead of the
 *  tag); `first` is 0.1.0, the default of an area never released with no
 *  version file. When the default's tag exists, the next free patch comes
 *  first. */
export type ReleaseVersionKind = "patch" | "minor" | "major" | "asIs" | "first";

export interface ReleaseVersionChoice {
  kind: ReleaseVersionKind;
  version: string;
  /** `site-v3.0.2`. */
  tag: string;
  /** That tag exists already (GitHub's were just fetched), or a release of
   *  it is on its way on GitHub (`onItsWay`). */
  taken: boolean;
  /** G2 walk: GitHub already has its release branch (its pull request open). */
  onItsWay?: boolean;
}

/** 1.174.0 (DR1): the area's release this computer recorded and hasn't
 *  finished. */
export interface ReleaseInFlight {
  tag: string;
  version: string;
  prNumber: number | null;
  prUrl: string | null;
  /** `release_record::PrReleaseStep`; `null` for a release made on the
   *  target branch here. */
  step: "building" | "built" | "pushed" | "open" | "merging" | "merged" | "tagged" | null;
  problem: string | null;
}

/** 1.174.0 (DR1, D1(b)): `release_scope::ReleaseScope` — what a release of
 *  one area carries: everything on its target since its last tag, in its
 *  folder, plus its ready cards (release.html states 1–4, 10). */
export interface ReleaseScope {
  workspaceId: string;
  /** `null` without areas. */
  area: string | null;
  name: string | null;
  tagPrefix: string;
  /** Where its cards go ("main"). */
  targetBranch: string;
  /** `origin` is GitHub: counted on GitHub's target, just fetched. */
  throughGithub: boolean;
  /** The commit counted to. */
  head: string | null;
  /** GitHub couldn't be read: what this computer saw of it last. Words. */
  fetchProblem: string | null;
  /** git couldn't count what changed. Words. */
  countProblem: string | null;
  /** A shallow copy of the project: the counts may be short (DR3 says
   *  "This copy of the project has only part of its history, so the counts
   *  may be short."). */
  partial: boolean;
  /** The folder counted, from the repository root; "" for the root area
   *  (or a workspace at the root without areas). */
  folder: string | null;
  /** The last release's tag, never an `-unverified` one; `null` before the
   *  first. */
  sinceTag: string | null;
  /** Unix ms. */
  sinceAt: number | null;
  /** The newest cards (at most 100), oldest first. */
  cards: ReleaseScopeCard[];
  /** Every card, listed or not. */
  cardsTotal: number;
  /** The newest other changes (at most 100), oldest first. */
  otherChanges: ReleaseOtherChange[];
  /** Every other change, listed or not. */
  otherTotal: number;
  /** The area's cards ready to ship but not on the target yet. */
  readyCardIds: string[];
  /** This computer's target against GitHub's, in commits (`null`: not
   *  known). */
  localAhead: number | null;
  localBehind: number | null;
  diverged: boolean;
  currentVersion: string;
  /** A version file's path, "tag", or `null` (0.0.0). */
  versionSource: string | null;
  /** What the version file says, and the last tag's version. */
  fileVersion: string | null;
  tagVersion: string | null;
  versionOnGithub: boolean;
  /** The default first. */
  versions: ReleaseVersionChoice[];
  /** Why the area can't be released, in words (also when GitHub has no
   *  such branch; then `fetchProblem` is null). A refused area of
   *  `releaseScopes` still carries `name`, `tagPrefix` and `targetBranch`. */
  refusal: string | null;
  inFlight: ReleaseInFlight | null;
  /** A release or land of this workspace runs right now. */
  busy: boolean;
}

/** 1.174.0 (DR1): what a release of `areaId` would carry (`null`: the
 *  workspace's, the first area's in a repository with areas). Fetches
 *  GitHub's target; never writes to GitHub. */
export function releaseScope(workspaceId: string, areaId: string | null) {
  return invoke<ReleaseScope>("release_scope", { workspaceId, areaId });
}

/** 1.174.0 (DR1): every area's scope, in the repository's order (one
 *  without areas), with one fetch of GitHub — How this goes live (DR5).
 *  Fetches are shared for 30 s. A rejection is raw text (no workspace, no
 *  repository): the caller says it in its own words. */
export function releaseScopes(workspaceId: string) {
  return invoke<ReleaseScope[]>("release_scopes", { workspaceId });
}

export function shipBatch(request: ShipBatchRequest) {
  return invoke<ShipResult>("ship_batch", { request });
}

/** 1.174.0 (DR2, D1(b)): `ship::ReleaseAreaRequest` — Release Site… of one
 *  area, with the cards ticked that aren't on its branch yet (none is
 *  fine: the release then carries what is on the branch since the area's
 *  last tag). Any number of ready cards may be ticked. */
export interface ReleaseAreaRequest {
  workspaceId: string;
  /** The area's id; null: the workspace's (the first area's). */
  areaId: string | null;
  cardIds: string[];
  releaseKind: ReleaseKind;
  version: string;
  skipVerify?: boolean;
}

/** 1.174.0 (DR2): `worktrees::ShipError::Stopped` — Stop the release took it
 *  back (`{ stopped }`): the person's own stop, never a failure. */
export interface ReleaseStopped {
  stopped: {
    tag: string;
    version: string;
    /** It had reached GitHub: what was done there, in words (its pull
     *  request's auto-merge turned off, the pull request left open). null:
     *  nothing of it was on GitHub. */
    onGithub: string | null;
    /** DR2 round 1: what taking it back left in the project folder, in
     *  words (changes kept in the stash list, a folder that couldn't be put
     *  back), when that isn't simply "put back as it was". */
    here: string | null;
    /** The project's `origin` is GitHub: only then is GitHub named. */
    github: boolean;
  };
}

/** 1.174.0 (DR2): the release of an area (`release_area`). Rejects with the
 *  same `ShipError` shapes as `shipBatch`, and `ReleaseStopped`. */
export function releaseTheArea(request: ReleaseAreaRequest) {
  return invoke<ShipResult>("release_area", { request });
}

/** 1.174.0 (DR2): `ship::ReleaseStopOutcome`. */
export interface ReleaseStopOutcome {
  /** The press making or sending it takes it back itself; its own answer
   *  (`ReleaseStopped`) says so. */
  stopping: boolean;
  /** Given up here (no press ran): what was done on GitHub, in words; empty
   *  when nothing was. null while `stopping`. */
  said: string | null;
}

/** 1.174.0 (DR2): Stop the release (`release_stop`). Rejects with words when
 *  there is none on its way, or it is merged already. */
export function releaseStop(workspaceId: string) {
  return invoke<ReleaseStopOutcome>("release_stop", { workspaceId });
}

export function shipUnverifiedCount() {
  return invoke<number>("ship_unverified_count");
}

// ── Verify pipeline (v1.10.x Phase B) ──────────────────

export type VerifyStateOut =
  | { kind: "queued"; position: number }
  | { kind: "running"; step: string; startedAt: number }
  | { kind: "passed" }
  | { kind: "failed"; reason: string }
  | { kind: "timedOut"; step: string }
  /** v1.12.x (Phase D, decision 17): claude CLI hit Max-plan capacity.
   *  Pipeline halts WITHOUT marking the card failed. Retry when free. */
  | { kind: "capacityStall"; detail: string };

export interface VerifyJobStatus {
  verifyRunId: string;
  workspaceId: string;
  cardId: string;
  state: VerifyStateOut;
  steps: VerifyStepResult[];
}

export interface VerifyRequestPayload {
  workspaceId: string;
  cardId: string;
}

export function verifyStart(request: VerifyRequestPayload) {
  return invoke<string>("verify_start", { request });
}

export function verifyStatus(workspaceId: string, cardId: string) {
  return invoke<VerifyJobStatus | null>("verify_status", {
    workspaceId,
    cardId,
  });
}

/** GH #62: reveal a verify step's full log in Finder. Only the card's
 *  last run keeps its logs; the backend errors when the log is gone. */
export function verifyRevealLog(
  workspaceId: string,
  cardId: string,
  verifyRunId: string,
  step: string,
) {
  return invoke<void>("verify_reveal_log", {
    workspaceId,
    cardId,
    verifyRunId,
    step,
  });
}

export function verifyListInflight() {
  return invoke<VerifyJobStatus[]>("verify_list_inflight");
}

export function onVerifyProgress(
  cb: (verifyRunId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("verify://progress", (e) => cb(e.payload));
}

export function onVerifyDone(
  cb: (verifyRunId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("verify://done", (e) => cb(e.payload));
}

// ── Drain coordinator (v1.9.x Phase A.5) ───────────────

export interface DrainStatus {
  draining: boolean;
  startedAt: number | null;
}

export function drainStatus() {
  return invoke<DrainStatus>("drain_status");
}

export function drainStart() {
  return invoke<void>("drain_start");
}

export function drainCancel() {
  return invoke<void>("drain_cancel");
}

// ── Intake agent (v1.7.0) ──────────────────────────────

/** v1.7.0: structured proposal the intake agent writes to a JSON file when
 *  the user clicks "Finish planning". The frontend reads it via
 *  `intakeReadDraft`, then applies it via `intakeApply` which validates
 *  the suggested template id against the current catalog. */
export interface IntakeProposal {
  dispatchPrompt: string;
  suggestedSwarmTemplateId?: string | null;
}

/** Spawn the intake conversation PTY for a card. Returns the pty_id; the
 *  frontend attaches an xterm bound to its `pty://data` events. */
// ── Builder session (v1.106.0) ────────────────────────

export interface BuilderStartResult {
  ptyId: string;
  card: KanbanCard;
}

export function builderStart(
  workspaceId: string,
  cardId: string,
  vendor: "claude" | "codex",
  bypass: boolean,
  /** UX P-C: ask for the guided first card's mode (Rust decides). */
  guided = false,
  /** 1.169.0 (A3): "Retry on…" — this start's model and effort, this once. */
  retry?: RetryChoice,
) {
  return invoke<BuilderStartResult>("builder_start", {
    workspaceId,
    cardId,
    vendor,
    bypass,
    guided,
    ...(retry ? { retry } : {}),
  });
}

// ── Card worktree setup (SL-4) ────────────────────────

/** `worktree_setup::WorktreeSettings`: what this Mac runs with. */
export interface WorktreeSettings {
  worktreeCopy?: string[] | null;
  worktreeSetup?: string | null;
  /** This Mac's answer to the one-time `.env` question; never shared. */
  envProposal?: "copy" | "dontCopy" | null;
  /** The setup command this Mac agreed to run; never shared. */
  approvedSetup?: string | null;
  /** Try it: the start command this Mac agreed to run; never shared. */
  approvedTry?: string | null;
}

export function worktreeSettingsGet(workspaceId: string) {
  return invoke<WorktreeSettings>("worktree_settings_get", { workspaceId });
}

/** Change `worktreeCopy` and/or `worktreeSetup`; an empty list or command
 *  clears it, an absent one is left alone. Published like every shared
 *  field when the workspace shares its definition. */
export function worktreeSettingsSet(
  workspaceId: string,
  change: { worktreeCopy?: string[]; worktreeSetup?: string },
) {
  return invoke<WorktreeSettings>("worktree_settings_set", {
    workspaceId,
    worktreeCopy: change.worktreeCopy ?? null,
    worktreeSetup: change.worktreeSetup ?? null,
  });
}

/** The git-ignored `.env*` files to offer before the card's first worktree
 *  is made; empty when there is nothing to ask. */
export function worktreeEnvProposal(workspaceId: string, cardId: string) {
  return invoke<string[]>("worktree_env_proposal", { workspaceId, cardId });
}

export function worktreeEnvProposalAnswer(workspaceId: string, copy: boolean, files: string[]) {
  return invoke<WorktreeSettings>("worktree_env_proposal_answer", { workspaceId, copy, files });
}

/** Retry: the setup again in the card's worktree. `allow` is "Allow and
 *  run": the command the card showed, allowed on this Mac first. SL-6:
 *  `lane: "b"` is the Codex build's worktree of a card built by both. */
export function cardWorktreeSetupRetry(
  workspaceId: string,
  cardId: string,
  allow?: string | null,
  lane?: BuildLaneId | null,
) {
  return invoke<KanbanCard>("card_worktree_setup_retry", {
    workspaceId,
    cardId,
    allow: allow ?? null,
    ...(lane ? { lane } : {}),
  });
}

/** Start anyway: the failed setup no longer holds the Builder back. */
export function cardWorktreeSetupSkip(workspaceId: string, cardId: string, lane?: BuildLaneId | null) {
  return invoke<KanbanCard>("card_worktree_setup_skip", { workspaceId, cardId, ...(lane ? { lane } : {}) });
}

// ── Build with both (SL-6) ────────────────────────────

/** Start Claude and Codex on the card, each in its own worktree. CL-8:
 *  `models` is each build's model, chosen at start for this card. */
export function buildBothStart(workspaceId: string, cardId: string, bypass: boolean, models?: BuildBothModels) {
  return invoke<KanbanCard>("build_both_start", { workspaceId, cardId, bypass, ...(models ? { models } : {}) });
}

/** CL-8: one build's changes (files, +/−, hunks) from the card's base. */
export function buildBothLaneDiff(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<LaneDiff>("build_both_lane_diff", { workspaceId, cardId, lane });
}

/** Start the builds a setup held back (after Retry / Start anyway). */
export function buildBothStartLanes(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("build_both_start_lanes", { workspaceId, cardId });
}

export function buildBothLaneResume(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<KanbanCard>("build_both_lane_resume", { workspaceId, cardId, lane });
}

/** v1.154.1 round 2 (walk J1): a new session of one build, brief sent again. */
export function buildBothLaneStartFresh(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<KanbanCard>("build_both_lane_start_fresh", { workspaceId, cardId, lane });
}

/** One build's Build done: its snapshot, then its checks. */
export function buildBothLaneDone(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<KanbanCard>("build_both_lane_done", { workspaceId, cardId, lane });
}

export function buildBothLaneStop(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<KanbanCard>("build_both_lane_stop", { workspaceId, cardId, lane });
}

export function buildBothCompareAgain(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("build_both_compare_again", { workspaceId, cardId });
}

/** The owner's pick: that build becomes the card's; the other is set aside. */
export function buildBothPick(workspaceId: string, cardId: string, lane: BuildLaneId) {
  return invoke<KanbanCard>("build_both_pick", { workspaceId, cardId, lane });
}

/** Stop building with both: the card keeps Claude's worktree, no Builder. */
export function buildBothStop(workspaceId: string, cardId: string) {
  return invoke<KanbanCard>("build_both_stop", { workspaceId, cardId });
}

export interface WorktreeSetupStarted {
  workspaceId: string;
  cardId: string;
  command: string | null;
}

export function onWorktreeSetupStarted(handler: (e: WorktreeSetupStarted) => void) {
  return listen<WorktreeSetupStarted>("worktree-setup://started", (e) => handler(e.payload));
}

export function builderResume(workspaceId: string, cardId: string) {
  return invoke<BuilderStartResult>("builder_resume", { workspaceId, cardId });
}

/** Result of Build done. `newSnapshot`: a newly recorded SHA. `reselected`:
 *  the tree went back to an earlier snapshot, which is current again (and
 *  re-reviewed/re-verified). Both false: the tree already is the current
 *  snapshot — nothing was recorded, reviewed or verified again. */
export interface BuildDone {
  snapshot: BuildSnapshot;
  newSnapshot: boolean;
  reselected: boolean;
  /** Unchanged tree + Skip review (or Accept the Builder's pushback): the
   *  changes-requested verdict on the current snapshot was overridden. */
  reviewOverridden: boolean;
  /** Unchanged tree and the changes-requested verdict still stands. */
  changesRequested: boolean;
  /** Unchanged tree: Verify already passed on this snapshot. */
  snapshotVerified: boolean;
  /** GH #124: the Challenger was still reviewing this card (this snapshot
   *  number, 0 when unknown), so the new snapshot is reviewed next. Absent
   *  or null when its review started or was skipped. */
  reviewWaitingOn?: number | null;
  /** GH #124: Skip review on an unchanged tree dropped the waiting review. */
  waitingDropped?: boolean;
  /** GH #124: an unchanged tree started the review left waiting with none
   *  running — this snapshot. */
  waitingStarted?: number | null;
}

export function builderDone(
  workspaceId: string,
  cardId: string,
  skipReview = false,
  selfCheck: SelfCheckRecord | null = null,
) {
  return invoke<BuildDone>("builder_done", {
    workspaceId,
    cardId,
    skipReview,
    selfCheck,
  });
}

/** ADR 0006 (third card): the self-check message Build done sends the
 *  Builder first, or null when none runs (the repository's switch is off,
 *  or nothing changed since the last snapshot). */
export function builderSelfCheckMessage(workspaceId: string, cardId: string, token: string) {
  return invoke<string | null>("builder_self_check_message", { workspaceId, cardId, token });
}

/** Record that the human accepted the Builder's pushback on the current
 *  snapshot's changes-requested verdict. Nothing is committed or re-run. */
/** Findings filter: "Not a real issue" — dismiss an open finding of the
 *  card's ledger, with an optional one-line reason. The card reloads on
 *  `kanban://changed`. */
export function reviewFindingDismiss(workspaceId: string, cardId: string, findingId: string, reason: string | null) {
  return invoke<void>("review_finding_dismiss", { workspaceId, cardId, findingId, reason });
}

export function builderAcceptPushback(workspaceId: string, cardId: string) {
  return invoke<BuildDone>("builder_accept_pushback", { workspaceId, cardId });
}

/** GH #58 "Review again in passes": re-run the Challenger on the current
 *  snapshot in smaller passes. Resolves with the snapshot number. */
export function builderReviewAgain(workspaceId: string, cardId: string) {
  return invoke<number>("builder_review_again", { workspaceId, cardId });
}

/** GH #135: the Builder received the verdict of the review that settled
 *  at `at` on `snapshotN`, so the card owes it no longer. Idempotent; a
 *  stale delivery (a newer review settled since) clears nothing. */
export function builderVerdictDelivered(
  workspaceId: string,
  cardId: string,
  snapshotN: number,
  at: number,
) {
  return invoke<void>("builder_verdict_delivered", { workspaceId, cardId, snapshotN, at });
}

export function builderClose(workspaceId: string, cardId: string) {
  return invoke<void>("builder_close", { workspaceId, cardId });
}

/** Skills hub H1 (R13): the library skills the session in `ptyId` was given
 * that changed upstream since it started. Empty when none did. */
export function sessionSkillDrift(ptyId: string) {
  return invoke<string[]>("session_skill_drift", { ptyId });
}

/** Skills hub H6a (R15): what the *Needs your OK* sheet shows for a team
 *  skill; null when it needs no OK any more. */
export function skillsHubScriptsReview(plugin: string, skill: string, library?: "mine") {
  return invoke<ScriptsReview | null>("skills_hub_scripts_review", { plugin, skill, library: library ?? null });
}

/** Skills hub H6a: OK for what the sheet showed, on this Mac only. Refused
 *  when the library moved to other scripts meanwhile. */
export function skillsHubApprove(plugin: string, skill: string, commit: string, scriptsIds: string[], library?: "mine") {
  return invoke<void>("skills_hub_approve", { plugin, skill, commit, scriptsIds, library: library ?? null });
}

// ── Skills hub H10: My library (`my_library.rs`) ─────────────────────

/** One gh account the create sheet can choose. */
export interface MyLibraryAccount {
  login: string;
  active: boolean;
}

/** My library on this computer (`my_library::MyLibraryView`). */
export interface MyLibraryView {
  /** `owner/name`; null: this computer uses none. */
  repo: string | null;
  account: string | null;
  hasClone: boolean;
  lastPullAt: number | null;
  lastAttemptAt: number | null;
  /** `offline` · `gone` · `held` · `failed`. */
  lastError: string | null;
  goneAt: number | null;
  defaultName: string;
  /** Signed-in gh accounts, when no My library is set here. */
  accounts: MyLibraryAccount[];
  /** The plugin sessions get it as: `mine`, or `mine-<login>`. */
  plugin: string;
}

export function myLibraryStatus() {
  return invoke<MyLibraryView>("my_library_status");
}

/** A second computer: `<login>/plyloft-skills` when it is a My library. */
export function myLibraryFind(account: string | null) {
  return invoke<string | null>("my_library_find", { account });
}

export function myLibraryCreate(name: string, account: string | null, seed: string[]) {
  return invoke<MyLibraryView>("my_library_create", { name, account, seed });
}

/** *Use it on this Mac* and *Point to another repository…*. */
export function myLibraryUse(repo: string, account: string | null) {
  return invoke<MyLibraryView>("my_library_use", { repo, account });
}

/** *Stop using it on this Mac* (after the confirm). */
export function myLibraryForget() {
  return invoke<MyLibraryView>("my_library_forget");
}

/** *Create it again* (the repository is gone). */
export function myLibraryRecreate() {
  return invoke<MyLibraryView>("my_library_recreate");
}

export function myLibraryPullNow() {
  return invoke<MyLibraryView>("my_library_pull_now");
}

/** Where *Add to My library* takes the skill from. */
export type MyLibrarySource =
  | { kind: "thisMac"; skill: string }
  | { kind: "repository"; workspaceId: string; skill: string };

/** The two-computer compare (`my_library::MyCompare`). */
export interface MyLibraryCompare {
  skill: string;
  otherId: string;
  otherAuthor: string | null;
  otherAt: number | null;
  twoWay: boolean;
  files: Compare3File[];
}

export function myLibraryPublish(
  source: MyLibrarySource,
  choice?: "keepThis" | "keepOther",
  expected?: string,
) {
  return invoke<MyLibraryPublished>("my_library_publish", {
    source,
    choice: choice ?? null,
    expected: expected ?? null,
  });
}

/** Skills hub H6b (R15): the Install-time sheet — every file Install
 *  (`plugin:skill` of the team library) or Update (this repository's linked
 *  `skill`) would write, when it brings a script or an extra file the
 *  repository doesn't hold yet. `null`: nothing to ask, go ahead. */
export function skillsHubInstallReview(
  workspaceId: string,
  plugin: string,
  skill: string,
  verb: "install" | "update",
  /** Skills hub H10: Install from My library. */
  library?: "mine",
) {
  return invoke<ScriptsReview | null>("skills_hub_install_review", {
    workspaceId,
    plugin,
    skill,
    verb,
    ...(library ? { library } : {}),
  });
}

// ── Skills hub H8: Copy to… (`commands::skills_hub_copy`) ─────────────

/** What Copy to… copies (`skills_hub_copy::CopyFrom`). */
export type CopyFrom =
  | { kind: "workspace"; workspaceId: string; skill: string }
  | { kind: "team"; plugin: string; skill: string }
  | { kind: "thisMac"; skill: string };

/** What a copy would do in one workspace (`skill_copy::Target`). */
export type CopyTargetState =
  | { kind: "ready" }
  | { kind: "sameContent" }
  | { kind: "replace" }
  /** H8 Challenger: it already holds exactly the copy and the link is kept
   *  on this Mac only — linked at once, no card. */
  | { kind: "linkHere" }
  | { kind: "refused"; why: string };

export interface CopyTarget {
  workspaceId: string;
  name: string;
  repo: string | null;
  target: CopyTargetState;
}

export interface CopyTargets {
  skill: string;
  /** "astra", "your own skills", "the team library". */
  fromWords: string;
  claude: boolean;
  codex: boolean;
  /** The title each card gets. */
  cardTitle: string;
  /** Why the link is kept on this Mac only, when it is. */
  localReason: string | null;
  /** The origin's checkout has changes that aren't committed. */
  uncommittedNote: string | null;
  targets: CopyTarget[];
}

export interface CopyMade {
  cards: { workspaceId: string; name: string; card: KanbanCard }[];
  refused: { workspaceId: string; name: string; why: string }[];
  /** H8 Challenger: linked on this Mac at once, with no card. Absent from
   *  an older backend. */
  linked?: { workspaceId: string; name: string }[];
}

/** Skills hub H8 (R5): the destination picker — every other workspace on
 *  this Mac, warm or cold, and what a copy there would do. Read-only. */
export function skillsHubCopyTargets(from: CopyFrom) {
  return invoke<CopyTargets>("skills_hub_copy_targets", { from });
}

/** H8: H6b's sheet for what the copy brings; `null` when nothing asks. */
export function skillsHubCopyReview(from: CopyFrom) {
  return invoke<ScriptsReview | null>("skills_hub_copy_review", { from });
}

/** H8 (R5): one skill card per workspace picked; `replace` names those
 *  whose different copy of the same name the member chose to replace. */
export function skillsHubCopyTo(from: CopyFrom, workspaceIds: string[], replace: string[], scriptsOk?: string[]) {
  return invoke<CopyMade>("skills_hub_copy_to", {
    from,
    workspaceIds,
    replace,
    ...(scriptsOk ? { scriptsOk } : {}),
  });
}

/** Skills hub H2 (`skills_hub::LibraryPullView`): the team library's pull
 *  record on this Mac — "Updated 4 min ago", access lost, left the team. */
export interface LibraryPullView {
  library: string;
  repo: string;
  teamName: string | null;
  hasClone: boolean;
  /** Unix ms of the last pull that went through. */
  lastPullAt: number | null;
  /** The commit the last pull brought (the Library reads its rows again when it moves). */
  lastPullCommit: string | null;
  lastAttemptAt: number | null;
  /** Why the last attempt did not go through. */
  lastError: "offline" | "noAccess" | "failed" | "held" | null;
  /** Why no background pull runs: the team gate refuses. */
  heldBack: "plan" | null;
  switchedOff: boolean;
  /** Unix ms when Plyloft concluded GitHub no longer lets this account read it. */
  accessLost: number | null;
  keptLastCopy: boolean;
  /** Unix ms when this Mac found it is no longer in the team. */
  leftAt: number | null;
  /** Why the clone stayed on this Mac after leaving. */
  cloneKept: string | null;
  /** The account GitHub last confirmed as a member here. */
  login: string | null;
}

// ── Skills hub H7: All skills (`skills_index`) ───────────────────────

/** `skills_index::IndexRow`: one skill at one place — facts only; Used in,
 *  the filters and the counts are joins in `lib/allSkills.ts`. */
export interface HubIndexRow {
  name: string;
  description: string;
  codexName?: string | null;
  plugin?: string | null;
  claude: boolean;
  codex: boolean;
  /** Each twin's content id (the git tree id of its directory). */
  claudeId: string | null;
  codexId: string | null;
  twinsDiffer: boolean;
  legacyCodex: boolean;
  dir: string;
  /** Newest modification time of its files, Unix ms. */
  changedAt: number | null;
  tooManyFiles: boolean;
  link?: HubIndexLink | null;
  needsOk: boolean;
  offHere: boolean;
  /** H10 (§8): a library skill whose paths are too long for Windows on this
   *  computer; sessions here don't get it. Absent from older caches. */
  tooLongHere?: boolean;
  /** Only a shared workspace's mirror of its branch has it: not in this
   *  checkout. Absent from a cache written before it. */
  branchOnly?: boolean;
}

export interface HubIndexLink {
  originKind: string;
  originWords: string;
  source: string;
  plugin: string | null;
  name: string;
  state: SkillLinkState | null;
  /** Skills hub H8: kept on this Mac only. Absent from an older cache. */
  local?: boolean;
  /** H8: a local link's origin workspace. */
  originWorkspace?: string | null;
}

export interface HubIndexWorkspace {
  id: string;
  name: string;
  path: string;
  /** "missing": the folder isn't there; its last rows are kept. */
  state: "ok" | "missing";
  source: "checkout" | "branch" | "checkoutShared";
  repo: string | null;
  /** A shared workspace's integration branch (its mirror's manifest). */
  branch?: string | null;
  readAt: number | null;
  rows: HubIndexRow[];
}

export interface HubIndexSource {
  repo: string | null;
  readAt: number | null;
  rows: HubIndexRow[];
  problem: string | null;
}

export interface HubIndex {
  schemaVersion: number;
  builtAt: number | null;
  workspaces: HubIndexWorkspace[];
  team: HubIndexSource | null;
  /** Skills hub H10: My library, when this Mac uses one (absent in a cache
   *  written before H10). */
  myLibrary?: HubIndexSource | null;
  thisMac: HubIndexSource | null;
  plyloft: HubIndexSource | null;
}

export interface HubIndexView {
  index: HubIndex;
  refreshing: boolean;
  reading: string[];
}

/** One message of the index's stream (`skills-hub://index`). */
export type HubIndexEvent =
  | { kind: "started"; workspaceIds: string[]; whole: boolean }
  | { kind: "workspace"; workspace: HubIndexWorkspace }
  | { kind: "team"; source: HubIndexSource | null }
  | { kind: "myLibrary"; source: HubIndexSource | null }
  | { kind: "thisMac"; source: HubIndexSource }
  | { kind: "plyloft"; source: HubIndexSource }
  | { kind: "done"; builtAt: number | null; workspaceIds: string[] };

/** The cached index at once; `refresh` reads everything again behind it. */
export function skillsHubIndex(refresh = false) {
  return invoke<HubIndexView>("skills_hub_index", { refresh });
}

/** Read these workspaces again (a skill root changed), or everything; with
 *  `libraries`, the team library, this Mac's and Plyloft's too. */
export function skillsHubIndexRefresh(workspaceIds?: string[], libraries = false) {
  return invoke<void>("skills_hub_index_refresh", { workspaceIds: workspaceIds ?? null, libraries });
}

export function onSkillsHubIndex(handler: (event: HubIndexEvent) => void): Promise<UnlistenFn> {
  return listen<HubIndexEvent>("skills-hub://index", (event) => handler(event.payload));
}

export function skillsHubLibraryStatus() {
  return invoke<LibraryPullView | null>("skills_hub_library_status");
}

/** R16: `on: false` is *Switch it off on this Mac*; `true` switches it back on. */
export function skillsHubLibrarySwitch(on: boolean) {
  return invoke<LibraryPullView | null>("skills_hub_library_switch", { on });
}

/** R16: *Keep the last copy*. */
export function skillsHubKeepLastCopy() {
  return invoke<LibraryPullView | null>("skills_hub_keep_last_copy");
}

/** One skill a background pull changed, and who changed it (newest first). */
export interface SkillChange {
  skill: string;
  authors: string[];
}

export interface SkillsHubPulled {
  library: string;
  teamName: string | null;
  changes: SkillChange[];
}

/** Skills hub H2: a pull brought changes by someone else (the toast). */
export function onSkillsHubPulled(handler: (pulled: SkillsHubPulled) => void): Promise<UnlistenFn> {
  return listen<SkillsHubPulled>("skills-hub://pulled", (event) => handler(event.payload));
}

/** Skills hub H2: the team library's pull record changed. */
export function onSkillsHubLibrary(handler: () => void): Promise<UnlistenFn> {
  return listen<unknown>("skills-hub://library", () => handler());
}

export function builderSessionEnded(
  workspaceId: string,
  cardId: string,
  ptyId: string,
) {
  return invoke<void>("builder_session_ended", { workspaceId, cardId, ptyId });
}

export function cardPlanChallengeSet(
  workspaceId: string,
  cardId: string,
  discussionId: string,
  decisions: PlanDecision[],
) {
  return invoke<KanbanCard>("card_plan_challenge_set", {
    workspaceId,
    cardId,
    discussionId,
    decisions,
  });
}

export function cardPlanChallengeClear(workspaceId: string, cardId: string) {
  return invoke<void>("card_plan_challenge_clear", { workspaceId, cardId });
}

/** v1.109.0: the brief as the Plan challenge sees it — mirrors
 *  `kanban::card_brief_text` so a stale challenge is detected the same way. */
export function cardBriefText(card: Pick<KanbanCard, "title" | "notes" | "dispatchPrompt">): string {
  const p = card.dispatchPrompt?.trim();
  if (p) return p;
  const parts = [card.title.trim()];
  const n = card.notes?.trim();
  if (n) parts.push(n);
  return parts.join("\n\n");
}

/** ADR 0006 (third card): when the card's Builder session last printed
 *  (ms), stamped by the PTY reader with or without a terminal attached;
 *  null without a live session. */
export function builderLastOutputAt(cardId: string) {
  return invoke<number | null>("builder_last_output_at", { cardId });
}

/** UX P-F (was `TrustQuestion`, v1.154.1 walk G1): a live Builder session
 *  stopped where only the person can move it on — its CLI's folder-trust
 *  question, Claude's Bypass Permissions warning, or Claude's usage limit
 *  (`builder::session_blocks`). `key` is the session's (`<card>`, or SL-6's
 *  `<card>#both-a|b`). */
export type SessionBlock = {
  key: string;
  workspaceId: string;
  vendor: "claude" | "codex";
  /** N14 walk F10: the card's intake conversation asks, not its Builder
   *  (`key` is the card). Always the trust question. */
  intake?: boolean;
  kind: "trust" | "bypass" | "usageLimit";
  /** A usage limit's reset time as Claude wrote it ("3pm"), when it did. */
  resetsAt?: string;
};

export function builderSessionBlocks() {
  return invoke<SessionBlock[]>("builder_session_blocks");
}

/** N14 walk F14: the cards whose intake conversation ended (its PTY
 *  exited) while they still read as planning, and (Challenger P3-4) those
 *  whose intake is live. */
export type IntakeSessionsReport = { ended: string[]; live: string[] };

export function intakeEndedCards() {
  return invoke<IntakeSessionsReport>("intake_ended_cards");
}

/** The Builder session's captured output (tail) and the stream offset it
 *  ends at, for `lib/builderAttach.ts` to join with the live events. */
export async function builderReadCapture(
  cardId: string,
): Promise<{ data: Uint8Array; end: number } | null> {
  const raw = await invoke<ArrayBuffer | Uint8Array>("builder_read_capture", { cardId });
  return decodeCaptureReplay(raw);
}

/** `builder_read_capture`'s raw body (`CaptureReplay::encode`): `end` as 8
 *  bytes little-endian, then the captured bytes; empty = no live session. */
export function decodeCaptureReplay(
  raw: ArrayBuffer | Uint8Array | null | undefined,
): { data: Uint8Array; end: number } | null {
  if (!raw) return null;
  const body = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (body.byteLength < 8) return null;
  const end = Number(new DataView(body.buffer, body.byteOffset, 8).getBigUint64(0, true));
  return { data: body.subarray(8), end };
}

export function intakeStart(opts: {
  workspaceId: string;
  cardId: string;
  workspaceCwd: string;
}) {
  return invoke<string>("intake_start", {
    workspaceId: opts.workspaceId,
    cardId: opts.cardId,
    workspaceCwd: opts.workspaceCwd,
  });
}

/** Send the conclude sentinel to the intake PTY. The agent reacts by
 *  writing its JSON proposal to the draft path; the FE polls until it
 *  appears (or times out) and then calls `intakeApply`. */
export function intakeConclude(cardId: string) {
  return invoke<void>("intake_conclude", { cardId });
}

/** Kill the intake PTY, delete any partial draft, and clear the registry
 *  entry. Idempotent. */
export function intakeCancel(workspaceId: string, cardId: string, opts?: { replanned?: boolean }) {
  // N14 walk F20: Plan again records the ended conversation as replanned.
  return invoke<void>("intake_cancel", { workspaceId, cardId, replanned: opts?.replanned ?? false });
}

/** Read the agent's proposal for a card. Returns `null` when the draft
 *  doesn't exist yet. Surfaces parse errors as rejected promises. */
export function intakeReadDraft(workspaceId: string, cardId: string) {
  return invoke<IntakeProposal | null>("intake_read_draft", {
    workspaceId,
    cardId,
  });
}

/** Validate + commit the agent's proposal (drops unknown
 *  `suggestedSwarmTemplateId` values). Kills the PTY, deletes the draft.
 *  Returns the validated proposal so the FE can show what landed. */
export function intakeApply(workspaceId: string, cardId: string) {
  return invoke<IntakeProposal>("intake_apply", { workspaceId, cardId });
}

/** v1.19.0 (Cycle E4): one record per intake session ever opened on a
 *  card. Appended to `KanbanCard.intakeHistory` by intakeApply
 *  (applied=true) or intakeCancel (applied=false). FIFO cap = 10;
 *  evicting an entry deletes its transcript file. */
export interface IntakeRecord {
  intakeId: string;
  startedAt: number;
  concludedAt?: number | null;
  dispatchPrompt?: string | null;
  /** Path relative to `<config_dir>` (e.g.
   *  `intake/transcripts/<wsId>/<cardId>/<intakeId>.log`). Pass to
   *  `intakeReadTranscript` to fetch the body. */
  transcriptPath?: string | null;
  applied: boolean;
  /** OB-14 (§13.3): who held the conversation; absent on records before
   *  OB-14, which were all Claude. */
  vendor?: "claude" | "codex" | null;
  /** N14 walk F20: ended by Plan again, which started a new conversation
   *  at once; the Activity says "Planned again". Absent before it. */
  replanned?: boolean;
  /** Plan with two AIs: the plan came from an exchange; `vendor` is then
   *  the proposer (the critic may be the same vendor: owner Q5). */
  twoAis?: { critic: "claude" | "codex"; rounds: number; exchangeId: string } | null;
}

/** v1.19.0 (Cycle E4): read a persisted intake transcript by relative
 *  path. Returns null when the file is missing (FIFO-evicted or never
 *  written). The transcript is already ANSI-stripped at write time. */
export function intakeReadTranscript(relativePath: string) {
  return invoke<string | null>("intake_read_transcript", { relativePath });
}

// GH #171: the intake system-prompt editor (get / set / reset) went with
// Settings › Agents. An override already written is still what intake reads.

// ── Prompts library (v0.8.0) ───────────────────────────

/** v1.50.0 (Team Mode Phase 2): runtime-only scope tag on library items.
 *  `personal` = read from the user's app-support library (the v0.8.0
 *  default location). `shared` = read from the active workspace's
 *  `<cwd>/.atelier/library/<file>.json` — i.e. committed to the project
 *  repo and visible to every teammate who opens the same workspace.
 *  Never persisted on disk; the loader sets it based on which layer
 *  produced the entry. */
export type LibraryScope = "personal" | "shared";

export interface Prompt {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  promptTemplate: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** v1.49.0 (Team Mode Phase 0): see AgentConfig docs. */
  author?: string | null;
  lastEditedBy?: string | null;
  /** v1.50.0 (Team Mode Phase 2): which layer this prompt was read
   *  from. Defaults to `"personal"` if absent (older backend or
   *  legacy callers that don't pass project_cwd). */
  scope?: LibraryScope;
}

/** v1.50.0 (Team Mode Phase 2): pass `projectCwd` to additively merge
 *  `<cwd>/.atelier/library/prompts.json` (tagged `scope: "shared"`)
 *  into the result. Omit for personal-only (the pre-v1.50 behavior).
 *  Shared-id collisions resolve in favor of the shared entry. */
export function promptsList(projectCwd?: string | null) {
  return invoke<Prompt[]>("prompts_list", { projectCwd: projectCwd ?? null });
}

export function promptsCreate(prompt: Prompt) {
  return invoke<Prompt>("prompts_create", { prompt });
}

export function promptsUpdate(prompt: Prompt) {
  return invoke<Prompt>("prompts_update", { prompt });
}

export function promptsDelete(id: string) {
  return invoke<void>("prompts_delete", { id });
}

/** v1.52.0 (Team Mode Phase 2.3): move a personal prompt into
 *  `<projectCwd>/.atelier/library/prompts.json`. Returns the promoted
 *  prompt with `scope: "shared"`. */
export function promptsPromote(projectCwd: string, id: string) {
  return invoke<Prompt>("prompts_promote", { projectCwd, id });
}

/** v1.52.0: inverse of `promptsPromote`. Removes the entry from the
 *  shared file and writes it into the personal layer. */
export function promptsDemote(projectCwd: string, id: string) {
  return invoke<Prompt>("prompts_demote", { projectCwd, id });
}

/** v1.52.0: copy a shared prompt into a personal entry with a fresh id
 *  and the current user's email stamped as `author`. The shared entry
 *  is left untouched. */
export function promptsFork(projectCwd: string, id: string) {
  return invoke<Prompt>("prompts_fork", { projectCwd, id });
}

// ── Memory (v1.35.0) ───────────────────────────────────
//
// Per-workspace + opt-in global persistent learnings. Markdown bodies
// with YAML frontmatter on disk. CRUD-only in v1.35.0 (Increment 1);
// dispatch-time injection lands in v1.36.0 (Increment 2) and post-ship
// suggestion in v1.37.0 (Increment 3).

export type MemoryScope = "workspace" | "global";

/** v1.115.0 (team sharing rung 2): which home an entry was read out of.
 *  `project` is the repo's committed layer (relabelled from "Team" — the
 *  path did not change); `team` is the team library in the team repo. */
export type KnowledgeLayer = "personal" | "project" | "team";

export type MemorySource =
  | { kind: "manual" }
  | { kind: "suggested"; runId?: string | null; cardId?: string | null };

/** v1.68.0 (UX revamp step 3b — Knowledge merge): entry kind. `note` is
 *  the classic memory and the default; `prompt` carries the optional
 *  systemPrompt/promptTemplate payload (migrated personal prompts). */
export type KnowledgeType = "note" | "prompt";

export type EvidenceAttribution =
  | "isolated_card"
  | "legacy_checkout"
  | "shared_batch";

export interface ChangedPathEvidence {
  path: string;
  oldPath?: string | null;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type_changed"
    | "unmerged"
    | "unknown";
  lossy: boolean;
}

export interface DiffEvidence {
  baseRevision: string;
  headRevision: string;
  range: string;
  sha256: string;
  byteCount: number;
  stat: {
    filesChanged: number;
    insertions: number;
    deletions: number;
    raw: string;
  };
  changedPaths: ChangedPathEvidence[];
  changedPathCount: number;
  pathsTruncated: boolean;
  excerpt?: string | null;
  excerptSameAs?: string | null;
  excerptByteCount: number;
  excerptTruncated: boolean;
}

export interface KnowledgeEvidenceEnvelope {
  schemaVersion: number;
  proposalId: string;
  suggestionId?: string | null;
  capturedAt: number;
  provenanceKind: string;
  ship: {
    commitSha: string;
    parentRevision?: string | null;
    releaseKind: string;
    shippedVersion?: string | null;
    shippedAt: number;
    attribution: EvidenceAttribution;
    batchCardIds: string[];
  };
  source: {
    targetRef?: string | null;
    baseRevision: string;
    headRevision: string;
  };
  changeDiff: DiffEvidence;
  landedDiff: DiffEvidence;
  verificationArtifacts: Array<{
    verifyRunId: string;
    status: string;
    endedAt: number;
    summary?: string | null;
    steps: Array<{
      kind: string;
      passed: boolean;
      elapsedMs: number;
      reason?: string | null;
    }>;
    skipped: boolean;
    revisionBinding: "exact" | "pre_ship_unbound" | "legacy" | "unknown";
  }>;
  reviewerArtifacts: Array<{
    reviewId: string;
    provider: string;
    providerVersion: string;
    capability: string;
    baseRevision: string;
    headRevision: string;
    status: string;
    verdict?: string | null;
    summary?: string | null;
    artifact?: unknown;
    artifactSha256: string;
    artifactByteCount: number;
    artifactTruncated: boolean;
    stale: boolean;
    writeEscaped: boolean;
    excludedDirtyPaths: string[];
  }>;
  discussionArtifacts: Array<{
    discussionId: string;
    participantVersions: string[];
    synthesizer: string;
    pinnedRevision: string;
    completedAt: number;
    stale: boolean;
    resultSha256: string;
    resultExcerpt?: unknown;
    synthesisSummary?: string | null;
    disagreementCount: number;
    unresolved: Array<{ id: string; statement: string }>;
  }>;
  handoffArtifacts: Array<{
    handoffId: string;
    runId?: string | null;
    cardId?: string | null;
    swarmId?: string | null;
    status: string;
    createdAt: number;
  }>;
  ids: {
    cardIds: string[];
    cardIdCount: number;
    cardIdsSha256: string;
    cardIdsTruncated: boolean;
    runIds: string[];
    runIdCount: number;
    runIdsSha256: string;
    runIdsTruncated: boolean;
    swarmIds: string[];
    swarmIdCount: number;
    swarmIdsSha256: string;
    swarmIdsTruncated: boolean;
    sessionIds: string[];
    sessionIdCount: number;
    sessionIdsSha256: string;
    sessionIdsTruncated: boolean;
  };
}

export interface Memory {
  id: string;
  slug: string;
  title: string;
  scope: MemoryScope;
  /** Present iff `scope === "workspace"`. */
  workspaceId?: string | null;
  tags: string[];
  linkedCards: string[];
  source: MemorySource;
  /** v1.68.0: note (default) or prompt. */
  entryType?: KnowledgeType;
  systemPrompt?: string | null;
  promptTemplate?: string | null;
  /** v1.72.0 (step 5b-2): true iff the entry lives in a shared layer.
   *  Kept for every caller written before the Team layer existed; `layer`
   *  is the field that tells Project from Team. */
  shared?: boolean;
  /** v1.115.0: `personal` | `project` | `team`. Absent on an entry a
   *  pre-v1.115.0 backend produced. */
  layer?: KnowledgeLayer;
  /** Phase 6: mechanically captured ship provenance. Immutable through
   * ordinary Knowledge editing and optional for legacy/manual entries. */
  evidence?: KnowledgeEvidenceEnvelope | null;
  body: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
}

export interface MemoryCreateInput {
  title: string;
  body: string;
  scope: MemoryScope;
  /** Required when scope is "workspace"; omit/null for "global". */
  workspaceId?: string | null;
  tags?: string[];
  linkedCards?: string[];
  /** Defaults server-side to `{ kind: "manual" }`. */
  source?: MemorySource;
  /** v1.68.0: defaults server-side to "note". */
  entryType?: KnowledgeType;
  systemPrompt?: string | null;
  promptTemplate?: string | null;
}

/** PATCH semantics: absent key = untouched; explicit `null` = clear;
 *  value = set. Matches the kanban CardPatch convention. */
export interface MemoryPatch {
  title?: string | null;
  body?: string | null;
  tags?: string[] | null;
  linkedCards?: string[] | null;
}

function memoryArgs(scope: MemoryScope, workspaceId: string | null | undefined) {
  return { scope, workspaceId: workspaceId ?? null };
}

export function memoryList(scope: MemoryScope, workspaceId: string | null) {
  return invoke<Memory[]>("memory_list", memoryArgs(scope, workspaceId));
}

export function memoryGet(
  scope: MemoryScope,
  workspaceId: string | null,
  id: string,
) {
  return invoke<Memory | null>("memory_get", {
    ...memoryArgs(scope, workspaceId),
    id,
  });
}

export function memoryCreate(input: MemoryCreateInput) {
  return invoke<Memory>("memory_create", { input });
}

export function memoryUpdate(
  scope: MemoryScope,
  workspaceId: string | null,
  id: string,
  patch: MemoryPatch,
) {
  return invoke<Memory>("memory_update", {
    ...memoryArgs(scope, workspaceId),
    id,
    patch,
  });
}

export function memoryDelete(
  scope: MemoryScope,
  workspaceId: string | null,
  id: string,
) {
  return invoke<void>("memory_delete", {
    ...memoryArgs(scope, workspaceId),
    id,
  });
}

export function memorySearch(
  scope: MemoryScope,
  workspaceId: string | null,
  query: string,
  limit?: number,
) {
  return invoke<Memory[]>("memory_search", {
    ...memoryArgs(scope, workspaceId),
    query,
    limit: limit ?? null,
  });
}

// ── Project Knowledge scope (v1.72.0 — step 5b-2) ──────────────────
// Shared inside one repository: `<cwd>/.atelier/library/knowledge/*.md`,
// reaching teammates via that repo's own git history. v1.115.0 relabelled
// this layer Team → **Project** and renamed these commands with it; the
// on-disk path is untouched and nothing migrated.

export function knowledgeListProject(projectCwd: string) {
  return invoke<Memory[]>("knowledge_list_project", { projectCwd });
}

export function knowledgePromoteProject(
  projectCwd: string,
  id: string,
  workspaceId?: string | null,
) {
  return invoke<Memory>("knowledge_promote_project", {
    projectCwd,
    id,
    workspaceId: workspaceId ?? null,
  });
}

export function knowledgeDemoteProject(projectCwd: string, id: string) {
  return invoke<Memory>("knowledge_demote_project", { projectCwd, id });
}

export function knowledgeForkProject(projectCwd: string, id: string) {
  return invoke<Memory>("knowledge_fork_project", { projectCwd, id });
}

// ── Team Knowledge scope (v1.115.0 — team sharing rung 2) ──────────
// Shared everywhere: `library/knowledge/` in the team repo, cloned at
// `<app-support>/team/<slug>/`. Every write pulls, commits and pushes
// through `team.rs`, so a conflict is a real answer, not a silent retry.

export interface TeamKnowledgeView {
  /** A key naming a team repo is present on this Mac. */
  configured: boolean;
  /** The team repo is cloned here. */
  hasClone: boolean;
  /** Why the list is empty, when it is empty for a reason. */
  reason: string | null;
  /** Writing into the team library needs a valid key; reading does not. */
  canShare: boolean;
  entries: Memory[];
}

/** Where a Share/Promote into the team library takes the entry from. */
export type TeamPromoteSource = "workspace" | "global" | "project";

export function knowledgeListTeam() {
  return invoke<TeamKnowledgeView>("knowledge_list_team");
}

export interface TeamPromoteOutcome {
  /** The entry as it now sits in the team library. */
  entry: Memory;
  /** Set when Ply deliberately did not remove the source, and why — e.g.
   *  the entry was edited while the push was in flight. */
  note: string | null;
}

export function knowledgePromoteTeam(
  source: TeamPromoteSource,
  id: string,
  options?: { workspaceId?: string | null; projectCwd?: string | null },
) {
  return invoke<TeamPromoteOutcome>("knowledge_promote_team", {
    source,
    id,
    workspaceId: options?.workspaceId ?? null,
    projectCwd: options?.projectCwd ?? null,
  });
}

export function knowledgeDemoteTeam(id: string) {
  return invoke<Memory>("knowledge_demote_team", { id });
}

export function knowledgeForkTeam(id: string) {
  return invoke<Memory>("knowledge_fork_team", { id });
}

/** v1.36.0 (memory Increment 2): backend-composed dispatch prompt for
 *  a card. Single source of truth — combines intake-finalized
 *  `dispatchPrompt` (or title+notes+knowledge concat) + attachments +
 *  the workspace memory injection block. The FE calls this instead of
 *  assembling the prompt locally; both card-driven swarm dispatches
 *  and single-agent card dispatches send the returned string to the
 *  backend run/swarm-start IPCs. */
export function cardComposeDispatchPrompt(workspaceId: string, cardId: string) {
  return invoke<string>("card_compose_dispatch_prompt", { workspaceId, cardId });
}

// GH #104 (ADR 0005): the post-ship lesson proposal's types, commands and
// events are retired. Its files are left on disk in `memory/proposals`, unread.
// What replaces it is the Challenger's improvement proposal, above.
// ── User-defined workspace templates (v0.8.0) ──────────

export type UserTileSeedKind = "shell" | "claude";

export interface UserTileSeed {
  kind: UserTileSeedKind;
}

export interface UserTemplate {
  id: string;
  label: string;
  description: string;
  tiles: UserTileSeed[];
  createdAt: number;
  updatedAt: number;
  /** v1.49.0 (Team Mode Phase 0): see AgentConfig docs. */
  author?: string | null;
  lastEditedBy?: string | null;
  /** v1.51.0 (Team Mode Phase 2.2): runtime-only scope tag. See
   *  `Prompt.scope` for the contract. */
  scope?: LibraryScope;
}

/** v1.51.0 (Team Mode Phase 2.2): pass `projectCwd` to additively merge
 *  `<cwd>/.atelier/library/templates.json` (tagged `scope: "shared"`)
 *  into the result. Omit for personal-only. */
export function templatesList(projectCwd?: string | null) {
  return invoke<UserTemplate[]>("templates_list", {
    projectCwd: projectCwd ?? null,
  });
}

export function templatesCreate(template: UserTemplate) {
  return invoke<UserTemplate>("templates_create", { template });
}

export function templatesUpdate(template: UserTemplate) {
  return invoke<UserTemplate>("templates_update", { template });
}

export function templatesDelete(id: string) {
  return invoke<void>("templates_delete", { id });
}

/** v1.52.0 lifecycle for user (workspace-layout) templates. See
 *  `promptsPromote` family for the contract. */
export function templatesPromote(projectCwd: string, id: string) {
  return invoke<UserTemplate>("templates_promote", { projectCwd, id });
}
export function templatesDemote(projectCwd: string, id: string) {
  return invoke<UserTemplate>("templates_demote", { projectCwd, id });
}
export function templatesFork(projectCwd: string, id: string) {
  return invoke<UserTemplate>("templates_fork", { projectCwd, id });
}

// ── Swarm templates + role library (v1.2.0) ────────────

export interface SwarmTemplateRoleStep {
  role: string;
  expectsArtifact: boolean;
  /** Step index to jump to on `verdict: "reject"`. null = terminal step. */
  onRejectJumpTo: number | null;
  /** v1.21.0 (Phase 3): which provider runs this step. Undefined / omitted
   * means claude (the v1.x default); `"codex"` dispatches via `codex exec
   * --json`. Loader is permissive; dispatch rejects unknown values. */
  provider?: string;
}

export interface SwarmTemplate {
  schemaVersion: number;
  id: string;
  label: string;
  description: string;
  steps: SwarmTemplateRoleStep[];
  maxIterations: number;
  maxWallSeconds: number;
  /** True for the 4 ships-with templates (feature/refactor/ux-audit/bugfix). */
  builtin: boolean;
  /** v1.3.0+: coordinator-mode templates dispatch a role pool rather than a
   * sequential chain. Present on every current Rust response. */
  coordinator: boolean;
  /** v1.38.0+: whether the template produces code or a text Recon result. */
  outputKind: "code" | "recon";
  createdAt: number;
  updatedAt: number;
  /** v1.49.0 (Team Mode Phase 0): builtins carry `"atelier"`; custom
   *  templates carry the cached identity email of the creator (stable
   *  across edits) and the most recent editor. */
  author?: string | null;
  lastEditedBy?: string | null;
  /** v1.51.0 (Team Mode Phase 2.2): runtime-only scope tag. Builtins
   *  stay `"personal"` (they ship in-binary); custom templates land
   *  with whichever layer produced them. See `Prompt.scope` for the
   *  contract. */
  scope?: LibraryScope;
}

/** v1.51.0 (Team Mode Phase 2.2): pass `projectCwd` to additively merge
 *  `<cwd>/.atelier/library/swarm_templates.json` (tagged
 *  `scope: "shared"`) into the result. Builtins always come back
 *  tagged `"personal"` since they ship in-binary. */
export function swarmTemplatesList(projectCwd?: string | null) {
  return invoke<SwarmTemplate[]>("swarm_templates_list", {
    projectCwd: projectCwd ?? null,
  });
}

export function swarmTemplatesGet(id: string) {
  return invoke<SwarmTemplate | null>("swarm_templates_get", { id });
}

// GH #171: create / update / delete / fork / promote / demote went with
// Settings › Swarm templates, their only caller. Templates are still listed
// (above) for the card picker, Brainstorm and a swarm run's view.

/** v1.53.0 (Team Mode Phase 2.4): one role referenced by a swarm
 *  template that's not yet bound to an agent on the current user's
 *  machine. `suggestedAgentId` is sourced from
 *  `<projectCwd>/.atelier/agents/` when present — null when no
 *  obvious candidate exists. */
export interface UnboundRole {
  role: string;
  suggestedAgentId: string | null;
  suggestedAgentName: string | null;
}

/** v1.53.0: pre-dispatch preflight that returns every role in
 *  `templateId` that `workspaceId` hasn't bound yet. The FE calls
 *  this before kicking off a swarm and blocks dispatch (with a
 *  helpful toast naming the missing roles) if the list is non-empty.
 *  Returns empty when every role is bound. Resolves suggestions
 *  from `.atelier/agents/` when `projectCwd` is supplied. */
export function swarmTemplateUnboundRoles(
  templateId: string,
  workspaceId: string,
  projectCwd?: string | null,
) {
  return invoke<UnboundRole[]>("swarm_template_unbound_roles", {
    templateId,
    workspaceId,
    projectCwd: projectCwd ?? null,
  });
}

export function swarmInstanceAbort(swarmId: string, instanceId: string) {
  return invoke<void>("swarm_instance_abort", { swarmId, instanceId });
}

export function agentRunExport(runId: string) {
  return invoke<string>("agent_run_export", { runId });
}

export function swarmExport(swarmId: string) {
  return invoke<string>("swarm_export", { swarmId });
}

// GH #171: the role-binding commands went with Settings › Role bindings. A
// swarm still seeds and reads its bindings in Rust (`swarms.rs`).

// ── Snapshots / diff reviewer (v0.9.0 F1) ──────────────

export type ChangeKind = "added" | "modified" | "removed";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  before: string | null;
  after: string | null;
}

export interface ChangesManifest {
  schemaVersion: number;
  runId: string;
  changes: FileChange[];
  truncated: boolean;
}

export function snapshotGetChanges(runId: string) {
  return invoke<ChangesManifest | null>("snapshot_get_changes", { runId });
}

// ── Shell integration (v0.10.0 Command Blocks) ─────────

/** The shells `shell_integration_script` has a snippet for. */
export type SnippetShell = "zsh" | "bash" | "powershell";

export function shellIntegrationScript(shell: SnippetShell) {
  return invoke<string>("shell_integration_script", { shell });
}

// ── Localhost probe ────────────────────────────────────

export function probeLocalhostPorts() {
  return invoke<number[]>("probe_localhost_ports");
}

/** Try it TI-3: which of `ports` answer on localhost — a card copy's block
 *  (`cardPortList` in lib/tryAddress). Ports below 1024 are never tried and
 *  at most 16 are (`probe_ports` in commands.rs). */
export function probePorts(ports: number[]) {
  return invoke<number[]>("probe_ports", { ports });
}

// ── Notifications ──────────────────────────────────────

/**
 * Sends a benign test notification. Used by Settings to trigger the macOS
 * notification permission prompt under user control before agent runs start
 * firing real notifications in the background.
 */
export function notificationSendTest() {
  return invoke<void>("notification_send_test");
}

/** QoL 1.168 (F4, D6): whether the system lets Plyloft show notifications
 *  (`notification_access::NotificationAccess`). `unknown`: Plyloft could not
 *  tell — a development build, or the system did not answer. */
export type NotificationAccess = "not-asked" | "allowed" | "denied" | "unknown";

export function notificationAccess() {
  return invoke<NotificationAccess>("notification_access");
}

/** Ask macOS for permission (its prompt appears once) and return what it
 *  settled on; Windows asks nothing of a desktop app. */
export function notificationRequestAccess() {
  return invoke<NotificationAccess>("notification_request_access");
}

/** Open the system's notification settings. */
export function notificationOpenSettings() {
  return invoke<void>("notification_open_settings");
}

/** QoL 1.168 (F5): Rust showed a notification about this card. */
export type NotificationSent = { workspaceId: string; cardId: string };

export function onNotificationSent(cb: (e: NotificationSent) => void): Promise<UnlistenFn> {
  return listen<NotificationSent>("notification://sent", (e) => cb(e.payload));
}

// ── Swarm (v1.0) ─────────────────────────────────

export type SwarmStatus =
  | "running"
  | "done"
  | "failed"
  | "aborted"
  | "timed_out"
  | "max_iter"
  /** v1.1.0 (resumable swarms): swarm was Running when Ply exited. Resumable via `swarmResume`. */
  | "suspended";

/** v1.3.0: per-leg state inside a Dispatching swarm. */
export type InstanceStatus = "pending" | "running" | "done" | "failed";

/** v1.3.0: one fan-out leg dispatched by the coordinator. */
export interface RoleInstance {
  id: string;
  role: string;
  runId?: string | null;
  ownerGlobs: string[];
  task: string;
  dependsOn: string[];
  status: InstanceStatus;
}

export type SwarmState =
  /** v1.2.0: generalized FSM position. Replaces v1.0/v1.1 PendingScout/Build/Review. */
  | { kind: "pending_step"; idx: number; role: string; priorRunIds: string[] }
  /** v1.3.0: coordinator about to dispatch tick `tick`. */
  | { kind: "pending_coordinator"; tick: number }
  /** v1.3.0: fan-out tick `tick` is running with these instances. */
  | { kind: "dispatching"; tick: number; instances: RoleInstance[] }
  | { kind: "done" }
  | { kind: "failed" }
  | { kind: "aborted" }
  | { kind: "timed_out" }
  | { kind: "max_iter" };

/** v1.22.0: how a swarm was initiated. `adhoc` = direct `Start swarm` IPC,
 *  `card` = kanban card drag, `brainstorm` = dedicated brainstorm modal.
 *  Persisted records that predate this field default to `adhoc`. */
export type SwarmKind = "adhoc" | "card" | "brainstorm";

export interface Swarm {
  schemaVersion: number;
  id: string;
  workspaceId: string;
  templateId: string;
  goal: string;
  status: SwarmStatus;
  state: SwarmState;
  /** v1.22.0: initiation tag. Defaults to `adhoc` for any legacy persisted record. */
  kind?: SwarmKind;
  iteration: number;
  /** Map of role name → AgentConfig id. */
  roleBindings: Record<string, string>;
  runIds: string[];
  startedAt: number;
  endedAt?: number | null;
  endReason?: string | null;
  /** v1.1.0: unix-ms when status flipped to `suspended`. null when not suspended. */
  suspendedAt?: number | null;
  /** v1.1.0: cumulative seconds spent in `suspended` across resume cycles. */
  suspendedSeconds?: number;
  /** v1.1.0: which role's run was killed by app exit. Used by `swarmResume` to decide what to re-fire. */
  inFlightRoleAtSuspend?: string | null;
  /** v1.3.0: snapshot of every fan-out leg that was non-terminal at suspend time. Empty for sequential swarms. */
  inFlightAtSuspend?: RoleInstance[];
  /** v1.31.0 (Cycle 1): the swarm's effective working directory — the
   *  per-card git worktree for card swarms. Empty on pre-fix records. */
  cwd?: string;
  /** v1.31.0 (Cycle 1): sticky — set when any run of this swarm was
   *  rate-limited / throttled. The swarm-terminal mapper reads it. */
  throttled?: boolean;
}

export type MailboxKind =
  | "created"
  | "dispatch"
  | "report"
  | "artifact"
  | "terminate"
  /** v1.1.0: appended once per Cmd-Q while a swarm is running. */
  | "suspend"
  /** v1.1.0: appended once per click of the Resume button. */
  | "resume"
  /** v1.3.0: coordinator emitted a tick artifact with a fresh dispatch list. */
  | "coordinator_tick"
  /** v1.3.0: a fan-out leg started its run. */
  | "instance_started"
  /** v1.3.0: a fan-out leg finished. */
  | "instance_done"
  /** v1.3.0: leg attempted out-of-glob write or two dispatches overlapped. */
  | "collision";

export interface RunSummary {
  runId: string;
  role: string;
  status: string;
  startedAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  bytesWritten: number;
  model?: string | null;
  totalCostUsd?: number | null;
  filesChangedCount?: number | null;
}

export interface MailboxEntry {
  id: string;
  ts: number;
  swarmId: string;
  kind: MailboxKind;
  role?: string | null;
  runId?: string | null;
  body?: unknown;
  runSummary?: RunSummary | null;
}

export function swarmStart(opts: {
  workspaceId: string;
  templateId: string;
  goal: string;
  roleBindings: Record<string, string>;
  /** v1.10.x Cycle A: when set, the swarm runs with this directory as
   *  cwd instead of the workspace cwd. Used by kanban moveCard to point
   *  card-driven swarms at the per-card worktree. */
  cwdOverride?: string | null;
  /** v1.22.0: initiation tag. Omit (or pass `"adhoc"`) for the default
   *  Start-swarm path; `"card"` for kanban card drags; `"brainstorm"`
   *  for the dedicated Brainstorm modal. */
  kind?: SwarmKind;
  /** Required by the backend when `kind === "card"` so work authorization
   *  and card-link publication share one guarded transition. */
  cardId?: string | null;
}) {
  return invoke<Swarm>("swarm_start", {
    workspaceId: opts.workspaceId,
    templateId: opts.templateId,
    goal: opts.goal,
    roleBindings: opts.roleBindings,
    cwdOverride: opts.cwdOverride ?? null,
    kind: opts.kind ?? null,
    cardId: opts.cardId ?? null,
  });
}

export function swarmGet(swarmId: string) {
  return invoke<Swarm | null>("swarm_get", { swarmId });
}

export function swarmList(workspaceId?: string | null) {
  return invoke<Swarm[]>("swarm_list", { workspaceId: workspaceId ?? null });
}

export function swarmAbort(swarmId: string) {
  return invoke<void>("swarm_abort", { swarmId });
}

/** v1.30.0 (parallel swarms): card-swarm slot usage for a workspace.
 *  Running + Suspended both count toward `cap`. */
export interface CardSlotStatus {
  runningCardSwarms: number;
  suspendedCardSwarms: number;
  cap: number;
}

export function swarmCardSlotStatus(workspaceId: string) {
  return invoke<CardSlotStatus>("swarm_card_slot_status", { workspaceId });
}

export function swarmMailboxRead(swarmId: string, fromOffset: number = 0) {
  return invoke<MailboxEntry[]>("swarm_mailbox_read", { swarmId, fromOffset });
}

/** Subscribe to live mailbox events (one per `append_mailbox` call). */
export function onSwarmMailbox(handler: (entry: MailboxEntry) => void): Promise<UnlistenFn> {
  return listen<MailboxEntry>("swarm://mailbox", (e) => handler(e.payload));
}

/**
 * v1.1.0 (resumable swarms): re-fire the in-flight role of a Suspended swarm.
 * The backend/store capability survives the retired Swarm tab; Part 3 owns
 * the next guided resume surface. Returns the post-resume Swarm record
 * (status: "running"). See `docs/RESUMABLE_SWARMS_DESIGN.md` §6.3.
 */
export function swarmResume(swarmId: string) {
  return invoke<Swarm>("swarm_resume", { swarmId });
}

// ── Card chat (chat.rs; the card's Chat tab is `ChatPanel`) ─────────────

export type ChatVendor = "claude" | "codex";
/** `chat::ChatStatus`. The composer is the member's for idle, ready and
 *  stopped; Stop is offered while working. */
export type ChatStatus = "idle" | "starting" | "working" | "ready" | "stopped";
export type ChatRole = "user" | "assistant" | "tool" | "shell" | "interrupted" | "notice";

/** Tokens a conversation used (`chat_store::TokenUsage`): never a cost.
 *  `inputTokens` is the input not read from the cache. */
export type ChatTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
};

export type ChatTool = { name: string; detail: string; outcome: string };

/** `chat_store::ChatMessage`. A newer role is kept as a string. */
export type ChatMessage = {
  id: string;
  role: ChatRole | (string & {});
  text: string;
  sourceId?: string | null;
  attachmentIds: string[];
  /** An assistant message is complete (false while it streams). */
  done: boolean;
  /** On a user message: it was not sent. On a notice: a warning. */
  isError: boolean;
  tool?: ChatTool | null;
  pastedImages?: number;
  at: number;
  /** Plan with two AIs: the answer this message relays to the other side
   *  (the thread hides relays). Never on a Chat message. */
  relayOf?: string | null;
  /** Plan with two AIs: the exchange turn it belongs to. */
  turn?: number | null;
};

export type ChatAttachmentKind = "image" | "pdf" | "text" | "docx" | "other";

/** `chat_attachments::Attachment`: local to this computer, deleted with the card. */
export type ChatAttachment = {
  id: string;
  name: string;
  kind: ChatAttachmentKind;
  bytes: number;
  storedName?: string;
  addedAt?: number;
  pages?: number | null;
  textName?: string | null;
  textTruncated?: boolean;
  note?: string | null;
};

export type ChatSnapshot = {
  workspaceId: string;
  cardId: string;
  vendor: ChatVendor;
  status: ChatStatus;
  reason?: string | null;
  attention?: string | null;
  messages: ChatMessage[];
  usage: ChatTokenUsage;
  attachments: ChatAttachment[];
  ptyId?: string | null;
};

export type ChatStateEvent = {
  workspaceId: string;
  cardId: string;
  vendor: ChatVendor;
  status: ChatStatus;
  reason?: string | null;
  attention?: string | null;
  usage: ChatTokenUsage;
  ptyId?: string | null;
};

export type ChatMessagesEvent = {
  workspaceId: string;
  cardId: string;
  vendor: ChatVendor;
  /** Added or changed messages, by `id`. */
  messages: ChatMessage[];
};

/** "Show terminal"'s first paint: the live Claude session's screen and its
 *  terminal modes (bracketed paste…), the `pty://data` offset the grid stands
 *  at (write only the bytes at or after it), and the grid's size. */
export type ChatScreenSnapshot = { ptyId: string; formatted: string; offset: number; rows: number; cols: number };

/** Makes `vendor` the card's chat and returns its conversation. Starts nothing. */
export function chatOpen(workspaceId: string, cardId: string, vendor: ChatVendor) {
  return invoke<ChatSnapshot>("chat_open", { workspaceId, cardId, vendor });
}

/** A conversation from Plyloft's own copy (default: the active vendor). */
/** `preferred` (1.171.0, E1): the vendor a chat that never chose one opens
 *  on — the card's Builder, else the default Builder. */
export function chatMessages(workspaceId: string, cardId: string, vendor?: ChatVendor, preferred?: ChatVendor) {
  return invoke<ChatSnapshot>("chat_messages", { workspaceId, cardId, vendor: vendor ?? null, preferred: preferred ?? null });
}

/** Sends to the active vendor, starting or resuming its session. */
export function chatSend(workspaceId: string, cardId: string, text: string, attachmentIds: string[]) {
  return invoke<ChatMessage>("chat_send", { workspaceId, cardId, text, attachmentIds });
}

/** Stop: Esc to Claude, `turn/interrupt` to Codex. */
export function chatInterrupt(workspaceId: string, cardId: string) {
  return invoke<void>("chat_interrupt", { workspaceId, cardId });
}

/** Ends the session; the history stays and the next send resumes it. */
export function chatClose(workspaceId: string, cardId: string) {
  return invoke<void>("chat_close", { workspaceId, cardId });
}

/** The live Claude chat's PTY and its screen, or null when none runs. */
export function chatScreen(workspaceId: string, cardId: string) {
  return invoke<ChatScreenSnapshot | null>("chat_screen", { workspaceId, cardId });
}

/** Attaches a file: its raw bytes as the request body (never a JSON number
 *  array), the card and the percent-encoded name in headers. A PDF may take
 *  up to 20 s (its text is read in a child process). */
export function chatAttachmentAdd(workspaceId: string, cardId: string, name: string, bytes: Uint8Array) {
  let encoded: string;
  try {
    encoded = encodeURIComponent(name);
  } catch {
    // A lone surrogate (URIError): no header can carry the name.
    return Promise.reject(CHAT_NAME_UNSENDABLE);
  }
  return invoke<ChatAttachment>("chat_attachment_add", bytes, {
    headers: {
      "x-ply-workspace-id": workspaceId,
      "x-ply-card-id": cardId,
      "x-ply-file-name": encoded,
    },
  });
}

/** Why a file whose name no header can carry was not attached. */
export const CHAT_NAME_UNSENDABLE =
  "Its name has a character Plyloft can't pass on. Rename the file, then add it again.";

export function chatAttachmentList(workspaceId: string, cardId: string) {
  return invoke<ChatAttachment[]>("chat_attachment_list", { workspaceId, cardId });
}

export function chatAttachmentRemove(workspaceId: string, cardId: string, attachmentId: string) {
  return invoke<void>("chat_attachment_remove", { workspaceId, cardId, attachmentId });
}

export function onChatState(handler: (e: ChatStateEvent) => void): Promise<UnlistenFn> {
  return listen<ChatStateEvent>("chat://state", (e) => handler(e.payload));
}

export function onChatMessages(handler: (e: ChatMessagesEvent) => void): Promise<UnlistenFn> {
  return listen<ChatMessagesEvent>("chat://messages", (e) => handler(e.payload));
}

// ── Plan with two AIs (plan_exchange.rs; `PlanExchangePanel`) ───────────

export type PlanRole = "proposer" | "critic";
export type PlanExchangeStatus = "running" | "awaitingMember" | "paused" | "accepted" | "discarded" | (string & {});
export type PlanPauseKind =
  | "stopped"
  | "signIn"
  | "usageLimit"
  | "trust"
  | "screen"
  | "failed"
  | "quit"
  | "sessionEnded"
  | "archived"
  | "timeout"
  | (string & {});
export type PlanTurnRole = "propose" | "critique" | "revise" | (string & {});
export type PlanVerdict = "ready" | "changesNeeded" | "none" | (string & {});

/** One conversation of an exchange (`chat_store::Conversation`). */
export type PlanConversation = {
  vendor: ChatVendor;
  sessionId?: string | null;
  sessionDir?: string | null;
  messages: ChatMessage[];
  usage: ChatTokenUsage;
};

export type PlanTurn = {
  n: number;
  round: number;
  role: PlanTurnRole;
  vendor: ChatVendor;
  sent: "full" | "retry" | "reseed" | (string & {});
  sentMessageId?: string | null;
  answerMessageId?: string | null;
  answer?: string | null;
  verdict?: PlanVerdict | null;
  startedAt: number;
  endedAt?: number | null;
  outcome?: "answered" | "interrupted" | "failed" | "noAnswer" | "stopped" | (string & {}) | null;
};

/** `plan_store::Exchange`. */
export type PlanExchange = {
  id: string;
  createdAt: number;
  updatedAt: number;
  proposer: ChatVendor;
  critic: ChatVendor;
  ask: string;
  attachmentIds: string[];
  roundsDefault: number;
  roundsMax: number;
  roundsDone: number;
  roundsTarget: number;
  note?: string | null;
  status: PlanExchangeStatus;
  pause?: { kind: PlanPauseKind; reason: string } | null;
  turns: PlanTurn[];
  proposerConversation?: PlanConversation | null;
  criticConversation?: PlanConversation | null;
  outcome?: { kind: "accepted" | "edited" | "discarded" | (string & {}); text: string; at: number } | null;
};

export type PlanLaneState = {
  role: PlanRole;
  vendor: ChatVendor;
  status: ChatStatus;
  usage: ChatTokenUsage;
  ptyId?: string | null;
  attention?: string | null;
};

export type PlanExchangeSnapshot = {
  workspaceId: string;
  cardId: string;
  current: PlanExchange | null;
  earlier: PlanExchange[];
  readOnly: boolean;
  runningElsewhere: string | null;
  lanes: PlanLaneState[];
  waitingForPrompt: boolean;
};

/** `plan://state`: the snapshot without `earlier`, and without the
 *  conversations (they travel in `plan://messages`). */
export type PlanStateEvent = Omit<PlanExchangeSnapshot, "earlier"> & { exchangeId: string | null };

export type PlanMessagesEvent = {
  workspaceId: string;
  cardId: string;
  exchangeId: string;
  role: PlanRole;
  vendor: ChatVendor;
  messages: ChatMessage[];
};

/** Starts an exchange: `preferred` is the card's Builder vendor (it proposes
 *  when both vendors are ready; with one ready, that one takes both roles). */
export function planExchangeStart(
  workspaceId: string,
  cardId: string,
  preferred: ChatVendor,
  ask: string,
  attachmentIds: string[],
) {
  return invoke<PlanExchangeSnapshot>("plan_exchange_start", { workspaceId, cardId, preferred, ask, attachmentIds });
}

export function planExchangeGet(workspaceId: string, cardId: string) {
  return invoke<PlanExchangeSnapshot>("plan_exchange_get", { workspaceId, cardId });
}

export function planExchangeStop(workspaceId: string, cardId: string) {
  return invoke<void>("plan_exchange_stop", { workspaceId, cardId });
}

export function planExchangeRetry(workspaceId: string, cardId: string) {
  return invoke<PlanExchangeSnapshot>("plan_exchange_retry", { workspaceId, cardId });
}

export function planExchangeMore(workspaceId: string, cardId: string, note: string | null) {
  return invoke<PlanExchangeSnapshot>("plan_exchange_more", { workspaceId, cardId, note });
}

/** Use this plan (no text) or Edit… saved (the text): the card's plan,
 *  written in one backend write. Returns the card. */
export function planExchangeAccept(workspaceId: string, cardId: string, editedText: string | null) {
  return invoke<KanbanCard>("plan_exchange_accept", { workspaceId, cardId, editedText });
}

export function planExchangeDiscard(workspaceId: string, cardId: string) {
  return invoke<void>("plan_exchange_discard", { workspaceId, cardId });
}

/** The view-only paint of the exchange's Claude session, or null. */
export function planExchangeScreen(workspaceId: string, cardId: string) {
  return invoke<ChatScreenSnapshot | null>("plan_exchange_screen", { workspaceId, cardId });
}

/** `plan_exchange::PlanOpenCard`: a card whose latest exchange runs, waits
 *  for the member or is paused. */
export type PlanOpenCard = {
  workspaceId: string;
  cardId: string;
  exchangeId: string;
  status: PlanExchangeStatus;
  proposer: ChatVendor;
  critic: ChatVendor;
  roundsDone: number;
  updatedAt: number;
  pause?: { kind: PlanPauseKind; reason: string } | null;
};

/** Every workspace's cards with an open or paused exchange (read from disk
 *  once after a launch): the Board, the card's Now and the Inbox say so. */
export function planExchangeOpenCards() {
  return invoke<PlanOpenCard[]>("plan_exchange_open_cards");
}

export function onPlanState(handler: (e: PlanStateEvent) => void): Promise<UnlistenFn> {
  return listen<PlanStateEvent>("plan://state", (e) => handler(e.payload));
}

export function onPlanMessages(handler: (e: PlanMessagesEvent) => void): Promise<UnlistenFn> {
  return listen<PlanMessagesEvent>("plan://messages", (e) => handler(e.payload));
}

// ── 1.173.0 (D1): where a project goes live (deploy_map.rs), read only ──

/** What Railway said (`deploy_map::RailwayState`). */
export type RailwayState =
  | "ok"
  | "noCli"
  | "notLinked"
  /** The link is on a folder above this repository: another project's. */
  | "otherProject"
  | "signedOut"
  | "timedOut"
  | "failed";

/** One service of one Railway environment. */
export interface RailwayService {
  environment: string;
  name: string;
  /** `owner/name`; null for a service built from an image. */
  repo: string | null;
  /** The branch it deploys from. */
  branch: string | null;
  /** From the repository's root, no leading or trailing `/`; null: the
   *  whole repository. */
  rootDirectory: string | null;
  /** Gitignore-style, from the repository's root; empty: any change
   *  rebuilds it. */
  watchPatterns: string[];
  /** Custom addresses first, then Railway's own. */
  domains: string[];
  cron: string | null;
  /** 1.173.0 walk: its latest deployment's state as Railway names it
   *  (`SUCCESS`, `FAILED`, `BUILDING`…), upper-cased; null when Railway gave
   *  none. Optional: older test shapes leave it out. */
  deployStatus?: string | null;
  /** It builds from this workspace's repository (`origin`). */
  thisRepository: boolean;
}

export interface RailwayRead {
  state: RailwayState;
  project: string | null;
  services: RailwayService[];
  message: string | null;
  /** Epoch ms; null when nothing ran. */
  readAt: number | null;
}

/** One event's filters; null: no filter. */
export interface WorkflowTrigger {
  branches: string[] | null;
  branchesIgnore: string[] | null;
  paths: string[] | null;
  pathsIgnore: string[] | null;
}

/** One `.github/workflows` file. */
export interface DeployWorkflow {
  file: string;
  name: string;
  push: WorkflowTrigger | null;
  pullRequest: WorkflowTrigger | null;
  /** `pull_request_target` runs on a pull request too. */
  pullRequestTarget: WorkflowTrigger | null;
  jobs: string[];
}

/** `deploy_map::DeployMap`. */
export interface DeployMap {
  /** The workspace's GitHub `owner/name`. */
  repo: string | null;
  railway: RailwayRead;
  workflows: DeployWorkflow[];
  /** 1.173.0: the repository has `railway.json`/`railway.toml` (root or one
   *  folder down). Optional: older test shapes leave it out. */
  railwayFiles?: boolean;
}

/** `watched` / `inRoot`: it updates; `anyChange`: it restarts too, only
 *  because it has no watch paths. */
export type RebuildReason = "watched" | "inRoot" | "anyChange";

export interface Redeploy {
  service: RailwayService;
  reason: RebuildReason;
  rebuildsOnAnyChange: boolean;
  domains: string[];
}

export interface DeployCheckRun {
  file: string;
  name: string;
  jobs: string[];
}

/** `deploy_map::WhatRedeploys`: what a card's merge changes online. */
export interface WhatRedeploys {
  targetBranch: string;
  /** Updates first, then `anyChange`. */
  services: Redeploy[];
  /** Workflows that run on a pull request to `targetBranch`. */
  checks: DeployCheckRun[];
  project: string | null;
  railwayReadAt: number | null;
  changed: number;
}

/** Where the workspace goes live. Railway is cached ten minutes;
 *  `refresh` reads it again (*Read again*). */
export function deployMapGet(workspaceId: string, refresh?: boolean) {
  return invoke<DeployMap>("deploy_map_get", { workspaceId, refresh: refresh ?? null });
}

/** What the card's pull request changes online when it merges; null with
 *  nothing to measure (no copy, nothing changed, the card can't ship yet)
 *  or nothing it changes online that Plyloft can see — then show nothing. */
export function deployWhatChanges(workspaceId: string, cardId: string) {
  return invoke<WhatRedeploys | null>("deploy_what_changes", { workspaceId, cardId });
}

// ── 1.173.0 (E1): Next improvement's direction ────────────────────────

/** The approaches a direction can ask for (`next_improvement::APPROACHES`),
 *  in the editor's order. A file may hold others a newer Plyloft knows. */
export const NI_APPROACHES = ["polish", "simplify", "grow", "fix"] as const;
export type NiApproach = (typeof NI_APPROACHES)[number];

/** An idea the person said not to propose again, and why. */
export interface NiRejected {
  title: string;
  reason: string;
  /** Milliseconds. */
  at: number;
  by?: string | null;
  device?: string | null;
  [key: string]: unknown;
}

/** `.atelier/next-improvement/<area>.json`. Unknown keys round-trip. */
export interface NiDirection {
  schemaVersion: number;
  /** For whom. */
  audience: string;
  /** What "better" means here. */
  better: string;
  /** What you don't want. */
  avoid: string;
  /** Where to look at it: a web address, "" for none. */
  lookAt: string;
  approaches: string[];
  /** Absent: whichever AI is installed. */
  proposer?: "claude" | "codex" | null;
  rejected: NiRejected[];
  [key: string]: unknown;
}

/** An empty direction, as `Direction::default()`. */
export function emptyNiDirection(): NiDirection {
  return { schemaVersion: 1, audience: "", better: "", avoid: "", lookAt: "", approaches: [], rejected: [] };
}

/** Where a suggested "Where to look at it" came from: `railway` "Found in
 *  Railway", `packageJson` "From package.json", `readme`, `area` (Settings ›
 *  Areas). */
export type NiLookAtSource = "area" | "railway" | "packageJson" | "readme";

export interface NiLookAtHint {
  url: string;
  source: NiLookAtSource;
}

export interface NiDirectionDraft {
  direction: NiDirection;
  /** What it was drafted from ("Drafted from your README"). "What better
   *  means" is never drafted. */
  from: ("readme" | "packageJson")[];
  lookAt: NiLookAtHint | null;
  /** 1.174.0 (C9): "For whom" as the README (else package.json) says it,
   *  offered beside the empty field, never filled in. Absent before 1.174. */
  audience?: { text: string; source: "readme" | "packageJson" } | null;
}

export interface NiPending {
  state: "waiting" | "offline" | "pullRequest" | "conflict" | "failed";
  /** In the app's words. */
  message: string | null;
  /** What git or GitHub said: Details / Copy details only. */
  technical: string | null;
  pullRequest: ConfigPullRequest | null;
  /** C3's questions, one per field (`field` = `ni-<area>-<key>`): open the
   *  existing sheet with `useSettingConflict.getState().show(ws, field)`. */
  conflicts: SettingConflict[];
}

/** `ni_direction_get` and every press's answer. */
export interface NiDirectionView {
  /** The area's file name: its id, or "default" without areas. */
  area: string;
  /** "" for a repository without areas. */
  areaName: string;
  path: string;
  /** True: the direction is the shared setup's, in the repository. False
   *  (E6): it is kept on this computer only, and can still be saved; the
   *  editor offers to share the setup (`workspaceAdoptionShare`). */
  shared: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  /** E6, said once: the repository's direction was kept over the one this
   *  computer kept before the share. Then `niDirectionNoticeSeen`. */
  notice: string | null;
  /** E6, shared: why a direction is still kept on this computer (a
   *  read-only Mac shows its own until it can save, or a file matches no
   *  area). Already in this computer's words. */
  keptHere: string | null;
  /** A direction exists on the branch or is queued here. */
  exists: boolean;
  direction: NiDirection;
  /** Only while none exists; never saved until the person saves. */
  draft: NiDirectionDraft | null;
  /** The suggested "Where to look at it": only while there is no
   *  direction or its address is empty. */
  lookAtHint: NiLookAtHint | null;
  /** 1.174.0 (C9, NIW-1): on a shared setup this Mac can save to, the
   *  branch a save goes to. Absent before 1.174. */
  savesTo?: string | null;
  /** C9 round 1 (owner): GitHub says that branch takes changes through a
   *  pull request, read before the first save. Absent before 1.174. */
  savesViaPullRequest?: boolean;
  pending: NiPending | null;
  /** The repository's file can't be read (the app's words); nothing is
   *  saved over it. */
  problem: string | null;
  /** What git said about it: Details only. */
  problemTechnical: string | null;
  /** 1.174.0 (C11, P15): the direction written before the project had
   *  areas, while this area has none of its own: its first time offers
   *  *Use it for <area>*. Absent before 1.174. */
  beforeAreas?: NiDirection | null;
}

/** 1.174.0 (C11): the sheet's question at the first save of two or more
 *  areas — the direction written before the areas, and the areas (ids, in
 *  the list's order) without one of their own. */
export interface NiBeforeAreas {
  direction: NiDirection;
  areas: string[];
}

/** C11: the sheet's question, or null when there is none to ask. Reads only. */
export function niDirectionProject(workspaceId: string) {
  return invoke<NiBeforeAreas | null>("ni_direction_project", { workspaceId });
}

/** C11: *Use it for both* / *Use it for <area>* — each area without its own
 *  takes a copy of the direction written before the areas, its "Not to
 *  propose again" list included. `direction`: the answers as checked in the
 *  editor (*Check the direction first…*); the list still comes from the
 *  project's. A shared setup publishes at once. The areas that took it. */
export function niDirectionAdoptProject(workspaceId: string, areas: string[], direction?: NiDirection | null) {
  return invoke<string[]>("ni_direction_adopt_project", { workspaceId, areas, direction: direction ?? null });
}

/** One area's direction. `area` absent: the implicit area without areas;
 *  with areas, the workspace's default area, else the only one, else it is
 *  refused with "Which area is this for?". Held areas refuse. */
export function niDirectionGet(workspaceId: string, area?: string | null) {
  return invoke<NiDirectionView>("ni_direction_get", { workspaceId, area: area ?? null });
}

/** *Save*: published at once; offline it waits for the next refresh. The
 *  rejected list in `direction` is ignored (only its own presses change it). */
export function niDirectionSave(workspaceId: string, area: string | null | undefined, direction: NiDirection) {
  return invoke<NiDirectionView>("ni_direction_save", { workspaceId, area: area ?? null, direction });
}

/** E6: the view's `notice` was shown; it isn't said again. `area` is the
 *  view's own `area`. */
export function niDirectionNoticeSeen(workspaceId: string, area: string) {
  return invoke<void>("ni_direction_notice_seen", { workspaceId, area });
}

/** *Don't propose this…*: the idea's title and one line of why. */
export function niReject(workspaceId: string, area: string | null | undefined, idea: string, reason: string) {
  return invoke<NiDirectionView>("ni_reject", { workspaceId, area: area ?? null, idea, reason });
}

/** *Remove* on "Not to propose again": the row's position in
 *  `direction.rejected` with its `title` and `at`; a list that moved since
 *  is refused ("That idea isn't on the list any more."). */
export function niUnreject(workspaceId: string, area: string | null | undefined, row: { index: number; title: string; at: number }) {
  return invoke<NiDirectionView>("ni_unreject", { workspaceId, area: area ?? null, ...row });
}

/** Emitted after a direction changed on this computer. */
export function onNiDirection(handler: (e: { workspaceId: string; area: string }) => void): Promise<UnlistenFn> {
  return listen<{ workspaceId: string; area: string }>("ni://direction", (e) => handler(e.payload));
}

// ── Next improvement · the round (1.173.0 E2, `next_improvement_round.rs`) ──

export type NiRoundStatus =
  | "running"
  | "ready"
  | "nothing"
  | "unreadable"
  | "stopped"
  | "timedOut"
  | "failed"
  | "interrupted"
  | "unknown";

/** One line of the in-progress view ("Done · Claude looked at 9 pages of
 *  www.lyrappc.com"). `look` is skipped without an address; `second` without
 *  ideas. */
export interface NiPhase {
  id: "look" | "read" | "second" | string;
  state: "todo" | "now" | "done" | "skipped";
  words: string;
}

export interface NiLooked {
  /** The product's pages the proposer opened. */
  pages: string[];
  /** Files it read or searched. */
  files: number;
  /** A browser or screenshot tool was in the session: false today, so the
   *  ideas say they read the page's text and the code. */
  browser: boolean;
  /** It could reach the web. */
  web: boolean;
}

export interface NiIdea {
  id: string;
  title: string;
  saw: string;
  change: string;
  better: string;
  removes: string;
  check: string;
  size: "S" | "M" | "L" | string;
  risk: "low" | "some" | "high" | string;
  sources: string[];
  /** `file:line` in the area's code. */
  where: string[];
  /** A screenshot under the app's data folder (none today). */
  shot?: string | null;
  /** The second opinion's line on a kept idea. */
  secondOpinion?: string | null;
  /** Set by `niRoundMark` after *Make it a card*. */
  cardId?: string | null;
  /** Set by `niRoundMark` after *Don't propose this…*. */
  dismissed: boolean;
  /** 1.174.0 (C15): still unanswered when the next round started, so it
   *  stayed in the slate — the round it came from ("From the last round").
   *  Absent for the round's own ideas and in a 1.173 file. */
  carriedFrom?: number | null;
  [key: string]: unknown;
}

/** "Set aside by the second opinion" (`by: "secondOpinion"`), or by
 *  Plyloft's own check after reading the answer (`check`, E4). */
export interface NiSetAside {
  idea: NiIdea;
  reason: string;
  by: "secondOpinion" | "check" | "other";
  /** 1.174.0 (C8, P13): Plyloft's check set it aside because it repeats
   *  this card (`reason` "already a card: <title>"); the line opens it.
   *  Absent for every other reason and in a 1.173 file. */
  card?: { id: string; title: string } | null;
}

export interface NiRound {
  id: string;
  /** 1 for this area's first round on this computer. */
  number: number;
  status: NiRoundStatus;
  startedAt: number;
  endedAt: number | null;
  areaName: string;
  approaches: string[];
  /** 1.174.0 (C15): the approaches chosen for this round only, when they
   *  differ from the direction's ("Polish, this round"). */
  approachesOverride?: string[] | null;
  /** C15: who proposes, chosen for this round only. */
  proposerOverride?: "claude" | "codex" | null;
  lookAt: string;
  proposer: "claude" | "codex";
  second: "claude" | "codex";
  /** One AI gave both: the second opinion was a separate session of it. */
  oneAi: boolean;
  folder: string;
  rejectedCount: number;
  /** 1.174.0 (C8): the cards already planned for the area it was given
   *  (the phase "read the 3 cards already planned for Site…"); absent as 0. */
  plannedCount?: number;
  /** "Read the code as of 28 Oct 2026: Plyloft couldn't reach the
   *  repository." when the branch couldn't be fetched. */
  codeNote?: string | null;
  branch: string;
  revision: string;
  phases: NiPhase[];
  looked: NiLooked;
  /** The slate (status `ready`); empty for `nothing`. */
  ideas: NiIdea[];
  setAside: NiSetAside[];
  /** The proposer's line when nothing is worth doing. */
  nothing?: string | null;
  /** Status `unreadable`: "Couldn't read the ideas this time", with the raw
   *  answer behind Details. */
  unreadable?: { stage: "proposer" | "second" | "other"; raw: string; problem: string } | null;
  /** Why it stopped, failed, timed out or was interrupted (the app's words). */
  reason?: string | null;
  /** *Change it…* under way (status `running`, the slate still shown). */
  change?: { ideaId: string; comment: string; startedAt: number } | null;
  /** The last *Change it…* didn't land; the idea stayed as it was. */
  changeProblem?: string | null;
  /** What git or the session said: Details / Copy details only. */
  technical?: string | null;
  [key: string]: unknown;
}

/** `ni_round_get`, every round call's answer, and `ni://progress`. */
export interface NiRoundView {
  workspaceId: string;
  area: string;
  round: NiRound | null;
  /** "Claude proposed, Codex gave a second opinion", or "Claude proposed,
   *  then gave itself a second opinion in a separate pass · Codex isn't ready
   *  on this computer"; only what happened ("Claude was proposing when
   *  Plyloft quit", "Claude proposed"). */
  byline: string | null;
  elapsedMs: number | null;
}

/** *Prepare proposals*: a new round for the area (resolved as
 *  `niDirectionGet`). Refused while one runs for it, without a direction
 *  ("Write the direction first: …" — open the direction sheet), or with no AI
 *  ready. A copy of the code that can't be made comes back as a `failed`
 *  round with `technical`. Takes a moment: it fetches the branch and makes
 *  the read-only copy first. */
export function niRoundStart(
  workspaceId: string,
  area?: string | null,
  /** 1.174.0 (C15): *Prepare new proposals*' popover — for this round only;
   *  the direction is never written for it. Ideas still waiting stay in the
   *  new round's slate. */
  thisRound?: { approaches?: string[]; proposer?: "claude" | "codex" } | null,
) {
  return invoke<NiRoundView>("ni_round_start", {
    workspaceId,
    area: area ?? null,
    ...(thisRound?.approaches ? { approaches: thisRound.approaches } : {}),
    ...(thisRound?.proposer ? { proposer: thisRound.proposer } : {}),
  });
}

/** *Change it…*: the proposer rewrites one idea after `comment`, then it gets
 *  a second opinion again; the rest of the slate stays. */
export function niRoundChange(workspaceId: string, area: string | null | undefined, ideaId: string, comment: string) {
  return invoke<NiRoundView>("ni_round_change", { workspaceId, area: area ?? null, ideaId, comment });
}

/** *Stop*: the round ends stopped (a change under way ends; the slate stays). */
export function niRoundStop(workspaceId: string, area?: string | null) {
  return invoke<void>("ni_round_stop", { workspaceId, area: area ?? null });
}

/** The area's latest round (a round left running by a quit reads
 *  `interrupted`). Stop, Get and Mark take the area id as given whenever this
 *  computer has a round for it, even if the areas are held meanwhile. */
export function niRoundGet(workspaceId: string, area?: string | null) {
  return invoke<NiRoundView>("ni_round_get", { workspaceId, area: area ?? null });
}

/** After *Make it a card* (`cardId`) or *Don't propose this…* (`dismissed`,
 *  after `niReject`): the idea is marked on the slate. */
export function niRoundMark(
  workspaceId: string,
  area: string | null | undefined,
  ideaId: string,
  mark: { cardId?: string | null; dismissed?: boolean },
) {
  return invoke<NiRoundView>("ni_round_mark", {
    workspaceId,
    area: area ?? null,
    ideaId,
    cardId: mark.cardId ?? null,
    dismissed: mark.dismissed ?? false,
  });
}

/** Every change of a round (phases while it runs, the slate when it ends). */
export function onNiProgress(handler: (view: NiRoundView) => void): Promise<UnlistenFn> {
  return listen<NiRoundView>("ni://progress", (e) => handler(e.payload));
}
