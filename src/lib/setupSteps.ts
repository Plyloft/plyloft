// Onboarding OB-4 (ONBOARDING_SPEC §3–§5): Setup's step model, pure.
//
// Every step's state is *derived* from what Plyloft can see on this Mac — the
// doctor report, the settings and the workspaces — never remembered (§3.2:
// "A step's 'done' is detected, never just remembered"). The only things
// stored are the answers (`level`, `workMode`), the resume point
// (`currentStep`) and what the person skipped (`skipped`).
//
// The facts come in through `SetupFacts`, built by `setupFacts()` from the
// doctor report. OB-2 added `aiReady` and the git identity to the report;
// `doctorFacts` reads them when present and falls back to the older fields
// for a report without them.
//
// Tests: `node --experimental-strip-types src/lib/setupSteps.test.ts`.
import {
  SETUP_STEP_IDS,
  SETUP_VERSION,
  type SetupLevel,
  type SetupStepId,
  type WorkMode,
} from "./settingsShape.ts";

/** A step's state word in the list (§3.1): `done`, `skipped`, `needs you`, or
 *  nothing to say yet (`empty`). */
export type StepState = "done" | "skipped" | "needs" | "empty";

/** Who is looking at Setup, which decides its header (§5.0). (1.178.0 A3 D6:
 *  no `newSteps` — the optional account step reopens nothing.) */
export type SetupCase = "firstRun" | "existing" | "rerun";

/** Setup's required set (§4 "What required means"). */
export type RequiredId = "git" | "identity" | "ai" | "project";
export const REQUIRED_IDS: readonly RequiredId[] = ["git", "identity", "ai", "project"];

/**
 * What Setup knows about this Mac. `null` = could not tell, or not read yet:
 * a step whose fact is unknown is never called done, and never "needs you"
 * either — it has nothing to say until the fact arrives.
 */
export interface SetupFacts {
  /** Git resolves and answers `--version` (OB-2); today: the doctor found it. */
  gitWorks: boolean | null;
  /** `user.name` and `user.email` both set globally. */
  gitIdentity: boolean | null;
  /** At least one of Claude Code / Codex works and is signed in. */
  aiReady: boolean | null;
  /** `gh` is signed in — known only when a read asked (Diagnostics). */
  githubSignedIn: boolean | null;
  /** `settings.onboarding.level`. */
  level: SetupLevel | null;
  /** Solo or team as Rust derives it (`team_work_mode`). */
  workMode: WorkMode;
  /** `settings.team.workMode` holds a choice. */
  workModeChosen: boolean;
  /** This Mac is in a team (a key naming one, `team.teamRepo`, a clone). */
  teamJoined: boolean;
  /** `settings.projects.folder` is set. */
  projectsFolderChosen: boolean;
  /** Workspaces added to Plyloft; null until the list is read (OB-15: an
   *  empty list at launch is not "no project"). */
  workspaceCount: number | null;
  /** Workspaces with a saved project config (`project_config_list`), or null
   *  while that list is not read. */
  configuredWorkspaceCount: number | null;
  /**
   * OB-12 (§4 `project`, §5 step 8 "Success"): at least one workspace is a
   * Git repository with a commit on its target branch — Setup reads it with
   * `project_inspect` (`lib/firstProject.ts::probeRepoReady`); null while
   * that read is out or couldn't tell. Absent where a surface doesn't read
   * it (the sidebar's Finish row, Settings › Account › Setup: no git runs at
   * launch), and there a workspace counts as before.
   */
  projectRepoReady?: boolean | null;
  /**
   * OB-13 (§5 step 9): Setup's own workspace — the active one, else the
   * first — has a project config (`project_config_list`); null while that
   * list is not read. Step 9 is done for *that* project, so a Mac with other
   * projects set up still shows the step for the one just added. Absent where
   * a surface doesn't know Setup's workspace, and there step 9 counts any
   * configured workspace as before. The required `project` item (§4) still
   * counts any workspace.
   */
  activeConfigured?: boolean | null;
  /**
   * Launch A2 (step 2, "Plyloft account"): a signed-in Plyloft account
   * (`accountStore.ts::accountReady`). Null while the account is not read;
   * absent where a surface doesn't read it (the sidebar's Finish row).
   * 1.178.0 (A3): optional — only teams need it, so a missing one is never
   * "Needs you"; a debug run that skips sign-in reads Skipped.
   */
  plyloftSignedIn?: boolean | null;
}

/** What `doctorFacts` reads of a doctor report: today's fields, and OB-2's
 *  optional. Typed loosely so this stays pure and runs under node. */
export interface DoctorFactsInput {
  tools: {
    id: string;
    found: boolean;
    versionOk?: boolean;
    auth?: { signedIn: boolean | null } | null;
  }[];
  /** OB-2: one AI works and is signed in (credential seen or "could not
   *  tell"). Absent before OB-2 lands. */
  aiReady?: boolean | null;
  /** OB-2: the git identity row — both name and email set. Absent before
   *  OB-2 lands. */
  gitIdentity?: { name?: string | null; email?: string | null } | boolean | null;
  /** OB-2: git works (version answers; CLT present on the Mac). Absent
   *  before OB-2 lands. */
  gitWorks?: boolean | null;
}

/**
 * The doctor's part of the facts. `userEmail` is the identity store's cached
 * `git config --global user.email`, the fallback for the identity until the
 * doctor reports it.
 */
