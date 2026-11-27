/**
 * v1.106.0 (Builder/Challenger injection contract): text sent into a live
 * Builder PTY is wrapped in bracketed paste so a multi-line message lands
 * in the vendor's composer as one block; the trailing CR submits it.
 * Pure — no Tauri import — so it is unit-tested under node.
 */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** The Enter that submits what the composer holds. */
export const SUBMIT = "\r";

/**
 * CL-7 round 3: whether keystrokes from the terminal hold an Enter that
 * submits — not a CR or LF inside a bracketed paste (the pasted text's own
 * lines), and not Option+Enter (ESC then CR, a newline in the composer).
 * An Enter on an empty prompt or in a menu still reads as one here; the
 * store's next turn-over scan corrects that (`markPromptBox`).
 */
export function typedEnter(data: string): boolean {
  let outside = "";
  let i = 0;
  while (i < data.length) {
    const start = data.indexOf(PASTE_START, i);
    if (start < 0) {
      outside += data.slice(i);
      break;
    }
    outside += data.slice(i, start);
    const end = data.indexOf(PASTE_END, start + PASTE_START.length);
    // An unterminated paste: the rest of the chunk is pasted text.
    if (end < 0) break;
    i = end + PASTE_END.length;
  }
  return /[\r\n]/.test(outside.replace(/\x1b[\r\n]/g, ""));
}

/**
 * Measured 2026-10-15 on Claude Code 2.1.300: text that reaches the
 * composer — typed or pasted — with `!` as its very first character runs
 * as a shell command, even in the read-only profile (no Bash in --tools,
 * Bash disallowed, --restricted, disableSkillShellExecution); a leading `/`
 * opens the slash-command menu. A leading space disables both on Claude.
 * Codex's TUI has the same two prefixes (`!` runs a local shell command,
 * `/` is a slash command), so its messages get the same guard; whether a
 * leading space disables them there is unmeasured (Codex may trim it).
 *
 * Plyloft's own messages into a live session therefore never start with
 * either: when the text after any leading whitespace (space, tab, newline)
 * starts with `!` or `/`, one space goes in front. The text itself is never
 * trimmed, and only its start counts. No caller sends a slash command on
 * purpose; one that ever has to must write it without `pasteText`. The
 * member's own keystrokes (`writeBuilderInput`) never pass through here.
 */
export function composerSafe(text: string): string {
  return /^\s*[!/]/.test(text) ? ` ${text}` : text;
}

/** Plyloft's message, guarded (`composerSafe`), framed, with its Enter. */
export function pasteText(text: string): string {
  return `${PASTE_START}${composerSafe(text)}${PASTE_END}${SUBMIT}`;
}

export function pasteBytes(text: string): Uint8Array {
  return new TextEncoder().encode(pasteText(text));
}

/** Typographic characters and what they become in a paste replayed as
 *  keys (`plainForKeys`). */
const PLAIN_FOR_KEYS: Array<[RegExp, string]> = [
  [/\u2192/g, "->"],
  [/\u2190/g, "<-"],
  [/[\u201c\u201d\u201e\u201f]/g, '"'],
  [/[\u2018\u2019\u201a\u201b]/g, "'"],
  [/[\u00b7\u2014\u2013]/g, "-"],
  [/\u2026/g, "..."],
  [/\u00a0/g, " "],
];

/**
 * 1.172.0 E2 (Windows walk 2026-10-28): ConPTY replays a paste to Codex as
 * one key event a character, so the fewer unusual keys it holds, the fewer
 * chances a key is read as something else — the walk's ~1.5k-character
 * review, with arrows, curly quotes and blank lines, ended up in Codex's
 * transcript search instead of its composer. For that path only
 * (`submitsSeparately`): typographic characters become their plain ASCII
 * spelling (→ ->, ← <-, curly quotes straight, · — – -, … ..., a
 * non-breaking space a space), CR LF and a lone CR become LF, runs of three
 * or more line breaks become one blank line, and control characters other
 * than tab and line break are dropped — an ESC in the text could otherwise
 * spell a key (F3, `ESC O R`, opens Codex's transcript search). Everything
 * else is kept as it is.
 */
