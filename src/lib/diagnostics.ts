/**
 * UX language card 8 (GH #103; BOARDS.md §5 "Settings › Advanced ›
 * Diagnostics"): the Dependency Doctor's report as Procedure rows.
 *
 * A Procedure row states the condition and offers **the one step that changes
 * it** (PATTERNS.md §6). The doctor already knows every condition; what this
 * module adds is who takes the step:
 *
 *  - `ready` — nothing to do. The row's right side is the word `Ready`.
 *  - `ply` — Ply can do it itself, so it does: choosing zsh as the tile shell
 *    is a settings write, and telling somebody to go and type it in Settings ›
 *    Terminals & shell (which is what the doctor's copy did) is Ply asking for
 *    help with its own job.
 *  - `app` — a step inside Ply that is not a settings write: asking macOS for
 *    the microphone, opening its privacy pane, going to the Dictation page.
 *  - `person` — a command only the person can run, in **their** terminal:
 *    `gh auth login` asks questions and opens a browser, `brew install` writes
 *    outside Ply. Diagnostics opens a shell tile with it already running.
 *
 * Pure — no React, no Tauri — so `diagnostics.test.ts` builds a report for
 * every state the doctor can be in and checks the row each one produces.
 *
 * GH #173: this is the **one** row model. Settings › Diagnostics and Setup's
 * AI step draw a tool from `toolRow`, so they cannot word the same `gh`
 * differently. What differs is only whether the read behind them asks about
 * sign-in: Diagnostics does; the other shows a remembered answer if the
 * backend still holds a fresh one, and otherwise only found / not found.
 */

import type {
  DoctorReport,
  GitIdentityStatus,
  MicrophoneStatus,
  ReviewerCapability,
  ToolStatus,
  WhisperModelStatus,
  DictationShellStatus,
} from "../ipc.ts";
import type { UxError } from "./uxError.ts";
import { isWindows, machineWords } from "./platform.ts";
import { agoWords } from "./copyWords.ts";

export type RowSignal = "ok" | "warn" | "error";

export type DiagnosticFix =
  | { kind: "ready" }
  /** Ply writes the setting itself. */
  | { kind: "ply"; action: string; what: "tile-shell-zsh" }
  /** A step inside Ply that is not a settings write. `git-identity` (OB-2,
   *  OB-6): opens Setup at its Git step (step 4), which sets Git's name and
   *  email after a consent sheet. */
  | {
      kind: "app";
      action: string;
      what: "microphone" | "privacy-pane" | "dictation-page" | "git-identity" | "program-folders";
    }
  /** One bounded provider call that proves the reviewer cannot write. */
  | { kind: "probe"; action: string; provider: "claude" | "codex" }
  /** A command the person runs; Diagnostics opens a tile with it running.
   *  `update` (OB-2, D6): a newer release offered, never forced — the row is
   *  already ready, so nothing is watched. */
  | { kind: "person"; action: string; command: string; update?: true };

export interface DiagnosticRow {
  /** Stable, for a key and for a test. */
  id: string;
  /** What the row is called. `claude`, `gh` and `whisper-cli` are commands,
   *  so they read in mono; `Tile shell` and `Microphone` are not. */
  label: string;
  mono: boolean;
  signal: RowSignal;
  /** The doctor's own sentence. Ply does not paraphrase it: `doctor.rs` has
   *  unit tests on these words. */
  hint: string;
  fix: DiagnosticFix;
  /** A required tool that is missing is an error; an optional one is a
   *  warning. Drawn as a chip on the row, not only in the colour. */
  required: boolean;
  /** OB-2 review (P3-4): the chip's own word when neither `Required` nor
   *  `Optional` is true — the two AIs while neither is ready (`One needed`). */
  chip?: string;
  /** Where the thing is, when it was found. Drawn in mono after the hint. */
  where?: string | null;
  /** What it calls itself: `v2.60.0`, `bash 3.2.57`, the model's name. Drawn
   *  as a chip beside the label. */
  version?: string | null;
  /** The page that explains it, copyable — Ply has no URL opener, so this is
   *  reachable rather than clickable (as it was before this card). */
  docs?: string | null;
  /** The command a person would run, when there is one. Copyable from the
   *  row's menu even once the row is `Ready`. */
  command?: string | null;
  /** GH #169 review 1: a step offered beside a neutral row rather than as its
   *  own — `claude auth login` when Ply could not see a sign-in. Drawn in the
   *  row's menu, never as the row's button. */
  secondary?: { kind: "person"; action: string; command: string } | null;
  /** 1.174.0 (DS7): the technical sentence behind a short hint, which ⋯ ›
   *  Copy details copies whole (a reviewer's proof). */
  details?: string | null;
}

