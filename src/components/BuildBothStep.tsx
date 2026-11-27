import { showBackendText } from "../lib/backendMarks";
import { RepairFor } from "./ux/RepairFor";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { modelSentenceWords } from "../lib/roleModels";
import { buildBothLaneDiff, type BuildLaneId, type KanbanCard, type LaneDiff } from "../ipc";
import {
  compareLegend,
  compareWords,
  judgeWords,
  LANES,
  laneChecksLine,
  laneDiffLine,
  laneFindingsWords,
  laneKey,
  laneLeanLabel,
  laneModelWords,
  laneOf,
  laneSetup,
  laneStage,
  laneVendorName,
  laneVerdict,
  pickOffer,
} from "../lib/buildBoth";
import { DiffFiles } from "./CardReviewPanel";
import { shownLaneKey, useBuildBoth } from "../store/buildBothStore";
import { builderResumedIdle, useBuilder } from "../store/builderStore";
import { actorStateWords, laneActor, type ActorWords } from "../lib/sessionActor";
import { TRUST_LABEL, trustHelper } from "../lib/trustQuestion";
import { sessionBlockHeadline, sessionBlockSentence } from "../lib/sessionBlock";
import { FINISH_AGAIN_LABEL, FINISH_BUSY_LABEL, FINISH_LABEL, resumeFailedHelper } from "../lib/cardLifecycle";
import { ago } from "../lib/cardPage";
import { confirmSheet } from "../store/confirmStore";
import { earlyFinishSheet } from "../lib/finishAndCheck";
import { BuilderSession } from "./BuilderSession";
import { WorktreeSetupNote } from "./BuilderRunStep";
import { CBtn, Callout, Details, Segmented, Sheet, StateWord } from "./ux";
import { InlineMd } from "./InlineMd";
import { MarkdownText } from "./MarkdownText";

/** CL-11 (walk): each build's switch, line and card say what its session
 *  is doing, as the Now callout does (CL-7) — "Claude · waiting for you"
 *  once its turn is over, never "Working" until Build done. */
/** (Challenger, P-B) A build's Finish and check, pressed early, asks first
 *  as the card's own Builder's does (`earlyFinishSheet`); Esc and Enter keep
 *  it working. */
async function finishLane(workspaceId: string, cardId: string, lane: BuildLaneId): Promise<void> {
  const sheet = earlyFinishSheet(useBuilder.getState().byCard[laneKey(cardId, lane)], Date.now(), builderResumedIdle(laneKey(cardId, lane)));
  if (sheet && !(await confirmSheet(sheet))) return;
  await useBuildBoth.getState().done(workspaceId, cardId, lane);
}

function useLaneActors(card: KanbanCard): Record<BuildLaneId, ActorWords> {
  const liveA = useBuilder((s) => s.byCard[laneKey(card.id, "a")]) ?? null;
  const liveB = useBuilder((s) => s.byCard[laneKey(card.id, "b")]) ?? null;
  const sentA = useBuilder((s) => s.sentAt[laneKey(card.id, "a")] ?? null);
  const sentB = useBuilder((s) => s.sentAt[laneKey(card.id, "b")] ?? null);
  const submitA = useBuilder((s) => s.submittedAt[laneKey(card.id, "a")] ?? null);
  const submitB = useBuilder((s) => s.submittedAt[laneKey(card.id, "b")] ?? null);
  const now = Date.now();
  return {
    a: laneActor({ card, lane: "a", live: liveA, sentAt: sentA, submittedAt: submitA, now }),
    b: laneActor({ card, lane: "b", live: liveB, sentAt: sentB, submittedAt: submitB, now }),
  };
}

/**
 * SL-6 — the Run step of a card built by both: Claude's and Codex's
 * sessions (one terminal shown at a time; both stay attached), each with its
 * own Build done. SP-3: the two builds' cards, the Challenger's comparison
 * and the pick are `BuildBothCards`, under the card's Now callout from the
 * start; this section keeps the terminals.
 */
