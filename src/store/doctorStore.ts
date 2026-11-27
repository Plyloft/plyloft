import { create } from "zustand";
import {
  claudeReviewTrustStatus,
  dependencyDoctor,
  onReviewerAutoProbe,
  reviewerCapabilityProbe,
  onShellEnvChanged,
  shellEnvInfo,
  shellEnvRetry,
  type DoctorReport,
  type ReviewerAutoProbeEvent,
  type ShellEnvInfo,
} from "../ipc";
import { reviewerAutoProbeToast, type ReviewerAutoProbePress } from "../lib/reviewerAutoProbe";
import { WATCH_LIMIT_MS, doctorReadArgs, needsRows, watchDelayMs } from "../lib/diagnostics";
import { pushToast } from "./toastStore";
import { pushErrorToast } from "../lib/errorToast";

/**
 * v1.32.0 — dependency-doctor store. One shared fetch behind the welcome
 * screen, Settings › Diagnostics, and the persistent missing-dependency
 * banner, so they never disagree and "Look again" re-probes once for all.
 */
interface DoctorState {
  /** Shared executable snapshot consumed by the app shell and tile toolbar. */
  env: ShellEnvInfo | null;
  report: DoctorReport | null;
  loading: boolean;
  /** Load the backend's current cached executable snapshot. */
  refreshEnv: () => Promise<ShellEnvInfo>;
  /** Accept a fresh snapshot from another executable refresh (e.g. Codex). */
  setEnv: (env: ShellEnvInfo) => void;
  /** True while a background Codex update is running. */
  codexUpdating: boolean;
  setCodexUpdating: (running: boolean) => void;
  /**
   * Fetch the report from the cached probe (no shell re-probe).
   *
   * GH #103 review 1: `withAuth` also asks `gh` whether it is signed in, which
   * is a **network** round trip — so only Diagnostics and its watch pass it,
   * and the backend reuses an answer younger than ninety seconds. Calls that
   * overlap share one request.
   */
  refresh: (options?: { withAuth?: boolean }) => Promise<void>;
  /**
   * The "Look again" action: re-run the shell probe, then re-fetch.
   *
   * GH #173: only Diagnostics passes `withAuth` — it is the page that shows
   * the sign-in rows, and its `Look again, from scratch` is the one press
   * meant to re-ask `gh` (review 2, N2). The welcome screen's and the
   * banner's `Look again` re-probe the shell and ask nobody about sign-in:
   * before this card they ran `gh auth status` over the network on a screen
   * that never showed the answer.
   */
  reprobe: (options?: { withAuth?: boolean }) => Promise<void>;
  /**
   * GH #103: the Diagnostics rows whose condition Ply is waiting on, and when
   * the wait began.
   *
   * It lives here rather than in the page because the wait outlives the page:
   * pressing `Sign in` opens a shell tile running `gh auth login` and closes
   * Settings, so the person can answer it — and the row that asked has to turn
   * `Ready` by itself when it works, however long that takes and wherever the
   * person is looking.
   */
  watching: Record<string, number>;
  /** Start watching a row, re-reading the report until its check turns good. */
  watch: (rowId: string) => void;
  unwatch: (rowId: string) => void;
}

let watchTimer: number | null = null;
/** The read in flight, so the several places that ask at once — app launch, a
 *  workspace switch, a definition event, a page opening — share one request
 *  instead of each making their own (review 1). */
let inFlight: { promise: Promise<void>; withAuth: boolean } | null = null;
/** True between a scheduled read starting and its outcome being settled, so a
 *  row watched while one is in flight joins that chain instead of starting a
 *  second one (two chains would double every request to GitHub). */
let watchReading = false;

/**
 * GH #227 review 2: `dependency_doctor` runs on a worker now, so two reads can
 * answer out of order — a `refresh` issued before a `reprobe` could land after
 * it and put back the older report. Each read is numbered when it is sent;
 * an answer older than the last one applied is dropped. `loading` stays true
 * while any read is still out.
 */
let issued = 0;
let applied = 0;
let pending = 0;

