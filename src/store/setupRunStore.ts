import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onPtyData,
  onSetupProgress,
  projectClone,
  setupActive,
  setupReach,
  setupRun,
  setupStop,
  type ProjectCloneResult,
  type ProjectCloneStart,
  type SetupArgs,
  type SetupOutcome,
  type SetupPhase,
  type SetupProgressEvent,
  type SetupReach,
  type SetupRunActionId,
  type SetupStarted,
} from "../ipc";
import { useDoctor } from "./doctorStore";
import { isRepairAction } from "../lib/repairAction";
import type { SetupRunEvidence } from "../lib/setupEvidence";

/**
 * OB-3 — Setup's one guided run (spec §7). Rust owns the PTY and decides
 * the result (`setup_run.rs`); this store starts and stops a run by action
 * id, follows its `setup://progress` events and, when an install or update
 * re-probed the shell, refreshes the doctor so every row agrees.
 *
 * It also keeps the run's output from its first byte: Rust starts the
 * command before `setup_run` answers, and gh prints its one-time code at
 * once, so a panel that listened only after the answer would miss it. The
 * panel reads the output through `subscribeSetupOutput`, which hands it
 * what came so far and then each new chunk, with no gap and no repeat.
 *
 * One run at a time is Rust's rule: a second `start` comes back as `error`
 * with the words naming the run under way.
 */
interface SetupRunState {
  run: SetupStarted | null;
  phase: SetupPhase | null;
  outcome: SetupOutcome | null;
  exitCode: number | null;
  /** The last output lines, from the final event (the error's Details). */
  tail: string[];
  /** 1.176.0 R2: the final event's cause and versions (empty before it). */
  evidence: SetupRunEvidence;
  /** Why the last `start` was refused, in Rust's words. */
  error: string | null;
  /** OB-12: a clone's end, from its final event (`project.clone`). */
  clone: ProjectCloneResult | null;
  /** OB-5: an install stopped before it ran — its host didn't answer. */
  blocked: { actionId: SetupRunActionId; reach: SetupReach } | null;
  /** OB-5: the sequence the current run belongs to, from this run on
   *  (Install both: `install.git`, `install.claude`), so Try again resumes
   *  the pair. Null for a run started on its own. */
  sequence: SetupRunActionId[] | null;
  /** OB-5: the runs of a sequence that never started because the run
   *  before them did not succeed. */
  halted: SetupRunActionId[] | null;
  /**
   * OB-5: run `ids` one at a time, each install first checked for its host
   * (`setup_reach`). The next starts only when the one before succeeded
   * (`always`: whatever its outcome — the code sign-in after a stopped
   * browser one). The chain lives here, not in the step, so it survives the
   * step unmounting; it is armed before the first run starts, so a run that
   * is Done before `setup_run` answers still continues it.
   */
  startSequence: (ids: SetupRunActionId[], options?: { always?: boolean }) => Promise<SetupStarted | null>;
  /**
   * 1.176.0 R6: follow a run some other command started (a Repair's
   * terminal step, `cli_repair_run`): `begin` answers its start, or null
   * when it started none. Its output is kept from the first byte and its
   * events are followed exactly as a Setup run's.
   */
  startVia: (begin: () => Promise<SetupStarted | null>) => Promise<SetupStarted | null>;
  /** What runs after the current run, once it ends (`always` as above). */
  then: (next: SetupRunActionId[], options?: { always?: boolean }) => void;
  start: (
    actionId: SetupRunActionId,
    args?: SetupArgs,
    size?: { cols: number; rows: number },
  ) => Promise<SetupStarted | null>;
  /**
   * OB-12 (spec §5 step 8b): get `repo` in the guided terminal. Rust checks
   * first (destination exists, already in Plyloft) and answers without a
   * run; otherwise it creates the folder and starts `project.clone`, which
   * this store follows like any run — its output from the first byte, and
   * the final event's `clone`.
   */
  startClone: (
    repo: string,
    options?: { destParent?: string; account?: string; size?: { cols: number; rows: number } },
  ) => Promise<ProjectCloneStart | null>;
  stop: () => Promise<void>;
  /** OB-5: stop the run and drop what was queued after it (leaving the
   *  step with "Stop the installer?"). */
  abandon: () => Promise<void>;
  /** A panel mounting while a run is under way picks it up. */
  attach: () => Promise<void>;
  receive: (event: SetupProgressEvent) => void;
  /** Forget a finished run (the step moved on). */
  clear: () => void;
}

