// 1.176.1: the sidebar's one "something needs you" indicator. Every problem
// that stops work and that the doctor report ALREADY knows, in a fixed
// priority order, each with a plain half-sentence and one action that leads
// to the fix. Pure (node runs it: `src/lib/needsAttention.test.ts`):
//
//     node --experimental-strip-types src/lib/needsAttention.test.ts
//
// The sidebar draws only the first item, and "and N more" (which opens
// Diagnostics) for the rest. Nothing here probes or polls: it reads the
// report the doctor store last held. Only certain problems count: a state
// the report calls unknown (`signedIn: null`, a tool that answered slowly)
// says nothing, and nothing is said before the first report.
import type { DoctorReport, ShellEnvInfo } from "../ipc.ts";
import { brokenCliRowText, brokenClis } from "./cliBroken.ts";
import { aiReadyOf, isNoAiProbeError, missingRequiredTools, noAiSentence } from "./diagnostics.ts";
import { machineWords } from "./platform.ts";
import type { TileCli } from "./ptySpawnIpc.ts";

/** The missing-AI row's words while Program folders is set in Settings. */
// 1.176.1 walk: short enough for the sidebar's narrowest width.
export const NO_AI_IN_FOLDERS = "Program folders find no AI tool";

export type AttentionKind =
  | "program-folders"
  | "ai-broken"
  | "ai-missing"
  | "tool-missing"
  | "github-missing"
  | "setting-problem"
  | "github-signed-out"
  | "ai-signed-out"
  | "shell-unread";

/** Where the press goes: Settings › Diagnostics, or one tool's Repair. */
export type AttentionTarget =
  | { to: "diagnostics" }
  | { to: "repair"; tool: TileCli }
  /** A settings page, on one row (`openSettingsSection(section, { row })`). */
  | { to: "setting"; section: string; row?: string };

/** A problem some other part of the app found in a saved setting (a tile
 *  shell that can't start, a team folder that can't be used), handed in to
 *  be shown among the rest: after a missing tool, before the GitHub items.
 *  Its action is "Open the setting". */
export interface SettingProblemItem {
  id: string;
  words: string;
  title?: string;
  target: AttentionTarget;
}

export interface AttentionItem {
  kind: AttentionKind;
  /** Stable, for a React key (a tool's name where there are several). */
  id: string;
  words: string;
  title?: string;
  action: { label: string; target: AttentionTarget; title: string };
}

export interface AttentionInput {
  /** The doctor's last report; null until its first answer. */
  report: DoctorReport | null;
  /** The cached shell snapshot: speaks only while there is no report. */
  env: Pick<ShellEnvInfo, "claudePath" | "codexPath"> | null;
  /** A Program folders value is set (`hasPathOverride`). */
  programFolders: boolean;
  /** The person's AI (`behavior.builderVendor`). */
  chosen: TileCli | null | undefined;
  /** Kinds of the tiles open now, and tools a tile found gone. */
  tileKinds: readonly string[];
  gone: readonly TileCli[];
  codexUpdating: boolean;
  /** The active project uses GitHub: its board is GitHub Issues, or it
   *  ships as pull requests by its own setting. */
  usesGithub: boolean;
  /** Whether `gh` is signed in, when known: the report's own answer, or the
   *  last one the app saw for this account. null = unknown, which never
   *  raises a row and never clears one. */
  ghSignedIn?: boolean | null;
  /** Problems in saved settings found elsewhere (not computed here). */
  settingProblems?: readonly SettingProblemItem[];
}

/** The report's answer on `gh`'s sign-in, when it is a clear one. A sign-in
 *  that is only offered (`optionalStep`: the keychain was locked) or that
 *  Plyloft couldn't read (`null`) is not an answer. A `gh` that isn't there
 *  is signed out of nothing: null. */
export function ghAnswerOf(report: DoctorReport | null): boolean | null {
  const gh = report?.tools.find((t) => t.id === "gh");
  const auth = gh?.auth;
  if (!gh || !gh.found || !auth || auth.signedIn === null || auth.signedIn === undefined) return null;
  if (auth.signedIn === false && auth.optionalStep === true) return null;
  return auth.signedIn;
}

