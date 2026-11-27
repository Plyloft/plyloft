import { showBackendText } from "../lib/backendMarks";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  onPlanMessages,
  onPlanState,
  planExchangeScreen,
  type ChatAttachment,
  type ChatVendor,
  type KanbanCard,
  type PlanExchange,
  type PlanLaneState,
} from "../ipc";
import { attachmentFacts, attachmentLabels, chatVendorName } from "../lib/chatView";
import { isFolderTrustRefusal } from "../lib/claudeReviewTrust";
import {
  anotherRound,
  CODEX_NO_TERMINAL,
  codexTurnRunning,
  decisionHeading,
  latestPlan,
  laneTokenLine,
  lineupLine,
  pauseActions,
  pauseTitle,
  planStateLine,
  planThread,
  PLAN_TWO_AIS_LABEL,
  planViewOnly,
  replaceConfirmNeeded,
  showTerminalLane,
} from "../lib/planExchangeView";
import { twoAisBlocker, vendorReadiness } from "../lib/vendorReadiness";
import { chatKey, useChat } from "../store/chatStore";
import { confirmSheet } from "../store/confirmStore";
import { useDoctor } from "../store/doctorStore";
import { useKanban } from "../store/kanbanStore";
import { formRequestFresh, usePlanExchange } from "../store/planExchangeStore";
import { ChatItem } from "./ChatThread";
import { ChatTerminal } from "./ChatTerminal";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { MarkdownText } from "./MarkdownText";
import { Callout, CBtn, FailureText } from "./ux";
import { failureWith } from "../lib/plainError";
import type { Failure } from "../lib/failure";

/** What the card page tells the Plan mode. */
export type PlanContext = {
  /** The card is unbuilt (draft or ready) and not under intake. */
  offered: boolean;
  /** The card's effective Builder vendor: it proposes when both are ready. */
  preferred: ChatVendor;
  /** The card's plan is one the member edited by hand. */
  dispatchPromptEditedAt: number | null;
  archived: boolean;
  /** Why the card can't be planned now (its blockers), or null. */
  heldReason: string | null;
};

const EMPTY_ATTACHMENTS: ChatAttachment[] = [];
const EMPTY_LANES: PlanLaneState[] = [];

export { showTerminalLane };

/**
 * Plan with two AIs (part 2): the Chat tab's Plan mode. A start form, the
 * exchange as one labelled thread ("Claude proposes", "Codex critiques",
 * "Claude revises" — with one vendor in both roles, its name twice), the
 * state line, the decision bar once the rounds are done, the pauses with
 * their ways on, both sessions' tokens, and Earlier plans. The driver is in
 * Rust; this view presses buttons and draws the state.
 */
