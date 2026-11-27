import { create } from "zustand";
import {
  cliRepairPlan,
  cliRepairRun,
  type RepairPlan,
  type RepairRequest,
  type RepairRunResult,
  type RepairStarted,
  type RepairStep,
} from "../lib/cliRepairIpc";
import { cliHealth, type CliHealth, type CliTool } from "../lib/cliHealthIpc";
import { setupActive, setupStop, type SetupOutcome, type SetupStarted } from "../ipc";
import { plainCause } from "../lib/plainError";
import {
  MAX_STEPS,
  isRepaired,
  pauseBefore,
  refusalWords,
  stepView,
  type JournalEntry,
  type Pause,
  type StepView,
  writesProgramFolders,
} from "../lib/repairView";
import { dismissToast, pushToast, UNDO_TOAST_MS } from "./toastStore";
import { useSettings } from "./settingsStore";
import { useSetupRun } from "./setupRunStore";
import { resumeArgs, useTiles } from "./tileStore";
import { useWorkspaces } from "./workspaceStore";

/**
 * 1.176.0 R6: the guided Repair of Claude Code or Codex, as a sequence the
 * sheet shows. The engine is stateless (`cli_repair.rs`): this store asks for
 * a plan, runs the plan's next step, asks again, and stops at a block. It
 * lives here and not in the sheet so that closing the sheet cannot orphan a
 * step that is running: a step's terminal is Setup's one guided run, which
 * Rust owns, and the sheet is only a view of it.
 *
 * It never closes anything but a window tile of the tool, through the tile
 * store's own `closeTile` (the PTY is killed there), and never answers for
 * the person: a password is typed in the visible terminal; the sessions, a
 * password and any removal the person did not see listed when they pressed
 * Repair (`agreed`) wait for a press.
 */

export type Phase =
  /** The plan is being read. */
  | "looking"
  /** The plan is shown; nothing has run. */
  | "found"
  /** Sessions of the tool are open and have to close first. */
  | "sessions"
  /** The next step needs a press (a password, a removal). */
  | "paused"
  | "running"
  /** The person stopped a step. */
  | "stopped"
  /** The last plan has a block: repaired, or why not. */
  | "end"
  /** A step could not be taken at all; Try again looks again. */
  | "error";

/** A tile Plyloft closed, to offer to open again (as the session it was in). */
export interface ClosedTile {
  kind: "claude" | "codex" | "codex-chat";
  workspaceId: string;
  workspaceName: string;
  label: string;
  labelSource?: "auto" | "user";
  cwd: string;
  args?: string[];
  cliSessionId?: string;
}

/** The last output of a command step that didn't succeed. */
export interface StepOutput {
  title: string;
  lines: string[];
}

interface RepairState {
  open: boolean;
  tool: CliTool | null;
  phase: Phase;
  plan: RepairPlan | null;
  /** D3: the box. */
  removeNpm: boolean;
  /** "Reinstall anyway". */
  reinstall: boolean;
  journal: JournalEntry[];
  /** The step ids the person saw when they pressed Repair. */
  agreed: string[];
  current: StepView | null;
  pause: Pause | null;
  /** The Setup run id of the step under way. */
  runId: string | null;
  health: CliHealth | null;
  repaired: boolean;
  message: string | null;
  /** The raw words behind `message`, for Details. */
  details: string | null;
  output: StepOutput | null;
  /** A press is being handled: the buttons wait. */
  busy: boolean;
  /** Another tool's repair was asked for while this one runs. */
  waiting: CliTool | null;
  /** The tiles closed in this repair (kept when the sheet is closed). */
  closed: ClosedTile[];
  skipped: string[];
  reopened: boolean;

  /** Open the sheet for `tool`: a fresh repair, or the one still running. */
  show: (tool: CliTool, options?: { reinstall?: boolean; removeNpm?: boolean }) => void;
  /** Close the sheet; nothing while a step runs. */
  dismiss: () => void;
  /** Read the plan again (the first look, and after the box changes). */
  look: () => Promise<void>;
  tickNpm: (on: boolean) => Promise<void>;
  /** Start again from a fresh look (Look again, Try again). */
  restart: (options?: { reinstall?: boolean; removeNpm?: boolean }) => void;
  /** Read the plan again, keeping the run (sessions). */
  lookAgain: () => Promise<void>;
  /** The press on Repair. */
  go: () => Promise<void>;
  /** The press on a paused step. */
  proceed: () => Promise<void>;
  /** The press that closes the listed tiles. */
  closeSessions: () => Promise<void>;
  stop: () => Promise<void>;
  reopenTiles: () => void;
}

