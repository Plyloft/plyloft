// 1.177.0 Compare: the one-line relay bar under a workspace's tile grid. It
// links one Claude Code tile and one Codex tile and passes the last finished
// answer of one into the other, with a note of the member's own — every
// hand-over is their press. Mounted inside the grid host, so no tile or
// terminal is ever unmounted for it; it grows by at most three short rows
// when open, and the grid refits by its own ResizeObserver.
import { useEffect, useMemo, useRef, useState } from "react";
import { useTiles } from "../store/tileStore";
import { useWsCompare, useCompare } from "../store/compareStore";
import { factsOfTile, openComposer, outputActiveAfterPass, tileReady, refreshAnswers, reopenFromPass } from "../store/compareActions";
import { focusTile } from "../store/tileActions";
import {
  answerSeen,
  bar,
  clockWords,
  deliveryGate,
  directionOnOffer,
  passDropped,
  resolvePair,
  sentOver,
  type BarView,
  type Pass,
} from "../lib/compareView";
import {
  COMPARE_ASK_LABEL,
  COMPARE_BACK,
  COMPARE_CLAUDE_TILE,
  COMPARE_CODEX_TILE,
  COMPARE_PASS_AGAIN,
  COMPARE_SHOW_IT,
  COMPARE_SWAP,
  COMPARE_SWAP_TITLE,
  COMPARE_WITH_NOTE,
  COMPARE_WITH_QUESTION,
  conversationUnknownWords,
  historyDirection,
  targetDraftWords,
  targetWorkingWords,
} from "../lib/compareWords";
import { shortcutKeys } from "../lib/shortcuts";
import { tileScreenNow } from "../lib/tileScreen";
import { useWorkspaces } from "../store/workspaceStore";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { CBtn } from "./ui/primitives";
import { RelayWho } from "./RelayWho";
import { CompareComposer } from "./CompareComposer";
import { MenuButton, type MenuItem } from "./ux";
import { useDismiss } from "./ux/MoreMenu";
import { useEscapeFirst } from "./ux/useEscapeFirst";
import { MarkdownText } from "./MarkdownText";

/** The shortcut's event: App.tsx answers the chord and asks the bar of the
 *  active workspace (every warmed workspace has its own). */
export const COMPARE_PASS_EVENT = "ply:compare-pass";

