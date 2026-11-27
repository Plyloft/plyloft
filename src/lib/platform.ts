// Windows port (W5): which desktop the shell runs on, and the few things that
// differ because of it — the shortcut modifier, how a chord is drawn, and the
// words for the file manager and the machine. One module, so a component asks
// here instead of sniffing the user agent itself.
//
// Detected from the web view, without a plugin: WebView2 reports
// "Windows NT" in its user agent (and "Windows" as its client-hints
// platform); WKWebView says "Macintosh". `navigator.platform` is not read:
// node 21+ reports "Win32" there on a Windows host, and jsdom's user agent
// carries "(win32)" — a test host must never turn into Windows by itself.
// Anything else counts as the Mac, so every existing test keeps its behaviour.
// Pure, so node can test it.

export type Platform = "mac" | "windows";

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string };
}

/** The platform a navigator describes: Windows only on a browser's own
 *  signal, the Mac otherwise. */
export function detectPlatform(nav: NavigatorLike | undefined | null): Platform {
  if (!nav) return "mac";
  if (nav.userAgentData?.platform === "Windows") return "windows";
  return /\bWindows NT\b/.test(nav.userAgent ?? "") ? "windows" : "mac";
}

let detected: Platform | null = null;
let forced: Platform | null = null;

/** The platform the shell is running on. */
export function platform(): Platform {
  if (forced) return forced;
  if (detected === null) {
    detected = detectPlatform(
      typeof navigator === "undefined" ? null : (navigator as NavigatorLike),
    );
  }
  return detected;
}

/** Tests only: pretend to be `p`; `null` goes back to detection. Values a
 *  module computed at load (a hint string) keep what they read then. */
export function setPlatformForTests(p: Platform | null): void {
  forced = p;
}

export function isMac(): boolean {
  return platform() === "mac";
}

export function isWindows(): boolean {
  return platform() === "windows";
}

// ── The shortcut modifier ─────────────────────────────────────────────

