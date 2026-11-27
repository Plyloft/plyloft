/**
 * GH #138 — the shell's drop guard.
 *
 * `dragDropEnabled` is false on the main window (AGENTS.md hard rule 6), so
 * the OS hands drops to the web layer. Every real drop target handles its own
 * (`Tile`, `Terminal`, `CardDetailPanel` attachments, `FilesPanel`,
 * `KanbanBoard`, CodeMirror) — but nothing handled the rest of the window, and
 * there WKWebView does what a browser does: it opens the dropped file and the
 * whole shell is gone from under the user.
 *
 * The guard is installed once, at the shell (`main.tsx`), on `window`, **in
 * the capture phase** — before any target, so nothing a descendant does can
 * get past it. `stopPropagation()` in particular cannot: the board's column
 * delegation calls it, and a bubble-phase guard would simply never run.
 *
 * Because capture runs first, `event.defaultPrevented` is not yet an answer to
 * "does a real target want this?". The answer comes from an **explicit
 * registry**: a rule matches a zone's root element and names the payload kinds
 * that zone accepts. A zone claims a drag only when it accepts what the drag
 * is actually carrying, so a text field keeps its text drops and refuses a
 * Finder file — the UA does not accept a file drop on a text field, and the
 * navigation default is still sitting behind it.
 *
 * Everything unclaimed is refused: `preventDefault()` on `dragenter`,
 * `dragover`, `dragleave` and `drop`, and `dropEffect = "none"` so the cursor
 * says the drop will do nothing.
 *
 * **Why there is no "the drop failed" message.** Measured in Chrome with real
 * (CDP-dispatched) drag events: cancelling `dragover` with
 * `dropEffect = "none"` makes the UA cancel the gesture on release — the
 * sequence is `dragenter, dragover, dragover, dragleave, dragend` and **no
 * `drop` ever arrives**. With `"copy"` it does. So with the cursor the brief
 * asks for there is no `drop` to announce, and for a drag that came from
 * outside the app there is no `dragend` either: a release over open ground
 * and the pointer leaving the window produce exactly the same events. The one
 * signal that separates them is the OS drag session, which is behind the
 * `dragDropEnabled` flag hard rule 6 forbids and which would break every
 * internal drag in the app.
 *
 * So the guard does not infer a failed drop from silence. It raises the
 * guidance **while**
 * the drag is over ground that will refuse it and takes it down when the drag
 * is claimed or ends — one message, on screen at the moment of release
 * because it has been on screen the whole hover, and it says where drops go
 * rather than what just happened. Nothing infers a release from inactivity:
 * `HINT_IDLE_MS` of drag silence only *hides* the guidance, which asserts
 * nothing about how the drag ended. The one moment there is nothing to infer
 * is a `drop` that does arrive over open ground: a release happened, here,
 * and was refused — so that is said outright, once, in a message that
 * outlives the gesture.
 */

import { dragFileCount, dropRefusalWords, type DropRefusalKind } from "./terminalDropWords.ts";

/** What the guard says while a drag is over ground that will refuse it. */
export const UNHANDLED_DROP_MESSAGE =
  "Drop files on a terminal, a card, or the editor";

/** 1.172.2 D1: what the guard says while a drag from another app that
 *  carries no file at all is over a place that takes files — a terminal, a
 *  card. Measured (ux-1722/measure.md): a fresh screenshot dragged from its
 *  floating thumbnail is only a promise of a file until it is saved, and
 *  with `dragDropEnabled` off (hard rule 6) the webview gets no file from
 *  it. The saved file drags fine. */
export const UNSAVED_DRAG_MESSAGE =
  "This screenshot isn't saved yet. Let it finish, then drag the file.";

/** Marker naming a drop zone; its value is for debugging only. */
export const DROP_ZONE_ATTR = "data-drop-zone";
export const DROP_ZONE_SELECTOR = `[${DROP_ZONE_ATTR}]`;
/** Space-separated `DragPayloadKind`s that zone accepts. */
export const DROP_ACCEPTS_ATTR = "data-drop-accepts";

/** 1.174.0 E6 (P23): a zone that takes nothing and says so in its own words
 *  (a Codex chat tile). Its value is a `DropRefusalKind`; the zone shows its
 *  words itself while the drag is over it, so the guard's generic guidance
 *  stands down there, and a release that lands on it anyway is announced
 *  with the zone's words, not the generic ones. */
export const DROP_REFUSAL_ATTR = "data-drop-refusal";

const REFUSAL_KINDS: ReadonlySet<string> = new Set<DropRefusalKind>(["codex-chat"]);

/** Drag silence for this long takes the guidance down: the drag is no longer
 *  over us, whether it was released, cancelled or carried out of the window.
 *  Hiding a hint concludes nothing about which — and a UA repeats `dragover`
 *  at least every 350ms while a drag is in flight, so it cannot elapse while
 *  the drag is still here. */
export const HINT_IDLE_MS = 1200;

