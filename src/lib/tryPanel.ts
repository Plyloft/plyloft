// Try it TI-4 (docs/try-it/TRY_IT_SPEC.md §3.1, §3.3, §4.4, §6, §7): the
// card's Try it — when the button is offered, what a press asks first (the
// command, this machine's OK, the copy's packages), what the panel says in
// each state, and when the session's command has ended. Pure: no store, no
// IPC, no DOM, so node runs `tryPanel.test.ts`. `store/tryRunStore.ts` runs it.

import type { CardPresentationState, TryCommandView } from "../ipc.ts";
import { AnsiStripper, COMMAND_DONE_MARK, CURSOR_LINE_MARK, loopbackUrl, portOfAddress } from "./tryAddress.ts";
import { machineWords, type Platform, platform } from "./platform.ts";
import type { TourAnchor } from "./tutorial/manifest.ts";

/** The button, everywhere it is drawn. */
export const TRY_IT_LABEL = "Try it";
/** The tutorial's anchor (TUTORIAL_SPEC B9) on the Now box's Try it: one of
 *  the manifest's `TOUR_ANCHORS`, the one place the id is written for it. */
export const TRY_IT_TOUR = "card-try-it" satisfies TourAnchor;

/** The probe of the card's ports runs every 2 s until an address is found,
 *  and gives up after 60 s (spec §4.2). */
export const PROBE_EVERY_MS = 2_000;
export const ADDRESS_WAIT_MS = 60_000;
/** A PowerShell session whose command ends this soon with no address offers
 *  the `.cmd` form (spec §7's fallback). */
export const QUICK_EXIT_MS = 10_000;
/** What Couldn't start shows of the output (spec §7). */
export const TAIL_LINES = 40;

// ── When the button is offered (spec §3.1) ──────────────────────────────

/** The states in which a card's copy holds the Builder's changes: ready to
 *  ship, changes requested, checks done (or being run, or stale), and a
 *  failed check — the changes are there to look at. */
const CHANGED_STATES: ReadonlySet<CardPresentationState> = new Set<CardPresentationState>([
  "ready-to-ship",
  "changes-requested",
  "result-ready",
  "review-stale",
  "verify-failed",
  "checking",
  "challenger-reviewing",
]);

/** What the rule reads of a card. */
export interface TryOfferCard {
  archived?: boolean | null;
  prReview?: unknown;
  worktreePath?: string | null;
  builder?: { snapshots?: ReadonlyArray<unknown> | null } | null;
  buildBoth?: { lanes: ReadonlyArray<{ worktreePath: string; done?: unknown }> } | null;
}

/**
 * Whether the card offers Try it: it has a copy with changes in it. A
 * changed state, or a Builder that saved at least one round (stopped with
 * changes, back at work on them), or — built by both and not picked yet — a
 * build that is done. Never before the first change, never on a shipped,
 * archived or pull-request card (after Ship is TI-5's).
 */
export function tryItOffered(
  card: TryOfferCard,
  state: CardPresentationState,
  undecidedBuildBoth: boolean,
): boolean {
  if (card.archived || card.prReview) return false;
  if (state === "shipped" || state === "shipping" || state === "archived" || state === "closed") return false;
  if (undecidedBuildBoth) return !!card.buildBoth?.lanes.some((l) => l.done && l.worktreePath);
  if (!card.worktreePath?.trim()) return false;
  if (CHANGED_STATES.has(state)) return true;
  return (card.builder?.snapshots?.length ?? 0) > 0;
}

// ── What a press asks first (spec §3.1 steps 1–3, §4.4) ─────────────────

