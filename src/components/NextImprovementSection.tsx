// 1.173.0 (E3): Next improvement, above the Board — the slate of ideas a
// round left for the current area (E2), and every state around it: first
// use, a round under way (with Stop), the slate, nothing worth doing, an
// answer that couldn't be read, a round that ended early, and the offer
// after a card from here shipped. Nothing starts by
// itself: every round begins on a press.
// Mockup: ~/ply-build/next-1173/mockups/next-improvement.html, scenes 1, 3–6.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  niDirectionAdoptProject,
  niDirectionGet,
  niReject,
  niRoundChange,
  niRoundGet,
  niRoundMark,
  niRoundStart,
  niRoundStop,
  onNiDirection,
  onNiProgress,
  openWebLink,
  type KanbanCard,
  type NiIdea,
  type NiRound,
} from "../ipc";
import { CBtn, CheckList, CheckRow, CIcon, Details, FailureText, Group, Popover, Row, RowValue, TextField } from "./ux";
import { failure, type Failure } from "../lib/failure";
import { rawError } from "../lib/cardPage";
import { machineWords } from "../lib/platform";
import { areaName, pickerAreas, pickerShown } from "../lib/areaPicker";
import {
  CHANGE_IT,
  CHOOSE,
  DETAILS,
  DIRECTION_LABEL,
  DONT_PROPOSE,
  DONT_PROPOSE_CONFIRM,
  HIDE,
  HIDE_DETAILS,
  HOW_SHOULD_IT_CHANGE,
  MAKE_IT_A_CARD,
  NI_TITLE,
  NI_TOUR,
  NI_COLLAPSE_LABEL,
  NI_EXPAND_LABEL,
  NI_HIDDEN_TOAST,
  NI_NOTHING_TITLE,
  NOT_NOW,
  NOTHING_WORTH,
  OPEN_THE_CARD,
  PREPARE_AGAIN,
  PREPARE_NEW,
  PREPARE_PROPOSALS,
  SHOW_IT,
  SHOW_NI,
  REWRITE_IT,
  UNREADABLE_TITLE,
  WAITING_FOR_CHOICE,
  WHICH_AREA_LEAD,
  MARK_FAILED_WORDS,
  cantSaveWords,
  shippedSub,
  approachesWords,
  cardAreaOfRound,
  endedTitle,
  firstUseLine,
  answeredSub,
  howItLookedWords,
  ideaCardNotes,
  isNoDirectionRefusal,
  minutesWords,
  niProblemWords,
  nothingLine,
  openIdeas,
  rejectHint,
  rejectQuestion,
  rewritingWords,
  runningTitle,
  setAsideHeading,
  setAsideLine,
  setAsideCardParts,
  shippedFromHere,
  shippedTitle,
  shownPhases,
  sizeRiskWords,
  slateSub,
  slateTitle,
  unansweredIdeas,
  CHANGE_WHO,
  FROM_LAST_ROUND,
  NEXT_ROUND,
  ROUND_APPROACHES,
  ROUND_APPROACH_LINES,
  carriedIdeas,
  carriedLine,
  roundApproachesFrom,
  thisRoundOnlyWords,
  whoProposesWords,
  BEFORE_AREAS_LINE,
  CHECK_DIRECTION_FIRST,
  useItForArea,
} from "../lib/nextImprovement";
import { useAreas, useAreasView, useCurrentArea } from "../store/areaStore";
import { pushToast } from "../store/toastStore";
import { useKanban } from "../store/kanbanStore";
import { useSettingConflict } from "../store/settingConflictStore";
import { useUi } from "../store/uiStore";
import { useSettings } from "../store/settingsStore";
import {
  hiddenFor,
  hiddenToken,
  niKey,
  offerDismissed,
  openDirectionEditor,
  slateCollapsed,
  takeNotice,
  useNextImprovement,
  useNiOpens,
} from "../store/nextImprovementStore";
import { linkDidNotOpen } from "../lib/linkToast";
import { vendorReadiness } from "../lib/vendorReadiness";
import { useDoctor } from "../store/doctorStore";
import { oneAiWords } from "../lib/niDirectionWords";

const EMPTY_CARDS: KanbanCard[] = [];

/**
 * 1.174.0 (A4): whether the section draws anything — the Board's notes slot
 * (BoardNotices) asks, so Next improvement is a note like the others: last,
 * and only a name in "N more notes" while another is shown first.
 */
export function useNextImprovementShown(workspaceId: string): boolean {
  const areasView = useAreasView(workspaceId);
  const area = useCurrentArea(workspaceId);
  const key = niKey(workspaceId, area?.id ?? null);
  const hidden = useNextImprovement((s) => {
    const token = hiddenFor(s, key);
    return token !== null && token === hiddenToken(s.rounds[key]?.round);
  });
  // A6 (D2c): not before this person's first shipped card, unless asked for.
  const opens = useNiOpens(workspaceId, key);
  if (areasView?.held) return false;
  if (!opens) return false;
  if (pickerShown(areasView) && !area) return true;
  return !hidden;
}

/** A section left behind when the Board goes: told once React is done —
 *  a remount in the same pass (StrictMode) keeps it open. */
const leaving = new Map<string, number>();
function leaveSoon(key: string) {
  window.clearTimeout(leaving.get(key));
  leaving.set(
    key,
    window.setTimeout(() => {
      leaving.delete(key);
      useNextImprovement.getState().leave(key);
    }, 0),
  );
}
function stayHere(key: string) {
  window.clearTimeout(leaving.get(key));
  leaving.delete(key);
}

