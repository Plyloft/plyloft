// Tier 3 pure-function test. Run with Node 22+:
//   node --experimental-strip-types src/lib/dropGuard.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATELIER_CARD_TYPE,
  ATELIER_PATH_TYPE,
  BOARD_COLUMN_DROP_KINDS,
  CARD_FILES_DROP_KINDS,
  CODEMIRROR_CONTENT_SELECTOR,
  CODEMIRROR_KINDS,
  BINARY_SNIFF_BYTES,
  EDITOR_DROP_KINDS,
  MAX_OPENABLE_BYTES,
  FILES_ROW_DROP_KINDS,
  TERMINAL_DROP_KINDS,
  TILE_DROP_KINDS,
  DROP_ACCEPTS_ATTR,
  DROP_REFUSAL_ATTR,
  refusingZoneKind,
  DROP_ZONE_SELECTOR,
  EDITABLE_HOST_SELECTOR,
  EDITABLE_TEXT_FIELD_SELECTOR,
  EMPTY_PAYLOAD,
  EXTERNAL_FILES_TYPE,
  HANDED_OFF_SCHEMES,
  FILE_INPUT_SELECTOR,
  GUIDANCE_TOAST_TTL_MS,
  GESTURE_GAP_MS,
  HINT_IDLE_MS,
  NATIVE_TEXT_KINDS,
  UNHANDLED_DROP_MESSAGE,
  UNSAVED_DRAG_MESSAGE,
  acceptsAttr,
  classifyNavigation,
  decideDropGuard,
  requiredDragKind,
  droppedFileRejection,
  dragIsCardMove,
  findAcceptingZone,
  guardedWindowOpen,
  nestedZoneOwnsDrop,
  startsNewGesture,
  guidanceFor,
  installDropGuard,
  installNavigationGuard,
  parseAccepts,
  payloadAccepted,
  payloadCanNavigate,
  payloadFromTypes,
  type DragPayload,
  type DropNode,
  type DropZoneRule,
} from "./dropGuard.ts";

// The build constant is named only where check-no-release.sh allows it.
const BRIDGE = ["__PLY", "TEST", "BRIDGE__"].join("_");

// ── a DOM-free element chain ──────────────────────────────────────────────

interface FakeNode extends DropNode {
  readonly selectors: string[];
  readonly attrs: Record<string, string>;
  readonly parentElement: FakeNode | null;
}

function node(
  selectors: string[],
  parent: FakeNode | null = null,
  attrs: Record<string, string> = {},
): FakeNode {
  return {
    selectors,
    attrs,
    parentElement: parent,
    matches(selector: string) {
      // Enough of `Element.matches` for the guard: exact selectors, and the
      // comma-separated lists the native-target rules are written as.
      return selector
        .split(",")
        .some((part) => this.selectors.includes(part.trim()));
    },
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    },
  } as FakeNode;
}

/** A zone marked the way the components mark one. */
function zoneNode(accepts: string, parent: FakeNode | null = null): FakeNode {
  return node([DROP_ZONE_SELECTOR], parent, { [DROP_ACCEPTS_ATTR]: accepts });
}

const FILES = payloadFromTypes([EXTERNAL_FILES_TYPE]);
const TEXT = payloadFromTypes(["text/plain"]);
const URI = payloadFromTypes(["text/uri-list", "text/plain"]);
const CARD = payloadFromTypes([ATELIER_CARD_TYPE, "text/plain"]);
const PATH = payloadFromTypes([ATELIER_PATH_TYPE, "text/plain"]);
/** What a Finder file actually arrives as on WebKit: the file, plus a URL
 *  and a text twin. Claiming it for one of those twins is GH #138 F1. */
const FINDER_FILE = payloadFromTypes([
  EXTERNAL_FILES_TYPE,
  "text/uri-list",
  "text/plain",
]);
const URI_ONLY = payloadFromTypes(["text/uri-list"]);
const HTML_ONLY = payloadFromTypes(["text/html"]);

// ── payloadFromTypes ──────────────────────────────────────────────────────

assert.equal(FILES.files, true);
assert.equal(TEXT.text, true);
// `text/html` is its own kind: nothing in Ply reads it, and folding it into
// `text` made zones that consume only `text/plain` claim it (GH #138 F11).
assert.equal(HTML_ONLY.html, true);
assert.equal(HTML_ONLY.text, false);
assert.equal(URI.uri, true);
assert.equal(CARD.card, true);
assert.equal(CARD.text, true, "a card drag carries the text/plain fallback too");
assert.equal(PATH.path, true);
assert.deepEqual(payloadFromTypes([]), EMPTY_PAYLOAD);
assert.deepEqual(payloadFromTypes(null), EMPTY_PAYLOAD);
// An unknown type is not a payload the guard reasons about.
assert.deepEqual(payloadFromTypes(["application/x-unknown"]), EMPTY_PAYLOAD);

// Files, URLs and text can all replace the page; the app's own types cannot.
assert.equal(payloadCanNavigate(FILES), true);
assert.equal(payloadCanNavigate(URI), true);
assert.equal(payloadCanNavigate(TEXT), true);
assert.equal(
  payloadCanNavigate(payloadFromTypes([ATELIER_PATH_TYPE])),
  false,
);
assert.equal(payloadCanNavigate(EMPTY_PAYLOAD), false);
assert.equal(payloadCanNavigate(HTML_ONLY), true);

// ── requiredDragKind and payloadAccepted (GH #138 F1 + F14) ──────────────

// A file, or an identity only this app can read, must be taken *as that*:
// nothing else in the transfer stands in for it.
assert.equal(requiredDragKind(FINDER_FILE), "files");
assert.equal(requiredDragKind(FILES), "files");
assert.equal(requiredDragKind(CARD), "card");
assert.equal(requiredDragKind(PATH), "path");
// Text, URLs and HTML are alternative renderings of one dragged run of text,
// so none of them is required as itself.
assert.equal(requiredDragKind(URI), null);
assert.equal(requiredDragKind(TEXT), null);
assert.equal(requiredDragKind(HTML_ONLY), null);
assert.equal(requiredDragKind(EMPTY_PAYLOAD), null);

// So a target that takes text does not get a file merely because one rode in
// with a text twin — the file itself would be consumed by nobody and the
// webview's "open the file" default would still be standing behind it.
assert.equal(payloadAccepted(FINDER_FILE, NATIVE_TEXT_KINDS), false);
assert.equal(payloadAccepted(TEXT, NATIVE_TEXT_KINDS), true);
assert.equal(payloadAccepted(FINDER_FILE, CARD_FILES_DROP_KINDS), true);
assert.equal(payloadAccepted(EMPTY_PAYLOAD, TERMINAL_DROP_KINDS), false);

// GH #138 F14: text dragged out of a web page carries `text/html` **and**
// `text/plain`. The HTML must not veto the plain text beside it — every
// target that reads text keeps taking these, as it always did.
const RICH_TEXT = payloadFromTypes(["text/html", "text/plain"]);
const RICH_LINK = payloadFromTypes([
  "text/html",
  "text/uri-list",
  "text/plain",
]);
assert.equal(requiredDragKind(RICH_TEXT), null);
for (const kinds of [
  NATIVE_TEXT_KINDS,
  CODEMIRROR_KINDS,
  TERMINAL_DROP_KINDS,
  TILE_DROP_KINDS,
]) {
  assert.equal(payloadAccepted(RICH_TEXT, kinds), true);
  assert.equal(payloadAccepted(RICH_LINK, kinds), true);
}
// A transfer that offers *only* HTML has no alternative anyone reads left,
// so it is still refused everywhere.
for (const kinds of [
  NATIVE_TEXT_KINDS,
  CODEMIRROR_KINDS,
  TERMINAL_DROP_KINDS,
  TILE_DROP_KINDS,
  CARD_FILES_DROP_KINDS,
  BOARD_COLUMN_DROP_KINDS,
  EDITOR_DROP_KINDS,
]) {
  assert.equal(payloadAccepted(HTML_ONLY, kinds), false);
}
// …and a file that also carries HTML and text is still only a file's.
assert.equal(
  payloadAccepted(
    payloadFromTypes([EXTERNAL_FILES_TYPE, "text/html", "text/plain"]),
    NATIVE_TEXT_KINDS,
  ),
  false,
);

// ── each target's declared kinds are the ones its handler consumes ────────
// (GH #138 F9/F11: a declaration wider than the handler means a drop that
// lands nowhere in silence.)

