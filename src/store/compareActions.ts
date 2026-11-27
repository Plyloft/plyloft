// 1.177.0 Compare: the relay bar's doings — reading the two tiles' last
// answers, opening the composer, and the one write into a tile. The facts
// and words are pure (`lib/compareView`); this file touches the stores, the
// backend commands and the PTY. Every hand-over is the member's press. An
// answer's text is never logged or put in a toast or an error.
import { ptyWrite, tileScreenBlock } from "../ipc";
import { compareTileAnswer, comparePreparePaste, type CompareAnswer, type ComparePreparedPaste } from "../lib/compareIpc";
import {
  answerSeen,
  defaultAsk,
  heldOffered,
  deliveryGate,
  lastAskInto,
  plannedSincePass,
  pasteParts,
  questionFor,
  resolvePair,
  type QuestionState,
  type TileFacts,
} from "../lib/compareView";
import {
  compareOtherVendor,
  conversationUnknownWords,
  COMPARE_NOTHING_YET,
  newerAnswerWords,
  noteCutsWords,
  tileClosedWords,
  notReachedWords,
  targetAsksWords,
  targetUnknownWords,
  type CompareAsk,
  type CompareVendor,
} from "../lib/compareWords";
import { isWindows } from "../lib/platform";
import { tileHeaderStatusFor } from "../lib/tileHeaderStatus";
import { PASTE_SETTLE_MS_PER_CHAR, PASTE_SETTLE_QUIET_MS } from "../lib/builderInject";
import { pasteIntoTile } from "../lib/pasteIntoTile";
import { screenProvesTurnOver, tileLastOutputAt, tileScreenNow, type TileScreenNow } from "../lib/tileScreen";
import { useCompare, type Composer, type WsCompare } from "./compareStore";
import { useTiles, type Tile } from "./tileStore";
import { focusTile } from "./tileActions";

const ENDED = new Set(["done", "error", "killed", "crashed"]);

function liveTilesOf(workspaceId: string): Tile[] {
  return (useTiles.getState().byWorkspace[workspaceId]?.tiles ?? []).filter(
    (t) => (t.kind === "claude" || t.kind === "codex") && !t.pendingClose,
  );
}

/** What the store says about a tile; `screen` (read just now) overrides the
 *  scanned flags, and a question the screen draws counts at once. */
export function tileReady(tile: Tile, now: number): boolean | null {
  if (!tile.readiness) return null;
  if (tile.readiness.running) return false;
  const kind = tile.kind === "codex" ? "codex" : "claude";
  return tileHeaderStatusFor(kind, tile.readiness, tile.startedAt, now).ready;
}

/** Two readings of one fact, store (settled) and screen (now): unknown stays
 *  unknown, and either one saying "yes" wins. Two facts differ (walk round 5,
 *  below): whether the tile asks, and whether it works. */
const orOf = (a: boolean | null, b: boolean | null): boolean | null =>
  a === true || b === true ? true : a === null || b === null ? null : false;
const andOf = (a: boolean | null, b: boolean | null): boolean | null =>
  a === false || b === false ? false : a === null || b === null ? null : true;

/** How long the tile has printed nothing but its own resize redraws (H1),
 *  from the live read only: no screen read, not known. */
function quietFor(screen: TileScreenNow | null | undefined, now: number): number | null {
  if (!screen) return null;
  const last = screen.lastWorkOutputAt !== undefined ? screen.lastWorkOutputAt : screen.lastOutputAt;
  return last == null ? null : Math.max(0, now - last);
}

