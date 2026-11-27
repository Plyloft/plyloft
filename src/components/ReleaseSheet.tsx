import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  PENDING_RELEASE_CHANGED,
  deployMapGet,
  projectConfigGet,
  releaseScope,
  releaseScopes,
  releaseStop,
  releaseTheArea,
  onReleasePrReleased,
  shipAudit,
  type DeployWorkflow,
  type KanbanCard,
  type ReleaseKind,
  type ReleaseScope,
  type ShipAuditReport,
  type ShipResult,
} from "../ipc";
import {
  ANOTHER_RUNNING,
  ANOTHER_VERSION,
  RELEASE_WITHOUT_CHECKS,
  STOP_THE_RELEASE,
  STOP_WORK_AND_RELEASE,
  WHATS_IN_IT,
  WHICH_AREA_LEDE,
  WHICH_AREA_TITLE,
  KEEP_IT_GOING,
  progressLede,
  stopAsks,
  stopConfirmWords,
  alsoReadyHeading,
  OPEN_AREAS,
  areaChoiceWords,
  areaRefusalFix,
  behindLine,
  decodeStopped,
  divergedLine,
  footWords,
  initialTicks,
  kindHint,
  nothingNewWords,
  onItsWayWords,
  onlyAreaWithSomething,
  otherChangeHint,
  pressSummary,
  readyCardHint,
  releaseLede,
  scopeCardHint,
  scopeNews,
  stoppedWords,
  tagOf,
  takenTag,
  takenWords,
  technicalLines,
  throughPr,
  versionHint,
  versionSourceLine,
  whatsInCount,
  whatsInFold,
  withoutChecksLine,
} from "../lib/releaseSheet";
import { releaseLabel } from "../lib/projectRelease";
import { checksDetail, checksFor } from "../lib/goLive";
import { RELEASE_KIND_LABEL, RELEASE_KIND_ORDER, chosenReleaseKind } from "../lib/shippingPage";
import { releaseOffered } from "../lib/boardSemantics";
import { cardAreaOf, pickerAreas } from "../lib/areaPicker";
import { releasePrStateLabel } from "../lib/uxError";
import { shipDoneWords } from "../lib/shipDone";
import { installHeldAfter, useChecksConsent } from "../store/checksConsentStore";
import { shipBatchFailure } from "../lib/plainError";
import { machineWords } from "../lib/platform";
import { SET_UP_LABEL, needsSetUp } from "../lib/projectSetup";
import { SHOW_THEM, TARGET_DIRTY_TITLE, decodeTargetDirtyError, type TargetDirtyState } from "../lib/shipPreflight";
import { builderMayCommit, commitStop } from "../lib/checksFix";
import { rawError, releaseConflict } from "../lib/cardPage";
import { ASK_BUILDER_LABEL } from "../lib/shipConflict";
import { useBuilder } from "../store/builderStore";
import { openAreasSettings, useAreasView } from "../store/areaStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useShip } from "../store/shipStore";
import { markReleaseScopesStale } from "../store/releaseScopeStore";
import { pushToast } from "../store/toastStore";
import { confirmChoice } from "../store/confirmStore";
import { noticeStopSettled, sayStoppedOnce } from "../store/releaseStopNotice";
import { observeShipAttempt, refreshPendingRelease, useErrorBlocks } from "../store/errorBlockStore";
import { askBuilderToCommit, askBuilderToFixHook } from "../store/askBuilderCard";
import { openFolderChanges } from "../store/projectFolderStore";
import { openCardStep, openProjectSetUp, setUpAction, type ReleaseSheetAsk } from "../store/uiStore";
import { isFileDirty, useEditor, type OpenFile } from "../store/editorStore";
import { useDefaultReleaseKind } from "../hooks/useDefaultReleaseKind";
import { DismissPendingReleaseButton } from "./errors/DismissPendingRelease";
import { ReleaseFollow } from "./ReleaseProgress";
import { CBtn, CheckList, CheckRow, ChoiceList, Details, Group, Icon, Row, Sheet, StatusLine, TextField, Toggle } from "./ux";
import { ReadAgainButton } from "./ReadAgainButton";
import { CARD_NOT_ON_BOARD, OPEN_THE_CARD, READ_IT_AGAIN, openTheCardAction, retryCanHelp } from "../lib/errorButtons";
import { RELEASE_STILL_RUNNING, pressOnce, pressRunning, releasePressKey, sayStillRunning, usePressRunning } from "../lib/pressOnce";

/** How often the open sheet reads the audit again (another release or land
 *  starting or ending elsewhere turns the press off or on). */
const AUDIT_POLL_MS = 3000;
/** Plyloft's own repository: the drain's poll, and its grace before the
 *  release goes by itself. */
const DRAIN_POLL_MS = 2000;
const DRAIN_GRACE_MS = 10_000;
const EMPTY_OPEN_FILES: OpenFile[] = [];
const NO_CARDS: readonly KanbanCard[] = [];
const OTHER = "other";
/** 1.176.2 (E1): the project folder's check failed — what it would have warned of may be missing. */
export const AUDIT_READ_FAILED =
  "Plyloft couldn't check the project folder, so a warning about its branch or about work still running may be missing here.";
const READ_FAILED = "Plyloft couldn't read what this release would carry.";
/** When reading again can't change it (the project folder or its repository is gone). */
const READ_FAILED_FINAL = `${READ_FAILED} The project's folder isn't there, or it isn't a Git repository.`;
/** DR4 round 1: how long a press runs before the sheet follows it. */
const PRESS_FOLLOWS_MS = 600;
const STOP_FAILED = "Plyloft couldn't stop the release. Try again in a moment.";
const DRAIN_FAILED = "Plyloft couldn't hold new work to wait for the release. Try again in a moment.";
const NOT_SET_UP =
  "This project isn't set up for releases yet: Set up says which branch it releases from and how its version is kept.";

const pushes = (kind: ReleaseKind) => kind === "github" || kind === "push_only";

/**
 * 1.174.0 (DR3, D1(b)): the one Release sheet (mockups/release.html states
 * 1–5, the refusals of state 9). Every Release… opens it. A release of an
 * area takes everything on its branch since its last tag — the cards that
 * got there with Ship it and the other changes — and the ready cards not
 * there yet that are ticked (ticked by default). It replaced
 * ShipBatchModal, ReleaseAreaSheet and the card's ReleaseFlow; the drain of
 * Plyloft's own repository (a release that quits and relaunches Plyloft)
 * moved here. Focus starts on Cancel; one filled button, with the real tag.
 */