export function PlanExchangePanel({
  workspaceId,
  cardId,
  context,
  chatVendor = "claude",
}: {
  workspaceId: string;
  cardId: string;
  context: PlanContext;
  /** 1.174.0 E10: the AI the Chat tab asks, named in the attachments hint. */
  chatVendor?: ChatVendor;
}) {
  const key = chatKey(workspaceId, cardId);
  const view = usePlanExchange((s) => s.byKey[key]);
  const snapshot = view?.snapshot ?? null;
  const current = snapshot?.current ?? null;
  const attachments = useChat((s) => s.byKey[key]?.attachments ?? EMPTY_ATTACHMENTS);
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  // QoL 1.168 block 8 (A5): plain words, the raw text behind Details.
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  /** Start's own wait: the form says "Starting…" for it only, never while
   *  another action (Use this plan) is still settling (walk of c26f197e). */
  const [starting, setStarting] = useState(false);

  // Follow the card's exchange.
  useEffect(() => {
    let cancelled = false;
    const offs: Array<() => void> = [];
    const mine = (e: { workspaceId: string; cardId: string }) => e.workspaceId === workspaceId && e.cardId === cardId;
    void (async () => {
      const offState = await onPlanState((e) => {
        if (mine(e)) {
          usePlanExchange.getState().applyState(e);
          return;
        }
        // Another card's exchange moved on (it finished, paused, or began):
        // this card's "Two AIs are planning … now" is read again, so Start
        // and Another round don't stay off after it ends.
        const elsewhere = usePlanExchange.getState().byKey[chatKey(workspaceId, cardId)]?.snapshot?.runningElsewhere;
        const running = e.current?.status === "running";
        if (Boolean(elsewhere) !== running) void usePlanExchange.getState().load(workspaceId, cardId).catch(() => {});
      });
      const offMessages = await onPlanMessages((e) => {
        if (mine(e)) usePlanExchange.getState().applyMessages(e);
      });
      if (cancelled) {
        offState();
        offMessages();
        return;
      }
      offs.push(offState, offMessages);
    })();
    // Read again when Plan mode opens: what changed while the Chat showed
    // (another card's exchange ended) is current.
    if (usePlanExchange.getState().byKey[chatKey(workspaceId, cardId)]?.loaded) {
      void usePlanExchange.getState().load(workspaceId, cardId).catch(() => {});
    }
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, [workspaceId, cardId]);

  async function act(what: () => Promise<unknown>, failed: string) {
    setBusy(true);
    setError(null);
    try {
      await what();
    } catch (e) {
      setError(failureWith(failed, e));
    } finally {
      setBusy(false);
    }
  }

  async function accepted(text: string | null) {
    if (replaceConfirmNeeded(context.dispatchPromptEditedAt)) {
      const yes = await confirmSheet({
        title: "Replace the plan you edited on this card?",
        body: "Your edited plan is replaced by this one. The two AIs' thread stays under Earlier plans.",
        confirmLabel: "Replace it",
      });
      if (!yes) return;
    }
    await act(async () => {
      // The card was written in the backend: read it, never write it here —
      // before the exchange's end shows, so the card goes straight from
      // "Plan ready to review" to its plan.
      await usePlanExchange
        .getState()
        .accept(workspaceId, cardId, text, (card: KanbanCard) => useKanban.getState().loadFromDisk(card.workspaceId, true));
    }, "The plan wasn't used");
  }

  if (!view?.loaded) {
    return <p className="ux-chat-scope">Reading this card's plans…</p>;
  }

  return (
    <div className="ux-plan" data-ply-plan={cardId} data-ply-plan-status={current?.status ?? "none"}>
      <p className="ux-chat-scope">
        Two AI sessions plan this card together: one writes the plan, the other critiques it, the first revises it.
        Discussion only: neither can change anything. You decide at the end.
      </p>
      {snapshot?.readOnly && (
        <Callout kind="warn" title="Saved by a newer Plyloft" text="These plans are shown as they are. Update Plyloft to go on with them." />
      )}
      {error && (
        <div className="ux-chat-error" role="alert">
          <FailureText failure={error} />
        </div>
      )}
      {current ? (
        <ExchangeView
          workspaceId={workspaceId}
          cardId={cardId}
          exchange={current}
          context={context}
          busy={busy}
          onAct={act}
          onAccept={accepted}
        />
      ) : (
        <StartForm
          workspaceId={workspaceId}
          cardId={cardId}
          context={context}
          attachments={attachments}
          chatVendor={chatVendor}
          blocker={twoAisBlocker(readiness) ?? context.heldReason ?? (snapshot?.runningElsewhere ? `Two AIs are planning "${snapshot.runningElsewhere}" now. Try again when they finish.` : null)}
          line={lineupLine(context.preferred, readiness)}
          busy={busy}
          starting={starting}
          onStart={(ask, ids) => {
            setStarting(true);
            void act(
              () => usePlanExchange.getState().start(workspaceId, cardId, context.preferred, ask, ids),
              "The plan didn't start",
            ).finally(() => setStarting(false));
          }}
        />
      )}
      {(snapshot?.earlier.length ?? 0) > 0 && <EarlierPlans exchanges={snapshot!.earlier} />}
    </div>
  );
}

function StartForm({
  context,
  attachments,
  chatVendor,
  blocker,
  line,
  busy,
  starting,
  onStart,
}: {
  workspaceId: string;
  cardId: string;
  context: PlanContext;
  attachments: ChatAttachment[];
  chatVendor: ChatVendor;
  blocker: string | null;
  line: string | null;
  busy: boolean;
  starting: boolean;
  onStart: (ask: string, attachmentIds: string[]) => void;
}) {
  const [ask, setAsk] = useState("");
  const [left, setLeft] = useState<Set<string>>(new Set());
  const labels = useMemo(() => attachmentLabels(attachments), [attachments]);
  if (!context.offered) {
    return (
      <p className="ux-chat-empty" data-ply-plan-not-offered="">
        {PLAN_TWO_AIS_LABEL} is for a card that hasn't been built yet, with no planning conversation under way.
      </p>
    );
  }
  const chosen = attachments.filter((a) => !left.has(a.id)).map((a) => a.id);
  return (
    <form
      className="ux-plan-form"
      aria-label={PLAN_TWO_AIS_LABEL}
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocker && !busy) onStart(ask, chosen);
      }}
    >
      <label className="ux-card-field ux-plan-field">
        <span className="ux-card-field-label">
          What should the plan cover?
          <span className="ux-card-field-note">Optional — the card's brief is sent anyway.</span>
        </span>
        <textarea className="ux-chat-input" rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} />
      </label>
      {attachments.length > 0 && (
        <fieldset className="ux-plan-files">
          <legend>The chat's files to send</legend>
          {attachments.map((a) => (
            <label key={a.id} className="ux-plan-file">
              <input
                type="checkbox"
                checked={!left.has(a.id)}
                onChange={(e) =>
                  setLeft((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.delete(a.id);
                    else next.add(a.id);
                    return next;
                  })
                }
              />
              <span>
                {labels.get(a.id) ?? a.name} · {attachmentFacts(a)}
              </span>
            </label>
          ))}
          <p className="ux-chat-hint">
            Files you add when you ask {chatVendorName(chatVendor)} can be sent here. The card's own attachments always go.
          </p>
        </fieldset>
      )}
      {line && !blocker && (
        <p className="ux-plan-lineup" data-ply-plan-lineup="">
          {line}
        </p>
      )}
      {blocker && (
        <p className="ux-plan-blocker" role="status" data-ply-plan-blocker="">
          {blocker}
        </p>
      )}
      <div className="ux-chat-actions">
        <CBtn type="submit" tone={blocker ? "ghost" : "accent"} disabled={Boolean(blocker) || busy} title={blocker ?? undefined}>
          {starting ? "Starting…" : "Start"}
        </CBtn>
      </div>
    </form>
  );
}

