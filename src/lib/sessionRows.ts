/**
 * GH #95 (ADR 0005, BOARDS.md §1): liveness has one home, the sidebar. The
 * active workspace's live sessions are listed under its `Terminals` entry —
 * the Builder sessions of cards and the tiles of the grid, what the retired
 * Live rail showed. Pure view model: presentation only, no store access, so
 * no PTY is spawned or killed by anything derived here.
 */
import { STARTING, tileStatusLine, type TileQuestion, type TileTone } from "./tileStatusLine.ts";
import { isRestartableKind } from "./tileExit.ts";
import type { TileStatusKind } from "./playfulStatus.ts";
import type { Readiness } from "./tileHeaderStatus.ts";
import { cardActor, laneActor, type ActorCard, type ActorWords, type LiveSession } from "./sessionActor.ts";
import { laneKey } from "./buildBoth.ts";
import { cardSessionWords, type CardPresentation } from "./cardPresentation.ts";
import type { BuildBoth, BuildLaneId, KanbanCard } from "../ipc.ts";
import { pausedLabel, SESSION_WORDS } from "./deliveryWords.ts";

/** Where a click on a row lands — what the rail's chip did. */
export type SessionTarget =
  /** Reopen the card (its lifecycle owns the Board centre). */
  | { kind: "card"; cardId: string }
  /** Terminals mode with that tile expanded; `null` expands none. */
  | { kind: "terminals"; tileId: string | null };

/** The 8 px state dot. `empty` is a plain shell (nothing to report). */
/** `warn`: the filled amber of a session waiting on the member (the
 *  Inbox's); `error` is its ring, for a silent or held session; `crashed`
 *  (QoL 1.168 block 10, A6) the filled red of a tile that ended in a
 *  failure, as its header draws it. */
export type SessionDot = "running" | "done" | "error" | "warn" | "crashed" | "empty";

export type SessionRow = {
  key: string;
  kind: "builder" | "tile";
  /** SL-6: which build of a card built by both this session is. */
  lane?: "a" | "b";
  name: string;
  dot: SessionDot;
  /** A tile row's header tone (QoL 1.168 block 10): what the dot alone
   *  can't tell — a quiet session from a failed one, both the ring. */
  tone?: TileTone;
  /** GH #293: the state in words — the row's accessible name and tooltip
   *  say it, so the dot is never colour alone. */
  state: string;
  /** CL-7 round 2 (F7): the state without its clock, for the accessible
   *  name, which must not change every minute. */
  spokenState: string;
  /** A plain shell is set in mono `--muted`. */
  plainShell: boolean;
  /** QoL 1.168 (D7, terminals S2-5): the state is drawn as the row's second
   *  line, not only said in its tooltip — every Builder row, and a tile that
   *  waits on the member, has gone quiet or failed. */
  stateLine?: boolean;
  target: SessionTarget;
  /** P-A (UX P1 point 2): a Builder row's card rule (`presentCard`), as
   *  `data-ply-rule` — the same as the card's Board card and Now box. */
  rule?: string;
};

export type SessionRowsView = {
  /** The rows to draw — the first 8 unless expanded. */
  visible: SessionRow[];
  /** Sessions the cap is holding back; 0 when none or when expanded. */
  hidden: number;
};

/** More than this many sessions collapse to the first 8 and `+N more`. */
export const SESSION_ROW_CAP = 8;

/**
 * Apply the cap. GH #95 (Challenger review 2, P2): `+N more` EXPANDS the
 * list in place instead of opening Terminals. A Builder session lives in
 * its card, not the tile grid, so with nine live Builders and no tiles the
 * spec's "opens Terminals" led to an empty grid and the ninth session was
 * unreachable. The Terminals row directly above still opens Terminals.
 */
export function capSessionRows(
  rows: readonly SessionRow[],
  expanded: boolean,
): SessionRowsView {
  if (expanded) return { visible: [...rows], hidden: 0 };
  return {
    visible: rows.slice(0, SESSION_ROW_CAP),
    hidden: Math.max(0, rows.length - SESSION_ROW_CAP),
  };
}

