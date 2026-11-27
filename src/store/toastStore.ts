import { create } from "zustand";
import { machineWords } from "../lib/platform";
import { cliNotStartingToast } from "../lib/cliNotStarting";
import { showBackendText } from "../lib/backendMarks";

export type ToastKind = "info" | "warn" | "error";

/** v1.24.0 (G4): optional callback action on a toast (e.g. "Undo").
 *  Click on the button invokes `onClick`, then dismisses the toast.
 *
 *  Owner, 2026-10-19: a toast with an action stays until it is dismissed —
 *  the action is the way forward, and it must not go away before the person
 *  has read it. The one exception is an action that itself stops working
 *  after a while (Undo): it sets `ttlMs`, and the toast goes when it does. */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Only for an action that stops working after this long (Undo's
   *  window). Leave it out and the toast stays until dismissed. */
  ttlMs?: number;
}

/**
 * GH #296 (the ToastBar spec, ADR 0007): one toast on screen at a time. E3
 * (owner, 2026-10-28): `title` on its own line, `body` under it. Raw machine
 * text never sits in either: it goes in `details` (or the older `copyText`),
 * which the toast keeps behind `Details` (GH #297).
 *
 * QoL 1.168 block 8 (A2, Challenger H1): nothing that matters is dropped.
 * An Undo never waits: it takes the screen at once, and what it covers goes
 * back to the head of `queue` with what is left of its time. A toast that
 * stays until dismissed is put back, never dropped, by a newer one. An info
 * waits behind a warn or an error for that toast's timed life — or at most
 * `PERSISTENT_YIELD_MS` behind one with no timer, which then comes back right
 * after it. A newer timed warn or error replaces an older timed one. Timers
 * stand still while the window is hidden (a close only hides it), and the
 * last ten toasts stay readable under the Inbox's ⋯ (`recent`).
 */
export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** The raw error behind `Details` — never in the line itself (GH #297). */
  details?: string;
  /** Older name for `details`, kept for its callers: the same disclosure. */
  copyText?: string;
  /** v1.24.0 (G4): optional inline action button. Currently used by the
   *  Promote-to-knowledge flow for the Undo affordance. */
  action?: ToastAction;
  /** E3 round 2: a second press beside `action` (Show the files · Sync
   *  again). Runs, then the toast goes, like `action`. */
  secondaryAction?: ToastAction;
  /** GH #138: override the auto-dismiss window. The drop guard's guidance is
   *  raised for as long as the drag is over ground that will refuse it and
   *  dismissed by hand when the drag ends, so it must not expire underneath
   *  a drag the user is still holding. */
  ttlMs?: number;
  /** 1.168.1 (walk #12): a notice the app also keeps somewhere else (the
   *  "Updated to" toast — Help keeps its dot and New in this version). It
   *  stays until dismissed while it is alone; once it has been on screen
   *  `DROP_COVERED_AFTER_MS`, a newer toast replaces it for good — it never
   *  comes back behind the one that covered it, so dismissing that one
   *  leaves nothing on screen. Covered sooner, it is put back as usual, so
   *  a toast at app start never hides it before anyone has seen it. */
  dropWhenCovered?: boolean;
  /** X2 round 1 (owner, 2026-10-31): raised from inside the Settings
   *  overlay — shown above Settings (still under its sheets) while Settings
   *  is open. Left out, `push` sets it when the Settings overlay holds the
   *  keyboard focus (what the person is doing there raised it). */
  scope?: "settings";
  createdAt: number;
}

/** X2 round 1: the Settings overlay (`.ux-backdrop`) holds the focus. */
export function focusInSettings(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  return el instanceof Element && el.closest(".ux-backdrop") !== null;
}

/** A past toast, as "Recent messages" lists it: its words, never its action
 *  (an Undo from minutes ago would act on something that has moved on). */
export interface RecentToast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  details?: string;
  createdAt: number;
  /** Its Undo was pressed (final Mac walk). */
  undone?: boolean;
  /** The same message, said this many times in a row (×3). */
  times?: number;
}

/** How many past toasts "Recent messages" keeps (A2). */
export const RECENT_TOASTS = 10;
/** How many toasts may wait; past it the oldest plain info goes first, then
 *  the oldest timed warn or error. A toast that stays until dismissed is
 *  never dropped (Challenger H1). */
