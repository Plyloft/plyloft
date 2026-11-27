import { useCallback, useEffect, useRef, useState } from "react";
import { projectShareable } from "../lib/uxScope";
import {
  kanbanGithubPushLocal,
  onWorkspaceDefinitionEdited,
  onWorkspaceDefinitionRefreshed,
  workspaceAdoptionBoardChoice,
  workspaceAdoptionDecline,
  workspaceAdoptionSetupElsewhere,
  workspaceAdoptionShare,
  workspaceAdoptionStatus,
  workspaceDefinitionGet,
  workspaceDefinitionOpenPullRequest,
  workspaceDefinitionPublish,
  workspaceSetKanbanSyncMode,
} from "../ipc";
import {
  adoptionBanner,
  createdIssuesToast,
  ELSEWHERE_USE,
  creatingIssuesToast,
  LatestOnly,
  InFlight,
  migrationToastNeeded,
  OncePerSession,
  recordStatus,
  statusFor,
  type AdoptionStatus,
  type StatusBook,
} from "../lib/adoption";
import { useKanban } from "../store/kanbanStore";
import { useTeamAllowed } from "../store/accountStore";
import { pushToast, useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { machineWords } from "../lib/platform";
import { confirmSheet } from "../store/confirmStore";
import {
  KEEP_FAILED,
  KEEP_ON_THIS_MAC,
  KEPT_LOCAL_TOAST,
  OPEN_PULL_REQUEST,
  PROPOSE_AGAIN,
  SHARE_AGAIN,
  STOP_FAILED,
  shareAgainSheet,
  sharingToasts,
  stopOutcomeToast,
  stopSharingSheet,
  type SharedSetup,
} from "../lib/sharedSetup";
import {
  workspaceConversionNoticeSeen,
  workspaceMoveSharedSetup,
  workspaceKeepSetupLocal,
  workspaceProposeConversionAgain,
  workspaceStopSharing,
} from "../lib/sharedSetupIpc";
import { WORK_WITH_A_TEAM } from "../lib/settingsNav";
import { useUi } from "../store/uiStore";
import { CBtn } from "./ux";
import { adoptionKind, adoptionSummary, type BoardNoteView } from "../lib/boardNotices";
import { sharesAreasLine } from "../lib/areasPage";
import { definitionReadKey, pageReadFoundNothing } from "../lib/definitionRefresh";
import { useDefinitionReads } from "../store/definitionReadStore";
import { useAreasView } from "../store/areaStore";
import { useSolo } from "../store/workModeStore";
import {
  SHARE_AGAIN_STILL_RUNNING,
  STOP_SHARING_STILL_RUNNING,
  pressOnce,
  sayStillRunning,
  shareAgainPressKey,
  stopSharingPressKey,
} from "../lib/pressOnce";
import { pushErrorToast } from "../lib/errorToast";

/** GH #81: the adoption status of a workspace, re-read whenever its
 *  definition is refreshed or edited, and when the licence changes. The
 *  status is kept with the workspace it was read for and only the newest
 *  request's answer lands, so a component reused for another workspace never
 *  returns the previous one's status. */
export function useAdoptionStatus(workspaceId: string | null, solo = false) {
  const [book, setBook] = useState<StatusBook>({});
  // C10 round 1: a read that failed has landed too (nothing more will come
  // until the next reload), so a caller waiting on it stops waiting.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // Two-account walk: a read just changed something, so the status on screen
  // may be out of date until this one lands. Per workspace. Other reloads (an
  // edit, a publish, a read that changed nothing) hold nothing.
  const [changing, setChanging] = useState<Readonly<Record<string, true>>>({});
  const latest = useRef(new LatestOnly());
  const licensed = useTeamAllowed();
  // Two-account walks: what the last status that landed was read after. A failed
  // one doesn't count, so the next read tries again (`pageReadFoundNothing`).
  const lastRead = useRef<Record<string, string>>({});

  const read = useCallback((afterChange: boolean, key?: string) => {
    if (!workspaceId) return;
    const ticket = latest.current.begin(workspaceId);
    const landed = () =>
      setChanging((prev) => {
        if (!prev[workspaceId]) return prev;
        const { [workspaceId]: _done, ...rest } = prev;
        return rest;
      });
    if (afterChange) setChanging((prev) => ({ ...prev, [workspaceId]: true }));
    workspaceAdoptionStatus(workspaceId, solo)
      .then((status) => {
        // C1 round 2: this very read kept a removed setup for a member who
        // can't push — the backend says so once, whichever hook asked.
        for (const toast of sharingToasts({ sharing: status.sharingNote })) pushToast(toast);
        if (latest.current.isLatest(workspaceId, ticket)) {
          setBook((prev) => recordStatus(prev, workspaceId, status));
          if (key !== undefined) lastRead.current[workspaceId] = key;
          landed();
        }
      })
      .catch((e) => {
        console.warn("adoption status failed:", e);
        if (latest.current.isLatest(workspaceId, ticket)) {
          setFailedFor(workspaceId);
          delete lastRead.current[workspaceId];
          landed();
        }
      });
  }, [workspaceId, solo]);
  const reload = useCallback(() => read(false), [read]);

  useEffect(() => {
    reload();
  }, [reload, licensed]);

  useEffect(() => {
    if (!workspaceId) return;
    const refreshed = onWorkspaceDefinitionRefreshed((report) => {
      if (report.workspaceId !== workspaceId) return;
      if (pageReadFoundNothing(report, lastRead.current[workspaceId])) return;
      read(report.moment !== "publish" && (report.changes?.length ?? 0) > 0, definitionReadKey(report));
    });
    const edited = onWorkspaceDefinitionEdited((id) => {
      if (id === workspaceId) reload();
    });
    return () => {
      void refreshed.then((off) => off());
      void edited.then((off) => off());
    };
  }, [workspaceId, reload, read]);

  // A press asked: exempt from the skip above.
  const asked = useDefinitionReads((s) => (workspaceId ? (s.statusAsked[workspaceId] ?? 0) : 0));
  const askedSeen = useRef(asked);
  useEffect(() => {
    if (asked === askedSeen.current) return;
    askedSeen.current = asked;
    if (asked > 0) reload();
  }, [asked, reload]);

  const status = statusFor(book, workspaceId);
  return {
    status,
    reload,
    settled: !!workspaceId && (status != null || failedFor === workspaceId),
    /** A read changed something and the status it brings hasn't landed. */
    changing: !!workspaceId && !!changing[workspaceId],
  };
}

/** 1.174.0 (C10, D6): whether this workspace's setup can be shared from
 *  here — not shared yet, not solo, a GitHub repository, and the notice
 *  above the Board not waiting for another answer (E6's rule). Reads the
 *  adoption status only while nothing is shared. */
export function useSetupShareable(workspaceId: string, notShared: boolean) {
  const solo = useSolo();
  const { status, reload, settled } = useAdoptionStatus(notShared ? workspaceId : null, solo);
  // Round 1: until the status lands, whether Share is offered isn't known;
  // callers hold the words that depend on it rather than say the wrong one.
  const loading = notShared && !settled;
  // One rule with every project mark (`projectShareable`); here a status
  // not read yet offers no Share.
  const shareable = notShared && status != null && projectShareable(status, solo);
  return { shareable, status, reload, loading };
}

/** The legacy conversion runs once per session: a failed publish stays in
 *  the queue, which every refresh drains. */
const automatic = new OncePerSession();
/** Migrations and board switches: one at a time per workspace, and again in
 *  a later adoption cycle. */
const running = new InFlight();
/** Workspaces whose migration failed outright (not a card that stayed
 *  pending): not retried on their own — Share, a switch or a licence change
 *  tries again — so a persistent error can't loop on every refresh. */
const migrationFailures = new Set<string>();

/** Why a workspace's automatic board switch failed, kept for the session
 *  like its guard: the banner unmounts when the board isn't shown, and the
 *  Retry must be there when it comes back. */
const switchFailures = new Map<string, string>();

/** Local cards → issues, with a progress toast, then a pull. One at a time
 *  per workspace, whichever path asks (Share, a board switch, a board
 *  received from another Mac); the backend migrates only cards that still
 *  have no issue. A card whose create fails stays `sync_pending`, and Sync
 *  retries it. */
async function migrateLocalCards(
  workspaceId: string,
  count: number,
  repo: string | null,
) {
  const key = `${workspaceId}:migrate`;
  if (count > 0 && running.start(key)) {
    const progress = pushToast(creatingIssuesToast(count));
    try {
      const summary = await kanbanGithubPushLocal(workspaceId);
      migrationFailures.delete(workspaceId);
      if (migrationToastNeeded(summary)) {
        pushToast(createdIssuesToast(repo, summary));
      }
    } catch (e) {
      migrationFailures.add(workspaceId);
      throw e;
    } finally {
      useToasts.getState().dismiss(progress);
      running.finish(key);
    }
  }
  await useKanban.getState().reconcileGithub(workspaceId);
}

/** OB-8 review 2: Settings › Board's "Move to GitHub Issues" after the offer
 *  was answered "Keep it on this Mac", or (R14) for a board the repository's
 *  definition says is Local, after its confirm — one press: the answer
 *  becomes "move", then the board switches (unless only cards wait; the
 *  switch is this Mac's edit, published as one config change) and the local
 *  cards become issues. */
export async function moveKeptBoard(
  workspaceId: string,
  repo: string,
  cardsOnly: boolean,
  localCards: number,
) {
  await workspaceAdoptionBoardChoice(workspaceId, true);
  const key = `${workspaceId}:switch`;
  if (!running.start(key)) return;
  try {
    let count = localCards;
    if (!cardsOnly) {
      count = await workspaceSetKanbanSyncMode(workspaceId, "githubIssues", repo);
      switchFailures.delete(workspaceId);
      await useWorkspaces.getState().refresh();
    }
    await migrateLocalCards(workspaceId, count, repo);
  } finally {
    running.finish(key);
  }
}

/** The banner's *Share*: the one share call and its toasts, also pressed
 *  from Next improvement's direction editor (1.173.0 E5). True when it
 *  shared (or someone had meanwhile). */
export async function shareWorkspaceSetup(
  workspaceId: string,
  status: Pick<AdoptionStatus, "boardRepo" | "githubRepo"> | null,
): Promise<boolean> {
  try {
    const outcome = await workspaceAdoptionShare(workspaceId);
    await useWorkspaces.getState().refresh();
    if (outcome.alreadyShared) {
      pushToast({
        kind: "info",
        title: "Already shared",
        body: "Someone shared this repository meanwhile; Plyloft uses its setup.",
      });
    }
    // Shared now or by someone else meanwhile: a GitHub Issues board takes
    // this Mac's local cards either way.
    if (outcome.board === "githubIssues") {
      await migrateLocalCards(workspaceId, outcome.localCards, status?.boardRepo ?? status?.githubRepo ?? null);
    }
    return true;
  } catch (e) {
    pushErrorToast("Couldn't share this workspace", e);
    return false;
  }
}

// ── 1.175.0 (C1, SC-2): Stop sharing, and a removed shared setup ──────
// Pressed from the Board's notice and from Settings › Project › General's
// "Shared setup" row: one set of calls, sheets and toasts.

/** Open a pull request of the workspace's repository in the browser. */
export function openSetupPullRequest(workspaceId: string, number: number) {
  void workspaceDefinitionOpenPullRequest(workspaceId, number).catch((e) =>
    pushToast({
      kind: "warn",
      title: `Couldn't open pull request #${number}`,
      details: String(e),
    }),
  );
}

/** *Stop sharing…*: the consent sheet (focus on "Keep sharing"), then the
 *  removal. True when something was done — the file removed, or its pull
 *  request opened. */
export async function stopSharingSetup(
  workspaceId: string,
  setup: Extract<SharedSetup, { state: "shared" }>,
  /** WALKFIX-1: called once the sheet said yes (the row's "Stopping…"). */
  started?: () => void,
): Promise<boolean> {
  // 1.176.2 F2: one Stop sharing at a time — a second press while the
  // question or the removal is on its way does nothing.
  return (
    (await pressOnce(
      stopSharingPressKey(workspaceId),
      () => stopSharingNow(workspaceId, setup, started),
      sayStillRunning(STOP_SHARING_STILL_RUNNING),
    )) ?? false
  );
}

async function stopSharingNow(
  workspaceId: string,
  setup: Extract<SharedSetup, { state: "shared" }>,
  started?: () => void,
): Promise<boolean> {
  const yes = await confirmSheet(stopSharingSheet(setup.branch, setup.pending));
  if (!yes) return false;
  started?.();
  let outcome;
  try {
    outcome = await workspaceStopSharing(workspaceId);
  } catch (e) {
    pushToast({ kind: "error", ...STOP_FAILED, details: String((e as Error)?.message ?? e) });
    return false;
  }
  const { pullRequest, ...toast } = stopOutcomeToast(outcome);
  pushToast(
    pullRequest != null
      ? { ...toast, action: { label: OPEN_PULL_REQUEST, onClick: () => openSetupPullRequest(workspaceId, pullRequest) } }
      : toast,
  );
  // The removal happened whatever this re-read does: its failure is not
  // "Couldn't stop sharing".
  await useWorkspaces.getState().refresh().catch(() => {});
  return true;
}

/** "Keep it on this Mac" on a removed shared setup: recorded here, nothing
 *  written to GitHub. */
export async function keepSetupLocal(workspaceId: string): Promise<boolean> {
  try {
    await workspaceKeepSetupLocal(workspaceId);
    pushToast(KEPT_LOCAL_TOAST);
    return true;
  } catch (e) {
    pushToast({ kind: "error", ...KEEP_FAILED, details: String((e as Error)?.message ?? e) });
    return false;
  }
}

/** "Share it again…": a short sheet (focus on "Not now"), then the Share
 *  the Board's question runs, with its toasts. */
export async function shareSetupAgain(
  workspaceId: string,
  status: Pick<AdoptionStatus, "boardRepo" | "githubRepo" | "sharedSetup"> | null,
  started?: () => void,
): Promise<boolean> {
  // 1.176.2 F2 (review F3): one Share it again at a time, as Stop sharing.
  return (
    (await pressOnce(
      shareAgainPressKey(workspaceId),
      () => shareAgainNow(workspaceId, status, started),
      sayStillRunning(SHARE_AGAIN_STILL_RUNNING),
    )) ?? false
  );
}

async function shareAgainNow(
  workspaceId: string,
  status: Pick<AdoptionStatus, "boardRepo" | "githubRepo" | "sharedSetup"> | null,
  started?: () => void,
): Promise<boolean> {
  const yes = await confirmSheet(
    shareAgainSheet(status?.sharedSetup, status?.githubRepo ?? null, Date.now() / 1000),
  );
  if (!yes) return false;
  started?.();
  return shareWorkspaceSetup(workspaceId, status);
}

// ── 1.175.0 (C5, SC-5): the shared setup's branch is gone from GitHub ──

/** "Move to {new}": the setup goes to the branch GitHub renamed it to. What
 *  the publish did is said by the read that follows, as for any edit. */
export async function moveSharedSetup(workspaceId: string, to: string): Promise<boolean> {
  try {
    await workspaceMoveSharedSetup(workspaceId, to);
    return true;
  } catch (e) {
    pushToast({
      kind: "warn",
      title: "Couldn't move the shared setup",
      body: "Nothing changed on GitHub. Details has the reason.",
      details: String((e as Error)?.message ?? e),
    });
    return false;
  }
}

/** "Choose where cards go": Settings › Shipping, at its row. */
export function chooseWhereCardsGo(workspaceId: string) {
  useUi.getState().openSettingsSection("shipping", { workspaceId });
}

// ── 1.175.0 (C2, SC-1): a declined conversion of the older file ───────

/** "Propose it again": the conversion, on a press. What it did is said by
 *  the refresh that follows (the pull request it waits in, as always). */
export async function proposeConversionAgain(workspaceId: string): Promise<boolean> {
  try {
    await workspaceProposeConversionAgain(workspaceId);
    return true;
  } catch (e) {
    pushToast({
      kind: "warn",
      title: "Couldn't publish .atelier/workspace.json",
      details: String((e as Error)?.message ?? e),
    });
    return false;
  }
}

/** The workspaces whose "stays in its older file" notice was on screen in
 *  this session: recorded once each. */
const declinedSeen = new Set<string>();

/** Drawn inside the declined-conversion notice: once it is really on screen
 *  (the Board's one slot shows it), it is recorded as seen, so the next read
 *  doesn't bring it back (owner, C2-a). It stays up until that read. */
function DeclinedSeen({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    // Round 5: mounted is not seen — the window may be hidden (closing it
    // hides it, and the Board keeps drawing). Recorded only while the page
    // is visible, or when it becomes visible with the notice still up.
    const record = () => {
      if (document.visibilityState !== "visible" || declinedSeen.has(workspaceId)) return;
      declinedSeen.add(workspaceId);
      void workspaceConversionNoticeSeen(workspaceId).catch(() => declinedSeen.delete(workspaceId));
    };
    record();
    document.addEventListener("visibilitychange", record);
    return () => document.removeEventListener("visibilitychange", record);
  }, [workspaceId]);
  return null;
}