/** Drag silence for this long means the next drag event belongs to a new
 *  gesture, so the guidance is owed again.
 *
 *  This is the only thing inactivity decides, and it decides nothing about
 *  how the previous gesture ended — a drag carried out of the window and a
 *  drag released over a gap look identical here, and neither is announced.
 *  Longer than `HINT_IDLE_MS` on purpose: leaving the window, hovering over
 *  another app and coming back is one gesture, and it is told once. */
export const GESTURE_GAP_MS = 5000;

/** Has `at` begun a gesture the guard has not seen before? */
export function startsNewGesture(
  lastEventAt: number | null,
  at: number,
  gapMs: number = GESTURE_GAP_MS,
): boolean {
  return lastEventAt === null || at - lastEventAt >= gapMs;
}

/** A backstop only. The guard takes its own guidance down when the drag ends;
 *  this is what keeps a toast from living forever if a `dragend` and every
 *  drag event were somehow lost at once. */
export const GUIDANCE_TOAST_TTL_MS = 30_000;

// ── payloads ──────────────────────────────────────────────────────────────

export const ATELIER_PATH_TYPE = "application/x-atelier-path";
export const ATELIER_CARD_TYPE = "application/x-atelier-card";
export const EXTERNAL_FILES_TYPE = "Files";

export type DragPayloadKind =
  | "card"
  | "path"
  | "files"
  | "uri"
  | "html"
  | "text";

/** Every kind a transfer can carry. `REQUIRED_DRAG_KINDS` and
 *  `ALTERNATIVE_DRAG_KINDS` below split them into the ones a target must take
 *  as themselves and the ones that stand in for each other. */
export const DRAG_PAYLOAD_KINDS: readonly DragPayloadKind[] = [
  "card",
  "path",
  "files",
  "uri",
  "html",
  "text",
];

export type DragPayload = Readonly<Record<DragPayloadKind, boolean>>;

export const EMPTY_PAYLOAD: DragPayload = {
  card: false,
  path: false,
  files: false,
  uri: false,
  html: false,
  text: false,
};

/** What a drag is carrying, from its `DataTransfer.types`. */
export function payloadFromTypes(
  types: readonly string[] | null | undefined,
): DragPayload {
  if (!types) return EMPTY_PAYLOAD;
  let files = false;
  let uri = false;
  let html = false;
  let text = false;
  let path = false;
  let card = false;
  for (const type of types) {
    if (type === EXTERNAL_FILES_TYPE) files = true;
    else if (type === "text/uri-list") uri = true;
    // `text/html` is its own kind: nothing in Ply reads it, and folding it
    // into `text` made a zone that only consumes `text/plain` claim an
    // HTML-only drag and then silently discard it.
    else if (type === "text/html") html = true;
    else if (type === "text/plain") text = true;
    else if (type === ATELIER_PATH_TYPE) path = true;
    else if (type === ATELIER_CARD_TYPE) card = true;
  }
  return { card, path, files, uri, html, text };
}

/** Could following this drag's default action replace the app's page? Files,
 *  URLs and text are all navigable in a webview; the app's own internal types
 *  are carried by drags that started here and cannot navigate anything. */
export function payloadCanNavigate(payload: DragPayload): boolean {
  return payload.files || payload.uri || payload.html || payload.text;
}

/** The kinds that are a distinct thing in their own right: a file, or an
 *  identity only this app can read. A target that cannot take the payload
 *  *as that* must not claim it — nothing else in the transfer stands in for
 *  a file, and an internal drag's `text/plain` is only a WKWebView fallback,
 *  not what the drag is. In precedence order. */
export const REQUIRED_DRAG_KINDS: readonly DragPayloadKind[] = [
  "card",
  "path",
  "files",
];

/** Interchangeable renderings of one dragged run of text: a target that
 *  takes either of them gets the whole drag, because the other is the same
 *  content in another encoding.
 *
 *  `html` is deliberately absent. It is an alternative too, but nothing in
 *  Ply reads `text/html`, so it can never be the one a target consumes — and
 *  a transfer that offers *only* HTML has no alternative left and is refused.
 *  It must not be allowed to veto the `text/plain` beside it either: dragging
 *  selected text out of a web page carries both. */
export const ALTERNATIVE_DRAG_KINDS: readonly DragPayloadKind[] = [
  "uri",
  "text",
];

/** What this drag must be taken *as*, or null when it is only text. */
export function requiredDragKind(
  payload: DragPayload,
): DragPayloadKind | null {
  for (const kind of REQUIRED_DRAG_KINDS) {
    if (payload[kind]) return kind;
  }
  return null;
}

/** Does a target that consumes `kinds` accept this drag? The single question
 *  both the guard's registry and the targets' own handlers ask, so the two
 *  cannot drift into disagreeing about the same drop.
 *
 *  A Finder file arrives as `Files` **and** `text/uri-list` **and**
 *  `text/plain`. Claiming it because a zone happens to take one of those —
 *  a text field taking `text/plain` — would leave the file itself unconsumed
 *  and the webview's "open the file" default still standing behind it. So a
 *  file-bearing transfer is only ever a file's. Text and URLs are the other
 *  way round: they are alternatives, and a target that reads any one of them
 *  has read the drag. */