/** Ask for the report, numbered; `null` when a newer answer already landed. */
async function readReport(
  ...args: Parameters<typeof dependencyDoctor>
): Promise<{ report: DoctorReport | null }> {
  const seq = ++issued;
  pending += 1;
  try {
    const report = await dependencyDoctor(...args);
    if (seq < applied) return { report: null };
    applied = seq;
    return { report };
  } finally {
    pending -= 1;
  }
}

/** Test seam: forget the numbering between tests. */
export function resetDoctorReadsForTest(): void {
  issued = 0;
  applied = 0;
  pending = 0;
  inFlight = null;
}

export const useDoctor = create<DoctorState>((set) => ({
  env: null,
  report: null,
  loading: false,
  refreshEnv: async () => {
    const env = await shellEnvInfo();
    set({ env });
    return env;
  },
  setEnv: (env) => set({ env }),
  codexUpdating: false,
  setCodexUpdating: (codexUpdating) => set({ codexUpdating }),
  refresh: (options) => {
    const withAuth = options?.withAuth === true;
    // A read already running answers this one too, unless it is the weaker
    // kind and this one needs the sign-in row.
    if (inFlight && (inFlight.withAuth || !withAuth)) return inFlight.promise;
    const previous = inFlight?.promise ?? Promise.resolve();
    set({ loading: true });
    const promise = previous
      .catch(() => {})
      .then(async () => {
        try {
          const { report } = await readReport(...doctorReadArgs(withAuth, false));
          set(report ? { report, loading: pending > 0 } : { loading: pending > 0 });
        } catch {
          set({ loading: pending > 0 });
        }
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { promise, withAuth };
    return promise;
  },
  watching: {},
  watch: (rowId) => {
    set((s) => ({ watching: { ...s.watching, [rowId]: Date.now() } }));
    startWatchTimer();
  },
  unwatch: (rowId) => {
    set((s) => {
      const next = { ...s.watching };
      delete next[rowId];
      return { watching: next };
    });
    stopWatchTimerIfIdle();
  },
  reprobe: async (options) => {
    const withAuth = options?.withAuth === true;
    set({ loading: true });
    try {
      // Keep the app shell's executable snapshot in lockstep with the doctor
      // report. Previously this fresh value was discarded, so the required-
      // dependency modal closed while the Terminals toolbar still hid the
      // newly detected Claude button until Ply restarted.
      // `Look again, from scratch` is the one press that is meant to cost
      // something: it re-probes the shell and, ignoring the remembered answer,
      // re-asks `gh` (review 2, N2 — `shell_env_retry` also forgets it).
      // Anywhere else (GH #173) the re-probe asks nobody about sign-in.
      const env = await shellEnvRetry();
      const { report } = await readReport(...doctorReadArgs(withAuth, withAuth));
      set(report ? { env, report, loading: pending > 0 } : { env, loading: pending > 0 });
    } catch {
      set({ loading: pending > 0 });
    }
  },
}));

/**
 * While anything is being waited on, re-read the report and let go of every row
 * whose check has turned good — saying so, because the terminal the person is
 * looking at will not.
 *
 * Chained timeouts, not an interval: reading the report asks `gh auth status`
 * over the network, so one read never starts before the last has finished, and
 * the gap grows as the wait does (`watchDelayMs`).
 */
function startWatchTimer(): void {
  if (watchTimer !== null || watchReading) return;
  schedule();
}

function schedule(): void {
  const started = Object.values(useDoctor.getState().watching);
  if (started.length === 0) {
    watchTimer = null;
    return;
  }
  // The gap follows the row that started waiting **last**: a step pressed in
  // the middle of a long wait deserves the quick cadence, not the one the
  // oldest row has slowed to (review 1, finding 15).
  const waited = Date.now() - Math.max(...started);
  watchTimer = window.setTimeout(() => {
    watchTimer = null;
    watchReading = true;
    void useDoctor
      .getState()
      // The watch is waiting on exactly the conditions the sign-in row
      // carries, so it is one of the two reads that ask.
      .refresh({ withAuth: true })
      .then(settleWatched)
      .catch(settleWatched);
  }, watchDelayMs(waited));
}

function settleWatched(): void {
  watchReading = false;
  const state = useDoctor.getState();
  const rows = state.report ? needsRows(state.report) : [];
  for (const id of Object.keys(state.watching)) {
    const row = rows.find((r) => r.id === id);
    if (row?.signal === "ok") {
      state.unwatch(id);
      pushToast({ kind: "info", title: `${row.label} is ready.` });
    } else if (Date.now() - state.watching[id] > WATCH_LIMIT_MS) {
      // Given up on: stop asking rather than reading for ever, and say
      // nothing — nothing happened.
      state.unwatch(id);
    } else if (state.report && !row) {
      // The row is not in the report any more (no workspace open, a check that
      // stopped applying): there is nothing left to wait for.
      state.unwatch(id);
    }
  }
  schedule();
}

function stopWatchTimerIfIdle(): void {
  if (watchTimer === null) return;
  if (Object.keys(useDoctor.getState().watching).length > 0) return;
  window.clearTimeout(watchTimer);
  watchTimer = null;
}

/**
 * E3 (owner, 2026-10-28): the reviewer toast's press — the Diagnostics row's
 * own way out, run from the toast. "Open Claude there" opens the Claude tile
 * on Plyloft's review folder in the active workspace (as the trust step
 * does, `ClaudeReviewTrustStep`), or Diagnostics, where the step is, when no
 * workspace is open or the folder can't be read. "Prove it again" runs the
 * reviewer check now and says how it went.
 */
export async function reviewerPress(kind: ReviewerAutoProbePress, event: ReviewerAutoProbeEvent): Promise<void> {
  const { useUi, openCenterMode } = await import("./uiStore");
  if (kind === "open-trust") {
    const { useWorkspaces } = await import("./workspaceStore");
    const { useTiles } = await import("./tileStore");
    const wsId = useWorkspaces.getState().activeId;
    const known = !!wsId && useWorkspaces.getState().workspaces.some((w) => w.id === wsId);
    const status = await claudeReviewTrustStatus().catch(() => null);
    if (!known || !wsId || !status) {
      useUi.getState().openSettingsSection("diagnostics");
      return;
    }
    if (status.trusted === true) {
      await reviewerPress("prove-again", event);
      return;
    }
    const tile = useTiles.getState().addClaudeTile(wsId, status.folder);
    openCenterMode(wsId, "terminals");
    useTiles.getState().setExpanded(wsId, tile.id);
    if (useUi.getState().settingsOverlayOpen) useUi.getState().setSettingsOverlayOpen(false);
    return;
  }
  const provider = event.provider === "codex" ? "codex" : "claude";
  const name = provider === "codex" ? "Codex" : "Claude";
  try {
    const proved = await reviewerCapabilityProbe(provider);
    await useDoctor.getState().refresh();
    if (proved.eligible) {
      pushToast({ kind: "info", title: `${name} can review your cards again` });
    } else {
      pushToast({
        kind: "warn",
        title: `${name} still can't review your cards`,
        body: "The check didn't pass again. Diagnostics has what it found.",
        details: proved.proof,
        action: { label: "Open Diagnostics", onClick: () => useUi.getState().openSettingsSection("diagnostics") },
      });
    }
  } catch (e) {
    pushErrorToast(`Plyloft couldn't check ${name} again`, e);
  }
}

let autoProbeSubscribed = false;

/** A provider CLI updated itself and Ply re-probed its reviewer capability
 *  in the background: refresh the doctor row, and warn when it failed. */
export function startDoctorSubscriptions(): void {
  if (autoProbeSubscribed) return;
  autoProbeSubscribed = true;
  onReviewerAutoProbe((event) => {
    void useDoctor.getState().refresh();
    const toast = reviewerAutoProbeToast(event);
    if (toast) {
      const { press, ...words } = toast;
      pushToast({ ...words, action: { label: press.label, onClick: () => void reviewerPress(press.kind, event) } });
    }
  }).catch((err) => {
    autoProbeSubscribed = false;
    console.error("doctor: onReviewerAutoProbe subscription failed:", err);
  });
  // A changed PATH override re-probes in the background: take its snapshot
  // so the Terminals page's Claude/Codex buttons and Diagnostics follow at
  // once, not at the next Look again (2026-10-16).
  onShellEnvChanged((env) => {
    useDoctor.getState().setEnv(env);
    void useDoctor.getState().refresh();
  }).catch((err) => {
    console.error("doctor: onShellEnvChanged subscription failed:", err);
  });
}