/** `Choose zsh` writes this (BOARDS.md §5). It is the shell macOS logs every
 *  account into since Catalina, and it understands pasted text. */
export const ZSH = "/bin/zsh";

/** Windows (W5): PowerShell 7 is the shell there that understands pasted
 *  text; it is what the row offers in zsh's place. */
export const PWSH = "pwsh";

/** The shell `Choose …` writes on this platform. */
export function preferredTileShell(): string {
  return isWindows() ? PWSH : ZSH;
}

const READY: DiagnosticFix = { kind: "ready" };

/** OB-2: rows whose id is not a command read in words, not mono. */
const WORD_LABEL: Partial<Record<string, string>> = { "git-bash": "Git Bash" };

/** 1.176.1 walk: a tool the snapshot didn't find while Program folders is
 *  set — it may well be installed, outside the folders set. */
export const NOT_IN_FOLDERS = "Not in your Program folders.";

/** A tool row: found, found-but-not-usable, signed out, or missing.
 *  `programFoldersSet`: Program folders is set in Settings, so a missing tool
 *  is "not in your Program folders" and its fix opens that row — never an
 *  installer for a tool that may exist. */
export function toolRow(tool: ToolStatus, programFoldersSet = false): DiagnosticRow {
  const auth = tool.auth ?? null;
  // GH #169 review 1: an answer whose step is only offered (claude, when Ply
  // could not see a sign-in; GH #189: gh, when the keychain is locked) is
  // neutral — it counts as ready and warns about nothing, because the person
  // may well be signed in in a way Ply cannot see.
  const offered = auth != null && auth.signedIn !== true && auth.optionalStep === true;
  const asked = offered ? null : auth;
  // OB-2 (D6): a newer release is offered quietly, and only on a tool that is
  // otherwise fine to run.
  const update = tool.found && tool.versionOk ? (tool.update ?? null) : null;
  // A tool Ply asked about sign-in and did not get a clear `yes` for is not
  // ready: `signedIn: null` means Ply could not tell, and a row that says
  // `Ready` while offering `Check` claims both at once.
  const signal: RowSignal = !tool.found
    ? tool.required
      ? "error"
      : "warn"
    : !tool.versionOk || (asked != null && asked.signedIn !== true)
      ? "warn"
      : "ok";
  // What needs doing, most blocking first: a missing tool before a stale one,
  // a stale one before a sign-in, a sign-in before a newer release.
  const outside = !tool.found && programFoldersSet;
  const fix: DiagnosticFix = outside
    ? { kind: "app", action: "Open Program folders", what: "program-folders" }
    : !tool.found
    ? {
        kind: "person",
        // P3-5: Git Bash is not installed on its own; Git for Windows brings it.
        action: tool.id === "git-bash" ? "Install Git for Windows" : "Install",
        command: tool.installCmd,
      }
    : !tool.versionOk
      ? {
          kind: "person",
          // 1.176.0 R3: a Claude or Codex that doesn't answer `--version` is
          // reinstalled (`installCmd` is then the official installer); only
          // one that runs and is old is updated.
          action: (tool.id === "claude" || tool.id === "codex") && tool.version == null ? "Reinstall" : "Update",
          command: tool.installCmd,
        }
      : asked && asked.signedIn !== true
        ? { kind: "person", action: asked.action, command: asked.command }
        : update
          ? { kind: "person", action: "Update", command: update.command, update: true }
          : READY;
  // The sign-in sentence replaces the tool's own only once the tool itself
  // is fine: "install it" and "sign in" are not both true.
  const base = outside ? NOT_IN_FOLDERS : tool.found && tool.versionOk && auth ? auth.detail : tool.detail;
  const word = WORD_LABEL[tool.id];
  return {
    id: `tool:${tool.id}`,
    label: word ?? tool.id,
    mono: word == null,
    signal,
    // G2 Windows walk: with a newer version, "Nothing to do." beside Update
    // contradicts it — the row says it is fine and that a newer one exists.
    hint: update ? `${base.replace(/\s*Nothing to do\.$/, "")} ${update.detail}` : base,
    fix,
    required: tool.required,
    where: tool.path,
    version: tool.version,
    docs: tool.docsUrl,
    command: outside ? null : tool.installCmd,
    secondary:
      offered && tool.found && tool.versionOk && auth
        ? { kind: "person", action: auth.action, command: auth.command }
        : null,
  };
}