export function payloadAccepted(
  payload: DragPayload,
  kinds: readonly DragPayloadKind[],
): boolean {
  const required = requiredDragKind(payload);
  if (required !== null) return kinds.includes(required);
  for (const kind of ALTERNATIVE_DRAG_KINDS) {
    if (payload[kind] && kinds.includes(kind)) return true;
  }
  return false;
}

export function payloadIsEmpty(payload: DragPayload): boolean {
  return !DRAG_PAYLOAD_KINDS.some((kind) => payload[kind]);
}

// ── the registry ──────────────────────────────────────────────────────────

/** The slice of `Element` the pure resolver needs. Keeping it structural is
 *  what lets the contract tests run without a DOM. */
export interface DropNode {
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  readonly parentElement: DropNode | null;
}

export interface DropZoneRule {
  /** Matches the zone's root element. */
  selector: string;
  /** The payload kinds this zone takes, or null to read them from the
   *  element's `data-drop-accepts`. */
  accepts: readonly DragPayloadKind[] | null;
}

const KIND_SET = new Set<string>(DRAG_PAYLOAD_KINDS);

/** Read a `data-drop-accepts` value. Unknown words are dropped rather than
 *  widening a zone by accident. */
export function parseAccepts(value: string | null): DragPayloadKind[] {
  if (!value) return [];
  const kinds: DragPayloadKind[] = [];
  for (const word of value.split(/\s+/)) {
    if (KIND_SET.has(word) && !kinds.includes(word as DragPayloadKind)) {
      kinds.push(word as DragPayloadKind);
    }
  }
  return kinds;
}

/** Ancestor walks are bounded: a detached or cyclic parent chain must not
 *  hang the drag loop. */
const MAX_ANCESTOR_DEPTH = 512;

/** The element an event's target belongs to, when it is one at all. */
export function asDropTarget(target: EventTarget | null): DropNode | null {
  if (!target) return null;
  const candidate = target as Partial<DropNode>;
  if (typeof candidate.matches !== "function") return null;
  if (typeof candidate.getAttribute !== "function") return null;
  return candidate as DropNode;
}

/** Does a zone nested inside `self` own this drop?
 *
 *  Two handlers can both be on the path of one drop: a tile's own listener
 *  sits on the tile root, and the terminal pane inside it has handlers of
 *  its own. Both used to write the dropped path into the PTY, so a file row
 *  dropped on a terminal body was typed twice — the tile's native listener
 *  runs while the event bubbles, and React dispatches the pane's handler
 *  afterwards at the root container, too late for its `stopPropagation` to
 *  undo anything.
 *
 *  The registry already says who owns what. An outer handler asks this and
 *  stands down when a marked zone nearer the target than itself will take
 *  the drop. */
export function nestedZoneOwnsDrop(
  target: DropNode | null,
  self: unknown,
): boolean {
  let node: DropNode | null = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (node.matches(DROP_ZONE_SELECTOR)) return node !== self;
    node = node.parentElement;
  }
  return false;
}

/** The nearest zone above `target` that accepts what this drag is carrying.
 *
 *  "What it is carrying" is decided by `payloadAccepted`: a Finder file that
 *  also carries `text/plain` is a file and a text field does not get to claim
 *  it, while text dragged out of a web page is claimed by anything reading
 *  either of the encodings it offers.
 *
 *  A zone that matches but does not accept the payload is not a claim — the
 *  walk continues outward, because a wider zone may still take it (a file
 *  dropped on the terminal's search input belongs to the terminal pane). */
export function findAcceptingZone(
  target: DropNode | null,
  payload: DragPayload,
  rules: readonly DropZoneRule[],
): DropZoneRule | null {
  if (rules.length === 0) return null;
  if (payloadIsEmpty(payload)) return null;
  let node: DropNode | null = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
    for (const rule of rules) {
      if (!node.matches(rule.selector)) continue;
      const accepts =
        rule.accepts ?? parseAccepts(node.getAttribute(DROP_ACCEPTS_ATTR));
      if (payloadAccepted(payload, accepts)) return rule;
    }
    node = node.parentElement;
  }
  return null;
}

// ── what each target really consumes ──────────────────────────────────────
//
// One list per target, used for **both** its `data-drop-accepts` marker and
// its own handlers' acceptance check. The guard refuses in the capture phase
// and a target's handler runs afterwards, so if the two disagreed the handler
// would put the copy cursor and its highlight back on a drop the guard had
// just refused, and the user would be invited to drop something that lands
// nowhere. Sharing the list is what makes that impossible.

/** `Terminal.handleHtmlDrop`: an internal path, a URL, plain text, or files
 *  materialized through `fs_save_dropped_file`. */
export const TERMINAL_DROP_KINDS: readonly DragPayloadKind[] = [
  "files",
  "path",
  "uri",
  "text",
];

/** `CardDetailPanel`'s attachments: `dataTransfer.files` and nothing else. */
export const CARD_FILES_DROP_KINDS: readonly DragPayloadKind[] = ["files"];
/** 1.172.2 D5: the whole card page — a file dropped anywhere on it joins
 *  the card's Files. Files only, as the Files area. */