/** The fields read from a tile (structural, so the test needs no store). */
export type SessionTileInput = {
  id: string;
  kind: string;
  label: string;
  status: string;
  /** GH #293: what the tile header reads (`tileStatusLine`), so the row
   *  and the header show one state. */
  exitCode?: number | null;
  startedAt?: number;
  sessionBusy?: boolean;
  sessionTurnStartedAt?: number;
  readiness?: Readiness;
  lastOutputAt?: number;
  /** Try it (TI-2): the card copy this shell is the Try session of. Listed
   *  with that card's sessions, after its Builder. */
  tryOf?: { cardId: string; lane?: string | null };
  /** Terminals block P3: what the session waits on the member for. */
  question?: TileQuestion | null;
  questionResetsAt?: string | null;
};

/** The fields read from a card. CL-7: the Builder's vendor and the facts
 *  that say who is working (its review, the checks, Build done). */
export type SessionCardInput = {
  id: string;
  title: string;
  ghIssueNumber?: number | null;
  lastRunStatus?: KanbanCard["lastRunStatus"];
  verifyStatus?: KanbanCard["verifyStatus"];
  worktreeSetup?: KanbanCard["worktreeSetup"];
  builder?: {
    ptyId?: string | null;
    vendor?: "claude" | "codex";
    startedAt?: number;
    review?: NonNullable<KanbanCard["builder"]>["review"];
    snapshots?: NonNullable<KanbanCard["builder"]>["snapshots"];
  } | null;
  /** SL-6: a card built by both lists each build's session. */
  buildBoth?: BuildBoth | null;
};

/** CL-7: what this window knows of the live Builder sessions, keyed by
 *  session key (a card id, or a build's lane key) — `useBuilder`'s
 *  `byCard`, `sentAt` and `doneAt`. Absent: rows say only "session open". */
export type LiveSessions = {
  byKey: Readonly<Record<string, LiveSession | undefined>>;
  sentAt?: Readonly<Record<string, number | undefined>>;
  submittedAt?: Readonly<Record<string, number | undefined>>;
  doneAt?: Readonly<Record<string, number | undefined>>;
  /** P-A (UX P1 point 2): what the card says (`presentCard`) — a question
   *  its session waits on is said in the card's words, on every surface. */
  presentOf?: (cardId: string) => Pick<CardPresentation, "rule" | "headline" | "dot" | "waiting"> | null;
};

const ACTOR_DOT: Record<ActorWords["dot"], SessionDot> = {
  running: "running",
  done: "done",
  aborted: "error",
  empty: "empty",
};

/** CL-7: a Builder row's state — who is working, in words ("Claude ·
 *  building · 4m", "Claude · waiting for you", "Codex · reviewing"), and
 *  the dot that goes with them. A session this window cannot read keeps
 *  "session open", with its vendor when the card names one. */
export function builderRowState(
  card: SessionCardInput,
  live: LiveSessions | undefined,
  now: number,
): { state: string; spokenState: string; dot: SessionDot; rule?: string } {
  const vendor = card.builder?.vendor;
  const presented = live?.presentOf?.(card.id) ?? null;
  // P-A: the session stopped at its CLI's folder-trust question says so as
  // the card does ("Claude · asks to trust the folder"), not "waiting for
  // you" — nothing moves until it is answered. Mac walk 4: so does a card
  // stopped on a ship conflict or a failed Ship press ("Claude · ship
  // stopped on a conflict", not "build done") — the words and the dot the
  // session panel's header says too (`cardSessionWords`).
  const cardWords = presented && vendor ? cardSessionWords(presented, vendor) : null;
  if (cardWords && presented) {
    return { state: cardWords.row, spokenState: cardWords.row, dot: ACTOR_DOT[cardWords.dot], rule: presented.rule };
  }
  const rule = presented?.rule;
  if (vendor && card.builder?.startedAt != null) {
    const actor = cardActor({
      card: card as ActorCard,
      live: live?.byKey[card.id] ?? null,
      sentAt: live?.sentAt?.[card.id] ?? null,
      submittedAt: live?.submittedAt?.[card.id] ?? null,
      doneAt: live?.doneAt?.[card.id] ?? null,
      now,
    });
    if (actor) return { state: actor.words, spokenState: actor.spoken, dot: ACTOR_DOT[actor.dot], rule };
  }
  const who = vendor === "codex" ? "Codex · " : vendor === "claude" ? "Claude · " : "";
  return { state: `${who}session open`, spokenState: `${who}session open`, dot: "running", rule };
}

export function builderSessionName(card: SessionCardInput): string {
  const number = card.ghIssueNumber != null ? ` #${card.ghIssueNumber}` : "";
  return `Card${number} · ${card.title}`;
}

