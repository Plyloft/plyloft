// GH #230: read a file dropped from outside Ply whole, or say it could not be.
//
// Four drops (21 and 23 September; 1.148.0 among them) were saved cut short at exact 64 KiB multiples
// (262144, 327680 bytes), always macOS screenshots dropped seconds after they
// were taken. Ply's own path has no chunking: `file.arrayBuffer()` is one read,
// the bytes cross IPC as one array and Rust wrote them with one `fs::write`.
// And the first 262144 bytes of the truncated `d545bde0-…15.33.52.png` are
// exactly the first 262144 bytes of `a31ea2bc-…15.33.52.png`, the same
// screenshot dropped again 31 s later and saved whole. So the webview handed
// Ply a prefix: the source file was still being written (in 64 KiB writes)
// when the drop read it, and nothing checked what came back.
//
// What is checked now, before anything is saved:
// - the bytes read must be `File.size` bytes — fewer is a cut, more means the
//   file changed while being read; neither is used;
// - a PNG's chunk chain, walked from its signature, must reach `IEND`. A
//   screenshot still being written can report its current, short size as
//   `File.size`, so the length check alone would pass the observed truncation;
//   the chunk chain does not. Bytes after `IEND` are tolerated.
// - a read that rejects (WebKit's `NotReadableError` when the file changed
//   since the drop snapshotted it) is an incomplete read too, not a raw error.
// One re-read follows ~500 ms later, then the drop is refused with a message
// that says so. WebKit snapshots a dropped file's size and modification time
// at the drop, so a re-read of the same `File` is unlikely to see the finished
// file; it is kept short so the refusal comes quickly, and dropping the file
// again (a new snapshot) is what the message asks for.
// JPEG, GIF and other formats get the length check only: they may legitimately
// carry data after their end marker (a Motion Photo JPEG carries a whole MP4),
// and a false refusal would block a good drop.
import { fsOpenDropped, fsSaveDroppedFile, type DroppedOpen } from "../ipc";
import { pushToast } from "../store/toastStore";

/** The PNG signature, and the type of the chunk that must end the file. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = [0x49, 0x45, 0x4e, 0x44];

/** The wait before the one re-read of an incomplete file, in ms. */
export const DROP_REREAD_DELAY_MS = 500;

function startsWith(bytes: Uint8Array, prefix: number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

/** Whether a PNG's chunk chain reaches `IEND` inside `bytes`: each chunk is a
 *  4-byte big-endian length, a 4-byte type, the data and a 4-byte CRC. A
 *  chunk whose declared end lies past the buffer means the file was cut. */
export function pngReachesEnd(bytes: Uint8Array): boolean {
  let at = PNG_SIGNATURE.length;
  while (at + 8 <= bytes.length) {
    const length =
      ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
    const end = at + 12 + length;
    if (end > bytes.length) return false;
    if (startsWith(bytes, IEND, at + 4)) return true;
    at = end;
  }
  return false;
}

/** Why `bytes` is not the whole of a file whose `File.size` is `size`, or
 *  `null` when nothing says it is incomplete. */
/** Formats a valid file of which is never empty: an image, video, audio,
 *  PDF or archive. */
const NEVER_EMPTY_TYPE = /^(image|video|audio)\/|^application\/(pdf|zip|x-tar|gzip|x-gzip|x-7z-compressed|x-rar-compressed|x-bzip2|x-xz)$/;
const NEVER_EMPTY_EXT =
  /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|ico|svg|avif|mov|mp4|m4v|webm|mkv|avi|mp3|m4a|wav|aiff?|flac|ogg|pdf|zip|tar|tgz|gz|bz2|xz|7z|rar|dmg)$/i;

/** Whether a file of this name and type can't really be empty. */
export function neverEmpty(name: string, type: string): boolean {
  return NEVER_EMPTY_TYPE.test(type) || NEVER_EMPTY_EXT.test(name);
}