export function factsOfTile(tile: Tile, screen?: TileScreenNow | null, now: number = Date.now()): TileFacts {
  const scanned = tile.promptBoxIdle !== undefined;
  const storeQuestion = tile.question || tile.menuInView ? true : scanned ? false : null;
  const ready = tileReady(tile, now);
  const storeWorking = ready === null ? null : !ready;
  const store = {
    question: storeQuestion,
    draft: tile.inputDraft ?? null,
    promptIdle: tile.promptBoxIdle ?? null,
    working: storeWorking,
  };
  return {
    id: tile.id,
    vendor: tile.kind === "codex" ? "codex" : "claude",
    label: tile.label,
    live: tile.status === "running" && tile.ptyId !== null,
    ended: ENDED.has(tile.status),
    // Walk round 5: the store's settled scan doesn't run while a spinner
    // keeps the tile printing, so its "asks" outlives the menu by the whole
    // turn. A live read in hand decides: its menu verdict replaces the store's
    // ("decision", `menuInView`). A trust, usage-limit or Bypass screen the
    // store read stays (the write is checked against those again right
    // before it, `tileScreenBlock`).
    question: screen ? screen.decision || (tile.question != null && tile.question !== "decision") : store.question,
    // Round 7 (final walk 2, C1): the settled scan's "typed" can be the
    // member's `/status` before its Enter; a live read that reads the box
    // empty AND proves the CLI's idle box (its idle footer, which text in the
    // box takes away) replaces it. Otherwise either one saying "typed" wins.
    draft: screen
      ? screen.draft === false && (screen.readyBox === true || screen.boxIdle === true || screen.boxAsked === true)
        ? false
        : orOf(store.draft, screen.draft)
      : store.draft,
    promptIdle: screen ? andOf(store.promptIdle, screen.promptIdle) : store.promptIdle,
    // Claude: a live "not working" (its box idle with the turn's start in
    // view, no running sign anywhere) replaces a stale store "working"; a
    // live unknown never does. Codex: never — its screen reads "not working"
    // while it streams (review B1), so either one saying "working" wins.
    // 1.177.1 (item 4/16): the same for a screen that proves Claude's turn
    // over (its box and footer, a turn's end the last row above the box,
    // nothing running) where the turn's start is off the page.
    // Round 9: Codex's own `Worked for …` right above its idle box with
    // nothing running (`screenProvesTurnOver`) replaces the store's "working"
    // in the header's 2 s quiet window (after Esc on its picker the bar said
    // "Codex is working" with nothing working).
    working: screen
      ? tile.kind !== "codex" && (screen.working === false || (screen.working !== true && screen.turnOver === true))
        ? false
        : tile.kind === "codex" && screen.working !== true && screenProvesTurnOver("codex", screen)
          ? false
          : orOf(store.working, screen.working)
      : store.working,
    overlay: screen?.overlay,
    newConversation: tile.kind === "codex" && tile.newConversation === true,
    quietMs: quietFor(screen, now),
    draftNow: screen ? screen.draft : undefined,
    turnOverOnScreen: screen ? (screen.turnOver ?? null) : undefined,
    readyBox: screen ? (screen.readyBox ?? null) : undefined,
    boxDrawn: screen ? (screen.boxDrawn ?? null) : undefined,
    boxIdle: screen ? (screen.boxIdle ?? null) : undefined,
    boxAsked: screen ? (screen.boxAsked ?? null) : undefined,
    boxMode: screen ? (screen.boxMode ?? null) : undefined,
    inputQuietMs: screen ? (screen.lastInputAt > 0 ? Math.max(0, now - screen.lastInputAt) : Number.POSITIVE_INFINITY) : undefined,
    // Round 8 (review M1): drawn — xterm drew a batch that changed the screen —
    // after the keys, not merely bytes arrived (they wait in the batcher).
    echoPending: screen
      ? screen.lastInputAt > 0 && (screen.lastDrawnAt !== undefined ? (screen.lastDrawnAt ?? 0) : (screen.lastOutputAt ?? 0)) < screen.lastInputAt
      : undefined,
  };
}

export function liveFacts(workspaceId: string): TileFacts[] {
  return liveTilesOf(workspaceId).map((t) => factsOfTile(t));
}

function pairedTiles(workspaceId: string): Record<CompareVendor, Tile | null> {
  const w = useCompare.getState().byWorkspace[workspaceId];
  const tiles = liveTilesOf(workspaceId);
  const pair = resolvePair(tiles.map((t) => factsOfTile(t)), w?.claudeId ?? null, w?.codexId ?? null);
  const byId = (f: TileFacts | null) => tiles.find((t) => t.id === f?.id) ?? null;
  return { claude: byId(pair.claude), codex: byId(pair.codex) };
}

/** The tile as the store has it now (a snapshot taken before an await can be old). */
function currentTile(tile: Tile): Tile {
  for (const ws of Object.values(useTiles.getState().byWorkspace)) {
    const t = ws.tiles.find((x) => x.id === tile.id);
    if (t) return t;
  }
  return tile;
}