export type TryAsk =
  /** The repository's command, not run on this machine yet: Allow and run. */
  | { kind: "approve"; command: string }
  /** No packages in the copy, and worktree setup is set: Install and try
   *  (Allow and run first when this machine hasn't allowed it). */
  | { kind: "install"; setup: string; approved: boolean }
  /** No packages, and no setup: Set it up and try writes `install` — or,
   *  where this machine can't save the repository's settings (`readOnly`),
   *  Install them this time runs it once, unsaved. `shared`: the setup
   *  would reach everyone who opens the repo. */
  | { kind: "setUp"; install: string; shared: boolean; readOnly: boolean; creates?: string | null }
  /** TI-5: Try it in <project> — no packages in the project folder itself:
   *  Install and try runs `install` there once — the lockfile's frozen form,
   *  or the plain install, which also creates `creates` (worktree setup is
   *  about cards' copies, so it is neither run nor offered here). */
  | { kind: "projectInstall"; install: string; creates: string | null };

export type TryPreflight =
  /** No start command: the How to start your app sheet. */
  | { kind: "sheet" }
  | { kind: "ask"; ask: TryAsk }
  | { kind: "start"; command: string };

/**
 * What Try it does now. `view` is the start command as read now;
 * `needsPackages` the copy's check (`try_copy_needs_packages`: the install
 * its lockfile calls for — the frozen form, `npm ci`…, with a lockfile, so
 * it is never rewritten into the card's change — or null when nothing is
 * missing), asked only once a command is allowed; `setup` this repository's
 * worktree setup and the command this machine allowed.
 */
export function tryPreflight(input: {
  view: Pick<TryCommandView, "command" | "approved" | "shared" | "readOnly">;
  needsPackages: { command: string; creates?: string | null } | null;
  setup: { command: string | null | undefined; approved: string | null | undefined } | null;
  /** TI-5: the project folder after Ship, not a card's copy — and, when
   *  it has no packages, how they would be installed there
   *  (`try_project_needs_packages`); `needsPackages` is not read then. */
  project?: boolean;
  projectInstall?: { command: string; creates: string | null } | null;
}): TryPreflight {
  const command = input.view.command?.trim();
  if (!command) return { kind: "sheet" };
  if (!input.view.approved) return { kind: "ask", ask: { kind: "approve", command } };
  if (input.project) {
    const plan = input.projectInstall;
    return plan
      ? { kind: "ask", ask: { kind: "projectInstall", install: plan.command, creates: plan.creates } }
      : { kind: "start", command };
  }
  if (input.needsPackages) {
    const setup = input.setup?.command?.trim();
    if (setup) {
      const approved = input.setup?.approved?.trim() === setup;
      return { kind: "ask", ask: { kind: "install", setup, approved } };
    }
    return {
      kind: "ask",
      ask: {
        kind: "setUp",
        install: input.needsPackages.command,
        ...(input.needsPackages.creates ? { creates: input.needsPackages.creates } : {}),
        shared: !!input.view.shared,
        readOnly: !!input.view.readOnly,
      },
    };
  }
  return { kind: "start", command };
}

/** The repository's command, not run here before — the worktree setup's
 *  words (spec §3.1 step 2). */
export function approvalLine(command: string, p: Platform = platform()): string {
  return machineWords(`"${command}" comes from this repository and hasn't run on this Mac before.`, p);
}

/** The setUp ask's button: saves the setup command, then installs and tries. */
export const SET_UP_AND_TRY = "Set it up and try";
/** The setUp ask's field: the setting's own name (Settings › Building and
 *  checking, `rowLabel("worktreeSetup")` since 1.174.0). */
export const SETUP_FIELD_LABEL = "Before the Builder starts, run";

/** The setUp ask's field, as typed: what Set it up and try saves, or null
 *  when there is nothing to save (the button is off). */
export function setupToSave(typed: string): string | null {
  const command = typed.trim();
  return command ? command : null;
}