export function plainForKeys(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  for (const [from, to] of PLAIN_FOR_KEYS) out = out.replace(from, to);
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return out.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n");
}

/** The paste alone, without the Enter (`writePasteThenSubmit`, Codex on
 *  Windows): its text as plain keys (`plainForKeys`). */
export function pasteBodyBytes(text: string): Uint8Array {
  return new TextEncoder().encode(`${PASTE_START}${composerSafe(plainForKeys(text))}${PASTE_END}`);
}

/**
 * Windows port: the Codex TUI under ConPTY never sees a bracketed paste.
 * ConPTY hands it console key events, one per character, and Codex's
 * paste-burst heuristic gathers them into `[Pasted Content N chars]`; an
 * Enter that arrives inside the burst (or within its short suppress window)
 * is taken as part of the paste, so the message sat in the composer unsent —
 * measured on codex-cli 0.157.0 in the Windows 11 VM, where Build done's
 * self-check then waited out its 10 minutes. The Enter has to be its own
 * write once the paste has settled. Claude Code on Windows and both vendors
 * on the Mac submit with the trailing CR, as before.
 */
export function submitsSeparately(vendor: string | undefined, windows: boolean): boolean {
  return windows && vendor === "codex";
}

/** No output for this long after the paste: Codex has drawn its
 *  `[Pasted Content …]` placeholder and the burst is over. Measured: the
 *  keys redraw every ~1 ms while they are read, then 80–100 ms pass before
 *  the placeholder, then nothing. */
export const PASTE_SETTLE_QUIET_MS = 500;
/** Never sooner than this after the paste was written. */
export const PASTE_SETTLE_MIN_MS = 500;
/** Send the Enter by this time whatever the screen does, so a Builder that
 *  keeps printing still gets its message submitted — for a short paste
 *  (`pasteSettleMaxMs` scales it for a long one). */
export const PASTE_SETTLE_MAX_MS = 30_000;
/** A long paste's cap per character: ConPTY replays the paste as keys at
 *  ~0.5–1 ms each, so a fixed 30 s would send the Enter mid-burst for a
 *  paste of more than ~30 000 characters. Twice the slowest rate measured. */
export const PASTE_SETTLE_MS_PER_CHAR = 2;
/** However long the paste, the Enter goes by this time. */
export const PASTE_SETTLE_CEILING_MS = 300_000;

/** The cap for this paste: 30 s, or 2 ms a character for a longer one,
 *  never past five minutes. */
export function pasteSettleMaxMs(text: string): number {
  return Math.min(
    PASTE_SETTLE_CEILING_MS,
    Math.max(PASTE_SETTLE_MAX_MS, text.length * PASTE_SETTLE_MS_PER_CHAR),
  );
}
export const PASTE_SETTLE_POLL_MS = 100;

/**
 * 1.170.0 F1 (Windows walk 2026-10-26, the first card's self-check sat as
 * `› [Pasted Content 3210 chars]` for 3 minutes): the Enter is confirmed.
 * This long after it, with the session quiet, the screen is read; while
 * Codex's composer still holds the pasted block — at its composer, no turn
 * running, nothing asked — the Enter is sent again, at most
 * `SUBMIT_RETRIES` times. Only an Enter: nothing else is ever typed, and a
 * screen that can't be read (no live terminal) or shows anything else
 * sends nothing more.
 */
export const SUBMIT_CONFIRM_MS = 1_500;
/** Enters sent again, at most, after the first. */
export const SUBMIT_RETRIES = 2;
/** The confirmation gives up this long after the last Enter if the session
 *  never goes quiet (a turn printing: it was submitted). */