export function doctorFacts(
  report: DoctorFactsInput | null,
  userEmail: string | null,
): Pick<SetupFacts, "gitWorks" | "gitIdentity" | "aiReady" | "githubSignedIn"> {
  if (!report) {
    return { gitWorks: null, gitIdentity: userEmail ? true : null, aiReady: null, githubSignedIn: null };
  }
  const tool = (id: string) => report.tools.find((t) => t.id === id) ?? null;
  const git = tool("git");
  const claude = tool("claude");
  const codex = tool("codex");
  const gh = tool("gh");

  // OB-2: the git row is found only when it answered `--version` (CLT
  // checked first). OB-6: on Windows Git Bash is part of it (§4 "required"),
  // so a git without Git Bash leaves step 4 not done.
  const bash = tool("git-bash");
  const gitWorks = report.gitWorks ?? (git ? git.found && (bash ? bash.found : true) : null);

  // The doctor's git identity row (OB-2). A report without it falls back to
  // the cached global email for both name and email; no email = not known yet.
  let gitIdentity: boolean | null;
  const reported = report.gitIdentity;
  if (typeof reported === "boolean") gitIdentity = reported;
  else if (reported && typeof reported === "object") gitIdentity = Boolean(reported.name && reported.email);
  else gitIdentity = userEmail ? true : null;

  // OB-2's `aiReady`: one AI works and is not seen signed out (Claude's
  // credential or "could not tell"; Codex's `auth.json`) — no process run.
  // Inside the AI step the step's own reads replace it (`withAiObserved`).
  // A report without the field (an older backend) falls back to installed
  // and recent enough.
  const aiReady =
    report.aiReady ??
    (claude || codex
      ? Boolean((claude?.found && claude.versionOk !== false) || (codex?.found && codex.versionOk !== false))
      : null);

  // Only a read that asked (`withAuth`) carries gh's sign-in; otherwise unknown.
  const githubSignedIn = gh?.auth ? gh.auth.signedIn : null;

  return { gitWorks, gitIdentity, aiReady, githubSignedIn };
}

/**
 * OB-5 (§4 "What required means"): inside the AI step, `claude auth status`
 * and `codex login status` decide `ai` (D2, D4). `observed` is the step's
 * answer — null while its reads are out, or when the step is not open —
 * and replaces the doctor's file-presence answer only when it has one.
 */
export function withAiObserved(facts: SetupFacts, observed: boolean | null): SetupFacts {
  return observed === null ? facts : { ...facts, aiReady: observed };
}

/**
 * OB-7a (§5 step 5): the GitHub step's own read (`gh auth status --json
 * hosts`, all accounts) decides `github` — done when at least one account is
 * signed in. `observed` is null until that read answers, and then replaces
 * the doctor's answer (which only Diagnostics asks for).
 */
export function withGithubObserved(facts: SetupFacts, observed: boolean | null): SetupFacts {
  return observed === null ? facts : { ...facts, githubSignedIn: observed };
}

// ── Leaving a step while its run goes on (§7) ────────────────────────────

/** The step whose actions start `actionId`, for a run Setup didn't see
 *  start (it was under way when Setup opened). `install.git` is the Git
 *  step's, though the AI step starts it too before Claude on Windows: a run
 *  seen starting is guarded on the step it started from. */
export function stepOfAction(actionId: string): SetupStepId {
  if (actionId === "project.clone") return "project";
  if (actionId.endsWith(".gh")) return "github";
  if (actionId === "install.git") return "git";
  return "ai";
}

/**
 * The run the leave guard asks about ("Stop the installer?" / "Stop signing
 * in?"): the run under way, when the step on screen is the one that started
 * it. Leaving any other step never asks. `startedOn` is where Setup saw the
 * run start; null for a run it didn't see start.
 */
export function guardedRun(
  running: string | null,
  startedOn: SetupStepId | null,
  shown: SetupStepId | null,
): string | null {
  if (!running || !shown) return null;
  return (startedOn ?? stepOfAction(running)) === shown ? running : null;
}

// ── The steps ────────────────────────────────────────────────────────────

export interface SetupStepDef {
  id: SetupStepId;
  /** The step list's name (§3.1). */
  title: string;
  /** The required items this step satisfies (§4). */
  required: readonly RequiredId[];
  /** Skipping is offered (§4.5): Skip for now, or — the Plyloft account,
   *  1.178.0 A3 — Continue without an account. Welcome and Ready have none. */
  skippable: boolean;
  /** Shown only in team mode (step 6, §3.1). */
  teamOnly: boolean;
}

export const SETUP_STEPS: readonly SetupStepDef[] = [
  { id: "welcome", title: "Welcome", required: [], skippable: false, teamOnly: false },
  // Launch A2: not a §4 required item. 1.178.0 (A3): optional, "Only for
  // teams" — Continue without an account marks it Skipped (the footer has
  // no Skip for now of its own: Continue is the way on).
  { id: "account", title: "Plyloft account", required: [], skippable: true, teamOnly: false },
  // 1.175.0 F1 (UX-2): right after the account, so a second GitHub code
  // (for whoever signed in to Plyloft) follows the first instead of coming
  // three steps later. It needs neither
  // Git nor an AI; what it does for Git waits for the Git step when Git
  // isn't installed yet.
  { id: "github", title: "GitHub for your projects", required: [], skippable: true, teamOnly: false },
  // 1.175.0 F2 (UX-3): not in the list. Plyloft deduces solo or team
  // (`deduceWorkMode`); the question is shown only when asked for, from the
  // link under the step list ("Joining a team? Add the team step").
  { id: "mode", title: "Solo or team", required: [], skippable: false, teamOnly: false },
  { id: "ai", title: "Your AI", required: ["ai"], skippable: true, teamOnly: false },
  { id: "git", title: "Git and your name", required: ["git", "identity"], skippable: true, teamOnly: false },
  { id: "team", title: "Your team", required: [], skippable: true, teamOnly: true },
  // 1.175.0 F2: not in the list either. The projects folder is a row inside
  // "Your first project", in the two ways that make a folder, and is saved
  // at the first creation or download. The id stays for resume points and
  // Ready's "What you have".
  { id: "folder", title: "Where your projects live", required: [], skippable: true, teamOnly: false },
  { id: "project", title: "Your first project", required: ["project"], skippable: true, teamOnly: false },
  { id: "config", title: "Project settings", required: ["project"], skippable: true, teamOnly: false },
  { id: "ready", title: "Ready", required: [], skippable: false, teamOnly: false },
];