/** What the app last saw of `gh`'s sign-in, per GitHub account. The doctor
 *  asks `gh` only on reads made with sign-in (Diagnostics, Setup), so a later
 *  plain read carries no answer: the last clear one stands until a fresh read
 *  says otherwise, the account changes (another key) or `gh` is gone. */
export type GhSignInMemory = Readonly<Record<string, boolean>>;

export function rememberGhSignIn(memory: GhSignInMemory, key: string, report: DoctorReport | null): GhSignInMemory {
  const gh = report?.tools.find((t) => t.id === "gh");
  if (!report || !gh) return memory;
  if (!gh.found) {
    if (!(key in memory)) return memory;
    const { [key]: _gone, ...rest } = memory;
    return rest;
  }
  const answer = ghAnswerOf(report);
  if (answer === null || memory[key] === answer) return memory;
  return { ...memory, [key]: answer };
}

/** The answer to hand `needsAttention`: the report's, else the remembered. */
export function ghSignedInNow(memory: GhSignInMemory, key: string, report: DoctorReport | null): boolean | null {
  const gh = report?.tools.find((t) => t.id === "gh");
  if (!gh || !gh.found) return null;
  return ghAnswerOf(report) ?? memory[key] ?? null;
}

const PROGRAM_FOLDERS_ROW = { to: "setting", section: "editor-terminals", row: "Program folders" } as const;

const DIAGNOSTICS = { to: "diagnostics" } as const;
const OPEN_DIAGNOSTICS = "Open Settings › Setup and account › Diagnostics";
const FIX = { label: "Fix", target: DIAGNOSTICS, title: OPEN_DIAGNOSTICS };
const FOLDERS_FIX = { label: "Fix", target: PROGRAM_FOLDERS_ROW, title: "Open Settings › Look and feel › Editor and terminals › Program folders" };

const AI_NAME: Record<TileCli, string> = { claude: "Claude Code", codex: "Codex" };

/** The tools whose state matters: the person's AI, or one they have a tile of. */
function usedAis(input: AttentionInput): TileCli[] {
  return (["claude", "codex"] as const).filter(
    (tool) =>
      input.chosen === tool ||
      input.tileKinds.some((k) => k === tool || (tool === "codex" && k === "codex-chat")),
  );
}

/** "and 2 more" — what the row says beside its own problem. */
export function andMoreWords(count: number): string {
  return `and ${count} more`;
}