export function BuildBothStep({ card }: { card: KanbanCard }) {
  const ws = card.workspaceId;
  const bb = card.buildBoth!;
  // Round 3: the Inbox's Open session on one build's row shows that build.
  const shown = useBuildBoth((s) => s.shownLane[shownLaneKey(ws, card.id)]) ?? "a";
  const setShown = (lane: BuildLaneId) => useBuildBoth.getState().showLane(ws, card.id, lane);
  const busy = useBuildBoth((s) => s.busy[card.id]) ?? null;
  // v1.154.1 (walk G1): a build stopped at its CLI's folder-trust question.
  const trustAsking = useBuilder((s) => s.trustAsking);
  const asks = (id: BuildLaneId) => Boolean(trustAsking[laneKey(card.id, id)]);
  // UX P-F: a build stopped by Claude's usage limit or its bypass warning.
  const sessionBlocks = useBuilder((s) => s.sessionBlocks);
  const blockOf = (id: BuildLaneId) => (asks(id) ? null : (sessionBlocks[laneKey(card.id, id)] ?? null));
  const { startLanes, resume, startFresh, stopLane } = useBuildBoth.getState();
  const done = finishLane;
  const actors = useLaneActors(card);

  return (
    <div className="ux-card-session" data-ply-build-both="">
      <p className="ux-card-plain">
        Claude and Codex are each building this card in their own copy of the repository.
        {/* v1.154.1 (J5): with one build stopped nothing is compared. */}
        {bb.lanes.some((l) => l.failed)
          ? " One build ended without a result: the other is the one to pick."
          : ` Press ${FINISH_LABEL} on each when it's finished; the Reviewer then compares the two, and you pick the one the card continues with.`}
      </p>
      <Segmented<BuildLaneId>
        label="Build"
        value={shown}
        onChange={setShown}
        options={LANES.map((id) => ({
          value: id,
          label: asks(id)
            ? `${laneVendorName(laneOf(bb, id), id)} · ${TRUST_LABEL}`
            : blockOf(id)
              ? `${laneVendorName(laneOf(bb, id), id)} · ${sessionBlockHeadline(blockOf(id)!.kind)}`
              : actors[id].words,
        }))}
      />
      <div className="ux-both-lanes">
        {LANES.map((id) => (
          <LanePanel
            key={id}
            card={card}
            id={id}
            shown={shown === id}
            actor={actors[id]}
            asksTrust={asks(id)}
            stoppedWords={(() => {
              const b = blockOf(id);
              return b ? sessionBlockSentence(b.kind, b.vendor, b.resetsAt) : null;
            })()}
            busy={busy}
            onStartLanes={() => startLanes(ws, card.id)}
            onResume={() => resume(ws, card.id, id)}
            onStartFresh={() => startFresh(ws, card.id, id)}
            onDone={() => done(ws, card.id, id)}
            onStop={async () => {
              const name = laneVendorName(laneOf(bb, id), id);
              if (
                await confirmSheet({
                  title: `Stop ${name}'s build?`,
                  body: `Its session ends and it counts as ended without a result. Its copy of the repository stays until you pick.`,
                  confirmLabel: `Stop ${name}'s build`,
                })
              ) {
                await stopLane(ws, card.id, id);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * SP-3 (CL-8): Build with both under the card's Now callout, from the start
 * — the two builds side by side, each with its live state ("Codex ·
 * building · 3m"), when it started, Open session and Build done while it
 * runs; then its changes, checks and the Challenger's verdict. The
 * comparison and the pick are the same grid once both are done (Pick stays
 * off until then). The terminals stay in the run section (`BuildBothStep`).
 */
export function BuildBothCards({
  card,
  onOpenSession,
}: {
  card: KanbanCard;
  /** Shows that build's session: its lane in the run section, opened. */
  onOpenSession: (lane: BuildLaneId) => void;
}) {
  const ws = card.workspaceId;
  const bb = card.buildBoth!;
  const busy = useBuildBoth((s) => s.busy[card.id]) ?? null;
  const { compareAgain, pick, stop } = useBuildBoth.getState();
  const done = finishLane;
  const actors = useLaneActors(card);
  const words = compareWords(bb);
  const judge = judgeWords(bb.compare);
  const legend = compareLegend(bb);
  const recommended = bb.compare?.status === "done" || bb.compare?.status === "decided" ? bb.compare.recommended ?? null : null;

  async function onPick(id: BuildLaneId) {
    const picked = laneVendorName(laneOf(bb, id), id);
    const other = laneOf(bb, id === "a" ? "b" : "a");
    const otherName = laneVendorName(other, id === "a" ? "b" : "a");
    const against = recommended && recommended !== id ? ` The Reviewer recommended ${otherName}'s.` : "";
    if (
      !(await confirmSheet({
        title: `Pick ${picked}'s build?`,
        body:
          `${picked}'s copy of the repository, its branch and its session become this card's, and its Finish and check runs now: its checks and the Reviewer's full review follow.` +
          ` ${otherName}'s copy goes to the trash for 7 days and its branch${other ? ` ${other.branchName}` : ""} is kept.${against}`,
        confirmLabel: `Pick ${picked}'s build`,
      }))
    ) {
      return;
    }
    await pick(ws, card.id, id);
  }

  async function onStopBoth() {
    if (
      !(await confirmSheet({
        title: "Stop building with both?",
        body: "Both sessions end. The card keeps Claude's copy of the repository, and Start build builds it with one Builder. Codex's copy goes to the trash for 7 days; its branch is kept.",
        confirmLabel: "Stop building with both",
      }))
    ) {
      return;
    }
    await stop(ws, card.id);
  }

  return (
    <section
      className="ux-card-outcome-block"
      aria-label="Comparison"
      data-ply-build-both-compare={bb.compare?.status ?? "waiting"}
      tabIndex={-1}
    >
      <Callout
        kind={words.tone === "warn" ? "warn" : "info"}
        title={words.title}
        text={
          <>
            {words.text}
            {legend && (
              <span className="ux-card-muted" data-ply-build-both-legend="">
                {" "}
                {legend}
              </span>
            )}
            {words.reasons.length > 0 && (
              <ul className="ux-card-findings">
                {words.reasons.map((r) => (
                  <li key={r}>
                    <InlineMd text={r} />
                  </li>
                ))}
              </ul>
            )}
          </>
        }
        actions={
          bb.compare?.status !== "running" && bb.lanes.every((l) => l.done) ? (
            <CBtn tone="quiet" disabled={busy !== null} onClick={() => void compareAgain(ws, card.id)}>
              Compare again
            </CBtn>
          ) : undefined
        }
      />
      {judge && (
        <p className="ux-card-muted" data-ply-build-both-judge="">
          {judge}
        </p>
      )}
      {/* CL-8: the two builds side by side, each with its own Pick;
          stacked when the column is narrow (a container query). */}
      <div className="ux-both-builds">
        <div className="ux-both-cards" data-ply-build-both-cards="">
          {LANES.map((id) => (
            <BuildCard
              key={id}
              card={card}
              id={id}
              recommended={recommended === id}
              actor={actors[id]}
              busy={busy}
              onPick={() => void onPick(id)}
              onOpenSession={() => onOpenSession(id)}
              onDone={() => void done(ws, card.id, id)}
            />
          ))}
        </div>
      </div>
      {bb.compare?.excerpt && (
        <Details summary="The Reviewer's answer">
          <MarkdownText text={bb.compare.excerpt} />
        </Details>
      )}
      <div className="ux-card-section-actions">
        <CBtn tone="quiet" disabled={busy !== null} onClick={() => void onStopBoth()}>
          Stop building with both…
        </CBtn>
      </div>
    </section>
  );
}

function LanePanel({
  card,
  id,
  shown,
  actor,
  asksTrust = false,
  stoppedWords = null,
  busy,
  onStartLanes,
  onResume,
  onStartFresh,
  onDone,
  onStop,
}: {
  card: KanbanCard;
  id: BuildLaneId;
  shown: boolean;
  /** CL-11: what its session is doing (`laneActor`). */
  actor: ActorWords;
  /** v1.154.1 (walk G1): its session waits on the folder-trust question. */
  asksTrust?: boolean;
  /** UX P-F: the sentence of Claude's usage limit or bypass warning
   *  stopping its session, if one does. */
  stoppedWords?: string | null;
  busy: string | null;
  onStartLanes: () => Promise<void>;
  onResume: () => Promise<void>;
  onStartFresh: () => Promise<void>;
  onDone: () => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const lane = laneOf(card.buildBoth, id);
  if (!lane) return null;
  const name = laneVendorName(lane, id);
  // 1.169.0 walk: "builds on gpt-6-astra with high effort".
  const laneSentence = modelSentenceWords(lane.model);
  const stage = laneStage(card, id);
  const setup = laneSetup(card, id);
  const checks = laneChecksLine(lane);
  const comparing = card.buildBoth?.compare?.status === "running";
  const canDone = lane.startedAt != null && !lane.failed && !comparing;
  // Hidden, never unmounted: each terminal stays attached to its session.
  // SP-4: the lane not shown takes no room and keeps its laid-out width,
  // invisible and inert (`.ux-card-slot--closed`'s way) — never
  // `display: none`, whose zero size the fit addon would hand the PTY, and
  // never the `hidden` attribute, which `.ux-card-session`'s own display
  // overrode (Codex's tab showed Claude's terminal).
  return (
    <div
      className={shown ? "ux-both-lane" : "ux-both-lane ux-both-lane--hidden"}
      data-ply-build-both-lane={id}
      data-ply-build-both-stage={stage}
      data-ply-build-both-lane-hidden={shown ? undefined : ""}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
    >
      <div className="ux-card-session ux-both-lane-body">
        <p className="ux-card-session-line">
          <StateWord state={actor.dot} live={actor.dot === "running"}>
            {actorStateWords(actor)}
          </StateWord>
          <span>
            {name} builds{laneSentence ? ` on ${laneSentence}` : ""}
          </span>
          {lane.bypass && <span title="Started with the AI's own permission bypass">without asking</span>}
        </p>
        {/* A build started anyway keeps saying so once it runs (F4). */}
        {setup && setup.state !== "done" && (lane.startedAt == null || setup.state === "skipped") && (
          <WorktreeSetupNote card={card} busy={busy !== null} onStart={onStartLanes} lane={id} record={setup} />
        )}
        {asksTrust && <Callout kind="warn" text={trustHelper(lane.vendor)} />}
        {!asksTrust && stoppedWords && <Callout kind="warn" text={stoppedWords} />}
        {lane.failed && (
          <p className="ux-card-muted">
            {showBackendText(lane.failed)}. <RepairFor texts={[lane.failed]} />
          </p>
        )}
        {checks && <p className="ux-card-muted">{checks}</p>}
        {lane.ptyId ? (
          <BuilderSession workspaceId={card.workspaceId} cardId={laneKey(card.id, id)} ptyId={lane.ptyId} vendor={lane.vendor} />
        ) : lane.startedAt != null && !lane.failed && lane.resumeFailed ? (
          <p className="ux-card-muted">{resumeFailedHelper(lane.vendor)}</p>
        ) : lane.startedAt != null && !lane.failed ? (
          <p className="ux-card-muted">
            {name}'s session ended. Its copy of the repository is intact; Resume opens a new session that continues the same conversation.
          </p>
        ) : null}
        <div className="ux-card-section-actions">
          {lane.startedAt != null && !lane.failed && !lane.ptyId && (
            <CBtn disabled={busy !== null} onClick={() => void onResume()}>
              Resume
            </CBtn>
          )}
          {lane.startedAt != null && !lane.failed && !lane.ptyId && lane.resumeFailed && (
            <CBtn
              disabled={busy !== null}
              title="A new session in this build's folder with the brief sent again. Its changes and saved work stay."
              onClick={() => void onStartFresh()}
            >
              {busy === "Start fresh" ? "Starting…" : "Start fresh"}
            </CBtn>
          )}
          {canDone && (
            <CBtn
              disabled={busy !== null}
              title={
                lane.done
                  ? "Saves this build again (after more changes) and runs its checks; the two builds are compared again."
                  : "Saves this build and runs the card's checks on it."
              }
              onClick={() => void onDone()}
            >
              {busy === FINISH_LABEL ? FINISH_BUSY_LABEL : lane.done ? FINISH_AGAIN_LABEL : FINISH_LABEL}
            </CBtn>
          )}
          {!lane.done && !lane.failed && (
            <CBtn tone="quiet" disabled={busy !== null || comparing} onClick={() => void onStop()}>
              Stop this build…
            </CBtn>
          )}
        </div>
      </div>
    </div>
  );
}

/** CL-8: a build's changes, read once per snapshot (its Build done's sha)
 *  for as long as the card is open in this window. */
const laneDiffs = new Map<string, Promise<LaneDiff | null>>();

function useLaneDiff(workspaceId: string, cardId: string, lane: BuildLaneId, sha: string | null) {
  const [state, setState] = useState<{ sha: string; diff: LaneDiff | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!sha) return;
    let live = true;
    const key = [workspaceId, cardId, lane, sha].join("\u0000");
    let read = laneDiffs.get(key);
    if (!read) {
      read = buildBothLaneDiff(workspaceId, cardId, lane).then((d) => d ?? null);
      laneDiffs.set(key, read);
      // A failed or empty read is tried again next time the card is drawn.
      read.then(
        (d) => {
          if (!d) laneDiffs.delete(key);
        },
        () => laneDiffs.delete(key),
      );
    }
    read.then(
      (diff) => live && setState({ sha, diff, error: null }),
      (e: unknown) => live && setState({ sha, diff: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, cardId, lane, sha]);
  return state && state.sha === sha ? state : null;
}

/** CL-8: one build's card — its state, its changes, its checks, the
 *  Challenger's summary and findings of it, Open the diff, and its Pick. */
function BuildCard({
  card,
  id,
  recommended,
  actor,
  busy,
  onPick,
  onOpenSession,
  onDone,
}: {
  card: KanbanCard;
  id: BuildLaneId;
  recommended: boolean;
  /** CL-11: what its session is doing (`laneActor`). */
  actor: ActorWords;
  busy: string | null;
  onPick: () => void;
  /** SP-3: shows its session in the run section. */
  onOpenSession: () => void;
  /** SP-3: its Build done, as its lane's. */
  onDone: () => void;
}) {
  const bb = card.buildBoth!;
  const lane = laneOf(bb, id);
  const name = laneVendorName(lane, id);
  const sha = lane?.done?.sha ?? null;
  const read = useLaneDiff(card.workspaceId, card.id, id, sha);
  const [diffOpen, setDiffOpen] = useState(false);
  const verdict = laneVerdict(bb, id);
  const findings = laneFindingsWords(verdict);
  const checks = laneChecksLine(lane);
  const changes = sha ? (read?.error ? "Its changes couldn't be read." : read ? laneDiffLine(read.diff) : "Reading its changes…") : null;
  const offer = pickOffer(bb, id);
  const lean = laneLeanLabel(bb, id);
  // SP-3: while it builds, when it started and its two presses — the
  // session, and Finish and check (as its lane offers it; nothing while comparing).
  const building = lane != null && lane.startedAt != null && !lane.done && !lane.failed;
  const comparing = bb.compare?.status === "running";
  return (
    <article
      className={recommended ? "ux-both-card ux-both-card--recommended" : "ux-both-card"}
      aria-label={`${name}'s build`}
      data-ply-build-both-card={id}
      data-ply-build-both-recommended={recommended ? "" : undefined}
    >
      <p className="ux-both-card-head">
        <span className="ux-both-card-title">{name}'s build</span>
        {lean && <span className="ux-both-recommended">{lean}</span>}
      </p>
      <p className="ux-card-session-line">
        <StateWord state={actor.dot} live={actor.dot === "running"}>
          {actorStateWords(actor)}
        </StateWord>
        <span>{laneModelWords(lane)}</span>
      </p>
      {building && lane?.startedAt != null && (
        <p className="ux-card-muted" data-ply-build-both-started={id}>
          Started {ago(Date.now() - lane.startedAt)}
        </p>
      )}
      {changes && (
        <p className="ux-card-muted" data-ply-build-both-changes={id}>
          {changes}
        </p>
      )}
      {read?.error && (
        <Details summary="What went wrong">
          <pre className="ux-output">{read.error}</pre>
        </Details>
      )}
      {checks && <p className="ux-card-muted">{checks}</p>}
      {verdict?.summary && (
        <p className="ux-both-summary">
          <InlineMd text={verdict.summary} />
        </p>
      )}
      {findings && (
        <div className="ux-both-findings" data-ply-build-both-findings={id}>
          <p className="ux-both-label">{findings.title}</p>
          {findings.items.length > 0 && (
            <ul className="ux-card-checklist">
              {findings.items.map((f) => (
                <li key={f}>
                  <InlineMd text={f} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="ux-both-card-actions">
        {building && lane?.ptyId && (
          <CBtn tone="quiet" onClick={onOpenSession} data-ply-build-both-open={id}>
            {/* 1.172.0 D2 (CP-24): one of the two Builders' sessions. */}
            Open this Builder
          </CBtn>
        )}
        {building && (
          <CBtn
            disabled={busy !== null || comparing}
            title="Saves this build and runs the card's checks on it."
            onClick={onDone}
            data-ply-build-both-done={id}
          >
            {busy === FINISH_LABEL ? FINISH_BUSY_LABEL : FINISH_LABEL}
          </CBtn>
        )}
        {sha && (
          <CBtn
            tone="quiet"
            disabled={!read?.diff || read.diff.files.length === 0}
            onClick={() => setDiffOpen(true)}
            data-ply-build-both-diff={id}
          >
            See the changes
          </CBtn>
        )}
        <CBtn
          tone={recommended ? "strong" : "quiet"}
          disabled={!offer.enabled || busy !== null}
          title={`Continue this card with ${name}'s build.`}
          reason={offer.reason ?? null}
          onClick={onPick}
          data-ply-build-both-pick={id}
        >
          {busy === "Pick" ? "Picking…" : `Pick ${name}'s build`}
        </CBtn>
      </div>
      {/* On the page, not in the run section: a sheet over everything. */}
      {diffOpen && read?.diff && createPortal(
        <Sheet
          title={`${name}'s build — its changes`}
          size="wide"
          lede={laneDiffLine(read.diff) ?? undefined}
          onClose={() => setDiffOpen(false)}
          actions={
            <CBtn tone="quiet" onClick={() => setDiffOpen(false)}>
              Close
            </CBtn>
          }
        >
          {read.diff.cut && (
            <Callout
              kind="warn"
              text={`These changes are longer than 4 MiB, so ${read.diff.files.filter((f) => f.cut).map((f) => f.path).join(", ") || "some files"} show${read.diff.files.filter((f) => f.cut).length === 1 ? "s" : ""} no lines here. A terminal in the card's copy shows all of it.`}
            />
          )}
          <DiffFiles cardId={card.id} files={read.diff.files} />
        </Sheet>,
        document.body,
      )}
    </article>
  );
}
