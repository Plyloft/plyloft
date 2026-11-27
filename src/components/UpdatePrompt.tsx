import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { error as logError, info as logInfo } from "@tauri-apps/plugin-log";
import { useKanban } from "../store/kanbanStore";
import { useTiles } from "../store/tileStore";
import { builderScreensReadFailing, freshBuilderScreens, useBuilder } from "../store/builderStore";
import { useAgents } from "../store/agentStore";
import { useSwarms } from "../store/swarmStore";
import { useVerify } from "../store/verifyStore";
import { useShip } from "../store/shipStore";
import { openWebLink, ptyCommandRunning } from "../ipc";
import { isFileDirty, useEditor } from "../store/editorStore";
import { useUi } from "../store/uiStore";
import { setupIsOpen } from "../store/setupStore";
import { visibleModalOpen } from "../lib/visibleModal";
import { pushToast } from "../store/toastStore";
import {
  ACTIVITY_EVENTS,
  IDLE_POLL_MS,
  idleBlocker,
  installDue,
  nextIdleLooks,
  type IdleFacts,
} from "../lib/updateIdle";
import { isMac } from "../lib/platform";
import { runningCounts } from "../lib/closeChoice";
import { busyForUpdate, workingTotal } from "../lib/quitGuard";
import {
  DOWNLOAD_URL,
  WHEN_DONE_LABEL,
  scheduledRowText,
  updateConfirmBody,
  updateFailedError,
  updateWaitLine,
  whenDoneHint,
} from "../lib/updateWords";
import { usePageVisible } from "../hooks/usePageVisible";
import { isTestBuild } from "../testBridge/isTestBuild";
import { StatusRow } from "./SidebarStatus";
import { CBtn, ErrorBlock, Sheet } from "./ux";
import { notificationsPermitted } from "../lib/agentNotifier";
import { confirmQuit, firstWaitingPlace, offScreenWorkingWhy, useQuitGuard, workingNow } from "../store/quitGuardStore";
import { OPEN_SESSION, OPEN_THE_BUILDER, openWaitingSession } from "../store/openWaitingSession";
import {
  UpdateFlow,
  formatDownloadStatus,
  releaseCheckFor,
  type UpdateLogger,
  type UpdateState,
} from "../lib/updateFlow";
import { linkDidNotOpen } from "../lib/linkToast";

/** v1.113.0: re-check the feed while the app stays open. Users keep Ply
 *  open for days (window-close hides — Hard Rule #5), so a launch-only
 *  check meant a release published this morning went unnoticed until the
 *  next relaunch. There is no push server by design: polling the public
 *  `latest.json` every 30 minutes is a few bytes and reaches everyone. */
const POLL_EVERY_MS = 30 * 60 * 1000;
/** A regained window after at least this long also triggers a check. */
const REFOCUS_MIN_GAP_MS = 10 * 60 * 1000;

/** GH #59: every updater step goes to Ply.log. A logging failure must never
 *  break the update itself. */
const updateLog: UpdateLogger = {
  info: (message) => {
    logInfo(message).catch(() => {});
  },
  error: (message) => {
    logError(message).catch(() => {});
  },
};

/** Native macOS notice for an update discovered while Ply was in the
 *  background. Permission is never requested here — Settings › Claude and Codex ›
 *  "Send a test notification" owns the prompt — and a focused window gets the
 *  sidebar's status row instead. */
async function notifyNative(version: string): Promise<void> {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  let plugin: typeof import("@tauri-apps/plugin-notification");
  try {
    plugin = await import("@tauri-apps/plugin-notification");
  } catch {
    return;
  }
  try {
    if (!(await notificationsPermitted(plugin))) return;
    plugin.sendNotification({
      title: `Plyloft ${version} is available`,
      body: "Open Plyloft to install it when you're ready.",
    });
  } catch {
    // permission revoked between the check and the send — nothing to do
  }
}

// One flow for the app's lifetime; the state machine lives in
// lib/updateFlow.ts so it can be tested without Tauri or React. UX-3.8: it is
// shared — this component runs the checks and draws the dialog, and the
// sidebar's status row ("Ply X is available · Install") reads the same state.
let sharedFlow: UpdateFlow | null = null;