export function CompareBar({ workspaceId }: { workspaceId: string }) {
  const w = useWsCompare(workspaceId);
  const tiles = useTiles((s) => s.byWorkspace[workspaceId]?.tiles);
  const live = useMemo(
    () => (tiles ?? []).filter((t) => (t.kind === "claude" || t.kind === "codex") && !t.pendingClose),
    [tiles],
  );
  const [now, setNow] = useState(() => Date.now());
  // The live screen with the store's flags (F1, F3, C8): what the CLI does now
  // — a menu, a turn, the box — read once a tick, never kept.
  // Review M1: only with Compare on and this workspace's Terminals page the
  // one shown; nothing is read otherwise.
  const activeWs = useWorkspaces((s) => s.activeId === workspaceId);
  const onTerminals = useUi((s) => effectiveCenterMode(s.centerMode, workspaceId) === "terminals");
  const readScreens = w.on && activeWs && onTerminals;
  const facts = useMemo(
    () => live.map((t) => factsOfTile(t, readScreens ? tileScreenNow(t.id) : null, now)),
    [live, now, readScreens],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openPass, setOpenPass] = useState<number | null>(null);
  const historyRoot = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const closeHistory = () => {
    setHistoryOpen(false);
    setOpenPass(null);
    countRef.current?.focus();
  };
  useDismiss(historyOpen, historyRoot, () => {
    setHistoryOpen(false);
    setOpenPass(null);
  });
  const countRef = useRef<HTMLButtonElement>(null);
  // Esc closes the popover first; focus goes into it when it opens.
  useEscapeFirst(historyOpen, historyRoot, closeHistory);
  useEffect(() => {
    if (historyOpen) historyRoot.current?.querySelector<HTMLElement>(".ux-relay-history button")?.focus();
  }, [historyOpen, openPass]);

  // A closed tile undoes its pair.
  useEffect(() => {
    if (w.on) useCompare.getState().reconcile(workspaceId, facts.map((f) => ({ id: f.id, vendor: f.vendor })));
  }, [w.on, workspaceId, facts]);

  // A tile that paired by itself is remembered (a later second tile of its
  // kind doesn't change the pair; its closing is noticed).
  useEffect(() => {
    if (!w.on) return;
    const p = resolvePair(facts, w.claudeId, w.codexId);
    if (p.claude && p.claude.id !== w.claudeId) useCompare.getState().adopt(workspaceId, "claude", p.claude.id);
    if (p.codex && p.codex.id !== w.codexId) useCompare.getState().adopt(workspaceId, "codex", p.codex.id);
  }, [w.on, workspaceId, facts, w.claudeId, w.codexId]);

  const pairIds = {
    claude: resolvePair(facts, w.claudeId, w.codexId).claude?.id ?? null,
    codex: resolvePair(facts, w.claudeId, w.codexId).codex?.id ?? null,
  };
  const view: BarView = bar({
    tiles: facts,
    claudeId: w.claudeId,
    codexId: w.codexId,
    closed: w.closed,
    answers: w.answers,
    history: w.history,
    flipped: w.flipped,
    sent: w.sent,
    sentOutputActive: w.sent ? outputActiveAfterPass(workspaceId, w.sent.to, pairIds[w.sent.to], now) : false,
    held: w.returnHeld,
    now,
  });

  // Reading the answers: when the bar goes on, when the pair changes, and
  // when a paired tile goes from working to ready. Never on a timer.
  const pairKey = `${facts
    .filter((f) => f.vendor === "claude")
    .map((f) => f.id)
    .join(",")}|${facts
    .filter((f) => f.vendor === "codex")
    .map((f) => f.id)
    .join(",")}|${w.claudeId}|${w.codexId}`;
  const pairedPty = live.map((t) => `${t.id}:${t.ptyId ?? ""}`).join(",");
  // Each paired tile's last seen state: a re-read follows whenever one STOPS
  // working for any reason (ready, a question, a menu, ended) and whenever
  // its question appears or changes (a plan ends on a question).
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!w.on) {
      seen.current = {};
      return;
    }
    void refreshAnswers(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.on, workspaceId, pairKey, pairedPty]);
  useEffect(() => {
    if (!w.on) return;
    let changed = false;
    const next: Record<string, string> = {};
    for (const t of live) {
      const working = tileReady(t, now) === false && !t.question;
      const sig = `${working ? "w" : "s"}|${t.question ?? ""}|${t.status}`;
      next[t.id] = sig;
      const before = seen.current[t.id];
      if (before === undefined) continue;
      const wasWorking = before.startsWith("w");
      const questionBefore = before.split("|")[1];
      if ((wasWorking && !working) || questionBefore !== (t.question ?? "") || before.split("|")[2] !== t.status) changed = true;
    }
    seen.current = next;
    if (changed) void refreshAnswers(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.on, workspaceId, live, now]);

  // Walk round 5: the same, on the facts the bar shows (the live screen read
  // with the store's flags): a re-read when a paired tile's question or menu
  // goes, and when it goes from working (or unknown) to not working — the
  // store's own flags can lag a whole turn behind the screen.
  const liveSeen = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!w.on) {
      liveSeen.current = {};
      return;
    }
    let changed = false;
    const next: Record<string, string> = {};
    for (const f of facts) {
      const sig = `${f.question}|${f.working}`;
      next[f.id] = sig;
      const before = liveSeen.current[f.id];
      if (before === undefined || before === sig) continue;
      const [q0, w0] = before.split("|");
      if ((q0 === "true" && f.question !== true) || (w0 !== "false" && f.working === false)) changed = true;
    }
    liveSeen.current = next;
    if (changed) void refreshAnswers(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.on, workspaceId, facts]);

  // "answered 2 min ago" stays right: a 1 s tick like the tile headers, only
  // with the bar on; each tick reads the AI tiles' drawn screens (above) and
  // calls nothing.
  useEffect(() => {
    if (!w.on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [w.on]);

  const composer = w.composer;

  // The shortcut: open the composer for the direction on offer, or focus the note.
  useEffect(() => {
    if (!w.on) return;
    const onPass = (e: Event) => {
      if ((e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId !== workspaceId) return;
      if (composer) {
        noteRef.current?.focus();
        return;
      }
      if (view.from && view.button && !view.button.disabled) void openComposer(workspaceId, view.from);
    };
    window.addEventListener(COMPARE_PASS_EVENT, onPass);
    return () => window.removeEventListener(COMPARE_PASS_EVENT, onPass);
  });

  // The note takes the keyboard when the composer opens.
  const composerOpen = composer !== null;
  const noteText = composer?.note ?? "";
  // Two rows at rest, growing with the text to five at most.
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 18;
    const max = line * 5 + 16;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [noteText, composerOpen]);
  useEffect(() => {
    if (composerOpen) noteRef.current?.focus();
  }, [composerOpen]);

  // A pass whose state is over (the target answered, stopped, or ended) leaves
  // the store, so nothing keeps guarding on it.
  useEffect(() => {
    const sent = w.sent;
    if (!sent) return;
    const target = facts.find((f) => f.id === pairIds[sent.to]);
    // 1.179.0: the other tile's answer too, as the view reads it (`bar`): a
    // Put no longer in the box ends once that tile answered since.
    const other = sent.to === "claude" ? "codex" : "claude";
    if (sentOver(sent, target, w.answers[sent.to], now, outputActiveAfterPass(workspaceId, sent.to, pairIds[sent.to], now), w.answers[other])) {
      // 1.177.1: its text left the box with no turn (the member cleared it):
      // the tile's next answer is not the answer to this pass. Review round 1
      // (L3): read the answers once more first — a turn quicker than the bar's
      // tick is never seen working, and its answer then fulfils the wait.
      if (passDropped(w.returnPending, sent, target, w.answers[sent.to], now)) {
        const at = sent.at;
        void refreshAnswers(workspaceId).then(() => {
          const p = useCompare.getState().byWorkspace[workspaceId]?.returnPending;
          if (p && p.at === at && !p.sawWork) useCompare.getState().dropReturn(workspaceId);
        });
      }
      useCompare.getState().clearSent(workspaceId);
    }
  });

  // Review round 1 (L1): a paired tile whose process changed under the same
  // id (restarted: a new conversation) drops the pass's answer, waited for
  // or held.
  const pairedPtys = useRef<Partial<Record<"claude" | "codex", string | null>>>({});
  useEffect(() => {
    if (!w.on) {
      pairedPtys.current = {};
      return;
    }
    let changed = false;
    for (const v of ["claude", "codex"] as const) {
      const id = pairIds[v];
      const pty = id ? (live.find((t) => t.id === id)?.ptyId ?? null) : null;
      const key = id && pty ? `${id}:${pty}` : null;
      const before = pairedPtys.current[v];
      if (before && key && before.split(":")[0] === id && before !== key) changed = true;
      if (key) pairedPtys.current[v] = key;
    }
    if (changed) useCompare.getState().dropReturn(workspaceId);
  });

  // 1.177.1: the answer to a pass — its tile seen working on it, and dropped
  // when that tile is a Codex that started a new conversation (`/new`).
  useEffect(() => {
    const p = w.returnPending;
    const v = p?.into ?? w.returnHeld?.from;
    if (!v) return;
    const f = facts.find((x) => x.id === pairIds[v]);
    if (f?.vendor === "codex" && f.newConversation === true) {
      useCompare.getState().dropReturn(workspaceId);
      return;
    }
    if (p && !p.sawWork && f?.working === true && now > p.at) useCompare.getState().noteReturnWork(workspaceId);
  });

  // The "it reached the box" notice goes when the target's box is seen empty
  // and idle again, or it starts working (a few seconds after it was said,
  // so the scan that predates the paste can't clear it).
  useEffect(() => {
    const n = w.notice;
    if (!n || now - n.at < 3_000) return;
    const f = facts.find((x) => x.id === pairIds[n.to]);
    if (!f || f.working === true || (f.draft === false && f.promptIdle === true && f.question === false)) {
      useCompare.getState().setNotice(workspaceId, null);
    }
  });

  // Round 5 (final walk, step 8b): a guard's refusal after a press is no
  // longer true once both buttons are on again (the member cleared the box,
  // the turn ended): it goes. Other sentences stay until the next press.
  useEffect(() => {
    const c = w.composer;
    if (!c || c.busy || !c.error) return;
    const to = c.to;
    // Only refusals the bar's own facts can see end (text in the box, a turn):
    // a trust or limit screen, or typing after the read, are the press's own.
    const guardWords = [targetDraftWords(to), targetWorkingWords(to)];
    if (!guardWords.includes(c.error)) return;
    // The screen as it is now (the tick's facts can be a second older than the refusal).
    const tile = live.find((t) => t.id === (to === "claude" ? pairIds.claude : pairIds.codex));
    if (!tile || !readScreens) return;
    const toFacts = factsOfTile(tile, tileScreenNow(tile.id), Date.now());
    if (deliveryGate(to, toFacts, w.answers[to], "put") === null && deliveryGate(to, toFacts, w.answers[to], "send") === null) {
      useCompare.getState().patchComposer(workspaceId, { error: null });
    }
  });

  // After a refusal (busy drops, the composer stays) the note has the keyboard
  // again, so ⌘/Ctrl+Enter can retry.
  const busyNow = composer?.busy === true;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busyNow && composerOpen) noteRef.current?.focus();
    wasBusy.current = busyNow;
  }, [busyNow, composerOpen]);

  if (!w.on) return null;

  const store = useCompare.getState();
  const passKeys = shortcutKeys("comparePass", { terminal: true });

  const pickerItems = (p: BarView["pickers"][number]): MenuItem[] =>
    p.options.map((o) => ({
      label: o.label,
      checked: o.id === p.selectedId,
      onSelect: () => store.choose(workspaceId, p.vendor, o.id),
    }));
  const pickers = view.pickers.map((p) => (
    <MenuButton
      key={p.vendor}
      tone="quiet"
      label={p.selectedId ? `${p.vendor === "claude" ? COMPARE_CLAUDE_TILE : COMPARE_CODEX_TILE}: ${p.options.find((o) => o.id === p.selectedId)?.label ?? ""}` : p.vendor === "claude" ? COMPARE_CLAUDE_TILE : COMPARE_CODEX_TILE}
      menuLabel={p.vendor === "claude" ? COMPARE_CLAUDE_TILE : COMPARE_CODEX_TILE}
      items={pickerItems(p)}
    />
  ));

  if (composer) {
    const toFacts = facts.find((f) => f.id === (composer.to === "claude" ? pairIds.claude : pairIds.codex));
    // A composer on the old answer of a Codex tile that started a new
    // conversation since: neither button is offered (a pass from history
    // carries its own text and is not affected).
    const fromFacts = facts.find((f) => f.id === (composer.from === "claude" ? pairIds.claude : pairIds.codex));
    const sourceNew = !composer.fromHistory && fromFacts?.newConversation === true;
    const gateFor = (action: "send" | "put") =>
      sourceNew
        ? conversationUnknownWords(composer.from)
        : toFacts
          ? deliveryGate(composer.to, toFacts, w.answers[composer.to], action)
          : null;
    return (
      <CompareComposer
        workspaceId={workspaceId}
        composer={composer}
        sendReason={gateFor("send")}
        putReason={gateFor("put")}
        answerGone={sourceNew}
        noteRef={noteRef}
      />
    );
  }

  const passRow = (p: Pass) => (
    <CBtn key={p.n} tone="quiet" className="ux-relay-pass" onClick={() => setOpenPass(p.n)}>
      <span className="ux-relay-pass-n">{p.n}</span>
      <span>
        {historyDirection(p.from, p.to)}
        <span className="ux-relay-muted">
          {` · ${COMPARE_ASK_LABEL[p.ask]}${p.withQuestion ? ` · ${COMPARE_WITH_QUESTION}` : ""}${p.withNote ? ` · ${COMPARE_WITH_NOTE}` : ""}`}
        </span>
      </span>
      <span className="ux-relay-pass-time">{clockWords(p.at)}</span>
    </CBtn>
  );
  const shown = openPass !== null ? w.history.find((p) => p.n === openPass) : undefined;
  const history = historyOpen && w.history.length > 0 && (
    <div className="ux-relay-history" role="dialog" aria-label={`${view.count}`}>
      {shown ? (
        <div className="ux-relay-pass-text">
          <div className="ux-relay-line">
            <b>{historyDirection(shown.from, shown.to)}</b>
            <span className="ux-relay-muted">{` · ${COMPARE_ASK_LABEL[shown.ask]}`}</span>
            <span className="ux-relay-spacer" />
            <CBtn size="sm" tone="quiet" onClick={() => setOpenPass(null)}>
              {COMPARE_BACK}
            </CBtn>
            <CBtn
              size="sm"
              tone="strong"
              onClick={() => {
                setHistoryOpen(false);
                setOpenPass(null);
                reopenFromPass(workspaceId, shown.n);
              }}
            >
              {COMPARE_PASS_AGAIN}
            </CBtn>
          </div>
          <div className="ux-relay-answer">
            <MarkdownText text={shown.sent} />
          </div>
        </div>
      ) : (
        w.history.map(passRow)
      )}
    </div>
  );

  const button = view.button;
  const from = view.from;
  return (
    <div
      className="ux-relay"
      role="region"
      aria-label="Compare"
      data-compare-ws={workspaceId}
      ref={historyRoot}
      onFocusCapture={() => void refreshAnswers(workspaceId)}
    >
      {history}
      {/* Row 1: the sentence on the left; on the right, fixed and right-aligned,
          Swap · count · button · hint (wrapping under as one block when the
          grid is narrow). A reason that doesn't fit beside the sentence has
          its own muted row under it. */}
      <div className="ux-relay-main">
        <div className="ux-relay-left">
          {/* "answered 2 min ago" changes every minute: it stays out of the
              live region, which carries only the state and its reason. */}
          {view.kind === "ready" && from && <RelayWho vendor={from}>{viewLine(view)}</RelayWho>}
          <span className="ux-relay-live" aria-live="polite">
            {view.kind !== "ready" &&
              (from && view.kind !== "no-pair" && view.kind !== "choose" && view.kind !== "nothing" ? (
                <RelayWho vendor={from}>{viewLine(view)}</RelayWho>
              ) : (
                <span className="ux-relay-text">{view.line}</span>
              ))}
          </span>
          {pickers}
        </div>
        <div className="ux-relay-right">
          {view.canSwap && (
            <CBtn
              size="sm"
              tone="quiet"
              title={COMPARE_SWAP_TITLE}
              onClick={() => {
                // 1.177.1: Swap drops an answer held for a pass and offers
                // the other direction from there.
                if (w.returnHeld && view.from) {
                  // Review round 1 (L4): the answers as the bar reads them.
                  const seen = {
                    claude: answerSeen(facts.find((f) => f.id === pairIds.claude), w.answers.claude) ?? undefined,
                    codex: answerSeen(facts.find((f) => f.id === pairIds.codex), w.answers.codex) ?? undefined,
                  };
                  const newest = directionOnOffer(seen, false, now)?.from ?? null;
                  store.flip(workspaceId, newest === view.from);
                } else {
                  store.flip(workspaceId);
                }
                void refreshAnswers(workspaceId);
              }}
            >
              {COMPARE_SWAP}
            </CBtn>
          )}
          {view.kind !== "no-pair" && view.kind !== "choose" && (
            <CBtn
              ref={countRef}
              size="sm"
              tone="quiet"
              disabled={w.history.length === 0}
              aria-expanded={historyOpen}
              onClick={() => {
                setHistoryOpen((o) => !o);
                void refreshAnswers(workspaceId);
              }}
            >
              {view.count}
            </CBtn>
          )}
          {button && (
            <>
              <CBtn
                tone="accent"
                disabled={button.disabled}
                reason={button.reason}
                onClick={() => from && void openComposer(workspaceId, from)}
              >
                {button.label}
              </CBtn>
              {!button.disabled && <kbd className="ux-relay-keys">{passKeys}</kbd>}
            </>
          )}
        </div>
      </div>
      {(view.note || view.muted || w.notice) && (
        <div className="ux-relay-reason ux-relay-muted" aria-live="polite">
          <span>{[view.note, view.muted, w.notice?.words].filter(Boolean).join(" ")}</span>
          {view.showIt && (
            <CBtn size="sm" tone="quiet" onClick={() => focusTile(view.showIt!)}>
              {COMPARE_SHOW_IT}
            </CBtn>
          )}
        </div>
      )}
    </div>
  );
}

/** The line's words, with the vendor's name bold as the mockup draws it. */
function viewLine(view: BarView): React.ReactNode {
  const m = /^(.*?)(Claude|Codex)(.*)$/.exec(view.line);
  // Round 9: the possessive stays with the name ("Codex's"), so no reader
  // that joins the parts with a space says "Codex 's".
  const own = m && m[3].startsWith("'s") ? 2 : 0;
  return m && !/^[.,]/.test(m[3]) ? (
    <>
      {m[1]}
      <b>{m[2] + m[3].slice(0, own)}</b>
      {m[3].slice(own)}
    </>
  ) : (
    view.line
  );
}