// The terminal reads an internal path, text/plain, text/uri-list and files.
for (const payload of [FINDER_FILE, PATH, TEXT, URI, URI_ONLY]) {
  assert.equal(payloadAccepted(payload, TERMINAL_DROP_KINDS), true);
}
assert.equal(
  payloadAccepted(HTML_ONLY, TERMINAL_DROP_KINDS),
  false,
  "nothing in the terminal reads text/html",
);
assert.equal(payloadAccepted(CARD, TERMINAL_DROP_KINDS), false);

// A tile writes a path or plain text into its PTY, and reads neither a URL
// list nor HTML.
assert.equal(payloadAccepted(PATH, TILE_DROP_KINDS), true);
assert.equal(payloadAccepted(TEXT, TILE_DROP_KINDS), true);
assert.equal(payloadAccepted(HTML_ONLY, TILE_DROP_KINDS), false);
assert.equal(payloadAccepted(URI_ONLY, TILE_DROP_KINDS), false);
assert.equal(
  payloadAccepted(URI, TILE_DROP_KINDS),
  true,
  "a dragged link carries text/plain, which a tile does read",
);
assert.equal(
  payloadAccepted(FINDER_FILE, TILE_DROP_KINDS),
  false,
  "external files are the terminal pane's, inside the tile",
);

// The attachments area ingests files and nothing else.
assert.equal(payloadAccepted(FINDER_FILE, CARD_FILES_DROP_KINDS), true);
for (const payload of [TEXT, URI, URI_ONLY, HTML_ONLY, CARD, PATH]) {
  assert.equal(payloadAccepted(payload, CARD_FILES_DROP_KINDS), false);
}

// A board column takes a card move; a files row takes an internal path.
assert.equal(payloadAccepted(CARD, BOARD_COLUMN_DROP_KINDS), true);
assert.equal(payloadAccepted(TEXT, BOARD_COLUMN_DROP_KINDS), false);
assert.equal(payloadAccepted(URI, BOARD_COLUMN_DROP_KINDS), false);
assert.equal(payloadAccepted(PATH, FILES_ROW_DROP_KINDS), true);
assert.equal(payloadAccepted(FINDER_FILE, FILES_ROW_DROP_KINDS), false);

// The editor opens a dropped file or file row; CodeMirror keeps its text.
assert.equal(payloadAccepted(FINDER_FILE, EDITOR_DROP_KINDS), true);
assert.equal(payloadAccepted(PATH, EDITOR_DROP_KINDS), true);
assert.equal(payloadAccepted(TEXT, EDITOR_DROP_KINDS), false);
assert.equal(payloadAccepted(TEXT, CODEMIRROR_KINDS), true);
assert.equal(
  payloadAccepted(FINDER_FILE, CODEMIRROR_KINDS),
  false,
  "a dropped file is the editor host's to open, not CodeMirror's to inline",
);
assert.equal(payloadAccepted(PATH, CODEMIRROR_KINDS), false);

assert.equal(acceptsAttr(TERMINAL_DROP_KINDS), "files path uri text");

// ── parseAccepts ──────────────────────────────────────────────────────────

assert.deepEqual(parseAccepts("files path text uri"), ["files", "path", "text", "uri"]);
assert.deepEqual(parseAccepts("  card   card "), ["card"]);
assert.deepEqual(parseAccepts(null), []);
assert.deepEqual(parseAccepts(""), []);
// A typo must narrow a zone, never widen it.
assert.deepEqual(parseAccepts("file everything"), []);

// ── findAcceptingZone ─────────────────────────────────────────────────────

const markedRule: DropZoneRule[] = [{ selector: DROP_ZONE_SELECTOR, accepts: null }];

const body = node(["body"]);
const gap = node(["div.tile-grid"], body);
const terminal = zoneNode("files path text uri", gap);
const xtermRow = node([".xterm-rows"], terminal);

// Open ground is in no zone, however deep.
assert.equal(findAcceptingZone(gap, FILES, markedRule), null);
assert.equal(findAcceptingZone(null, FILES, markedRule), null);
// A target inside a zone that accepts this payload is claimed, and so is the
// zone root itself.
assert.notEqual(findAcceptingZone(terminal, FILES, markedRule), null);
assert.notEqual(findAcceptingZone(xtermRow, FILES, markedRule), null);
assert.notEqual(findAcceptingZone(xtermRow, TEXT, markedRule), null);
// An empty registry claims nothing.
assert.equal(findAcceptingZone(xtermRow, FILES, []), null);
// A drag carrying nothing the guard knows is not claimed by anything.
assert.equal(findAcceptingZone(xtermRow, EMPTY_PAYLOAD, markedRule), null);

// A zone that does not accept this payload is not a claim.
const attachments = zoneNode("files", gap);
assert.notEqual(findAcceptingZone(attachments, FILES, markedRule), null);
assert.equal(
  findAcceptingZone(attachments, TEXT, markedRule),
  null,
  "the attachments drop area ingests files and nothing else",
);
const column = zoneNode("card", gap);
assert.notEqual(findAcceptingZone(column, CARD, markedRule), null);
assert.equal(
  findAcceptingZone(column, TEXT, markedRule),
  null,
  "text dragged from another app is not a card move",
);
assert.equal(findAcceptingZone(column, URI, markedRule), null);
assert.equal(findAcceptingZone(column, FILES, markedRule), null);
// A files row takes an internal path drag only.
const filesRow = zoneNode("path", gap);
assert.notEqual(findAcceptingZone(filesRow, PATH, markedRule), null);
assert.equal(findAcceptingZone(filesRow, FILES, markedRule), null);

// A narrow zone inside a wider one does not shadow it: a file dropped on the
// terminal's search input is still the terminal pane's.
const searchInput = node(
  ["textarea:not([readonly]):not(:disabled)"],
  terminal,
);
const nativeRules: DropZoneRule[] = [
  { selector: DROP_ZONE_SELECTOR, accepts: null },
  { selector: EDITABLE_TEXT_FIELD_SELECTOR, accepts: NATIVE_TEXT_KINDS },
];
assert.notEqual(findAcceptingZone(searchInput, FILES, nativeRules), null);

// A cyclic parent chain terminates instead of hanging the drag loop.
const cyclic = {
  selectors: [],
  attrs: {},
  matches: () => false,
  getAttribute: () => null,
} as unknown as FakeNode;
(cyclic as { parentElement: FakeNode | null }).parentElement = cyclic;
assert.equal(findAcceptingZone(cyclic, FILES, markedRule), null);

// ── native targets: text yes, files no (GH #138 F1) ───────────────────────

const shellRules: DropZoneRule[] = [
  { selector: DROP_ZONE_SELECTOR, accepts: null },
  { selector: CODEMIRROR_CONTENT_SELECTOR, accepts: CODEMIRROR_KINDS },
  { selector: FILE_INPUT_SELECTOR, accepts: ["files"] },
  { selector: EDITABLE_TEXT_FIELD_SELECTOR, accepts: NATIVE_TEXT_KINDS },
  { selector: EDITABLE_HOST_SELECTOR, accepts: NATIVE_TEXT_KINDS },
];

const editableFields = EDITABLE_TEXT_FIELD_SELECTOR.split(", ");
assert.ok(editableFields.includes("textarea:not([readonly]):not(:disabled)"));
for (const selector of editableFields) {
  const field = node([selector], gap);
  // Dropped text is a native insertion: the guard stands aside.
  assert.notEqual(
    findAcceptingZone(field, TEXT, shellRules),
    null,
    `${selector} must keep its text drops`,
  );
  assert.notEqual(findAcceptingZone(field, URI, shellRules), null, selector);
  // A Finder file is not. Nothing inserts it and the navigation default is
  // still behind it, so the guard takes it.
  assert.equal(
    findAcceptingZone(field, FILES, shellRules),
    null,
    `${selector} must not exempt a file drop`,
  );
}

const EVERY_EXTERNAL_PAYLOAD: DragPayload[] = [TEXT, URI, FILES];

// Readonly and disabled fields accept nothing at all — they are absent from
// the selector, so they never match.
for (const selectors of [
  ["textarea", "[readonly]"],
  ["textarea", ":disabled"],
  ['input[type="text"]', "[readonly]"],
  ['input[type="text"]', ":disabled"],
]) {
  const field = node(selectors, gap);
  for (const carried of EVERY_EXTERNAL_PAYLOAD) {
    assert.equal(
      findAcceptingZone(field, carried, shellRules),
      null,
      `${selectors.join("")} must claim nothing`,
    );
  }
}