export function updateFlow(): UpdateFlow {
  if (!sharedFlow) {
    sharedFlow = new UpdateFlow({
      // n16: a test build (`isTestBuild`) never finds a release.
      check: releaseCheckFor(isTestBuild, () => check()),
      relaunch,
      // QoL 1.168 S1-2: Install already asked (below); files edited while it
      // downloaded are asked about again before the install — on Windows the
      // installer ends Plyloft itself, so nothing after it would ask. Cancel
      // keeps the download: "Update ready — restart when you're done".
      beforeInstall: () => confirmQuit("update", { workingAcknowledged: true }),
      log: updateLog,
      notify: (version) => void notifyNative(version),
    });
  }
  return sharedFlow;
}

/** For the behavioural tests: a flow over a fake `check`. */
export function setUpdateFlowForTests(flow: UpdateFlow | null): void {
  sharedFlow = flow;
}

export function useUpdateState(): UpdateState {
  const flow = updateFlow();
  return useSyncExternalStore(flow.subscribe, flow.getState);
}

/** 1.176.4 (owner, 2026-11-23): how often the "Waiting: …" line reads the
 *  work again (the update sheet's counts follow the work as often). */
export const UPDATE_WAIT_EVERY_MS = 2000;

/** Why a scheduled update waits, and the way to the session that asks. */
export interface UpdateWait {
  /** `Waiting: 1 session asks you something.` (`updateWaitLine`). */
  line: string;
  /** The dot: the asks ink when a session waits for the person; grey when
   *  the only ones waiting are at their usage limit (nothing to answer). */
  tone: "warn" | "running" | "empty";
  /** The first session that asks (a card's Builder, then a tile, then one
   *  at its usage limit), opened the way the Inbox opens it; null when none
   *  waits. */
  open: { label: string; ariaLabel: string; onClick: () => void } | null;
}

/** The line's press: the waiting session read again now (the line may be
 *  up to 2 s old) and opened; with none left, nothing happens. */
function openWaitingNow(): void {
  workingNow(Date.now(), { unsure: builderScreensReadFailing() });
  const place = firstWaitingPlace();
  if (place) openWaitingSession(place);
}

/** What holds a scheduled update now, in the quit sheet's words — the same
 *  count (`workingNow`, a failed screen read counting each Builder no
 *  terminal shows as at work, as the idle look does) — or null. Only what is
 *  shown: when the update installs is `lookForIdle`'s. */
export function updateWaitNow(now = Date.now()): UpdateWait | null {
  const counts = workingNow(now, { unsure: builderScreensReadFailing() });
  const line = updateWaitLine(counts);
  if (!line) return null;
  const asking = (counts.waiting ?? 0) > 0;
  const place = asking ? firstWaitingPlace() : null;
  const label = place?.target.kind === "card" ? OPEN_THE_BUILDER : OPEN_SESSION;
  return {
    line,
    tone: asking && !place?.limit ? "warn" : workingTotal(counts) > 0 ? "running" : "empty",
    open: place ? { label, ariaLabel: `${label}: ${place.where}`, onClick: openWaitingNow } : null,
  };
}

/** The line while an update is scheduled, read again every 2 s while the
 *  window is on screen. */
export function useUpdateWait(): UpdateWait | null {
  const scheduled = useUpdateState().kind === "scheduled";
  const visible = usePageVisible();
  useTick(scheduled && visible, UPDATE_WAIT_EVERY_MS);
  return scheduled ? updateWaitNow() : null;
}

/** UX-3.8: the update as a quiet status row at the sidebar's foot — it used
 *  to be a banner floating over the window. Install opens the dialog. QoL
 *  1.168 G1: a scheduled update says it waits, and offers Install now;
 *  1.176.4: and why, on a row of its own under it. */
