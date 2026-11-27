// OB-5 (ONBOARDING_SPEC §5 step 3): the AI tools step's words and decisions,
// pure. Each tool's row is derived from what Plyloft sees — the doctor's row
// (found, works, a newer release), the step's own sign-in read
// (`status.claude` / `status.codex`, D2/D4) and the guided run under way — never remembered.
//
// Tests: `node --experimental-strip-types src/lib/aiTools.test.ts`.
import type {
  SetupOutcome,
  SetupPhase,
  SetupReach,
  SetupGuidedActionId,
  SetupRunActionId,
  SetupSignInAnswer,
} from "../ipc.ts";
import type { UxError } from "./uxError.ts";
import { isRepairAction } from "./repairAction.ts";
import { backendMarkTool, showBackendText } from "./backendMarks.ts";
import { CLI_REPAIR_ACTION } from "./cliNotStarting.ts";
import type { SetupRunEvidence } from "./setupEvidence.ts";

export type AiTool = "claude" | "codex";
export const AI_TOOLS: readonly AiTool[] = ["claude", "codex"];

export const TOOL_NAME: Record<AiTool, string> = { claude: "Claude Code", codex: "Codex" };

/** What the doctor says about one tool. */
export interface ToolFacts {
  found: boolean;
  /** Claude: recent enough (`versionOk`); Codex: starts (`codex_healthy`). */
  works: boolean;
  /** 1.176.0 R3: it answered `--version` (Claude's `claude_healthy`). Unset:
   *  read from `works` (Codex) or taken as yes (Claude), as before. */
  starts?: boolean;
  /** A newer release (D6), when the doctor read one. */
  update: { latest: string; command: string } | null;
  /** What Install runs (`doctor::install_cmd_on`), for the sheet's Details. */
  installCmd: string;
}

/** The step's sign-in read of one tool. */
export type SignIn =
  | { kind: "unread" }
  | { kind: "checking" }
  | { kind: "answer"; answer: SetupSignInAnswer };

/** The guided run as the store holds it. */
export interface RunView {
  actionId: SetupGuidedActionId;
  phase: SetupPhase | null;
  outcome: SetupOutcome | null;
}

export type RowState =
  | "missing"
  | "installing"
  | "updating"
  | "not-found-yet"
  | "too-old"
  | "broken"
  | "checking"
  | "signed-out"
  | "signing-in"
  | "unsure"
  | "ready";

/** `program-folders` (1.176.1 walk): the tool is missing while Program
 *  folders is set — it opens that row; it never installs. */
export type RowActionId = "install" | "update" | "reinstall" | "sign-in" | "check-again" | "program-folders";

export interface RowAction {
  id: RowActionId;
  label: string;
  /** Offered, not asked for: an update, a sign-in when Plyloft couldn't tell. */
  quiet: boolean;
}

/** Whether the tool can run cards: seen signed in, maybe (could not tell),
 *  not, or not known yet (a read or a run under way). */
export type Usable = "yes" | "maybe" | "no" | "pending";

export interface RowView {
  tool: AiTool;
  state: RowState;
  words: string;
  action: RowAction | null;
  usable: Usable;
}

/** The run that opens Claude in Plyloft's review folder, for the member to
 *  answer its trust question (`setup_actions::ActionId::TrustClaude`). */
export const TRUST_ACTION = "trust.claude" satisfies SetupRunActionId;

/** 1.179.0 (C1): the steps on one Claude account (`login-account.claude`,
 *  `logout-account.claude`). Settings › AI and models › Claude accounts
 *  follows them; Setup's AI step never takes one for its own run. */
export function isAccountAction(id: string): boolean {
  return id === "login-account.claude" || id === "logout-account.claude";
}

/** The tool an action id is about (`install.claude` → claude). The trust
 *  run is not about installing or signing in: no row follows it. */
export function toolOfAction(id: string): AiTool | null {
  // 1.176.0 R4: a Repair's run is no step's install or sign-in; nor
  // (1.179.0, C1) a Claude account's, which Settings › AI and models starts.
  if (id === TRUST_ACTION || isRepairAction(id) || isAccountAction(id)) return null;
  const tool = id.slice(id.indexOf(".") + 1);
  return tool === "claude" || tool === "codex" ? tool : null;
}

/** Every run this step starts (Git for Windows goes before Claude Code). */
export function isAiStepAction(id: string): id is SetupRunActionId {
  return toolOfAction(id) !== null || id === "install.git" || id === TRUST_ACTION;
}

/** A run that keeps the AI step's Continue back while it runs. The trust run
 *  does not: Setup never waits on it (leaving asks first, and stops it). */
export function holdsAiStep(id: string): boolean {
  return isAiStepAction(id) && id !== TRUST_ACTION;
}

// ── Claude's review folder (v1.164.0 part 5) ────────────────────────────