// The table and the stable ids (settings.rs::SETUP_STEP_IDS) must agree.
if (SETUP_STEPS.map((s) => s.id).join() !== SETUP_STEP_IDS.join()) {
  throw new Error("setupSteps: SETUP_STEPS is out of step with SETUP_STEP_IDS");
}

export function stepDef(id: SetupStepId): SetupStepDef {
  return SETUP_STEPS.find((s) => s.id === id)!;
}

/** A stored step id this build knows, or null (a later release may drop one). */
export function knownStepId(raw: unknown): SetupStepId | null {
  return typeof raw === "string" && (SETUP_STEP_IDS as readonly string[]).includes(raw)
    ? (raw as SetupStepId)
    : null;
}

/**
 * 1.175.0 Y3: how many projects there are, as Setup's facts take it. Not
 * known (`null`) before the list is read — and while the project list is in
 * trouble this launch and holds none: the list was set aside as unreadable,
 * or refused (a newer Plyloft saved it), so "none" is not "none was ever
 * added". The Finish row then isn't drawn and the project list's own notice
 * is what speaks. With a project in it (one added after a set-aside list)
 * the count is the count again.
 */
export function setupWorkspaceCount(
  loaded: boolean,
  count: number,
  listTrouble: "pending" | "setAside" | "refused" | null,
): number | null {
  if (!loaded) return null;
  if (count === 0 && listTrouble !== null) return null;
  return count;
}

/** Which required items are missing. Unknown facts are not counted missing
 *  (a probe that has not answered must not raise "Setup isn't finished"):
 *  with workspaces but the config list not read yet, `project` is unknown;
 *  with none at all it is missing. */
export function missingRequired(facts: SetupFacts): RequiredId[] {
  const out: RequiredId[] = [];
  if (facts.gitWorks === false) out.push("git");
  if (facts.gitIdentity === false) out.push("identity");
  if (facts.aiReady === false) out.push("ai");
  const workspaces = facts.workspaceCount;
  if (
    workspaces === 0 ||
    (workspaces !== null && (facts.configuredWorkspaceCount === 0 || facts.projectRepoReady === false))
  ) {
    out.push("project");
  }
  return out;
}

/** Every required item seen satisfied (unknown is not satisfied). */
export function requiredComplete(facts: SetupFacts): boolean {
  return (
    facts.gitWorks === true &&
    facts.gitIdentity === true &&
    facts.aiReady === true &&
    projectReady(facts)
  );
}

/** §4 `project`: a workspace that is a Git repo with a commit on its target
 *  branch (OB-12, `projectRepoReady` where it was read) and has a project
 *  config. */
function projectReady(facts: SetupFacts): boolean {
  return (
    (facts.workspaceCount ?? 0) > 0 &&
    (facts.configuredWorkspaceCount ?? 0) > 0 &&
    repoSeenReady(facts) === true
  );
}

/** The repo-with-a-commit half of `project`: what Setup read, or — where it
 *  wasn't read — true once a workspace exists. */
function repoSeenReady(facts: SetupFacts): boolean | null {
  if (facts.workspaceCount === null) return null;
  if (facts.workspaceCount === 0) return false;
  return facts.projectRepoReady === undefined ? true : facts.projectRepoReady;
}

/** Whether the step's own condition is seen true, false, or not known. */
function detected(id: SetupStepId, f: SetupFacts): boolean | null {
  switch (id) {
    case "welcome":
      return f.level !== null;
    case "account":
      return f.plyloftSignedIn ?? null;
    case "mode":
      return f.workModeChosen;
    case "ai":
      return f.aiReady;
    case "git":
      if (f.gitWorks === false || f.gitIdentity === false) return false;
      if (f.gitWorks === null || f.gitIdentity === null) return null;
      return true;
    case "github":
      return f.githubSignedIn;
    case "team":
      return f.teamJoined;
    case "folder":
      return f.projectsFolderChosen;
    case "project":
      // §5 step 8 "Success": a workspace that is a Git repo with a commit on
      // the target branch.
      return repoSeenReady(f);
    case "config":
      if (f.activeConfigured !== undefined) return f.activeConfigured;
      return f.configuredWorkspaceCount === null ? null : f.configuredWorkspaceCount > 0;
    case "ready":
      return requiredComplete(f);
  }
}

/** One step's state: detected done wins; then skipped (only where skipping
 *  is offered); then `needs` for a required step seen missing; else empty. */
export function stepState(
  id: SetupStepId,
  facts: SetupFacts,
  skipped: Record<string, string> | undefined,
): StepState {
  const def = stepDef(id);
  const seen = detected(id, facts);
  if (seen === true) return "done";
  if (def.skippable && skipped && typeof skipped[id] === "string") return "skipped";
  // 1.178.0 (A3): the account is optional — never "Needs you" by itself.
  if (def.required.length > 0 && seen === false) return "needs";
  return "empty";
}

export interface SetupStepView extends SetupStepDef {
  /** 1-based, among the applicable steps (solo sees "of 9"). */
  number: number;
  state: StepState;
}

/** The ids never in the list by themselves (F2): the folder is a row of
 *  "Your first project"; the solo/team question only when asked for. */
const ON_REQUEST: readonly SetupStepId[] = ["mode", "folder"];

/** The steps this person sees: Team only in team mode; Solo or team only
 *  when the person asked for it (F2, `modeAsked`); the folder never. */
export function applicableSteps(workMode: WorkMode, modeAsked = false): SetupStepDef[] {
  return SETUP_STEPS.filter(
    (s) => (!s.teamOnly || workMode === "team") && (!ON_REQUEST.includes(s.id) || (s.id === "mode" && modeAsked)),
  );
}