/** The ask's sentence and its button. */
export function askWords(
  ask: TryAsk,
  p: Platform = platform(),
  /** setUp: the Setup command field as it stands — the lockfile note is
   *  about the suggestion, so it goes once the field says something else. */
  setupTyped?: string,
): { sentence: string; action: string } {
  switch (ask.kind) {
    case "approve":
      return { sentence: approvalLine(ask.command, p), action: "Allow and run" };
    case "install":
      return ask.approved
        ? { sentence: "This copy needs its packages first.", action: "Install and try" }
        : {
            sentence: `This copy needs its packages first. ${approvalLine(ask.setup, p)}`,
            action: "Allow and run",
          };
    case "setUp": {
      // Yarn 2+ has no install without a lockfile: say it writes one.
      const suggested = setupTyped == null || setupTyped.trim() === ask.install.trim();
      const creates = ask.creates && suggested ? ` It also creates ${ask.creates} in the card's copy.` : "";
      return ask.readOnly
        ? {
            sentence: `This copy needs its packages first. Plyloft can install them with "${ask.install}" this time; making it the repository's setup is up to someone who can change it.${creates}`,
            action: "Install them this time",
          }
        : {
            // 1.168.1 B4 (owner): the command is a field under this
            // sentence, pre-filled, and saved only by the press.
            sentence: `Cards' copies start without packages. Plyloft can install them in each new copy with the setup command below. It's saved for this repository when you press ${SET_UP_AND_TRY}.${creates}`,
            action: SET_UP_AND_TRY,
          };
    }
    case "projectInstall":
      return {
        sentence:
          `Your project has no packages yet. Install them with "${ask.install}" in your project's folder?` +
          (ask.creates ? ` It also creates ${ask.creates} there.` : ""),
        action: "Install and try",
      };
  }
}

// ── The How to start your app sheet (spec §3.3) ─────────────────────────

export const TRY_SHEET_TITLE = "How to start your app";
export const TRY_SHEET_LEDE = "Plyloft will start your app with this command, in the card's own copy of your project.";
/** The same sheet for Try it in <project> (TI-5), from Code's strip. */
export const TRY_SHEET_PROJECT_LEDE = "Plyloft will start your app with this command, in your project's folder.";
export const TRY_SHEET_NOTHING_FOUND =
  'Plyloft couldn\'t tell how this app starts. Type the command you\'d use in a terminal, for example "npm run dev".';
export const TRY_SHEET_STATIC = "This looks like a plain website.";

/** What the sheet opens on: the suggestion in the field, the static-site
 *  offer, or an empty field. */
export function sheetStart(view: Pick<TryCommandView, "command" | "detection"> | null): {
  kind: "suggested" | "staticSite" | "nothing";
  text: string;
} {
  const saved = view?.command?.trim();
  if (saved) return { kind: "suggested", text: saved };
  const d = view?.detection;
  if (d && (d.kind === "packageScript" || d.kind === "django" || d.kind === "rails")) {
    return { kind: "suggested", text: d.command };
  }
  if (d?.kind === "staticSite") return { kind: "staticSite", text: "" };
  return { kind: "nothing", text: "" };
}

// ── The panel's states (spec §3.1 step 4, §6, §7) ───────────────────────

export type TryPhase =
  /** A pre-flight question waits for the member (`ask`). */
  | "ask"
  /** Worktree setup is installing the copy's packages. */
  | "installing"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

/** One card copy's Try it, as the panel draws it. In memory only. */
export interface TryRun {
  phase: TryPhase;
  ask?: TryAsk | null;
  /** The start command as saved (what Details names). */
  command: string;
  tileId: string | null;
  address: string | null;
  /** The address is https: Open in browser only. */
  secure: boolean;
  /** Where the address came from. */
  source: "printed" | "probe" | "typed" | null;
  /** 60 s passed with no address while the command still runs. */
  noAddress: boolean;
  /** PowerShell refused a script (Try again runs `cmdForm`), or a
   *  PowerShell session ended at once with a command that has a `.cmd` form
   *  (Try again the other way runs it). */
  blocked: "scripts" | "quickExit" | null;
  /** The command ended right after it started, with no address. */
  quickExit?: boolean;
  /** Stop didn't go through: say so, the session still runs. */
  stopFailed?: boolean;
  cmdForm: string | null;
  /** The last lines the session printed, ANSI stripped. */
  lines: string[];
  /** The packages' install failed (worktree setup's own log in `lines`). */
  installFailed?: boolean;
  /** A start that never got going (the tile didn't start), in words. */
  error?: string | null;
}