/** GH #81: the one question on the board ("Share this workspace's setup…"),
 *  or why the board stays local; and, without a banner, the steps a team
 *  workspace takes on the owner's Mac — publishing a converted
 *  `workspace_default.json`, switching a Local board here to the GitHub
 *  Issues board the repository's definition already names (nothing to
 *  publish) with its local cards migrated. A definition that says Local puts
 *  up no banner and is never switched (R14, 1.169.1). */
export function AdoptionBanner({
  workspaceId,
  solo = false,
}: {
  workspaceId: string;
  /** OB-9: solo mode — only the X2 notice (a shared setup on another
   *  branch); no sharing question, board offer or automatic step. */
  solo?: boolean;
}) {
  return <>{useAdoptionNotice(workspaceId, solo)?.body ?? null}</>;
}

/**
 * 1.174.0 (A4): the banner as a note for the Board's one slot
 * (BoardNotices) — its automatic steps run whether or not the note is the
 * one shown. A failed board switch is broken; the rest is a setup to decide.
 * Every button bordered: the Board's one filled button is New card
 * (mockups/board.html §1, §8).
 */
export function useAdoptionNotice(workspaceId: string, solo = false): BoardNoteView | null {
  const { status, reload } = useAdoptionStatus(workspaceId, solo);
  const licensed = useTeamAllowed();
  const refreshWorkspaces = useWorkspaces((s) => s.refresh);
  const [busy, setBusy] = useState(false);
  // X2: which answer is running, so only the "Use …" pressed says so — B1:
  // `use:<branch>` for one of several.
  const [pressed, setPressed] = useState<string | null>(null);
  // Why this workspace's automatic board switch failed (`switchFailures`);
  // the counter re-renders when it changes.
  const [, setFailureVersion] = useState(0);
  const switchError = switchFailures.get(workspaceId) ?? null;

  // A licence gained or lost: failed automatic steps may succeed now.
  const lastLicensed = useRef(licensed);
  useEffect(() => {
    if (lastLicensed.current === licensed) return;
    lastLicensed.current = licensed;
    migrationFailures.delete(workspaceId);
    switchFailures.delete(workspaceId);
    setFailureVersion((v) => v + 1);
  }, [licensed, workspaceId]);

  const runSwitch = useCallback(
    async (repo: string) => {
      const key = `${workspaceId}:switch`;
      if (!running.start(key)) return;
      try {
        const count = await workspaceSetKanbanSyncMode(
          workspaceId,
          "githubIssues",
          repo,
        );
        switchFailures.delete(workspaceId);
        setFailureVersion((v) => v + 1);
        await refreshWorkspaces();
        await migrateLocalCards(workspaceId, count, repo);
      } catch (e) {
        switchFailures.set(workspaceId, String((e as Error)?.message ?? e));
        setFailureVersion((v) => v + 1);
      } finally {
        running.finish(key);
        reload();
      }
    },
    [workspaceId, refreshWorkspaces, reload],
  );

  useEffect(() => {
    // `status` is this workspace's (useAdoptionStatus), never another's.
    if (!status || solo) return;
    const action = status.action;
    if (
      action.kind === "migrateCards" &&
      status.boardRepo &&
      !migrationFailures.has(workspaceId) &&
      !running.has(`${workspaceId}:migrate`)
    ) {
      migrateLocalCards(workspaceId, action.localCards, status.boardRepo)
        .catch((e) =>
          pushToast({
            kind: "warn",
            title: "Couldn't turn this Mac's cards into issues",
            details: String((e as Error)?.message ?? e),
          }),
        )
        .finally(reload);
    }
    if (
      action.kind === "convertLegacy" &&
      automatic.claim(`${workspaceId}:convert`)
    ) {
      workspaceDefinitionPublish(workspaceId)
        .catch((e) =>
          pushToast({
            kind: "warn",
            title: "Couldn't publish .atelier/workspace.json",
            details: String((e as Error)?.message ?? e),
          }),
        )
        .finally(reload);
    }
    if (
      action.kind === "switchBoard" &&
      status.boardRepo &&
      !switchFailures.has(workspaceId)
    ) {
      void runSwitch(status.boardRepo);
    }
  }, [status, workspaceId, runSwitch, reload, solo]);

  // T1: an offer to move the board reads as joining when the repository's
  // own definition already says GitHub Issues — this Mac is the one behind.
  // Solo shows no offer, so it reads nothing for one.
  const offersBoard = !solo && status?.action.kind === "offerBoard" && !status.action.cardsOnly;
  const [repoBoard, setRepoBoard] = useState<{
    workspaceId: string;
    board: "local" | "githubIssues" | null;
  } | null>(null);
  useEffect(() => {
    if (!offersBoard) return;
    let live = true;
    workspaceDefinitionGet(workspaceId)
      .then((view) => {
        if (live) setRepoBoard({ workspaceId, board: view?.cache.definition?.board ?? null });
      })
      .catch(() => {
        // Without the definition the offer keeps its general words.
      });
    return () => {
      live = false;
    };
  }, [offersBoard, workspaceId]);

  const asked = adoptionBanner(
    status,
    licensed,
    switchError,
    repoBoard?.workspaceId === workspaceId ? repoBoard.board : null,
  );
  // 1.174.0 (C10, D6 §4a): the areas kept on this Mac go with the Share.
  const areasLine = sharesAreasLine(useAreasView(workspaceId));
  const view = asked && asked.kind === "question" && areasLine ? { ...asked, body: `${asked.body} ${areasLine}` } : asked;
  // B1: solo mode also says why a GitHub Issues board stays local (`team`).
  if (!view || (solo && view.kind !== "elsewhere" && !view.team)) return null;
  const note = { id: "adoption", kind: adoptionKind(view.kind), summary: adoptionSummary(view) };

  async function share() {
    setBusy(true);
    try {
      await shareWorkspaceSetup(workspaceId, status);
    } finally {
      setBusy(false);
      reload();
    }
  }

  /** OB-8: the offer's answer. "Move" records it and re-reads: the status is
   *  then the switch to the repository's GitHub Issues board (or the
   *  migration), which runs as it always has. "Keep it" records it, and the
   *  offer is not made again. A board the repository's definition says is
   *  Local is never offered here (R14); Settings › Board moves it. */
  async function answerOffer(moved: boolean) {
    setBusy(true);
    try {
      await workspaceAdoptionBoardChoice(workspaceId, moved);
    } catch (e) {
      pushErrorToast(moved ? "Couldn't move the board" : "Couldn't remember that", e);
    } finally {
      setBusy(false);
      reload();
    }
  }

  /** X2: "Use the shared setup" adopts the setup found on the other branch
   *  (the refresh renames the workspace, so the list is re-read); "Keep this
   *  folder's setup" is remembered and not asked again. D6 Challenger: both
   *  bordered — the Board's one filled button is New card. */
  async function answerElsewhere(useIt: boolean, branch: string | null = null) {
    setBusy(true);
    setPressed(useIt ? `use:${branch ?? ""}` : "keep");
    try {
      await workspaceAdoptionSetupElsewhere(workspaceId, useIt, branch);
      if (useIt) await refreshWorkspaces();
    } catch (e) {
      pushErrorToast(useIt ? "Couldn't use that setup" : "Couldn't remember that", e);
    } finally {
      setBusy(false);
      setPressed(null);
      reload();
    }
  }

  /** C1: the removed-setup notice's two answers. */
  async function answerRemoved(again: boolean) {
    setBusy(true);
    setPressed(again ? "again" : "keep");
    try {
      if (again) await shareSetupAgain(workspaceId, status);
      else await keepSetupLocal(workspaceId);
    } finally {
      setBusy(false);
      setPressed(null);
      reload();
    }
  }

  /** C5: the gone branch's one action. */
  async function moveOrChoose(to: string | undefined) {
    if (!to) {
      chooseWhereCardsGo(workspaceId);
      return;
    }
    setBusy(true);
    try {
      await moveSharedSetup(workspaceId, to);
    } finally {
      setBusy(false);
      reload();
    }
  }

  /** C2: the declined conversion's one action. */
  async function proposeAgain() {
    setBusy(true);
    try {
      await proposeConversionAgain(workspaceId);
    } finally {
      setBusy(false);
      reload();
    }
  }

  async function decline() {
    setBusy(true);
    try {
      await workspaceAdoptionDecline(workspaceId);
    } catch (e) {
      pushErrorToast("Couldn't remember that", e);
    } finally {
      setBusy(false);
      reload();
    }
  }

  return {
    ...note,
    body: (
    <div
      className={`adoption-banner adoption-banner--${view.kind}`}
      role={
        view.kind === "question" ||
        view.kind === "offer" ||
        view.kind === "elsewhere" ||
        view.kind === "removed" ||
        view.kind === "declined" ||
        view.kind === "branchGone"
          ? "region"
          : "status"
      }
      aria-label={machineWords(view.title)}
    >
      <div className="adoption-banner-text">
        <strong>{machineWords(view.title)}</strong>
        <span>{machineWords(view.body)}</span>
      </div>
      {view.kind === "retry" && status?.boardRepo && (
        <div className="adoption-banner-actions">
          <CBtn
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void runSwitch(status.boardRepo!).finally(() => setBusy(false));
            }}
          >
            {busy ? "Switching…" : "Retry"}
          </CBtn>
        </div>
      )}
      {view.kind === "offer" && (
        <div className="adoption-banner-actions">
          {/* A4 (scene 8): keep first, then the move — both bordered. */}
          <CBtn disabled={busy} onClick={() => void answerOffer(false)}>
            {machineWords(view.keep ?? "Keep it on this Mac")}
          </CBtn>
          <CBtn disabled={busy} onClick={() => void answerOffer(true)}>
            {busy ? "Moving…" : view.move}
          </CBtn>
        </div>
      )}
      {view.kind === "elsewhere" && (
        <div className="adoption-banner-actions">
          <CBtn disabled={busy} onClick={() => void answerElsewhere(false)}>
            {view.keep ? machineWords(view.keep) : view.keep}
          </CBtn>
          {(view.uses ?? [{ label: view.move ?? ELSEWHERE_USE }]).map((use) => (
            <CBtn
              key={use.branch ?? ""}
              disabled={busy}
              onClick={() => void answerElsewhere(true, use.branch ?? null)}
            >
              {pressed === `use:${use.branch ?? ""}` ? "Setting up…" : use.label}
            </CBtn>
          ))}
        </div>
      )}
      {view.kind === "branchGone" && view.move && (
        <div className="adoption-banner-actions">
          <CBtn disabled={busy} onClick={() => void moveOrChoose(view.moveTo)}>
            {busy ? "Moving…" : view.move}
          </CBtn>
        </div>
      )}
      {view.kind === "declined" && (
        <div className="adoption-banner-actions">
          <DeclinedSeen workspaceId={workspaceId} />
          <CBtn disabled={busy} onClick={() => void proposeAgain()}>
            {busy ? "Proposing…" : (view.move ?? PROPOSE_AGAIN)}
          </CBtn>
        </div>
      )}
      {view.kind === "removed" && (
        <div className="adoption-banner-actions">
          {/* C1 (scene 1.6): keep first, then the way back — both bordered. */}
          <CBtn disabled={busy} onClick={() => void answerRemoved(false)}>
            {machineWords(view.keep ?? KEEP_ON_THIS_MAC)}
          </CBtn>
          <CBtn disabled={busy} onClick={() => void answerRemoved(true)}>
            {pressed === "again" ? "Sharing…" : (view.move ?? SHARE_AGAIN)}
          </CBtn>
        </div>
      )}
      {view.kind === "held" && view.team && (
        <div className="adoption-banner-actions">
          <CBtn onClick={() => useUi.getState().openSettingsSection("setup", { row: WORK_WITH_A_TEAM })}>
            {view.team}
          </CBtn>
        </div>
      )}
      {view.kind === "question" && (
        <div className="adoption-banner-actions">
          <CBtn disabled={busy} onClick={() => void share()}>
            {busy ? "Sharing…" : "Share"}
          </CBtn>
          <CBtn disabled={busy} onClick={() => void decline()}>
            {machineWords("Not on this Mac")}
          </CBtn>
        </div>
      )}
    </div>
    ),
  };
}