/** The step list, numbered and with each state. */
export function deriveSteps(
  facts: SetupFacts,
  skipped: Record<string, string> | undefined,
  modeAsked = false,
): SetupStepView[] {
  return applicableSteps(facts.workMode, modeAsked).map((s, i) => ({
    ...s,
    number: i + 1,
    state: stepState(s.id, facts, skipped),
  }));
}

/** The progress bar: steps done or skipped, over the applicable ones. */
export function progress(steps: readonly SetupStepView[]): { settled: number; total: number; percent: number } {
  const settled = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const total = steps.length;
  return { settled, total, percent: total === 0 ? 0 : Math.round((settled / total) * 100) };
}

/** SP-7: the words beside the bar — "6 of 9 done", "6 of 9 done or
 *  skipped" once a step was skipped (the bar counts both). */
export function progressCaption(steps: readonly SetupStepView[]): string {
  const { settled, total } = progress(steps);
  const skipped = steps.some((s) => s.state === "skipped");
  return `${settled} of ${total} ${skipped ? "done or skipped" : "done"}`;
}

/** "Step 3 of 11" for an applicable step; the id's nearest applicable
 *  neighbour otherwise (never throws). */
export function stepLine(steps: readonly SetupStepView[], id: SetupStepId): string {
  const at = steps.find((s) => s.id === id);
  return `Step ${at ? at.number : 1} of ${steps.length}`;
}

/** The step before and after `id` among the applicable ones. */
export function neighbours(
  steps: readonly SetupStepView[],
  id: SetupStepId,
): { prev: SetupStepId | null; next: SetupStepId | null } {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) return { prev: null, next: steps[0]?.id ?? null };
  return { prev: steps[i - 1]?.id ?? null, next: steps[i + 1]?.id ?? null };
}

/**
 * QoL 7.1 (B1): where the guided path's Continue goes — the next step after
 * `id` that is neither done nor skipped, so a Mac where Git, the name and
 * Claude are already fine is not walked through their "Done" screens.
 * Ready when every later step is settled. A step whose fact is not known yet
 * is not settled, and is shown. The settled steps stay in the list.
 * `unsure` (Challenger): steps whose "done" is a guess — the AI step's from
 * the doctor's file-presence read ("could not tell" counts signed in) — are
 * shown unless skipped; only a definite answer passes one over.
 */
export function nextOpenStep(
  steps: readonly SetupStepView[],
  id: SetupStepId,
  unsure: readonly SetupStepId[] = [],
): SetupStepId | null {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) return steps[0]?.id ?? null;
  if (id === "ready") return null;
  const open = steps
    .slice(i + 1)
    .find(
      (s) =>
        s.id !== "ready" && s.state !== "skipped" && (s.state !== "done" || unsure.includes(s.id)),
    );
  return open?.id ?? (steps.some((s) => s.id === "ready") ? "ready" : null);
}

/** QoL 7.1: the steps Continue passed over between `from` and `to` because
 *  they were done — what Ready says Plyloft found already set up. */
export function passedOverSteps(
  steps: readonly SetupStepView[],
  from: SetupStepId,
  to: SetupStepId | null,
  unsure: readonly SetupStepId[] = [],
): SetupStepId[] {
  const i = steps.findIndex((s) => s.id === from);
  const j = to === null ? steps.length : steps.findIndex((s) => s.id === to);
  if (i < 0 || j <= i) return [];
  return steps
    .slice(i + 1, j)
    .filter((s) => s.state === "done" && !unsure.includes(s.id))
    .map((s) => s.id);
}

/** QoL 7.1: Ready's line for what Plyloft found done and passed over, or
 *  null when nothing was. Only the steps with a fact of the Mac (not the
 *  answers the person gave), and only those still done now (Windows walk:
 *  never a step Ready's own rows say isn't). The Plyloft account is the
 *  person's own sign-in, not something found, so it is never named. */
export function foundAlreadyLine(steps: readonly SetupStepView[], passed: readonly SetupStepId[]): string | null {
  const FOUND: Partial<Record<SetupStepId, string>> = {
    ai: "your AI",
    git: "Git and your name",
    github: "GitHub",
    team: "your team",
    folder: "your projects folder",
    project: "your project",
    config: "how your project builds",
  };
  const names = steps
    .filter((s) => passed.includes(s.id) && s.state === "done" && FOUND[s.id])
    .map((s) => FOUND[s.id]!);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Plyloft found ${list} already set up, so Setup didn't stop there.`;
}

/** `id` if it is shown, else the next shown step after it in the full order
 *  (a solo person resuming on `team` lands on `project`). F2: a resume point
 *  on `mode`, which 1.174.5 asked everyone, lands on the first step not
 *  settled after the account (the deduction answers the question by itself),
 *  and one on `folder` lands on "Your first project", where the folder's row
 *  now is. */
export function applicableOrNext(steps: readonly SetupStepView[], id: SetupStepId): SetupStepId {
  if (steps.some((s) => s.id === id)) return id;
  if (id === "mode") return nextOpenStep(steps, "account") ?? "ready";
  const order = SETUP_STEPS.map((s) => s.id);
  for (let i = order.indexOf(id) + 1; i < order.length; i++) {
    if (steps.some((s) => s.id === order[i])) return order[i];
  }
  return steps[steps.length - 1]?.id ?? "ready";
}

/** The first step with something left: neither done nor skipped. Ready when
 *  every other step is settled. */
export function firstOpenStep(steps: readonly SetupStepView[]): SetupStepId {
  const open = steps.find((s) => s.id !== "ready" && s.state !== "done" && s.state !== "skipped");
  return open?.id ?? "ready";
}

/**
 * The first step whose required item is missing (the "Finish" row, §9.1).
 * With `missing` (OB-15), only a step that satisfies one of those items and
 * is not done: an AI step whose fact is still unknown is passed over when
 * what is known missing is the project.
 */