export const CARD_PAGE_DROP_KINDS: readonly DragPayloadKind[] = ["files"];
/** A card's Chat composer: a file dropped there waits for the next message
 *  (card chat, part 2). Finder files only, as the card's Files. */
export const CARD_CHAT_DROP_KINDS: readonly DragPayloadKind[] = ["files"];

/** A board column: a card move. */
export const BOARD_COLUMN_DROP_KINDS: readonly DragPayloadKind[] = ["card"];

/** A `FilesPanel` row: an internal path, to reorder its siblings. */
export const FILES_ROW_DROP_KINDS: readonly DragPayloadKind[] = ["path"];

/** A tile's own listener writes a path or plain text into its PTY. */
export const TILE_DROP_KINDS: readonly DragPayloadKind[] = ["path", "text"];

/** The editor opens a dropped file, from the filesystem or from `FilesPanel`. */
export const EDITOR_DROP_KINDS: readonly DragPayloadKind[] = ["files", "path"];

/** Write a kind list as its `data-drop-accepts` value. */
export function acceptsAttr(kinds: readonly DragPayloadKind[]): string {
  return kinds.join(" ");
}

/** The acceptance question, asked of a live drag event. A target's handlers
 *  call this before claiming, highlighting or setting a drop effect. */
export function acceptsDrag(
  event: { dataTransfer: { types: readonly string[] } | null },
  kinds: readonly DragPayloadKind[],
): boolean {
  return payloadAccepted(dragPayloadFor(event), kinds);
}

// ── native targets the UA itself serves ───────────────────────────────────

/** CodeMirror's content. It is `contenteditable` and its own `drop` handler
 *  inserts dropped text. Files and internal paths are **not** its: the editor
 *  host around it claims those and opens them (`EDITOR_DROP_KINDS`), which is
 *  what the brief asks a dropped file on the editor to do. */
export const CODEMIRROR_CONTENT_SELECTOR = ".cm-content";

/** Text fields the UA inserts dropped text into. Readonly and disabled ones
 *  are deliberately absent: they accept nothing, so a drop on them would fall
 *  through to the webview's own default. */
export const EDITABLE_TEXT_FIELD_SELECTOR = [
  "textarea",
  "input:not([type])",
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="password"]',
  'input[type="number"]',
]
  .map((base) => `${base}:not([readonly]):not(:disabled)`)
  .join(", ");

/** A `contenteditable` host that is not CodeMirror's. */
export const EDITABLE_HOST_SELECTOR = [
  '[contenteditable=""]',
  '[contenteditable="true"]',
]
  .map((base) => `${base}:not(${CODEMIRROR_CONTENT_SELECTOR})`)
  .join(", ");

/** A file picker really does take files. */
export const FILE_INPUT_SELECTOR = 'input[type="file"]:not(:disabled)';

/** What a plain text field takes. **Not** `files`: inserting dropped text is
 *  a native behaviour, opening a dropped file is not, and the webview's
 *  navigation default is still behind it. */
export const NATIVE_TEXT_KINDS: readonly DragPayloadKind[] = [
  "text",
  "uri",
  "card",
  // A dragged file row is a path string: a field inserts it, which is a real
  // workflow (a path into an agent prompt). The editor is the exception —
  // `EDITOR_DROP_KINDS` claims a path there and opens the file instead.
  "path",
];

/** What CodeMirror's own `drop` handler inserts. */
export const CODEMIRROR_KINDS: readonly DragPayloadKind[] = [
  "text",
  "uri",
  "card",
];

// ── what the editor can open ──────────────────────────────────────────────
//
// `files::read_text_file` refuses a file over `MAX_READ_BYTES` or with a NUL
// byte in its first 8 KiB, and returns a message. Asking it first would mean
// pulling the whole file into the webview, shipping it over the IPC and
// writing it into the cache dir — where it would then sit for the fourteen
// days `cache_retention` gives dropped files — only to be told no. So the
// same two rules run here, on the `File` handle, before any of that.
// `dropGuard.test.ts` asserts both against `files.rs` so they cannot drift.

/** Mirrors `files.rs::MAX_READ_BYTES`. */
export const MAX_OPENABLE_BYTES = 5 * 1024 * 1024;
/** Mirrors the NUL scan window in `files.rs::read_text_file`. */
export const BINARY_SNIFF_BYTES = 8192;

/** Why this dropped file cannot be opened as text, or null if it can. */
export function droppedFileRejection(
  file: { name: string; size: number },
  head: Uint8Array,
): string | null {
  if (file.size > MAX_OPENABLE_BYTES) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    return `${file.name} is ${mb(file.size)} MB — the editor opens files up to ${mb(
      MAX_OPENABLE_BYTES,
    )} MB.`;
  }
  const scanned = head.subarray(0, BINARY_SNIFF_BYTES);
  for (const byte of scanned) {
    if (byte === 0) return `${file.name} is not a text file.`;
  }
  return null;
}