const BASE = {
  phase: "looking" as Phase,
  plan: null,
  removeNpm: false,
  reinstall: false,
  journal: [] as JournalEntry[],
  agreed: [] as string[],
  current: null,
  pause: null,
  runId: null,
  health: null,
  repaired: false,
  message: null,
  details: null,
  output: null,
  busy: false,
  waiting: null,
  skipped: [] as string[],
  reopened: false,
};

/** Bumped when the sheet is reset: an answer for an older repair is dropped. */
let epoch = 0;
/** Refusals in a row (a plan that changed under us); a loop guard. */
let refusals = 0;
/** Asks Rust now whether the run the sheet follows is still going. */
let pollNow: (() => void) | null = null;
/** The person pressed Stop for the step under way: nothing runs after it
 *  without a new press, whatever the poll says. */
let stopRequested = false;
/** Test knobs: how often Rust is asked about the run, and how long a run that
 *  looks gone is given for its final event (Rust frees the runner just before
 *  it emits it). */
export const tuning = { pollMs: 3000, graceMs: 700 };

interface OpenTile {
  ptyId: string | null;
  id: string;
  kind: "claude" | "codex" | "codex-chat";
  workspaceId: string;
  workspaceName: string;
  label: string;
  labelSource?: "auto" | "user";
  cwd: string;
  args?: string[];
  cliSessionId?: string;
}

/** The window's tiles that run `tool`: its terminal tiles, and for Codex its
 *  chat tiles too (`codex-chat` is a window tile with no PTY). */
export function openTilesOf(tool: CliTool, withChats = true): OpenTile[] {
  const names = new Map(useWorkspaces.getState().workspaces.map((w) => [w.id, w.name]));
  const out: OpenTile[] = [];
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    for (const t of ws.tiles) {
      if (t.pendingClose || t.status !== "running") continue;
      const chat = tool === "codex" && t.kind === "codex-chat";
      if (t.kind !== tool && !chat) continue;
      if (!chat && !t.ptyId) continue;
      if (chat && !withChats) continue;
      out.push({
        ptyId: chat ? null : t.ptyId,
        id: t.id,
        kind: chat ? "codex-chat" : tool,
        workspaceId: t.workspaceId,
        workspaceName: names.get(t.workspaceId) ?? "",
        label: t.label,
        labelSource: t.labelSource,
        cwd: t.cwd,
        args: t.args,
        cliSessionId: t.cliSessionId,
      });
    }
  }
  return out;
}

function requestFor(tool: CliTool, s: { removeNpm: boolean; reinstall: boolean; journal: JournalEntry[] }): RepairRequest {
  const reinstalled = s.journal.some((e) => e.kind === "runInstaller");
  return {
    tiles: openTilesOf(tool, false).map((t) => ({
      ptyId: t.ptyId as string,
      label: (t.workspaceName ? `${t.workspaceName} · ${t.label}` : t.label).slice(0, 80),
    })),
    removeNpmCopy: s.removeNpm,
    startOver: s.journal.length === 0,
    ...(s.reinstall && !reinstalled ? { reinstall: true } : {}),
  };
}

/** The Setup store's own shape for a Repair's started run. */
function asSetupStarted(started: RepairStarted): SetupStarted {
  // The `repair-*` action ids are Setup's runner's own (`repairAction.ts`);
  // the IPC's union lists only the ones Setup's screens start.
  return started as unknown as SetupStarted;
}

interface RunEnd {
  outcome: SetupOutcome | null;
  /** No final event came and Rust no longer has the run. */
  lost: boolean;
  tail: string[];
}

/** Resolves when the run ends. Besides the final event, Rust is asked now
 *  and then whether the run is still there, so the sheet can't wait for a
 *  run that is gone. */
function runEnd(runId: string): Promise<RunEnd> {
  return new Promise((resolve) => {
    let finished = false;
    const done = (s: ReturnType<typeof useSetupRun.getState>) =>
      s.run?.runId === runId && s.phase === "done" ? { outcome: s.outcome, tail: s.tail } : null;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (r: RunEnd) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (timer) clearInterval(timer);
      if (pollNow === check) pollNow = null;
      resolve(r);
    };
    const check = () => {
      const d = done(useSetupRun.getState());
      if (d) {
        finish({ ...d, lost: false });
        return;
      }
      setupActive().then(
        (active) => {
          if (active?.runId === runId) return;
          // The slot is freed just before the final event is emitted: look
          // again a moment later before calling the run lost.
          setTimeout(() => {
            const late = done(useSetupRun.getState());
            finish(late ? { ...late, lost: false } : { outcome: null, lost: true, tail: [] });
          }, tuning.graceMs);
        },
        () => {},
      );
    };
    const now = done(useSetupRun.getState());
    if (now) {
      finish({ ...now, lost: false });
      return;
    }
    unsubscribe = useSetupRun.subscribe((s) => {
      const d = done(s);
      if (d) finish({ ...d, lost: false });
    });
    timer = setInterval(check, tuning.pollMs);
    pollNow = check;
  });
}