/** The modifier keys of a key press. */
export interface ModifierPress {
  metaKey: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Is the platform's shortcut modifier held — ⌘ on the Mac, Ctrl on Windows?
 *  On Windows the Windows key must not be: the shell owns its chords. */
export function mod(e: ModifierPress): boolean {
  return isWindows() ? e.ctrlKey === true && !e.metaKey : e.metaKey;
}

/** The modifier alone — ⌘F, not ⌘⇧F, ⌃⌘F or ⌥⌘F (Ctrl+F on Windows). */
export function modOnly(e: ModifierPress): boolean {
  if (!mod(e) || e.shiftKey || e.altKey) return false;
  // The other of Ctrl/⌘ must not be held either.
  return isWindows() ? !e.metaKey : !e.ctrlKey;
}

// ── Drawing a chord ───────────────────────────────────────────────────

const WINDOWS_MODIFIERS: Record<string, string> = {
  "⌃": "Ctrl",
  "⌘": "Ctrl",
  "⌥": "Alt",
  "⇧": "Shift",
};
// Windows writes them in this order: Ctrl+Alt+Shift+K.
const WINDOWS_ORDER = ["Ctrl", "Alt", "Shift"];

/**
 * A chord as the platform draws it. The Mac's glyphs stay as written
 * (`⌘⇧F`); on Windows each run of glyphs and the key after it becomes
 * `Ctrl+Shift+F`, anywhere in a sentence (`/ or ⌘F` → `/ or Ctrl+F`).
 */
export function formatKeys(keys: string, p: Platform = platform()): string {
  if (p === "mac") return keys;
  let out = "";
  let i = 0;
  const chars = Array.from(keys);
  while (i < chars.length) {
    if (!(chars[i] in WINDOWS_MODIFIERS)) {
      out += chars[i];
      i += 1;
      continue;
    }
    const held = new Set<string>();
    while (i < chars.length && chars[i] in WINDOWS_MODIFIERS) {
      held.add(WINDOWS_MODIFIERS[chars[i]]);
      i += 1;
    }
    const names = WINDOWS_ORDER.filter((m) => held.has(m));
    // The key is what follows, up to a space: `K`, `1–9`, `,`, `Space`.
    let key = "";
    while (i < chars.length && !/\s/.test(chars[i])) {
      key += chars[i];
      i += 1;
    }
    out += [...names, key.length === 1 ? key.toUpperCase() : key].filter(Boolean).join("+");
  }
  return out;
}

// ── Words that name the machine ───────────────────────────────────────

const WORDS = {
  mac: {
    fileManager: "Finder",
    reveal: "Reveal in Finder",
    showIn: "Show in Finder",
    thisMachine: "This Mac",
  },
  windows: {
    fileManager: "File Explorer",
    reveal: "Show in File Explorer",
    showIn: "Show in File Explorer",
    thisMachine: "This PC",
  },
} as const;

export type PlatformWord = keyof (typeof WORDS)["mac"];

/** On Windows, a sentence written for the Mac with the machine renamed:
 *  `this Mac` → `this PC`, `your Mac` → `your PC`, `Other Macs` → `Other PCs`, `per`/`every`/
 *  `each`/`their Mac` → `… PC`, `the Mac that` → `the PC that`, and `macOS` as the
 *  system → `Windows`. The Mac's text comes back as written. */
export function machineWords(text: string, p: Platform = platform()): string {
  if (p === "mac") return text;
  return text
    // `(?! mini)`: a Mac mini is hardware named in the text, not this machine.
    .replace(/\b([Tt])his Mac\b(?! mini)/g, "$1his PC")
    .replace(/\b([Yy])our Mac\b(?! mini)/g, "$1our PC")
    .replace(/\b([Oo])ther Macs\b/g, "$1ther PCs")
    .replace(/\b([Oo])ther Mac\b(?! mini)/g, "$1ther PC")
    .replace(/\b([Pp]er|[Ee]very|[Ee]ach|[Tt]heir|[Aa] personal) Mac\b(?! mini)/g, "$1 PC")
    .replace(/\b([Tt])he Mac that\b/g, "$1he PC that")
    .replace(/\bMac-wide\b/g, "PC-wide")
    .replace(/\bmacOS\b/g, "Windows");
}

/** The platform's word for `w`: `Finder` / `File Explorer`, `This Mac` / `This PC`. */
export function platformWord(w: PlatformWord, p: Platform = platform()): string {
  return WORDS[p][w];
}

// ── Installing a tool ─────────────────────────────────────────────────

/** A tool a hint tells the person to install, where the backend sends no
 *  command of its own. The doctor's rows carry theirs (`doctor::install_cmd`,
 *  the same commands). */
export type InstallableTool = "rg" | "codex" | "bash" | "whisper";

const INSTALL: Record<InstallableTool, Record<Platform, string | null>> = {
  rg: { mac: "brew install ripgrep", windows: "winget install --id BurntSushi.ripgrep.MSVC" },
  codex: {
    mac: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    // OB-2 review: the official installer (native codex.exe, no Node.js).
    windows: "irm https://chatgpt.com/codex/install.ps1 | iex",
  },
  // Windows tiles default to PowerShell 7, which has bracketed paste; there
  // is no bash 5 to install.
  bash: { mac: "brew install bash", windows: null },
  // whisper.cpp has no one-line install on Windows yet.
  whisper: { mac: "brew install whisper.cpp", windows: null },
};

/** The command that installs `tool` here, or null where there is no one-line
 *  install. */
export function installCommand(tool: InstallableTool, p: Platform = platform()): string | null {
  return INSTALL[tool][p];
}

// ── The window ────────────────────────────────────────────────────────

/** The `data-tauri-drag-region` value for a strip that moves the window.
 *  The Mac's overlay title bar has no strip of its own, so the page's top
 *  edge drags it; Windows keeps its native title bar, where a drag region in
 *  the page would only steal text selection and double-click. */
export function windowDragRegion(p: Platform = platform()): "deep" | undefined {
  return p === "mac" ? "deep" : undefined;
}

/** Ctrl+Shift+Q: quit Ply on Windows, where closing the window only hides it
 *  to the tray and there is no app menu with a Quit. Matched on `code`, so it
 *  holds on any keyboard layout. Never on the Mac (⌘Q is the menu's). */
export function isQuitChord(
  e: ModifierPress & { code: string },
  p: Platform = platform(),
): boolean {
  return (
    p === "windows" &&
    e.ctrlKey === true &&
    e.shiftKey === true &&
    !e.altKey &&
    !e.metaKey &&
    e.code === "KeyQ"
  );
}
