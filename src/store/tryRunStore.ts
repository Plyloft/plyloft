import { create } from "zustand";
import {
  cardWorktreeSetupRetry,
  openWebLink,
  probeLocalhostPorts,
  probePorts,
  projectTryCommandApprove,
  projectTryCommandGet,
  projectTryCommandSave,
  ptyCommandRunning,
  ptyPromptState,
  tryCmdShimsAvailable,
  tryCopyNeedsPackages,
  tryInstallPackagesInProject,
  tryProjectNeedsPackages,
  tryInstallPackagesOnce,
  tryOpenIndexHtml,
  tryPackageScript,
  worktreeSettingsGet,
  worktreeSettingsSet,
  type KanbanCard,
  type TryCommandView,
  type WorktreeSetupRecord,
} from "../ipc";
import { cardPortList, loopbackUrl, TryAddressScanner, type TryAddressResult } from "../lib/tryAddress";
import {
  ADDRESS_WAIT_MS,
  CONFIRM_LOOK_MS,
  FIRST_LOOK_MS,
  MIN_LOOK_GAP_MS,
  PROBE_EVERY_MS,
  SETTLE_MS,
  UNIX_GONE_MS,
  QUICK_EXIT_MS,
  TAIL_LINES,
  TryOutputTail,
  TryTypedEcho,
  commandEnded,
  SECURE_SENTENCE,
  emptyRun,
  hostPortOf,
  setupToSave,
  tryPreflight,
  tryRunKey,
  typedAddress,
  withoutPromptLine,
  type TryRun,
} from "../lib/tryPanel";
import {
  onOutput as subscribeTryOutput,
  startTrySession,
  stopTrySession,
  stopTrySessionOrThrow,
  trySessionFor,
} from "../lib/trySession";
import {
  PROJECT_TRY_ID,
  TRY_SHIM_NAMES,
  isProjectTry,
  shellFamily,
  tryCommandCmdForm,
  tryCwdFor,
  tryScriptOf,
  tryTypedCommand,
  type TryLane,
} from "../lib/tryTile";
import {
  newlyOpenPorts,
  portsOfOtherRuns,
  projectTryCard,
  tryInProjectLabel,
  type TryProject,
} from "../lib/tryProject";
import { isWindows } from "../lib/platform";
import { fallbackTileShell } from "../lib/tileShell";
import { useDoctor } from "./doctorStore";
import { useSettings } from "./settingsStore";
import { useKanban } from "./kanbanStore";
import { useTiles, type Tile } from "./tileStore";
import { useTryStopped } from "./tryStoppedStore";
import { openCodePreview, openCenterMode, setCodePreviewAddress, useUi } from "./uiStore";
import { useWorkspaces } from "./workspaceStore";
import { pushToast, type ToastAction } from "./toastStore";
import { linkDidNotOpen } from "../lib/linkToast";

/**
 * Try it TI-4 (docs/try-it/TRY_IT_SPEC.md §3.1, §3.3, §4.4): a card copy's
 * Try it, from the press to the preview. What each copy's panel shows is
 * `runs` (in memory only: a session never survives a relaunch); the How to
 * start your app sheet is `sheet`. The session itself is TI-2's
 * (`lib/trySession.ts`), the address TI-3's scanner and port probe.
 *
 * One session per copy: a press while one runs only shows its panel.
 */

/** The card's copy a Try it is about: the card, and its build when it is
 *  built by both. */
export type TryItCard = KanbanCard;

export interface TrySheet {
  card: TryItCard;
  lane: TryLane | null;
  view: TryCommandView | null;
  /** Why the last Save and try or Open index.html didn't go through. */
  error: { words: string; details: string } | null;
  busy: boolean;
}

interface TryRunStore {
  runs: Record<string, TryRun | undefined>;
  /** TI-5: cards (`workspaceId\u0000cardId`) whose ship this session ran a
   *  go-live step, which rebuilds the app detached — the receipt says to
   *  wait for it. In memory only: Plyloft can't tell when it ends. */
  goLive: Record<string, true>;
  noteGoLive: (workspaceId: string, cardId: string) => void;
  /** TU-5 Mac walk (tutorial B9): card copies (`tryRunKey`) whose sheet's
   *  Open index.html showed the page in the browser this session — the
   *  member saw it. In memory only. */
  indexOpened: Record<string, true>;
  sheet: TrySheet | null;
  /** Try it: show the copy's panel, asking first what a start needs. */
  press: (card: TryItCard, lane: TryLane | null) => Promise<void>;
  /** The panel's ask, answered: Allow and run, Install and try, Set it up and
   *  try, Install them this time. `setup`: Set it up and try's field, as
   *  the member left it — what is saved (1.168.1 B4); the suggestion when
   *  absent. */
  answer: (card: TryItCard, lane: TryLane | null, setup?: string) => Promise<void>;
  /** Change how it starts: the sheet, on what is saved. */
  openSheet: (card: TryItCard, lane: TryLane | null) => Promise<void>;
  closeSheet: () => void;
  /** The sheet's Save and try. */
  saveAndTry: (command: string) => Promise<void>;
  /** The sheet's Open index.html: the page in the default browser, no session. */
  openIndex: () => Promise<void>;
  stop: (card: TryItCard, lane: TryLane | null) => Promise<void>;
  /** Try again: the pre-flight and a fresh session — straight to the `.cmd`
   *  form after PowerShell refused a script. */
  tryAgain: (card: TryItCard, lane: TryLane | null) => Promise<void>;
  /** Try again the other way: the `.cmd` form after a quick exit. */
  tryOtherWay: (card: TryItCard, lane: TryLane | null) => Promise<void>;
  /** The address the member typed after 60 s with none (loopback only). */
  useAddress: (card: TryItCard, lane: TryLane | null, text: string) => boolean;
  /** TI-5: Try it in <project> after Ship — the same pre-flight and session,
   *  in the workspace's own folder (`projectTryCard`), one per workspace. */
  pressProject: (ws: TryProject) => Promise<void>;
}