/** OB-2: whether Git knows who commits. Read only; `Set` goes where it is set. */
export function identityRow(status: GitIdentityStatus): DiagnosticRow {
  return {
    id: "git-identity",
    label: "Git identity",
    mono: false,
    signal: status.set ? "ok" : "warn",
    hint: status.detail,
    fix: status.set ? READY : { kind: "app", action: "Set", what: "git-identity" },
    required: false,
  };
}

/** OB-2 (§13.1): one AI is enough. Older-shaped reports (no `aiReady`) read
 *  it from the two rows. */
export function aiReadyOf(report: DoctorReport): boolean {
  return (
    report.aiReady ??
    report.tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found)
  );
}

/** The sidebar's words when no AI is ready: none found, or found and not
 *  usable (not starting, signed out). Null when one is ready. */
export function noAiSentence(report: DoctorReport): string | null {
  if (aiReadyOf(report)) return null;
  const found = report.tools.some((t) => (t.id === "claude" || t.id === "codex") && t.found);
  return found ? "No AI tool is ready" : "No AI tool is installed";
}

/** The required tools that are missing (git; Git Bash on Windows). The AIs
 *  are never here: each is optional, and `noAiSentence` says when neither is
 *  ready. */
export function missingRequiredTools(report: DoctorReport): { id: string; name: string }[] {
  if (report.allRequiredOk) return [];
  return report.tools
    .filter((t) => t.required && !t.found)
    .map((t) => ({ id: String(t.id), name: t.name }));
}

/** The welcome screen's warning under the tools, or null when all is well. */
export function welcomeWarning(report: DoctorReport | null): string | null {
  if (!report || report.allRequiredOk) return null;
  const tools = missingRequiredTools(report);
  const noAi = noAiSentence(report);
  const names = tools.map((t) => t.name).join(" and ");
  if (tools.length > 0 && noAi) {
    return `${names} and an AI tool (Claude or Codex) aren't ready yet — you can still look around, but agents won't run until the rows above are ready.`;
  }
  if (tools.length > 0) {
    const one = tools.length === 1;
    return `${names} ${one ? "isn't" : "aren't"} installed yet — you can still look around, but cards can't start until ${one ? "it is" : "they are"}.`;
  }
  if (noAi) {
    return `${noAi} yet. One is enough: Claude or Codex. You can still look around, but agents won't run until one is ready.`;
  }
  return null;
}

/**
 * The reviewer capability rows (GH #103 review 1, finding 3b).
 *
 * The sectioned Settings drew this under each provider tool: what Ply has
 * *proved* about that CLI's ability to write during a review, and the one
 * bounded call that proves it again. Reducing it to a line under `Details` lost
 * the only way to re-run the proof, so it is a Procedure row of its own — the
 * condition on the left, `Run the proof` on the right, and `Ready` once the
 * proof is current.
 */
export function reviewerRow(tool: ToolStatus, now: number = Date.now()): DiagnosticRow | null {
  const r: ReviewerCapability | null | undefined = tool.reviewer;
  if (!r || !tool.found) return null;
  const provider = tool.id === "codex" ? "codex" : "claude";
  const signal: RowSignal = r.probing ? "warn" : r.stale ? "warn" : r.eligible ? "ok" : "warn";
  const name = provider === "codex" ? "Codex" : "Claude";
  return {
    id: `reviewer:${tool.id}`,
    // 1.174.0 (X5, owner): the row names the AI and its role; its line says
    // what was proved, and the proof itself is behind ⋯ › Copy details.
    label: `${name} as a reviewer`,
    mono: false,
    signal,
    hint: reviewerSummary(r, now),
    fix:
      r.probing || (r.eligible && !r.stale)
        ? READY
        : {
            kind: "probe",
            action: r.probedAt ? "Prove it again" : "Run the proof",
            provider,
          },
    required: false,
    version: r.level ? REVIEWER_LEVEL[r.level] : null,
    where: r.executablePath,
    // DS7 round 1: the level, then the proof, whole.
    details: r.proof ? (r.level ? `${REVIEWER_LEVEL[r.level]}: ${r.proof}` : r.proof) : null,
  };
}