// ── the drag session ──────────────────────────────────────────────────────

/** What the drag in flight is carrying, recorded at `dragstart`.
 *
 *  WKWebView strips custom MIME types on internal drags often enough that the
 *  board reads `text/plain` as a fallback, so a mid-drag `dataTransfer.types`
 *  cannot be trusted to still name the drag's own type. At `dragstart` it can:
 *  the source has just written it. Delegated targets that claim a whole area
 *  ask this rather than the event. */
export interface DragSession {
  payload: DragPayload;
}

/** The record, its stamp, and the clock that stamped it: the guard may be
 *  installed with an injected clock, and a stamp is only ever compared with
 *  the clock it came from. */
let activeSession: (DragSession & { at: number; now: () => number }) | null = null;

/** Owner-side review: a `dragend` can be lost — a Kanban card's node is
 *  unmounted by the move itself, and an event on a disconnected node never
 *  reaches `window` — and a session left standing would speak for every
 *  later drag: a Finder file would read as a card, a text field would claim
 *  it, and the guard would let the window follow it. The record is stamped
 *  and every drag event of the gesture refreshes it, so a live drag is
 *  always fresh and an abandoned one is gone a gesture later. */
export function touchDragSession(at: number): void {
  if (activeSession) activeSession.at = at;
}

/** The drag in flight, when it started inside this document and is still
 *  going: a record nothing has touched for a whole gesture is stale. */
export function activeDragSession(): DragSession | null {
  if (activeSession && activeSession.now() - activeSession.at >= GESTURE_GAP_MS) {
    activeSession = null;
  }
  return activeSession;
}

/** What this event is carrying: the session's record when the drag started
 *  here, the event's own types otherwise. */
export function dragPayloadFor(event: {
  dataTransfer: { types: readonly string[] } | null;
}): DragPayload {
  const session = activeDragSession();
  if (session) return session.payload;
  return payloadFromTypes(event.dataTransfer?.types);
}

/** Is this a card being moved on the board? The board's column delegation
 *  claims a gesture only when this is true, so a file, a URL or text dragged
 *  from another app falls through to the guard instead of being swallowed by
 *  a handler that then finds no card id. */
export function dragIsCardMove(event: {
  dataTransfer: { types: readonly string[] } | null;
}): boolean {
  return dragPayloadFor(event).card;
}

/** Is `target` inside a marked zone that takes files (a terminal, a card,
 *  the editor)? Any one on the way out counts: a tile's own zone takes only
 *  paths and text, the card page around it takes files. */