export const QUEUED_TOASTS = 5;
/** Challenger H1: how long an info waits behind a warn or an error that has
 *  no timer of its own (it stays until dismissed). Then the info shows and
 *  the persistent one comes back right after it. */
export const PERSISTENT_YIELD_MS = 12000;
/** 1.168.1 (#12, Challenger): how long a `dropWhenCovered` toast must have
 *  been on screen before a newer one may drop it rather than put it back. */
export const DROP_COVERED_AFTER_MS = 5000;

/** Why a toast's timer is held: the pointer is on it, its Details is open,
 *  the window is hidden, or it is covered (back in the queue). It runs again
 *  only once nothing holds it. */
export type TimerHold = "hover" | "details" | "hidden" | "covered";

interface ToastState {
  /** At most one: the toast on screen (GH #296). An array so callers that
   *  look for a toast by id or text keep working. */
  toasts: Toast[];
  /** Block 8 (A2): the toasts waiting, next first. Each shows, with its own
   *  time (or what is left of it, for one that was covered), when the one
   *  before it goes. */
  queue: Toast[];
  /** The last `RECENT_TOASTS` toasts, newest first, whether or not they
   *  are still on screen — tokens redacted (Challenger L7). */
  recent: RecentToast[];
  push: (t: Omit<Toast, "id" | "createdAt">) => string;
  dismiss: (id: string) => void;
  pauseTimer: (id: string, hold?: TimerHold) => void;
  resumeTimer: (id: string, hold?: TimerHold) => void;
  clearRecent: () => void;
  /** Its Undo was pressed: Recent messages says "(undone)". */
  markUndone: (id: string) => void;
  /** E3: the toast's "1 more message" press — the next waiting toast
   *  shows, and the one on screen goes to the back of the line, with what
   *  is left of its time. Nothing when nothing waits. */
  showWaiting: () => void;
}

const AUTO_DISMISS_INFO_MS = 6000;
const AUTO_DISMISS_WARN_MS = 8000;
const AUTO_DISMISS_ERROR_MS = 12000;
/** The ToastBar's Undo window (GH #296): an Undo that stops working after
 *  it passes it as its action's `ttlMs`. */
export const UNDO_TOAST_MS = 6000;

let counter = 0;
const newId = () => `t${Date.now()}-${counter++}`;

/** Per-toast timer bookkeeping. Lives outside React state because React
 *  doesn't need to re-render as a timer ticks. `timeoutId === 0` means
 *  the timer is held (no pending setTimeout). A covered toast keeps its
 *  entry, held `covered`, so it comes back with what is left of its time. */
interface TimerEntry {
  timeoutId: number;
  remainingMs: number;
  startedAt: number;
  holds: Set<TimerHold>;
}
const timers = new Map<string, TimerEntry>();

/** How long the toast stays, or `null` for "until dismissed": an action
 *  toast stays unless its action has a window of its own (Undo). */
export function computeTtl(t: Omit<Toast, "id" | "createdAt">): number | null {
  if (t.ttlMs != null) return t.ttlMs;
  if (t.action) return t.action.ttlMs ?? null;
  if (t.kind === "info") return AUTO_DISMISS_INFO_MS;
  if (t.kind === "warn") return AUTO_DISMISS_WARN_MS;
  return AUTO_DISMISS_ERROR_MS;
}

/** A warn or an error holds the screen against an info: the info waits
 *  behind it (A2) — for that toast's timed life, or `PERSISTENT_YIELD_MS`. */
export function holdsScreen(t: Pick<Toast, "kind">): boolean {
  return t.kind === "warn" || t.kind === "error";
}

/** Challenger H1: an action with a window of its own (Undo) — it never
 *  waits, and its window runs whatever covers it. */
export function hasOwnWindow(t: Pick<Toast, "action" | "ttlMs">): boolean {
  return t.ttlMs == null && t.action?.ttlMs != null;
}

/** 1.176.1 walk: a toast that carries an Undo — timed (`hasOwnWindow`) or
 *  staying until dismissed (Repair's "Program folders changed · Undo") —
 *  keeps the screen: what comes after it waits, it is never put behind "1
 *  more message". An unrelated warn hid that Undo in the walk. */