const keyOf = (card: TryItCard, lane: TryLane | null) => tryRunKey(card.workspaceId, card.id, lane);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
}

/** The card copy's port block: that build's, else the card's. */
export function portBaseOf(card: TryItCard, lane: TryLane | null): number | null {
  if (lane === "b") return card.buildBoth?.lanes.find((l) => l.lane === "b")?.portBase ?? null;
  return card.portBase ?? null;
}

/** The card as the board has it now (a press holds the one it was drawn with). */
function current(card: TryItCard): TryItCard {
  return useKanban.getState().byWorkspace[card.workspaceId]?.cards.find((c) => c.id === card.id) ?? card;
}

/** The copy's worktree setup record: that build's, else the card's. */
function setupRecordOf(card: TryItCard, lane: TryLane | null): WorktreeSetupRecord | null | undefined {
  return lane === "b" ? card.buildBoth?.lanes.find((l) => l.lane === "b")?.worktreeSetup : card.worktreeSetup;
}

/** Resolves true once the copy's setup is no longer running (the board is
 *  read again on every backend change), or false — its subscription gone
 *  with it — when the card is deleted or its board unloaded first. */
function setupSettled(card: TryItCard, lane: TryLane | null): Promise<boolean> {
  return new Promise((resolve) => {
    const state = (): "running" | "settled" | "gone" => {
      const board = useKanban.getState().byWorkspace[card.workspaceId];
      const now = board?.cards.find((c) => c.id === card.id);
      if (!board?.loaded || !now) return "gone";
      return setupRecordOf(now, lane)?.state === "running" ? "running" : "settled";
    };
    const first = state();
    if (first !== "running") {
      resolve(first === "settled");
      return;
    }
    const off = useKanban.subscribe(() => {
      const next = state();
      if (next === "running") return;
      off();
      resolve(next === "settled");
    });
  });
}

/**
 * Walk fix (spec §4.1): the line a card copy's Try session types for the
 * saved `command` — with the copy's port for a Vite, Astro or Nuxt script
 * (`tryTypedCommand`), which ignore `PORT`. The script's body is read from
 * the copy; the shell is the one the new tile will run.
 */
async function typedCommandFor(cwd: string, command: string, portBase: number): Promise<string> {
  const run = tryScriptOf(command);
  if (!run) return command;
  const body = await tryPackageScript(cwd, run.script).catch(() => null);
  if (!body) return command;
  const shell =
    useSettings.getState().settings.shell.tileShell?.trim() || useDoctor.getState().env?.shell || fallbackTileShell();
  return tryTypedCommand(command, body, portBase, shellFamily(shell, isWindows() ? "windows" : "mac"));
}

/** Stops by copy: a Stop bumps it, and a start begun before it sees the
 *  change after any await — before its session existed, while it was being
 *  typed, or once it returned. */
const stopGen = new Map<string, number>();
const genOf = (key: string) => stopGen.get(key) ?? 0;

function findTile(tileId: string | null): Tile | null {
  if (!tileId) return null;
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    const t = ws.tiles.find((x) => x.id === tileId);
    if (t) return t;
  }
  return null;
}

/** The watches of running sessions: the output subscription, the 2 s tick
 *  and the tile watch, by copy. */
/** 1.168.1 B4: copies (`tryRunKey`) whose ask is being answered. */
const answering = new Set<string>();
const watches = new Map<string, () => void>();

function endWatch(key: string): void {
  const stop = watches.get(key);
  watches.delete(key);
  stop?.();
}