export function firstMissingRequiredStep(
  steps: readonly SetupStepView[],
  missing?: readonly RequiredId[],
): SetupStepId | null {
  return (
    steps.find(
      (s) =>
        s.required.length > 0 &&
        s.state !== "done" &&
        (!missing || s.required.some((r) => missing.includes(r))),
    )?.id ?? null
  );
}

// ── The "Finish setup" row and the Setup page's summary (OB-15, §9) ──────

/** What the Setup page and the Finish row say about each required item. */
export interface RequiredItemView {
  id: RequiredId;
  /** The Setup page's row label. */
  label: string;
  state: "done" | "missing" | "unknown";
  /** The row's state words. */
  words: string;
  /** The step `Fix` opens. */
  step: SetupStepId;
  /** The Finish row's words for it, after "Still to do:". */
  todo: string;
}

/** What the words need beyond the facts: whether an AI tool is installed at
 *  all (so "install" or "sign in"), from the doctor. */
export interface RequiredWordsInput {
  aiInstalled: boolean | null;
  /** 1.176.1 walk: Program folders is set, so what isn't found may be
   *  installed outside it: "Not in your Program folders", not "Not installed". */
  programFolders?: boolean;
}

/** §4's required items, each with its state and its way into Setup. */
export function requiredItems(facts: SetupFacts, words: RequiredWordsInput): RequiredItemView[] {
  const missing = missingRequired(facts);
  const state = (id: RequiredId, known: boolean | null): RequiredItemView["state"] =>
    missing.includes(id) ? "missing" : known === true ? "done" : "unknown";
  // OB-12: a workspace without a commit on its target branch (where Setup
  // read it) is step 8's to fix, before any config.
  const noCommit = (facts.workspaceCount ?? 0) > 0 && facts.projectRepoReady === false;
  const projectKnown: boolean | null =
    facts.workspaceCount === 0 || noCommit
      ? false
      : facts.workspaceCount === null || facts.configuredWorkspaceCount === null
        ? null
        : facts.configuredWorkspaceCount > 0 && repoSeenReady(facts) === true
          ? true
          : facts.configuredWorkspaceCount === 0
            ? false
            : null;
  const aiInstalled = words.aiInstalled === true;
  return [
    {
      id: "git",
      label: "Git",
      state: state("git", facts.gitWorks),
      words:
        facts.gitWorks === true
          ? "Works"
          : facts.gitWorks === false
            ? words.programFolders
              ? "Not in your Program folders"
              : "Not installed"
            : "Not checked yet",
      step: "git",
      todo: "install Git",
    },
    {
      id: "identity",
      label: "Your name and email",
      state: state("identity", facts.gitIdentity),
      words: facts.gitIdentity === true ? "Set" : facts.gitIdentity === false ? "Not set" : "Not checked yet",
      step: "git",
      todo: "give Git your name and email",
    },
    {
      id: "ai",
      label: "An AI tool",
      state: state("ai", facts.aiReady),
      words:
        facts.aiReady === true
          ? "Ready"
          : facts.aiReady === false
            ? aiInstalled
              ? "Not signed in"
              : words.programFolders
                ? "Not in your Program folders"
                : "Not installed"
            : "Not checked yet",
      step: "ai",
      todo: aiInstalled ? "sign in to an AI tool" : "install an AI tool",
    },
    {
      id: "project",
      label: "A first project",
      state: state("project", projectKnown),
      words:
        projectKnown === true
          ? "Ready"
          : facts.workspaceCount === 0
            ? "None yet"
            : noCommit
              ? "No saved version yet"
              : projectKnown === false
                ? "Not set up for builds"
                : "Not checked yet",
      step: facts.workspaceCount === 0 || noCommit ? "project" : "config",
      todo:
        facts.workspaceCount === 0
          ? "add a first project"
          : noCommit
            ? "save your project's first version"
            : "set up your project's builds",
    },
  ];
}

/** 1.176.4: Ready's last screen when a required item is still missing: its
 *  title, and one sentence naming what won't work until it is done. Null when
 *  nothing is missing (the screen is "Plyloft is ready", as it was). */
export const UNFINISHED_TITLE = "Setup isn't finished";
const WONT_WORK: Record<RequiredId, string> = {
  ai: "No AI tool is ready, so Plyloft can't build a card yet.",
  git: "Git isn't working, so cards can't get their own copy of your code.",
  identity: "Git needs your name and email before Plyloft can make a commit.",
  project: "There's no project ready for builds yet.",
};
export function readyUnfinished(items: readonly RequiredItemView[]): { title: string; text: string } | null {
  const order: RequiredId[] = ["ai", "git", "identity", "project"];
  // A project whose only gap is its build settings is no "project not ready":
  // the tour's press saves them (UX P-C), so the sentence leaves it out.
  const gap = (i: RequiredItemView) => i.state === "missing" && !(i.id === "project" && i.step === "config");
  const lines = order.filter((id) => items.some((i) => i.id === id && gap(i))).map((id) => WONT_WORK[id]);
  if (lines.length === 0) return null;
  return { title: UNFINISHED_TITLE, text: lines.join(" ") };
}

/** 1.176.4 (e): what skipping a step leaves undone, in a sentence, modeled on
 *  GitHub's ("Ship it will keep your changes on this Mac."). Null for a step
 *  with nothing to say. `gitWorks`: Git is there and only the name is missing. */
export function skipConsequence(id: SetupStepId, gitWorks: boolean | null): string | null {
  if (id === "ai") return "Plyloft can't build cards until an AI tool is ready.";
  if (id === "git") {
    return gitWorks === true
      ? "Plyloft can't make a commit until Git has your name and email."
      : "Plyloft can't give cards their own copy of your code until Git works.";
  }
  return null;
}