export const SETUP_TRUST = {
  title: "Claude needs to trust Plyloft's review folder.",
  text:
    "Claude asks once whether to trust the folder Plyloft runs its reviews in, and Plyloft never answers that for you. " +
    "Open Claude there and choose “Yes, I trust this folder”: Plyloft notices and closes Claude. " +
    // 1.171.0 D2 (FR-14): what putting it off costs, said before the press.
    "Until you do, Claude can't review your cards. You can also do it later in Settings › Setup and account › Diagnostics.",
  open: "Open Claude there",
  later: "Later (reviews wait)",
};

/**
 * Whether the AI step offers the trust step: Claude is installed and seen
 * signed in (its row is Ready), Claude's own state says the folder is not
 * trusted (`null`, unreadable, says nothing: no session has met the question
 * on a first run), and the member hasn't put it off on this visit.
 */
export function showsSetupTrust(
  claudeRow: Pick<RowView, "state">,
  trusted: boolean | null | undefined,
  later: boolean,
): boolean {
  return claudeRow.state === "ready" && trusted === false && !later;
}

const CLAUDE_PLANS: Record<string, string> = {
  max: "Claude Max",
  pro: "Claude Pro",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
};

/** The Ready row's words (§5 step 3; MEASUREMENTS §1–2; D3). The plan only
 *  when known — never guessed. */
export function readyWords(tool: AiTool, answer: SetupSignInAnswer): string {
  const method = answer.method ?? "";
  if (method === "api_key" || method === "api_key_helper") return "Ready, with an API key.";
  if (tool === "claude") {
    if (method === "claude.ai") {
      const plan = answer.plan ? CLAUDE_PLANS[answer.plan] : undefined;
      return plan ? `Ready. Signed in with ${plan}.` : "Ready.";
    }
    // `oauth_token`, `third_party` (OB-0): ready, no plan, no warning.
    return "Ready.";
  }
  return method === "chatgpt" ? "Ready. Signed in with ChatGPT." : "Ready.";
}

/** The Pro warning (§5 step 3): a subscription sign-in whose plan is Pro. */
export function showsProWarning(signIn: SignIn): boolean {
  return (
    signIn.kind === "answer" &&
    signIn.answer.signedIn === true &&
    signIn.answer.method === "claude.ai" &&
    signIn.answer.plan === "pro"
  );
}

export const PRO_WARNING = {
  title: "Claude Pro works with Plyloft.",
  text: "Pro reaches its usage limit sooner than Max, so a long build can pause until the limit resets. You can keep going with Pro and upgrade later.",
};

/**
 * One tool's row. `run` is the guided run under way or last finished (the
 * store keeps a finished one until the next starts).
 */
export function toolRow(tool: AiTool, facts: ToolFacts, signIn: SignIn, run: RunView | null, programFoldersSet = false): RowView {
  const mine = run && toolOfAction(run.actionId) === tool ? run : null;
  const running = mine !== null && mine.phase !== "done";
  const view = (state: RowState, words: string, action: RowAction | null, usable: Usable): RowView => ({
    tool,
    state,
    words,
    action,
    usable,
  });

  if (running) {
    const id = mine.actionId;
    if (id.startsWith("install.")) {
      return view("installing", "Installing… this takes about a minute.", null, "pending");
    }
    if (id.startsWith("update.")) return view("updating", "Updating…", null, "pending");
    return view(
      "signing-in",
      id === "login-device.codex"
        ? "Enter the code shown below in your browser. Plyloft notices when you're done."
        : "Finish signing in in your browser. Plyloft notices when you're done.",
      null,
      "pending",
    );
  }

  if (!facts.found) {
    // §5 step 3 "Installed but not on PATH": the install ran and the re-probe
    // still can't find it.
    if (mine && mine.actionId.startsWith("install.") && mine.outcome === "not-observed") {
      return view(
        "not-found-yet",
        "Installed, but Plyloft can't find it yet. Quit and reopen Plyloft.",
        { id: "check-again", label: "Look again", quiet: true },
        "no",
      );
    }
    // 1.176.1 walk: with Program folders set, missing from the snapshot is
    // missing from that list — it may well be installed. No installer.
    if (programFoldersSet) {
      return view("missing", "Not in your Program folders.", { id: "program-folders", label: "Open Program folders", quiet: false }, "no");
    }
    return view("missing", "Not installed.", { id: "install", label: "Install", quiet: false }, "no");
  }

  if (!facts.works) {
    // 1.176.0 R3: a Claude that doesn't start gets Codex's row and fix — the
    // official installer, never `claude update` (the broken binary itself).
    const starts = facts.starts ?? (tool === "codex" ? facts.works : true);
    return tool === "claude" && starts
      ? view(
          "too-old",
          "Installed but too old. Update it to use it with Plyloft.",
          { id: "update", label: "Update", quiet: false },
          "no",
        )
      : view(
          "broken",
          "Installed but not starting. Reinstall it.",
          { id: "reinstall", label: "Reinstall", quiet: false },
          "no",
        );
  }

  if (signIn.kind !== "answer") {
    return view("checking", "Installed. Checking whether you're signed in…", null, "pending");
  }
  const answer = signIn.answer;
  if (answer.signedIn === false) {
    return view(
      "signed-out",
      "Installed. Not signed in yet.",
      { id: "sign-in", label: "Sign in", quiet: false },
      "no",
    );
  }
  if (answer.signedIn === null) {
    return view(
      "unsure",
      tool === "claude"
        ? "Installed. Plyloft couldn't tell whether you're signed in; if your Claude tiles start, this is fine."
        : "Installed. Plyloft couldn't tell whether you're signed in.",
      { id: "sign-in", label: "Sign in", quiet: true },
      "maybe",
    );
  }
  const ready = readyWords(tool, answer);
  // D6: a newer release is offered, never forced.
  if (facts.update) {
    return view(
      "ready",
      `${ready} Version ${facts.update.latest} is available.`,
      { id: "update", label: "Update", quiet: true },
      "yes",
    );
  }
  return view("ready", ready, null, "yes");
}