export const useTryRuns = create<TryRunStore>((set, get) => {
  const runOf = (key: string) => get().runs[key];
  const put = (key: string, run: TryRun) => set((s) => ({ runs: { ...s.runs, [key]: run } }));
  const patch = (key: string, change: Partial<TryRun>) => {
    const run = runOf(key);
    if (run) put(key, { ...run, ...change });
  };
  const fail = (key: string, command: string, words: string, details: string) => {
    endWatch(key);
    put(key, { ...(runOf(key) ?? emptyRun(command)), command, phase: "failed", error: words, lines: [details] });
  };

  /** Steps 1–3: what a start needs first, then the start. */
  async function preflight(drawn: TryItCard, lane: TryLane | null): Promise<void> {
    const card = current(drawn);
    const key = keyOf(card, lane);
    const gen = genOf(key);
    const stopped = () => genOf(key) !== gen;
    let view: TryCommandView;
    try {
      view = await projectTryCommandGet(card.workspaceId);
    } catch (e) {
      if (stopped()) return;
      fail(key, "", "Plyloft couldn't read how your app starts. Nothing was started.", errorText(e));
      return;
    }
    if (stopped()) return;
    const project = isProjectTry(card.id);
    const first = tryPreflight({ view, needsPackages: null, setup: null, project });
    if (first.kind === "sheet") {
      if (project) {
        // Offered only with a command; it was removed since. The sheet is the
        // card's (its words are about a card's copy): Settings has the row.
        fail(
          key,
          "",
          "Plyloft doesn't know how your app starts any more. Nothing was started. Set it in Settings › Cards › Building and checking › How to start your app.",
          "No start command is saved for this repository.",
        );
        return;
      }
      set({ sheet: { card, lane, view, error: null, busy: false } });
      return;
    }
    if (first.kind === "ask") {
      put(key, { ...emptyRun(view.command ?? ""), phase: "ask", ask: first.ask });
      return;
    }
    // The copy's setup is installing already (a new copy, a Retry): wait for
    // it rather than running a second one.
    if (setupRecordOf(card, lane)?.state === "running") {
      put(key, { ...emptyRun(first.command), phase: "installing" });
      const settled = await setupSettled(card, lane);
      if (!settled || stopped() || runOf(key)?.phase !== "installing") return;
      const record = setupRecordOf(current(card), lane);
      if (record?.state === "failed" && !record.approvalNeeded) {
        installFailed(key, first.command, record);
        return;
      }
    }
    const cwd = tryCwdFor(card, lane);
    // TI-5: the project folder's own check, with the install it would run.
    const projectInstall = project ? await tryProjectNeedsPackages(card.workspaceId).catch(() => null) : null;
    const needs = !project && cwd ? await tryCopyNeedsPackages(cwd).catch(() => null) : null;
    let setup: { command: string | null | undefined; approved: string | null | undefined } | null = null;
    if (needs && !project) {
      const s = await worktreeSettingsGet(card.workspaceId).catch(() => null);
      setup = { command: s?.worktreeSetup, approved: s?.approvedSetup };
    }
    if (stopped()) return;
    const next = tryPreflight({ view, needsPackages: needs ?? null, setup, project, projectInstall });
    if (next.kind === "ask") {
      put(key, { ...emptyRun(first.command), phase: "ask", ask: next.ask });
      return;
    }
    if (next.kind === "start") await begin(card, lane, next.command, undefined, gen);
  }

  function installFailed(key: string, command: string, record: WorktreeSetupRecord) {
    // The runner's own words (Git Bash missing on Windows, a timeout) first,
    // then the end of what the install printed.
    const text = [record.reason, record.log].filter(Boolean).join("\n");
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES);
    put(key, { ...emptyRun(command), phase: "failed", installFailed: true, lines });
  }

  /** The ask's press (`answer`, once at a time). */
  async function answerAsk(
    card: TryItCard,
    lane: TryLane | null,
    key: string,
    run: TryRun,
    ask: NonNullable<TryRun["ask"]>,
    typedSetup: string | undefined,
  ) {
    switch (ask.kind) {
      case "approve":
        try {
          await projectTryCommandApprove(card.workspaceId, ask.command);
        } catch (e) {
          fail(key, ask.command, "Plyloft couldn't save your OK. Nothing was started.", errorText(e));
          return;
        }
        await preflight(card, lane);
        return;
      case "install":
        await install(card, lane, run.command, { allow: ask.approved ? null : ask.setup });
        return;
      case "setUp": {
        if (ask.readOnly) {
          await install(card, lane, run.command, { once: ask.install });
          return;
        }
        // 1.168.1 B4: exactly the command the member confirmed.
        const setup = setupToSave(typedSetup ?? ask.install);
        if (!setup) return;
        try {
          await worktreeSettingsSet(card.workspaceId, { worktreeSetup: setup });
        } catch (e) {
          fail(key, run.command, "Plyloft couldn't save how cards' copies get their packages. Nothing was changed.", errorText(e));
          return;
        }
        await install(card, lane, run.command, { allow: null });
        return;
      }
      case "projectInstall":
        await install(card, lane, run.command, { project: ask.install });
        return;
    }
  }

  /** Install the copy's packages — through worktree setup, or once and
   *  unsaved (`once`) — then start. */
  async function install(
    card: TryItCard,
    lane: TryLane | null,
    command: string,
    how: { allow: string | null } | { once: string } | { project: string },
  ) {
    const key = keyOf(card, lane);
    put(key, { ...emptyRun(command), phase: "installing" });
    let record: WorktreeSetupRecord | null | undefined;
    try {
      if ("project" in how) {
        record = await tryInstallPackagesInProject(card.workspaceId, how.project);
      } else if ("once" in how) {
        record = await tryInstallPackagesOnce(card.workspaceId, card.id, lane, how.once);
      } else {
        const updated = await cardWorktreeSetupRetry(card.workspaceId, card.id, how.allow, lane === "b" ? "b" : null);
        record = setupRecordOf(updated, lane);
      }
    } catch (e) {
      fail(key, command, "Plyloft couldn't install the packages. Nothing in your project changed.", errorText(e));
      return;
    }
    if (runOf(key)?.phase !== "installing") return;
    if (record?.state === "failed") {
      if (record.approvalNeeded && record.command) {
        put(key, { ...emptyRun(command), phase: "ask", ask: { kind: "install", setup: record.command, approved: false } });
        return;
      }
      installFailed(key, command, record);
      return;
    }
    await begin(card, lane, command);
  }

  /** Step 4: the session, its output read for the address; every 2 s the
   *  card's ports probed (until an address, or 60 s) and the PTY asked
   *  whether the command still runs (as long as the session is watched).
   *  `existing`: a session that already runs (started elsewhere) — watched,
   *  nothing typed. */
  async function begin(
    card: TryItCard,
    lane: TryLane | null,
    saved: string,
    existing?: Tile,
    gen: number = genOf(keyOf(card, lane)),
  ): Promise<void> {
    const key = keyOf(card, lane);
    if (genOf(key) !== gen) return;
    endWatch(key);
    useTryStopped.getState().clear(key);
    put(key, { ...emptyRun(saved), tileId: existing?.id ?? null });

    // TI-5: the project folder has no port block — the printed address, else
    // a common port (`probe_localhost_ports`) that opened after the start.
    const project = isProjectTry(card.id);
    const base = portBaseOf(card, lane);
    const ports = project || !base ? [] : cardPortList(base);
    // What is typed (and what Details names): in a card's copy, the copy's
    // port on a Vite or Astro script's line. The saved command is unchanged.
    let command = saved;
    const copyCwd = !existing && !project && base ? tryCwdFor(card, lane) : null;
    if (copyCwd && base) {
      command = await typedCommandFor(copyCwd, saved, base);
      if (genOf(key) !== gen) return;
      if (command !== saved) patch(key, { command });
    }
    const scanner = new TryAddressScanner({ portBlock: ports });
    let openBefore: Set<number> | null = null;
    if (project && !existing) {
      openBefore = new Set((await probeLocalhostPorts().catch(() => [] as number[])) ?? []);
      if (genOf(key) !== gen) return;
    }
    const tail = new TryOutputTail();
    const decoder = new TextDecoder();
    /** The command counts as ended (`commandEnded`): no more looks. */
    let ended = false;
    /** The watch is gone: nothing more is read of the session. */
    let closed = false;
    let typedAt = Date.now();
    let sawRunning = false;
    /** Looks in a row, since it was seen running, that found nothing running. */
    let goneLooks = 0;
    /** Unix: when a look (at `FIRST_LOOK_MS` or later) first found nothing
     *  running, since the last one that found something. */
    let goneSince: number | null = null;
    /** A look is on its way (`look`), and when the last one was taken. */
    let looking = false;
    let lastLookAt = 0;
    const unix = !isWindows();
    let probing = ports.length > 0 || openBefore !== null;
    let unsubscribe: (() => void) | null = null;
    let offTiles: (() => void) | null = null;
    let tick: ReturnType<typeof setInterval> | null = null;
    let wait: ReturnType<typeof setTimeout> | null = null;
    let chunks = 0;
    /** Windows walk: the line as typed (`npm.cmd …` in PowerShell), and
     *  what the session printed after it (its echo, then the prompt). */
    let typedLine: string | null = null;
    let echo: TryTypedEcho | null = null;
    let soonLook: ReturnType<typeof setTimeout> | null = null;
    /** What Details shows: the lines after the typed line's echo, or all
     *  of them while it hasn't been seen. */
    const lastLines = () => echo?.linesAfter() ?? tail.read();

    const clearTimers = () => {
      if (tick) clearInterval(tick);
      if (wait) clearTimeout(wait);
      if (soonLook) clearTimeout(soonLook);
      tick = null;
      wait = null;
      soonLook = null;
    };
    const finish = () => {
      ended = true;
      closed = true;
      unsubscribe?.();
      offTiles?.();
      clearTimers();
      if (watches.get(key) === finish) watches.delete(key);
    };
    watches.set(key, finish);

    const startTicking = () => {
      if (!tick) tick = setInterval(() => void onTick(), PROBE_EVERY_MS);
    };

    /** A look sooner than the next tick (a prompt came back, a look found it
     *  gone): never before `FIRST_LOOK_MS` after the typing on the Mac, nor
     *  before `SETTLE_MS` on Windows, where nothing can end sooner. */
    const lookSoon = (ms: number) => {
      if (ended || soonLook) return;
      const settle = Math.max(0, typedAt + (unix ? FIRST_LOOK_MS : SETTLE_MS) - Date.now());
      soonLook = setTimeout(() => {
        soonLook = null;
        void look();
      }, Math.max(ms, settle));
    };

    /** Couldn't start said, and then the app printed its address after all
     *  (the PTY's word came before the command did): it runs. */
    const revive = (r: TryAddressResult) => {
      ended = false;
      goneLooks = 0;
      goneSince = null;
      probing = false;
      patch(key, {
        address: r.address,
        secure: r.secure,
        source: "printed",
        phase: "running",
        noAddress: false,
        quickExit: false,
        blocked: null,
        cmdForm: null,
        lines: [],
      });
      startTicking();
    };

    const apply = (r: TryAddressResult) => {
      const run = runOf(key);
      if (!run || ended) return;
      if (r.scriptsBlocked) {
        void offerCmdForm("scripts");
        return;
      }
      if (r.address && (run.address !== r.address || run.source !== "printed")) {
        probing = false;
        patch(key, { address: r.address, secure: r.secure, source: "printed", phase: "running", noAddress: false });
      }
    };

    const onOutput = (data: Uint8Array) => {
      if (closed) return;
      const text = decoder.decode(data, { stream: true });
      tail.feed(text);
      echo?.feed(text);
      chunks += 1;
      if (ended) {
        // Couldn't start is said; the session is still read: an address
        // always wins, and Details keeps up with what it prints.
        const r = scanner.feed(text);
        const run = runOf(key);
        if (run?.phase !== "failed") return;
        if (r.address && !r.scriptsBlocked) revive(r);
        else patch(key, { lines: withoutPromptLine(lastLines()) });
        return;
      }
      // The lines are kept for Couldn't start; written now and then, not per chunk.
      if (chunks % 8 === 0) patch(key, { lines: lastLines() });
      apply(scanner.feed(text));
      if (echo?.promptBack || echo?.commandDone) lookSoon(0);
    };

    const shellOf = () => {
      const tile = findTile(runOf(key)?.tileId ?? null);
      return tile?.command ?? useDoctor.getState().env?.shell ?? fallbackTileShell();
    };

    /** The `.cmd` form, when PowerShell is the tile's shell and the command
     *  has one that is not what ran already; null otherwise. */
    const cmdFormOf = async (): Promise<string | null> => {
      if (!isWindows() || shellFamily(shellOf(), "windows") !== "powershell") return null;
      const ran = typedLine ?? command;
      const shims = await tryCmdShimsAvailable(TRY_SHIM_NAMES).catch(() => [] as string[]);
      const form = tryCommandCmdForm(ran, shims ?? []);
      return form !== ran ? form : null;
    };

    /** PowerShell refused a script: Try again runs the `.cmd` form. */
    const offerCmdForm = async (why: "scripts") => {
      if (ended) return;
      finish();
      const form = await cmdFormOf();
      patch(key, { phase: "failed", lines: withoutPromptLine(lastLines()), blocked: form ? why : null, cmdForm: form });
    };

    /** `exited`: the tile's shell itself ended — nothing more comes. */
    const onEnded = async (exited: boolean) => {
      if (ended) return;
      const r = scanner.flush();
      if (r.scriptsBlocked) {
        await offerCmdForm("scripts");
        return;
      }
      if (runOf(key)?.address) {
        finish();
        patch(key, { phase: "stopped", lines: withoutPromptLine(lastLines()) });
        return;
      }
      // Couldn't start: the session is still read (`onOutput`) unless its
      // shell ended; the looks stop.
      if (exited) finish();
      else {
        ended = true;
        clearTimers();
      }
      const quick = Date.now() - typedAt < QUICK_EXIT_MS;
      const form = quick ? await cmdFormOf() : null;
      if (closed && !exited) return; // stopped or replaced meanwhile
      // Its address came while the other way was looked up: it runs.
      const late = scanner.current();
      if (!exited && late.address && !late.scriptsBlocked) {
        revive(late);
        return;
      }
      patch(key, {
        phase: "failed",
        lines: withoutPromptLine(lastLines()),
        quickExit: quick,
        blocked: form ? "quickExit" : null,
        cmdForm: form,
      });
    };

    const signals = (running: boolean | null, promptEditing: boolean, goneForMs: number | null) => ({
      tileStatus: findTile(runOf(key)?.tileId ?? null)?.status ?? null,
      running,
      sawRunning,
      goneLooks,
      goneForMs,
      promptEditing,
      commandDone: echo?.commandDone ?? false,
      echoSeen: echo ? echo.echoSeen : !!existing,
      promptBack: echo?.promptBack ?? false,
      outputAfterEcho: echo ? echo.outputAfterEcho : !!existing,
      msSinceTyped: Date.now() - typedAt,
    });

    const check = () => {
      if (closed) return;
      const tile = findTile(runOf(key)?.tileId ?? null);
      if (!tile) {
        // Its tile went: stopped from Terminals, or by Plyloft before a removal.
        const failed = ended && runOf(key)?.phase === "failed";
        finish();
        if (!failed) patch(key, { phase: "stopped", lines: withoutPromptLine(lastLines()) });
        return;
      }
      if (tile.status === "done" || tile.status === "crashed") {
        if (ended) finish();
        else void onEnded(true);
      }
    };

    /** Every 2 s: the card's ports (until an address or 60 s), and whether
     *  the command still runs — on the Mac and on Windows alike. */
    const onTick = async () => {
      if (ended) return;
      if (probing && !runOf(key)?.address) {
        const open = openBefore
          ? newlyOpenPorts(
              (await probeLocalhostPorts().catch(() => [] as number[])) ?? [],
              openBefore,
              portsOfOtherRuns(get().runs, key),
            )
          : await probePorts(ports).catch(() => [] as number[]);
        const run = runOf(key);
        if (!ended && run && !run.address && open?.length) {
          probing = false;
          patch(key, { address: `http://localhost:${open[0]}/`, secure: false, source: "probe", phase: "running", noAddress: false });
        }
      }
      await look();
    };

    /** Whether the command still runs; ended by `commandEnded`'s rule. */
    const look = async () => {
      const ptyId = findTile(runOf(key)?.tileId ?? null)?.ptyId;
      if (ended || !ptyId) return;
      // One look at a time, and two never closer than MIN_LOOK_GAP_MS: a
      // tick and a confirming look landing together count once.
      if (looking) return;
      const gap = Date.now() - lastLookAt;
      if (lastLookAt > 0 && gap < MIN_LOOK_GAP_MS) {
        lookSoon(MIN_LOOK_GAP_MS - gap);
        return;
      }
      looking = true;
      lastLookAt = Date.now();
      let running: boolean | null;
      let editing = false;
      try {
        [running, editing] = await Promise.all([
          ptyCommandRunning(ptyId).catch(() => null),
          // GH #70: the Mac's line editor editing its prompt again.
          unix ? ptyPromptState(ptyId).then((state) => state === "editing", () => false) : Promise.resolve(false),
        ]);
      } finally {
        looking = false;
      }
      if (ended) return;
      const at = Date.now();
      if (running === true) {
        sawRunning = true;
        goneLooks = 0;
        goneSince = null;
      } else if (running === false) {
        if (sawRunning) goneLooks += 1;
        if (unix && goneSince === null && at - typedAt >= FIRST_LOOK_MS) goneSince = at;
      } else {
        goneLooks = 0;
        goneSince = null;
      }
      const s = signals(running, editing, unix && running === false && goneSince !== null ? at - goneSince : null);
      if (commandEnded(s)) {
        void onEnded(s.tileStatus === "done" || s.tileStatus === "crashed");
        return;
      }
      // Seen gone once: a second look soon confirms it.
      if (running === false && sawRunning && goneLooks === 1) lookSoon(CONFIRM_LOOK_MS);
      else if (running === false && unix && goneSince !== null) lookSoon(Math.max(MIN_LOOK_GAP_MS, goneSince + UNIX_GONE_MS - at));
    };

    const onTyped = (line: string) => {
      typedLine = line;
      echo = new TryTypedEcho(line);
      typedAt = Date.now();
      // Windows walk 2026-10-20: Details names what ran (`npm.cmd …`) from
      // Starting on, not only once the typing returned.
      if (!ended && genOf(key) === gen && line !== runOf(key)?.command) patch(key, { command: line });
    };

    if (!existing) {
      let tileId: string;
      try {
        const started = await startTrySession(card, lane, {
          command,
          reveal: false,
          onOutput,
          onTyped,
          onSubscribed: (off) => {
            unsubscribe = off;
          },
        });
        tileId = started.tileId;
      } catch (e) {
        if (ended) return;
        fail(key, command, "Plyloft couldn't open a session for your app. Nothing in your project changed.", errorText(e));
        return;
      }
      if (ended || genOf(key) !== gen) {
        // Stopped (or replaced) while it was starting: what it started goes.
        finish();
        (unsubscribe as (() => void) | null)?.();
        const replaced = watches.has(key) && genOf(key) === gen;
        if (replaced) return; // a newer start of this copy owns it
        const left = findTile(tileId);
        if (left?.ptyId && !left.pendingClose) await useTiles.getState().closeTile(tileId);
        else if (left && !left.pendingClose) useTiles.getState().removeTile(tileId);
        if (runOf(key)?.phase === "starting") patch(key, { phase: "stopped" });
        return;
      }
      // Details names what ran: the typed line, `.cmd` form included.
      const ran = typedLine as string | null;
      patch(key, { tileId, ...(ran && ran !== runOf(key)?.command ? { command: ran } : {}) });
    } else {
      // Started elsewhere (a Restart): typed before this watch, so its echo
      // is not looked for — it was seen running, and its output counts.
      sawRunning = true;
      typedAt = Date.now() - SETTLE_MS;
      unsubscribe = subscribeTryOutput(existing.id, onOutput);
    }

    offTiles = useTiles.subscribe(check);
    startTicking();
    // A command that fails at once is over before the first tick.
    lookSoon(FIRST_LOOK_MS);
    wait = setTimeout(() => {
      probing = false;
      const run = runOf(key);
      if (!ended && run && !run.address && run.phase === "starting") patch(key, { noAddress: true, lines: lastLines() });
    }, ADDRESS_WAIT_MS);
    check();
  }

  return {
    runs: {},
    sheet: null,
    goLive: {},
    indexOpened: {},
    noteGoLive: (workspaceId, cardId) =>
      set((s) => ({ goLive: { ...s.goLive, [`${workspaceId}\u0000${cardId}`]: true } })),

    press: async (card, lane) => {
      const key = keyOf(card, lane);
      const run = runOf(key);
      const live = trySessionFor(card, lane);
      // One per copy: a running one is only shown.
      if (live) {
        if (run?.tileId === live.id && (run.phase === "failed" || run.phase === "stopped")) {
          // Its command ended and its shell is still there (still read, for
          // a late address): start afresh.
          endWatch(key);
          await stopTrySession(card, lane).catch(() => {});
          await preflight(card, lane);
          return;
        }
        if (run?.tileId === live.id && watches.has(key)) return;
        // Started elsewhere (its tile's Restart): watched from now on.
        await begin(card, lane, live.tryOf?.command ?? run?.command ?? "", live);
        return;
      }
      if (run && watches.has(key) && (run.phase === "starting" || run.phase === "running")) return;
      if (run?.phase === "installing") return;
      await preflight(card, lane);
    },

    answer: async (card, lane, typedSetup) => {
      const key = keyOf(card, lane);
      const run = runOf(key);
      const ask = run?.ask;
      if (!run || run.phase !== "ask" || !ask) return;
      // 1.168.1 B4 (Challenger): one answer per copy at a time — an Enter
      // repeat, or Enter then a click, would save and install twice.
      if (answering.has(key)) return;
      answering.add(key);
      try {
        await answerAsk(card, lane, key, run, ask, typedSetup);
      } finally {
        answering.delete(key);
      }
    },

    openSheet: async (card, lane) => {
      set({ sheet: { card, lane, view: null, error: null, busy: false } });
      const view = await projectTryCommandGet(card.workspaceId).catch(() => null);
      const sheet = get().sheet;
      if (sheet && sheet.card.id === card.id && sheet.lane === lane) set({ sheet: { ...sheet, view } });
    },

    closeSheet: () => set({ sheet: null }),

    saveAndTry: async (command) => {
      const sheet = get().sheet;
      if (!sheet || sheet.busy) return;
      set({ sheet: { ...sheet, busy: true, error: null } });
      try {
        await projectTryCommandSave(sheet.card.workspaceId, command.trim());
      } catch (e) {
        set({
          sheet: {
            ...sheet,
            busy: false,
            error: { words: "Plyloft couldn't save how your app starts. Nothing was changed.", details: errorText(e) },
          },
        });
        return;
      }
      set({ sheet: null });
      // A session of the old command goes first: one per copy.
      endWatch(keyOf(sheet.card, sheet.lane));
      await stopTrySession(sheet.card, sheet.lane).catch(() => {});
      await preflight(sheet.card, sheet.lane);
    },

    openIndex: async () => {
      const sheet = get().sheet;
      if (!sheet || sheet.busy) return;
      try {
        await tryOpenIndexHtml(sheet.card.workspaceId, sheet.card.id, sheet.lane);
        const key = keyOf(sheet.card, sheet.lane);
        set((s) => ({ sheet: null, indexOpened: { ...s.indexOpened, [key]: true } }));
      } catch (e) {
        set({
          sheet: {
            ...sheet,
            error: { words: "Plyloft couldn't open index.html. Nothing was changed.", details: errorText(e) },
          },
        });
      }
    },

    stop: async (card, lane) => {
      const key = keyOf(card, lane);
      // A start still on its way sees this and drops what it starts.
      stopGen.set(key, genOf(key) + 1);
      const run = runOf(key);
      if (run?.phase === "starting" && !run.tileId) {
        // Still starting: its tile goes now — before its shell is up, nothing
        // is typed into it — and whatever got further goes once the start
        // returns (`begin`).
        endWatch(key);
        const tile = trySessionFor(card, lane);
        if (tile?.ptyId) await stopTrySession(card, lane).catch(() => {});
        else if (tile) useTiles.getState().removeTile(tile.id);
        patch(key, { phase: "stopped", stopFailed: false });
        return;
      }
      try {
        await stopTrySessionOrThrow(card, lane);
      } catch {
        // The watch stays: the session still runs.
        patch(key, { stopFailed: true });
        return;
      }
      endWatch(key);
      patch(key, { phase: "stopped", stopFailed: false });
    },

    tryAgain: async (card, lane) => {
      const key = keyOf(card, lane);
      const run = runOf(key);
      endWatch(key);
      await stopTrySession(card, lane).catch(() => {});
      if (run?.blocked === "scripts" && run.cmdForm) {
        await begin(current(card), lane, run.cmdForm);
        return;
      }
      await preflight(card, lane);
    },

    tryOtherWay: async (card, lane) => {
      const key = keyOf(card, lane);
      const run = runOf(key);
      if (!run?.cmdForm) return;
      endWatch(key);
      await stopTrySession(card, lane).catch(() => {});
      await begin(current(card), lane, run.cmdForm);
    },

    useAddress: (card, lane, text) => {
      const key = keyOf(card, lane);
      const address = typedAddress(text);
      if (!address || !runOf(key)) return false;
      patch(key, {
        address,
        secure: address.startsWith("https:"),
        source: "typed",
        phase: "running",
        noAddress: false,
      });
      return true;
    },

    pressProject: async (ws) => {
      // Code with its preview strip, where the project's session is said
      // (what it asks first, Starting…, then the found address).
      const ui = useUi.getState();
      ui.setBrowserMode(ws.id, "localhost");
      ui.setCodePreviewOpen(ws.id, true);
      if (useWorkspaces.getState().activeId !== ws.id) void useWorkspaces.getState().setActive(ws.id);
      openCenterMode(ws.id, "code");
      await get().press(projectTryCard(ws), null);
    },
  };
});