// A generic contenteditable host is a text target, not a file one.
for (const selector of EDITABLE_HOST_SELECTOR.split(", ")) {
  assert.match(selector, /:not\(\.cm-content\)$/, "CodeMirror has its own rule");
  const editableHost = node([selector], gap);
  assert.notEqual(findAcceptingZone(editableHost, TEXT, shellRules), null, selector);
  assert.equal(findAcceptingZone(editableHost, FILES, shellRules), null, selector);
}

// The editor, as it is really nested: CodeMirror's content inside the host
// that claims files and paths. The nearest accepting zone wins, so a text
// drag stops at CodeMirror and a file walks out to the host, which opens it.
const editorHost = zoneNode(acceptsAttr(EDITOR_DROP_KINDS), gap);
const cmContent = node([CODEMIRROR_CONTENT_SELECTOR], editorHost);
assert.equal(
  findAcceptingZone(cmContent, TEXT, shellRules)?.selector,
  CODEMIRROR_CONTENT_SELECTOR,
  "text dragged inside the editor stays CodeMirror's",
);
assert.equal(
  findAcceptingZone(cmContent, FINDER_FILE, shellRules)?.selector,
  DROP_ZONE_SELECTOR,
  "a dropped file is the editor host's, to open",
);
assert.equal(
  findAcceptingZone(cmContent, PATH, shellRules)?.selector,
  DROP_ZONE_SELECTOR,
  "a dragged file row is the editor host's too",
);
// An HTML-only drag is nobody's, even in the editor.
assert.equal(findAcceptingZone(cmContent, HTML_ONLY, shellRules), null);

// A file picker really does take files.
const filePicker = node([FILE_INPUT_SELECTOR], gap);
assert.notEqual(findAcceptingZone(filePicker, FILES, shellRules), null);

// ── decideDropGuard ───────────────────────────────────────────────────────

const decide = (
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  target: DropNode | null,
  payload: DragPayload,
  internal = false,
) => decideDropGuard({ type, target, payload, rules: shellRules, internal });

// A claimed drag is left entirely alone.
assert.deepEqual(decide("dragover", xtermRow, FILES), {
  claimed: true,
  block: false,
  refuse: false,
  hint: false,
  announceable: true,
  message: UNHANDLED_DROP_MESSAGE,
  zoneSpeaks: false,
});
assert.deepEqual(decide("drop", xtermRow, FILES), {
  claimed: true,
  block: false,
  refuse: false,
  hint: false,
  announceable: true,
  message: UNHANDLED_DROP_MESSAGE,
  zoneSpeaks: false,
});

// Open ground: blocked and refused on every drag event…
for (const type of ["dragenter", "dragover", "dragleave"] as const) {
  const d = decide(type, gap, FILES);
  assert.equal(d.block, true, type);
  assert.equal(d.refuse, true, type);
}
// …and the guidance applies for the whole hover, not only as the drag
// arrives, because with `dropEffect = "none"` the UA cancels the gesture and
// no `drop` is ever delivered to announce anything at.
assert.equal(decide("dragenter", gap, FILES).hint, true);
assert.equal(decide("dragover", gap, FILES).hint, true);
// A `dragleave` says nothing either way — `guidanceFor` leaves it standing.
assert.equal(decide("dragleave", gap, FILES).hint, false);
// A `drop` that a UA does deliver anyway is blocked; there is no live
// `dropEffect` left to set on it, and nothing left to advise.
const droppedOnGap = decide("drop", gap, FILES);
assert.deepEqual(droppedOnGap, {
  claimed: false,
  block: true,
  refuse: false,
  hint: false,
  announceable: true,
  message: UNHANDLED_DROP_MESSAGE,
  zoneSpeaks: false,
});

// A file dropped on an ordinary text field is refused, not exempted.
assert.deepEqual(decide("dragenter", node(["textarea:not([readonly]):not(:disabled)"], gap), FILES), {
  claimed: false,
  block: true,
  refuse: true,
  hint: true,
  announceable: true,
  message: UNHANDLED_DROP_MESSAGE,
  zoneSpeaks: false,
});

// A drag that started in the app is refused over open ground — the cursor
// should say so — but never advised: it could not have navigated anything,
// and "Drop files on a terminal…" is beside the point for a card released
// between two columns.
const internalOverGap = decide("dragenter", gap, CARD, true);
assert.equal(internalOverGap.block, true);
assert.equal(internalOverGap.refuse, true);
assert.equal(internalOverGap.hint, false);
// Nor is a payload that could not navigate in the first place.
assert.equal(decide("dragenter", gap, payloadFromTypes([ATELIER_PATH_TYPE])).hint, false);

// ── nestedZoneOwnsDrop (GH #138 F13) ─────────────────────────────────────

// A tile's own listener sits on the tile root; the terminal pane inside it
// is a zone of its own and writes the dropped path itself. Both ran, so a
// file row dropped on a terminal body was typed into the PTY twice. The
// outer handler stands down when a nearer zone will take the drop.
const tileRoot = zoneNode(acceptsAttr(TILE_DROP_KINDS), gap);
const tileHeader = node([".tile-header"], tileRoot);
const paneInTile = zoneNode(acceptsAttr(TERMINAL_DROP_KINDS), tileRoot);
const xtermInTile = node([".xterm-rows"], paneInTile);

assert.equal(
  nestedZoneOwnsDrop(xtermInTile, tileRoot),
  true,
  "the terminal pane owns a drop on its body",
);
assert.equal(nestedZoneOwnsDrop(paneInTile, tileRoot), true);
// The header and the tile root itself are still the tile's.
assert.equal(nestedZoneOwnsDrop(tileHeader, tileRoot), false);
assert.equal(nestedZoneOwnsDrop(tileRoot, tileRoot), false);
// Nothing marked anywhere above the target: nobody nearer owns it.
assert.equal(nestedZoneOwnsDrop(node(["div.loose"], body), tileRoot), false);
assert.equal(nestedZoneOwnsDrop(null, tileRoot), false);

// ── startsNewGesture ──────────────────────────────────────────────────────

assert.equal(startsNewGesture(null, 0), true);
assert.equal(startsNewGesture(1000, 1000 + GESTURE_GAP_MS - 1), false);
assert.equal(startsNewGesture(1000, 1000 + GESTURE_GAP_MS), true);
// A UA repeats `dragover` at least every 350ms while a drag is in flight,
// so a gesture cannot be split by its own cadence.
let cursor = 0;
for (let i = 0; i < 60; i++) {
  const next = cursor + 300;
  assert.equal(startsNewGesture(cursor, next), false, `at ${next}ms`);
  cursor = next;
}
assert.ok(cursor > GESTURE_GAP_MS * 3);

// ── guidanceFor ───────────────────────────────────────────────────────────

const guidance = (
  type: "dragenter" | "dragover" | "dragleave" | "drop",
  target: DropNode | null,
  payload: DragPayload,
  internal = false,
) =>
  guidanceFor(
    decideDropGuard({ type, target, payload, rules: shellRules, internal }),
    type,
  );

// Over ground that will refuse it, the guidance is up — for the whole hover,
// not just as the drag arrives, so it is still on screen at the release.
assert.equal(guidance("dragenter", gap, FILES), "show");
assert.equal(guidance("dragover", gap, FILES), "show");
// A `dragleave` on the way somewhere else changes nothing on its own; the
// idle timer decides, so crossing a boundary does not make it flicker.
assert.equal(guidance("dragleave", gap, FILES), "leave");
// A real target has it, or the release arrived: nothing left to say.
assert.equal(guidance("dragover", xtermRow, FILES), "hide");
// A `drop` that really arrives over open ground is a release that happened
// and was refused — nothing is inferred, so it is announced.
assert.equal(guidance("drop", gap, FILES), "announce");
assert.equal(guidance("drop", xtermRow, FILES), "hide");
// …unless there was nothing to announce: an internal drag, or a payload
// that could not have navigated anything.
assert.equal(guidance("drop", gap, CARD, true), "hide");
assert.equal(
  guidance("drop", gap, payloadFromTypes([ATELIER_PATH_TYPE])),
  "hide",
);
// A drag that started here could not have navigated the window.
assert.equal(guidance("dragover", gap, CARD, true), "leave");
// Nor could one carrying nothing that navigates.
assert.equal(
  guidance("dragover", gap, payloadFromTypes([ATELIER_PATH_TYPE])),
  "leave",
);