async function readAnswer(tile: Tile | null): Promise<CompareAnswer | null> {
  if (!tile?.ptyId) return null;
  try {
    const a = await compareTileAnswer(tile.ptyId);
    // A Codex tile that started a new conversation: the old one's answer is
    // never offered, whatever the files still say.
    return answerSeen(factsOfTile(currentTile(tile)), a) ?? null;
  } catch {
    // Nothing is known: the bar says it can't tell (no content in any log).
    return null;
  }
}

const reads = new Map<string, { p: Promise<void>; dirty: boolean }>();

/** Read both paired tiles' last answers (on toggle, when a tile stops, when
 *  the composer opens, right before a send). One read is in flight at a time;
 *  a request meanwhile marks it dirty and one more read follows. The returned
 *  promise settles after a read that started after the call. */
export function refreshAnswers(workspaceId: string): Promise<void> {
  if (!useCompare.getState().byWorkspace[workspaceId]?.on) return Promise.resolve();
  const cur = reads.get(workspaceId);
  if (cur) {
    cur.dirty = true;
    return cur.p;
  }
  const entry = { dirty: false, p: Promise.resolve() };
  entry.p = (async () => {
    do {
      entry.dirty = false;
      await readOnce(workspaceId);
    } while (entry.dirty);
  })().finally(() => reads.delete(workspaceId));
  reads.set(workspaceId, entry);
  return entry.p;
}

async function readOnce(workspaceId: string): Promise<void> {
  const tiles = pairedTiles(workspaceId);
  const [claude, codex] = await Promise.all([readAnswer(tiles.claude), readAnswer(tiles.codex)]);
  if (!useCompare.getState().byWorkspace[workspaceId]?.on) return;
  const set = useCompare.getState().setAnswer;
  if (tiles.claude) set(workspaceId, "claude", claude);
  if (tiles.codex) set(workspaceId, "codex", codex);
}

/** The tile that has the keyboard now, so it gets it back when the bar closes. */
function tileWithKeyboard(workspaceId: string): string | null {
  const el = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>("[data-tile-id]") : null;
  return el && el.dataset.tileWorkspace === workspaceId ? (el.dataset.tileId ?? null) : null;
}

/** Which of Enter and Space are down right now. A held one auto-repeats, and
 *  once focus is in a terminal that repeat is input (Enter submits, Space
 *  types): focus waits for their release, however the press was made. */
const heldKeys = new Set<string>();
if (typeof window !== "undefined") {
  const norm = (k: string) => (k === " " || k === "Spacebar" ? "Space" : k);
  window.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") heldKeys.add(norm(e.key)); }, true);
  window.addEventListener("keyup", (e) => { heldKeys.delete(norm(e.key)); }, true);
  // A key released while the window had lost focus never reports its keyup.
  window.addEventListener("blur", () => heldKeys.clear());
}

/** The keyboard back where it was: the tile that had it, else the bar's
 *  Pass button (a composer opened by mouse). `afterKeyUp`: a held Enter must
 *  not reach the tile's terminal as a repeat, so focus waits for its release. */
function giveFocusBack(workspaceId: string, back: string | null | undefined, _afterKeyUp: boolean): void {
  /** Focus is where the member left it: the page, or this bar. */
  const parked = () => {
    const at = document.activeElement;
    return !at || at === document.body || at.closest(`[data-compare-ws="${workspaceId}"]`) !== null;
  };
  const go = () => {
    if (!parked()) return;
    if (back && liveTilesOf(workspaceId).some((t) => t.id === back)) {
      focusTile(back);
      return;
    }
    requestAnimationFrame(() => {
      // Only when focus fell to the page (never over a popover or field in the bar).
      const at = document.activeElement;
      if (at && at !== document.body) return;
      document.querySelector<HTMLElement>(`[data-compare-ws="${workspaceId}"] .cbtn--accent:not(:disabled)`)?.focus();
    });
  };
  // Nothing held: back at once; Enter or Space still held: their release.
  if (heldKeys.size === 0) return go();
  let done = false;
  const once = (e?: KeyboardEvent) => {
    if (done) return;
    if (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (heldKeys.size > 0) return;
    }
    done = true;
    window.removeEventListener("keyup", once, true);
    go();
  };
  window.addEventListener("keyup", once, true);
  window.setTimeout(() => once(), 10_000);
}