export function droppedBytesIncomplete(size: number, bytes: Uint8Array, name = "", type = ""): string | null {
  // 1.176.1: three screenshots arrived as 0 bytes and were saved empty, with
  // no message (the owner was dragging macOS's floating screenshot
  // thumbnail, whose `File` itself reports size 0). Review 1: an empty read
  // is refused only when it can't be a real empty file — a size that said
  // otherwise, or a format that is never empty (an image, video, audio, PDF
  // or archive). `__init__.py`, `.gitkeep` or an empty `.env.example` go in
  // as before. A refused one writes nothing to disk.
  if (bytes.length === 0 && (size > 0 || neverEmpty(name, type))) return "it arrived empty: 0 bytes";
  if (bytes.length < size) {
    return `read ${bytes.length} of its ${size} bytes`;
  }
  if (bytes.length > size) {
    return `it changed while being read: ${bytes.length} bytes, not its ${size}`;
  }
  if (startsWith(bytes, PNG_SIGNATURE) && !pngReachesEnd(bytes)) {
    return `the PNG stops after ${bytes.length} bytes, before its end`;
  }
  return null;
}

/** Why a dropped file could not be read whole (1.172.2 D1/D2):
 *  - `arriving`: the read rejected `NotFoundError` — the file the drop names
 *    is not there yet. Measured (1.172.2 D1, ux-1722/measure.md): a fresh
 *    screenshot dragged from its thumbnail on another Mac (Universal Control)
 *    arrives as a promise, and re-reading the same `File` never recovered.
 *  - `saving`: fewer bytes than `File.size`, a PNG that stops before its end,
 *    or WebKit's `NotReadableError` (the file changed since the drop): it was
 *    still being written.
 *  - `changed`: more bytes than `File.size` — it changed while being read.
 *  - `unreadable`: any other read that rejected.
 *  - `empty` (1.176.1): it arrived with no bytes at all. */
export type DropReadKind = "arriving" | "saving" | "changed" | "unreadable" | "empty";

/** A dropped file that could not be read completely. Its `message` is the
 *  raw account (byte counts, the engine's error) for Details/Copy only; what
 *  the person reads comes from `dropRefusalWords`. */
export class IncompleteDropError extends Error {
  readonly fileName: string;
  readonly kind: DropReadKind;
  readonly reason: string;
  constructor(name: string, reason: string, kind: DropReadKind = "saving") {
    super(`${name} could not be read completely (${reason})`);
    this.name = "IncompleteDropError";
    this.fileName = name;
    this.kind = kind;
    this.reason = reason;
  }
}

export type ReadOptions = {
  /** The wait before the one re-read; defaults to `DROP_REREAD_DELAY_MS`. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ReadFailure = { kind: DropReadKind; reason: string };

/** The kind of a read that rejected, from the engine's error name. */
export function readRejectionKind(err: unknown): DropReadKind {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "NotFoundError") return "arriving";
  if (name === "NotReadableError") return "saving";
  return "unreadable";
}

/** One whole read: the bytes, or why they are not the whole file. */
async function readOnce(file: File): Promise<Uint8Array | ReadFailure> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: readRejectionKind(err), reason: `the read failed — ${what}` };
  }
  const reason = droppedBytesIncomplete(file.size, bytes, file.name, file.type);
  if (reason === null) return bytes;
  return { kind: bytes.length === 0 ? "empty" : bytes.length > file.size ? "changed" : "saving", reason };
}

/** The whole of a dropped file, or an `IncompleteDropError`. One short
 *  re-read and no more: measured (1.172.2 D1), waiting longer on the same
 *  `File` does not bring it back, so the refusal comes quickly. */
export async function readDroppedFile(file: File, opts: ReadOptions = {}): Promise<Uint8Array> {
  const first = await readOnce(file);
  if (first instanceof Uint8Array) return first;
  await (opts.sleep ?? realSleep)(opts.delayMs ?? DROP_REREAD_DELAY_MS);
  const second = await readOnce(file);
  if (second instanceof Uint8Array) return second;
  throw new IncompleteDropError(file.name, second.reason, second.kind);
}

/** Read a dropped file whole and materialize it in the cache's `dropped/`
 *  directory; Rust refuses bytes that do not arrive at the length read. */
export async function saveDroppedFile(file: File, opts: ReadOptions = {}): Promise<string> {
  const bytes = await readDroppedFile(file, opts);
  return fsSaveDroppedFile(file.name, bytes);
}