// ── the copy, and droppedFileRejection ───────────────────────────────────

// The brief prescribes this string; it is what the guard shows and what the
// runtime smoke waits for.
assert.equal(
  UNHANDLED_DROP_MESSAGE,
  "Drop files on a terminal, a card, or the editor",
);
// A backstop only — the guard takes its own guidance down.
assert.ok(GUIDANCE_TOAST_TTL_MS > HINT_IDLE_MS * 10);

// The editor refuses what `files::read_text_file` would refuse, and refuses
// it *before* the file is pulled into the webview, shipped over the IPC and
// written into the cache dir — where a rejected 500MB video would then sit
// for the fourteen days `cache_retention` gives dropped files.
const textHead = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
assert.equal(
  droppedFileRejection({ name: "notes.md", size: 1234 }, textHead),
  null,
);
assert.equal(droppedFileRejection({ name: "empty.txt", size: 0 }, new Uint8Array()), null);
assert.equal(
  droppedFileRejection({ name: "notes.md", size: MAX_OPENABLE_BYTES }, textHead),
  null,
  "exactly at the limit is still readable",
);
assert.match(
  droppedFileRejection(
    { name: "movie.mov", size: MAX_OPENABLE_BYTES + 1 },
    textHead,
  ) ?? "",
  /movie\.mov is 5\.0 MB — the editor opens files up to 5\.0 MB\./,
);
// A NUL in the sniff window is how `files.rs` decides a file is binary.
const binaryHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
assert.equal(
  droppedFileRejection({ name: "shot.png", size: 900 }, binaryHead),
  "shot.png is not a text file.",
);
// A NUL past the window is not scanned, exactly as in `files.rs` — the read
// there will simply succeed on the same bytes.
const lateNul = new Uint8Array(BINARY_SNIFF_BYTES + 1).fill(0x61);
lateNul[BINARY_SNIFF_BYTES] = 0;
assert.equal(droppedFileRejection({ name: "big.txt", size: 10 }, lateNul), null);
// Size is checked before the sniff, so an oversize binary says the useful one.
assert.match(
  droppedFileRejection(
    { name: "movie.mov", size: MAX_OPENABLE_BYTES * 100 },
    binaryHead,
  ) ?? "",
  /opens files up to/,
);

// ── installDropGuard, driven against a fake window ────────────────────────

interface Dispatched {
  type: string;
  target: DropNode | null;
  types: string[];
  dropEffect: string;
  /** A descendant that calls stopPropagation() without cancelling. */
  stoppedByDescendant?: boolean;
}