/** Close the composer; the keyboard goes back (`giveFocusBack`). */
export function closeComposer(workspaceId: string, afterKeyUp = false, focusTileId?: string): void {
  const c = useCompare.getState().byWorkspace[workspaceId]?.composer;
  useCompare.getState().closeComposer(workspaceId);
  // Cancel and Esc go back to where the member was; a pass goes to its target.
  giveFocusBack(workspaceId, focusTileId ?? c?.returnTileId, afterKeyUp);
}

/** Open the composer on `from`'s last finished answer (read afresh). */
export async function openComposer(workspaceId: string, from: CompareVendor): Promise<void> {
  const returnTileId = tileWithKeyboard(workspaceId);
  await refreshAnswers(workspaceId);
  const w = useCompare.getState().byWorkspace[workspaceId];
  const fromTile = pairedTiles(workspaceId)[from];
  // 1.177.1: the answer held for a pass is the one on offer from its tile.
  const heldHere = w?.returnHeld?.from === from && fromTile ? heldOffered(w.returnHeld, () => factsOfTile(currentTile(fromTile))) : null;
  const a = heldHere ? heldHere.answer : fromTile ? answerSeen(factsOfTile(currentTile(fromTile)), w?.answers[from]) : w?.answers[from];
  if (!w || !a?.answer) return;
  const to = compareOtherVendor(from);
  // A plan seen from that tile counts for the held answer only up to it (a
  // later, separate plan is not what this answer followed).
  const planSeen = w.planSeenAt[from];
  const planSeenFor = heldHere && planSeen !== undefined && heldHere.answer.finishedAtMs !== undefined && planSeen > heldHere.answer.finishedAtMs ? undefined : planSeen;
  const composer: Composer = {
    from,
    to,
    answer: a.answer,
    answerKind: a.answerKind,
    chars: a.chars ?? a.answer.length,
    cut: a.cut,
    finishedAtMs: a.finishedAtMs,
    ask: defaultAsk(a.answerKind, lastAskInto(w.history, from), plannedSincePass(w.history, from, planSeenFor)),
    note: "",
    expanded: false,
    busy: false,
    error: null,
    fromHistory: false,
    ...(heldHere ? { held: true } : {}),
    returnTileId,
    ...questionOpening(questionOf(w, from, a)),
  };
  useCompare.getState().openComposer(workspaceId, composer);
}

/** 1.179.0: the member's question in `a`'s turn, against the passes into
 *  its tile held in memory. */
function questionOf(w: WsCompare, from: CompareVendor, a: CompareAnswer): QuestionState {
  return questionFor(
    a.turnAsks,
    w.history.filter((p) => p.to === from),
    a.finishedAtMs,
  );
}

/** The switch at a composer's open: on whenever there is a question. */
function questionOpening(question: QuestionState | null): Pick<Composer, "question" | "includeQuestion" | "preview"> {
  return { question, includeQuestion: question?.state === "ok", preview: null };
}

/** The question for an answer read again in an open composer: the member's
 *  "off" stays off for this composer; otherwise on when there is one. */
function questionAgain(workspaceId: string, c: Composer, a: CompareAnswer): Pick<Composer, "question" | "includeQuestion" | "preview"> {
  const w = useCompare.getState().byWorkspace[workspaceId];
  const question: QuestionState = w ? questionOf(w, c.from, a) : { state: "unknown", why: "not-read" };
  const turnedOff = c.question?.state === "ok" && c.includeQuestion === false;
  return { question, includeQuestion: question.state === "ok" && !turnedOff, preview: null };
}

/** What the composer passes as the member's question: only with the switch
 *  on and a question to include. */
export function questionParts(c: Composer | null | undefined): { text: string; cut: boolean } | null {
  if (!c || c.includeQuestion !== true || c.question?.state !== "ok") return null;
  return { text: c.question.text, cut: c.question.cut };
}

/** Pass a past pass's answer again, in the same direction. */
export function reopenFromPass(workspaceId: string, passN: number): void {
  const w = useCompare.getState().byWorkspace[workspaceId];
  const p = w?.history.find((x) => x.n === passN);
  if (!w || !p) return;
  useCompare.getState().openComposer(workspaceId, {
    from: p.from,
    to: p.to,
    answer: p.answer,
    answerKind: p.answerKind,
    chars: p.answer.length,
    cut: p.cut,
    ask: p.ask,
    note: "",
    expanded: false,
    busy: false,
    error: null,
    fromHistory: true,
    returnTileId: tileWithKeyboard(workspaceId),
    // 1.179.0: it carries the question it went with, or none.
    ...questionOpening(p.question !== undefined ? { state: "ok", text: p.question, cut: p.questionCut === true } : null),
  });
  void refreshAnswers(workspaceId);
}