export function UpdateStatusRow() {
  const state = useUpdateState();
  const wait = useUpdateWait();
  const version =
    state.kind === "available" || state.kind === "scheduled" ? state.version : null;
  // Logged when it is really on screen, not when the state said so.
  useEffect(() => {
    if (version) updateLog.info(`updater: status row shown: ${version}`);
  }, [version]);
  if (!version) return null;
  if (state.kind === "scheduled") {
    return (
      <>
        <StatusRow
          tone="info"
          text={scheduledRowText(version)}
          action={{
            label: "Install now",
            onClick: () => updateFlow().installNow(),
            title: "Install the update now — asks first",
          }}
        />
        {wait && <StatusRow tone={wait.tone} text={wait.line} wrap action={wait.open ?? undefined} />}
      </>
    );
  }
  return (
    <StatusRow
      tone="info"
      text={`Plyloft ${version} is available`}
      action={{
        label: "Install",
        onClick: () => updateFlow().openFromBanner(),
        title: "Install the update and restart Plyloft — asks first",
      }}
    />
  );
}

/** QoL 1.168 G1 (Challenger round 1): what the idle check reads, now. Every
 *  live shell tile is asked whether a command runs in it (`npm run dev`, a
 *  build, ssh, a REPL); an answer Plyloft can't get counts as running. */
export async function idleFactsNow(lastInputAt: number, now = Date.now()): Promise<IdleFacts> {
  // 1.176.2 (review F1): the Builders no terminal shows, read now; unread,
  // each counts as at work and the update waits.
  const screensRead = await freshBuilderScreens();
  const tiles = Object.values(useTiles.getState().byWorkspace).flatMap((w) => w.tiles);
  const shells = tiles.filter(
    (t) =>
      t.kind === "shell" &&
      !t.pendingClose &&
      t.ptyId &&
      (t.status === "running" || t.status === "pending"),
  );
  const shellCommands = await Promise.all(
    shells.map((t) => ptyCommandRunning(t.ptyId!).catch(() => null)),
  );
  const drafts = tiles.filter(
    (t) =>
      !t.pendingClose &&
      (t.kind === "claude" || t.kind === "codex" || t.kind === "codex-chat") &&
      t.inputEmpty === false,
  ).length;
  const dirtyFiles = Object.values(useEditor.getState().byWorkspace)
    .flatMap((w) => w.openFiles)
    .filter((f) => isFileDirty(f)).length;
  const ui = useUi.getState();
  return {
    now,
    lastInputAt,
    dirtyFiles,
    // Challenger: a session waiting for an answer is not idle either — no
    // restart over a pending approval.
    working: busyForUpdate(workingNow(now, { unsure: !screensRead })),
    shellCommands,
    drafts,
    quitAsk: useQuitGuard.getState().ask !== null,
    modalOpen: typeof document !== "undefined" && visibleModalOpen(),
    settingsOpen: ui.settingsOverlayOpen,
    setupOpen: setupIsOpen(),
    paletteOpen: ui.palette.open,
    windowInFront:
      typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus(),
  };
}

/** One look of the watcher: the new count of idle looks in a row. Installs
 *  once `IDLE_LOOKS` looks in a row found nothing in the way. */
export async function lookForIdle(
  flow: UpdateFlow,
  lastInputAt: number,
  looks: number,
  now = Date.now(),
): Promise<number> {
  const blocker = idleBlocker(await idleFactsNow(lastInputAt, now));
  noteWhyWaiting(blocker);
  const next = nextIdleLooks(looks, blocker === null);
  if (installDue(next)) {
    updateLog.info("updater: nothing is working: installing the scheduled update");
    // 1.176.2 (F1 review round 3, M1): the same look once more, right
    // before the install (work may have started meanwhile).
    void flow.idleMoment(async () => {
      const again = idleBlocker(await idleFactsNow(lastInputAt));
      noteWhyWaiting(again);
      return again === null;
    });
    return 0;
  }
  return next;
}

/** 1.176.2 (F1 review round 3, S1): the log says why the scheduled update
 *  waits on a Builder no terminal shows — once per change, not every look. */
let whyWaitingLogged = "";
function noteWhyWaiting(blocker: ReturnType<typeof idleBlocker>): void {
  const why = blocker === "working" ? offScreenWorkingWhy() : "";
  if (why === whyWaitingLogged) return;
  whyWaitingLogged = why;
  if (why) updateLog.info(`updater: waiting (working): ${why}`);
}