/** What the output buffer keeps of one run. */
const OUTPUT_CAP = 512 * 1024;

let listeners: Promise<UnlistenFn[]> | null = null;
/** OB-5: what starts when the run `after` ends; `after` is null while the
 *  first run's `setup_run` has not answered. */
let chain: { after: string | null; next: SetupRunActionId[]; always: boolean } | null = null;
/** While `setup_run` has not answered: the run's id is not known yet. */
let starting = false;
/** Events that came before `setup_run` answered with their run's id (Rust
 *  says Running — and a run that ends at once, Done — before it returns). */
let early: SetupProgressEvent[] = [];
/** PTY output that came before the answer, by PTY id. */
let earlyOutput = new Map<string, Uint8Array[]>();
/** The current run's output, oldest first, and who is reading it. */
let output: { ptyId: string; chunks: Uint8Array[]; bytes: number } | null = null;
const readers = new Set<{ ptyId: string; write: (data: Uint8Array) => void }>();

function keep(ptyId: string, data: Uint8Array) {
  if (!output || output.ptyId !== ptyId) return;
  output.chunks.push(data);
  output.bytes += data.length;
  while (output.bytes > OUTPUT_CAP && output.chunks.length > 1) {
    output.bytes -= output.chunks.shift()!.length;
  }
  for (const reader of readers) if (reader.ptyId === ptyId) reader.write(data);
}

function onData(id: string, data: Uint8Array) {
  const run = useSetupRun.getState().run;
  if (run) {
    if (id === run.ptyId) keep(id, data);
  } else if (starting) {
    const list = earlyOutput.get(id) ?? [];
    list.push(data);
    earlyOutput.set(id, list);
  }
}

/** The listeners, for the app's life (per window), installed on first use. */
function ensureListeners(): Promise<UnlistenFn[]> {
  if (!listeners) {
    listeners = Promise.all([
      onSetupProgress((event) => useSetupRun.getState().receive(event)),
      onPtyData(onData),
    ]);
  }
  return listeners;
}

/**
 * Read the run's output: what came so far, at once, then every new chunk.
 * Returns the unsubscribe.
 */
export function subscribeSetupOutput(ptyId: string, write: (data: Uint8Array) => void): () => void {
  if (output?.ptyId === ptyId) for (const chunk of output.chunks) write(chunk);
  const reader = { ptyId, write };
  readers.add(reader);
  return () => {
    readers.delete(reader);
  };
}

/** Tests: the next test's stub gets its own listeners (src/test/setup.ts). */
export function stopSetupListenersForTests(): void {
  const pending = listeners;
  listeners = null;
  chain = null;
  starting = false;
  early = [];
  earlyOutput = new Map();
  output = null;
  readers.clear();
  void pending?.then((stops) => stops.forEach((stop) => stop())).catch(() => {});
}

/** R2: the evidence fields of a final event (absent on an older build's). */
function evidenceOf(event: SetupProgressEvent): SetupRunEvidence {
  return {
    cause: event.cause ?? null,
    causePath: event.causePath ?? null,
    versionBefore: event.versionBefore ?? null,
    versionAfter: event.versionAfter ?? null,
  };
}

const IDLE = {
  run: null,
  phase: null,
  outcome: null,
  exitCode: null,
  tail: [],
  evidence: {},
  error: null,
  clone: null,
  blocked: null,
  sequence: null,
  halted: null,
} satisfies Partial<SetupRunState>;

/** An install checks its host first; updates and sign-ins don't (their
 *  host isn't known for sure — `setup_actions::reach_url`). */
const checksHost = (id: SetupRunActionId) => id.startsWith("install.") && id !== "install.git";