export function emptyRun(command: string): TryRun {
  return {
    phase: "starting",
    ask: null,
    command,
    tileId: null,
    address: null,
    secure: false,
    source: null,
    noAddress: false,
    blocked: null,
    cmdForm: null,
    lines: [],
  };
}

/** `localhost:41003` of an address (`http://localhost:41003/x`). */
export function hostPortOf(address: string): string {
  try {
    const url = new URL(address);
    return url.host;
  } catch {
    return address;
  }
}

/** The run state each phase draws (PRINCIPLES: running indigo, done green,
 *  failed or stopped amber, empty muted). */
export type TryDot = "running" | "done" | "aborted" | "empty";

export interface TryStatus {
  dot: TryDot;
  live: boolean;
  /** The word beside the dot. */
  word: string;
  /** The sentence under it, when there is one. */
  sentence: string | null;
}

export const COULDNT_START_SENTENCE =
  "Your app stopped while starting. Nothing in your project changed. The last lines it printed are below.";
export const COULDNT_INSTALL_SENTENCE =
  "Installing the packages didn't finish. Nothing in your project changed. The last lines it printed are below.";
export const FIX_HINT = "To fix it, tell the Builder on the card what went wrong; you can paste these lines.";
export const QUICK_EXIT_SENTENCE =
  "Your app stopped right after starting. Nothing in your project changed. The last lines it printed are below.";
export const OTHER_WAY_SENTENCE = "Plyloft can also run it the other way:";
export const STOP_FAILED_SENTENCE = "Plyloft couldn't stop it. Show the session to stop it there.";
export const INSTALLING_WORD = "Installing your app's packages…";
export const SCRIPTS_BLOCKED_SENTENCE = "Windows blocked a script this command needs. Plyloft can run it the other way:";
export const SECURE_SENTENCE = "This app uses a secure address. Open it in your browser.";
export const NO_ADDRESS_SENTENCE = "Your app started but Plyloft can't see its address.";
export const STOPPED_SENTENCE = "Your app isn't running. Nothing in your project changed.";
/** TI-5: the install ran in the project folder itself, so it may have
 *  changed what it installs there. */
export const PROJECT_COULDNT_INSTALL_SENTENCE =
  "Installing the packages didn't finish. The last lines it printed are below.";

/** Where a Try session runs: a card's copy, or (TI-5) the project folder. */
export type TryWhere = "copy" | "project";

/** The status line of a run. */
export function tryStatus(run: TryRun, p: Platform = platform(), where: TryWhere = "copy"): TryStatus {
  switch (run.phase) {
    case "ask":
      return { dot: "empty", live: false, word: "Not started", sentence: null };
    case "installing":
      return { dot: "running", live: true, word: INSTALLING_WORD, sentence: null };
    case "starting":
      return run.noAddress
        ? { dot: "running", live: false, word: "Started", sentence: NO_ADDRESS_SENTENCE }
        : { dot: "running", live: true, word: "Starting your app…", sentence: null };
    case "running":
      return {
        dot: "done",
        live: false,
        word: `Running on ${hostPortOf(run.address ?? "")}`,
        sentence: run.secure ? SECURE_SENTENCE : null,
      };
    case "stopped":
      return { dot: "empty", live: false, word: "Stopped", sentence: STOPPED_SENTENCE };
    case "failed":
      if (run.blocked === "scripts" && run.cmdForm) {
        return { dot: "aborted", live: false, word: "Couldn't start", sentence: SCRIPTS_BLOCKED_SENTENCE };
      }
      if (run.quickExit && !run.installFailed && !run.error) {
        return { dot: "aborted", live: false, word: "Couldn't start", sentence: withMissingTool(QUICK_EXIT_SENTENCE, run) };
      }
      return {
        dot: "aborted",
        live: false,
        word: "Couldn't start",
        sentence: run.installFailed
          ? where === "project"
            ? PROJECT_COULDNT_INSTALL_SENTENCE
            : COULDNT_INSTALL_SENTENCE
          : run.error
            ? machineWords(run.error, p)
            : withMissingTool(COULDNT_START_SENTENCE, run),
      };
  }
}