export function isUndo(t: Pick<Toast, "action" | "ttlMs">): boolean {
  return hasOwnWindow(t) || /^undo\b/i.test(t.action?.label?.trim() ?? "");
}

/** Challenger H1: a toast that stays until dismissed (an action with no
 *  window of its own) — never dropped by a newer one, only put back. */
export function isPersistent(t: Omit<Toast, "id" | "createdAt">): boolean {
  return computeTtl(t) === null;
}

/** Challenger L3: the window's visibility as `usePageVisible` reads it (the
 *  `visibilitychange` signal with Tauri's focus as the fallback), fed by
 *  `ToastStack` through `setToastsPageVisible`. */
let pageVisible = typeof document !== "undefined" ? !document.hidden : true;

function clearTimer(id: string) {
  const entry = timers.get(id);
  if (entry && entry.timeoutId !== 0) {
    window.clearTimeout(entry.timeoutId);
  }
  timers.delete(id);
}

let yieldTimer = 0;
/** The toast on screen and since when (one at a time, GH #296). */
let onScreen: { id: string; since: number } | null = null;
function clearYield() {
  if (yieldTimer !== 0) window.clearTimeout(yieldTimer);
  yieldTimer = 0;
}

/** The waiting toasts, trimmed to `QUEUED_TOASTS`: the oldest plain info
 *  first, then the oldest timed warn or error; a persistent one never. */
function trimQueue(queue: Toast[]): Toast[] {
  const q = [...queue];
  while (q.length > QUEUED_TOASTS) {
    let at = q.findIndex((t) => !holdsScreen(t) && !isPersistent(t) && !hasOwnWindow(t));
    if (at < 0) at = q.findIndex((t) => !isPersistent(t) && !hasOwnWindow(t));
    if (at < 0) break;
    const [gone] = q.splice(at, 1);
    clearTimer(gone.id);
  }
  return q;
}

/** Challenger L7: a token never lands in Recent messages — a URL's
 *  `user:token@` and GitHub's `ghp_…`/`gho_…`/`ghu_…`/`ghs_…`/`ghr_…`. */
export function redactSecrets(text: string): string {
  return text
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://…@")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "gh…_[hidden]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "github_pat_[hidden]");
}

function asRecent(t: Toast): RecentToast {
  const details = t.details ?? t.copyText;
  return {
    id: t.id,
    kind: t.kind,
    title: redactSecrets(t.title),
    ...(t.body !== undefined ? { body: redactSecrets(t.body) } : {}),
    ...(details !== undefined ? { details: redactSecrets(details) } : {}),
    createdAt: t.createdAt,
  };
}