// A card that is gone (deleted, or no longer on its board) keeps no Try it.
useKanban.subscribe((state) => {
  const runs = useTryRuns.getState().runs;
  const stopped = useTryStopped.getState().words;
  const opened = useTryRuns.getState().indexOpened;
  const keys = new Set([...Object.keys(runs), ...Object.keys(stopped), ...Object.keys(opened)]);
  if (keys.size === 0) return;
  const gone: string[] = [];
  for (const key of keys) {
    const [workspaceId, cardId] = key.split("\u0000");
    // TI-5: the project's own session belongs to no card.
    if (isProjectTry(cardId)) continue;
    const board = state.byWorkspace[workspaceId];
    if (!board?.loaded) continue;
    if (!board.cards.some((c) => c.id === cardId)) gone.push(key);
  }
  if (gone.length === 0) return;
  for (const key of gone) {
    endWatch(key);
    useTryStopped.getState().clear(key);
  }
  useTryRuns.setState((s) => {
    const next = { ...s.runs };
    const nextOpened = { ...s.indexOpened };
    for (const key of gone) {
      delete next[key];
      delete nextOpened[key];
    }
    return { runs: next, indexOpened: nextOpened };
  });
});

/** TI-5: the workspace as its project's Try session needs it, or null when
 *  it is gone. */