export function NextImprovementSection({
  workspaceId,
  folded = false,
}: {
  workspaceId: string;
  /** A4: in the Board's notes slot behind another note — kept reading the
   *  round, drawn only when Show opens the slot. */
  folded?: boolean;
}) {
  const areasView = useAreasView(workspaceId);
  const area = useCurrentArea(workspaceId);
  const opens = useNiOpens(workspaceId, niKey(workspaceId, area?.id ?? null));
  // Areas that can't be used: the Board's AreaNotice says so; nothing here.
  if (areasView?.held) return null;
  // All areas, with two or more: one area at a time — say so, and offer them.
  if (pickerShown(areasView) && !area) {
    if (folded || !opens) return null;
    return (
      <section className="ni" aria-label={NI_TITLE} data-ply-tour={NI_TOUR} data-ni-state="which-area">
        <div className="ni-head">
          <h3 className="ni-title">{NI_TITLE}</h3>
          <span className="ni-sub">{WHICH_AREA_LEAD}</span>
          <span className="ni-actions">
            {pickerAreas(areasView).map((a) => (
              <CBtn key={a.id} size="sm" onClick={() => useAreas.getState().choose(workspaceId, a.id)}>
                {areaName(a)}
              </CBtn>
            ))}
          </span>
        </div>
      </section>
    );
  }
  // Challenger 4: keyed by workspace and area, so nothing of one section's
  // state (a problem, a press under way, an ask) carries to another.
  return (
    <AreaSection key={niKey(workspaceId, area?.id ?? null)} workspaceId={workspaceId} area={area?.id ?? null} folded={folded} />
  );
}

type Ask =
  | { kind: "change"; ideaId: string }
  | { kind: "reject"; ideaId: string };

/** Where focus goes after a press (Challenger 10). */
type FocusNext = { kind: "open"; ideaId: string } | { kind: "after"; ideaId: string } | { kind: "head" };