export const useToasts = create<ToastState>((set, get) => {
  const fire = (id: string) => () => get().dismiss(id);
  /** Put `toast` on screen: its timer starts, or — one that was covered —
   *  runs on with what was left. An Undo whose window passed while it
   *  waited is not shown. Returns false when there is nothing to show. */
  const showTimer = (toast: Toast): boolean => {
    const entry = timers.get(toast.id);
    if (entry) {
      entry.holds.delete("covered");
      // A5F-06: its bar is mounted again, closed and not under the pointer.
      entry.holds.delete("hover");
      entry.holds.delete("details");
      if (pageVisible) entry.holds.delete("hidden");
      else entry.holds.add("hidden");
      if (entry.holds.size === 0 && entry.timeoutId === 0) {
        entry.startedAt = Date.now();
        entry.timeoutId = window.setTimeout(fire(toast.id), entry.remainingMs);
      }
      return true;
    }
    const base = computeTtl(toast);
    if (base === null) return true;
    const ttl = hasOwnWindow(toast) ? base - (Date.now() - toast.createdAt) : base;
    if (ttl <= 0) return false;
    const holds = new Set<TimerHold>(pageVisible ? [] : ["hidden"]);
    const timeoutId = holds.size ? 0 : window.setTimeout(fire(toast.id), ttl);
    timers.set(toast.id, { timeoutId, remainingMs: ttl, startedAt: Date.now(), holds });
    return true;
  };
  /** Take `toast` off the screen without losing it: a timed one keeps what
   *  is left of its time, held `covered` — except an Undo, whose window
   *  runs on (its action stops working when it ends, wherever it is). */
  const cover = (toast: Toast) => {
    if (hasOwnWindow(toast)) return;
    const entry = timers.get(toast.id);
    if (!entry) return;
    entry.holds.add("covered");
    if (entry.timeoutId !== 0) {
      window.clearTimeout(entry.timeoutId);
      entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt));
      entry.timeoutId = 0;
    }
  };
  /** Show `toast` now; `back` are put at the head of the queue. */
  const show = (toast: Toast, back: Toast[] = []) => {
    clearYield();
    const queue = trimQueue([...back, ...get().queue.filter((t) => t.id !== toast.id)]);
    set({ toasts: [toast], queue });
    onScreen = { id: toast.id, since: Date.now() };
    if (!showTimer(toast)) {
      set({ toasts: [] });
      showNext();
      return;
    }
    armYield();
  };
  /** Put the next waiting toast on screen, skipping an expired Undo. */
  const showNext = () => {
    clearYield();
    // A waiting Undo is shown before anything else (Challenger H1 round 2).
    const waiting = get().queue;
    const at = Math.max(0, waiting.findIndex(isUndo));
    const next = waiting[at];
    const rest = waiting.filter((_, i) => i !== at);
    if (!next) {
      set({ toasts: [], queue: [] });
      return;
    }
    set({ toasts: [next], queue: rest });
    onScreen = { id: next.id, since: Date.now() };
    if (!showTimer(next)) {
      set({ toasts: [] });
      showNext();
      return;
    }
    armYield();
  };
  /** H1 (3): a persistent warn or error on screen with an info waiting gives
   *  way after `PERSISTENT_YIELD_MS`: the info shows, the persistent one
   *  comes back right after it. */
  const armYield = () => {
    clearYield();
    const current = get().toasts[0];
    const waiting = get().queue[0];
    if (!current || !waiting || !holdsScreen(current) || !isPersistent(current)) return;
    if (holdsScreen(waiting)) return;
    yieldTimer = window.setTimeout(() => {
      yieldTimer = 0;
      const now = get().toasts[0];
      const next = get().queue[0];
      if (!now || now.id !== current.id || !next) return;
      cover(now);
      show(next, [now]);
    }, PERSISTENT_YIELD_MS);
  };
  return {
    toasts: [],
    queue: [],
    recent: [],
    push: (given) => {
      const id = newId();
      // 1.176.0 R7: a refusal for a Claude or Codex that is installed but
      // doesn't start, wherever it was raised: its sentence, and Repair.
      // The mark itself never shows.
      const repair = cliNotStartingToast({ ...given, hasAction: !!given.action });
      const tool = repair?.tool;
      const t = repair
        ? {
            ...given,
            title: repair.title,
            ...(repair.body !== undefined ? { body: repair.body } : {}),
            ...(repair.details !== undefined ? { details: repair.details } : {}),
            ...(repair.copyText !== undefined ? { copyText: repair.copyText } : {}),
            ...(tool
              ? {
                  action: {
                    label: repair.label,
                    onClick: () => void import("../lib/openRepair").then((m) => m.openRepair(tool)),
                  },
                }
              : {}),
          }
        : given;
      // 1.176.0 seams: no backend mark of any kind (`backendMarks.ts`) is shown.
      const shown = {
        title: showBackendText(t.title),
        ...(t.body !== undefined ? { body: showBackendText(t.body) } : {}),
        ...(t.details !== undefined ? { details: showBackendText(t.details) } : {}),
        ...(t.copyText !== undefined ? { copyText: showBackendText(t.copyText) } : {}),
      };
      // W5: the machine named as this platform names it (`this PC` on Windows).
      const toast: Toast = {
        ...t,
        ...shown,
        title: machineWords(shown.title),
        ...(shown.body !== undefined ? { body: machineWords(shown.body) } : {}),
        // `details` and `copyText` stay verbatim: raw output, paths, a
        // transcript. The backend names the machine itself (`THIS_MACHINE`).
        // 1.176.1 walk 3: an Undo lives as long as every Undo in the product
        // (`UNDO_TOAST_MS`), wherever it was raised — Repair's stayed for
        // minutes, its Undo two saves old.
        ...(t.action
          ? {
              action: {
                ...t.action,
                label: machineWords(t.action.label),
                ...(t.action.ttlMs == null && t.ttlMs == null && isUndo(t) ? { ttlMs: UNDO_TOAST_MS } : {}),
              },
            }
          : {}),
        ...(t.secondaryAction
          ? { secondaryAction: { ...t.secondaryAction, label: machineWords(t.secondaryAction.label) } }
          : {}),
        ...(t.scope === undefined && focusInSettings() ? { scope: "settings" as const } : {}),
        id,
        createdAt: Date.now(),
      };
      // The same message again, right after itself, is one line "×N".
      const said = asRecent(toast);
      const [last, ...older] = get().recent;
      const same =
        last &&
        !last.undone &&
        last.kind === said.kind &&
        last.title === said.title &&
        last.body === said.body &&
        last.details === said.details;
      set({
        recent: same
          ? [{ ...said, times: (last.times ?? 1) + 1 }, ...older]
          : [said, ...get().recent].slice(0, RECENT_TOASTS),
      });
      // 1.176.3: a toast that stays until dismissed, said again while the
      // same one is on screen or waiting, replaces it — repeated presses of
      // a failing action never pile up "Open …" toasts behind "1 more message".
      if (isPersistent(toast) && !isUndo(toast)) {
        const same = (c: Toast) =>
          isPersistent(c) && !isUndo(c) && c.kind === toast.kind && c.title === toast.title && c.body === toast.body && c.action?.label === toast.action?.label;
        const waiting = get().queue.filter(same);
        if (waiting.length) {
          for (const w of waiting) clearTimer(w.id);
          set({ queue: get().queue.filter((c) => !same(c)) });
        }
        const onScreenNow = get().toasts[0];
        if (onScreenNow && same(onScreenNow)) {
          clearTimer(onScreenNow.id);
          show(toast);
          return id;
        }
      }
      const current = get().toasts[0];
      if (!current) {
        show(toast);
        return id;
      }
      // 1.168.1 (#12): a notice kept elsewhere, once it has been seen, just
      // goes — a newer toast is never followed by it again. Sooner than
      // that, it is put back like any toast that stays (below).
      if (
        current.dropWhenCovered &&
        onScreen?.id === current.id &&
        Date.now() - onScreen.since >= DROP_COVERED_AFTER_MS
      ) {
        clearTimer(current.id);
        show(toast);
        return id;
      }
      // Kept rather than dropped when something covers it: a warn or an
      // error, a toast that stays until dismissed, an Undo still running.
      const keep = (c: Toast) => holdsScreen(c) || isPersistent(c) || hasOwnWindow(c);
      // H1 (1): an Undo never waits — it takes the screen; what it covers
      // goes back to the head of the queue (a plain info just goes).
      if (isUndo(toast)) {
        if (keep(current)) {
          cover(current);
          show(toast, [current]);
        } else {
          clearTimer(current.id);
          show(toast);
        }
        return id;
      }
      // An Undo on screen keeps it for its short window: the new one waits.
      // Challenger H1 round 2: after any Undo already waiting — an Undo
      // always goes first, its window runs out wherever it is.
      // 1.176.1 walk: an Undo that stays until dismissed holds the screen for
      // the usual Undo window after it showed; past it, a newer toast puts it
      // back (head of the queue) as any toast that stays.
      const undoHolds =
        hasOwnWindow(current) ||
        (isUndo(current) && onScreen?.id === current.id && Date.now() - onScreen.since < UNDO_TOAST_MS);
      if (undoHolds) {
        const queue = get().queue;
        const undos = queue.filter(isUndo);
        const rest = queue.filter((t) => !isUndo(t));
        set({ queue: trimQueue([...undos, toast, ...rest]) });
        return id;
      }
      if (holdsScreen(toast)) {
        // H1 (2): a persistent toast is never dropped by a newer warn or
        // error — it goes back to the head of the queue. A timed older warn
        // or error is replaced (the newer news; it stays in `recent`).
        if (isPersistent(current)) {
          cover(current);
          show(toast, [current]);
        } else {
          clearTimer(current.id);
          show(toast);
        }
        return id;
      }
      // An info.
      if (holdsScreen(current)) {
        // A2 / H1 (3): it waits behind the warn or error — for its timed
        // life, or `PERSISTENT_YIELD_MS` when it has none.
        set({ queue: trimQueue([...get().queue, toast]) });
        armYield();
        return id;
      }
      if (isPersistent(current)) {
        // A persistent info is put back, never dropped.
        cover(current);
        show(toast, [current]);
        return id;
      }
      // A plain info on screen is replaced (GH #296).
      clearTimer(current.id);
      show(toast);
      return id;
    },
    dismiss: (id) => {
      clearTimer(id);
      if (get().toasts.some((t) => t.id === id)) {
        set({ toasts: [] });
        showNext();
        return;
      }
      set((s) => ({ queue: s.queue.filter((t) => t.id !== id) }));
      armYield();
    },
    pauseTimer: (id, hold = "hover") => {
      const entry = timers.get(id);
      if (!entry) return;
      entry.holds.add(hold);
      if (entry.timeoutId === 0) return;
      window.clearTimeout(entry.timeoutId);
      entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt));
      entry.timeoutId = 0;
    },
    resumeTimer: (id, hold = "hover") => {
      const entry = timers.get(id);
      if (!entry) return;
      entry.holds.delete(hold);
      if (entry.holds.size > 0 || entry.timeoutId !== 0) return;
      entry.startedAt = Date.now();
      entry.timeoutId = window.setTimeout(fire(id), entry.remainingMs);
    },
    showWaiting: () => {
      const current = get().toasts[0];
      const [next, ...rest] = get().queue;
      if (!current || !next) return;
      clearYield();
      // Challenger 1: the press unmounts this toast, so the pointer's leave
      // and Details' close never come — their holds go with it, or it would
      // come back held and never time out.
      const entry = timers.get(current.id);
      entry?.holds.delete("hover");
      entry?.holds.delete("details");
      cover(current);
      set({ toasts: [next], queue: trimQueue([...rest, current]) });
      onScreen = { id: next.id, since: Date.now() };
      if (!showTimer(next)) {
        set({ toasts: [] });
        showNext();
        return;
      }
      armYield();
    },
    clearRecent: () => set({ recent: [] }),
    markUndone: (id) => set((s) => ({ recent: s.recent.map((r) => (r.id === id ? { ...r, undone: true } : r)) })),
  };
});