/** The run an action starts for a tool. */
export function runActionFor(tool: AiTool, action: RowActionId): SetupRunActionId | null {
  switch (action) {
    case "install":
    case "reinstall":
      return tool === "claude" ? "install.claude" : "install.codex";
    case "update":
      return tool === "claude" ? "update.claude" : "update.codex";
    case "sign-in":
      return tool === "claude" ? "login.claude" : "login.codex";
    case "check-again":
    case "program-folders":
      return null;
  }
}

const usableNow = (u: Usable) => u === "yes" || u === "maybe";

/**
 * The step's own `ai` fact (§4: inside the AI step the status reads decide).
 * true: one tool is usable; false: every tool is settled and none is; null:
 * a read or run is still out and nothing is usable yet.
 */
export function aiStepReady(rows: readonly RowView[]): boolean | null {
  if (rows.some((r) => usableNow(r.usable))) return true;
  if (rows.some((r) => r.usable === "pending")) return null;
  return false;
}

/** Builder and Challenger (§5 step 3, §13): what to show under the rows. */
export type BuilderView =
  | { kind: "none" }
  | { kind: "single"; vendor: AiTool; title: string; text: string }
  | { kind: "choose" };

export function builderView(rows: readonly RowView[]): BuilderView {
  const claude = rows.find((r) => r.tool === "claude");
  const codex = rows.find((r) => r.tool === "codex");
  const c = claude ? usableNow(claude.usable) : false;
  const x = codex ? usableNow(codex.usable) : false;
  if (c && x) return { kind: "choose" };
  if (c) {
    return {
      kind: "single",
      vendor: "claude",
      title: "Claude will build and review your cards.",
      text: "Adding Codex later gives you reviews from a second, independent AI. It's optional.",
    };
  }
  if (x) {
    return {
      kind: "single",
      vendor: "codex",
      title: "Codex will build and review your cards.",
      text: "Adding Claude Code later gives you reviews from a second, independent AI. It's optional.",
    };
  }
  return { kind: "none" };
}

export const BUILDER_ROW = {
  label: "Who builds your cards",
  hint: "The other one reviews the work. You can change it on any card.",
};

/**
 * When only one vendor is ready, the Builder and the discussion synthesizer
 * follow it (§5 step 3, §13.4) — but only once the other is settled as not
 * there: not installed, or definitively signed out (review P3-2). A tool
 * that is broken, too old, slow to answer or could-not-tell is left alone,
 * so a deliberate choice of it is never changed behind its back. Null when
 * nothing would change.
 */
export function vendorPatch(
  rows: readonly RowView[],
  current: { builderVendor: AiTool; discussionSynthesizer: AiTool },
): { builderVendor: AiTool; discussionSynthesizer: AiTool } | null {
  const view = builderView(rows);
  if (view.kind !== "single") return null;
  const other = rows.find((r) => r.tool !== view.vendor);
  if (other && other.state !== "missing" && other.state !== "signed-out") return null;
  if (current.builderVendor === view.vendor && current.discussionSynthesizer === view.vendor) return null;
  return { builderVendor: view.vendor, discussionSynthesizer: view.vendor };
}

/** The callout's added sentence when the step changed who builds. */
export function switchedWords(from: AiTool, to: AiTool): string {
  const name = (t: AiTool) => (t === "claude" ? "Claude" : "Codex");
  return `Plyloft switched who builds your cards from ${name(from)} to ${name(to)}.`;
}