/** 1.174.0 (DS7): a reviewer's proof in a few words, by its outcome — the
 *  long sentence (`review_capabilities.rs`) is the row's Copy details. */
export function reviewerSummary(r: ReviewerCapability, now: number): string {
  if (r.probing) {
    return r.stale
      ? "Updated since its last proof; Plyloft is running the proof again in the background."
      : "Plyloft is running the proof now.";
  }
  if (r.stale) return "It has updated since, so the proof is out of date.";
  if (r.eligible) return r.probedAt ? `checked ${agoWords(r.probedAt, now)}` : "checked";
  switch (r.outcome) {
    case null:
      return "Not proved yet.";
    case "passed":
      return "Its last proof couldn't show that it can't change files, so it doesn't review.";
    case "write-escaped":
      return "A change got through in its last proof, so it doesn't review.";
    case "quota-blocked":
      return "Its last proof hit your plan's limit. Run it again later.";
    case "auth-blocked":
      return "Its last proof needed a sign-in. Sign in, then run it again.";
    case "timed-out":
      return "Its last proof took too long. Run it again.";
    case "inconclusive":
      return "Its last proof showed nothing either way, so it doesn't review.";
    default:
      return "Its last proof didn't show that it can't change files, so it doesn't review.";
  }
}

/** 1.174.0 (DS7, scene 13): a tool row is titled by what it is for; the
 *  program and its version go in the hint ("git 2.46 · Ready."). */
const PURPOSE: Readonly<Record<string, string>> = {
  "tool:git": "Gives each card its own copy of the project",
  "tool:gh": "Opens pull requests and reads GitHub's checks",
  "tool:claude": "Claude",
  "tool:codex": "Codex",
  "tool:node": "Runs Codex",
  "tool:git-bash": "Runs your project checks",
  "tool:whisper-cli": "Dictation",
};

/** The row's title on Settings › Diagnostics. */
export function diagnosticsTitle(row: DiagnosticRow): string {
  return PURPOSE[row.id] ?? row.label;
}

/** The row's hint on Settings › Diagnostics: the program and its version
 *  first (a reviewer's row keeps them in Copy details), then the sentence. */
export function diagnosticsHint(row: DiagnosticRow): string {
  if (row.id.startsWith("reviewer:")) return row.hint;
  return withProgram(row, shortModelHint(row.hint));
}

/** F6 (1.176.2): the doctor's "Not downloaded — Settings › Look and feel ›
 *  Dictation › The model file › Download (~466 MB)." sits beside Open
 *  Dictation, which goes there: the row says what is missing, not the path. */