export function tryProjectOf(workspaceId: string): TryProject | null {
  const ws = useWorkspaces.getState().workspaces.find((w) => w.id === workspaceId);
  return ws ? { id: ws.id, name: ws.name, cwd: ws.cwd } : null;
}

/** TI-5: Try it in <project>, pressed on the Ship receipt or the Shipped
 *  toast. */
export function pressTryInProject(workspaceId: string): void {
  const ws = tryProjectOf(workspaceId);
  if (ws) void useTryRuns.getState().pressProject(ws);
}

/** TI-5: the Shipped toast's Try it in <project>, when the project has a
 *  start command (read now); undefined otherwise. */
export async function tryInProjectAction(workspaceId: string): Promise<ToastAction | undefined> {
  const ws = tryProjectOf(workspaceId);
  if (!ws) return undefined;
  const view = await projectTryCommandGet(workspaceId).catch(() => null);
  if (!view?.command?.trim()) return undefined;
  return { label: tryInProjectLabel(ws.name), onClick: () => pressTryInProject(workspaceId) };
}

/** TI-5: a workspace that is gone keeps no project Try session — its run is
 *  forgotten and its session stopped. */
useWorkspaces.subscribe((state, prev) => {
  if (state.workspaces === prev.workspaces) return;
  const known = new Set(state.workspaces.map((w) => w.id));
  const tries = useTryRuns.getState();
  const projectGone = (key: string) => {
    const [workspaceId, cardId] = key.split("\u0000");
    return isProjectTry(cardId) && !known.has(workspaceId);
  };
  const gone = Object.keys(tries.runs).filter(projectGone);
  // The tour's record of an Open index.html (B9, K3) goes with its project.
  const openedGone = Object.keys(tries.indexOpened).filter(projectGone);
  if (gone.length === 0 && openedGone.length === 0) return;
  for (const key of gone) {
    endWatch(key);
    const workspaceId = key.split("\u0000")[0];
    void stopTrySession({ id: PROJECT_TRY_ID, workspaceId }).catch(() => {});
  }
  useTryRuns.setState((s) => {
    const next = { ...s.runs };
    for (const key of gone) delete next[key];
    const nextOpened = { ...s.indexOpened };
    for (const key of openedGone) delete nextOpened[key];
    return { runs: next, indexOpened: nextOpened };
  });
});