/** Spec §9.3: a missing `npm` or `python` says which tool, beside the error. */
function withMissingTool(sentence: string, run: TryRun): string {
  const tool = missingTool(run.lines, run.command);
  if (!tool) return sentence;
  const hint = TOOL_HINTS[tool];
  return `${sentence} Plyloft couldn't start "${tool}".${hint ? ` ${hint}` : ""}`;
}

const TOOL_HINTS: Record<string, string> = {
  npm: "Is Node.js installed?",
  npx: "Is Node.js installed?",
  node: "Is Node.js installed?",
  pnpm: "Is pnpm installed?",
  yarn: "Is Yarn installed?",
  bun: "Is Bun installed?",
  python3: "Is Python installed?",
  python: "Is Python installed?",
  py: "Is Python installed?",
  ruby: "Is Ruby installed?",
  bundle: "Is Ruby installed?",
};

/** The command's program when the shell said it can't find it (zsh, bash,
 *  PowerShell, cmd), else null. */
export function missingTool(lines: readonly string[], command: string): string | null {
  const program = command.trim().split(/\s+/)[0]?.replace(/\.cmd$/i, "") ?? "";
  if (!program) return null;
  const esc = program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`command not found:\\s*${esc}\\b`, "i"),
    new RegExp(`\\b${esc}(?:\\.cmd)?: (?:command )?not found`, "i"),
    new RegExp(`'${esc}(?:\\.cmd)?' is not recognized`, "i"),
    new RegExp(`The term '${esc}(?:\\.cmd)?' is not recognized`, "i"),
  ];
  return lines.some((l) => patterns.some((re) => re.test(l))) ? program : null;
}

/** Details' line: `Ran "npm run dev" in the card's copy · port 41003` (TI-5:
 *  `in your project's folder`). */
export function ranWords(
  run: Pick<TryRun, "command" | "address">,
  laneName: string | null,
  inWhere: TryWhere = "copy",
): string {
  const where = inWhere === "project" ? "your project's folder" : laneName ? `${laneName}'s copy` : "the card's copy";
  const port = run.address ? portOfAddress(run.address) : null;
  return `Ran "${run.command}" in ${where}${port ? ` · port ${port}` : ""}`;
}

/** Why a typed address can't be shown, or null when it can: only an address
 *  on this machine (`localhost`, `127.0.0.0/8`, `[::1]`). */
export function typedAddressProblem(text: string, p: Platform = platform()): string | null {
  const t = text.trim();
  if (!t) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  return loopbackUrl(withScheme)
    ? null
    : machineWords("Only an address on this Mac, such as http://localhost:3000.", p);
}