/** The guard's sheet when a run of this step is under way (spec §7). */
export function leaveSheet(actionId: SetupGuidedActionId): { title: string; body: string } {
  // OB-12: step 8's clone.
  if (actionId === "project.clone") {
    return {
      title: "Stop the download?",
      body: "Plyloft is still getting the project from GitHub. Stopping removes what was downloaded so far; nothing is added to Plyloft.",
    };
  }
  // OB-7a: every step's run — gh's sign-ins (a second account, the scope
  // refresh) are sign-ins too; setup-git changes Git's settings.
  if (actionId.startsWith("login") || actionId === "add-account.gh" || actionId === "refresh.gh") {
    return {
      title: "Stop signing in?",
      body: "Plyloft is waiting for you to finish signing in. Stop it, or keep going and come back to this step.",
    };
  }
  if (actionId === TRUST_ACTION) {
    return {
      title: "Stop Claude?",
      body: "Claude is still asking whether to trust Plyloft's review folder. Stop it, or keep going and answer it. You can also do it later in Settings › Setup and account › Diagnostics.",
    };
  }
  if (actionId === "setupgit.gh") {
    return {
      title: "Stop the GitHub command?",
      body: "It's still changing Git's settings. Stopping it may leave them half done; Plyloft checks again when you come back.",
    };
  }
  return {
    title: "Stop the installer?",
    body: "It's still running. Stopping it may leave part of it installed; Plyloft checks again when you come back.",
  };
}

// ── "Which do you have?" ─────────────────────────────────────────────────

export type Have = "claude" | "codex" | "neither";

export const HAVE_OPTIONS: { value: Have; label: string }[] = [
  { value: "claude", label: "Claude (Pro or Max)" },
  { value: "codex", label: "ChatGPT (Plus, Pro or Business) for Codex" },
  { value: "neither", label: "Neither yet" },
];

export const NEITHER_TEXT = "You'll need one subscription. Sign up in your browser, then come back here.";

/** Ticking `Neither yet` clears the others, and the reverse. */
export function toggleHave(current: ReadonlySet<Have>, value: Have, on: boolean): Set<Have> {
  const next = new Set(current);
  if (!on) {
    next.delete(value);
    return next;
  }
  if (value === "neither") return new Set<Have>(["neither"]);
  next.delete("neither");
  next.add(value);
  return next;
}

/** The question shows only while neither tool is installed. */
export function asksWhich(claude: ToolFacts, codex: ToolFacts): boolean {
  return !claude.found && !codex.found;
}

/**
 * A row's role under the question: a checked tool is `primary` (its Install
 * is the strong one); the other becomes the quiet "Also use …" row. With
 * nothing ticked, or `Neither yet`, or once a tool is installed, rows are
 * `normal`.
 */
export function rowRole(tool: AiTool, asking: boolean, have: ReadonlySet<Have>): "primary" | "also" | "normal" {
  if (!asking) return "normal";
  const picked = have.has("claude") || have.has("codex");
  if (!picked) return "normal";
  return have.has(tool) ? "primary" : "also";
}

export function rowLabel(tool: AiTool, role: "primary" | "also" | "normal"): string {
  if (role === "also") return tool === "claude" ? "Also use Claude Code" : "Also use Codex";
  return TOOL_NAME[tool];
}

// ── Consent sheets (§4 principle 2, §5 step 3) ───────────────────────────

export type SheetKind =
  | "install-claude"
  | "install-git-then-claude"
  | "install-codex"
  | "reinstall-codex"
  | "update-claude"
  | "update-codex";

export interface SheetCopy {
  title: string;
  body: string;
  confirm: string;
}

export function sheetCopy(kind: SheetKind): SheetCopy {
  switch (kind) {
    case "install-claude":
      return {
        title: "Install Claude Code?",
        body: "Plyloft will download and run the installer Anthropic publishes. It installs for your user only and doesn't need an administrator.",
        confirm: "Install",
      };
    case "install-git-then-claude":
      return {
        title: "Install Git for Windows first?",
        body: "Claude Code on Windows needs Git for Windows. Windows may ask for an administrator's permission.",
        confirm: "Install both",
      };
    case "install-codex":
      return {
        title: "Install Codex?",
        body: "Plyloft will download and run the installer OpenAI publishes. It installs for your user only and doesn't need an administrator.",
        confirm: "Install",
      };
    case "reinstall-codex":
      return {
        title: "Reinstall Codex?",
        body: "Plyloft will download and run the installer OpenAI publishes again. It installs for your user only and doesn't need an administrator.",
        confirm: "Reinstall",
      };
    case "update-claude":
      return { title: "Update Claude Code?", body: "Plyloft will run Claude Code's own updater.", confirm: "Update" };
    case "update-codex":
      return { title: "Update Codex?", body: "Plyloft will run Codex's own updater.", confirm: "Update" };
  }
}

/**
 * Which sheet a row's action opens. Sign-in and Look again open none: they
 * install nothing. Claude Code on Windows without Git Bash gets Git for
 * Windows first.
 */