export function ReleaseSheet({ ask, onClose }: { ask: ReleaseSheetAsk; onClose: () => void }) {
  const board = useKanban((s) => s.byWorkspace[ask.workspaceId]?.cards ?? NO_CARDS);
  const view = useAreasView(ask.workspaceId);
  // The area: the one asked for, else the area of the cards asked for, else
  // the project's without two areas, else the chooser decides (or opens the
  // only one with something).
  const askedArea = useMemo(() => {
    if (ask.areaId !== undefined) return ask.areaId;
    const first = ask.cardIds?.map((id) => board.find((c) => c.id === id)).find((c) => c !== undefined);
    const area = first ? cardAreaOf(first) : null;
    if (area) return area;
    return view != null && pickerAreas(view).length < 2 ? null : undefined;
  }, [ask, board, view]);
  const [picked, setArea] = useState<string | null | undefined>(undefined);
  const area = picked !== undefined ? picked : askedArea;
  if (area === undefined) {
    return (
      <WhichArea
        workspaceId={ask.workspaceId}
        onPick={setArea}
        onClose={onClose}
      />
    );
  }
  return <AreaRelease workspaceId={ask.workspaceId} areaId={area} asked={ask.cardIds} onClose={onClose} />;
}

/** State 4: which area — each says what is new since its last tag. With one
 *  area with something to release (or none of two), no question. */