export function UpdatePrompt() {
  const flow = updateFlow();
  const lastCheckRef = useRef(0);
  const visible = usePageVisible();
  const scheduled = useUpdateState().kind === "scheduled";

  function runCheck(reason: "launch" | "poll") {
    lastCheckRef.current = Date.now();
    void flow.runCheck(reason);
  }

  useEffect(() => {
    // n16: a test build doesn't poll the release feed at all.
    if (isTestBuild) return;
    runCheck("launch");
    const timer = window.setInterval(() => runCheck("poll"), POLL_EVERY_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isTestBuild || !visible) return;
    if (Date.now() - lastCheckRef.current < REFOCUS_MIN_GAP_MS) return;
    runCheck("poll");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // QoL 1.168 G1: while an update waits for the work to be done, look every
  // 15 s; two idle looks in a row install it (a session between two turns
  // reads idle for a moment).
  useEffect(() => {
    if (!scheduled) return;
    let lastInputAt = Date.now();
    let idleLooks = 0;
    let looking = false;
    const onInput = () => {
      lastInputAt = Date.now();
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      if (looking) return;
      looking = true;
      void lookForIdle(flow, lastInputAt, idleLooks)
        .then((n) => {
          idleLooks = n;
        })
        .catch(() => {
          idleLooks = 0;
        })
        .finally(() => {
          looking = false;
        });
    }, IDLE_POLL_MS);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onInput, { capture: true });
      window.clearInterval(timer);
    };
  }, [scheduled, flow]);

  return <UpdatePromptView />;
}

/** QoL 1.168 G1 (Challenger round 1): how long a quit waits for the update
 *  to be put in place before it goes ahead anyway. */
export const INSTALL_AT_QUIT_MS = 90 * 1000;

/** Install the scheduled update as Plyloft quits, but never hold the quit
 *  longer than `ms`: past it the quit goes ahead and the log says so (the
 *  current version stays; the next launch offers the update again). */