/** After a pass into `to`, whether its terminal printed within the paste's
 *  quiet window (`PASTE_SETTLE_QUIET_MS`): ConPTY replays a long paste to
 *  Codex as keys, and the box is not settled until the output is. */
export function outputActiveAfterPass(workspaceId: string, to: CompareVendor, tileId: string | null, now = Date.now()): boolean {
  const sent = useCompare.getState().byWorkspace[workspaceId]?.sent;
  if (!sent || sent.to !== to || !tileId) return false;
  // Only within the expected replay of THAT paste (2 ms a character): an idle
  // tile that prints now and then (an animation) doesn't block for ever.
  if (now - sent.at >= Math.max(PASTE_SETTLE_QUIET_MS, sent.chars * PASTE_SETTLE_MS_PER_CHAR)) return false;
  const last = tileLastOutputAt(tileId);
  return last != null && now - last < PASTE_SETTLE_QUIET_MS;
}

/** The press of Send to … (`mode` "send") or Put it in its box ("put").
 *  `byKey`: pressed with ⌘/Ctrl+Enter (focus returns after the key's release).
 *  The delivery is bound to the composer object recorded at the press: it
 *  writes only while that same composer is open, Compare is on and the pair
 *  is unchanged — checked again in the synchronous guard and, on Windows
 *  Codex, before each Enter. */
