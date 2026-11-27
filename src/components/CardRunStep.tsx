import { useEffect } from "react";
import type { KanbanCard, MailboxEntry } from "../ipc";
import { useSwarms } from "../store/swarmStore";
import { useTiles } from "../store/tileStore";
import { useAgents } from "../store/agentStore";
import { pushToast } from "../store/toastStore";
import { EMPTY_ARRAY } from "../lib/empties";
import { confirmSheet } from "../store/confirmStore";
import { isCardSwarmQueued } from "../lib/cardLifecycle";
import { RoleStatusStrip, MailboxFeed } from "./SwarmRunViews";
import { OverlapWarnings } from "./OverlapWarnings";
import { BuilderRunStep, type StartHold } from "./BuilderRunStep";
import { BuildBothStep } from "./BuildBothStep";
import { isUndecided } from "../lib/buildBoth";
import { CBtn, StateWord } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

const EMPTY_MAILBOX: MailboxEntry[] = EMPTY_ARRAY;

/**
 * v1.66.0 (UX revamp step 2): the lifecycle's Run step — live progress
 * INSIDE the card panel, ending the mid-run hop to the Swarm tab
 * (UX_BRIEF pain point #4). Reuses the Swarm tab's `RoleStatusStrip` +
 * `MailboxFeed` scoped to the card's linked swarm; live terminal output
 * stays on the tile grid (resolved call #3 — one xterm host per PTY),
 * reached via the strip's "view run →" jump or the single-agent jump
 * below. (v1.84.0: the Swarm tab is gone; the shared views live in
 * SwarmRunViews.tsx.)
 */
export function CardRunStep({
  card,
  resumeInNow = false,
  startHold,
}: {
  card: KanbanCard;
  /** The Now callout offers Resume and Start fresh (a closed session). */
  resumeInNow?: boolean;
  /** 1.174.0 C4 (G3a walk): the card page's start rules, so this Start
   *  build holds as Now's does (`BuilderStartPanel`). */
  startHold?: StartHold;
}) {
  // v1.106.0 (Builder/Challenger): a card with a Builder session — or one
  // that has never run at all — takes the live-session face. The swarm
  // face below stays for cards dispatched through the (Advanced) role
  // chain until v1.110 retires it from the primary flow.
  // SL-6: built by both and not picked yet — the two builds and the pick.
  if (isUndecided(card)) return <BuildBothStep card={card} />;
  if (card.builder) return <BuilderRunStep card={card} resumeInNow={resumeInNow} startHold={startHold} />;
  return <SwarmRunStep card={card} startHold={startHold} />;
}

function SwarmRunStep({ card, startHold }: { card: KanbanCard; startHold?: StartHold }) {
  const ws = card.workspaceId;
  const swarmId = card.linkedSwarmId ?? null;
  const swarm = useSwarms((s) =>
    swarmId
      ? s.byWorkspace[ws]?.swarms.find((x) => x.id === swarmId) ?? null
      : null,
  );
  const mailbox = useSwarms((s) =>
    swarmId
      ? s.byWorkspace[ws]?.mailboxes[swarmId] ?? EMPTY_MAILBOX
      : EMPTY_MAILBOX,
  );
  const mailboxCached = useSwarms((s) =>
    swarmId ? !!s.byWorkspace[ws]?.mailboxes[swarmId] : false,
  );
  const abort = useSwarms((s) => s.abort);

  // Lazy-load the swarm record + mailbox on first render (the
  // LinkedBrainstormBanner pattern — a swarm from a prior session may
  // not be in the FE cache yet).
  useEffect(() => {
    if (swarmId && !mailboxCached) {
      void useSwarms.getState().loadMailbox(ws, swarmId);
    }
  }, [swarmId, mailboxCached, ws]);
  useEffect(() => {
    if (swarmId && !swarm) {
      void useSwarms.getState().refreshSwarm(ws, swarmId);
    }
  }, [swarmId, swarm, ws]);

  if (!swarmId && !card.linkedRunId) {
    // Queue-eligible = In Progress with a template, waiting for a
    // card-swarm slot (v1.30.0 derived queue). pump_card_queue starts it
    // when a slot frees; the row updates via kanban://changed.
    const queued = isCardSwarmQueued(card);
    if (queued) {
      return (
        <p className="ux-card-muted">
          In line for a free slot; it starts by itself when one frees up.
        </p>
      );
    }
    return <BuilderRunStep card={card} startHold={startHold} />;
  }

  if (swarmId) {
    // GH #260: the swarm's run on the one scale.
    return (
      <div className="ux-card-outcome">
        {swarm ? (
          <>
            <section className="ux-card-outcome-block" aria-label="Goal">
              <h3 className="ux-card-subheading">Goal</h3>
              <p className="ux-card-plain">{swarm.goal}</p>
            </section>
            <RoleStatusStrip workspaceId={ws} swarm={swarm} mailbox={mailbox} />
            {/* v1.86.0: live overlap awareness while the run is going —
                the same check the result makes before a merge. */}
            <OverlapWarnings workspaceId={ws} cardId={card.id} />
            <MailboxFeed entries={mailbox} workspaceId={ws} swarmId={swarmId} />
            {(swarm.status === "running" || swarm.status === "suspended") && (
              <div className="ux-card-section-actions">
                <CBtn
                  tone="quiet"
                  onClick={async () => {
                    if (
                      await confirmSheet({
                        title: "Stop this multi-AI run?",
                        body: "Its agents stop where they are.",
                        confirmLabel: "Stop the run",
                        destructive: true,
                      })
                    ) {
                      void abort(ws, swarmId).catch((e) =>
                        pushErrorToast("The run couldn't be stopped", e, { then: "It may still be running. Try again." }),
                      );
                    }
                  }}
                >
                  Stop the run…
                </CBtn>
              </div>
            )}
          </>
        ) : (
          <p className="ux-card-muted">Loading the run…</p>
        )}
      </div>
    );
  }

  return <SingleRunSummary card={card} />;
}

/** Single-agent-run variant: status + a jump to the live tile (the tile
 *  grid is the terminal surface). */
function SingleRunSummary({ card }: { card: KanbanCard }) {
  const ws = card.workspaceId;
  const runId = card.linkedRunId!;
  const tile = useTiles((s) =>
    s.byWorkspace[ws]?.tiles.find((t) => t.runId === runId),
  );
  const setSelectedRun = useAgents((s) => s.setSelectedRun);

  function jump() {
    if (tile) {
      useTiles.getState().setExpanded(ws, tile.id);
    } else {
      setSelectedRun(ws, runId);
      pushToast({
        kind: "info",
        title: "Run tile closed",
        body: "The tile for this run has been cleaned up. History has its record; live runs stay in Terminals.",
      });
    }
  }

  const status = card.lastRunStatus ?? "running";
  return (
    <p className="ux-card-proposal">
      <StateWord
        state={status === "running" ? "running" : status === "success" ? "done" : "aborted"}
        live={status === "running"}
      >
        {RUN_STATUS_WORDS[status] ?? status}
      </StateWord>
      <CBtn tone="quiet" onClick={jump} title="Expand the run's live tile in Terminals">
        Show the run
      </CBtn>
    </p>
  );
}

const RUN_STATUS_WORDS: Record<string, string> = {
  running: "Running",
  success: "Finished",
  failed: "Failed",
  aborted: "Stopped",
  rate_limited: "Rate-limited",
};