/** Per card (`chatKey`): the Plan request whose decision bar was brought
 *  into view. */
const revealedRequests = new Map<string, number>();

/** Focus sits in a text field, a select or an editor outside `bar`. */
function typingElsewhere(bar: HTMLElement): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body || bar.contains(active)) return false;
  return active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
}

function ExchangeView({
  workspaceId,
  cardId,
  exchange,
  context,
  busy,
  onAct,
  onAccept,
}: {
  workspaceId: string;
  cardId: string;
  exchange: PlanExchange;
  context: PlanContext;
  busy: boolean;
  onAct: (what: () => Promise<unknown>, failed: string) => Promise<void>;
  onAccept: (text: string | null) => Promise<void>;
}) {
  const key = chatKey(workspaceId, cardId);
  const snapshot = usePlanExchange((s) => s.byKey[key]?.snapshot);
  const lanes = snapshot?.lanes ?? EMPTY_LANES;
  const waiting = snapshot?.waitingForPrompt ?? false;
  const same = exchange.proposer === exchange.critic;
  const thread = useMemo(() => planThread(exchange), [exchange]);
  const plan = latestPlan(exchange);
  const more = anotherRound(exchange, snapshot?.runningElsewhere ?? null);
  const actions = pauseActions(exchange, context.archived);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [terminalShown, setTerminalShown] = useState(false);
  // The Claude session whose turn it is (with Claude in both roles, the
  // critic's during a critique): the one `plan_exchange_screen` paints, so
  // the terminal attaches to its PTY. On a Codex side's turn there is none
  // (Codex runs without a terminal): an open terminal says so, and comes
  // back on Claude's session when its turn comes.
  const claudeLane = showTerminalLane(exchange, lanes);
  const codexTurn = codexTurnRunning(exchange);
  const store = usePlanExchange.getState();
  const emptyMap = useMemo(() => new Map<string, ChatAttachment>(), []);
  const emptyLabels = useMemo(() => new Map<string, string>(), []);

  useEffect(() => {
    if (!claudeLane?.ptyId && !codexTurn) setTerminalShown(false);
  }, [claudeLane?.ptyId, codexTurn]);

  // Opened to decide (the Inbox's "Plan ready to review", the card's
  // "Review the plan" — both a fresh Plan request): the decision bar sits
  // below the thread, so it is scrolled into view and takes focus, once per
  // request (Mac walk of 1f8816bc). The request counts as used when the
  // frame runs, not when it is scheduled: StrictMode's second effect (dev
  // builds) cancels the first frame. It is kept per card, not per mount, so
  // leaving the Plan view and coming back inside the request's 10 s doesn't
  // move the page again; and a member typing elsewhere (the run ended while
  // they were in the card's notes) keeps their caret.
  const request = usePlanExchange((s) => s.formRequests[key] ?? 0);
  const decisionRef = useRef<HTMLElement | null>(null);
  const deciding = exchange.status === "awaitingMember";
  useEffect(() => {
    if (!deciding || !formRequestFresh(request) || revealedRequests.get(key) === request) return;
    // Two frames: the card page reveals the Chat section in a frame of its
    // own, scheduled after this one (a parent's effect runs after its
    // child's), with `block: "start"`. Scrolled in the first frame, the bar
    // was scrolled away again by it — invisible whenever the plan's
    // terminal is open above it (Windows walk of c26f197e, step 3).
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const bar = decisionRef.current;
        if (!bar) return;
        revealedRequests.set(key, request);
        if (typingElsewhere(bar)) return;
        bar.scrollIntoView?.({ block: "nearest" });
        bar.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [deciding, request, key]);

  const pause = exchange.pause;
  const trust = pause?.kind === "trust" || isFolderTrustRefusal(pause?.reason ?? null);

  return (
    <>
      <div className="ux-chat-bar">
        <span className="ux-chat-state" data-ply-plan-state="">
          {planStateLine(exchange, waiting)}
        </span>
        {exchange.status === "running" && (
          <CBtn tone="danger" onClick={() => void onAct(() => store.stop(workspaceId, cardId), "The plan wasn't stopped")}>
            Stop
          </CBtn>
        )}
        {(claudeLane?.ptyId || (codexTurn && terminalShown)) && (
          <CBtn tone="quiet" aria-expanded={terminalShown} onClick={() => setTerminalShown((v) => !v)}>
            {terminalShown ? "Hide terminal" : "Show terminal"}
          </CBtn>
        )}
      </div>
      {terminalShown && claudeLane?.ptyId && (
        <ChatTerminal
          workspaceId={workspaceId}
          cardId={cardId}
          ptyId={claudeLane.ptyId}
          readOnly
          rights={planViewOnly(claudeLane.role)}
          readScreen={() => planExchangeScreen(workspaceId, cardId)}
        />
      )}
      {terminalShown && !claudeLane?.ptyId && codexTurn && (
        <p className="ux-chat-hint" data-ply-plan-no-terminal="">
          {CODEX_NO_TERMINAL}
        </p>
      )}
      {exchange.ask && <p className="ux-chat-meta">Your ask: {exchange.ask}</p>}

      {pause && exchange.status === "paused" && (
        <>
          {trust ? (
            <ClaudeReviewTrustStep refused subject="chat" workspaceId={workspaceId} density="dense" />
          ) : (
            <Callout
              kind={pause.kind === "stopped" || pause.kind === "quit" ? "info" : "warn"}
              title={pauseTitle(pause.kind)}
              text={showBackendText(pause.reason)}
            />
          )}
          <div className="ux-chat-actions" data-ply-plan-pause-actions="">
            <CBtn
              tone="accent"
              disabled={!actions.retry || busy}
              title={context.archived ? "Restore the card to go on with its plan." : undefined}
              onClick={() => void onAct(() => store.retry(workspaceId, cardId), "The turn wasn't retried")}
            >
              Retry this turn
            </CBtn>
            {actions.useLatest && (
              <CBtn tone="quiet" disabled={busy} onClick={() => void onAccept(null)}>
                Use the latest plan
              </CBtn>
            )}
            <CBtn tone="ghost" disabled={busy} onClick={() => void onAct(() => store.discard(workspaceId, cardId), "The plan wasn't discarded")}>
              Discard
            </CBtn>
          </div>
        </>
      )}

      <ol className="ux-chat-log" aria-label="The two AIs' plan" data-ply-plan-thread="">
        {thread.map((item) =>
          item.kind === "turn" ? (
            <li key={item.key} className="ux-plan-turn" data-ply-plan-turn={item.turn.role}>
              <strong>{item.label}</strong>
              {item.round ? <span className="ux-chat-meta"> · {item.round}</span> : null}
              {item.turn.role === "critique" && item.turn.verdict && (
                <span className="ux-chat-meta">
                  {" "}
                  · {item.turn.verdict === "ready" ? "Verdict: ready" : item.turn.verdict === "changesNeeded" ? "Verdict: changes needed" : "No verdict"}
                </span>
              )}
            </li>
          ) : (
            <ChatItem
              key={item.key}
              message={item.message}
              vendor={item.vendor}
              attachments={emptyMap}
              labels={emptyLabels}
              who={same ? `${chatVendorName(item.vendor)} (${item.role})` : undefined}
            />
          ),
        )}
      </ol>

      {lanes.map((lane) => (
        <p key={lane.role} className="ux-chat-tokens" data-ply-plan-tokens={lane.role}>
          {laneTokenLine(lane, lane.usage)}
        </p>
      ))}

      {exchange.status === "awaitingMember" && (
        <section ref={decisionRef} tabIndex={-1} className="ux-plan-decision" aria-label="Decide" data-ply-plan-decision="">
          <p className="ux-plan-heading">{decisionHeading(exchange)}</p>
          {editing != null ? (
            <>
              <textarea
                className="ux-card-brief"
                aria-label="Edit the plan"
                rows={12}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
              />
              <div className="ux-chat-actions">
                <CBtn tone="accent" disabled={busy || editing.trim() === ""} onClick={() => void onAccept(editing)}>
                  Save as the card's plan
                </CBtn>
                <CBtn tone="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </CBtn>
              </div>
            </>
          ) : noteOpen ? (
            <>
              <label className="ux-card-field ux-plan-field">
                <span className="ux-card-field-label">
                  A note to both
                  <span className="ux-card-field-note">Optional.</span>
                </span>
                <textarea className="ux-chat-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <div className="ux-chat-actions">
                <CBtn
                  tone="accent"
                  disabled={busy}
                  onClick={() =>
                    void onAct(async () => {
                      await store.more(workspaceId, cardId, note.trim() ? note : null);
                      setNoteOpen(false);
                      setNote("");
                    }, "Another round didn't start")
                  }
                >
                  Run another round
                </CBtn>
                <CBtn tone="ghost" onClick={() => setNoteOpen(false)}>
                  Cancel
                </CBtn>
              </div>
            </>
          ) : (
            <div className="ux-chat-actions">
              <CBtn tone="accent" disabled={busy || !plan} onClick={() => void onAccept(null)}>
                Use this plan
              </CBtn>
              <CBtn tone="quiet" disabled={busy || !more.offered} reason={more.reason ?? null} onClick={() => setNoteOpen(true)}>
                Another round…
              </CBtn>
              <CBtn tone="quiet" disabled={busy || !plan} onClick={() => setEditing(plan ?? "")}>
                Edit…
              </CBtn>
              <CBtn tone="ghost" disabled={busy} onClick={() => void onAct(() => store.discard(workspaceId, cardId), "The plan wasn't discarded")}>
                Discard
              </CBtn>
            </div>
          )}
          {!more.offered && more.reason && <p className="ux-chat-hint">{more.reason}</p>}
        </section>
      )}
    </>
  );
}

function EarlierPlans({ exchanges }: { exchanges: PlanExchange[] }) {
  return (
    <details className="ux-details" data-ply-plan-earlier="">
      <summary className="ux-details-summary">Earlier plans ({exchanges.length})</summary>
      <div className="ux-details-body">
        <ol className="ux-plan-earlier">
          {[...exchanges].reverse().map((e) => (
            <li key={e.id}>
              <p>
                <strong>
                  {e.proposer === e.critic
                    ? `Two ${chatVendorName(e.proposer)} sessions`
                    : `${chatVendorName(e.proposer)} and ${chatVendorName(e.critic)}`}
                </strong>{" "}
                · {new Date(e.createdAt).toLocaleString()} ·{" "}
                {e.outcome?.kind === "accepted"
                  ? "accepted"
                  : e.outcome?.kind === "edited"
                    ? "accepted, edited"
                    : e.outcome?.kind === "discarded"
                      ? "discarded"
                      : e.status}
              </p>
              {latestPlan(e) && (
                <details className="ux-details">
                  <summary className="ux-details-summary">The last plan</summary>
                  <div className="ux-details-body">
                    <MarkdownText text={e.outcome?.text || latestPlan(e) || ""} />
                  </div>
                </details>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