export function insideFileZone(target: DropNode | null): boolean {
  let node: DropNode | null = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (
      node.matches(DROP_ZONE_SELECTOR) &&
      parseAccepts(node.getAttribute(DROP_ACCEPTS_ATTR)).includes("files")
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** 1.172.2 D5: does a zone between `target` and `self` take this drag?
 *  `self`'s own handlers stand down when it does — the card chat, a
 *  terminal or the card's Files inside a card page keep their drops. A
 *  zone that does not accept the payload (a tile's own, for a file) is
 *  walked past. */
export function innerZoneTakesDrop(
  target: DropNode | null,
  self: unknown,
  payload: DragPayload,
): boolean {
  let node: DropNode | null = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (node === self) return false;
    if (node.matches(FILE_INPUT_SELECTOR) && payload.files) return true;
    if (
      node.matches(DROP_ZONE_SELECTOR) &&
      payloadAccepted(payload, parseAccepts(node.getAttribute(DROP_ACCEPTS_ATTR)))
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

/** 1.174.0 E6: the refusing zone `target` is in, if the nearest marked zone
 *  around it is one. A zone nearer the target that is not a refusing one
 *  (a terminal, a card) speaks for itself instead. */
export function refusingZoneKind(target: DropNode | null): DropRefusalKind | null {
  let node: DropNode | null = target;
  for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (node.matches(DROP_ZONE_SELECTOR)) {
      const kind = node.getAttribute(DROP_REFUSAL_ATTR);
      return kind && REFUSAL_KINDS.has(kind) ? (kind as DropRefusalKind) : null;
    }
    node = node.parentElement;
  }
  return null;
}

// ── the guard's decision ──────────────────────────────────────────────────

export const DRAG_EVENT_TYPES = [
  "dragenter",
  "dragover",
  "dragleave",
  "drop",
] as const;

export type DragGuardEventType = (typeof DRAG_EVENT_TYPES)[number];

/** Not guarded — watched, to record the session above. */
export const DRAG_SESSION_TYPES = ["dragstart", "dragend"] as const;

export interface DropGuardDecision {
  /** Stand aside: a registered zone accepts this payload. */
  claimed: boolean;
  /** Neutralize the default action — the webview's "open the file". */
  block: boolean;
  /** Set `dataTransfer.dropEffect = "none"` so the cursor says so. */
  refuse: boolean;
  /** The guidance applies to this event: the drag is over ground that will
   *  refuse it and could have navigated the window. */
  hint: boolean;
  /** This drag is worth saying something about at all: it came from outside
   *  the app and carries something that could have navigated the window —
   *  or it carries nothing at all over a place that takes files. */
  announceable: boolean;
  /** What the guidance says: where drops go, or (1.172.2 D1) that the
   *  screenshot being dragged isn't saved yet, or (1.174.0 E6) the words of
   *  the refusing zone the drag is over. */
  message: string;
  /** 1.174.0 E6: the drag is over a zone that refuses it and shows its own
   *  words; the guard's toast stays down for the hover. */
  zoneSpeaks: boolean;
}

export function decideDropGuard(input: {
  type: DragGuardEventType;
  target: DropNode | null;
  payload: DragPayload;
  rules: readonly DropZoneRule[];
  /** The drag started in this document, so it could not navigate anything. */
  internal: boolean;
  /** How many files the drag carries (`dragFileCount`); one when unknown. */
  count?: number;
}): DropGuardDecision {
  // 1.172.2 D1: a drag from another app with no file, no text and no link
  // in it, over a terminal or a card — what a screenshot's thumbnail that
  // is not saved yet looks like here. Text and links are never this.
  const unsaved =
    !input.internal &&
    payloadIsEmpty(input.payload) &&
    insideFileZone(input.target);
  const announceable =
    unsaved || (!input.internal && payloadCanNavigate(input.payload));
  // A refusing zone's words are about files: a dragged link or text gets
  // the generic message there.
  const refusing =
    unsaved || !(input.payload.files || input.payload.path) ? null : refusingZoneKind(input.target);
  const message = unsaved
    ? UNSAVED_DRAG_MESSAGE
    : refusing
      ? dropRefusalWords(refusing, input.count ?? 1)
      : UNHANDLED_DROP_MESSAGE;
  if (findAcceptingZone(input.target, input.payload, input.rules)) {
    return {
      claimed: true,
      block: false,
      refuse: false,
      hint: false,
      announceable,
      message,
      zoneSpeaks: false,
    };
  }
  // `dropEffect` is only writable while the drag is in flight; on `drop` the
  // transfer is read-only and the effect no longer steers anything.
  const refuse = input.type !== "drop";
  // While the drag is over open ground, not only as it arrives: the guidance
  // stays up for the whole hover, so it is still on screen at the release.
  // A refusing zone shows its own words over itself (E6), so the toast
  // does not say them a second time.
  const zoneSpeaks = refusing !== null;
  const hint =
    !zoneSpeaks &&
    announceable &&
    input.type !== "drop" &&
    input.type !== "dragleave";
  return { claimed: false, block: true, refuse, hint, announceable, message, zoneSpeaks };
}

/** What the guard should do with its guidance for this event. */
export type GuidanceAction = "show" | "hide" | "announce" | "leave";

export function guidanceFor(
  decision: DropGuardDecision,
  type: DragGuardEventType,
): GuidanceAction {
  // A `drop` that actually arrives over open ground is the one unambiguous
  // thing in this whole model: a release happened, here, and was refused.
  // There is no inference in it, so it is said outright — once, and as a
  // message that outlives the gesture rather than the hover hint, which goes
  // with the drag. (The UA usually does not deliver it: see the header. When
  // it does, this is the release feedback.)
  if (type === "drop") {
    return !decision.claimed && decision.announceable ? "announce" : "hide";
  }
  if (decision.hint) return "show";
  // A real target has it: the guidance has nothing left to say. Over a zone
  // that refuses in its own words (E6), the generic toast goes too.
  if (decision.claimed || (decision.zoneSpeaks && type !== "dragleave")) return "hide";
  return "leave";
}

// ── installation ──────────────────────────────────────────────────────────

export interface DropGuardDeps {
  /** The window to guard. Injected so the contract tests can drive a fake. */
  window: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
  >;
  /** The registry, read per event so late-mounted zones count. */
  rules: () => readonly DropZoneRule[];
  /** Put the guidance on screen and return its handle.
   *
   *  Called on **every** event the guidance applies to, with the handle it
   *  last returned. It must be idempotent: if that handle is still on
   *  screen, return it unchanged; if it is gone — the toast's own backstop
   *  expired under a long hover — raise it again and return the new one.
   *  The guard cannot see the screen, so this is where that is decided.
   *  `message` is what it says; the guard takes a showing one down itself
   *  before it raises one that says something else. */
  showGuidance: (previous: string | null, message: string) => string;
  /** Take it down again. */
  hideGuidance: (handle: string) => void;
  /** A release really did land on open ground and was refused. Said once,
   *  and it outlives the gesture — unlike the hover guidance, which goes
   *  with the drag. */
  announceRejectedDrop: (message: string) => void;
  idleMs?: number;
  gestureGapMs?: number;
  now?: () => number;
}

/** Install the shell's drop guard. Returns the uninstaller. */
export function installDropGuard(deps: DropGuardDeps): () => void {
  const idleMs = deps.idleMs ?? HINT_IDLE_MS;
  const gapMs = deps.gestureGapMs ?? GESTURE_GAP_MS;
  const now = deps.now ?? (() => Date.now());
  const win = deps.window;
  /** The guidance currently on screen, if any. There is only ever one. */
  let guidance: string | null = null;
  /** What the guidance on screen says. */
  let shownMessage: string | null = null;
  /** What this gesture has already been told. Leaving the window and coming
   *  back is the same gesture, and is not told twice; a different message
   *  (1.172.2 D1: the screenshot isn't saved yet) is still owed once. */
  let spoken = new Set<string>();
  let lastEventAt: number | null = null;
  let idleTimer = 0;

  function raise(message: string) {
    // One message at a time: a different one replaces what is showing.
    if (guidance !== null && shownMessage !== message) hide();
    // Asked every time the guidance is already up, not only when the guard
    // thinks nothing is showing: the message must not be able to expire
    // under a drag the user is still holding. `showGuidance` is idempotent
    // while its handle is on screen.
    guidance = deps.showGuidance(guidance, message);
    shownMessage = message;
    spoken.add(message);
  }
  function hide() {
    if (guidance !== null) {
      deps.hideGuidance(guidance);
      guidance = null;
      shownMessage = null;
    }
  }
  function endGesture() {
    hide();
    spoken = new Set();
    lastEventAt = null;
  }
  function disarmIdle() {
    if (idleTimer !== 0) {
      win.clearTimeout(idleTimer);
      idleTimer = 0;
    }
  }
  function armIdle() {
    disarmIdle();
    // Only ever hides. Nothing is concluded about how the drag ended, and
    // the gesture itself is not ended here — a drag that left the window
    // and comes back is still the same one, and still already spoken for.
    idleTimer = win.setTimeout(() => {
      idleTimer = 0;
      hide();
    }, idleMs);
  }

  function onDrag(event: Event) {
    const e = event as DragEvent;
    const at = now();
    // The gesture is alive: its record does not go stale under it.
    touchDragSession(at);
    if (startsNewGesture(lastEventAt, at, gapMs)) spoken = new Set();
    lastEventAt = at;
    const payload = dragPayloadFor(e);
    const decision = decideDropGuard({
      type: e.type as DragGuardEventType,
      target: asDropTarget(e.target),
      payload,
      rules: deps.rules(),
      internal: activeSession !== null,
      count: dragFileCount(e.dataTransfer),
    });
    switch (guidanceFor(decision, e.type as DragGuardEventType)) {
      case "show":
        // Once per gesture. Crossing a real target takes it down, and
        // coming back does not put it up again; only the self-heal above
        // keeps a message that is already up from expiring.
        if (guidance !== null || !spoken.has(decision.message)) raise(decision.message);
        armIdle();
        break;
      case "hide":
        disarmIdle();
        hide();
        break;
      case "announce":
        disarmIdle();
        hide();
        deps.announceRejectedDrop(decision.message);
        break;
      case "leave":
        // A `dragleave` on its way somewhere else: keep what is showing and
        // let the idle timer decide, so crossing a boundary does not
        // flicker.
        armIdle();
        break;
    }
    // A release ends the gesture, whoever took it.
    if (e.type === "drop") {
      disarmIdle();
      endGesture();
    }
    if (decision.claimed) return;
    e.preventDefault();
    if (decision.refuse && e.dataTransfer) {
      // Never worth throwing out of a listener: the preventDefault above is
      // what keeps the window, and it has already run.
      try {
        e.dataTransfer.dropEffect = "none";
      } catch {
        /* not writable in this phase */
      }
    }
  }

  function onSession(event: Event) {
    if (event.type === "dragstart") {
      const e = event as DragEvent;
      activeSession = { payload: payloadFromTypes(e.dataTransfer?.types), at: now(), now };
      disarmIdle();
      endGesture();
    } else {
      activeSession = null;
      // The drag really is over: this one the UA told us about.
      disarmIdle();
      endGesture();
    }
  }

  // Capture, so nothing a descendant does — `stopPropagation()` above all —
  // can get in front of the refusal.
  for (const type of DRAG_EVENT_TYPES) win.addEventListener(type, onDrag, true);
  // Bubble, so the source's own `dragstart` handler has already written its
  // data by the time the session is recorded.
  for (const type of DRAG_SESSION_TYPES) win.addEventListener(type, onSession);
  return () => {
    activeSession = null;
    disarmIdle();
    endGesture();
    for (const type of DRAG_EVENT_TYPES)
      win.removeEventListener(type, onDrag, true);
    for (const type of DRAG_SESSION_TYPES)
      win.removeEventListener(type, onSession);
  };
}

// ── navigation guard ──────────────────────────────────────────────────────
//
// The categorical refusal lives in the native webview navigation policy
// (`src-tauri/src/navigation.rs`), because cancelling `beforeunload` only
// *asks* the UA to prompt and the UA may decline to. What is left here is the
// in-page half: an off-page anchor never gets as far as the policy.

/** Schemes the OS, not the webview, takes: following one does not navigate
 *  the page, so the guard leaves them alone. Kept in step with
 *  `navigation.rs::HANDED_OFF_SCHEMES`. */
export const HANDED_OFF_SCHEMES = ["mailto:", "tel:", "sms:", "facetime:"];

export type NavigationVerdict = "allow" | "refuse";

/**
 * Ply is a fixed single page: nothing legitimate navigates it. Anything that
 * resolves to another document is refused.
 */
export function classifyNavigation(
  href: string | null | undefined,
  currentHref: string,
): NavigationVerdict {
  const raw = (href ?? "").trim();
  if (raw === "") return "allow";
  if (raw.startsWith("#")) return "allow";
  for (const scheme of HANDED_OFF_SCHEMES) {
    if (raw.toLowerCase().startsWith(scheme)) return "allow";
  }
  let target: URL;
  let current: URL;
  try {
    current = new URL(currentHref);
    target = new URL(raw, currentHref);
  } catch {
    return "refuse";
  }
  if (target.origin !== current.origin) return "refuse";
  if (target.pathname !== current.pathname) return "refuse";
  if (target.search !== current.search) return "refuse";
  return "allow";
}

export interface NavigationGuardDeps {
  document: Pick<Document, "addEventListener" | "removeEventListener">;
  /** The app's own page. */
  currentHref: () => string;
  /** Told when a navigation was refused, so the hole is not silent. */
  onRefused?: (href: string) => void;
}

/** The in-page half of the navigation refusal.
 *
 *  The categorical half is the native policy in `src-tauri/src/navigation.rs`,
 *  which cancels the load outright — but it is handed a URL and no frame, so
 *  it cannot refuse `http(s)` without blanking `BrowserPane`'s iframes (see
 *  that file). Here the frame *is* known, so this is where the top-level
 *  `http(s)` case is held: the three ways content in this document can reach
 *  the main frame are an anchor, a form and `window.open` with a self-ish
 *  target, and all three are refused when they would leave the app's page.
 *  A framed page cannot reach the main frame at all — `BrowserPane`'s iframes
 *  carry a `sandbox` without `allow-top-navigation`.
 *
 *  `location` assignment is the one vector left, and it is unforgeable: no
 *  page code may intercept it. Nothing in Ply assigns to it. */
export function installNavigationGuard(deps: NavigationGuardDeps): () => void {
  function refuse(event: Event, href: string) {
    event.preventDefault();
    deps.onRefused?.(href);
  }
  function onClick(event: Event) {
    const node = event.target as {
      closest?: (
        selector: string,
      ) => { getAttribute(name: string): string | null } | null;
    } | null;
    if (!node || typeof node.closest !== "function") return;
    const anchor = node.closest("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (classifyNavigation(href, deps.currentHref()) === "allow") return;
    refuse(event, href ?? "");
  }
  function onSubmit(event: Event) {
    type Attributed = { getAttribute?: (name: string) => string | null };
    const form = event.target as Attributed | null;
    if (!form || typeof form.getAttribute !== "function") return;
    // The button that submitted may override both, and a `formaction`
    // pointing off-page is the same navigation by another route.
    const submitter = (event as { submitter?: Attributed | null }).submitter;
    const from = (name: string) => {
      const own =
        submitter && typeof submitter.getAttribute === "function"
          ? submitter.getAttribute(`form${name}`)
          : null;
      return own ?? form.getAttribute!(name);
    };
    // A form with no action posts to the current document; one with a target
    // that is not the main frame does not replace it.
    const target = from("target");
    if (target && !SELF_TARGETS.includes(target.toLowerCase())) return;
    const action = from("action");
    if (classifyNavigation(action, deps.currentHref()) === "allow") return;
    refuse(event, action ?? "");
  }
  deps.document.addEventListener("click", onClick, true);
  deps.document.addEventListener("submit", onSubmit, true);
  return () => {
    deps.document.removeEventListener("click", onClick, true);
    deps.document.removeEventListener("submit", onSubmit, true);
  };
}

/** `target` values that mean "this frame" or "the top one" — the ones that
 *  would replace the shell rather than open something beside it. */
export const SELF_TARGETS = ["_self", "_top", "_parent"];

export interface WindowOpenGuardDeps {
  currentHref: () => string;
  /** The real `window.open`, to call for the ones that are allowed. */
  open: (...args: unknown[]) => unknown;
  onRefused?: (href: string) => void;
}

/** `window.open(url, "_self")` replaces the current document, so it is a
 *  top-level navigation wearing another name. Returns the replacement. */
export function guardedWindowOpen(deps: WindowOpenGuardDeps) {
  return function open(...args: unknown[]) {
    // `window.open` stringifies its first argument, so a `URL` object is a
    // navigation just as much as a string is.
    const url =
      args[0] === undefined || args[0] === null ? null : String(args[0]);
    const target = typeof args[1] === "string" ? args[1].toLowerCase() : "";
    const replacesThisPage = SELF_TARGETS.includes(target);
    if (
      replacesThisPage &&
      classifyNavigation(url, deps.currentHref()) === "refuse"
    ) {
      deps.onRefused?.(url ?? "");
      return null;
    }
    return deps.open(...args);
  };
}