/**
 * TI-5 (spec §3.2): Code's preview follows the Try sessions.
 *  - The project's session found its address: the strip shows it
 *    (`openCodePreview` when the person is on this workspace's Code, else
 *    the strip is set up for when they come back). An https address, which
 *    the embedded preview can't accept, is offered in the browser instead.
 *  - A session whose address is the strip's target stopped (or went): the
 *    target is cleared, so reopening the strip doesn't start on a dead port.
 */
useTryRuns.subscribe((state, prev) => {
  if (state.runs === prev.runs) return;
  for (const [key, before] of Object.entries(prev.runs)) {
    if (before?.phase !== "running" || !before.address) continue;
    const now = state.runs[key];
    if (now?.phase === "running" && now.address === before.address) continue;
    const workspaceId = key.split("\u0000")[0];
    const target = useUi.getState().codePreviewTarget[workspaceId];
    if (target && target.address === loopbackUrl(before.address)) {
      useUi.getState().setCodePreviewTarget(workspaceId, null);
    }
  }
  for (const [key, run] of Object.entries(state.runs)) {
    const [workspaceId, cardId] = key.split("\u0000");
    if (!isProjectTry(cardId) || run?.phase !== "running" || !run.address) continue;
    const before = prev.runs[key];
    if (before?.phase === "running" && before.address === run.address) continue;
    showProjectAddress(workspaceId, run.address, run.secure);
  }
});

function showProjectAddress(workspaceId: string, address: string, secure: boolean): void {
  const here =
    useWorkspaces.getState().activeId === workspaceId && useUi.getState().centerMode[workspaceId] === "code";
  const shown = !secure && (here ? openCodePreview(workspaceId, address) : setCodePreviewAddress(workspaceId, address));
  if (shown) return;
  const url = loopbackUrl(address);
  pushToast({
    kind: "info",
    title: `Your app is running on ${hostPortOf(address)}`,
    body: secure ? SECURE_SENTENCE : "Plyloft can't show it here. Open it in your browser.",
    ...(url
      ? {
          action: {
            label: "Open in browser",
            onClick: () =>
              void openWebLink(url).catch((e: unknown) =>
                pushToast(linkDidNotOpen(url, e)),
              ),
          },
        }
      : {}),
  });
}

/** Tests only: drop every watch (timers, subscriptions) between tests. */
export function stopTryWatchesForTests(): void {
  for (const key of [...watches.keys()]) endWatch(key);
}