/** The problems, most blocking first. Empty: nothing needs the person. */
export function needsAttention(input: AttentionInput): AttentionItem[] {
  const { report } = input;
  const out: AttentionItem[] = [];

  // Before the doctor's first answer only the shell snapshot may speak, and
  // only to say that neither AI tool was found at all.
  if (!report) {
    const none = input.env != null && !input.env.claudePath && !input.env.codexPath;
    if (none) {
      out.push({
        kind: input.programFolders ? "program-folders" : "ai-missing",
        id: "ai-missing",
        words: input.programFolders ? NO_AI_IN_FOLDERS : "No AI tool is installed",
        action: input.programFolders ? FOLDERS_FIX : FIX,
      });
    }
    return out;
  }

  const noAi = noAiSentence(report);
  const noAiInstalled = noAi === "No AI tool is installed";

  // 1. Program folders: set, and no AI tool in them (the probe says it too).
  if (input.programFolders && (noAiInstalled || isNoAiProbeError(report.probeError))) {
    out.push({
      kind: "program-folders",
      id: "program-folders",
      words: NO_AI_IN_FOLDERS,
      title: "Agents can't run without one. Claude Code or Codex is enough.",
      action: FOLDERS_FIX,
    });
  }

  // 2. A tool the person uses doesn't start; or no AI tool is there/ready.
  for (const tool of brokenClis({
    report,
    chosen: input.chosen,
    tileKinds: input.tileKinds,
    gone: input.gone,
    codexUpdating: input.codexUpdating,
  })) {
    out.push({
      kind: "ai-broken",
      id: `ai-broken:${tool}`,
      words: brokenCliRowText(tool),
      title: "Its tiles and agents can't start until it's repaired.",
      action: { label: "Repair", target: { to: "repair", tool }, title: `Repair ${AI_NAME[tool]}` },
    });
  }
  if (noAi && !(input.programFolders && noAiInstalled)) {
    out.push({
      kind: "ai-missing",
      id: "ai-missing",
      words: noAi,
      title: "Agents can't run without one. Claude Code or Codex is enough.",
      action: FIX,
    });
  }

  // 3. A required tool is missing: git (on a Mac, its Command Line Tools), and
  // Git Bash on Windows. The report has no "too old" state for them.
  const missing = missingRequiredTools(report);
  if (missing.length > 0) {
    const one = missing.length === 1;
    // 1.176.1 walk: with Program folders set, a tool missing from the
    // snapshot may well be installed — outside the folders set. Never
    // "isn't installed", never toward an installer.
    out.push({
      kind: "tool-missing",
      id: "tool-missing",
      words: input.programFolders
        ? `${missing.map((t) => t.name).join(" and ")} ${one ? "isn't" : "aren't"} in your Program folders`
        : `${missing.map((t) => t.name).join(" and ")} ${one ? "isn't" : "aren't"} installed`,
      title: `Agents can't run without ${one ? "it" : "them"}.`,
      action: input.programFolders ? FOLDERS_FIX : FIX,
    });
  }

  // 3b. A problem in a saved setting, found elsewhere and handed in.
  for (const p of input.settingProblems ?? []) {
    out.push({
      kind: "setting-problem",
      id: `setting-problem:${p.id}`,
      words: p.words,
      title: p.title,
      action: { label: "Open the setting", target: p.target, title: "Open the setting" },
    });
  }

  // 4. GitHub's command, for a project that uses GitHub. Not installed is
  // read from the report now; signed out only from a clear answer (the
  // report's own, or the last one seen for this account: `ghSignedIn`).
  if (input.usesGithub) {
    const gh = report.tools.find((t) => t.id === "gh");
    if (gh && !gh.found) {
      out.push({
        kind: "github-missing",
        id: "github-missing",
        words: input.programFolders ? "The gh command isn't in your Program folders" : "The gh command isn't installed",
        title: "This project uses GitHub: its pull requests and board need it.",
        action: input.programFolders ? FOLDERS_FIX : FIX,
      });
    } else if (gh && (input.ghSignedIn ?? ghAnswerOf(report)) === false) {
      out.push({
        kind: "github-signed-out",
        id: "github-signed-out",
        words: "GitHub isn't signed in",
        title: "This project uses GitHub: its pull requests and board need you signed in.",
        action: { label: "Sign in", target: DIAGNOSTICS, title: OPEN_DIAGNOSTICS },
      });
    }
  }

  // 5. An AI tool the person uses is signed out (clearly: not "couldn't tell").
  // With no AI ready at all, the row above already says so.
  if (aiReadyOf(report)) {
    for (const tool of usedAis(input)) {
      const row = report.tools.find((t) => t.id === tool);
      if (row && row.found && row.versionOk && row.auth?.signedIn === false && row.auth.optionalStep !== true) {
        out.push({
          kind: "ai-signed-out",
          id: `ai-signed-out:${tool}`,
          words: `${AI_NAME[tool]} is signed out`,
          title: "Its tiles and agents can't work until you sign in.",
          action: { label: "Sign in", target: DIAGNOSTICS, title: OPEN_DIAGNOSTICS },
        });
      }
    }
  }

  // 6. The shell couldn't be read at launch (with Program folders set, the
  // probe's error is the first item's).
  // The backend also sets the probe error whenever no AI tool resolves: that
  // is the missing-AI row's, never a shell that couldn't be read.
  const noAiSaid = out.some((i) => i.kind === "ai-missing" || i.kind === "program-folders");
  if (report.probeError && !isNoAiProbeError(report.probeError) && !noAiSaid && !input.programFolders) {
    out.push({
      kind: "shell-unread",
      id: "shell-unread",
      words: machineWords("Couldn't read this Mac's program folders"),
      title: "Tools may be missing from the list below only because Plyloft looked in the wrong place.",
      action: FIX,
    });
  }

  return out;
}