export function sheetFor(
  tool: AiTool,
  action: RowActionId,
  platform: "mac" | "windows",
  gitBash: boolean,
): SheetKind | null {
  switch (action) {
    case "install":
      if (tool === "codex") return "install-codex";
      return platform === "windows" && !gitBash ? "install-git-then-claude" : "install-claude";
    case "reinstall":
      return tool === "codex" ? "reinstall-codex" : "install-claude";
    case "update":
      return tool === "claude" ? "update-claude" : "update-codex";
    default:
      return null;
  }
}

/** The runs a sheet starts, in order (one at a time, OB-3). */
export function sheetRuns(kind: SheetKind): SetupRunActionId[] {
  switch (kind) {
    case "install-claude":
      return ["install.claude"];
    case "install-git-then-claude":
      return ["install.git", "install.claude"];
    case "install-codex":
    case "reinstall-codex":
      return ["install.codex"];
    case "update-claude":
      return ["update.claude"];
    case "update-codex":
      return ["update.codex"];
  }
}

// ── Failures (§5 step 3 table; ErrorBlock shape, §4 principle 5) ─────────

/** winget's "needs an administrator" answers (MEASUREMENTS §7) — not
 *  `0x8A150056`, which is the installer refusing elevation. */
const WINGET_NEEDS_ADMIN = [0x8a150019, 0x8a15010c, 0x8a15003a];

/** A PTY exit code, signed or not, as winget's unsigned HRESULT. */
export function wingetNeedsAdmin(exitCode: number | null): boolean {
  if (exitCode === null) return false;
  return WINGET_NEEDS_ADMIN.includes(exitCode >>> 0);
}

/** A download failure that looks like a proxy's (407, CONNECT, TLS
 *  interception). */
export function looksLikeProxy(tail: readonly string[]): boolean {
  const text = tail.join("\n");
  return /\b407\b|CONNECT|proxy|SSL certificate problem|certificate verify failed|unable to get local issuer|self[- ]signed certificate/i.test(
    text,
  );
}

export const PROXY_TEXT =
  "Your network may use a proxy. Ask whoever manages it to allow claude.ai / chatgpt.com, or install the tool yourself.";

/** Action ids an error block's buttons carry. */
export type FailureWayOut = "try-again" | "do-it-yourself" | "check-again";

const tryAgain = { id: "try-again", label: "Try again", primary: true };
const yourself = { id: "do-it-yourself", label: "Do it yourself" };
const checkAgain = { id: "check-again", label: "Look again", primary: true };

function toolName(id: SetupRunActionId): string {
  if (id === "install.git") return "Git for Windows";
  const tool = toolOfAction(id);
  return tool ? TOOL_NAME[tool] : "It";
}

/** Before a download: the host did not answer (§5 step 3 "Offline"). */
export function offlineError(id: SetupRunActionId, reach: SetupReach): UxError {
  const installs = id.startsWith("install.");
  return {
    title: `${toolName(id)} couldn't be downloaded.`,
    happened: "You're offline, or this network blocks the download.",
    untouched: installs ? "Nothing was installed." : "Nothing was changed.",
    todo: reach.proxy ? `Connect and press Try again. ${PROXY_TEXT}` : "Connect and press Try again.",
    actions: [tryAgain, yourself],
    details: reach.details,
  };
}

/** 1.176.0 R2: the outcomes that get an error block in the AI step. A
 *  Record, so a new outcome doesn't compile until it is placed here.
 *  `nothing-newer` isn't one: the tool works as before (its line says so). */
const RUN_FAILS: Record<SetupOutcome, boolean> = {
  succeeded: false,
  "not-observed": false,
  "could-not-tell": false,
  failed: true,
  "timed-out": true,
  "installer-closed": false,
  "still-on-old-version": true,
  "nothing-newer": false,
  "older-version-now": true,
  cancelled: false,
};

/**
 * 1.176.0 R2: what the run's cause (`setup_outcome::Cause`, read from its
 * output) says happened, and the way on. Null when the output names none.
 */
function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** 1.176.1: the way on when a command wasn't found and Program folders is set. */
export const PROGRAM_FOLDERS_TODO =
  "Your Program folders in Settings › Look and feel › Editor and terminals may leave it out. Check them, or empty them so Plyloft uses what your shell reports, then press Try again.";