export const useSetupRun = create<SetupRunState>((set, get) => {
  /** One run: `setup_run` (or `project_clone`, OB-12), with its early
   *  output and events kept. `begin` answers the run, or null when Rust
   *  started none (a clone's preflight answered instead). */
  const startWith = async (begin: () => Promise<SetupStarted | null>, own = false): Promise<SetupStarted | null> => {
    await ensureListeners();
    // 1.176.0 R6: while a Repair's step runs, another start (Rust refuses it:
    // one run at a time) must not wipe the run the sheet follows.
    const cur = get();
    if (!own && cur.run && cur.phase !== "done" && isRepairAction(cur.run.actionId)) {
      try {
        await begin();
      } catch (e) {
        set({ error: typeof e === "string" ? e : String(e) });
      }
      return null;
    }
    set({ ...IDLE });
    early = [];
    earlyOutput = new Map();
    output = null;
    starting = true;
    try {
      const run = await begin();
      if (!run) return null;
      const chunks = earlyOutput.get(run.ptyId) ?? [];
      output = { ptyId: run.ptyId, chunks, bytes: chunks.reduce((n, c) => n + c.length, 0) };
      // A sequence's chain waits for this run's id, before any early Done is
      // replayed below (Challenger P3-4).
      if (chain && chain.after === null) chain.after = run.runId;
      set({ run, phase: "running" });
      const caught = early.filter((e) => e.runId === run.runId);
      for (const event of caught) get().receive(event);
      return run;
    } catch (e) {
      set({ ...IDLE, error: typeof e === "string" ? e : String(e) });
      return null;
    } finally {
      starting = false;
      early = [];
      earlyOutput = new Map();
    }
  };

  const startRun = (
    actionId: SetupRunActionId,
    args?: SetupArgs,
    size?: { cols: number; rows: number },
  ) => startWith(() => setupRun(actionId, args, size));

  return {
  ...IDLE,

  startSequence: async (ids, options) => {
    const [id, ...rest] = ids;
    if (!id) return null;
    chain = null;
    if (checksHost(id)) {
      const reach = await setupReach(id).catch(() => null);
      if (reach && !reach.reachable) {
        set({ ...IDLE, blocked: { actionId: id, reach }, sequence: ids });
        return null;
      }
    }
    // Armed before the run starts (Challenger P3-4).
    chain = rest.length > 0 ? { after: null, next: rest, always: options?.always === true } : null;
    const run = await startRun(id);
    if (!run) chain = null;
    else set({ sequence: ids.length > 1 ? ids : null });
    return run;
  },

  startVia: async (begin) => {
    chain = null;
    return startWith(begin, true);
  },

  then: (next, options) => {
    const run = get().run;
    if (!run || get().phase === "done") {
      void get().startSequence(next, options);
      return;
    }
    chain = { after: run.runId, next, always: options?.always === true };
  },

  start: async (actionId, args, size) => {
    chain = null;
    return startRun(actionId, args, size);
  },

  startClone: async (repo, options) => {
    chain = null;
    let answer: ProjectCloneStart | null = null;
    await startWith(async () => {
      answer = await projectClone(repo, options);
      return answer.kind === "started" ? answer.run : null;
    });
    return answer;
  },

  stop: async () => {
    const run = get().run;
    if (!run || get().phase === "done") return;
    await setupStop(run.runId);
  },

  abandon: async () => {
    chain = null;
    await get().stop();
  },

  attach: async () => {
    await ensureListeners();
    // Challenger P3-4: while `start` waits for its answer it owns the run —
    // attaching then would drop the output kept so far (gh's code) and,
    // after an early Done, put the phase back to running.
    if (starting) return;
    const run = await setupActive();
    if (starting) return;
    // 1.176.0 R4: a Repair's run belongs to the Repair sheet, not Setup.
    if (run && isRepairAction(run.actionId)) return;
    if (run && get().run?.runId !== run.runId) {
      output = { ptyId: run.ptyId, chunks: [], bytes: 0 };
      set({ ...IDLE, run, phase: "running" });
    }
  },

  receive: (event) => {
    const run = get().run;
    if (!run) {
      if (starting) early = [...early, event].slice(-20);
      return;
    }
    // Another window's run, or one this store has already let go of.
    if (event.runId !== run.runId) return;
    set({
      phase: event.phase,
      outcome: event.outcome,
      exitCode: event.exitCode,
      tail: event.phase === "done" ? event.tail : get().tail,
      evidence: event.phase === "done" ? evidenceOf(event) : get().evidence,
      clone: event.phase === "done" ? (event.clone ?? null) : get().clone,
    });
    if (event.phase === "done" && event.reprobed) {
      const doctor = useDoctor.getState();
      void doctor.refreshEnv().catch(() => {});
      void doctor.refresh().catch(() => {});
    }
    if (event.phase === "done" && chain && chain.after === event.runId) {
      const c = chain;
      chain = null;
      if (event.outcome === "succeeded" || c.always) {
        // The rest of the sequence, after this run's re-probe was asked for.
        void Promise.resolve().then(() => get().startSequence(c.next, { always: c.always }));
      } else {
        set({ halted: c.next });
      }
    }
  },

  clear: () => {
    if (get().phase === "done" || !get().run) {
      output = null;
      set({ ...IDLE });
    }
  },
  };
});