/** 1.176.4: the tour is offered on Ready only with a project and an AI tool
 *  ready (it builds a first card). The project is the required item's: not
 *  missing, or missing only for its settings (`step: "config"`, which the
 *  press saves first, UX P-C) — never a workspace with no saved version, which
 *  Ready's own sentence calls "no project ready for builds". */
export function tourOffered(facts: SetupFacts, items: readonly RequiredItemView[]): boolean {
  const project = items.find((i) => i.id === "project");
  return (
    facts.aiReady === true &&
    (facts.workspaceCount ?? 0) > 0 &&
    project !== undefined &&
    (project.state !== "missing" || project.step === "config")
  );
}

/** The Finish row's tooltip (§9.1): "Still to do: sign in to an AI tool, add
 *  a first project." */
export function stillToDo(items: readonly RequiredItemView[]): string {
  const todo = items.filter((i) => i.state === "missing").map((i) => i.todo);
  return todo.length === 0 ? "" : `Still to do: ${todo.join(", ")}.`;
}

/** The required items the doctor's own sidebar rows already say ("git isn't
 *  installed · Fix", "No AI tool is installed · Fix"). */
const DOCTOR_SAYS: readonly RequiredId[] = ["git", "ai"];

/** The Finish row (§9.1), when it is drawn. */
export interface FinishRowView {
  text: "Setup isn't finished";
  action: "Finish";
  /** The missing items in words. */
  title: string;
  /** Where Finish opens Setup. */
  step: SetupStepId;
}

/**
 * §9.1: whether the sidebar draws "Setup isn't finished · Finish" — while a
 * required item is seen missing and Setup is closed. While it shows, the
 * doctor's own rows for the same facts are not drawn (one row, not two).
 *
 * "After Setup is complete, the doctor's row returns for regressions": done
 * is detected, never remembered (§3.2), so "complete" is read from what is
 * there — a project set up for builds (the last required item) — and from
 * what the person told Setup (`skipped`). A Mac with a set-up project that
 * later loses only Git or its AI tool, whose step was never skipped, is a
 * regression: the doctor's row says what went, and Fix opens Diagnostics.
 * Anything else missing — a name and email, a project, or a step skipped —
 * is Setup not finished.
 */
export function finishRow(
  facts: SetupFacts,
  skipped: Record<string, string> | undefined,
  setupOpen: boolean,
  words: RequiredWordsInput,
  /** `onboarding.currentStep`: a Setup closed before Ready reopens there. */
  resumeAt?: unknown,
): FinishRowView | null {
  if (setupOpen) return null;
  // Workspaces whose configs aren't read yet (or couldn't be): whether Setup
  // was finished can't be told, so the doctor's own rows speak until then.
  // Nor before the workspace list is read (an empty list at launch is not
  // "no project yet").
  if (facts.workspaceCount === null) return null;
  if (facts.workspaceCount > 0 && facts.configuredWorkspaceCount === null) return null;
  const missing = missingRequired(facts);
  if (missing.length === 0) return null;
  const skippedStep = (id: RequiredId) =>
    SETUP_STEPS.some(
      (s) => s.required.includes(id) && skipped != null && typeof skipped[s.id] === "string",
    );
  const regression =
    projectReady(facts) && missing.every((id) => DOCTOR_SAYS.includes(id) && !skippedStep(id));
  if (regression) return null;
  const steps = deriveSteps(facts, skipped);
  const items = requiredItems(facts, words);
  return {
    text: "Setup isn't finished",
    action: "Finish",
    title: stillToDo(items),
    step: finishStep(
      resumePoint(resumeAt, steps),
      firstMissingRequiredStep(steps, missing) ?? items.find((i) => i.state === "missing")!.step,
    ),
  };
}

/** Where Finish opens: where Setup was closed before Ready, unless a
 *  required step is missing before it — then that step (review of the
 *  immediacy walk fixes). */
function finishStep(resumed: SetupStepId | null, firstMissing: SetupStepId): SetupStepId {
  if (!resumed) return firstMissing;
  const order = SETUP_STEPS.map((s) => s.id);
  return order.indexOf(firstMissing) < order.indexOf(resumed) ? firstMissing : resumed;
}

/** The Setup page's Setup row (§9.2): "Done." once every required item is
 *  there, else how many of the steps are done. */
export function setupSummary(steps: readonly SetupStepView[], facts: SetupFacts): string {
  if (requiredComplete(facts)) return "Done.";
  const done = steps.filter((s) => s.state === "done").length;
  return `${done} of ${steps.length} steps done.`;
}

/** What the facts are built from outside Setup (the sidebar, Settings):
 *  the stores as they are, with no process run for a sign-in (§4). */
export interface FactsSources {
  report: DoctorFactsInput | null;
  userEmail: string | null;
  level: SetupLevel | null;
  /** `settings.team.workMode`. */
  chosenMode: WorkMode | null;
  /** The mode Plyloft follows (`team_work_mode`), when read. */
  followedMode: WorkMode | null;
  teamJoined: boolean;
  projectsFolder: string | null;
  /** Null until the workspace list is read. */
  workspaceCount: number | null;
  configuredWorkspaceCount: number | null;
  /** OB-7a's read of gh's accounts, when there is one. */
  githubSignedIn?: boolean | null;
  /** Launch A2: the Plyloft account, where the surface reads it. */
  plyloftSignedIn?: boolean | null;
}

/** 1.175.0 F2: what `setup_team_hint` read from GitHub once it was
 *  connected (`lib/setupTeamHint.ts`), or null while it hasn't answered. */
export interface TeamHintFacts {
  /** GitHub answered. False: not signed in, offline, refused — solo. */
  read: boolean;
  /** `owner/name` of each Plyloft team listing the account. */
  teams: readonly string[];
  /** Repository invitations waiting for the account. */
  invitations: number;
}