/** GH #293: the header's tone as the row's dot — one source of truth. */
const TONE_DOT: Record<TileTone, SessionDot> = {
  running: "running",
  ready: "empty",
  pending: "empty",
  exited: "empty",
  ended: "empty",
  done: "done",
  quiet: "error",
  // QoL 1.168 (block 10, A6): a shell's error keeps the ring; a real
  // crash is the filled red its header has.
  failed: "error",
  crashed: "crashed",
  // Challenger round 1: waiting on the member is the Inbox's amber, not a
  // failure's ring.
  asks: "warn",
};

/** QoL 1.168 (D7): the tones a tile row draws in words under its name. */
const TONE_SHOWN: ReadonlySet<TileTone> = new Set<TileTone>(["asks", "quiet", "failed", "crashed"]);

/** Challenger round 1: what a waiting tile's row says after "Claude · " —
 *  the row's own words, short, beside the tile's name. */
export function tileQuestionRowWords(question: TileQuestion, resetsAt?: string | null): string {
  switch (question) {
    case "trust":
      return "asks to trust the folder";
    case "usageLimit":
      // 1.171.0 C2 (CF8): the session word Paused, as its header says it.
      return lowerFirst(pausedLabel(resetsAt));
    case "bypass":
      return "asks to work without asking";
    default:
      return lowerFirst(SESSION_WORDS.asks);
  }
}

function lowerFirst(w: string): string {
  return w.charAt(0).toLowerCase() + w.slice(1);
}

/** GH #293: the tone in a word that does not tick. */
const TONE_WORD: Record<TileTone, string> = {
  running: "working",
  ready: "ready",
  pending: "starting",
  exited: "exited",
  ended: "ended",
  done: "done",
  quiet: "no output for a while",
  failed: "failed",
  crashed: "stopped unexpectedly",
  asks: "asks you something",
};

/** Owner (2026-10-19): a shell says shell words. Its header reads
 *  "Running", so its row (the sidebar's tooltip and accessible name, the
 *  other workspaces' stack) says "running", never an agent's "working". */
export function tileToneWord(kind: string, tone: TileTone): string {
  if (kind === "shell" && tone === "running") return "running";
  // 1.171.0 C2 (CF8): an AI at its prompt is the person's turn; a shell is
  // ready.
  if (kind !== "shell" && tone === "ready") return lowerFirst(SESSION_WORDS.yourTurn);
  // (Challenger 5) An AI gone quiet is the person's turn too, as on a card.
  if ((kind === "claude" || kind === "codex") && tone === "quiet") return lowerFirst(SESSION_WORDS.yourTurn);
  return TONE_WORD[tone];
}

function tileTone(tile: SessionTileInput, now: number): TileTone {
  return tileLine(tile, now).tone;
}

function tileLine(tile: SessionTileInput, now: number) {
  return tileStatusLine({
    kind: tile.kind,
    status: tile.status as TileStatusKind,
    exitCode: tile.exitCode ?? null,
    startedAt: tile.startedAt ?? now,
    sessionBusy: tile.sessionBusy,
    sessionTurnStartedAt: tile.sessionTurnStartedAt,
    readiness: tile.readiness,
    lastOutputAt: tile.lastOutputAt,
    question: tile.question,
    now,
  });
}

export function tileSessionDot(tile: SessionTileInput, now: number = Date.now()): SessionDot {
  return TONE_DOT[tileTone(tile, now)];
}