export async function installAtQuitWithin(
  flow: UpdateFlow = updateFlow(),
  ms = INSTALL_AT_QUIT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      updateLog.error(`updater: install at quit took over ${Math.round(ms / 1000)} s; quitting anyway`);
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([flow.installAtQuit(), late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Re-render every `ms` while `on`: the counts in the sheet follow the work. */
function useTick(on: boolean, ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setTick((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [on, ms]);
}

/** Every live session and terminal (the Windows close sheet's count). */
function useOpenCounts() {
  const tiles = useTiles((s) => s.byWorkspace);
  const builders = useBuilder((s) => s.byCard);
  const agents = useAgents((s) => s.byWorkspace);
  const boards = useKanban((s) => s.byWorkspace);
  const swarms = useSwarms((s) => s.byWorkspace);
  const verifyJobs = useVerify((s) => s.inflight.length);
  const shipping = useShip((s) => s.shipping);
  return runningCounts({
    tiles: Object.values(tiles).flatMap((w) => w.tiles),
    builderSessions: Object.keys(builders).length,
    runStatuses: Object.values(agents).flatMap((w) => w.runs.map((r) => r.status)),
    reviewStatuses: Object.values(boards).flatMap((w) =>
      w.cards.map((c) => c.builder?.review?.status ?? ""),
    ),
    swarmStatuses: Object.values(swarms).flatMap((w) => w.swarms.map((sw) => sw.status)),
    verifyJobs,
    shipping,
  });
}

/** The install dialog for every state past "available" (the checks are
 *  UpdatePrompt's). */
export function UpdatePromptView() {
  const flow = updateFlow();
  const state = useUpdateState();
  const open = useOpenCounts();
  useTick(state.kind === "confirming" || state.kind === "ready", 2000);

  // UX-3.8: "available" is the sidebar's status row (UpdateStatusRow); a
  // scheduled update is a row too.
  if (state.kind === "idle" || state.kind === "available" || state.kind === "scheduled") return null;
  return (
    <UpdateDialog
      state={state}
      body={
        state.kind === "confirming" ? updateConfirmBody(workingNow(), open) : null
      }
      onConfirm={() =>
        // QoL 1.168 S1-2: the quit sheet first, when something would be lost
        // (a ready update asks in `beforeInstall`).
        state.kind === "ready"
          ? void flow.confirmInstall()
          : void confirmQuit("update").then((ok) => (ok ? flow.confirmInstall() : undefined))
      }
      onWhenDone={() => flow.installWhenIdle()}
      onRetry={() => void flow.retry()}
      onLater={() => flow.later()}
    />
  );
}

type DialogState = Exclude<
  UpdateState,
  { kind: "idle" } | { kind: "available" } | { kind: "scheduled" }
>;

function statusLine(state: DialogState): string | null {
  switch (state.kind) {
    case "looking":
    case "checking":
      return "Checking for the latest version…";
    case "downloading":
      return formatDownloadStatus(state.downloaded, state.total);
    case "installing":
      return "Installing…";
    case "relaunching":
      return "Restarting…";
    case "upToDate":
      return "Plyloft is up to date.";
    default:
      return null;
  }
}

function UpdateDialog({
  state,
  body: confirmBody,
  onConfirm,
  onWhenDone,
  onRetry,
  onLater,
}: {
  state: DialogState;
  body: string | null;
  onConfirm: () => void;
  onWhenDone: () => void;
  onRetry: () => void;
  onLater: () => void;
}) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const choosing = state.kind === "confirming" || state.kind === "failed" || state.kind === "ready";

  useEffect(() => {
    updateLog.info("updater: modal mounted");
  }, []);

  // The buttons unmount while busy; give Try again focus when it comes back.
  useEffect(() => {
    if (state.kind === "failed") primaryRef.current?.focus({ preventScroll: true });
  }, [state.kind]);

  let title: string;
  let body: string | null = null;
  if (state.kind === "upToDate") {
    title = "No update to install";
  } else if (state.kind === "installing" && state.atQuit) {
    title = "Installing the update…";
    body = `Plyloft quits when ${state.version} is in place.`;
  } else if (state.kind === "looking") {
    title = "Check for updates";
  } else if (state.kind === "ready") {
    // QoL 1.168 review: the install was held in the quit sheet — calm, no
    // failure and no new download.
    title = "Update ready — restart when you're done";
    body = `Plyloft didn't restart, so nothing was lost. ${state.version} is downloaded. Restart now installs it; quitting keeps the current version.`;
  } else if (state.kind === "failed") {
    title = state.version === null ? "Couldn't check for updates" : "Plyloft wasn't updated";
  } else {
    title = `Update available: ${state.version}`;
    if (state.kind === "confirming") body = confirmBody;
  }
  const status = statusLine(state);
  const offersWhenDone = state.kind === "confirming" || state.kind === "ready";
  const error = state.kind === "failed" ? updateFailedError(state) : null;
  const onErrorAction = (id: string) => {
    if (id === "retry") onRetry();
    else if (id === "download")
      void openWebLink(DOWNLOAD_URL).catch((e: unknown) =>
        pushToast(linkDidNotOpen(DOWNLOAD_URL, e)),
      );
  };

  return (
    <Sheet
      title={title}
      size="confirm"
      onClose={onLater}
      canDismiss={choosing}
      initialFocusRef={primaryRef}
      actions={
        state.kind === "failed" ? (
          <CBtn ref={primaryRef} onClick={onLater}>
            Close
          </CBtn>
        ) : choosing ? (
          <>
            <CBtn tone="ghost" onClick={onLater}>Later</CBtn>
            {offersWhenDone && <CBtn onClick={onWhenDone}>{WHEN_DONE_LABEL}</CBtn>}
            <CBtn ref={primaryRef} tone="accent" onClick={onConfirm}>
              {state.kind === "ready" ? "Restart now" : "Install and restart"}
            </CBtn>
          </>
        ) : undefined
      }
    >
      {body && <p className="ux-sheet-text">{body}</p>}
      {error && (
        <div role="alert">
          <ErrorBlock error={error} onAction={onErrorAction} />
        </div>
      )}
      {offersWhenDone && <p className="ux-sheet-hint">{whenDoneHint(isMac())}</p>}
      {status && (
        <p className="ux-sheet-hint" aria-live="polite">
          {status}
        </p>
      )}
    </Sheet>
  );
}