/** Challenger L3: `ToastStack` passes `usePageVisible()` here. While the
 *  window is hidden (a close only hides it, Hard rule 5) the toast on
 *  screen keeps its time, and gets all of it back on return. */
export function setToastsPageVisible(visible: boolean) {
  if (visible === pageVisible) return;
  pageVisible = visible;
  const s = useToasts.getState();
  for (const t of s.toasts) {
    if (visible) s.resumeTimer(t.id, "hidden");
    else s.pauseTimer(t.id, "hidden");
  }
}

export function pushToast(t: Omit<Toast, "id" | "createdAt">): string {
  return useToasts.getState().push(t);
}

export function dismissToast(id: string) {
  useToasts.getState().dismiss(id);
}

/** GH #138: is this toast still on screen (or waiting to be)? The drop
 *  guard's guidance is raised again if its own backstop expired while a drag
 *  was still over ground that refuses it. */
export function toastIsShowing(id: string): boolean {
  const s = useToasts.getState();
  return s.toasts.some((t) => t.id === id) || s.queue.some((t) => t.id === id);
}

/** Tests: nothing on screen, nothing waiting, no past toasts, no timers. */
export function resetToastsForTests() {
  for (const id of [...timers.keys()]) clearTimer(id);
  clearYield();
  pageVisible = true;
  onScreen = null;
  useToasts.setState({ toasts: [], queue: [], recent: [] });
}

/** The toast pushed last, on screen or waiting. */
export function latestToast(): Toast | undefined {
  const s = useToasts.getState();
  const id = s.recent[0]?.id;
  return [...s.toasts, ...s.queue].find((t) => t.id === id);
}
