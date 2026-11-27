// SL-0 app tester: DOM-level input (untrusted events). Enough for plain
// buttons and fields; drag, native dialogs, terminals' real keys and browser
// shortcuts go through PlyTestHelper's trusted events instead.

import { refFor } from "./tree";

function center(el: Element): { clientX: number; clientY: number } {
  const rect = el.getBoundingClientRect();
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

export function domClick(el: Element): void {
  (el as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const at = center(el);
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, ...at };
  const view = el.ownerDocument.defaultView ?? window;
  const Pointer = (view as typeof window).PointerEvent ?? (view as typeof window).MouseEvent;
  el.dispatchEvent(new Pointer("pointerdown", { ...init, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new (view as typeof window).MouseEvent("mousedown", init));
  if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus();
  el.dispatchEvent(new Pointer("pointerup", { ...init, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new (view as typeof window).MouseEvent("mouseup", init));
  el.dispatchEvent(new (view as typeof window).MouseEvent("click", init));
}

/** Sets a field's value the way React notices (the native setter + `input`). */
function setNativeValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(field) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

export function domType(el: Element, text: string, options: { replace?: boolean }): void {
  const replace = options.replace ?? true;
  (el as HTMLElement).focus?.();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, replace ? text : el.value + text);
    return;
  }
  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find((o) => o.text === text || o.value === text);
    if (!option) throw new Error(`no option "${text}"`);
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const editable = (el as HTMLElement).isContentEditable || el.getAttribute("contenteditable") === "true";
  if (editable) {
    const doc = el.ownerDocument;
    if (replace) doc.execCommand?.("selectAll");
    if (!doc.execCommand?.("insertText", false, text)) {
      if (replace) el.textContent = text;
      else el.textContent = (el.textContent ?? "") + text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
    return;
  }
  throw new Error(`${el.tagName.toLowerCase()} does not take text (use a field, or mode trusted)`);
}

export type Chord = { key: string; code?: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };

const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: " ",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Whether the page runs on macOS: elsewhere (Windows) `cmd` is Ctrl, the
 *  app's own shortcut modifier there, so a walk written on the Mac presses
 *  the same shortcut. */
function isMacPlatform(): boolean {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return /mac/i.test(nav?.platform ?? "") || /Macintosh/.test(nav?.userAgent ?? "");
}

/** `cmd+shift+p` → a chord. Modifiers: cmd/meta, ctrl, alt/option/opt, shift. */
export function parseChord(text: string, mac: boolean = isMacPlatform()): Chord {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("empty key chord");
  const chord: Chord = { key: "", meta: false, ctrl: false, alt: false, shift: false };
  for (const part of parts.slice(0, -1)) {
    const mod = part.toLowerCase();
    if (mod === "cmd" || mod === "command") {
      if (mac) chord.meta = true;
      else chord.ctrl = true;
    } else if (mod === "meta") chord.meta = true;
    else if (mod === "ctrl" || mod === "control") chord.ctrl = true;
    else if (mod === "alt" || mod === "option" || mod === "opt") chord.alt = true;
    else if (mod === "shift") chord.shift = true;
    else throw new Error(`unknown modifier "${part}"`);
  }
  const last = parts[parts.length - 1];
  chord.key = KEY_NAMES[last.toLowerCase()] ?? (last.length === 1 ? last : last[0].toUpperCase() + last.slice(1));
  return chord;
}

const TERMINAL_KEYS: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  " ": " ",
};

/** What a terminal receives for a chord, as xterm would send it from the
 *  keyboard: named keys as their escape sequences, ctrl+letter as a control
 *  character. DOM key events never reach a terminal (xterm reads keyCode). */
export function terminalSequence(chord: Chord): string {
  if (chord.shift && chord.key === "Tab") return "\x1b[Z";
  if (chord.ctrl && chord.key.length === 1 && /[a-z]/i.test(chord.key)) {
    return String.fromCharCode(chord.key.toLowerCase().charCodeAt(0) - 96);
  }
  if (chord.meta || chord.ctrl) throw new Error("a terminal takes cmd chords from the app, not as input: use mode trusted");
  const named = TERMINAL_KEYS[chord.key];
  if (named !== undefined) return (chord.alt ? "\x1b" : "") + named;
  if (chord.key.length === 1) return (chord.alt ? "\x1b" : "") + (chord.shift ? chord.key.toUpperCase() : chord.key);
  throw new Error(`no terminal sequence for "${chord.key}"`);
}

export function domKey(target: Element, chord: Chord): void {
  const init = {
    key: chord.key,
    metaKey: chord.meta,
    ctrlKey: chord.ctrl,
    altKey: chord.alt,
    shiftKey: chord.shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

// ── Hits: what the page actually received ────────────────────────────────

export type Hit = { seq: number; type: string; trusted: boolean; ref: string; key?: string; at: number };

const HIT_TYPES = ["pointerdown", "click", "keydown", "dragstart", "drop", "input", "contextmenu", "wheel"];
const HIT_MAX = 200;
const hits: { hit: Hit; target: Element }[] = [];
let hitSeq = 0;
let hitsInstalled = false;

export function installHits(win: Window): void {
  if (hitsInstalled) return;
  hitsInstalled = true;
  for (const type of HIT_TYPES) {
    win.addEventListener(
      type,
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        hitSeq += 1;
        const hit: Hit = {
          seq: hitSeq,
          type,
          trusted: event.isTrusted,
          ref: refFor(target),
          at: Date.now(),
        };
        if (event instanceof KeyboardEvent) hit.key = event.key;
        hits.push({ hit, target });
        if (hits.length > HIT_MAX) hits.shift();
      },
      { capture: true },
    );
  }
}

export function hitMark(): number {
  return hitSeq;
}

/** Hits after `after`; `landed` says whether a trusted one reached `within`. */
export function hitsSince(after: number, within: Element | null): { hits: Hit[]; landed: boolean | null } {
  const recent = hits.filter((h) => h.hit.seq > after);
  const landed = within
    ? recent.some((h) => h.hit.trusted && (h.target === within || within.contains(h.target)))
    : null;
  return { hits: recent.map((h) => h.hit), landed };
}