export function shortModelHint(hint: string): string {
  return hint.replace(/^Not downloaded — Settings ›[^(]*\((~[\d.]+ MB)\)\.$/, "Not downloaded ($1).");
}

function withProgram(row: DiagnosticRow, sentence: string): string {
  const program = row.id.startsWith("tool:") ? row.label : null;
  const version = row.version?.trim() || null;
  const head =
    program && version
      ? version.toLowerCase().startsWith(program.toLowerCase())
        ? version
        : `${program} ${version}`
      : (program ?? version);
  return head ? `${head} · ${sentence}` : sentence;
}

/** What a reviewer capability level is called (the sectioned Settings' words). */
export const REVIEWER_LEVEL: Record<string, string> = {
  "os-sandboxed": "OS sandboxed",
  "harness-enforced": "Harness enforced",
  "prompt-only": "Prompt only",
};

/** Every provider CLI Ply has something to say about, in report order. */
export function reviewerRows(report: DoctorReport, now: number = Date.now()): DiagnosticRow[] {
  return report.tools
    .map((tool) => reviewerRow(tool, now))
    .filter((row): row is DiagnosticRow => row !== null);
}

/** The shell new tiles run. The one row Ply can put right itself. */
export function tileShellRow(status: DictationShellStatus): DiagnosticRow {
  const signal: RowSignal = !status.found ? "error" : status.ok ? "ok" : "warn";
  return {
    id: "tile-shell",
    label: "Tile shell",
    mono: false,
    signal,
    version: status.label,
    hint: status.detail,
    // Ply cannot choose zsh *as the answer* when zsh is what is already
    // failing — a broken `/bin/zsh` would offer itself as its own fix.
    fix:
      status.ok || status.shell === preferredTileShell()
        ? status.ok
          ? READY
          : isWindows()
            ? { kind: "person", action: "Install PowerShell 7", command: "winget install --id Microsoft.PowerShell" }
            : { kind: "person", action: "Install bash 5", command: "brew install bash" }
        : {
            kind: "ply",
            action: isWindows() ? "Choose PowerShell 7" : "Choose zsh",
            what: "tile-shell-zsh",
          },
    required: false,
    where: status.shell,
  };
}

export function microphoneRow(status: MicrophoneStatus): DiagnosticRow {
  const signal: RowSignal =
    status.access === "granted" ? "ok" : status.access === "denied" ? "error" : "warn";
  return {
    id: "microphone",
    label: "Microphone",
    mono: false,
    signal,
    hint: status.detail,
    fix:
      status.access === "granted"
        ? READY
        : status.access === "denied"
          ? {
              kind: "app",
              action: isWindows() ? "Open Settings" : "Open System Settings",
              what: "privacy-pane",
            }
          : { kind: "app", action: machineWords("Ask macOS"), what: "microphone" },
    required: false,
  };
}

export function whisperModelRow(status: WhisperModelStatus): DiagnosticRow {
  return {
    id: "whisper-model",
    label: "Dictation model",
    mono: false,
    signal: status.present ? "ok" : "warn",
    version: status.model,
    hint: status.detail,
    fix: status.present
      ? READY
      : { kind: "app", action: "Open Dictation", what: "dictation-page" },
    required: false,
    where: status.path,
  };
}

/**
 * `What Ply needs`, in the order the board reads them: the tools, then the
 * shell they will run in, then what dictation needs.
 */
export function needsRows(report: DoctorReport, programFoldersSet = false): DiagnosticRow[] {
  // OB-2 review (P3-4): with no AI ready, the two AI rows are what is
  // missing — drawn as the missing-required state, each saying one is enough.
  const noAi = !aiReadyOf(report);
  const rows = report.tools.map((tool) => {
    const row = toolRow(tool, programFoldersSet);
    if (noAi && (tool.id === "claude" || tool.id === "codex") && row.signal !== "ok") {
      return { ...row, signal: "error" as const, chip: "One needed" };
    }
    return row;
  });
  if (report.gitIdentity) rows.push(identityRow(report.gitIdentity));
  if (report.dictationShell) rows.push(tileShellRow(report.dictationShell));
  if (report.microphone) rows.push(microphoneRow(report.microphone));
  if (report.whisperModel) rows.push(whisperModelRow(report.whisperModel));
  return rows;
}

/** `2 of 3 ready` (BOARDS.md §5). */
export function readyLine(rows: DiagnosticRow[]): string {
  const ready = rows.filter((r) => r.signal === "ok").length;
  return `${ready} of ${rows.length} ready`;
}

/**
 * What a row's `Details` shows, in mono: the raw facts the doctor read for it.
 * Everything the report holds about the row and nothing invented, so a person
 * showing this to somebody else is showing the probe's own words.
 */
export function rowDetails(report: DoctorReport, row: DiagnosticRow): string | null {
  if (row.id.startsWith("tool:")) {
    const tool = report.tools.find((t) => `tool:${t.id}` === row.id);
    if (!tool) return null;
    const lines = [
      `${tool.id}: ${tool.found ? (tool.path ?? "found") : "not found"}`,
      `version: ${tool.version ?? "(not reported)"}${tool.versionOk ? "" : " — below what Plyloft needs"}`,
      `required: ${tool.required ? "yes" : "no"}`,
      `install: ${tool.installCmd}`,
      `docs: ${tool.docsUrl}`,
    ];
    if (tool.auth) {
      lines.push(
        `signed in: ${tool.auth.signedIn === null ? "Plyloft could not tell" : tool.auth.signedIn ? "yes" : "no"}`,
      );
    }
    if (tool.update) lines.push(`latest: ${tool.update.latest} (update: ${tool.update.command})`);
    if (tool.reviewer) {
      lines.push(
        `reviewer: ${tool.reviewer.level}${tool.reviewer.outcome ? ` · ${tool.reviewer.outcome}` : ""}`,
      );
    }
    return lines.join("\n");
  }
  if (row.id === "tile-shell" && report.dictationShell) {
    const s = report.dictationShell;
    return [
      `shell: ${s.shell}`,
      `found: ${s.found ? "yes" : "no"}`,
      `reads pasted text: ${s.ok ? "yes" : "no"}`,
      `version: ${s.label}`,
    ].join("\n");
  }
  if (row.id === "git-identity" && report.gitIdentity) {
    const g = report.gitIdentity;
    return [
      `user.name: ${g.name ?? "(not set)"}`,
      `user.email: ${g.email ?? "(not set)"}`,
      "read with: git config --global --get",
    ].join("\n");
  }
  if (row.id === "microphone" && report.microphone) {
    return `access: ${report.microphone.access}`;
  }
  if (row.id === "whisper-model" && report.whisperModel) {
    const m = report.whisperModel;
    return [`model: ${m.model}`, `present: ${m.present ? "yes" : "no"}`, `path: ${m.path}`].join("\n");
  }
  return null;
}

/** Everything the probe said, for `If you need to show someone`. */
export function allDetails(report: DoctorReport): string {
  const parts: string[] = [];
  if (report.probeError) parts.push(`probe: ${report.probeError}`);
  for (const row of needsRows(report)) {
    const d = rowDetails(report, row);
    if (d) parts.push(d);
  }
  if (report.teamSkills) parts.push(`team skills: ${report.teamSkills.detail}`);
  if (report.projectSkills) {
    parts.push(`${report.projectSkills.workspace} skills: ${report.projectSkills.detail}`);
    // GH #227: git's own words for what it wouldn't answer — the row says it
    // in plain words.
    for (const line of report.projectSkills.gitDetails ?? []) {
      parts.push(`${report.projectSkills.workspace} skills, git: ${line}`);
    }
  }
  if (report.sharedDefinition) {
    parts.push(
      `shared definition (${report.sharedDefinition.workspace}): ${report.sharedDefinition.state} — ${report.sharedDefinition.detail}`,
    );
  }
  if (report.railway) {
    parts.push(`railway (${report.railway.workspace}): ${report.railway.state} — ${report.railway.summary}`);
    if (report.railway.technical) parts.push(`railway said: ${report.railway.technical}`);
  }
  return parts.join("\n\n");
}

/**
 * Whether the doctor's `probeError` only says that no AI tool was found
 * (`shell_env::ai_probe_error`: with neither claude nor codex resolved, the
 * backend sets it every time), as against a shell that really couldn't be
 * read. The words are the backend's constants, in both forms.
 */
export function isNoAiProbeError(probeError: string | null | undefined): boolean {
  if (!probeError) return false;
  // 1.176.1 walk 2: the backend now names the setting ("…in your Program
  // folders"); the older words are still read.
  return (
    probeError.startsWith("No AI tool found.") ||
    probeError.startsWith("Neither claude nor codex is in your Program folders") ||
    probeError.startsWith("Neither claude nor codex is in the PATH you set")
  );
}

/**
 * Whether a Settings PATH override is in effect: what `shell.pathOverride`
 * holds, blank counting as none (the backend's `configure_path_override`).
 * With one set, Plyloft never asks the login shell — not at startup, not on
 * `Look again` — so no sentence on this page may say it does.
 */
export function hasPathOverride(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** The `Look again, from scratch` row's hint. */
export function lookAgainHint(override: boolean, windows: boolean = isWindows()): string {
  if (override) {
    return "Plyloft looks again in the program folders you set in Editor and terminals, instead of reading what it noted at startup.";
  }
  // Windows has no login shell to ask (`shell_env::run_probe`): Plyloft
  // reads the program folders Windows gave it, adds the folders these tools
  // usually install into, and looks for each tool there.
  return windows
    ? "Plyloft looks again in the program folders Windows gave it and where these tools usually install, instead of reading what it noted at startup."
    : "Plyloft asks your login shell all over again, instead of reading what it noted at startup.";
}

/** The `Checking…` row's hint while the first report is on its way. */
export function checkingHint(override: boolean, windows: boolean = isWindows()): string {
  if (override) return "Plyloft is looking in the program folders you set in Editor and terminals.";
  return windows
    ? "Plyloft is looking in the program folders Windows gave it."
    : "Plyloft is asking your login shell.";
}

/**
 * The probe itself failed: Ply asked the login shell what is on PATH and got
 * an answer it could not use, so **every** row below is a guess. In the error
 * shape (BOARDS.md §5, PATTERNS.md §4), because it is the one thing on this
 * page that is wrong with Ply rather than with the Mac.
 *
 * With a PATH override set the login shell was never asked: the one probe
 * error then is that neither claude nor codex is in that PATH
 * (`shell_env::ai_probe_error`), and the way out is that PATH, not the shell.
 *
 * `Details` holds the probe's own words, closed like every other disclosure
 * (PATTERNS.md §4): no board draws this one open, and `What happened` already
 * carries the sentence the shell gave.
 */
export function probeFailedError(
  probeError: string,
  override = false,
  windows: boolean = isWindows(),
  reason: string | null = null,
): UxError {
  if (override) {
    // 1.176.1: why the setting can't work, when its reading says
    // (`programFolders.problemReason`: "it names a file, not a folder").
    const why = reason ? ` They can't work as written: ${reason}.` : "";
    return {
      title: "Plyloft found no AI tool in the program folders you set.",
      happened:
        "Plyloft looked only in the program folders you set in Editor and terminals, and neither claude nor codex is there." +
        why,
      untouched:
        "Nothing was changed. Everything below was read from those folders, so a row saying a tool is missing may only mean those folders leave its folder out.",
      todo: windows
        ? "Check those folders, or empty them so Plyloft looks in the folders Windows gave it again."
        : "Check those folders, or empty them so Plyloft asks your login shell again.",
      actions: [
        { id: "reprobe", label: "Look again", primary: true },
        { id: "path", label: "Open Program folders" },
      ],
      details: probeError,
    };
  }
  return {
    title: machineWords("Plyloft couldn't read this Mac's program folders."),
    happened: windows
      ? `It looked in the program folders Windows gave it and the answer came back unusable: ${probeError}`
      : `It asked your login shell where your tools are and the answer came back unusable: ${probeError}`,
    untouched:
      "Nothing was changed. Everything below was read from whatever program folders Plyloft fell back to, so a row saying a tool is missing may only mean Plyloft looked in the wrong place.",
    todo: "Try again — and if it keeps happening, set the program folders yourself in Editor and terminals.",
    actions: [
      { id: "reprobe", label: "Ask again", primary: true },
      { id: "path", label: "Set the folders myself" },
    ],
    details: probeError,
  };
}

/**
 * How long to wait before reading the report again, while a row is being waited
 * on (GH #103).
 *
 * It backs off, and that is not a nicety. Reading the report asks `gh auth
 * status`, which validates the stored token **over the network**: a flat
 * four-second poll for ten minutes is a hundred and fifty requests to GitHub
 * for one login. The first half minute is when the answer usually changes, so
 * that part is quick and the rest is not — about twenty-five reads over the
 * whole wait.
 */
export function watchDelayMs(waitedMs: number): number {
  if (waitedMs < 30_000) return 3_000;
  if (waitedMs < 120_000) return 10_000;
  return 30_000;
}

/**
 * The two flags a doctor read sends (`dependency_doctor(withAuth, forceAuth)`).
 *
 * GH #173: every read goes through here, so a read that does not ask about
 * sign-in — app launch, a workspace switch, the welcome screen, the banner —
 * cannot force one either. `force` only means something on a read that asks.
 */
export function doctorReadArgs(withAuth: boolean, force: boolean): [boolean, boolean] {
  return [withAuth, withAuth && force];
}

/** How long Ply keeps waiting before it stops asking. A `brew install` can take
 *  minutes; a login rarely does. */
export const WATCH_LIMIT_MS = 5 * 60 * 1000;