export interface WorkModeClues {
  /** `settings.team.workMode`: the person already chose on this computer. */
  chosen: WorkMode | null;
  /** The mode Plyloft follows (`team_work_mode`): a team joined, a board
   *  on GitHub Issues (U6). */
  effective: WorkMode | null | undefined;
  /** The Plyloft account's plan and role: Team, owned or with a seat. */
  account: { plan?: string | null; teamRole?: string | null } | null | undefined;
  /** A project on this computer uses a GitHub Issues board (`soloRefusal`). */
  boardOnGithub: boolean;
  /** GitHub's answer, once step 3 is behind: null while it isn't read, and
   *  `read: false` where it can't be (skipped, offline, signed out). */
  hint: TeamHintFacts | null;
}

export type WorkModeReason = "chosen" | "plan" | "team" | "invitation" | "board" | "none";

/**
 * 1.175.0 F2 (UX-3, I4): solo or team, deduced instead of asked — mockup
 * §2a's table, top row first. Null while the only thing left to look at is
 * GitHub's answer and it isn't in yet: the list stays as it is until then,
 * and nothing is saved. The step list follows what Plyloft deduces, and
 * the question is never asked by itself; the link under the step list asks
 * it. Only a team is saved (`deductionSaves`).
 */
export function deduceWorkMode(c: WorkModeClues): { mode: WorkMode; reason: WorkModeReason } | null {
  if (c.chosen) return { mode: c.chosen, reason: "chosen" };
  if (c.account?.plan === "team" && Boolean(c.account.teamRole)) return { mode: "team", reason: "plan" };
  if (c.boardOnGithub) return { mode: "team", reason: "board" };
  if (c.effective === "team") return { mode: "team", reason: "team" };
  if (c.hint === null) return null;
  if (c.hint.read && c.hint.teams.length > 0) return { mode: "team", reason: "team" };
  if (c.hint.read && c.hint.invitations > 0) return { mode: "team", reason: "invitation" };
  return { mode: "solo", reason: "none" };
}

/**
 * F2 round 2 (review): which deductions are saved as the choice. Only
 * team, and not from an invitation alone: a saved solo would outrank every
 * team signal that comes later (Rust's `effective_work_mode` lets a choice
 * win over a team joined or a Team plan bought after Setup), and an
 * invitation is only a team once the person joins it. What isn't saved
 * still decides the step list; today's derivation (solo with no signal,
 * team once one appears) goes on working.
 */
export function deductionSaves(d: { mode: WorkMode; reason: WorkModeReason } | null): boolean {
  return d !== null && d.mode === "team" && d.reason !== "invitation" && d.reason !== "chosen";
}

/** The link under the step list while the deduction said solo (F2, I4):
 *  the question's way back in for an invited member GitHub doesn't list
 *  yet (UX-20). Null once the question is in the list, or in team mode. */
export const TEAM_STEP_LINK = { lead: "Joining a team?", label: "Add the team step" } as const;
export function teamStepLinkShown(listMode: WorkMode, modeAsked: boolean): boolean {
  return listMode === "solo" && !modeAsked;
}

/** The question's first sentence when it is asked for (F2, mockup §2a):
 *  why the person sees it. `login` is the GitHub account the deduction
 *  looked for; without one, the account as such. */
export function modeAskedWhy(login: string | null): string {
  const who = login ? `for ${login}` : "for this account";
  return `Plyloft found no team ${who}, so it set you up on your own. You can change this later in Settings.`;
}

/** 1.174.3: the mode the step list follows. With a team, preselected or pressed,
 *  puts Your team in the list before Continue saves it: for as long as no mode
 *  has been chosen, so pressing a row doesn't take the row away, and otherwise
 *  on step 3, on Your team itself and during Continue's save. Nothing is saved
 *  by this. */
export function workModeInList(
  inForce: WorkMode,
  shown: SetupStepId | null,
  selected: WorkMode | null,
  saving: boolean,
  chosen: boolean,
): WorkMode {
  const follows = !chosen || saving || shown === "mode" || shown === "team";
  return follows && selected === "team" ? "team" : inForce;
}

export function setupFactsFrom(src: FactsSources): SetupFacts {
  const doctor = doctorFacts(src.report, src.userEmail);
  return {
    ...doctor,
    githubSignedIn: src.githubSignedIn ?? doctor.githubSignedIn,
    level: src.level,
    // U6: a GitHub Issues board makes it team even over a chosen solo
    // (`team::effective_work_mode`): the checklist says what is in force.
    workMode: src.chosenMode === "solo" && src.followedMode === "team" ? "team" : (src.chosenMode ?? src.followedMode ?? "solo"),
    workModeChosen: src.chosenMode !== null,
    teamJoined: src.teamJoined,
    projectsFolderChosen: Boolean(src.projectsFolder),
    workspaceCount: src.workspaceCount,
    configuredWorkspaceCount: src.configuredWorkspaceCount,
    ...(src.plyloftSignedIn !== undefined ? { plyloftSignedIn: src.plyloftSignedIn } : {}),
  };
}

/**
 * Where a Setup closed before Ready stopped (1.175.0, immediacy walk 1.4 /
 * 2.7): the stored step, or the next one this list shows. `null` when Setup
 * was finished (closed on Ready) or nothing this build knows is stored.
 */
export function resumePoint(currentStep: unknown, steps: readonly SetupStepView[]): SetupStepId | null {
  const id = knownStepId(currentStep);
  return id && id !== "ready" ? applicableOrNext(steps, id) : null;
}

/**
 * Where Setup opens (§3.3): the stored resume point when it is one this build
 * knows (quit mid-setup); else step 1 on a first run; else — an existing user
 * seeing it the first time — the first step not settled. A rerun re-detects
 * everything and starts at the first step not settled (§5.11) once Setup was
 * finished; one closed before Ready opens where it was closed (1.175.0).
 */