/** `name` may start lowercase mid-sentence ("the GitHub command"). */
export function causeWords(
  name: string,
  update: boolean,
  evidence: SetupRunEvidence,
  tail: readonly string[],
  programFoldersSet = false,
): { happened: string; todo: string } | null {
  const runner = update ? "updater" : "installer";
  const path = evidence.causePath ?? null;
  switch (evidence.cause) {
    case "permissions":
      return {
        // Rust reports the folder to fix (`setup_outcome::folder_to_fix`).
        happened: path
          ? `The computer didn't let ${name}'s ${runner} change the folder ${path}.`
          : `The computer didn't let ${name}'s ${runner} change its files.`,
        todo: "That folder may belong to another account (an earlier install as an administrator can do that). Ask whoever manages this computer, or install it yourself.",
      };
    case "disk-full":
      return { happened: "The disk is full.", todo: "Free some space on the disk, then press Try again." };
    case "file-in-use":
      return {
        happened: path ? `A file it had to replace is in use: ${path}.` : "A file it had to replace is in use.",
        todo: `Close the open ${name} tiles and windows, then press Try again.`,
      };
    case "network":
      return {
        happened: "The network didn't answer.",
        todo: looksLikeProxy(tail) ? PROXY_TEXT : "Connect and press Try again.",
      };
    case "timed-out":
      return {
        happened: capitalised(`${name}'s ${runner} took too long and was stopped.`),
        todo: "Try again, or install it yourself.",
      };
    case "command-not-found":
      // 1.176.1: the owner's installer ended `exit 127` with a Program
      // folders setting that held no folder.
      return {
        happened: path
          ? capitalised(`${name}'s ${runner} needed the ${path} command and couldn't find it.`)
          : capitalised(`${name}'s ${runner} needed a command it couldn't find.`),
        todo: programFoldersSet ? PROGRAM_FOLDERS_TODO : "Try again, or install it yourself.",
      };
    default:
      return null;
  }
}

/**
 * A finished run that failed. Null for outcomes that are not errors: a
 * cancelled sign-in is just *Not signed in yet.* (no error colour), and a
 * not-observed install says *Quit and reopen* on its row. 1.176.0 R2: an
 * update that left the old version (`still-on-old-version`) and an install
 * or update stopped at its time limit (`timed-out`; Git's own is the Git
 * step's) are failures too, and `evidence`'s cause says why in plain words.
 */
export function runFailure(
  id: SetupRunActionId,
  outcome: SetupOutcome | null,
  exitCode: number | null,
  tail: readonly string[],
  display: string,
  evidence: SetupRunEvidence = {},
  programFoldersSet = false,
): UxError | null {
  const timedOut = outcome === "timed-out" && id !== "install.git";
  if (!outcome || !RUN_FAILS[outcome] || (outcome === "timed-out" && !timedOut)) return null;
  const details = [display, ...tail].join("\n").trim() || null;
  if (id === "install.git") {
    if (wingetNeedsAdmin(exitCode)) {
      return {
        title: "Git for Windows wasn't installed.",
        happened: "Windows needs an administrator to install Git for Windows.",
        untouched: "Nothing was changed.",
        todo: "Ask your IT team to install it, or install it yourself and press Look again.",
        actions: [checkAgain, yourself],
        details,
      };
    }
  }
  const name = toolName(id);
  const update = id.startsWith("update.");
  if (id.startsWith("login")) {
    return {
      title: "Signing in stopped with an error.",
      happened: `${name} stopped before you were signed in.`,
      untouched: "Nothing was changed.",
      todo: "Try again.",
      actions: [tryAgain],
      details,
    };
  }
  const why = causeWords(name, update, timedOut ? { ...evidence, cause: "timed-out" } : evidence, tail, programFoldersSet);
  const before = evidence.versionBefore ?? null;
  const after = evidence.versionAfter ?? null;
  // R0: Claude's updater can say it succeeded, exit 0, and leave the old
  // version running (a folder it can't write): trying again won't help.
  const saidDone = outcome === "still-on-old-version" && exitCode === 0 && !why;
  // R0: a failed update removed the newer copy; an older one answers now.
  const older = outcome === "older-version-now";
  const untouched = older
    ? after && before
      ? `An older copy of ${name} answers now: version ${after}, where it was ${before}.`
      : `An older copy of ${name} answers now.`
    : outcome === "still-on-old-version"
      ? before
        ? `${name} still works, on version ${before}.`
        : `${name} still works, on the version it had.`
      : timedOut
        ? `Part of it may have been ${update ? "updated" : "installed"}.`
        : "Nothing else was changed.";
  const happened =
    why?.happened ??
    (saidDone
      ? `${name}'s updater said it finished, but the old version still runs.`
      : older
        ? `${name}'s update didn't finish.`
        : update
          ? `${name}'s updater stopped with an error.`
          : `${name}'s installer stopped with an error.`);
  const todo = saidDone
    ? `${name}'s folder may not be writable, so trying again won't help. Ask whoever manages this computer, or install it yourself.`
    : older
      ? `Install ${name} again yourself, so the newest copy is the one that runs.`
      : (why?.todo ?? (looksLikeProxy(tail) ? PROXY_TEXT : "Try again, or install it yourself."));
  return {
    title: update ? `${name} wasn't updated.` : `${name} wasn't installed.`,
    happened,
    untouched,
    todo,
    // 1.176.3: when the setting is the cause, the way to it, not a manual install.
    actions:
      saidDone || older
        ? [{ ...yourself, primary: true }]
        : programFoldersSet && evidence.cause === "command-not-found"
          ? [tryAgain, { id: "program-folders", label: "Open Program folders" }] // "Do it yourself" stays beside it, drawn by the step
          : [tryAgain, yourself],
    details,
  };
}