function WhichArea({
  workspaceId,
  onPick,
  onClose,
}: {
  workspaceId: string;
  onPick: (area: string | null) => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [scopes, setScopes] = useState<ReleaseScope[] | null>(null);
  const [failed, setFailed] = useState<{ again: boolean } | null>(null);
  // One generation per read: a read that is not the newest, or that ends
  // after the step closed, never lands.
  const gen = useRef(0);
  const readAreas = useCallback(() => {
    const mine = ++gen.current;
    return releaseScopes(workspaceId)
        .then((list) => {
          if (mine !== gen.current) return;
          const all = Array.isArray(list) ? list : [];
          const only = all.length === 1 ? all[0] : onlyAreaWithSomething(all);
          setFailed(null);
          if (only) onPick(only.area);
          else setScopes(all);
        })
        .catch((e: unknown) => {
          if (mine === gen.current) setFailed({ again: retryCanHelp(e) });
        });
  }, [workspaceId, onPick]);
  useEffect(() => {
    void readAreas();
    return () => {
      gen.current++;
    };
  }, [readAreas]);
  const now = Date.now();
  return (
    <Sheet
      title={WHICH_AREA_TITLE}
      lede={WHICH_AREA_LEDE}
      size="confirm"
      onClose={onClose}
      initialFocusRef={cancelRef}
      actions={
        <CBtn ref={cancelRef} onClick={onClose}>
          Cancel
        </CBtn>
      }
    >
      {failed ? (
        <>
          <p className="ux-sheet-alert" role="alert">
            {failed.again ? READ_FAILED : READ_FAILED_FINAL}
          </p>
          {failed.again && (
            <ReadAgainButton pressKey={`release-read-areas:${workspaceId}`} label={READ_IT_AGAIN} run={readAreas} />
          )}
        </>
      ) : scopes === null ? (
        <StatusLine state="running">Reading…</StatusLine>
      ) : (
        <Group label={WHICH_AREA_TITLE}>
          {scopes.map((sc) => {
            const name = sc.name?.trim() || sc.area || "the project";
            const row = areaChoiceWords(sc, name, now);
            const fix = row.act ? null : areaRefusalFix(sc.refusal);
            return (
              <Row
                key={sc.area ?? "project"}
                kind="item"
                label={name}
                hint={machineWords(row.words)}
                action={
                  row.act ? (
                    <CBtn onClick={() => onPick(sc.area)}>{releaseLabel(name)}</CBtn>
                  ) : fix === "areas" ? (
                    <CBtn
                      onClick={() => {
                        onClose();
                        openAreasSettings(workspaceId);
                      }}
                    >
                      {OPEN_AREAS}
                    </CBtn>
                  ) : undefined
                }
              />
            );
          })}
        </Group>
      )}
    </Sheet>
  );
}

/** The release of one area (states 2, 2b, 3, 5 and the refusals of 9). */
function AreaRelease({
  workspaceId,
  areaId,
  asked,
  onClose,
}: {
  workspaceId: string;
  areaId: string | null;
  asked: readonly string[] | undefined;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const board = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? NO_CARDS);
  const projectName = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.name.trim() ?? "");
  const view = useAreasView(workspaceId);
  const refreshPending = useShip((s) => s.refreshPendingCount);
  const performShip = useShip((s) => s.performShip);
  const drainBegin = useShip((s) => s.drainBegin);
  const drainEnd = useShip((s) => s.drainEnd);
  const drain = useShip((s) => s.drain);

  const [scope, setScope] = useState<ReleaseScope | null>(null);
  const [audit, setAudit] = useState<ShipAuditReport | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  // 1.176.2 (E1, A3-05): the project folder's audit couldn't be read — the
  // warnings it feeds may be missing, and the sheet says so.
  const [auditFailed, setAuditFailed] = useState(false);
  const [installScript, setInstallScript] = useState<string | null>(null);
  // 1.175.0 B2 (round 2): the hint doesn't promise an install step that waits for the OK.
  const installWaits = useChecksConsent((s) => s.byWorkspace[workspaceId]?.install.needsOk ?? false);
  useEffect(() => {
    void useChecksConsent.getState().load(workspaceId);
  }, [workspaceId]);
  const [workflows, setWorkflows] = useState<DeployWorkflow[]>([]);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [versionChoice, setVersionChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [skipVerify, setSkipVerify] = useState(false);
  const [pressingHere, setPressing] = useState(false);
  // 1.176.2 F2 (review M1/M2): a release still pressed from a sheet closed
  // since shows here as running — Releasing…, its progress and Stop.
  const pressingElsewhere = usePressRunning(releasePressKey(workspaceId));
  const pressing = pressingHere || pressingElsewhere;
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<{ line: string; details: string | null; cardId?: string } | null>(null);
  const [needsSetUpNow, setNeedsSetUpNow] = useState(false);
  const [dirty, setDirty] = useState<{ state: TargetDirtyState; builderCard: KanbanCard | null } | null>(null);
  const [graceLeft, setGraceLeft] = useState<number | null>(null);
  const [pressLong, setPressLong] = useState(false);
  useEffect(() => {
    if (!pressing) {
      setPressLong(false);
      return;
    }
    const id = window.setTimeout(() => setPressLong(true), PRESS_FOLLOWS_MS);
    return () => window.clearTimeout(id);
  }, [pressing]);
  // DR4: the release done here (state 8), with what it carried.
  // 1.176.1: the held install step's Review, kept for the sheet as well as
  // its toast (a toast over a sheet can't be reached by keyboard).
  const [heldReview, setHeldReview] = useState<{ label: string; onClick: () => void } | null>(null);
  // Gone once pressed, once the OK is given (the step no longer waits), and
  // when the sheet is reused for another release.
  useEffect(() => {
    if (heldReview && !installWaits) setHeldReview(null);
  }, [heldReview, installWaits]);
  useEffect(() => setHeldReview(null), [workspaceId, areaId]);
  const [done, setDone] = useState<{ result: ShipResult; cards: number; others: number; tag: string } | null>(null);
  const [builderWay, setBuilderWay] = useState<
    { kind: "resolve"; card: KanbanCard } | { kind: "hook"; card: KanbanCard; said: string } | null
  >(null);
  // The ship's outcome outlives the sheet: a failure it can no longer show
  // is toasted (Close is allowed while it runs).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 1.176.3: whether reading again can change a failed read (not when the
  // project folder is gone).
  const [readAgainHelps, setReadAgainHelps] = useState(true);
  const [auditAgainHelps, setAuditAgainHelps] = useState(true);
  // One generation per read: an older read that ends after a newer one
  // (a retry beside the change events' reads) never overwrites it.
  const scopeGen = useRef(0);
  const auditGen = useRef(0);
  const readScope = useCallback(() => {
    const mine = ++scopeGen.current;
    return releaseScope(workspaceId, areaId)
      .then((sc) => {
        if (mine !== scopeGen.current) return;
        setScope(sc);
        setReadFailed(false);
      })
      .catch((e: unknown) => {
        if (mine !== scopeGen.current) return;
        setReadAgainHelps(retryCanHelp(e));
        setReadFailed(true);
      });
  }, [workspaceId, areaId]);
  const readAudit = useCallback(() => {
    const mine = ++auditGen.current;
    return shipAudit(workspaceId, { area: areaId })
      .then((a) => {
        if (mine !== auditGen.current) return;
        setAudit(a);
        setAuditFailed(false);
      })
      .catch((e: unknown) => {
        if (mine !== auditGen.current) return;
        setAuditAgainHelps(retryCanHelp(e));
        setAuditFailed(true);
      });
  }, [workspaceId, areaId]);
  const readAll = useCallback(() => Promise.all([readScope(), readAudit()]), [readScope, readAudit]);
  useEffect(() => {
    readScope();
    readAudit();
    projectConfigGet(workspaceId)
      .then((c) => setInstallScript(c?.installScript?.trim() || null))
      .catch(() => {});
    // DR3 round 1: the GitHub checks, for Technical details (read only).
    deployMapGet(workspaceId)
      .then((m) => setWorkflows(m?.workflows ?? []))
      .catch(() => {});
    let stop: (() => void) | null = null;
    let gone = false;
    void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
      if (event.payload !== workspaceId) return;
      readScope();
      readAudit();
    })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId, readScope, readAudit]);
  useEffect(() => {
    if (pressing) return;
    const id = window.setInterval(readAudit, AUDIT_POLL_MS);
    return () => window.clearInterval(id);
  }, [pressing, readAudit]);

  // Plyloft's own repository: only a release that ends in its own install
  // waits for the work running here, or asks for the editor's files first.
  const openFiles = useEditor((s) => s.byWorkspace[workspaceId]?.openFiles ?? EMPTY_OPEN_FILES);
  const dirtyFiles = useMemo(() => openFiles.filter((f) => isFileDirty(f)).map((f) => f.path), [openFiles]);

  const name = scope?.name?.trim() || audit?.area?.name?.trim() || null;
  const shownName = name ?? (projectName || "the project");
  const knownAreaName =
    (areaId !== null ? view?.areas.find((a) => a.id === areaId)?.name?.trim() : null) ||
    (view != null && pickerAreas(view).length < 2 ? projectName : null) ||
    null;
  // G2 walk (Mac): until the audit is read, the record this computer knows
  // (the sidebar's), so Show it draws the progress view at once.
  const cachedRecord = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.unpublished ?? null);
  const pending = audit ? (audit.pendingRelease ?? null) : cachedRecord;
  const branch = scope?.targetBranch ?? audit?.targetBranch ?? "main";
  const throughGithub = scope?.throughGithub === true;

  // The ready cards: the scope's (the backend's list for this area), and a
  // card asked for from its own page that only its page could release
  // (its session open, say) — that one goes alone.
  const ownCard = useMemo(() => {
    if (!scope || !asked || asked.length !== 1 || scope.readyCardIds.includes(asked[0])) return null;
    const card = board.find((c) => c.id === asked[0]);
    if (!card || !releaseOffered(card) || (cardAreaOf(card) ?? null) !== (scope.area ?? null)) return null;
    if (scope.cards.some((c) => c.cardId === card.id)) return null;
    return card;
  }, [scope, asked, board]);
  const readyCards = useMemo(() => {
    const ids = scope ? [...scope.readyCardIds, ...(ownCard ? [ownCard.id] : [])] : [];
    return ids.map((id) => board.find((c) => c.id === id) ?? null).filter((c): c is KanbanCard => c !== null);
  }, [scope, ownCard, board]);
  useEffect(() => {
    if (!scope || ticked !== null) return;
    const ids = readyCards.map((c) => c.id);
    setTicked(new Set(initialTicks(ids, ownCard ? [ownCard.id] : asked)));
  }, [scope, readyCards, ticked, asked, ownCard]);
  // A release committed but not published goes on with exactly its cards.
  const tickedIds = pending ? pending.cardIds : readyCards.filter((c) => ticked?.has(c.id)).map((c) => c.id);
  const alone = ownCard !== null && tickedIds.length === 1 && tickedIds[0] === ownCard.id;

  // Version: patch by default (owner), minor and major one click away.
  const versions = scope?.versions ?? [];
  const firstFree = versions.find((v) => !v.taken) ?? versions[0];
  // Re-walk (Mac): a choice is its version — two choices can share a kind
  // (the patch moved past a taken one, and the taken one itself).
  const chosenVersion = versionChoice ?? firstFree?.version ?? null;
  const prefix = scope?.tagPrefix ?? audit?.area?.tagPrefix ?? "";
  const version = pending
    ? pending.version
    : chosenVersion === OTHER
      ? typed.trim().replace(/^v/i, "")
      : (versions.find((v) => v.version === chosenVersion)?.version ?? "");
  const tag = pending ? pending.tag : tagOf(prefix, version || "X.Y.Z");

  // How far it goes: from the area's default (Settings › Cards › Shipping), else how
  // Ship it ships, until the person chooses.
  const preferredKind = useDefaultReleaseKind(workspaceId, areaId);
  const chosenDefault = chosenReleaseKind(view, areaId === null ? null : { id: areaId });
  const [kind, setKindState] = useState<ReleaseKind>("local");
  const kindDecided = useRef(false);
  const setKind = (next: ReleaseKind) => {
    kindDecided.current = true;
    setKindState(next);
  };
  useEffect(() => {
    if (kindDecided.current || preferredKind === null) return;
    // Without checks, a default that pushes drops to on this Mac only.
    setKindState(skipVerify && pushes(preferredKind) ? "local" : preferredKind);
  }, [preferredKind, skipVerify]);
  useEffect(() => {
    if (pending && pending.releaseKind !== "local") setKind(pending.releaseKind);
  }, [pending]);
  const kindReady = preferredKind !== null || kindDecided.current || pending !== null;
  const diverged = throughGithub && scope?.diverged === true;
  const behind = throughGithub && kind === "local" ? (scope?.localBehind ?? 0) : 0;
  const prRoute = throughPr(kind, throughGithub) || pending?.pr != null;

  // Plyloft's own install: wait for the running work.
  const inFlightCount = audit ? audit.activeSwarms.length + audit.activeIntakes.length + audit.activeRunCount : 0;
  const restartsPlyloft = audit?.relaunches === true;
  const busyWork = restartsPlyloft && inFlightCount > 0;
  const unsavedFirst = restartsPlyloft && dirtyFiles.length > 0;

  // What holds the press back, said before it (state 9).
  const now = Date.now();
  const unreadable = audit?.pendingRecordUnreadable ?? null;
  const elsewhere = audit?.pendingElsewhere ?? null;
  const notSetUp = audit !== null && audit.targetBranch == null && pending === null;
  const nothing = scope !== null && pending === null && scopeNews(scope) === 0 && tickedIds.length === 0;
  const wrongBranch =
    audit !== null && !notSetUp && !audit.branchOk && pending === null && !prRoute
      ? `This project's folder is on ${audit.branch}, and a release is made from ${branch}. Switch it to ${branch}, then release.`
      : null;
  const holdBack: string | null = !scope
    ? null
    : scope.refusal
      ? scope.refusal
      : audit?.area?.refusal
        ? audit.area.refusal
        : notSetUp
          ? NOT_SET_UP
          : unreadable !== null
            ? `Plyloft's record of an unpublished release can't be read: ${unreadable}`
            : elsewhere !== null
              ? elsewhere
              : pending?.problem
                ? `${pending.tag} can't be published from here: ${pending.problem} Dismiss it to release again.`
                : !pending && scope.inFlight
                  ? onItsWayWords(scope.inFlight, shownName)
                  : !pending && (scope.busy || audit?.shipInFlight)
                    ? ANOTHER_RUNNING
                    : wrongBranch
                      ? wrongBranch
                      : !pending && kind === "local" && diverged
                        ? divergedLine(branch)
                        : !pending && takenTag(scope, tag)
                          ? takenWords(tag, throughGithub)
                          : nothing
                            ? nothingNewWords(scope, name, now)
                            : null;
  const canPress =
    scope !== null &&
    audit !== null &&
    kindReady &&
    holdBack === null &&
    !pressing &&
    !drain.draining &&
    version.length > 0;

  function sayFailure(e: unknown, cardIds: string[]) {
    const titleOf = (id: string) => useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === id)?.title ?? "";
    const shown = shipBatchFailure(e, cardIds.map(titleOf));
    const folder = decodeTargetDirtyError(e);
    // 1.176.3: a refusal that names a ticked card (`ship_batch blocked: card
    // `X` …`) leads to that card — only when exactly one ticked card has the title.
    const refused = /ship_batch blocked:\s*card `(.+?)`/s.exec(rawError(e))?.[1];
    const named = refused === undefined ? [] : cardIds.filter((id) => titleOf(id) === refused);
    const refusedId = named.length === 1 ? named[0] : undefined;
    if (alive.current) {
      setFailure({ line: machineWords(shown.line), details: shown.details, ...(refusedId ? { cardId: refusedId } : {}) });
      setNeedsSetUpNow(needsSetUp(e));
      // DR3 round 1: one ticked card with a Builder — the card's own ways out
      // (ReleaseFlow's): a conflict to resolve, a hook's refusal to fix.
      const one = cardIds.length === 1 ? useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === cardIds[0]) : undefined;
      const raw = rawError(e);
      const stop = commitStop(raw);
      setBuilderWay(
        !one || !one.builder || one.archived
          ? null
          : releaseConflict(raw)
            ? { kind: "resolve", card: one }
            : stop?.kind === "hook"
              ? { kind: "hook", card: one, said: stop.said }
              : null,
      );
      if (folder) {
        const builderCard =
          cardIds
            .map((id) => useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === id))
            .find((c): c is KanbanCard => c !== undefined && builderMayCommit(c)) ?? null;
        setDirty({ state: folder, builderCard });
      }
      return;
    }
    pushToast({
      kind: "warn",
      title: folder ? TARGET_DIRTY_TITLE : `${tag} wasn't released`,
      body: shown.line,
      details: shown.details ?? undefined,
      ...(folder
        ? { action: { label: SHOW_THEM, onClick: () => openFolderChanges(workspaceId, "ship") } }
        : needsSetUp(e)
          ? { action: setUpAction(workspaceId) }
          : refusedId && openTheCardAction(workspaceId, refusedId)
            ? { action: openTheCardAction(workspaceId, refusedId) }
            : {}),
    });
  }

  // 1.176.2 F2 (A5F-04): one press of this project's release at a time,
  // taken before the first await and kept by the module, not this sheet —
  // a sheet closed and opened again mid-press (its drain still on) is a new
  // mount. A second press while one runs does nothing: it never ends the
  // drain or drops the progress of the one running.
  async function press() {
    if (!scope) return;
    await pressOnce(releasePressKey(workspaceId), pressNow, sayStillRunning(RELEASE_STILL_RUNNING));
  }
  async function pressNow() {
    if (!scope) return;
    const cardIds = [...tickedIds];
    setHeldReview(null);
    setPressing(true);
    setFailure(null);
    setNeedsSetUpNow(false);
    setDirty(null);
    setBuilderWay(null);
    try {
      const result: ShipResult = alone
        ? await performShip({ workspaceId, cardId: cardIds[0], releaseKind: kind, version, skipVerify })
        : await releaseTheArea({
            workspaceId,
            areaId,
            cardIds,
            releaseKind: kind,
            version,
            skipVerify: pending ? false : skipVerify,
          });
      if (drain.draining) await drainEnd().catch(() => {});
      observeShipAttempt(workspaceId, cardIds, "ship", {
        passedGate: pushes(kind),
        shipped: true,
        fastForwarded: result.fastForwarded === true,
      });
      void refreshPending();
      void useKanban.getState().loadFromDisk(workspaceId, true);
      // DR4: the sheet follows it — done here (state 8), or its release
      // pull request on its way (state 6); closed already, a toast says it.
      // 1.175.0 B2: its install step waits for this Mac's OK — said in a
      // toast with Review, whether the sheet is still up or not.
      const heldInstall = await installHeldAfter(workspaceId, result);
      if (alive.current) setHeldReview(heldInstall?.action ?? null);
      if (!alive.current || heldInstall) {
        const words = shipDoneWords(result, Math.max(1, scope.cardsTotal + cardIds.length), heldInstall?.held);
        pushToast({ kind: "info", title: words.title, body: machineWords(words.body), ...(heldInstall ? { action: heldInstall.action } : {}) });
      }
      if (!alive.current) {
        // Said by the toast.
      } else if (!result.releasePr || result.releasePr.released) {
        setDone({ result, cards: scope.cardsTotal + cardIds.length, others: scope.otherTotal, tag: result.tag?.trim() || tag });
      } else {
        readAudit();
      }
    } catch (e: unknown) {
      if (drain.draining) await drainEnd().catch(() => {});
      const stopped = decodeStopped(e);
      if (stopped) {
        sayStoppedOnce(workspaceId, stopped.tag, stoppedWords(stopped));
        void refreshPending();
        markReleaseScopesStale(workspaceId);
        if (alive.current) onClose();
        return;
      }
      // GH #151: a refusal drawn on the cards' Ship step, announced there.
      if (observeShipAttempt(workspaceId, cardIds, "ship", { refused: e })) {
        if (alive.current) onClose();
        return;
      }
      void refreshPending();
      sayFailure(e, cardIds);
    } finally {
      if (alive.current) {
        setPressing(false);
        setStopping(false);
      }
    }
  }
  // Read at fire time by the drain's grace.
  const pressRef = useRef(press);
  pressRef.current = press;

  /** Stop asks first once the release is on GitHub (state 7). */
  async function askStop() {
    const step = pending?.pr?.step ?? null;
    if (stopAsks(step)) {
      const words = stopConfirmWords(pending!.tag, pending!.pr?.number ?? null, pending!.pr?.branch);
      const answer = await confirmChoice({
        title: words.title,
        body: words.body,
        confirmLabel: STOP_THE_RELEASE,
        cancelLabel: KEEP_IT_GOING,
        focusCancel: true,
        cautious: true,
        asIs: true,
      });
      if (answer !== "confirm") return;
    }
    await stopTheRelease();
  }

  async function stopTheRelease() {
    setStopping(true);
    try {
      const out = await releaseStop(workspaceId);
      // Its own press says how it ended (`{ stopped }`); a release with no
      // press running here is given up now.
      if (!out.stopping) {
        sayStoppedOnce(workspaceId, tag, { title: `${tag} is stopped`, ...(out.said ? { body: out.said } : {}) });
        setStopping(false);
        markReleaseScopesStale(workspaceId);
        if (alive.current) onClose();
      } else if (!pressingHere) {
        // Windows G2 walk: another press carries the stop out (the poller's,
        // or a sheet closed since) — its answer reaches no sheet, so the
        // stop is said once it settles.
        noticeStopSettled(workspaceId, pending, tag);
      }
    } catch (e: unknown) {
      setStopping(false);
      if (alive.current) setFailure({ line: typeof e === "string" ? e : STOP_FAILED, details: null });
    }
  }

  // The drain (Plyloft's own repository): new work is held, the press goes
  // by itself once nothing runs, after a grace the person can stop.
  useEffect(() => {
    if (!drain.draining) {
      setGraceLeft(null);
      return;
    }
    let cancelled = false;
    let grace: number | null = null;
    const poll = window.setInterval(async () => {
      try {
        const next = await shipAudit(workspaceId, { area: areaId });
        if (cancelled) return;
        setAudit(next);
        const busy = next.activeSwarms.length + next.activeIntakes.length + next.activeRunCount > 0;
        if (busy) {
          if (grace !== null) window.clearInterval(grace);
          grace = null;
          setGraceLeft(null);
        } else if (grace === null && !pressRunning(releasePressKey(workspaceId))) {
          // 1.176.2 F2 (A5F-04): no new grace while a press runs — the drain
          // stays on until that press settles, and the poll goes on meanwhile.
          let left = Math.floor(DRAIN_GRACE_MS / 1000);
          setGraceLeft(left);
          grace = window.setInterval(() => {
            left -= 1;
            setGraceLeft(left);
            if (left <= 0) {
              if (grace !== null) window.clearInterval(grace);
              grace = null;
              void pressRef.current();
            }
          }, 1000);
        }
      } catch (e) {
        console.warn("drain audit poll failed", e);
      }
    }, DRAIN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      if (grace !== null) window.clearInterval(grace);
    };
  }, [drain.draining, workspaceId, areaId]);

  function toggle(card: KanbanCard) {
    if (pending) return;
    setTicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(card.id)) next.delete(card.id);
      else {
        // The card only its page can release goes alone.
        if (ownCard && card.id === ownCard.id) next.clear();
        else if (ownCard) next.delete(ownCard.id);
        next.add(card.id);
      }
      return next;
    });
  }

  // Walk fix (DR3 early walk): a refusal is brought into view, and goes
  // once the version, the kind or the ticks change.
  const heldRef = useRef<HTMLDivElement>(null);
  const heldText = failure?.line ?? holdBack;
  useEffect(() => {
    if (heldText) heldRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [heldText]);
  const tickKey = tickedIds.join(",");
  useEffect(() => {
    setFailure(null);
    setDirty(null);
    setBuilderWay(null);
  }, [version, kind, tickKey]);

  // ── DR4: a release on its way, done, or stopped where only the person
  // can move it on (release.html states 6–9): the sheet follows it.
  const prRecord = pending?.pr ?? null;
  // The last step seen: a record that goes once merged was released.
  // DR4 round 1: never "released" for a record that went with a problem (a
  // Dismiss); the poller's own word confirms a release done while open.
  const lastSeen = useRef<{
    tag: string;
    step: string;
    cards: number;
    others: number;
    url: string | null;
    number: number | null;
    problem: boolean;
  } | null>(null);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    void onReleasePrReleased((event) => {
      const last = lastSeen.current;
      if (event.workspaceId !== workspaceId || !last || !alive.current) return;
      const tagOf = event.result.tag?.trim() || last.tag;
      if (tagOf !== last.tag) return;
      setDone({ result: event.result, cards: Math.max(event.cardCount, last.cards), others: last.others, tag: tagOf });
    })
      .then((u) => {
        if (gone) u();
        else stop = u;
      })
      .catch(() => {});
    return () => {
      gone = true;
      stop?.();
    };
  }, [workspaceId]);
  useEffect(() => {
    if (pending && prRecord) {
      lastSeen.current = {
        tag: pending.tag,
        step: prRecord.step,
        cards: (pending.mergedCardIds?.length ?? 0) + pending.cardIds.length,
        others: pending.otherChanges ?? 0,
        url: prRecord.url,
        number: prRecord.number,
        problem: pending.problem !== null,
      };
      return;
    }
    const last = lastSeen.current;
    if (!pending && last && !last.problem && (last.step === "merged" || last.step === "tagged") && !done) {
      setDone({
        result: {
          commitSha: "",
          shippedVersion: "",
          releaseKind: kind,
          installLog: "",
          tag: last.tag,
          releasePr: { step: "tagged", number: last.number, url: last.url, waiting: null, released: true },
        },
        cards: last.cards,
        others: last.others,
        tag: last.tag,
      });
    }
    // Re-walk (Mac): kept after the record goes, so the poller's word that
    // it was released (which may come after) still says so here.
  }, [pending, prRecord, done, kind]);
  // DR4 round 1: a press that ends at once (a refusal) never flickers into
  // the progress view — it follows once the record exists, or after 600 ms.
  // G2 walk (Mac): once done, the sidebar's row goes with the record.
  const doneTag = done?.tag ?? null;
  useEffect(() => {
    if (!doneTag) return;
    const shown = useErrorBlocks.getState().byWorkspace[workspaceId]?.unpublished;
    if (shown && shown.tag === doneTag) useErrorBlocks.getState().setUnpublished(workspaceId, null);
    void refreshPendingRelease(workspaceId);
  }, [doneTag, workspaceId]);
  const following = done !== null || prRecord !== null || (pressing && pending === null && pressLong);
  if (following) {
    return (
      <ReleaseFollow
        workspaceId={workspaceId}
        tag={done?.tag ?? pending?.tag ?? tag}
        branch={branch}
        kind={done?.result.releaseKind ?? pending?.releaseKind ?? kind}
        throughPr={done ? done.result.releasePr != null : prRecord !== null || prRoute}
        pr={prRecord}
        problem={pending?.problem ?? null}
        making={pressing && pending === null}
        readyCards={pending?.cardIds.length ?? 0}
        stage={pending?.stage ?? "tagged"}
        cardCount={pending?.cardIds.length ?? tickedIds.length}
        lede={progressLede({
          branch,
          mergedCards: pending ? (pending.mergedCardIds?.length ?? 0) : (scope?.cardsTotal ?? 0),
          otherChanges: pending ? (pending.otherChanges ?? 0) : (scope?.otherTotal ?? 0),
          ticked: tickedIds.map((id) => board.find((c) => c.id === id)?.title ?? ""),
        })}
        done={done}
        heldInstall={
          heldReview
            ? {
                label: heldReview.label,
                onClick: () => {
                  setHeldReview(null);
                  heldReview.onClick();
                },
              }
            : null
        }
        pressing={pressing}
        canStop={!alone || prRecord !== null || prRoute}
        stopping={stopping}
        failure={failure}
        onStop={() => void askStop()}
        onContinue={() => void press()}
        onClose={onClose}
        onReread={() => {
          readAudit();
          readScope();
        }}
      />
    );
  }

  const title = pending
    ? pending.pr
      ? `Continue ${pending.tag}`
      : `Publish ${pending.tag}`
    : // Walk fix (DR3 early walk): never titled before the area is known —
      // the project's name stands only for a project without areas.
      scope
      ? `Release ${shownName}`
      : knownAreaName
        ? `Release ${knownAreaName}`
        : "Release";
  const primaryLabel = pressing
    ? "Releasing…"
    : pending?.pr
      ? `Continue ${pending.tag}`
      : pending
        ? `Publish ${pending.tag}`
        : busyWork
          ? "Wait for the work, then release"
          : unsavedFirst
            ? "Release anyway"
            : `Release ${tag}`;
  const onPrimary = () => {
    if (busyWork && !pending) void drainBegin().catch(() => setFailure({ line: DRAIN_FAILED, details: null }));
    else void press();
  };
  const fold = scope ? whatsInFold(scope) : null;
  const ticks = ticked ?? new Set<string>();

  return (
    <Sheet
      title={title}
      lede={scope && !pending ? releaseLede(scope, shownName, now, readyCards.length) : undefined}
      onClose={onClose}
      initialFocusRef={cancelRef}
      footNote={scope && !pending ? <span className="ux-release-foot">{footWords(scope, tickedIds.length)}</span> : undefined}
      actions={
        <>
          <CBtn ref={cancelRef} onClick={onClose}>
            {pressing ? "Close" : "Cancel"}
          </CBtn>
          {/* A card released alone through its own Ship (ship_card) has no
              stop until it reaches GitHub's pull request. */}
          {pressing && (!alone || prRoute) && (
            <CBtn onClick={() => void stopTheRelease()} disabled={stopping}>
              {STOP_THE_RELEASE}
            </CBtn>
          )}
          {drain.draining && !pressing && (
            <CBtn onClick={() => void drainEnd().catch(() => {})}>Stop waiting</CBtn>
          )}
          <CBtn
            tone="accent"
            onClick={onPrimary}
            disabled={!canPress}
            data-ply-release-press=""
          >
            {primaryLabel}
          </CBtn>
        </>
      }
    >
      {readFailed && !scope && (
        <p className="ux-sheet-alert" role="alert">
          {readAgainHelps ? READ_FAILED : READ_FAILED_FINAL}
        </p>
      )}
      {auditFailed && !audit && (
        <p className="ux-sheet-alert" role="alert" data-ply-audit-failed="">
          {AUDIT_READ_FAILED}
        </p>
      )}
      {/* One press reads both again; none when the folder is gone (it can't help). */}
      {((readFailed && !scope) || (auditFailed && !audit)) &&
        !(readFailed && !scope && !readAgainHelps) &&
        !(auditFailed && !audit && !auditAgainHelps) && (
          <ReadAgainButton
            pressKey={`release-read:${workspaceId}:${areaId ?? ""}`}
            label={READ_IT_AGAIN}
            run={readAll}
          />
        )}
      {!scope && !readFailed && <StatusLine state="running">Reading…</StatusLine>}
      {scope && pending && (
        <section className="ux-release-section" data-ply-pending-release={pending.tag}>
          <p className="ux-sheet-text">
            {pending.pr
              ? `${pending.tag}: ${releasePrStateLabel(pending.pr)}. Continue looks at its pull request on GitHub now.`
              : machineWords(`Publishes ${pending.tag}, already made on this Mac.`)}
          </p>
        </section>
      )}
      {scope && !pending && (
        <>
          {(scope.fetchProblem || scope.countProblem || scope.partial) && (
            <p className="ux-sheet-hint">
              {machineWords(
                [
                  scope.fetchProblem,
                  scope.countProblem,
                  scope.partial ? "This copy of the project has only part of its history, so the counts may be short." : null,
                ]
                  .filter(Boolean)
                  .join(" "),
              )}
            </p>
          )}
          {scopeNews(scope) > 0 && fold && (
            <section className="ux-release-section" data-ply-release-whats-in="">
              <h3 className="ux-release-heading">
                {WHATS_IN_IT} <span className="ux-release-count">{whatsInCount(scope)}</span>
              </h3>
              {fold.shown.length > 0 && (
                <ul className="ux-release-list">
                  {fold.shown.map((c) => (
                    <li className="ux-release-row" key={c.cardId}>
                      <span className="ux-release-row-icon">
                        <Icon name="current" size="sm" />
                      </span>
                      <span className="ux-release-row-main">
                        {c.title}
                        <span className="ux-release-row-hint">{scopeCardHint(c, now)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {fold.fold && (
                <Details summary={fold.fold}>
                  <ul className="ux-release-list" data-ply-release-others="">
                    {fold.foldHasCards &&
                      scope.cards.slice(fold.shown.length).map((c) => (
                        <li className="ux-release-row" key={c.cardId}>
                          <span className="ux-release-row-icon">
                            <Icon name="current" size="sm" />
                          </span>
                          <span className="ux-release-row-main">
                            {c.title}
                            <span className="ux-release-row-hint">{scopeCardHint(c, now)}</span>
                          </span>
                        </li>
                      ))}
                    {scope.otherChanges.map((o) => (
                      <li className="ux-release-row" key={o.sha}>
                        <span className="ux-release-row-main">
                          {o.title}
                          <span className="ux-release-row-hint">{otherChangeHint(o, now)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Details>
              )}
            </section>
          )}

          {readyCards.length > 0 && (
            <section className="ux-release-section" data-ply-release-ready="">
              <h3 className="ux-release-heading">
                {alsoReadyHeading(branch)} <span className="ux-release-count">{readyCards.length}</span>
              </h3>
              <CheckList label={alsoReadyHeading(branch)}>
                {readyCards.map((c) => (
                  <CheckRow
                    key={c.id}
                    checked={ticks.has(c.id)}
                    disabled={pressing}
                    onChange={() => toggle(c)}
                    hint={readyCardHint(c.verifyStatus === "skipped")}
                  >
                    {c.title}
                  </CheckRow>
                ))}
              </CheckList>
            </section>
          )}

          {versions.length > 0 && (
            <section className="ux-release-section" data-ply-release-version="">
              <h3 className="ux-release-heading">Version</h3>
              <ChoiceList<string>
                label="Version"
                value={chosenVersion}
                onChange={setVersionChoice}
                options={[
                  ...versions.map((v) => ({
                    value: v.version,
                    label: v.tag,
                    hint: versionHint(v, scope),
                    disabled: v.taken || pressing,
                  })),
                  { value: OTHER, label: ANOTHER_VERSION, hint: "Type it below", disabled: pressing },
                ]}
              />
              {chosenVersion === OTHER && (
                <TextField label="Version" value={typed} onChange={setTyped} placeholder={firstFree?.version} mono />
              )}
              {versionSourceLine(scope, shownName) && <p className="ux-sheet-hint">{versionSourceLine(scope, shownName)}</p>}
            </section>
          )}
        </>
      )}

      {scope && (
        <section className="ux-release-section" data-ply-release-kind="">
          <h3 className="ux-release-heading">How far it goes</h3>
          <ChoiceList<ReleaseKind>
            label="How far it goes"
            value={kind}
            onChange={setKind}
            options={RELEASE_KIND_ORDER.map((k) => ({
              value: k,
              label: RELEASE_KIND_LABEL[k],
              hint:
                k === "local" && pending
                  ? `${pending.tag} is published by pushing it.`
                  : k === "local" && diverged
                    ? divergedLine(branch)
                    : k === "github" && skipVerify
                      ? "A release without checks is never a GitHub release."
                      : kindHint(k, {
                          throughGithub,
                          branch,
                          installScript: (view?.areas.length ?? 0) >= 2 ? null : installScript,
                          installWaits,
                          chosenDefault: chosenDefault === k,
                          owner: shownName,
                        }),
              disabled:
                pressing ||
                (k === "local" && (pending !== null || diverged)) ||
                (k === "github" && skipVerify && !pending),
            }))}
          />
          {behind > 0 && !diverged && <p className="ux-sheet-hint">{machineWords(behindLine(branch, behind))}</p>}
        </section>
      )}

      {scope && !pending && version && (
        <p className="ux-sheet-text" data-ply-release-summary="">
          {machineWords(
            pressSummary({ tag, branch, kind, throughGithub, ticked: tickedIds.length, skipVerify }),
          )}
        </p>
      )}

      {busyWork && !pending && (
        <p className="ux-sheet-hint">
          {`${inFlightCount} ${inFlightCount === 1 ? "thing is" : "things are"} still running in Plyloft. The release waits for ${inFlightCount === 1 ? "it" : "them"} to finish, then goes.`}
        </p>
      )}
      {unsavedFirst && (
        <p className="ux-sheet-alert">
          {`${dirtyFiles.length} ${dirtyFiles.length === 1 ? "file" : "files"} in the editor ${dirtyFiles.length === 1 ? "isn't" : "aren't"} saved. A release restarts Plyloft: save them first.`}
        </p>
      )}
      {drain.draining && (
        <StatusLine state="running">
          {graceLeft !== null
            ? `All clear — releasing in ${graceLeft}s. Stop waiting to cancel.`
            : `Waiting for ${inFlightCount} ${inFlightCount === 1 ? "thing" : "things"} to finish. New work is held.`}
        </StatusLine>
      )}

      {(holdBack || failure) && (
        <div ref={heldRef} className="ux-sheet-alert" role="alert" data-ply-release-held="">
          <p>{machineWords(failure?.line ?? holdBack ?? "")}</p>
          {failure?.details && (
            <Details>
              <pre className="ux-output">{failure.details}</pre>
            </Details>
          )}
        </div>
      )}
      {failure?.cardId && !dirty && !builderWay && (
        <div className="ux-flow-actions">
          <CBtn
            onClick={() => {
              const id = failure.cardId!;
              const card = useKanban.getState().byWorkspace[workspaceId]?.cards.find((c) => c.id === id && !c.archived);
              if (!card) {
                // The card went since the refusal: nothing to open.
                setFailure({ line: CARD_NOT_ON_BOARD, details: null });
                return;
              }
              onClose();
              openCardStep(workspaceId, id, "ship");
            }}
          >
            {OPEN_THE_CARD}
          </CBtn>
        </div>
      )}
      {builderWay && failure && !dirty && (
        <div className="ux-flow-actions">
          <CBtn
            onClick={() => {
              const way = builderWay;
              onClose();
              if (way.kind === "hook") void askBuilderToFixHook(way.card, way.said);
              else
                void (async () => {
                  // The conflict was written to the board by the release.
                  await useKanban.getState().loadFromDisk(way.card.workspaceId, true);
                  await useBuilder.getState().resolveShipConflict(way.card.workspaceId, way.card.id);
                })();
            }}
          >
            {builderWay.kind === "hook" ? "Ask the Builder" : ASK_BUILDER_LABEL}
          </CBtn>
        </div>
      )}
      {dirty && failure && (
        <div className="ux-flow-actions">
          {dirty.builderCard && (
            <CBtn
              onClick={() => {
                const card = dirty.builderCard!;
                onClose();
                void askBuilderToCommit(card, dirty.state);
              }}
            >
              Ask the Builder to commit them
            </CBtn>
          )}
          <CBtn
            onClick={() => {
              onClose();
              openFolderChanges(workspaceId, "ship");
            }}
          >
            {SHOW_THEM}
          </CBtn>
        </div>
      )}
      {(notSetUp || needsSetUpNow) && (
        <div>
          <CBtn
            onClick={() => {
              onClose();
              openProjectSetUp(workspaceId);
            }}
          >
            {SET_UP_LABEL}
          </CBtn>
        </div>
      )}
      {!pressing && (unreadable !== null || pending !== null) && (
        <div>
          <DismissPendingReleaseButton
            workspaceId={workspaceId}
            tag={unreadable !== null ? null : pending!.tag}
            cardCount={pending?.cardIds.length ?? 0}
            stage={pending?.stage ?? "tagged"}
            throughPr={unreadable === null && pending?.pr != null}
            onDismissed={() => {
              readAudit();
              readScope();
            }}
          />
        </div>
      )}

      {scope && !pending && (
        <Details summary="Technical details">
          <ul className="ux-flow-disk">
            {technicalLines(
              scope,
              skipVerify ? `${tag}-unverified` : tag,
              kind,
              checksFor(workflows, branch).length ? checksDetail(checksFor(workflows, branch)) : null,
            ).map((line) => (
              <li className="ux-flow-disk-line" key={line}>
                {machineWords(line)}
              </li>
            ))}
            {unsavedFirst &&
              dirtyFiles.map((p) => (
                <li key={p} className="ux-flow-disk-line">
                  Unsaved: {p}
                </li>
              ))}
          </ul>
          <div className="ux-flow-section">
            <Toggle
              label={RELEASE_WITHOUT_CHECKS}
              checked={skipVerify}
              onChange={(next) => {
                setSkipVerify(next);
                // Never a GitHub release (ship.rs refuses it).
                if (next && kind === "github") setKind("local");
              }}
            />{" "}
            {machineWords(withoutChecksLine(tag, kind))}
          </div>
          {busyWork && (
            <div className="ux-flow-section">
              <CBtn tone="danger" onClick={() => void press()} disabled={!canPress}>
                {STOP_WORK_AND_RELEASE}
              </CBtn>
            </div>
          )}
        </Details>
      )}
    </Sheet>
  );
}