export function startStep(
  setupCase: SetupCase,
  currentStep: unknown,
  steps: readonly SetupStepView[],
): SetupStepId {
  if (setupCase === "rerun") return resumePoint(currentStep, steps) ?? firstOpenStep(steps);
  const stored = knownStepId(currentStep);
  if (stored) return applicableOrNext(steps, stored);
  if (setupCase === "firstRun") return "welcome";
  return firstOpenStep(steps);
}

/**
 * Whether Setup opens *by itself* at launch. It was false while the
 * onboarding series was being built (steps 3–9 were placeholders, and an
 * existing user must not be shown Setup once and have it stamped away);
 * OB-17 turned it on. SETUP_VERSION stayed 1: no build with the automatic
 * open off was ever released or installed (v1.152.1, the last release, has
 * no `setupVersion` at all), so no Mac holds a stamp from an unfinished
 * Setup. It gates only the automatic open; Settings › Account › Setup and
 * ⌘K "Open setup" (OB-15) open Setup regardless.
 */
export const SETUP_AUTO_OPEN = true;

let autoOpenForTests: boolean | null = null;

/** SETUP_AUTO_OPEN, unless a test forced it. */
export function setupAutoOpens(): boolean {
  return autoOpenForTests ?? SETUP_AUTO_OPEN;
}

/** Tests only: force the automatic open on or off; null goes back to the
 *  constant. */
export function setSetupAutoOpenForTests(value: boolean | null): void {
  autoOpenForTests = value;
}

/** What the onboarding block says about opening Setup at launch. */
export interface OnboardingSnapshot {
  firstRunCompletedAt: string | null;
  setupVersion?: number | null;
}

/**
 * §3.3: whether Setup opens by itself at launch, and as which case. It opens
 * while this Mac has never closed a Setup (`setupVersion` absent) — a fresh
 * install, an existing user upgrading (once, D1), or someone who quit
 * mid-setup. 1.178.0 (A3, D6): one that closed Setup 1 is not reopened for
 * the optional account step (`stampsWithoutOpening`). Closing stamps
 * `setupVersion`, so a Setup closed with something
 * required still missing does not come back on its own (the sidebar row
 * does, OB-15).
 *
 * A first run is a Mac whose welcome was never finished: `lib.rs` backfills
 * `firstRunCompletedAt` for every install that already has workspaces.
 */
export function launchCase(onboarding: OnboardingSnapshot | undefined | null): SetupCase | null {
  const seen = onboarding?.setupVersion;
  if (typeof seen === "number" && seen >= 1) return null;
  return onboarding?.firstRunCompletedAt ? "existing" : "firstRun";
}

/**
 * 1.178.0 (A3, D6): a Mac that closed Setup 1 (`setupVersion` older than
 * this one). Setup 2's only new step was the Plyloft account, which is
 * optional now: Setup doesn't open for it. App stamps this Setup as seen,
 * as it already did for an account signed in (`closedOnboarding`);
 * SETUP_VERSION stays 2.
 */
export function stampsWithoutOpening(onboarding: OnboardingSnapshot | undefined | null): boolean {
  const seen = onboarding?.setupVersion;
  return typeof seen === "number" && seen >= 1 && seen < SETUP_VERSION;
}

/** §5.0: the header's title and sentence per case. */
export function headerCopy(setupCase: SetupCase): { title: string; sentence: string } {
  switch (setupCase) {
    case "firstRun":
      return {
        title: "Set up Plyloft",
        // 1.171.0 A3 (walk#1): no "about ten minutes" — it took one.
        sentence: "A few steps, plus the time to download what it installs. You can stop at any point and pick up where you left off.",
      };
    case "existing":
      return {
        title: "Plyloft can now set itself up",
        sentence: "We checked what's already on this Mac. Steps marked done need nothing from you.",
      };
    case "rerun":
      return {
        title: "Setup",
        sentence: "Everything Plyloft needs, and what it found on this Mac just now.",
      };
  }
}

/** The header link that changes the path (§3.2). Unset reads as step by step. */
export function levelSwitch(level: SetupLevel | null): { label: string; to: SetupLevel } {
  return level === "fast"
    ? { label: "Switch to step by step", to: "guided" }
    : { label: "Switch to just the essentials", to: "fast" };
}

/** The state word the list and the checklist draw (never colour alone). */
export function stateWord(state: StepState): string | null {
  switch (state) {
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
    case "needs":
      return "Needs you";
    case "empty":
      return null;
  }
}

/**
 * Step 2's refusal (§5 step 2): `On my own` while a workspace's board is
 * backed by GitHub Issues, which is a team feature. The first such
 * workspace, or null when solo is allowed.
 */
export function soloRefusal(
  workspaces: readonly { id: string; name: string; kanbanSyncMode?: string | null }[],
): { workspaceId: string; name: string; sentence: string } | null {
  const ws = workspaces.find((w) => w.kanbanSyncMode === "githubIssues");
  if (!ws) return null;
  return {
    workspaceId: ws.id,
    name: ws.name,
    sentence: `“${ws.name}” uses a GitHub Issues board, which is a team feature. Switch its board to Local first, or keep team on.`,
  };
}

/** Step 2's detected-team line, when a team signal names one. */
export function detectedTeamLine(teamName: string | null | undefined): string | null {
  const name = teamName?.trim();
  return name ? `Plyloft found a team on this Mac: “${name}”.` : null;
}

/** What Close setup (and finishing Ready) writes into `onboarding`: the
 *  version seen, the resume point, and the old first-run stamp for
 *  compatibility (a downgrade must not show the old welcome again). */
export function closedOnboarding<T extends { firstRunCompletedAt: string | null }>(
  onboarding: T,
  currentStep: SetupStepId,
  now: string,
): T & { setupVersion: number; currentStep: string } {
  return {
    ...onboarding,
    firstRunCompletedAt: onboarding.firstRunCompletedAt ?? now,
    setupVersion: SETUP_VERSION,
    currentStep,
  };
}