/** QoL 6.4: read a file dropped on the editor whole, and ask what it opens
 *  as — the workspace's own file when it is one of them, else a copy kept
 *  for a read-only tab (`fs_open_dropped`). */
export async function openDroppedFile(
  workspaceId: string,
  file: File,
  opts: ReadOptions = {},
): Promise<DroppedOpen> {
  const bytes = await readDroppedFile(file, opts);
  const modified = Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : null;
  return fsOpenDropped(workspaceId, file.name, bytes, modified);
}

// ── what the person is told (1.172.2 D2) ──────────────────────────────────
//
// Owner, 2026-10-28: the toast said "… (the read failed — NotFoundError: The
// object can not be found here.)" — engine text a person can't act on. Each
// drop site now says the same plain words by kind; the raw reason waits
// behind the toast's Details/Copy.

/** Where the file was dropped: what "nothing happened" means there, and
 *  the other way in it offers. */
export type DropSite = "terminal" | "card" | "chat" | "editor";

/** A file refused before it was read: over the place's size limit. */
export class DropTooLargeError extends Error {
  readonly fileName: string;
  readonly size: number;
  readonly limit: number;
  constructor(name: string, size: number, limit: number) {
    super(`${name} is ${size} bytes; the limit is ${limit} bytes`);
    this.name = "DropTooLargeError";
    this.fileName = name;
    this.size = size;
    this.limit = limit;
  }
}

export type DropRefusal = { name: string; error: unknown };
export type DropRefusalWords = { title: string; body: string; details: string };

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** "Drop it again" and the other way in the place offers. */
function againWords(where: DropSite, it: string): string {
  switch (where) {
    case "card":
      return `Drop ${it} again, or pick ${it} with Attach.`;
    case "chat":
      return `Drop ${it} again, or pick ${it} with Add files.`;
    case "terminal":
    case "editor":
      return `Drop ${it} again.`;
  }
}

/** What happened to the rest of the drop: nothing, or the others went in.
 *  Challenger round 1: "Nothing was added" is never said when some were. */
function outcomeWords(where: DropSite, added: number): string {
  if (added > 0) return where === "editor" ? "The others opened." : "The others were added.";
  switch (where) {
    case "terminal":
      return "Nothing was added to the terminal.";
    case "editor":
      return "Nothing was opened.";
    default:
      return "Nothing was added.";
  }
}

/** The outcome and the way to try again, for a refusal that is not a
 *  matter of waiting. */
function retryWords(where: DropSite, many: boolean, added: number): string {
  return `${outcomeWords(where, added)} ${againWords(where, many ? "them" : "it")}`;
}

/** A file refused with a plain sentence of its own (the editor's "is not a
 *  text file", "opens files up to 5 MB"). */
export class DropRefusedError extends Error {
  readonly sentence: string;
  constructor(sentence: string) {
    super(sentence);
    this.name = "DropRefusedError";
    this.sentence = sentence;
  }
}

/** The raw account of one refusal, for Details: the error names the file
 *  itself when it is ours, else the file is named in front. */
function detailsOf(name: string, error: unknown): string {
  if (error instanceof IncompleteDropError || error instanceof DropTooLargeError) return error.message;
  if (error instanceof DropRefusedError) return `${name}: ${error.sentence}`;
  return `${name}: ${rawOf(error)}`;
}

function rawOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Is this refusal one that dropping again in a moment fixes? */
function waitFixes(error: unknown): boolean {
  return error instanceof IncompleteDropError && error.kind !== "unreadable";
}

/** The words for one dropped file that was not used. The title and body
 *  never carry the engine's text; `details` does. `added` is how many other
 *  files of the same drop did go in. */