function fakeWindow() {
  // Keyed by phase: the guard must be in capture, so a descendant that stops
  // propagation cannot get in front of the refusal.
  const listeners = new Map<string, ((e: Event) => void)[]>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const key = (type: string, capture?: boolean) =>
    capture ? `${type}:capture` : type;
  return {
    listeners,
    timers,
    win: {
      addEventListener(type: string, fn: (e: Event) => void, capture?: boolean) {
        const k = key(type, capture);
        listeners.set(k, [...(listeners.get(k) ?? []), fn]);
      },
      removeEventListener(
        type: string,
        fn: (e: Event) => void,
        capture?: boolean,
      ) {
        const k = key(type, capture);
        listeners.set(k, (listeners.get(k) ?? []).filter((f) => f !== fn));
      },
      setTimeout(fn: () => void) {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    } as unknown as Window,
    /** `stoppedShort` models a target that claimed the event and called
     *  `stopPropagation()`: the capture listeners run, the bubble ones
     *  never do. */
    dispatch(event: Dispatched, stoppedShort = false) {
      const e = {
        type: event.type,
        target: event.target,
        defaultPrevented: false,
        preventDefault() {
          e.defaultPrevented = true;
        },
        dataTransfer: {
          types: event.types,
          get dropEffect() {
            return event.dropEffect;
          },
          set dropEffect(v: string) {
            event.dropEffect = v;
          },
        },
      };
      for (const fn of listeners.get(`${event.type}:capture`) ?? [])
        fn(e as unknown as Event);
      if (!stoppedShort) {
        for (const fn of listeners.get(event.type) ?? [])
          fn(e as unknown as Event);
      }
      return e;
    },
    /** The drag has gone quiet: run the guard's idle timer. */
    goIdle() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
  };
}

{
  const w = fakeWindow();
  /** The guidance on screen, as the user would see it: one entry or none. */
  const onScreen: string[] = [];
  /** Messages that outlive the gesture, as opposed to the hover guidance. */
  const announced: string[] = [];
  let nextHandle = 1;
  let clock = 0;
  const uninstall = installDropGuard({
    window: w.win,
    rules: () => shellRules,
    now: () => clock,
    // What `main.tsx` does: idempotent while the handle is on screen, and
    // raised again once it is not.
    showGuidance: (previous: string | null) => {
      if (previous !== null && onScreen.includes(previous)) return previous;
      const handle = `g${nextHandle++}`;
      onScreen.push(handle);
      return handle;
    },
    hideGuidance: (handle: string) => {
      const at = onScreen.indexOf(handle);
      if (at !== -1) onScreen.splice(at, 1);
    },
    announceRejectedDrop: () => announced.push("rejected"),
  });
  // The four protective handlers are in capture; only the session watchers
  // are in bubble, because the source writes its data during `dragstart`.
  assert.deepEqual([...w.listeners.keys()].sort(), [
    "dragend",
    "dragenter:capture",
    "dragleave:capture",
    "dragover:capture",
    "dragstart",
    "drop:capture",
  ]);

  const drag = (
    type: string,
    target: DropNode | null,
    types: string[] = [EXTERNAL_FILES_TYPE],
    stopped = false,
  ) => (
    (clock += 100), // a UA repeats `dragover` far more often than this
    w.dispatch(
      { type, target, types, dropEffect: "copy", stoppedByDescendant: stopped },
      stopped,
    )
  );

  // Entering open ground: refused, and the guidance goes up.
  const entered = drag("dragenter", gap);
  assert.equal(entered.defaultPrevented, true);
  assert.equal(entered.dataTransfer.dropEffect, "none");
  assert.equal(onScreen.length, 1);

  // It stays up for the whole hover, however long, and never accumulates —
  // there is one message, not a stream of them.
  for (let i = 0; i < 40; i++) {
    drag("dragover", gap);
    drag("dragenter", node(["div.sidebar"], body));
  }
  assert.equal(onScreen.length, 1, "one drag, one message on screen");

  // The toast carries its own expiry as a backstop. If it fires while the
  // drag is still over a gap, the next event puts the message back: it must
  // not be able to go out from under a drag the user is still holding.
  const expiring = onScreen[0];
  onScreen.length = 0; // the backstop fired
  drag("dragover", gap);
  assert.equal(onScreen.length, 1, "an expired message is raised again");
  assert.notEqual(onScreen[0], expiring);

  // Crossing a real target takes it down — and coming back does **not** put
  // it up again. This gesture has been told once.
  drag("dragover", xtermRow);
  assert.deepEqual(onScreen, []);
  drag("dragover", gap);
  assert.deepEqual(onScreen, [], "one gesture is told once");

  // ── GH #138 F5: leave, wait, re-enter ───────────────────────────────────
  // Leaving the window while still holding the file. Nothing is announced
  // about a release, because nothing was released.
  drag("dragenter", gap);
  drag("dragleave", gap);
  clock += 4_000; // hovering over another app, well past the idle hide
  w.goIdle();
  assert.deepEqual(onScreen, [], "drag silence takes it down, and says nothing");
  assert.deepEqual(announced, [], "and announces nothing");

  // …re-enter another gap: still the same gesture, so still no second
  // message, and still nothing claimed about a release that never happened.
  drag("dragenter", node(["div.board-background"], body));
  assert.deepEqual(onScreen, [], "re-entering does not raise it again");
  assert.deepEqual(announced, []);

  // …and release there. *That* is a release on open ground, so it is
  // announced — once, in a message that outlives the gesture.
  const atRelease = drag("drop", node(["div.board-background"], body));
  assert.equal(atRelease.defaultPrevented, true, "the release is refused");
  assert.deepEqual(announced, ["rejected"], "a delivered release is announced");
  announced.length = 0;

  // A release ends the gesture, so the next drag is owed the guidance again.
  drag("dragenter", gap);
  assert.equal(onScreen.length, 1, "a new gesture is told");

  // …or the drag reaches a terminal instead. The drop works, and nothing is
  // left behind claiming anything failed.
  drag("dragover", xtermRow);
  const landed = drag("drop", xtermRow);
  assert.equal(landed.defaultPrevented, false);
  assert.equal(landed.dataTransfer.dropEffect, "copy");
  assert.deepEqual(onScreen, []);
  assert.deepEqual(announced, [], "a drop that landed somewhere says nothing");
  w.goIdle();
  assert.deepEqual(onScreen, []);

  // A genuinely separate drag, long after, is owed the guidance again.
  clock += GESTURE_GAP_MS;
  drag("dragenter", gap);
  assert.equal(onScreen.length, 1, "a later gesture is a new one");
  drag("drop", gap);
  announced.length = 0;

  // A descendant that stops propagation without cancelling cannot get past
  // the guard: capture already ran. This is the board's column delegation.
  const stopped = drag("drop", gap, [EXTERNAL_FILES_TYPE], true);
  assert.equal(
    stopped.defaultPrevented,
    true,
    "a stopped-short drop is still cancelled",
  );
  assert.deepEqual(announced, ["rejected"], "…and still announced");
  announced.length = 0;

  // Text dropped into a text field is untouched…
  const field = node(["textarea:not([readonly]):not(:disabled)"], gap);
  const typed = drag("drop", field, ["text/plain"]);
  assert.equal(typed.defaultPrevented, false);
  assert.deepEqual(onScreen, []);
  // …as is text dragged out of a web page, which carries HTML beside it
  // (GH #138 F14).
  const rich = drag("dragover", field, ["text/html", "text/plain"]);
  assert.equal(rich.defaultPrevented, false);
  assert.deepEqual(onScreen, []);
  // …while a file dropped on that same field is refused and explained.
  const fileOnField = drag("dragenter", field);
  assert.equal(fileOnField.defaultPrevented, true);
  assert.equal(fileOnField.dataTransfer.dropEffect, "none");
  assert.equal(onScreen.length, 1);
  drag("drop", field);
  assert.deepEqual(onScreen, []);
  assert.deepEqual(
    announced,
    ["rejected"],
    "a file released on a text field is a rejected release like any other",
  );
  announced.length = 0;

  // ── the drag session (GH #138 F4) ───────────────────────────────────────
  // A card drag records what it carries at `dragstart`…
  w.dispatch({
    type: "dragstart",
    target: node(["div.kanban-card"], column),
    types: [ATELIER_CARD_TYPE, "text/plain"],
    dropEffect: "move",
  });
  // …so it is still a card move mid-drag, even where WKWebView has stripped
  // the custom type and only text/plain survives.
  assert.equal(
    dragIsCardMove({ dataTransfer: { types: ["text/plain"] } }),
    true,
  );
  const overColumn = drag("dragover", column, ["text/plain"]);
  assert.equal(overColumn.defaultPrevented, false, "the column keeps its card");
  // Released between two columns it is refused, and says nothing: it could
  // not have navigated the window.
  const betweenColumns = drag("dragenter", gap, ["text/plain"]);
  assert.equal(betweenColumns.defaultPrevented, true);
  assert.equal(betweenColumns.dataTransfer.dropEffect, "none");
  assert.deepEqual(onScreen, []);
  // An internal drag released between two columns is refused and says
  // nothing: it could not have navigated the window.
  const internalRelease = drag("drop", gap, ["text/plain"]);
  assert.equal(internalRelease.defaultPrevented, true);
  assert.deepEqual(announced, []);
  // `dragend` is the UA telling us the drag is over. It takes the guidance
  // down without waiting for the idle timer.
  w.dispatch({ type: "dragend", target: gap, types: [], dropEffect: "none" });
  assert.deepEqual(onScreen, []);

  // Owner-side review: a `dragend` that never arrives must not leave the
  // record speaking for the next drag. A card node is unmounted by its own
  // move, and an event on a disconnected node never reaches the window, so
  // the record is stale a gesture after the last drag event touched it.
  w.dispatch({
    type: "dragstart",
    target: node(["div.kanban-card"], column),
    types: [ATELIER_CARD_TYPE, "text/plain"],
    dropEffect: "move",
  });
  assert.equal(dragIsCardMove({ dataTransfer: { types: ["text/plain"] } }), true);
  clock += GESTURE_GAP_MS;
  assert.equal(
    dragIsCardMove({ dataTransfer: { types: ["text/plain"] } }),
    false,
    "a record nothing touched for a gesture speaks for nothing",
  );
  // And a file released over a text field after that lost `dragend` is
  // still refused, which is what this card exists for.
  const afterLostEnd = drag("drop", node(["textarea"]), ["Files"]);
  assert.equal(afterLostEnd.defaultPrevented, true);
  announced.length = 0;

  // With the session over, the same bare text/plain from another app is no
  // longer a card move, so a column does not claim it and the guard does.
  assert.equal(
    dragIsCardMove({ dataTransfer: { types: ["text/plain"] } }),
    false,
  );
  const foreignText = drag("dragenter", column, ["text/plain"]);
  assert.equal(foreignText.defaultPrevented, true);
  assert.equal(onScreen.length, 1);
  // A URL from another browser is the same story, and so is one dragged with
  // its HTML rendering attached.
  drag("dragend", gap, []);
  for (const types of [
    ["text/uri-list", "text/plain"],
    ["text/html", "text/uri-list", "text/plain"],
  ]) {
    const foreignUrl = drag("dragenter", column, types);
    assert.equal(foreignUrl.defaultPrevented, true);
    assert.equal(onScreen.length, 1);
    drag("drop", column, types);
    assert.deepEqual(onScreen, []);
  }

  uninstall();
  assert.deepEqual(
    [...w.listeners.values()].flat(),
    [],
    "uninstall removes every listener",
  );
  assert.equal(w.timers.size, 0, "uninstall disarms the idle timer");
  assert.deepEqual(onScreen, [], "and takes its guidance down");
  // The session does not outlive the guard.
  assert.equal(dragIsCardMove({ dataTransfer: { types: [ATELIER_CARD_TYPE] } }), true);
  assert.equal(dragIsCardMove({ dataTransfer: { types: ["text/plain"] } }), false);
}

// ── classifyNavigation ────────────────────────────────────────────────────

const here = "http://localhost:1420/index.html";
assert.equal(classifyNavigation("", here), "allow");
assert.equal(classifyNavigation(null, here), "allow");
assert.equal(classifyNavigation("#settings", here), "allow");
assert.equal(classifyNavigation("/index.html", here), "allow");
assert.equal(classifyNavigation(here, here), "allow");
// The Team beta CTA hands off to the OS; it does not navigate the page.
assert.equal(classifyNavigation("mailto:beta@ply.app?subject=Key", here), "allow");
assert.equal(classifyNavigation("MAILTO:beta@ply.app", here), "allow");
// The bug: a dropped file becomes a top-level navigation to that file.
assert.equal(classifyNavigation("file:///Users/me/Desktop/shot.png", here), "refuse");
assert.equal(classifyNavigation("https://example.com/", here), "refuse");
assert.equal(classifyNavigation("/other.html", here), "refuse");
assert.equal(classifyNavigation("?q=1", here), "refuse");
assert.equal(classifyNavigation("javascript:void(0)", here), "refuse");
assert.equal(classifyNavigation("tauri://localhost/index.html", here), "refuse");

// ── installNavigationGuard, driven against a fake document ───────────────

{
  const clicks: ((e: Event) => void)[] = [];
  const refused: string[] = [];
  const uninstall = installNavigationGuard({
    document: {
      addEventListener: (type: string, fn: (e: Event) => void, capture: boolean) => {
        // Capture, so the refusal lands before the target's own handlers.
        assert.equal(capture, true);
        if (type === "click") clicks.push(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        if (type === "click") clicks.splice(clicks.indexOf(fn), 1);
      },
    } as unknown as Document,
    currentHref: () => here,
    onRefused: (h) => refused.push(h),
  });

  function click(href: string | null) {
    const target =
      href === null
        ? { closest: () => null }
        : { closest: () => ({ getAttribute: () => href }) };
    const e = {
      target,
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
    };
    for (const fn of clicks) fn(e as unknown as Event);
    return e.defaultPrevented;
  }
  // A click that is not on an anchor at all is none of the guard's business.
  assert.equal(click(null), false);
  // The Team beta CTA still opens Mail.
  assert.equal(click("mailto:beta@ply.app"), false);
  assert.equal(click("#somewhere"), false);
  // Anything that would replace the document does not get to.
  assert.equal(click("file:///Users/me/Desktop/shot.png"), true);
  assert.equal(click("https://example.com/"), true);
  assert.deepEqual(refused, [
    "file:///Users/me/Desktop/shot.png",
    "https://example.com/",
  ]);

  uninstall();
  assert.equal(clicks.length, 0);
}

// ── a form and window.open reach the main frame too ──────────────────────

{
  const clicks: ((e: Event) => void)[] = [];
  const submits: ((e: Event) => void)[] = [];
  const refused: string[] = [];
  const uninstall = installNavigationGuard({
    document: {
      addEventListener: (type: string, fn: (e: Event) => void, capture: boolean) => {
        assert.equal(capture, true, `${type} must be guarded in capture`);
        (type === "click" ? clicks : submits).push(fn);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        const list = type === "click" ? clicks : submits;
        list.splice(list.indexOf(fn), 1);
      },
    } as unknown as Document,
    currentHref: () => here,
    onRefused: (h) => refused.push(h),
  });

  function submit(action: string | null, target: string | null = null) {
    const e = {
      target: {
        getAttribute: (name: string) => (name === "action" ? action : target),
      },
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
    };
    for (const fn of submits) fn(e as unknown as Event);
    return e.defaultPrevented;
  }
  // A form posting back to this document is fine; one posting away is not.
  assert.equal(submit(null), false);
  assert.equal(submit("/index.html"), false);
  assert.equal(submit("https://example.com/collect"), true);
  assert.equal(submit("file:///etc/passwd"), true);
  // A submit button may override both, and a `formaction` off-page is the
  // same navigation by another route.
  function submitWith(
    formaction: string | null,
    formtarget: string | null = null,
    action: string | null = "/index.html",
  ) {
    const e = {
      target: {
        getAttribute: (name: string) => (name === "action" ? action : null),
      },
      submitter: {
        getAttribute: (name: string) =>
          name === "formaction"
            ? formaction
            : name === "formtarget"
              ? formtarget
              : null,
      },
      defaultPrevented: false,
      preventDefault() {
        e.defaultPrevented = true;
      },
    };
    for (const fn of submits) fn(e as unknown as Event);
    return e.defaultPrevented;
  }
  refused.length = 0;
  assert.equal(submitWith(null), false, "no override: the form's own action");
  assert.equal(submitWith("/index.html"), false);
  assert.equal(submitWith("https://example.com/collect"), true);
  assert.equal(
    submitWith("https://example.com/collect", "results"),
    false,
    "…unless the button sends it somewhere that is not this frame",
  );
  assert.deepEqual(refused, ["https://example.com/collect"]);
  refused.length = 0;

  // …unless it targets something that is not this frame.
  assert.equal(submit("https://example.com/collect", "results"), false);
  assert.equal(
    submit("https://example.com/collect", "_top"),
    true,
    "_top replaces the shell",
  );
  assert.deepEqual(refused, ["https://example.com/collect"]);
  uninstall();
  assert.deepEqual([clicks.length, submits.length], [0, 0]);
}

{
  const opened: unknown[][] = [];
  const refused: string[] = [];
  const open = guardedWindowOpen({
    currentHref: () => here,
    open: (...args: unknown[]) => {
      opened.push(args);
      return "window";
    },
    onRefused: (h) => refused.push(h),
  });
  // A new window or tab is not a navigation of this one.
  assert.equal(open("https://example.com/", "_blank"), "window");
  assert.equal(open("https://example.com/"), "window");
  // Replacing this document is.
  assert.equal(open("https://example.com/", "_self"), null);
  assert.equal(open("file:///Users/me/Desktop/shot.png", "_top"), null);
  assert.equal(open("/index.html", "_self"), "window");
  assert.equal(open("#hash", "_SELF"), "window", "the target is case-insensitive");
  // `window.open` stringifies its first argument, so a URL object is a
  // navigation just as much as a string is.
  assert.equal(open(new URL("https://example.com/x"), "_self"), null);
  assert.equal(open(new URL(here), "_self"), "window");
  // No arguments at all opens a blank window beside this one.
  assert.equal(open(), "window");
  assert.deepEqual(refused, [
    "https://example.com/",
    "file:///Users/me/Desktop/shot.png",
    "https://example.com/x",
  ]);
  assert.equal(opened.length, 6);
}

// ── 1.172.2 D1: a screenshot that isn't saved yet ───────────────────────
//
// A fresh screenshot dragged from its thumbnail is only a promise of a file;
// with `dragDropEnabled` off the webview may see the drag carry no file at
// all. Over a terminal or a card the guard says so, in the same slot as its
// other guidance; over open ground, and for a text drag, it does not.
{
  const pageBody = node(["body"]);
  const openGround = node(["div.tile-grid"], pageBody);
  const term = zoneNode("files path text uri", openGround);
  const termRow = node([".xterm-rows"], term);
  const cardPage = zoneNode("files", pageBody);
  const cardTitle = node(["h1"], cardPage);
  // A tile's own zone takes paths and text only; the card page around it
  // takes files, so a no-file drag over the tile still counts.
  const tileInCard = zoneNode("path text", cardPage);
  const decideEmpty = (target: DropNode, internal = false) =>
    decideDropGuard({ type: "dragover", target, payload: EMPTY_PAYLOAD, rules: shellRules, internal });

  for (const target of [termRow, cardTitle, tileInCard]) {
    const d = decideEmpty(target);
    assert.equal(d.hint, true);
    assert.equal(d.announceable, true);
    assert.equal(d.message, UNSAVED_DRAG_MESSAGE);
    assert.equal(guidanceFor(d, "dragover"), "show");
  }
  assert.equal(
    UNSAVED_DRAG_MESSAGE,
    "This screenshot isn't saved yet. Let it finish, then drag the file.",
  );
  // Over open ground a drag that carries nothing has nothing to say.
  assert.equal(decideEmpty(openGround).hint, false);
  assert.equal(decideEmpty(openGround).message, UNHANDLED_DROP_MESSAGE);
  // A drag that started here is never a screenshot from elsewhere.
  assert.equal(decideEmpty(termRow, true).hint, false);
  // A text drag over a terminal is the terminal's: nothing is shown.
  const textOver = decideDropGuard({ type: "dragover", target: termRow, payload: TEXT, rules: shellRules, internal: false });
  assert.equal(textOver.claimed, true);
  assert.equal(guidanceFor(textOver, "dragover"), "hide");
  // A text drag over a card page (which takes files only) gets the usual
  // guidance, never the screenshot words.
  const textOverCard = decideDropGuard({ type: "dragover", target: cardTitle, payload: TEXT, rules: shellRules, internal: false });
  assert.equal(textOverCard.message, UNHANDLED_DROP_MESSAGE);
  // A file is claimed by both.
  assert.equal(decideDropGuard({ type: "dragover", target: cardTitle, payload: FILES, rules: shellRules, internal: false }).claimed, true);
  // A drop that does arrive with nothing in it over a terminal is said once.
  assert.equal(guidanceFor(decideDropGuard({ type: "drop", target: termRow, payload: EMPTY_PAYLOAD, rules: shellRules, internal: false }), "drop"), "announce");

  // Installed: the guidance says the screenshot words over the terminal, and
  // a showing "where drops go" is replaced, not stacked.
  const w = fakeWindow();
  const shown: { handle: string; message: string }[] = [];
  const announcedWords: string[] = [];
  let n = 1;
  let clock = 0;
  const uninstall = installDropGuard({
    window: w.win,
    rules: () => shellRules,
    now: () => clock,
    showGuidance: (previous: string | null, message: string) => {
      if (previous !== null && shown.some((g) => g.handle === previous)) return previous;
      const handle = `u${n++}`;
      shown.push({ handle, message });
      return handle;
    },
    hideGuidance: (handle: string) => {
      const at = shown.findIndex((g) => g.handle === handle);
      if (at !== -1) shown.splice(at, 1);
    },
    announceRejectedDrop: (message: string) => announcedWords.push(message),
  });
  const send = (type: string, target: DropNode, types: string[]) => (
    (clock += 100), w.dispatch({ type, target, types, dropEffect: "copy" })
  );
  send("dragenter", openGround, ["text/plain"]);
  assert.deepEqual(shown.map((g) => g.message), [UNHANDLED_DROP_MESSAGE]);
  const over = send("dragover", termRow, []);
  assert.deepEqual(shown.map((g) => g.message), [UNSAVED_DRAG_MESSAGE]);
  assert.equal(over.defaultPrevented, true, "refused, so the window never opens it");
  send("dragover", termRow, []);
  assert.equal(shown.length, 1, "one message on screen");
  send("drop", termRow, []);
  assert.deepEqual(announcedWords, [UNSAVED_DRAG_MESSAGE]);
  assert.equal(shown.length, 0);
  // A new gesture, a file this time: the terminal takes it, nothing shown.
  clock += GESTURE_GAP_MS;
  send("dragover", termRow, [EXTERNAL_FILES_TYPE]);
  assert.equal(shown.length, 0);
  uninstall();
}

// ── source guards ─────────────────────────────────────────────────────────

const entry = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
// One guard, installed once, at the shell.
assert.match(entry, /installDropGuard\(/);
assert.match(entry, /installNavigationGuard\(/);
// The original `window.open` must be captured before the reassignment, or
// the replacement calls itself.
assert.match(entry, /const nativeWindowOpen = window\.open\.bind\(window\)/);
const openWiring = entry.slice(entry.indexOf("window.open = guardedWindowOpen"));
assert.doesNotMatch(
  openWiring.slice(0, openWiring.indexOf("}) as typeof window.open")),
  /open:\s*\(/,
  "window.open must be passed the captured original, not a fresh closure over window.open",
);
// The guidance says the guard's own message (where drops go, or 1.172.2 D1's
// screenshot that isn't saved yet), never a fixed one of its own.
assert.match(entry, /showGuidance: \(previous, message\)/);
assert.match(entry, /title: message/);
// The drag probe is for dev and test-bridge builds only (1.172.2 D1).
assert.match(entry, new RegExp(String.raw`if \(import\.meta\.env\.DEV \|\| ${BRIDGE}\) \{\n\s*void import\("\.\/lib\/dragProbe"\)`));
// The registry is the contract, so every native rule has to be in it.
for (const token of [
  "CODEMIRROR_CONTENT_SELECTOR",
  "EDITABLE_TEXT_FIELD_SELECTOR",
  "EDITABLE_HOST_SELECTOR",
  "FILE_INPUT_SELECTOR",
  "NATIVE_TEXT_KINDS",
]) {
  assert.ok(entry.includes(token), `main.tsx is missing the ${token} rule`);
}
// `beforeunload` is not a navigation veto — cancelling it only asks the UA to
// prompt, and the UA may decline. Nothing here may register one and call it a
// refusal; the refusal is the native policy below.
const guardSource = readFileSync(new URL("./dropGuard.ts", import.meta.url), "utf8");
for (const src of [entry, guardSource]) {
  assert.doesNotMatch(src, /addEventListener\(\s*["']beforeunload["']/);
  assert.doesNotMatch(src, /onbeforeunload/);
  assert.doesNotMatch(src, /returnValue/);
}

// Every zone the guard relies on is really marked, and — the point of
// GH #138 F8/F10 — its own handlers ask the *same* question its marker
// answers. The guard refuses in the capture phase and a target's handler runs
// afterwards, so a handler working from a different idea of what it accepts
// would put the copy cursor and its highlight back on a drop that was just
// refused. Sharing one constant is what makes that impossible, and this is
// what holds the sharing in place.
const TARGET_CONTRACTS = [
  {
    file: "../components/Terminal.tsx",
    zone: "terminal",
    constant: "TERMINAL_DROP_KINDS",
    kinds: TERMINAL_DROP_KINDS,
    gates: ["acceptsDrag(e, TERMINAL_DROP_KINDS)"],
  },
  {
    file: "../components/CardMore.tsx",
    zone: "card-files",
    constant: "CARD_FILES_DROP_KINDS",
    kinds: CARD_FILES_DROP_KINDS,
    gates: ["acceptsDrag(e, CARD_FILES_DROP_KINDS)"],
  },
  {
    file: "../components/Tile.tsx",
    zone: "tile",
    constant: "TILE_DROP_KINDS",
    kinds: TILE_DROP_KINDS,
    gates: [
      "acceptsDrag(e, TILE_DROP_KINDS)",
      // GH #138 F13: the terminal pane inside writes the path itself.
      "nestedZoneOwnsDrop(asDropTarget(e.target), node)",
    ],
  },
  {
    file: "../components/EditorPanel.tsx",
    zone: "editor",
    constant: "EDITOR_DROP_KINDS",
    kinds: EDITOR_DROP_KINDS,
    gates: ["acceptsDrag(e, EDITOR_DROP_KINDS)"],
  },
  {
    file: "../components/KanbanBoard.tsx",
    zone: "board-column",
    constant: "BOARD_COLUMN_DROP_KINDS",
    kinds: BOARD_COLUMN_DROP_KINDS,
    // The board's delegation predates the registry and asks the same
    // question through the drag session.
    gates: ["dragIsCardMove(e)"],
  },
  {
    file: "../components/FilesPanel.tsx",
    zone: "files-row",
    constant: "FILES_ROW_DROP_KINDS",
    kinds: FILES_ROW_DROP_KINDS,
    // A row claims its own reorder MIME, which is narrower than `path`.
    gates: ["e.dataTransfer.types.includes(DRAG_MIME)"],
  },
] as const;

for (const contract of TARGET_CONTRACTS) {
  const src = readFileSync(new URL(contract.file, import.meta.url), "utf8");
  assert.ok(
    src.includes(`data-drop-zone="${contract.zone}"`) ||
      src.includes(`? undefined : "${contract.zone}"`) ||
      src.includes(`? "codex-chat" : "${contract.zone}"`),
    `${contract.file} no longer marks the ${contract.zone} zone`,
  );
  assert.ok(
    src.includes(`acceptsAttr(${contract.constant})`),
    `${contract.file}'s marker must be written from ${contract.constant}`,
  );
  for (const gate of contract.gates) {
    assert.ok(
      src.includes(gate),
      `${contract.file}'s handlers must gate on ${gate}`,
    );
  }
  // A hand-written kind list beside the shared one is exactly the drift this
  // is here to stop.
  assert.doesNotMatch(
    src,
    /data-drop-accepts="/,
    `${contract.file} must not hardcode its accepted kinds`,
  );
  assert.ok(contract.kinds.length > 0);
}

// GH #138 F13: exactly one handler writes a dropped path into a PTY. The
// tile's listener must stand down before it writes, not after.
const tileSource = readFileSync(
  new URL("../components/Tile.tsx", import.meta.url),
  "utf8",
);
const tileDrop = tileSource.slice(
  tileSource.indexOf("async function onDrop(e: DragEvent)"),
  tileSource.indexOf("node.addEventListener"),
);
const standDownAt = tileDrop.indexOf("nestedZoneOwnsDrop(");
const writeAt = tileDrop.indexOf("writeToTilePty(");
assert.ok(standDownAt >= 0, "the tile no longer stands down for nested zones");
assert.ok(writeAt >= 0, "the tile no longer writes to the PTY");
assert.ok(
  standDownAt < writeAt,
  "the tile must stand down before it writes, or the path is typed twice",
);

// The terminal really reads every format it declares, `text/uri-list`
// included (GH #138 F9) — a declaration wider than the handler is a drop
// that lands nowhere in silence.
const terminalSource = readFileSync(
  new URL("../components/Terminal.tsx", import.meta.url),
  "utf8",
);
for (const format of [
  "application/x-atelier-path",
  "text/plain",
  "text/uri-list",
]) {
  assert.ok(
    terminalSource.includes(`getData("${format}")`),
    `Terminal declares it takes ${format} but never reads it`,
  );
}
assert.ok(terminalSource.includes("dt.files"), "…and files");

// The editor opens what it claims, rather than letting CodeMirror inline it.
const editorSource = readFileSync(
  new URL("../components/EditorPanel.tsx", import.meta.url),
  "utf8",
);
// QoL 6.4: the bytes go to `openDroppedFile` (the workspace's own file, or a
// read-only copy), read whole like every drop.
assert.match(editorSource, /\bopenDroppedFile\(/);
// Refuse before materializing, not after.
const dropBody = editorSource.slice(
  editorSource.indexOf("function onHostDrop"),
  editorSource.indexOf("function onHostDragOver"),
);
const checkAt = dropBody.indexOf("droppedFileRejection(");
const materializeAt = dropBody.indexOf("openDroppedFile(");
// Both must be there: `indexOf` returns -1 for a call that is gone, and
// -1 < anything, so an ordering assertion alone would pass on its absence.
assert.ok(checkAt >= 0, "the dropped-file pre-flight is gone");
assert.ok(materializeAt >= 0, "the drop no longer materializes the file");
assert.ok(
  checkAt < materializeAt,
  "the size and binary check must run before the file is materialized",
);
// The workspace the drop landed in, captured before the first await.
assert.match(dropBody, /const droppedInto = workspaceIdRef\.current;/);
assert.doesNotMatch(
  dropBody,
  /openPath\((?!droppedInto)/,
  "openPath must be given the captured workspace, not a live ref",
);
assert.match(editorSource, /addEventListener\("drop", onHostDrop, true\)/);
assert.ok(
  editorSource.includes('useEditor.getState().open('),
  "a dropped file must open, not be inserted",
);

// The editor's pre-flight must stay in step with the reader it stands in
// front of, or it refuses what Rust would open, or lets through what Rust
// then refuses after a pointless round-trip.
const filesRs = readFileSync(
  new URL("../../src-tauri/src/files.rs", import.meta.url),
  "utf8",
);
const maxReadBytes = filesRs.match(
  /const MAX_READ_BYTES: u64 = (\d+) \* (\d+) \* (\d+);/,
);
assert.ok(maxReadBytes, "files.rs no longer states MAX_READ_BYTES as a product");
assert.equal(
  Number(maxReadBytes[1]) * Number(maxReadBytes[2]) * Number(maxReadBytes[3]),
  MAX_OPENABLE_BYTES,
  "the editor's size limit and files.rs::MAX_READ_BYTES disagree",
);
assert.ok(
  filesRs.includes(`bytes.len().min(${BINARY_SNIFF_BYTES})`),
  "the editor's binary sniff window and files.rs disagree",
);

// The categorical refusal lives in Rust, with its own contract tests.
const policy = readFileSync(
  new URL("../../src-tauri/src/navigation.rs", import.meta.url),
  "utf8",
);
assert.match(policy, /pub fn navigation_allowed/);
assert.match(policy, /on_navigation/);
// The two halves of the refusal must agree on what the OS takes, or a link
// the page lets through gets cancelled by the policy behind it.
const rustSchemes = policy
  .match(/pub const HANDED_OFF_SCHEMES: &\[&str\] = &\[([^\]]*)\]/)?.[1]
  ?.match(/"([^"]+)"/g)
  ?.map((quoted) => `${quoted.slice(1, -1)}:`);
assert.deepEqual(
  rustSchemes,
  HANDED_OFF_SCHEMES,
  "navigation.rs and dropGuard.ts disagree about the handed-off schemes",
);
const libRs = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
assert.match(libRs, /navigation::init\(\)/);

// ── 1.174.0 E6 (P23): Codex chat refuses in its own words ───────────────
//
// A Codex chat tile takes no files. It is a marked zone that accepts
// nothing and names itself (`data-drop-refusal`), so a file dragged over it
// gets the tile's own words, shown on the tile — never the shell's generic
// "Drop files on a terminal…", which is wrong over a terminal-looking tile.
{
  const pageBody = node(["body"]);
  const grid = node(["div.tile-grid"], pageBody);
  const chatTile = node([DROP_ZONE_SELECTOR], grid, {
    [DROP_ACCEPTS_ATTR]: "",
    [DROP_REFUSAL_ATTR]: "codex-chat",
  });
  const chatBubble = node(["div.codex-bubble"], chatTile);
  const composer = node(["textarea:not([readonly]):not(:disabled)"], chatTile);
  const claudeTile = zoneNode(acceptsAttr(TILE_DROP_KINDS), grid);
  const claudePane = zoneNode(acceptsAttr(TERMINAL_DROP_KINDS), claudeTile);
  const claudeRow = node([".xterm-rows"], claudePane);

  assert.equal(refusingZoneKind(chatBubble), "codex-chat");
  assert.equal(refusingZoneKind(composer), "codex-chat");
  assert.equal(refusingZoneKind(claudeRow), null, "a terminal speaks for itself");
  assert.equal(refusingZoneKind(grid), null, "open ground is not a refusing zone");
  // An unknown value never names a zone.
  assert.equal(
    refusingZoneKind(node([DROP_ZONE_SELECTOR], grid, { [DROP_REFUSAL_ATTR]: "nonsense" })),
    null,
  );

  const one = "Codex chat can't take files. Drop it on a Claude or Codex terminal, or on a card.";
  const many = "Codex chat can't take files. Drop them on a Claude or Codex terminal, or on a card.";
  for (const target of [chatBubble, composer]) {
    for (const type of ["dragenter", "dragover"] as const) {
      const d = decideDropGuard({ type, target, payload: FINDER_FILE, rules: shellRules, internal: false });
      assert.equal(d.claimed, false, "nothing on a Codex chat takes the file");
      assert.equal(d.block, true);
      assert.equal(d.refuse, true, "the cursor says the drop does nothing");
      assert.equal(d.zoneSpeaks, true);
      assert.equal(d.hint, false, "the tile shows its words; the toast does not repeat them");
      assert.equal(d.message, one);
      assert.notEqual(d.message, UNHANDLED_DROP_MESSAGE);
      // A generic toast still up from the open ground before goes.
      assert.equal(guidanceFor(d, type), "hide");
    }
  }
  const several = decideDropGuard({ type: "dragover", target: chatBubble, payload: FILES, rules: shellRules, internal: false, count: 3 });
  assert.equal(several.message, many);
  // Released there anyway: said once, in the zone's words.
  const dropped = decideDropGuard({ type: "drop", target: chatBubble, payload: FILES, rules: shellRules, internal: false, count: 2 });
  assert.equal(guidanceFor(dropped, "drop"), "announce");
  assert.equal(dropped.message, many);
  // Leaving it keeps the idle timer in charge, as everywhere else.
  assert.equal(
    guidanceFor(decideDropGuard({ type: "dragleave", target: chatBubble, payload: FILES, rules: shellRules, internal: false }), "dragleave"),
    "leave",
  );
  // The Claude tile beside it still takes the file.
  assert.equal(decideDropGuard({ type: "dragover", target: claudeRow, payload: FINDER_FILE, rules: shellRules, internal: false }).claimed, true);
  // A drag that carries nothing is not a file for Codex chat either: no
  // toast, and nothing to announce (as over any place that takes no files).
  const empty = decideDropGuard({ type: "dragover", target: chatBubble, payload: EMPTY_PAYLOAD, rules: shellRules, internal: false });
  assert.equal(empty.hint, false);
  assert.equal(empty.announceable, false);
  // Polish: a link or text dragged from another app over the chat (not the
  // composer) is no file: the generic words, not Codex chat's.
  for (const payload of [URI, URI_ONLY, TEXT]) {
    const d = decideDropGuard({ type: "dragover", target: chatBubble, payload, rules: shellRules, internal: false });
    assert.equal(d.zoneSpeaks, false);
    assert.equal(d.message, UNHANDLED_DROP_MESSAGE);
  }
  // An internal path (Code's file list) is a file: the zone's words.
  assert.equal(
    decideDropGuard({ type: "dragover", target: chatBubble, payload: PATH, rules: shellRules, internal: true }).message,
    one,
  );
  // Text dragged onto the composer is still the composer's.
  assert.equal(decideDropGuard({ type: "dragover", target: composer, payload: TEXT, rules: shellRules, internal: false }).claimed, true);

  // The guard counts the files the drag carries.
  assert.ok(guardSource.includes("count: dragFileCount(e.dataTransfer)"));
  // The Codex chat tile is marked that way, from one place.
  assert.ok(
    tileSource.includes('data-drop-refusal={tile.kind === "codex-chat" ? "codex-chat" : undefined}') &&
      tileSource.includes('data-drop-zone={tile.kind === "codex-chat" ? "codex-chat" : "tile"}'),
    "Tile.tsx no longer marks Codex chat as a refusing zone",
  );
  assert.equal(DROP_REFUSAL_ATTR, "data-drop-refusal");
  assert.ok(tileSource.includes("codexChatRefusalWords("), "Tile.tsx must show the zone's own words");
}

console.log("dropGuard: all contracts passed");