/** Waits until the tiles with these ids are gone, or a few seconds pass. */
async function tilesGone(ids: string[], limitMs = 8000): Promise<void> {
  // Still in the store, closing or not: the PTY is gone when the tile is.
  const left = () =>
    Object.values(useTiles.getState().byWorkspace).flatMap((ws) => ws.tiles.filter((t) => ids.includes(t.id)));
  const until = Date.now() + limitMs;
  while (left().length > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * 1.176.1 (review 1): Repair wrote the Program folders setting (in Rust,
 * through the setting's own save). The window reads the settings again at
 * once, so no change queued meanwhile writes the old value back (the
 * settings file has no revision to guard it; the queue applies each change
 * to the latest it holds), and an Undo puts back what the plan saw — only
 * while the setting is still what Repair wrote.
 */
export function offerFoldersUndo(step: RepairStep, now: string | null): void {
  if (step.kind !== "addProgramFolder" && step.kind !== "emptyProgramFolders") return;
  const was = step.was;
  const wrote = step.kind === "emptyProgramFolders" ? null : now;
  void useSettings
    .getState()
    .load()
    .catch(() => {});
  const id = pushToast({
    kind: "info",
    title: "Program folders changed",
    action: {
      label: "Undo",
      // 1.176.1 walk 3: the lifetime of every Undo in the product.
      ttlMs: UNDO_TOAST_MS,
      onClick: () =>
        void useSettings.getState().update((latest) =>
          (latest.shell.pathOverride ?? null) === wrote ? { ...latest, shell: { ...latest.shell, pathOverride: was } } : latest,
        ),
    },
  });
  // Walk 3: once the setting holds what Repair wrote, a later change (by
  // anyone) makes this Undo wrong: the toast goes.
  const current = () => useSettings.getState().settings.shell.pathOverride ?? null;
  let reached = current() === wrote;
  const stop = useSettings.subscribe(() => {
    const now = current();
    if (now === wrote) reached = true;
    else if (reached) {
      dismissToast(id);
      done();
    }
  });
  const timer = setTimeout(() => done(), UNDO_TOAST_MS + 1000);
  function done() {
    stop();
    clearTimeout(timer);
  }
}

export const useRepair = create<RepairState>((set, get) => {
  const finishEntry = (id: string, patch: Partial<JournalEntry>) =>
    set((s) => ({
      journal: s.journal.map((e, i) => (i === s.journal.length - 1 && e.id === id ? { ...e, ...patch } : e)),
    }));

  const fail = (message: string, details: string | null = null) =>
    set({ phase: "error", message, details, current: null, pause: null });
  /** A thrown error: a plain sentence first, the raw words under Details. */
  const failRaw = (e: unknown) => fail(plainCause(e), String(e));

  /** A press: one at a time, so a second press can't start a parallel look. */
  const pressed = async (fn: () => Promise<void>): Promise<void> => {
    if (get().busy) return;
    set({ busy: true });
    const my = epoch;
    try {
      await fn();
    } finally {
      if (my === epoch) set({ busy: false });
    }
  };

  /** What to do with a plan, once a repair has begun. */
  const continueRun = async (plan: RepairPlan): Promise<void> => {
    const { tool, journal, agreed } = get();
    if (!tool) return;
    const before = get().plan;
    set({ plan, current: null, pause: null });
    if (plan.block) {
      // 1.176.1 walk 2: the plan's own "Check that … starts" is answered by
      // the engine's look when it finds nothing left to repair: the end's
      // list shows it with that outcome, not as a step that vanished.
      const verify = before?.steps.find((x) => x.kind === "verify" && !journal.some((e) => e.id === x.id));
      if (verify && plan.block.kind === "nothingToRepair") {
        set((s) => ({
          journal: [...s.journal, { id: verify.id, kind: verify.kind, title: stepView(verify, tool).title, state: "done", failed: [] }],
        }));
      }
      const ran = journal.filter((e) => e.state === "done" && e.kind !== "closeSessions").length;
      // 1.176.1 walk: the end names the version that runs; a repair that
      // ended without running Verify asks for one fresh look.
      if (plan.block.kind === "nothingToRepair" && !get().health) {
        const my = epoch;
        const seen = await cliHealth(tool).catch(() => null);
        if (my !== epoch) return;
        if (seen) set({ health: seen });
      }
      set({ phase: "end", repaired: isRepaired(plan, ran) });
      return;
    }
    const first = plan.steps[0];
    if (!first) {
      fail("Plyloft couldn't tell what to do next. Try again.");
      return;
    }
    if (first.kind === "closeSessions") {
      set({ phase: "sessions" });
      return;
    }
    const next = plan.steps.find((s) => s.id === plan.nextStep);
    if (!next) {
      fail("Plyloft couldn't tell what to do next. Try again.");
      return;
    }
    if (journal.length >= MAX_STEPS) {
      fail("The repair went round more times than it should. Try again.");
      return;
    }
    const pause = pauseBefore(next, agreed.includes(next.id));
    if (pause) {
      set({ phase: "paused", pause, current: stepView(next, tool) });
      return;
    }
    await runStep(next);
  };

  const runStep = async (step: RepairStep): Promise<void> => {
    const my = epoch;
    const s0 = get();
    const { tool } = s0;
    if (!tool) return;
    const view = stepView(step, tool);
    const request = requestFor(tool, s0);
    stopRequested = false;
    set((s) => ({
      phase: "running",
      current: view,
      pause: null,
      message: null,
      details: null,
      runId: null,
      journal: [...s.journal, { id: step.id, kind: step.kind, title: view.title, state: "running", failed: [] }],
    }));
    let result: RepairRunResult | null = null;
    try {
      if (step.by === "terminal") {
        await useSetupRun.getState().startVia(async () => {
          result = await cliRepairRun(tool, step.id, request);
          return result.kind === "started" ? asSetupStarted(result.started) : null;
        });
      } else {
        result = await cliRepairRun(tool, step.id, request);
      }
    } catch (e) {
      if (my !== epoch) return;
      finishEntry(step.id, { state: "failed" });
      failRaw(e);
      return;
    }
    if (my !== epoch) return;
    const res = result as RepairRunResult | null;
    if (!res) {
      finishEntry(step.id, { state: "failed" });
      fail("That step didn't start. Try again.", useSetupRun.getState().error);
      return;
    }
    switch (res.kind) {
      case "started": {
        refusals = 0;
        set({ runId: res.started.runId });
        const end = await runEnd(res.started.runId);
        if (my !== epoch) return;
        set({ runId: null });
        if (end.outcome === "cancelled" || stopRequested) {
          finishEntry(step.id, { state: "stopped" });
          set({ phase: "stopped", current: null });
          return;
        }
        const state: JournalEntry["state"] =
          end.outcome === "succeeded"
            ? "done"
            : end.lost || end.outcome === "not-observed" || end.outcome === "could-not-tell"
              ? "unsure"
              : "failed";
        finishEntry(step.id, { state });
        if (state !== "done") set({ output: { title: view.title, lines: end.tail } });
        await get().look();
        return;
      }
      case "done": {
        refusals = 0;
        finishEntry(step.id, { state: "done", failed: res.failed });
        if (writesProgramFolders(step.kind)) offerFoldersUndo(step, res.paths[0] ?? null);
        if (res.health) set({ health: res.health });
        await get().look();
        return;
      }
      case "refused": {
        // The plan changed under us (or the runner is busy): drop the entry
        // and go by the fresh plan the engine sent back.
        set((s) => ({ journal: s.journal.filter((_, i) => i !== s.journal.length - 1) }));
        const words = refusalWords(res.reason, res.pathRefusal);
        if (words) {
          set({ plan: res.plan });
          fail(words, res.details);
          return;
        }
        if (++refusals > 3) {
          refusals = 0;
          fail("The plan kept changing while Plyloft tried it. Try again.", res.details);
          return;
        }
        await continueRun(res.plan);
        return;
      }
      default: {
        const never: never = res;
        fail(String(never));
      }
    }
  };

  return {
    open: false,
    tool: null,
    ...BASE,
    closed: [],

    show: (tool, options) => {
      const s = get();
      // A step that is running belongs to the sheet that started it.
      if (s.phase === "running") {
        set({ open: true, waiting: s.tool !== tool ? tool : null });
        return;
      }
      epoch++;
      refusals = 0;
      set({
        ...BASE,
        journal: [],
        agreed: [],
        skipped: [],
        tool,
        open: true,
        removeNpm: options?.removeNpm ?? false,
        reinstall: options?.reinstall ?? false,
        closed: s.tool === tool ? s.closed : [],
      });
      void get().look();
    },

    restart: (options) => {
      const tool = get().tool;
      if (tool && get().phase !== "running") get().show(tool, options);
    },

    dismiss: () => {
      if (get().phase === "running") return;
      epoch++;
      set({ ...BASE, journal: [], agreed: [], skipped: [], open: false });
    },

    look: async () => {
      const my = epoch;
      const s = get();
      const { tool, journal } = s;
      if (!tool) return;
      if (journal.length === 0) set({ phase: "looking", message: null, details: null });
      let plan: RepairPlan;
      try {
        plan = await cliRepairPlan(tool, requestFor(tool, s));
      } catch (e) {
        if (my !== epoch) return;
        failRaw(e);
        return;
      }
      if (my !== epoch) return;
      if (journal.length === 0) {
        // A machine that is fine says which version runs (the plan has none).
        let seen: CliHealth | null = null;
        if (plan.block?.kind === "nothingToRepair") seen = await cliHealth(tool).catch(() => null);
        if (my !== epoch) return;
        set({ plan, phase: "found", message: null, details: null, ...(seen ? { health: seen } : {}) });
        return;
      }
      await continueRun(plan);
    },

    tickNpm: async (on) => {
      // A different plan: what was agreed to is not what will be shown.
      set({ removeNpm: on, agreed: [] });
      await get().look();
    },

    lookAgain: () => pressed(() => get().look()),

    go: () =>
      pressed(async () => {
        const { plan } = get();
        if (!plan) return;
        refusals = 0;
        // What the person saw listed when they pressed: only these removals
        // run without a second press.
        set({ agreed: plan.steps.map((s) => s.id) });
        await continueRun(plan);
      }),

    proceed: () =>
      pressed(async () => {
        const { plan, current } = get();
        const step = plan?.steps.find((s) => s.id === current?.id);
        if (!step) {
          await get().look();
          return;
        }
        await runStep(step);
      }),

    closeSessions: () =>
      pressed(async () => {
        const { plan, tool } = get();
        const step = plan?.steps[0];
        if (!plan || !tool || !step || step.kind !== "closeSessions") return;
        const toClose = openTilesOf(tool).filter(
          (t) => t.ptyId === null || step.sessions.some((s) => s.source === "tile" && s.ptyId === t.ptyId),
        );
        const title = stepView(step, tool).title;
        set((s) => ({
          closed: [
            ...s.closed,
            ...toClose.map(
              (t): ClosedTile => ({
                kind: t.kind,
                workspaceId: t.workspaceId,
                workspaceName: t.workspaceName,
                label: t.label,
                labelSource: t.labelSource,
                cwd: t.cwd,
                args: t.args,
                cliSessionId: t.cliSessionId,
              }),
            ),
          ],
          journal: s.journal.some((e) => e.kind === "closeSessions")
            ? s.journal
            : [...s.journal, { id: step.id, kind: "closeSessions", title, state: "done", failed: [] }],
        }));
        for (const t of toClose) void useTiles.getState().closeTile(t.id);
        if (toClose.length > 0) await tilesGone(toClose.map((t) => t.id));
        await get().look();
      }),

    stop: async () => {
      stopRequested = true;
      const id = get().runId ?? useSetupRun.getState().run?.runId ?? null;
      if (id) await setupStop(id).catch(() => false);
      // However it ends, Rust is asked soon whether the run is still there.
      setTimeout(() => pollNow?.(), 1500);
    },

    reopenTiles: () => {
      const { closed } = get();
      const tiles = useTiles.getState();
      const alive = new Set(useWorkspaces.getState().workspaces.map((w) => w.id));
      const skipped: string[] = [];
      for (const c of closed) {
        if (!alive.has(c.workspaceId)) {
          skipped.push(c.workspaceName ? `${c.workspaceName} · ${c.label}` : c.label);
          continue;
        }
        if (c.kind === "codex-chat") {
          tiles.addCodexChatTile(c.workspaceId, c.cwd);
          continue;
        }
        // As the product's own Continue does: the conversation's id and
        // nothing else (`restartTile`). A tile's other arguments can hold the
        // prompt it opened with, which a repair must never send again; with no
        // id the tile opens fresh, with none of them.
        const args = c.cliSessionId ? resumeArgs(c.kind, c.cliSessionId) : undefined;
        const opts = {
          label: c.label,
          labelSource: c.labelSource,
          ...(args ? { args } : {}),
          ...(c.cliSessionId ? { cliSessionId: c.cliSessionId } : {}),
        };
        if (c.kind === "claude") tiles.addClaudeTile(c.workspaceId, c.cwd, opts);
        else tiles.addCodexTile(c.workspaceId, c.cwd, opts);
      }
      set({ closed: [], reopened: true, skipped });
    },
  };
});