/**
 * 1.176.0 R6: the tool whose Repair can help after this run ended — an
 * install or update of Claude Code or Codex that failed, ran out of time,
 * left the old version or left an older copy answering. Null for anything
 * else (a sign-in, Git, the GitHub command, a run that went well).
 */
export function repairToolAfter(id: SetupRunActionId, outcome: SetupOutcome | null): AiTool | null {
  if (!id.startsWith("install.") && !id.startsWith("update.")) return null;
  const tool = toolOfAction(id);
  if (!tool) return null;
  switch (outcome) {
    case "failed":
    case "timed-out":
    case "still-on-old-version":
    case "older-version-now":
    case "not-observed":
    case "could-not-tell":
      return tool;
    case "succeeded":
    case "installer-closed":
    case "nothing-newer":
    case "cancelled":
    case null:
      return null;
    default:
      return unhandledOutcome(outcome);
  }
}

/**
 * 1.176.0 R6: an install or update that ended without being seen to work
 * (`not-observed`, `could-not-tell`) and the tool still doesn't start: the
 * case Repair is for. Null when the tool works (the row says so).
 */
export function notStartingError(
  id: SetupRunActionId,
  outcome: SetupOutcome | null,
  works: boolean,
  tail: readonly string[],
  display: string,
): UxError | null {
  if (works || (outcome !== "not-observed" && outcome !== "could-not-tell")) return null;
  const tool = repairToolAfter(id, outcome);
  if (!tool) return null;
  const name = TOOL_NAME[tool];
  return {
    title: `${name} doesn't start yet.`,
    happened: id.startsWith("update.")
      ? `The updater ended, but Plyloft can't see ${name} working.`
      : `The installer ended, but Plyloft can't see ${name} working.`,
    untouched: "Nothing else was changed.",
    todo: "Press Repair to look at it, or press Look again in a moment.",
    actions: [checkAgain],
    details: [display, ...tail].join("\n").trim() || null,
  };
}

function unhandledOutcome(outcome: never): null {
  void outcome;
  return null;
}

/**
 * Install both (review P3-1): Git for Windows ended without being seen to
 * work (not observed, could not tell, timed out), so Claude Code never
 * started. A Git that *failed* keeps `runFailure`'s block; either way Try
 * again resumes the pair.
 */
export function haltedError(
  first: SetupRunActionId,
  outcome: SetupOutcome | null,
  halted: readonly SetupRunActionId[] | null,
  tail: readonly string[],
): UxError | null {
  if (first !== "install.git" || !halted?.includes("install.claude")) return null;
  if (outcome !== "not-observed" && outcome !== "could-not-tell" && outcome !== "timed-out") return null;
  return {
    title: "Claude Code wasn't installed.",
    happened: "Claude Code wasn't installed because Git for Windows isn't ready yet.",
    untouched: "Claude Code was left as it was.",
    todo: "Try again, or install Git for Windows yourself and press Look again.",
    actions: [tryAgain, yourself],
    details: tail.join("\n").trim() || null,
  };
}

/** A run refused before it started because winget is missing (LTSC, Server,
 *  blocked). Null for any other refusal (the terminal panel says those).
 *  1.176.0 seams: also Update refused on a copy whose updater can't write
 *  its folders (the backend's typed `PLY_CLI_UPDATE_REFUSED_V1`), with
 *  Repair as its way out (`ErrorBlock` answers `cli-repair:<tool>`). */
export function refusalError(error: string | null): UxError | null {
  const refused = backendMarkTool(error, "updateRefused");
  if (refused) {
    const name = refused === "claude" ? "Claude Code" : "Codex";
    return {
      title: `${name} wasn't updated.`,
      happened: showBackendText(error ?? "").trim(),
      untouched: "Nothing was changed.",
      todo: `Press Repair ${name}. Plyloft shows what it will do before it does anything.`,
      actions: [{ id: `${CLI_REPAIR_ACTION}${refused}`, label: `Repair ${name}`, primary: true }],
      details: null,
    };
  }
  if (!error || !/winget/i.test(error)) return null;
  return {
    title: "Git for Windows can't be installed from here.",
    happened: "Windows' package installer isn't available here.",
    untouched: "Nothing was changed.",
    todo: "Install Git for Windows yourself, then press Look again.",
    actions: [yourself, { id: "check-again", label: "Look again" }],
    details: error,
  };
}

/** The vendor page `Do it yourself` opens, by the run that failed. */
export function yourselfPage(id: SetupRunActionId): "install-claude" | "install-codex" | "install-git-windows" {
  if (id === "install.git") return "install-git-windows";
  return toolOfAction(id) === "codex" ? "install-codex" : "install-claude";
}

// ── The fast path's checklist row ────────────────────────────────────────

/**
 * The AI row's action on the checklist (§3.2), from the doctor alone — the
 * sign-in read belongs to the step (D2). It opens the step and starts the
 * same action there.
 */