/** The typed address as the preview loads it, or null. */
export function typedAddress(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return loopbackUrl(/^https?:\/\//i.test(t) ? t : `http://${t}`);
}

// ── When the command has ended ──────────────────────────────────────────

/** Windows: nothing reads as ended this soon after the command was typed
 *  — the tile's job holds only PowerShell until PowerShell has started the
 *  command (its own start, the profile, finding `npm.cmd`), which takes
 *  seconds on a slow machine, so "nothing runs" means "not yet" there. */
export const SETTLE_MS = 1_500;
/** The first look, and the earliest a look's "nothing runs" counts on the
 *  Mac: the shell has forked the command long before. */
export const FIRST_LOOK_MS = 500;
/** The Mac: two looks that found nothing running, this far apart, end it. */
export const UNIX_GONE_MS = 1_000;
/** A look this soon after one that found the command gone, to confirm it
 *  rather than wait for the next tick. */
export const CONFIRM_LOOK_MS = 500;
/** Two looks closer than this count as one (a tick and a confirming look
 *  landing together). */
export const MIN_LOOK_GAP_MS = 400;

/** What tells a Try session's command has ended. */
export interface TryEndSignals {
  /** The tile's status: its shell itself ended (`done`/`crashed`). */
  tileStatus: string | null;
  /** The PTY's answer now (`pty_command_running`: the Mac's process group,
   *  Windows' job); null when it can't say. */
  running: boolean | null;
  /** The PTY once said the command runs. */
  sawRunning: boolean;
  /** Answers in a row, since it was seen running, that nothing runs. */
  goneLooks: number;
  /** The shell's prompt came back after the typed line (`TryTypedEcho`). */
  promptBack: boolean;
  /** The typed line's echo was found. */
  echoSeen: boolean;
  /** Something was printed after the typed line's echo (`TryTypedEcho`). */
  outputAfterEcho: boolean;
  msSinceTyped: number;
  /** The shell said the command finished: OSC 133 `D` after the echo
   *  (Command blocks' shell integration). */
  commandDone?: boolean;
  /** The shell's line editor is editing its prompt again
   *  (`pty_prompt_state` = `editing`, GH #70; the Mac only). */
  promptEditing?: boolean;
  /** Unix only: ms from the first look (at `FIRST_LOOK_MS` or later) that
   *  found nothing running to this one, which also found nothing; null
   *  when this one found something, or on Windows. */
  goneForMs?: number | null;
}

/**
 * Whether the Try session's command has ended (Windows walk 2026-10-20):
 *  - the tile's shell ended, or the shell said the command finished (OSC
 *    133 `D` after the echo) — always;
 *  - not while the PTY says it runs;
 *  - the shell's line editor is editing its prompt again (the Mac's PTY),
 *    from `FIRST_LOOK_MS` after the typing, once the echo was seen;
 *  - unix: the echo seen, output after it, and two looks at least
 *    `UNIX_GONE_MS` apart, the first at `FIRST_LOOK_MS` or later, found
 *    nothing running (the process group is the shell's again — on the Mac
 *    that is the command gone; a slow fork that prints its address later
 *    turns the panel back to Running);
 *  - everywhere, `SETTLE_MS` after the typing with output after the echo:
 *    seen running and gone on two looks in a row, or the shell's prompt
 *    back after the typed line. On Windows that is all there is: "nothing
 *    runs" alone is also what the job says before PowerShell started it.
 */
export function commandEnded(s: TryEndSignals): boolean {
  if (s.tileStatus === "done" || s.tileStatus === "crashed") return true;
  if (s.commandDone) return true;
  if (s.running === true) return false;
  if (s.promptEditing && s.echoSeen && s.msSinceTyped >= FIRST_LOOK_MS) return true;
  if (s.goneForMs != null && s.goneForMs >= UNIX_GONE_MS && s.running === false && s.echoSeen && s.outputAfterEcho) {
    return true;
  }
  if (s.msSinceTyped < SETTLE_MS || !s.outputAfterEcho) return false;
  if (s.sawRunning && s.running === false && s.goneLooks >= 2) return true;
  return s.promptBack;
}

/** The last `max` lines of a session's output, ANSI stripped, fed chunk by
 *  chunk. */
export class TryOutputTail {
  private readonly stripper = new AnsiStripper();
  private readonly lines: string[] = [];
  private current = "";
  private readonly max: number;

  constructor(max = TAIL_LINES) {
    this.max = max;
  }

  /** A `\r` seen, its line not judged yet: `\n` next ends the line, anything
   *  else redraws it (a progress bar) and replaces it. Kept across chunks. */
  private carriage = false;

  feed(chunk: string): void {
    for (const ch of this.stripper.feed(chunk)) {
      if (this.carriage) {
        this.carriage = false;
        if (ch === "\n") {
          this.push();
          continue;
        }
        this.current = "";
      }
      if (ch === "\n") this.push();
      else if (ch === "\r") this.carriage = true;
      else this.current += ch;
    }
  }

  private push(): void {
    const line = this.current.replace(/\s+$/, "");
    this.current = "";
    if (!line) return;
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  read(): string[] {
    const tail = this.current.trim() ? [...this.lines, this.current.replace(/\s+$/, "")] : [...this.lines];
    return tail.slice(-this.max);
  }
}

/** A shell's prompt, as the last line of a session's output: zsh's
 *  `user@host dir %`, bash's `user@host:~/dir$` or `[user@host dir]$`,
 *  `bash-5.2$`, PowerShell's `PS C:\dir>`, cmd's `C:\dir>`, a bare `$`,
 *  `%`, `#` or `>`. The `user@host` part has no space before the `@`, and
 *  the mark follows a space (zsh) or the folder (bash): `pkg@1.0.0 done 100%`
 *  is output. */
const PROMPT_LINE = [
  /^[\w.-]+@[\w.-]+ \S+ [%$#]$/,
  /^[\w.-]+@[\w.-]+:\S*[$#]$/,
  /^\[[\w.-]+@[\w.-]+ [^\]]+\][$#]$/,
  /^PS(?: [^>]*)?>$/,
  /^[A-Za-z]:\\[^<>|"]*>$/,
  /^(?:bash|sh|zsh)(?:-[\d.]+)?[$#]$/,
  /^[$%#>]$/,
];

/** Details' last lines without the shell's prompt the session printed once
 *  the command ended (the end, only one line). */
export function withoutPromptLine(lines: readonly string[]): string[] {
  const last = lines[lines.length - 1]?.trim();
  if (last && PROMPT_LINE.some((re) => re.test(last))) return lines.slice(0, -1);
  return [...lines];
}

/** A prompt's shape: one of `PROMPT_LINE`, or a themed prompt's last mark
 *  (`❯`, `»`, `λ`, `➜`) alone or after a space at the end of the line. */
function isPromptLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 300) return false;
  return PROMPT_LINE.some((re) => re.test(t)) || /(?:^|\s)[❯»λ➜]$/.test(t);
}

/**
 * Windows walk: what the session printed after the line Plyloft typed —
 * the line's echo found in the output (spaces and cursor moves left out, so
 * a wrap or a ConPTY repaint doesn't hide it), then whether anything came
 * after it, whether a line after it is the shell's prompt, and whether the
 * shell said the command finished (OSC 133 `D`, Command blocks). Fed every
 * chunk from the typing on.
 *
 * Until the line is entered the line editor may draw it again (PSReadLine
 * on Enter, a grey prediction after the cursor): from the echo to the first
 * newline nothing counts as output, and the echo may be found again there.
 * After it, never again — PowerShell 5.1's error block quotes the line
 * (`+ npm.cmd run dev`) and that is output. A ConPTY that draws the next
 * lines with cursor moves instead of a newline ends that stretch at its
 * second move; what came after the first one is kept. When the echo is
 * never found, output after the first line counts instead.
 */
export class TryTypedEcho {
  private readonly stripper = new AnsiStripper({ marks: true });
  private readonly needle: string;
  private compact = "";
  private echoed = false;
  /** From the echo to the line being entered. */
  private editing = false;
  private moves = 0;
  private pending = "";
  /** After the echo (or, not found, since the typing): the line being
   *  printed, the one before it, and what was seen. */
  private line = "";
  private previous = "";
  private lines = 0;
  private text = false;
  private prompt = false;
  private done = false;
  /** The last lines after the echo: Details shows what the command
   *  printed, not the prompt and the line before it. */
  private after = new TryOutputTail();
  private out = "";

  constructor(typed: string) {
    this.needle = typed.replace(/\s+/g, "");
  }

  feed(chunk: string): void {
    this.out = "";
    for (const ch of this.stripper.feed(chunk)) this.take(ch);
    if (this.echoed && this.out) this.after.feed(this.out);
    this.out = "";
  }

  private restart(): void {
    this.line = "";
    this.previous = "";
    this.lines = 0;
    this.text = false;
    this.prompt = false;
    this.after = new TryOutputTail();
    this.out = "";
    this.pending = "";
    this.moves = 0;
  }

  private take(ch: string): void {
    if (ch === COMMAND_DONE_MARK) {
      // Only once the line was entered: a mark before is the last command's.
      if (this.echoed && !this.editing) this.done = true;
      return;
    }
    const space = /\s/.test(ch) || ch === CURSOR_LINE_MARK;
    if (this.needle && !space && (!this.echoed || this.editing)) {
      this.compact = (this.compact + ch).slice(-this.needle.length);
      if (this.compact === this.needle) {
        this.echoed = true;
        this.editing = true;
        this.compact = "";
        this.restart();
        return;
      }
    }
    if (this.editing) {
      if (ch === "\n") {
        // Entered: what the editor drew is dropped.
        this.editing = false;
        this.restart();
        return;
      }
      if (ch === CURSOR_LINE_MARK) {
        this.moves += 1;
        if (this.moves < 2) return;
        // Drawn with cursor moves, no newline: what came after the first
        // move is the command's.
        this.editing = false;
        const kept = this.pending;
        this.restart();
        for (const k of kept) this.take(k);
        this.take(ch);
        return;
      }
      if (this.moves >= 1) this.pending += ch;
      return;
    }
    this.out += ch === CURSOR_LINE_MARK ? "\n" : ch;
    if (ch === "\n" || ch === "\r" || ch === CURSOR_LINE_MARK) {
      this.endLine();
      return;
    }
    this.line += ch;
    if (this.line.length > 400) this.line = this.line.slice(-400);
    if (!space && this.counts()) this.text = true;
  }

  private endLine(): void {
    if (!this.line.trim()) {
      this.line = "";
      return;
    }
    if (this.counts() && this.promptIn(this.line)) this.prompt = true;
    this.previous = this.line;
    this.line = "";
    this.lines += 1;
  }

  /** A line counts once the echo was seen — or, never seen, after the
   *  first line (taken as the echo). */
  private counts(): boolean {
    return (this.echoed && !this.editing) || (!this.echoed && this.lines > 0);
  }

  /** The line, or the line before it joined to it (a long prompt the
   *  repaint broke in two), is a prompt. */
  private promptIn(line: string): boolean {
    return isPromptLine(line) || (!!this.previous && isPromptLine(this.previous.trim() + line.trim()));
  }

  /** The typed line's echo was found. */
  get echoSeen(): boolean {
    return this.echoed;
  }

  /** Something was printed after the echo. */
  get outputAfterEcho(): boolean {
    return this.text;
  }

  /** The shell said the command finished (OSC 133 `D`) after the echo. */
  get commandDone(): boolean {
    return this.done;
  }

  /** The shell's prompt came back after the echo: a whole line, or the
   *  last line still open (a prompt ends with no newline). */
  get promptBack(): boolean {
    if (this.prompt) return true;
    return this.counts() && !!this.line.trim() && this.promptIn(this.line);
  }

  /** The last lines printed after the echo, or null before it was seen. */
  linesAfter(): string[] | null {
    if (!this.echoed) return null;
    const flushed = this.out;
    if (flushed) {
      this.after.feed(flushed);
      this.out = "";
    }
    return this.after.read();
  }
}

/** One card copy's key: card ids repeat across repositories. */
export function tryRunKey(workspaceId: string, cardId: string, lane: string | null | undefined): string {
  return `${workspaceId}\u0000${cardId}\u0000${lane ?? ""}`;
}