export async function deliver(workspaceId: string, mode: "send" | "put", byKey = false): Promise<void> {
  const store = useCompare.getState();
  const c0 = store.byWorkspace[workspaceId]?.composer;
  if (!c0 || c0.busy) return;
  store.patchComposer(workspaceId, { busy: true, error: null });
  const c = useCompare.getState().byWorkspace[workspaceId]!.composer!;
  const mine = c;
  /** This press is over without a write: its own composer is free again. */
  const drop = () => {
    if (useCompare.getState().byWorkspace[workspaceId]?.composer === mine) store.patchComposer(workspaceId, { busy: false });
  };
  const fail = (error: string) => {
    if (useCompare.getState().byWorkspace[workspaceId]?.composer === mine) store.patchComposer(workspaceId, { busy: false, error });
  };
  const tiles = pairedTiles(workspaceId);
  const fromTile = tiles[c.from];
  const toTile = tiles[c.to];
  if (!fromTile) return fail(tileClosedWords(c.from));
  if (!toTile) return fail(tileClosedWords(c.to));
  // Still this press: the same composer, Compare on, the same pair.
  const wanted = () => {
    const w = useCompare.getState().byWorkspace[workspaceId];
    if (!w?.on || w.composer !== mine) return false;
    const now = pairedTiles(workspaceId);
    return now[c.from]?.id === fromTile.id && now[c.to]?.id === toTile.id;
  };
  const toPty = toTile.ptyId;
  if (!toPty) return fail(targetUnknownWords(c.to));

  // The source is read again: what goes is what was read on screen, or the
  // press stops and shows the newer answer. A pass offered again from the
  // history carries its own, older answer.
  // Review round 2 (M1): the target's conversation is read once, here; what
  // the member types into that tile after this moment is not in it.
  const dstReadAt = Date.now();
  const [src, dst] = await Promise.all([readAnswer(fromTile), readAnswer(toTile)]);
  if (!wanted()) return drop();
  // A source Codex tile that started a new conversation since the composer
  // opened: its old answer must not go (fail closed).
  if (factsOfTile(currentTile(fromTile)).newConversation && !c.fromHistory) return fail(conversationUnknownWords(c.from));
  // 1.177.1: a held answer to a pass goes as it was read, like a pass from
  // the history: its tile may have answered other things since. Review round
  // 1 (H2): unless the hold itself moved on (a held plan of a turn still
  // open, replaced by plan v2 or the turn's final answer): the press stops
  // and shows it, as for a newer answer.
  if (c.held) {
    if (src) store.setAnswer(workspaceId, c.from, src);
    const h = useCompare.getState().byWorkspace[workspaceId]?.returnHeld;
    // 1.179.0: the hold lapsed with this read (its tile finished a newer
    // answer of the member's own, `heldLapsed`): the held text no longer goes;
    // the press stops and shows that newer answer, as an ordinary composer.
    if ((!h || h.from !== c.from) && src?.answer && src.answer.trim() !== "" && (src.answer !== c.answer || src.finishedAtMs !== c.finishedAtMs)) {
      store.patchComposer(workspaceId, {
        busy: false,
        error: newerAnswerWords(c.from),
        answer: src.answer,
        answerKind: src.answerKind,
        chars: src.chars ?? src.answer.length,
        cut: src.cut,
        finishedAtMs: src.finishedAtMs,
        cutKnown: false,
        held: false,
        ...questionAgain(workspaceId, c, src),
      });
      return;
    }
    if (h && h.from === c.from && (h.answer.answer !== c.answer || h.answer.finishedAtMs !== c.finishedAtMs)) {
      store.patchComposer(workspaceId, {
        busy: false,
        error: newerAnswerWords(c.from),
        answer: h.answer.answer,
        answerKind: h.answer.answerKind,
        chars: h.answer.chars ?? h.answer.answer.length,
        cut: h.answer.cut,
        finishedAtMs: h.answer.finishedAtMs,
        cutKnown: false,
        ...questionAgain(workspaceId, c, h.answer),
      });
      return;
    }
  }
  if (!c.fromHistory && !c.held) {
    if (!src?.answer || src.answer.trim() === "") return fail(COMPARE_NOTHING_YET);
    if (src.answer !== c.answer || src.finishedAtMs !== c.finishedAtMs) {
      store.patchComposer(workspaceId, {
        busy: false,
        error: newerAnswerWords(c.from),
        answer: src.answer,
        answerKind: src.answerKind,
        chars: src.chars ?? src.answer.length,
        cut: src.cut,
        finishedAtMs: src.finishedAtMs,
        cutKnown: false,
        ...questionAgain(workspaceId, c, src),
      });
      return;
    }
  }
  if (!dst) return fail(targetUnknownWords(c.to));
  // Review round 3 (L1): the bar's facts take this fresh read too, so the
  // composer's refusal-clearing never clears a still-true refusal ("Codex is
  // working" from its open rollout turn) from an older answer.
  if (wanted()) store.setAnswer(workspaceId, c.to, dst);

  // A menu, trust or limit screen is the member's: read on the drawn screen
  // (the same 40 rows the scan reads).
  const screen = tileScreenNow(toTile.id);
  if (!screen) return fail(targetUnknownWords(c.to));
  try {
    if ((await tileScreenBlock(screen.blockTail)) !== null) return fail(targetAsksWords(c.to));
  } catch {
    return fail(targetUnknownWords(c.to));
  }
  if (!wanted()) return drop();

  // 1.179.0: the question goes only with the switch on (the parts are the
  // preview's: the same backend function gives what is shown and written).
  const question = questionParts(c);
  let prepared: ComparePreparedPaste;
  try {
    prepared = await comparePreparePaste(pasteParts(c.from, c.ask, c.answer, c.note, question));
  } catch {
    return fail(notReachedWords(c.to));
  }
  if (!wanted()) return drop();
  if (prepared.text === "") return fail(notReachedWords(c.to));
  // The note can make the backend cut the answer further to fit its cap: the
  // composer says so and waits for another press. The backend says so itself
  // (`answerCut`): a long question is cut or left out, never the answer.
  if (c.note.trim() !== "" && !c.cut && !c.cutKnown && prepared.answerCut) {
    store.patchComposer(workspaceId, { busy: false, error: noteCutsWords(), cut: true, cutKnown: true });
    return;
  }

  const result = await pasteIntoTile(
    prepared.text,
    {
      vendor: c.to,
      windows: isWindows(),
      submit: mode === "send",
      stillWanted: wanted,
      // Synchronous, right before the write: the tile as it is this instant.
      guard: () => {
        if (!wanted()) return CANCELLED;
        if (!c.fromHistory && factsOfTile(currentTile(fromTile)).newConversation) return conversationUnknownWords(c.from);
        const now = liveTilesOf(workspaceId).find((t) => t.id === toTile.id);
        if (!now || now.ptyId !== toPty) return targetUnknownWords(c.to);
        const live = tileScreenNow(now.id);
        if (!live) return targetUnknownWords(c.to);
        // The member typed into the target after its conversation was read (a
        // turn started there may not be in that read yet): read again first.
        if (live.lastInputAt > dstReadAt) return targetUnknownWords(c.to);
        // A paste Plyloft made here is still being replayed as keys: no
        // second write until the tile's output is quiet.
        if (outputActiveAfterPass(workspaceId, c.to, now.id)) return targetUnknownWords(c.to);
        return deliveryGate(c.to, factsOfTile(now, live), dst, mode);
      },
    },
    {
      write: (bytes) => ptyWrite(toPty, bytes),
      screen: () => tileScreenNow(toTile.id),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  );
  if (!result.ok) {
    if (result.words === CANCELLED) return;
    // Text that reached the box and wasn't sent is said even after Cancel.
    if (result.written && useCompare.getState().byWorkspace[workspaceId]?.composer !== mine) {
      store.setNotice(workspaceId, { words: result.words, to: c.to, at: Date.now() });
      return;
    }
    return fail(result.words);
  }

  store.addPass(workspaceId, {
    from: c.from,
    to: c.to,
    ask: c.ask as CompareAsk,
    withNote: c.note.trim() !== "",
    at: Date.now(),
    mode,
    sent: prepared.text,
    answer: c.answer,
    answerKind: c.answerKind,
    cut: c.cut,
    // What was given, before the backend's cut, so Pass it again sends the
    // same question; whether the text held it. Memory only.
    ...(question ? { question: question.text, questionCut: question.cut } : {}),
    withQuestion: prepared.question !== undefined,
  });
  // Only this press's own composer closes (another may be open by now).
  if (useCompare.getState().byWorkspace[workspaceId]?.composer === mine) closeComposer(workspaceId, byKey, toTile.id);
  // The target works now (Send) or holds the text (Put): read it again soon.
  void refreshAnswers(workspaceId);
}

/** The guard's own marker for "this press is no longer wanted": nothing is
 *  written and nothing is said. */
const CANCELLED = "\u0000compare-cancelled";

/** 1.179.0: how long the composer waits after a change before it asks the
 *  backend for the preview again. */
export const PREVIEW_DEBOUNCE_MS = 250;
const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const previewSeq = new Map<string, number>();

const sameParts = (a: Composer, b: Composer) => {
  const qa = questionParts(a);
  const qb = questionParts(b);
  return a.answer === b.answer && a.ask === b.ask && a.note === b.note && a.from === b.from && qa?.text === qb?.text && qa?.cut === qb?.cut;
};

/** 1.179.0: the composer's preview of the question as it will go, from
 *  `compare_prepare_paste` with the same parts a press sends (debounced),
 *  only while the switch is on. The write prepares again; nothing here is
 *  written, logged or kept beyond the open composer. */
export function refreshPreview(workspaceId: string): void {
  const pending = previewTimers.get(workspaceId);
  if (pending !== undefined) clearTimeout(pending);
  previewTimers.delete(workspaceId);
  // A newer request makes any answer still in flight stale.
  const seq = (previewSeq.get(workspaceId) ?? 0) + 1;
  previewSeq.set(workspaceId, seq);
  const c0 = useCompare.getState().byWorkspace[workspaceId]?.composer;
  if (!c0) return;
  if (!questionParts(c0)) {
    if (c0.preview) useCompare.getState().patchComposer(workspaceId, { preview: null });
    return;
  }
  previewTimers.set(
    workspaceId,
    setTimeout(() => {
      previewTimers.delete(workspaceId);
      const c = useCompare.getState().byWorkspace[workspaceId]?.composer;
      const question = questionParts(c);
      if (!c || !question) return;
      comparePreparePaste(pasteParts(c.from, c.ask, c.answer, c.note, question)).then(
        (preview) => {
          if (previewSeq.get(workspaceId) !== seq) return;
          const now = useCompare.getState().byWorkspace[workspaceId]?.composer;
          if (now && sameParts(now, c)) useCompare.getState().patchComposer(workspaceId, { preview });
        },
        // No preview: the composer shows the question without it; a press
        // prepares again and says if that fails.
        () => undefined,
      );
    }, PREVIEW_DEBOUNCE_MS),
  );
}