/** Every live session of the workspace, Builders first — the rail's order. */
export function sessionRows(
  tiles: readonly SessionTileInput[],
  cards: readonly SessionCardInput[],
  now: number = Date.now(),
  live?: LiveSessions,
): SessionRow[] {
  const all: SessionRow[] = [];
  for (const card of cards) {
    // SL-6: built by both and not picked — each build's own session.
    if (card.buildBoth && !card.buildBoth.outcome) {
      for (const lane of card.buildBoth.lanes) {
        if (!lane.ptyId) continue;
        const key = laneKey(card.id, lane.lane);
        const actor = laneActor({
          card: { worktreeSetup: card.worktreeSetup, buildBoth: card.buildBoth },
          lane: lane.lane,
          live: live?.byKey[key] ?? null,
          sentAt: live?.sentAt?.[key] ?? null,
          submittedAt: live?.submittedAt?.[key] ?? null,
          now,
        });
        all.push({
          key: `builder-${key}`,
          kind: "builder",
          lane: lane.lane,
          name: `${builderSessionName(card)} · ${lane.vendor === "codex" ? "Codex" : "Claude"}'s build`,
          dot: ACTOR_DOT[actor.dot],
          state: actor.words,
          spokenState: actor.spoken,
          plainShell: false,
          target: { kind: "card", cardId: card.id },
        });
      }
      continue;
    }
    if (!card.builder?.ptyId) continue;
    const { state, spokenState, dot, rule } = builderRowState(card, live, now);
    all.push({
      key: `builder-${card.id}`,
      kind: "builder",
      name: builderSessionName(card),
      dot,
      state,
      spokenState,
      plainShell: false,
      target: { kind: "card", cardId: card.id },
      ...(rule ? { rule } : {}),
    });
  }
  const tileRow = (tile: SessionTileInput): SessionRow => {
    const line = tileLine(tile, now);
    const tone = line.tone;
    // P3: a waiting session says what it waits on, as its header does.
    // QoL 1.168 (block 10 Mac walk): an ended tile says its header's words
    // ("stopped unexpectedly", "ended · error code 1").
    const word =
      tone === "asks" && tile.question
        ? `${tile.kind === "codex" ? "Codex" : "Claude"} · ${tileQuestionRowWords(tile.question, tile.questionResetsAt)}`
        : ((tone === "failed" || tone === "crashed") && isRestartableKind(tile.kind)) || line.text === STARTING
          ? line.text.charAt(0).toLowerCase() + line.text.slice(1)
          : tileToneWord(tile.kind, tone);
    return {
      key: `tile-${tile.id}`,
      kind: "tile",
      name: tile.label,
      dot: TONE_DOT[tone],
      tone,
      state: word,
      spokenState: word,
      plainShell: tile.kind === "shell" && !tile.tryOf,
      ...(TONE_SHOWN.has(tone) ? { stateLine: true } : {}),
      target: { kind: "terminals", tileId: tile.id },
    };
  };
  // TI-2: a card's Try session sits with the card's sessions — after its
  // last Builder row, or after every Builder when it has none live.
  const tries = tiles.filter((t) => t.tryOf);
  const placed = new Set<string>();
  const withTries: SessionRow[] = [];
  all.forEach((row, i) => {
    withTries.push(row);
    const cardId = row.target.kind === "card" ? row.target.cardId : null;
    const next = all[i + 1];
    const lastOfCard = !next || next.target.kind !== "card" || next.target.cardId !== cardId;
    if (!cardId || !lastOfCard) return;
    for (const tile of tries) {
      if (tile.tryOf?.cardId !== cardId || placed.has(tile.id)) continue;
      placed.add(tile.id);
      withTries.push(tileRow(tile));
    }
  });
  for (const tile of tries) {
    if (!placed.has(tile.id)) withTries.push(tileRow(tile));
  }
  for (const tile of tiles) {
    if (!tile.tryOf) withTries.push(tileRow(tile));
  }
  return withTries;
}

/** GH #117: the number beside Terminals — the sessions listed under it,
 *  tiles and Builders alike, so the count and the rows never disagree. */
export function terminalsCount(rows: readonly SessionRow[]): number {
  return rows.length;
}

/** SP-7: the live card sessions, for the Terminals page that has no tile
 *  of its own: each opens on its card. Windows parity walk: one link per
 *  session — a card built by both lists each build ("Card · Win abs ·
 *  Claude's build", "… · Codex's build"), with its lane, so the link opens
 *  the card on that build's session — never one link for two sessions. */
export type CardSessionLink = { key: string; cardId: string; lane?: BuildLaneId; name: string };
export function cardSessionLinks(cards: readonly SessionCardInput[]): CardSessionLink[] {
  const out: CardSessionLink[] = [];
  for (const row of sessionRows([], cards)) {
    if (row.target.kind !== "card") continue;
    out.push({
      key: row.key,
      cardId: row.target.cardId,
      ...(row.lane ? { lane: row.lane } : {}),
      name: row.name,
    });
  }
  return out;
}

/** SP-7: the empty Terminals page's sentence — no tile of its own, and
 *  where its card sessions are when it has some. 1.174.0 E7 (G16): the
 *  project's name is already in the breadcrumb. */
export function terminalsEmptyWords(cardSessions: number): string {
  if (cardSessions === 0) return "No sessions here yet.";
  return cardSessions === 1
    ? "No sessions of your own here yet. 1 card session opens on its card."
    : `No sessions of your own here yet. ${cardSessions} card sessions open on their cards.`;
}