export function checklistAiAction(claude: ToolFacts, codex: ToolFacts): { tool: AiTool; action: RowActionId; label: string } | null {
  // 1.176.0 R3 (review 2): a Claude that doesn't start is repaired, as
  // Codex is — `update.claude` would run the broken binary itself.
  // 1.176.0 seams: worded as the rest of the release; "reinstall" opens the
  // guided Repair (`SetupAiStep`'s press).
  if (claude.found && !claude.works)
    return claude.starts === false
      ? { tool: "claude", action: "reinstall", label: "Repair Claude Code" }
      : { tool: "claude", action: "update", label: "Update Claude Code" };
  if (!claude.found && codex.found && !codex.works) return { tool: "codex", action: "reinstall", label: "Repair Codex" };
  if (claude.found) return { tool: "claude", action: "sign-in", label: "Sign in" };
  if (codex.found) return { tool: "codex", action: "sign-in", label: "Sign in" };
  return null;
}

/** The doctor's row as `ToolFacts` (typed loosely so node runs this). */
export function toolFacts(
  row:
    | {
        found: boolean;
        versionOk: boolean;
        version?: string | null;
        installCmd: string;
        update?: { latest: string; command: string } | null;
      }
    | null
    | undefined,
): ToolFacts {
  if (!row) return { found: false, works: false, update: null, installCmd: "" };
  return {
    found: row.found,
    works: row.found && row.versionOk,
    // A row without `version` (an older shape) leaves it to `works`.
    ...(row.version === undefined ? {} : { starts: row.found && row.version !== null }),
    update: row.update ? { latest: row.update.latest, command: row.update.command } : null,
    installCmd: row.installCmd,
  };
}

// ── 1.176.4: what the AI step's actions do, said before the press ─────────

/** (a) Install's weight: the one the person said they have is filled, and
 *  only when exactly one was chosen; otherwise today's weights. */
export function installTone(role: "primary" | "also" | "normal", exactlyOne: boolean): "accent" | "strong" | "quiet" {
  if (role === "also") return "quiet";
  return role === "primary" && exactlyOne ? "accent" : "strong";
}

/** (c) One line per Install: what it downloads, from where, and — where an
 *  installer needs Git for Windows — that Windows may ask for permission.
 *  The facts are the runners' (`doctor::install_cmd_on`). */
export function installLines(rows: readonly RowView[], windows: boolean, gitBash: boolean): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.action?.id !== "install") continue;
    if (r.tool === "claude") {
      out.push(
        windows && !gitBash
          ? "Claude Code: Install first adds Git for Windows through winget, Windows' package installer, then downloads Anthropic's installer from claude.ai. Windows may ask for an administrator's permission."
          : "Claude Code: Install downloads Anthropic's installer from claude.ai and runs it for your user only. No administrator needed.",
      );
    } else {
      out.push("Codex: Install downloads OpenAI's installer from chatgpt.com and runs it for your user only. No administrator needed.");
    }
  }
  return out;
}

/** 1.176.4: how long the window waits for Repair's quick check before it
 *  counts as "no" and the row goes back to its normal state. */
export const PF_CHECK_MS = 8000;
let pfCheckOverride: number | null = null;
/** Tests shorten the limit. */
export function setPfCheckMsForTests(ms: number | null) {
  pfCheckOverride = ms;
}
export const pfCheckMs = () => pfCheckOverride ?? PF_CHECK_MS;

/** (d) */
export const AI_SUBSCRIPTION_LINE =
  "The Claude or ChatGPT subscription is paid to Anthropic or OpenAI. Plyloft doesn't include it.";

/** (b) Under the disabled Continue: what is missing. Null when nothing is,
 *  and while the reads aren't back (`aiReady` null). A tool that is there but
 *  doesn't work says so in its row's own words. */
export function aiContinueReason(c: {
  running: boolean;
  aiReady: boolean | null;
  facts: Record<AiTool, ToolFacts>;
}): string | null {
  if (c.running) return "Plyloft is still installing or signing in. Continue works when that is done.";
  if (c.aiReady === null) return null;
  // The quicker action first: a tool that works only needs a sign-in.
  const working = AI_TOOLS.filter((t) => c.facts[t].found && c.facts[t].works);
  if (working.length > 0) {
    return `Sign in to ${working.map((t) => TOOL_NAME[t]).join(" or ")} to go on, or press Skip for now.`;
  }
  const broken = AI_TOOLS.filter((t) => c.facts[t].found && !c.facts[t].works);
  if (broken.length > 0) {
    const words = broken.map((t) => `${TOOL_NAME[t]}: ${toolRow(t, c.facts[t], { kind: "unread" }, null).words}`);
    return `${words.join(" ")} Or press Skip for now.`;
  }
  return "Install Claude Code or Codex to go on, or press Skip for now.";
}