function AreaSection({ workspaceId, area, folded }: { workspaceId: string; area: string | null; folded: boolean }) {
  const key = niKey(workspaceId, area);
  const view = useNextImprovement((s) => s.rounds[key]);
  const direction = useNextImprovement((s) => s.directions[key]);
  const hiddenTok = useNextImprovement((s) => hiddenFor(s, key));
  // A4: how the slate opens — this session's copy, else this Mac's settings.
  const sessionSlate = useNextImprovement((s) => s.slate[key]);
  const savedSlate = useSettings((s) => s.settings.nextImprovement?.view?.[key]);
  const openNow = useNextImprovement((s) => s.openNow[key]);
  const cardOpen = useUi((s) => s.selectedCardId[workspaceId] != null);
  const reveal = useNextImprovement((s) => (s.reveal?.workspaceId === workspaceId ? s.reveal : null));
  const offerAnswered = useNextImprovement((s) =>
    view?.round ? offerDismissed(s, view.round.id) : false,
  );
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_CARDS);
  const [problem, setProblem] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [focusNext, setFocusNext] = useState<{ to: FocusNext; at: number } | null>(null);
  const section = useRef<HTMLElement>(null);
  // Challenger 11: cards made whose mark on the idea didn't land yet.
  const madeCards = useRef(new Map<string, string>());
  // The area the backend resolved for this section ("default" without
  // areas): what `ni://progress`, `ni://direction` and the Inbox name.
  const resolved = useRef<string | null>(null);
  const [resolvedArea0, setResolvedArea0] = useState<string | null>(null);
  const resolveTo = (a: string) => {
    resolved.current = a;
    setResolvedArea0(a);
  };

  const round = view?.round ?? null;
  const token = hiddenToken(round);
  // A6 (D2c): before it shows by itself it still reads its round (a round
  // there opens it), and draws nothing.
  const opens = useNiOpens(workspaceId, key);
  const hidden = (hiddenTok !== null && hiddenTok === token) || !opens;
  const collapsed = slateCollapsed(sessionSlate ?? savedSlate, openNow, token);
  // A round with something to read (not the first use, not one still
  // running): drawn unfolded, it is seen — it opens folded once the person
  // leaves the Board (mockup board.html 4a).
  const settled = !!round && (round.status !== "running" || !!round.change);
  useEffect(() => {
    if (folded || hidden || !settled || collapsed) return;
    useNextImprovement.getState().markSeen(key, token);
  }, [folded, hidden, settled, collapsed, key, token]);
  // Leaving: another workspace, area or mode unmounts the section; a card
  // opened over the Board hides it.
  useEffect(() => {
    stayHere(key);
    return () => leaveSoon(key);
  }, [key]);
  useEffect(() => {
    if (cardOpen) useNextImprovement.getState().leave(key);
  }, [cardOpen, key]);

  // The round, and every change of it (this section's area only).
  useEffect(() => {
    let live = true;
    void niRoundGet(workspaceId, area)
      .then((v) => {
        if (!live || !v) return;
        resolveTo(v.area);
        useNextImprovement.getState().setRound(key, v);
      })
      .catch((e) => live && setProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't read the last round."), e)));
    const offProgress = onNiProgress((v) => {
      if (v.workspaceId !== workspaceId || v.area !== resolved.current) return;
      useNextImprovement.getState().setRound(key, v);
    });
    const offDirection = onNiDirection((e) => {
      if (e.workspaceId !== workspaceId || e.area !== resolved.current) return;
      // Read again on show (Challenger 13): the read below runs once more.
      useNextImprovement.getState().dropDirection(key);
    });
    return () => {
      live = false;
      void offProgress.then((off) => off()).catch(() => {});
      void offDirection.then((off) => off()).catch(() => {});
    };
  }, [workspaceId, area, key]);

  // The direction: read once per area (the store keeps it across Board
  // mounts), again after `ni://direction`, never while the section is hidden.
  const haveDirection = direction !== undefined;
  useEffect(() => {
    if (hidden || haveDirection) return;
    let live = true;
    void niDirectionGet(workspaceId, area)
      .then((d) => {
        if (!live) return;
        if (d && resolved.current === null) resolveTo(d.area);
        useNextImprovement.getState().setDirection(key, d ?? null);
        // E6: the repository's direction was kept over this computer's.
        if (d?.notice && takeNotice(workspaceId, d)) pushToast({ kind: "info", title: NI_TITLE, body: d.notice });
      })
      .catch(() => live && useNextImprovement.getState().setDirection(key, null));
    return () => {
      live = false;
    };
  }, [workspaceId, area, key, hidden, haveDirection]);

  const running = round?.status === "running";
  // The in-progress minutes tick while it runs.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [running]);

  // The Inbox's *Look at the ideas* (Challenger 7): the section that
  // resolved to that area shows, unfolds, and then takes focus.
  useEffect(() => {
    if (!reveal || resolvedArea0 === null || reveal.area !== resolvedArea0) return;
    const store = useNextImprovement.getState();
    store.show(key);
    store.expand(key);
    useNextImprovement.setState({ reveal: null });
    setFocusNext({ to: { kind: "head" }, at: reveal.at });
  }, [reveal, resolvedArea0, key]);

  // Focus after a press or a reveal, once the section has drawn it — once
  // per request (Challenger round 2): a later `ni://progress` never pulls
  // focus back from a field the person is typing in.
  const focusHandled = useRef<number | null>(null);
  useEffect(() => {
    if (!focusNext || focusHandled.current === focusNext.at) return;
    const el = section.current;
    if (!el) return;
    const to = focusNext.to;
    let target: HTMLElement | null = null;
    if (to.kind === "open") {
      target = el.querySelector(`[data-ni-open="${CSS.escape(to.ideaId)}"]`);
      // Not drawn yet: the marked round is on its way.
      if (!target) return;
    }
    if (to.kind === "after") {
      // A4: each idea's title carries its id (one Row per idea).
      const titles = [...el.querySelectorAll<HTMLElement>("[data-ni-idea]")];
      if (titles.some((r) => r.getAttribute("data-ni-idea") === to.ideaId)) return;
      target = titles[0] ?? null;
    }
    target = target ?? el.querySelector<HTMLElement>(".ni-title");
    if (to.kind === "head") el.scrollIntoView?.({ block: "nearest" });
    target?.focus();
    focusHandled.current = focusNext.at;
    setFocusNext(null);
    // A4 round 1: a reveal behind another note lands once the slot opens.
  }, [focusNext, view, folded]);

  const shipped = useMemo(() => shippedFromHere(round, cards), [round, cards]);

  if (hidden || folded) return null;

  const areaWords = round?.areaName ?? direction?.areaName ?? "";
  // C7 (§1c): Hide says where the section went, with the way back.
  const hide = () => {
    useNextImprovement.getState().hide(key, hiddenToken(round));
    pushToast({
      kind: "info",
      title: NI_HIDDEN_TOAST,
      action: { label: SHOW_IT, onClick: () => useNextImprovement.getState().show(key, workspaceId) },
    });
  };
  const toggleCollapsed = () =>
    collapsed ? useNextImprovement.getState().expand(key, token) : useNextImprovement.getState().collapse(key, token);
  const toDirection = (thenStart = false) => openDirectionEditor(workspaceId, area, thenStart);
  const cantSave = cantSaveWords(direction);

  /** C15: `thisRound` is the popover's choice, for this round only. */
  const start = async (thisRound?: RoundChoice) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const v = await niRoundStart(workspaceId, area, thisRound ?? null);
      resolveTo(v.area);
      useNextImprovement.getState().setRound(key, v);
    } catch (e) {
      if (isNoDirectionRefusal(e)) toDirection(true);
      else setProblem(failure(niProblemWords(rawError(e), "Next improvement couldn't start the round."), e));
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    void niRoundStop(workspaceId, area).catch((e) =>
      setProblem(failure("Plyloft couldn't stop the round.", e)),
    );
  };

  const resolvedArea = round ? view!.area : (direction?.area ?? area ?? "default");

  /** True once the idea carries the mark. */
  const mark = async (idea: NiIdea, m: { cardId?: string; dismissed?: boolean }, fallback: string): Promise<boolean> => {
    try {
      const v = await niRoundMark(workspaceId, resolvedArea, idea.id, m);
      useNextImprovement.getState().setRound(key, v);
      return true;
    } catch (e) {
      setProblem(failure(niProblemWords(rawError(e), fallback), e));
      return false;
    }
  };

  const makeCard = async (idea: NiIdea) => {
    if (!round || busy) return;
    setAsk(null);
    setBusy(true);
    setProblem(null);
    try {
      // A card made by an earlier press whose mark didn't land: only the
      // mark again (Challenger 11).
      let cardId = madeCards.current.get(idea.id);
      if (!cardId) {
        const card = await useKanban
          .getState()
          .addCard(workspaceId, idea.title, ideaCardNotes(idea, round), "todo", cardAreaOfRound(resolvedArea));
        cardId = card.id;
        madeCards.current.set(idea.id, cardId);
      }
      if (await mark(idea, { cardId }, MARK_FAILED_WORDS)) {
        madeCards.current.delete(idea.id);
        setFocusNext({ to: { kind: "open", ideaId: idea.id }, at: Date.now() });
      }
    } catch {
      // addCard said why (its toast); the idea stays as it was.
    } finally {
      setBusy(false);
    }
  };

  const waiting = direction?.pending?.state === "conflict" && direction.pending.conflicts.length > 0;
  const waitingLine = waiting ? (
    <p className="ni-line" data-ni-waiting="">
      {WAITING_FOR_CHOICE}
      <CBtn
        size="sm"
        tone="quiet"
        onClick={() =>
          void useSettingConflict.getState().show(workspaceId, direction!.pending!.conflicts[0].field)
        }
      >
        {CHOOSE}
      </CBtn>
    </p>
  ) : null;
  const problemLine = problem ? (
    <div className="ni-line ni-problem" role="alert">
      <FailureText failure={problem} />
    </div>
  ) : null;

  const shell = (state: string, head: ReactNode, body?: ReactNode) => (
    <section
      ref={section}
      className="ni"
      aria-label={NI_TITLE}
      data-ply-tour={NI_TOUR}
      data-ni-state={state}
      data-ni-collapsed={collapsed ? "" : undefined}
    >
      {head}
      {waitingLine}
      {problemLine}
      {!collapsed && body}
    </section>
  );
  // 1.173.0 Windows walk: a head with no ideas under it ("nothing worth
  // doing", a round that ended early) opens as Show Next improvement.
  // C7 (P12): Prepare new proposals is in the head only where it is the
  // view's one way to a new round — never beside a row's own press.
  // C15 (§2c): every Prepare new proposals / Prepare proposals again opens
  // the round's popover: an approach for this round only, nothing saved.
  const prepareRound = (label: string, tone?: "strong") => (
    <PrepareRound
      label={label}
      tone={tone}
      busy={busy}
      approaches={direction?.direction.approaches}
      proposer={direction?.direction.proposer === "codex" ? "codex" : "claude"}
      open={unansweredIdeas(round).length}
      onStart={(choice) => void start(choice)}
    />
  );
  const slateHead = (title: string, ideas = false, sub?: string, prepare = false) => (
    <SlateHead
      title={title}
      ideas={ideas}
      sub={sub ?? slateSub(round!, Date.now())}
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      prepare={prepare ? prepareRound(PREPARE_NEW) : null}
      onDirection={() => toDirection()}
      onHide={hide}
    />
  );
  // C15 (§2): the last round's ideas still waiting, answerable while a new
  // round runs (no Change it… then: one AI pass at a time), and beside a
  // round with nothing new or an answer that couldn't be read.
  const carriedGroup = (canChange: boolean) => {
    const carried = carriedIdeas(round);
    if (!round || carried.length === 0) return null;
    return (
      <Group label="Ideas">
        {carried.map((idea) => ideaRow(idea, false, canChange))}
      </Group>
    );
  };

  const ideaRow = (idea: NiIdea, openFirst: boolean, canChange: boolean) => (
    <IdeaRow
      key={idea.id}
      idea={idea}
      round={round!}
      areaName={areaWords}
      byline={view?.byline ?? null}
      openFirst={openFirst}
      busy={busy || (running && !!round!.change)}
      canChange={canChange && !running}
      cantSave={cantSave}
      changing={round!.change?.ideaId === idea.id ? round!.change.comment : null}
      ask={ask?.ideaId === idea.id ? ask : null}
      setAsk={setAsk}
      onMakeCard={() => void makeCard(idea)}
      onOpenCard={() => idea.cardId && useUi.getState().selectCard(workspaceId, idea.cardId, true)}
      onChange={async (comment) => {
        setAsk(null);
        setProblem(null);
        try {
          const v = await niRoundChange(workspaceId, resolvedArea, idea.id, comment);
          useNextImprovement.getState().setRound(key, v);
        } catch (e) {
          setProblem(failure(niProblemWords(rawError(e), "Next improvement couldn't change the idea."), e));
        }
      }}
      onStopChange={stop}
      onReject={async (reason) => {
        await niReject(workspaceId, resolvedArea, idea.title, reason);
        setAsk(null);
        setFocusNext({ to: { kind: "after", ideaId: idea.id }, at: Date.now() });
        await mark(idea, { dismissed: true }, "Plyloft couldn't note that on the idea.");
      }}
    />
  );

  const waitingIdeas = unansweredIdeas(round);
  const shippedLine =
    round && !running && shipped && !offerAnswered ? (
      <div className="ni-line" data-ni-shipped="">
        <span className="ni-dot ni-dot--ok" aria-hidden="true" />
        <strong>{shippedTitle(shipped.idea.title)}</strong>
        <span className="ni-sub">{shippedSub(shipped.card)}</span>
        <span className="ni-actions">
          {/* C15: with ideas still waiting the head offers Prepare new
              proposals; one press of it per view. */}
          <CBtn size="sm" tone="quiet" onClick={() => useNextImprovement.getState().dismissOffer(round.id)}>
            {NOT_NOW}
          </CBtn>
        </span>
      </div>
    ) : null;

  // ── After a card from here shipped, nothing else waiting (scene 6) ──
  // (Challenger 6: with ideas still waiting it is a line above the slate.)
  if (round && shippedLine && waitingIdeas.length === 0) {
    return shell(
      "shipped",
      <div className="ni-head">
        <span className="ni-dot ni-dot--ok" aria-hidden="true" />
        <h3 className="ni-title" tabIndex={-1}>
          {shippedTitle(shipped!.idea.title)}
        </h3>
        <span className="ni-sub">{shippedSub(shipped!.card)}</span>
        <span className="ni-actions">
          {prepareRound(PREPARE_NEW, "strong")}
          <CBtn size="sm" tone="quiet" onClick={() => useNextImprovement.getState().dismissOffer(round.id)}>
            {NOT_NOW}
          </CBtn>
        </span>
      </div>,
    );
  }

  // ── First use (scene 1 → 1.174.0 A6: one line, mockups/board.html 5b) ──
  // Prepare proposals without a direction opens the direction sheet first
  // (`isNoDirectionRefusal`), whose lede says what Plyloft drafted it from.
  // 1.174.0 (C11, §5b): an area's first time, with a direction written
  // before the project had areas — the same line, with that sentence:
  // *Use it for <area>* copies it here (its list too); *Check the direction
  // first…* opens it in the editor. Never "default" on screen.
  if (!round) {
    const before = !!direction?.beforeAreas && !direction.exists && !!direction.areaName;
    const adoptHere = async () => {
      if (busy || !direction) return;
      setBusy(true);
      setProblem(null);
      try {
        await niDirectionAdoptProject(workspaceId, [direction.area]);
        useNextImprovement.getState().dropDirection(key);
      } catch (e) {
        setProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't copy the direction."), e));
      } finally {
        setBusy(false);
      }
    };
    return shell(
      before ? "before-areas" : "first-use",
      <div className="ni-head">
        <h3 className="ni-title" tabIndex={-1}>
          {NI_TITLE}
        </h3>
        {/* Round 1: said once the direction is read, so the AI's name never
            changes under the person's eyes. */}
        {direction !== undefined && (
          <span className="ni-sub">{before ? BEFORE_AREAS_LINE : firstUseLine(direction?.direction.proposer)}</span>
        )}
        <span className="ni-actions">
          {before ? (
            <>
              <CBtn size="sm" tone="strong" disabled={busy} onClick={() => void adoptHere()}>
                {busy ? "Copying…" : useItForArea(direction!.areaName)}
              </CBtn>
              <CBtn size="sm" disabled={busy} onClick={() => openDirectionEditor(workspaceId, area, false, true)}>
                {CHECK_DIRECTION_FIRST}
              </CBtn>
            </>
          ) : (
            <>
              <CBtn size="sm" tone="strong" disabled={busy} onClick={() => void start()}>
                {busy ? "Starting…" : PREPARE_PROPOSALS}
              </CBtn>
              <CBtn size="sm" tone="quiet" onClick={() => toDirection()}>
                {DIRECTION_LABEL}
              </CBtn>
            </>
          )}
          <CBtn size="sm" tone="quiet" onClick={hide}>
            {HIDE}
          </CBtn>
        </span>
      </div>,
    );
  }

  // ── A round under way (scene 3) ──
  if (running && !round.change) {
    return shell(
      "running",
      <div className="ni-head">
        <span className="ni-dot ni-dot--running" aria-hidden="true" />
        <h3 className="ni-title" tabIndex={-1}>
          {runningTitle(areaWords)}
        </h3>
        <span className="ni-sub">
          {/* Challenger 5: the minutes since it started, ticking. */}
          {[approachesWords(round.approaches), minutesWords(Math.max(now, Date.now()) - round.startedAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="ni-actions">
          <CBtn size="sm" onClick={stop}>
            Stop
          </CBtn>
        </span>
      </div>,
      <>
        <div className="ni-body">
          <ul className="ni-lines" aria-live="polite">
            {shownPhases(round).map((p, i) => (
              <li key={i}>
                <strong>{p.label}</strong> · {p.words}
              </li>
            ))}
            {carriedIdeas(round).length > 0 && <li data-ni-carried-line="">{carriedLine(carriedIdeas(round).length)}</li>}
          </ul>
        </div>
        {carriedGroup(false)}
      </>,
    );
  }

  const ended = endedTitle(round.status);

  // ── Nothing worth doing (scene 6) ──
  if (round.status === "nothing") {
    // C7 (mockups/next-improvement.html §3): "nothing this time" in the head,
    // the good answer in its row with Prepare proposals again (the head
    // doesn't repeat it); Set aside under it.
    return shell(
      "nothing",
      slateHead(NI_NOTHING_TITLE),
      <>
        <Group>
          <Row
            kind="item"
            label={NOTHING_WORTH}
            hint={nothingLine(round)}
            action={prepareRound(PREPARE_AGAIN)}
          />
        </Group>
        {carriedGroup(true)}
        <SetAside round={round} cards={cards} onOpenCard={(id) => useUi.getState().selectCard(workspaceId, id, true)} />
      </>,
    );
  }

  // ── An answer that couldn't be read, or a round that ended early ──
  if (round.status === "unreadable" || ((ended || round.status === "unknown") && round.ideas.length === 0)) {
    const title = round.status === "unreadable" ? UNREADABLE_TITLE : (ended ?? "The round didn't finish");
    const line = round.status === "unreadable" ? round.unreadable?.problem : round.reason;
    return shell(
      round.status,
      slateHead(NI_TITLE),
      <>
      <div className="ni-idea">
        <div className="ni-idea-main">
          <p className="ni-idea-title">{title}</p>
          {line && <p className="ni-hint">{line}</p>}
          {(round.unreadable?.raw || round.technical) && (
            <Details>
              <pre className="ux-output">{round.unreadable?.raw || round.technical}</pre>
            </Details>
          )}
        </div>
        <div className="ni-side">
          {/* Challenger round 1: a retry keeps the round's own choice. */}
          <CBtn size="sm" tone="strong" disabled={busy} onClick={() => void start(sameChoice(round))}>
            {busy ? "Starting…" : PREPARE_PROPOSALS}
          </CBtn>
        </div>
      </div>
      {carriedGroup(false)}
      </>,
    );
  }

  // ── The slate (scene 4), with a change under way on one idea (scene 5) ──
  const shown = openIdeas(round);
  return shell(
    "slate",
    // A6 (5e): every idea answered — "answered", with what became of them.
    slateHead(
      slateTitle(waitingIdeas.length),
      shown.length > 0,
      waitingIdeas.length === 0 && round.ideas.length > 0 && !running ? answeredSub(round, Date.now()) : undefined,
      // C15: offered whenever no round runs; ideas still open stay.
      !running,
    ),
    <>
      {/* A4 (P3 BCI-2): the slate has a height — 40vh, scrolling inside —
          so the Board stays in view under it. */}
      <div className="ni-list" data-ni-list="">
      {shippedLine}
      {round.codeNote && <p className="ni-line ni-hint">{round.codeNote}</p>}
      {ended && round.reason && <p className="ni-line ni-hint">{round.reason}</p>}
      {round.changeProblem && <p className="ni-line ni-hint">{round.changeProblem}</p>}
      {shown.length > 0 && (
      <Group label="Ideas">
      {shown.map((idea, i) => ideaRow(idea, i === 0, round.status === "ready" || round.status === "nothing"))}
      </Group>
      )}
      </div>
      <SetAside round={round} cards={cards} onOpenCard={(id) => useUi.getState().selectCard(workspaceId, id, true)} />
    </>,
  );
}

function SlateHead({
  title,
  sub,
  ideas,
  collapsed,
  onToggle,
  prepare,
  onDirection,
  onHide,
}: {
  title: string;
  sub: string;
  /** Ideas are under the head: the chevron opens "the ideas". */
  ideas: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Prepare new proposals (C15: its popover), where the head offers it. */
  prepare: ReactNode;
  onDirection: () => void;
  onHide: () => void;
}) {
  // C7 (BCI-3, NI-6; mockups/next-improvement.html §1, §1b): the chevron is
  // the toggle; the three presses are bordered and stay when folded.
  return (
    <div className="ni-head">
      <CIcon
        icon={collapsed ? "opens" : "expand"}
        tone="quiet"
        aria-expanded={!collapsed}
        aria-label={collapsed ? (ideas ? NI_EXPAND_LABEL : SHOW_NI) : NI_COLLAPSE_LABEL}
        title={collapsed ? (ideas ? NI_EXPAND_LABEL : SHOW_NI) : NI_COLLAPSE_LABEL}
        onClick={onToggle}
      />
      <h3 className="ni-title" tabIndex={-1}>
        {title}
      </h3>
      {sub && !collapsed && <span className="ni-sub">{machineWords(sub)}</span>}
      <span className="ni-actions">
        {prepare}
        <CBtn size="sm" onClick={onDirection}>
          {DIRECTION_LABEL}
        </CBtn>
        <CBtn size="sm" onClick={onHide}>
          {HIDE}
        </CBtn>
      </span>
    </div>
  );
}

/** C15: the popover's choice, for this round only. */
type RoundChoice = { approaches?: string[]; proposer?: "claude" | "codex" };

/** The choice a round was given for itself, to try it again with. */
function sameChoice(round: NiRound): RoundChoice | undefined {
  const approaches = round.approachesOverride?.length ? round.approachesOverride : undefined;
  const proposer = round.proposerOverride ?? undefined;
  return approaches || proposer ? { approaches, proposer } : undefined;
}

/**
 * 1.174.0 (C15, NIW-4; mockups/next-improvement.html §2c): *Prepare new
 * proposals* and *Prepare proposals again* open a small popover — this
 * round's approach (preselected from the direction) and who proposes — and
 * a second press starts it. Nothing is saved or shared: the round keeps its
 * choice, the direction stays as it is. Focus lands on Prepare proposals;
 * Esc closes it.
 */
function PrepareRound({
  label,
  tone,
  busy,
  approaches,
  proposer,
  open: openIdeas,
  onStart,
}: {
  label: string;
  tone?: "strong";
  busy: boolean;
  /** The direction's, to start from. */
  approaches: readonly string[] | null | undefined;
  proposer: "claude" | "codex";
  /** Ideas still waiting for an answer: they stay below. */
  open: number;
  onStart: (choice: RoundChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [who, setWho] = useState<"claude" | "codex">(proposer);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const oneAi =
    readiness.claude.ready && !readiness.codex.ready
      ? "claude"
      : readiness.codex.ready && !readiness.claude.ready
        ? "codex"
        : null;
  useEffect(() => {
    if (open) confirm.current?.focus();
  }, [open]);
  const show = () => {
    setChosen(roundApproachesFrom(approaches));
    setWho(proposer);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const toggle = (a: string) =>
    setChosen((now) => (now.includes(a) ? now.filter((x) => x !== a) : ROUND_APPROACHES.filter((x) => x === a || now.includes(x))));
  const go = () => {
    setOpen(false);
    if (chosen.length === 0) return;
    onStart({ approaches: chosen, proposer: oneAi ?? who });
  };
  return (
    <Popover
      open={open}
      onClose={close}
      label={NEXT_ROUND}
      trigger={
        <CBtn
          ref={trigger}
          size="sm"
          tone={tone}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : show())}
        >
          {busy ? "Starting…" : label}
        </CBtn>
      }
    >
      <div className="ux-popover-body" data-ni-round="">
        <p className="ux-popover-title">{NEXT_ROUND}</p>
        <CheckList label={NEXT_ROUND}>
          {ROUND_APPROACHES.map((a) => (
            <span key={a} data-ni-round-approach={a}>
              <CheckRow checked={chosen.includes(a)} onChange={() => toggle(a)}>
                <strong>{ROUND_APPROACH_LINES[a].name}</strong> {ROUND_APPROACH_LINES[a].line}
              </CheckRow>
            </span>
          ))}
        </CheckList>
        <p className="ux-popover-hint" data-ni-round-who="">
          {oneAi ? (
            oneAiWords(oneAi)
          ) : (
            <>
              {whoProposesWords(who)} ·{" "}
              <CBtn size="sm" tone="quiet" onClick={() => setWho((w) => (w === "claude" ? "codex" : "claude"))}>
                {CHANGE_WHO}
              </CBtn>
            </>
          )}
        </p>
        <p className="ux-popover-hint">{thisRoundOnlyWords(openIdeas)}</p>
        <div className="ux-popover-actions">
          <CBtn size="sm" onClick={close}>
            Cancel
          </CBtn>
          <CBtn ref={confirm} size="sm" tone="strong" disabled={chosen.length === 0} onClick={go}>
            {PREPARE_PROPOSALS}
          </CBtn>
        </div>
      </div>
    </Popover>
  );
}

function SetAside({ round, cards, onOpenCard }: { round: NiRound; cards: readonly KanbanCard[]; onOpenCard: (cardId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (round.setAside.length === 0) return null;
  return (
    <div className="ni-foot">
      <CBtn size="sm" tone="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {setAsideHeading(round.setAside)}
      </CBtn>
      {open && (
        <ul className="ni-lines">
          {round.setAside.map((s, i) => {
            // C8 (§2b): an idea that repeats a card names it, and the card's
            // title opens it while the card is on this Board.
            const parts = setAsideCardParts(s, round.setAside);
            const here = parts && cards.some((c) => c.id === parts.card.id) ? parts : null;
            return (
              <li key={`${s.idea.id}-${i}`} data-ni-set-aside-card={here?.card.id}>
                {here ? (
                  <>
                    {here.before}
                    <CBtn size="sm" tone="quiet" onClick={() => onOpenCard(here.card.id)}>
                      {here.card.title}
                    </CBtn>
                    {here.after}
                  </>
                ) : (
                  setAsideLine(s, round.setAside)
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IdeaRow({
  idea,
  round,
  areaName,
  byline,
  openFirst,
  busy,
  canChange,
  cantSave,
  changing,
  ask,
  setAsk,
  onMakeCard,
  onOpenCard,
  onChange,
  onStopChange,
  onReject,
}: {
  idea: NiIdea;
  round: NiRound;
  areaName: string;
  /** "Claude proposed, Codex gave a second opinion", for How it looked. */
  byline: string | null;
  openFirst: boolean;
  busy: boolean;
  /** C15: *Change it…* is offered (not while a round runs, nor on a round
   *  that ended early). */
  canChange: boolean;
  /** Why nothing can be saved here (a read-only Mac of a shared setup). */
  cantSave: string | null;
  /** *Change it…* under way on this idea: the comment it was given. */
  changing: string | null;
  ask: Ask | null;
  setAsk: (ask: Ask | null) => void;
  onMakeCard: () => void;
  onOpenCard: () => void;
  onChange: (comment: string) => void;
  onStopChange: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const [details, setDetails] = useState(openFirst);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [rejectProblem, setRejectProblem] = useState<Failure | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const changeOpen = ask?.kind === "change";
  useEffect(() => {
    if (changeOpen) commentRef.current?.focus();
  }, [changeOpen]);

  const made = !!idea.cardId;
  const sizeRisk = sizeRiskWords(idea.size, idea.risk);

  const submitReject = async () => {
    const why = reason.trim();
    if (!why || rejecting || cantSave) return;
    setRejecting(true);
    setRejectProblem(null);
    try {
      await onReject(why);
      setReason("");
    } catch (e) {
      setRejectProblem(failure(niProblemWords(rawError(e), "Plyloft couldn't save that."), e));
    } finally {
      setRejecting(false);
    }
  };

  const askHere = changing !== null || changeOpen;
  return (
    <>
      {/* A4 (VC-11): one row per idea — its title, the size and risk as
          words and Details, then the one action — in a tidy table. */}
      <Row
        kind="item"
        label={
          <span className="ni-idea-title" data-ni-idea={idea.id} tabIndex={-1}>
            {idea.title}
          </span>
        }
        hint={made ? "A card in Not started" : idea.carriedFrom != null ? FROM_LAST_ROUND : undefined}
        action={
          made ? (
            <CBtn size="sm" data-ni-open={idea.id} onClick={onOpenCard}>
              {OPEN_THE_CARD}
            </CBtn>
          ) : changing !== null ? (
            <CBtn size="sm" onClick={onStopChange}>
              Cancel
            </CBtn>
          ) : (
            <CBtn size="sm" disabled={busy} onClick={onMakeCard}>
              {MAKE_IT_A_CARD}
            </CBtn>
          )
        }
      >
        {/* Mockup 4b: size and risk, then Details, before the action. */}
        {sizeRisk && <RowValue>{sizeRisk}</RowValue>}
        <CBtn size="sm" tone="quiet" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          {details ? HIDE_DETAILS : DETAILS}
        </CBtn>
      </Row>
      {(details || askHere) && (
        <div className="ni-det" data-ni-idea-details={idea.id}>
        {details && (
          <dl className="ni-grid" data-ni-details="">
            {idea.saw && (
              <>
                <dt>Saw</dt>
                <dd>{idea.saw}</dd>
              </>
            )}
            {idea.removes && (
              <>
                <dt>Removes</dt>
                <dd>{idea.removes}</dd>
              </>
            )}
            {idea.change && (
              <>
                <dt>Change</dt>
                <dd>{idea.change}</dd>
              </>
            )}
            {idea.better && (
              <>
                <dt>Better because</dt>
                <dd>{idea.better}</dd>
              </>
            )}
            {idea.check && (
              <>
                <dt>How to check</dt>
                <dd>{idea.check}</dd>
              </>
            )}
            {idea.sources.length > 0 && (
              <>
                <dt>Sources</dt>
                <dd>
                  {idea.sources.map((url, i) => (
                    <span key={url}>
                      {i > 0 && " · "}
                      {/* Challenger 1: the window refuses to navigate; the
                          system browser opens it. */}
                      <CBtn
                        size="sm"
                        tone="quiet"
                        className="ni-source"
                        title={url}
                        onClick={() =>
                          void openWebLink(url).catch((e: unknown) =>
                            pushToast(linkDidNotOpen(url, e)),
                          )
                        }
                      >
                        {sourceWords(url)}
                      </CBtn>
                    </span>
                  ))}
                </dd>
              </>
            )}
            {idea.where.length > 0 && (
              <>
                <dt>Where</dt>
                <dd>
                  {idea.where.map((w, i) => (
                    <span key={w}>
                      {i > 0 && ", "}
                      <code>{w}</code>
                    </span>
                  ))}
                </dd>
              </>
            )}
            {idea.secondOpinion && (
              <>
                <dt>Second opinion</dt>
                <dd>{idea.secondOpinion}</dd>
              </>
            )}
            <dt>How it looked</dt>
            <dd>
              {machineWords(howItLookedWords(round, byline))}
              {round.codeNote ? ` · ${round.codeNote}` : ""}
            </dd>
          </dl>
        )}
        {/* A4: Change it… and Don't propose this… are under Details. */}
        {details && !made && changing === null && (
          <div className="ni-actions">
            {canChange && (
              <CBtn
                size="sm"
                disabled={busy}
                aria-expanded={changeOpen}
                onClick={() => setAsk(changeOpen ? null : { kind: "change", ideaId: idea.id })}
              >
                {CHANGE_IT}
              </CBtn>
            )}
            <Popover
              open={ask?.kind === "reject"}
              onClose={() => setAsk(null)}
              label={rejectQuestion(idea.title)}
              trigger={
                <CBtn
                  size="sm"
                  tone="quiet"
                  disabled={busy}
                  aria-haspopup="dialog"
                  aria-expanded={ask?.kind === "reject"}
                  onClick={() => setAsk(ask?.kind === "reject" ? null : { kind: "reject", ideaId: idea.id })}
                >
                  {DONT_PROPOSE}
                </CBtn>
              }
            >
              <div className="ni-reject" data-ni-reject="">
                <p className="ni-idea-title">{rejectQuestion(idea.title)}</p>
                <p className="ni-hint">{rejectHint(areaName)}</p>
                {cantSave && (
                  <p className="ni-hint" data-ni-cant-save="">
                    {cantSave}
                  </p>
                )}
                <TextField
                  label="Why"
                  wide
                  disabled={!!cantSave}
                  autoFocus={!cantSave}
                  value={reason}
                  onChange={setReason}
                  onEnter={() => void submitReject()}
                />
                {rejectProblem && (
                  <div className="ni-hint" role="alert">
                    <FailureText failure={rejectProblem} />
                  </div>
                )}
                <div className="ni-actions">
                  <CBtn size="sm" onClick={() => setAsk(null)}>
                    Cancel
                  </CBtn>
                  <CBtn size="sm" tone="strong" disabled={!reason.trim() || rejecting || !!cantSave} onClick={() => void submitReject()}>
                    {DONT_PROPOSE_CONFIRM}
                  </CBtn>
                </div>
              </div>
            </Popover>
          </div>
        )}
        {changing !== null && (
          <div className="ni-ask" data-ni-changing="">
            <p className="ni-hint">{HOW_SHOULD_IT_CHANGE}</p>
            <p className="ni-quote">{changing}</p>
            <p className="ni-hint" role="status">
              <span className="ni-dot ni-dot--running" aria-hidden="true" /> {rewritingWords(round.proposer)}
            </p>
          </div>
        )}
        {changeOpen && changing === null && (
          <div className="ni-ask" data-ni-change-form="">
            <label className="ni-hint" htmlFor={`ni-change-${idea.id}`}>
              {HOW_SHOULD_IT_CHANGE}
            </label>
            <textarea
              id={`ni-change-${idea.id}`}
              ref={commentRef}
              className="ux-card-textarea"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setAsk(null);
                }
              }}
            />
            <div className="ni-actions">
              <CBtn size="sm" onClick={() => setAsk(null)}>
                Cancel
              </CBtn>
              <CBtn
                size="sm"
                tone="strong"
                disabled={!comment.trim()}
                onClick={() => {
                  onChange(comment.trim());
                  setComment("");
                }}
              >
                {REWRITE_IT}
              </CBtn>
            </div>
          </div>
        )}
        </div>
      )}
    </>
  );
}

/** A source's address as its site and path: "baymard.com/blog/…". */
function sourceWords(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const text = `${u.hostname.replace(/^www\./, "")}${path}`;
    return text.length > 60 ? `${text.slice(0, 59)}…` : text;
  } catch {
    return url;
  }
}