export function dropRefusalWords(
  error: unknown,
  name: string,
  where: DropSite,
  added = 0,
): DropRefusalWords {
  const details = detailsOf(name, error);
  const others = added > 0 ? ` ${outcomeWords(where, added)}` : "";
  if (error instanceof IncompleteDropError) {
    switch (error.kind) {
      case "arriving":
        // Once it is saved the thumbnail is gone: it's the saved file that
        // is dragged again.
        return {
          title: `${name} hadn't arrived yet`,
          body: `It's still being saved, or still on its way from your other computer. Drag the saved file again in a moment.${others}`,
          details,
        };
      case "saving":
      case "changed":
        return { title: `${name} was still being saved`, body: `Drop it again in a moment.${others}`, details };
      case "unreadable":
        return { title: `${name} couldn't be read`, body: retryWords(where, false, added), details };
      case "empty":
        // A screenshot's floating thumbnail can hand over nothing: the saved
        // file, dragged again, is whole.
        return {
          title: `${name} arrived empty`,
          body: `Nothing was saved. Drop it again in a moment, or drag the saved file.${others}`,
          details,
        };
    }
  }
  if (error instanceof DropTooLargeError) {
    return {
      title: `${name} is too big`,
      body: `It is ${megabytes(error.size)}; ${where === "chat" ? "a message" : "a card"} takes files up to ${megabytes(error.limit)}.${others}`,
      details,
    };
  }
  if (error instanceof DropRefusedError) {
    return { title: where === "editor" ? `${name} didn't open` : `${name} wasn't added`, body: `${error.sentence}${others}`, details };
  }
  return {
    title: where === "editor" ? `${name} didn't open` : `${name} wasn't added`,
    body: retryWords(where, false, added),
    details,
  };
}

/** Names in a sentence: "a.png, b.png and c.png", at most three, then
 *  "and 2 more". */
function namesSentence(names: string[]): string {
  if (names.length <= 3) {
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** The words for every file of one drop that was not used: one toast per
 *  gesture, never one per file. `null` when nothing was refused. `added`
 *  is how many files of the drop did go in. */
export function dropRefusalsWords(
  refusals: DropRefusal[],
  where: DropSite,
  added = 0,
): DropRefusalWords | null {
  if (refusals.length === 0) return null;
  if (refusals.length === 1) return dropRefusalWords(refusals[0].error, refusals[0].name, where, added);
  const details = refusals.map((r) => detailsOf(r.name, r.error)).join("\n");
  const n = refusals.length;
  const title = where === "editor" ? `${n} files didn't open` : `${n} files weren't added`;
  const names = namesSentence(refusals.map((r) => r.name));
  const others = added > 0 ? ` ${outcomeWords(where, added)}` : "";
  const tooBig = refusals.filter((r) => r.error instanceof DropTooLargeError);
  const rest = refusals.filter((r) => !(r.error instanceof DropTooLargeError));
  const place = where === "chat" ? "a message" : "a card";
  let body: string;
  if (rest.every((r) => waitFixes(r.error)) && tooBig.length === 0) {
    const arriving = rest.some(
      (r) => r.error instanceof IncompleteDropError && (r.error.kind === "arriving" || r.error.kind === "empty"),
    );
    body = arriving
      ? `${names}. They weren't saved yet. Drag the saved files again in a moment.${others}`
      : `${names}. They were still being saved. Drop them again in a moment.${others}`;
  } else if (rest.length === 0) {
    const limit = (tooBig[0].error as DropTooLargeError).limit;
    body = `${names}. They are too big; ${place} takes files up to ${megabytes(limit)} each.${others}`;
  } else if (tooBig.length > 0) {
    // Challenger round 1: "drop them again" is no use for a file over the
    // limit, so those are named apart.
    const limit = (tooBig[0].error as DropTooLargeError).limit;
    const big = namesSentence(tooBig.map((r) => r.name));
    const verb = tooBig.length === 1 ? "is" : "are";
    const again = againWords(where, rest.length === 1 ? "it" : "them");
    body = `${big} ${verb} over ${megabytes(limit)}. ${namesSentence(rest.map((r) => r.name))}: ${again[0].toLowerCase()}${again.slice(1)}${others}`;
  } else {
    body = `${names}. ${retryWords(where, true, added)}`;
  }
  return { title, body, details };
}

/** Say the refused files of one drop in one calm toast; its raw reasons
 *  behind Details. Returns the toast's id, or `null` when nothing failed. */
export function toastDropRefusals(refusals: DropRefusal[], where: DropSite, added = 0): string | null {
  const words = dropRefusalsWords(refusals, where, added);
  if (!words) return null;
  const kind = refusals.every((r) => waitFixes(r.error)) ? "warn" : "error";
  return pushToast({ kind, title: words.title, body: words.body, details: words.details });
}