export const SUBMIT_CONFIRM_MAX_MS = 10_000;

export interface PasteSubmitDeps {
  write(bytes: Uint8Array): Promise<void>;
  /** The session's last output (epoch ms), or null when unknown. */
  lastOutputAt(): Promise<number | null>;
  /** F1: whether the composer on screen still holds the pasted block —
   *  true only at Codex's idle composer with the block in it; false for
   *  anything else; null when no live screen can be read. Absent: the
   *  Enter is not confirmed. */
  composerHoldsPaste?(): boolean | null;
  /** F1: the Enter was sent again (`n`: 1, 2), for the log. */
  resubmitted?(n: number): void;
  /** 1.172.0 E2 (Challenger 2): Plyloft pasted this same message into this
   *  session before and it was left unsent (`PASTE_STILL_UNSENT`). With the
   *  composer still holding it, it is not pasted again — only the Enter. */
  alreadyPasted?(): boolean;
  /** 1.172.0 E2: whether Codex shows a screen over its composer that
   *  takes the keys instead (its transcript search: `codexOverlayOpen`);
   *  null when no live screen can be read. Absent: never checked. */
  overlayOpen?(): boolean | null;
  /** 1.177.0 Compare: checked right before each Enter Plyloft writes; false
   *  means the pass is no longer wanted (the member typed, cancelled, turned
   *  it off, the pair changed) and no Enter is sent (`ENTER_NOT_WANTED`).
   *  Absent: always wanted — the Builder is unchanged. */
  stillWanted?(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** 1.177.0 Compare: thrown instead of an Enter that is no longer wanted. */
export const ENTER_NOT_WANTED = "Plyloft's Enter is no longer wanted.";

/** The session's last output (`since - 1` when it was before `since`);
 *  null when it isn't known (no stamp, or it can't be read). */
async function lastOutputSince(deps: PasteSubmitDeps, since: number): Promise<number | null> {
  try {
    const at = await deps.lastOutputAt();
    return at == null ? null : Math.max(since - 1, at);
  } catch {
    return null;
  }
}

/** 1.172.0 E2: the paste did not reach Codex's composer — its transcript
 *  search took the keys, or the composer still holds it after every Enter.
 *  `sendOnce` records the delivery as failed with this text; it reads as a
 *  sentence of its own (`codexScreenHelp` says what to do). */
export const OVERLAY_TOOK_PASTE = "Codex opened its transcript search while Plyloft was typing it in.";
export const OVERLAY_ALREADY_OPEN = "Codex's transcript search was open, so Plyloft didn't type it in.";
export const PASTE_STILL_UNSENT = "It is in Codex's message box, unsent.";

/** Whether `error` means nothing was typed — the search was already open
 *  — so the delivery goes in again by itself once the search is closed.
 *  (Round 2, Challenger 2) Not when the search took part of the message:
 *  a resend the moment it closes would land after the leftover. */
export function isCodexOverlayError(error: string | null | undefined): boolean {
  return error === OVERLAY_ALREADY_OPEN;
}

/** Whether `error` leaves something for the person to do in the session
 *  before the message is sent again by a press (`Send it again`). */
export function codexScreenNeedsPress(error: string | null | undefined): boolean {
  return error === OVERLAY_TOOK_PASTE || error === PASTE_STILL_UNSENT;
}

/** What the person does about an E2 failure, in plain words; null for any
 *  other error. `again`: Plyloft sends it again by itself once the search
 *  is closed (only when nothing was typed: `isCodexOverlayError`). */
export function codexScreenHelp(error: string | null | undefined, again: boolean): string | null {
  if (error === OVERLAY_TOOK_PASTE) {
    return `${error} Part of it may be in the search: press Esc in the session to close it, clear Codex's message box if anything is left there, then send it again.`;
  }
  if (error === OVERLAY_ALREADY_OPEN) {
    return `${error} Press Esc in the session to close the search.${again ? " Plyloft sends it again once the search is closed." : ""}`;
  }
  if (error === PASTE_STILL_UNSENT) return `${error} Press Enter in the session to send it.`;
  return null;
}

/** Round 2 (Challenger 1): the Codex prompt scan's own flags with the
 *  transcript search open over the composer — not a prompt anything is
 *  typed into. */
export function withoutCodexOverlay(overlayOpen: boolean, flag: boolean): boolean {
  return flag && !overlayOpen;
}

/** Whether the screen shows an overlay; unknown (null) and absent count as
 *  no. A reader that throws counts as unknown. */
function overlaySeen(deps: PasteSubmitDeps): boolean {
  try {
    return deps.overlayOpen?.() === true;
  } catch {
    return false;
  }
}

/** No reader given can read a live screen. */
function screenUnread(deps: PasteSubmitDeps): boolean {
  const holds = deps.composerHoldsPaste ? deps.composerHoldsPaste() : null;
  let overlay: boolean | null = null;
  try {
    overlay = deps.overlayOpen ? deps.overlayOpen() : null;
  } catch {
    overlay = null;
  }
  return holds === null && overlay === null;
}

/** Write the paste, wait until the session printed after it and has been
 *  quiet for `PASTE_SETTLE_QUIET_MS` (or `pasteSettleMaxMs(text)` passed),
 *  then write the Enter, and confirm it (`SUBMIT_CONFIRM_MS`). Resolves
 *  once the Enter is written and, where the screen can be read, taken.
 *  1.172.0 E2: rejects — and types nothing, or sends no Enter or no further
 *  one — when the screen shows Codex's transcript search before the paste
 *  (`OVERLAY_ALREADY_OPEN`) or after it (`OVERLAY_TOOK_PASTE`), or
 *  the composer still holds the paste after every Enter
 *  (`PASTE_STILL_UNSENT`): the delivery is then not "sent". */
export async function writePasteThenSubmit(
  text: string,
  deps: PasteSubmitDeps,
): Promise<"settled" | "capped"> {
  // E2: the search is already open — every key would go into its query
  // (and a self-check that retries would type there again and again).
  if (overlaySeen(deps)) throw new Error(OVERLAY_ALREADY_OPEN);
  let result: "settled" | "capped" = "settled";
  // E2 (Challenger 2): the composer still holds this message from the last
  // try — another paste would stack a second copy on it. Only the Enter.
  if (deps.alreadyPasted?.() === true && deps.composerHoldsPaste?.() === true) {
    if (deps.stillWanted && !deps.stillWanted()) throw new Error(ENTER_NOT_WANTED);
    await deps.write(new TextEncoder().encode(SUBMIT));
    await confirmSubmit(deps);
    return result;
  }
  await deps.write(pasteBodyBytes(text));
  const start = deps.now();
  const max = pasteSettleMaxMs(text);
  for (;;) {
    await deps.sleep(PASTE_SETTLE_POLL_MS);
    const now = deps.now();
    if (now - start >= max) {
      result = "capped";
      break;
    }
    if (now - start < PASTE_SETTLE_MIN_MS) continue;
    const last = await lastOutputSince(deps, start);
    // F1: Codex has to have read the keys — its redraw comes after the
    // paste. A Codex that has not read them yet (busy finishing its turn)
    // prints nothing, and an Enter written then reached it inside the
    // burst. Unknown (the stamp can't be read): the paste's own time.
    if (last !== null && last < start) continue;
    if (now - (last ?? start) >= PASTE_SETTLE_QUIET_MS) {
      result = "settled";
      break;
    }
  }
  // E2: the keys went into an overlay (the walk: Codex's transcript
  // search) — an Enter there would act in it, not submit anything.
  if (overlaySeen(deps)) throw new Error(OVERLAY_TOOK_PASTE);
  if (deps.stillWanted && !deps.stillWanted()) throw new Error(ENTER_NOT_WANTED);
  await deps.write(new TextEncoder().encode(SUBMIT));
  if (deps.composerHoldsPaste || deps.overlayOpen) await confirmSubmit(deps);
  return result;
}

/** F1: re-send the Enter while the composer still holds the paste. E2:
 *  throws when an overlay is seen, or the paste is still held once every
 *  retry was spent. Only Codex's transcript search is recognised as an
 *  overlay (`codexOverlayOpen`, from real screens); any other screen that is
 *  neither the composer holding the paste nor the search — its transcript
 *  pager (Ctrl+T), a picker — resolves as taken, as before. */
async function confirmSubmit(deps: PasteSubmitDeps): Promise<void> {
  // No live screen to read: nothing to confirm on, nothing more is sent.
  if (screenUnread(deps)) return;
  let enterAt = deps.now();
  let retries = 0;
  for (;;) {
    await deps.sleep(PASTE_SETTLE_POLL_MS);
    const now = deps.now();
    if (overlaySeen(deps)) throw new Error(OVERLAY_TOOK_PASTE);
    if (now - enterAt >= SUBMIT_CONFIRM_MAX_MS) return;
    if (now - enterAt < SUBMIT_CONFIRM_MS) continue;
    // Challenger: the screen is read on every poll and decides first — a
    // running turn or a question in view is "not held", and the person's
    // typing (held meanwhile) is released at once, not after
    // SUBMIT_CONFIRM_MAX_MS of a turn that never goes quiet.
    const holds = deps.composerHoldsPaste?.() ?? null;
    if (holds !== true) return;
    // E2: every Enter spent and the composer still holds it: not taken.
    if (retries >= SUBMIT_RETRIES) throw new Error(PASTE_STILL_UNSENT);
    // Still held: another Enter only once the session is quiet.
    const last = await lastOutputSince(deps, enterAt);
    if (last !== null && now - Math.max(last, enterAt) < PASTE_SETTLE_QUIET_MS) continue;
    if (deps.stillWanted && !deps.stillWanted()) throw new Error(ENTER_NOT_WANTED);
    retries += 1;
    await deps.write(new TextEncoder().encode(SUBMIT));
    deps.resubmitted?.(retries);
    enterAt = deps.now();
  }
}

/** The terminal's own replies xterm writes into the PTY — not the person
 *  typing: focus in/out (ESC[I, ESC[O), cursor position (ESC[n;mR), device
 *  attributes (ESC[?…c, ESC[>…c), colour scheme reports (ESC[?997;1n /
 *  ESC[?997;2n, lib/themeReports), mouse reports (SGR ESC[<…M/m, X10
 *  ESC[M + 3 bytes), OSC replies (ESC]…BEL or ESC]…ESC\) and DCS replies
 *  (ESCP…ESC\). Shift/Ctrl+F3 (ESC[1;2R / ESC[1;5R) has a cursor report's
 *  shape and mouse-wheel reports are mouse reports: classed as reports too,
 *  harmless (they type nothing, and the Builder and tiles only skip their
 *  input stamp for them). */
const TERMINAL_REPORT =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[\?997;[12]n|\x1b\[[?>]?[\d;]*c|\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3}|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1bP[\s\S]*?\x1b\\/g;

/** 1.172.0 E2: whether `data` is only cursor position reports
 *  (`ESC[row;colR`) — xterm's answer to a program's `ESC[6n`. Shift/Ctrl+F3
 *  (`ESC[1;2R`, `ESC[1;5R`) has the same shape and counts too. */
export function isCursorReport(data: string): boolean {
  return /^(?:\x1b\[\d+;\d+R)+$/.test(data);
}

/** v1.154.1 (J5): whether `data` from xterm's `onData` is only the
 *  terminal's own reports — then nothing was sent to the Builder. */
export function isTerminalReport(data: string): boolean {
  return data.length > 0 && data.replace(TERMINAL_REPORT, "") === "";
}
