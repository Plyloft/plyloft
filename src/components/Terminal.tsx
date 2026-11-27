import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ImageAddon } from "@xterm/addon-image";
import { WebglAddon } from "@xterm/addon-webgl";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { info as logInfo } from "@tauri-apps/plugin-log";
import "@xterm/xterm/css/xterm.css";
import {
  ptySpawn,
  ptyWrite,
  tileScreenBlock,
  ptyResize,
  ptyKill,
  onPtyData,
  onPtyExit,
  ptyPromptIdle,
  ptyPromptState,
  type TryTargetArg,
} from "../ipc";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { zoomKeyAction } from "../lib/textSize";
import { textSizeNow, useTextSize, zoomText } from "../store/textZoomStore";
import { REFIT_AFTER_SIZE_MS, followScreenReader, trailing } from "./terminalReading";
import { useTiles } from "../store/tileStore";
import { pendingCliRenameOf } from "../store/tileTitles";
import { passNameToCli } from "../lib/cliRename";
import { cliFreshCheck, cliStartVerdict, type TileCli } from "../lib/ptySpawnIpc";
import { codexStartWaitText } from "../lib/codexUpdateNotice";
import { useDoctor } from "../store/doctorStore";
import { decodeCliUnavailable } from "../lib/cliUnavailable";
import { newPtyId, ptyEventGate } from "../lib/earlyPtyEvents";
import {
  exitAsksBackend,
  verdictStartFailure,
  resumesConversation,
  setsUpScreen,
  spawnStartFailure,
  terminalWayOn,
  type StartFailure,
} from "../lib/startFailure";
import { useWorkspaces } from "../store/workspaceStore";
import {
  TERMINAL_DROP_KINDS,
  acceptsAttr,
  acceptsDrag,
  dragPayloadFor,
} from "../lib/dropGuard";
import { addingWords, dragFileCount, dropHintWords } from "../lib/terminalDropWords";
import { shellQuoteJoin } from "../lib/shellQuote";
import { saveDroppedFile, toastDropRefusals, type DropRefusal } from "../lib/droppedFile";
import {
  codexComposerRows,
  matchesCodexComposerIdle,
  promptBoxMatcherFor,
  RESIZE_REDRAW_MS,
  settledTail,
  promptInputEmpty,
  inputRowHasDraft,
  cliVendorOf,
  decisionMatcherFor,
  codexComposerHoldsPaste,
  codexOverlayOpen,
  choiceMenuInView,
} from "../lib/attention";
import { useCompare } from "../store/compareStore";
import { comparePassNow } from "../store/compareActions";
import { effectiveCenterMode, useUi } from "../store/uiStore";
import { codexScreenFacts, liveScreenFacts, noteTileInput, registerTileScreen, screenShape, workStamp } from "../lib/tileScreen";
import { inputRowCells } from "../lib/inputRow";
import { DictationController } from "../lib/dictationController";
import {
  FRESH_SCAN_MEMORY,
  READINESS_SCAN_MS,
  READY_QUIET_MS,
  createScanScheduler,
  foldScan,
  lastLayoutRefitAt,
  memberInput,
  noteLayoutRefit,
  readinessProbe,
  refitRebaselining,
  rebaselineEndsAt,
  questionGoneWhileWorking,
  RESIZE_SETTLE_MS,
  readinessRecheckMs,
  shellVerdict,
  type ReadinessKind,
} from "../lib/tileHeaderStatus";
import { createWriteBatcher } from "../lib/xtermBatch";
import {
  readinessNotedOnScreenChange,
  readinessNotesDraw,
  screenChangeTracker,
  stampsOnScreenChange,
  watchContentScroll,
} from "../lib/screenChange";
import { isWindows } from "../lib/platform";
import { guardPty, isPtyClosing, type GuardedPty } from "../lib/ptyGone";
import { handleAltArrowKey, handleTerminalClipboardKey, terminalKeyAction } from "../lib/terminalKeys";
import { terminalFormShortcut } from "../lib/shortcuts";
import { installTerminalPaste } from "../lib/terminalPaste";
import { installWideChars } from "../lib/xtermUnicode";
import { xtermThemeFor } from "../lib/xtermTheme";
import { isDarkTerminalTheme, minimumContrastFor, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import {
  disposeBlock,
  shellTileTerminalOptions,
  terminalScrollback,
  trackCommandBlocks,
  blockScrollLine,
  type CommandBlock,
} from "../lib/commandBlocks";
import { Icon } from "./ux";
import { installTerminalLinks } from "./terminalLinkProvider";
import { terminalFailureLines } from "../lib/plainError";
import "./terminals.css";

// v0.10.0 Command Blocks: one shell command from prompt → exec → exit, read
// from the shell's OSC 133 marks by lib/commandBlocks.
const MAX_COMMAND_BLOCKS = 200;

// v1.64.0: xterm theming centralized in lib/xtermTheme (recessed canvas +
// accent-following cursor), shared with IntakeConversation / AgentRunView.

/** D4: a drop hint with no dragover for this long is a drag that left
 *  without saying so. Dragover repeats while a drag is over, but a still
 *  pointer can leave gaps of ~550 ms; well past that, it is gone. */
export const DROP_HINT_STALE_MS = 1000;

/** SL-0 app tester: the page's terminal registry (`src/testBridge/terminals.ts`). */

function testTerminals(): Set<unknown> | undefined {
  return (window as { __plyTestTerminals?: Set<unknown> }).__plyTestTerminals;
}

type Props = {
  cmd: string;
  args?: string[];
  cwd?: string;
  onExit?: (code: number | null) => void;
  /** v0.5.0: report the spawned PTY id once available (for tile-grid bookkeeping). */
  onPtyId?: (ptyId: string) => void;
  /**
   * v1.63.0: which workspace this terminal belongs to. When set, the WebGL
   * renderer addon is loaded only while that workspace is active — browsers
   * cap WebGL contexts (~16) and the warmed-host pattern keeps up to 8
   * workspaces' terminals mounted, so hidden terminals must stay on the DOM
   * renderer. When omitted, WebGL loads unconditionally (single-instance
   * callers).
   */
  workspaceId?: string;
  /**
   * #47: Ply's hold-Space dictation, for a Codex TUI or shell tile only —
   * never a Claude tile, which has Claude Code's own `/voice`. Read once
   * when the terminal is created; a tile's kind never changes.
   */
  dictation?: { tileId: string; mode: "codex-tui" | "shell" };
  /**
   * GH #70: scan this tile's readiness for the header chip ("Ready", or
   * "Working for Ns" for an agent and "Running" for a shell). Read once
   * when the terminal is created.
   */
  readiness?: ReadinessKind;
  /** Try it (TI-2): spawn this shell as that card copy's Try session. Read
   *  once when the terminal is created. */
  tryTarget?: TryTargetArg;
  /** 1.176.0 R3: a Claude or Codex tile — checked before its spawn
   *  (`cliFreshCheck`) and spawned as that CLI. Read once when the terminal
   *  is created; a tile's kind never changes. */
  cli?: TileCli;
  /** 1.179.0 (C2): the Claude account to spawn a Claude tile on (an
   *  `ai_accounts_list` id); absent: the backend's choice. Read once when
   *  the terminal is created, like `tryTarget`. */
  account?: string;
  /** 1.176.0 R7: a Claude or Codex tile whose CLI didn't start (the rule in
   *  `lib/startFailure.ts`), told before `onExit`. */
  onStartFailed?: (failure: StartFailure) => void;
  /** 1.177.0 Compare: a Claude or Codex tile's id — its screen can be read
   *  on demand (`lib/tileScreen`) while this terminal is mounted. */
  screenTileId?: string;
};

/** The visible screen's rows (the bottom page, whatever the user scrolled
 *  to), as plain text. */
function screenRows(term: XTerm): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let i = buf.baseY; i < buf.baseY + term.rows; i++) {
    const line = buf.getLine(i);
    rows.push(line ? line.translateToString(true) : "");
  }
  return rows;
}

/** GH #67: a refused dictation insert goes to Ply.log with the rows judged,
 *  one per line behind a `|` so leading whitespace stays visible. A logging
 *  failure never breaks dictation. */
function logDictationRefusal(message: string, rows: readonly string[]): void {
  const body = rows.map((row) => `  |${row}`).join("\n");
  logInfo(`${message}\n${body}`).catch(() => {});
}

export function Terminal({
  cmd,
  args = [],
  cwd,
  onExit,
  onPtyId,
  workspaceId,
  dictation: dictationTarget,
  readiness: readinessKind,
  tryTarget,
  cli,
  account,
  onStartFailed,
  screenTileId,
}: Props) {
  // R3 review 8: Claude's and Codex's screen rules follow the tile's kind,
  // never its command — a shell whose program is named `claude` is a shell.
  const vendorCmd = cli ?? "";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // D4 (1.172.2): what a drop will do while a file is dragged over this
  // terminal, and "Adding …" from the drop until the path is typed.
  const [dropHint, setDropHint] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const hintStaleRef = useRef<number | null>(null);
  const addingSeqRef = useRef(0);
  const [searchValue, setSearchValue] = useState("");
  const theme = useColorScheme();
  // v1.64.0: accent preset retints the cursor (see ACCENT_CURSOR).
  const accent = useSettings((s) => s.settings.appearance.accent);
  // v1.63.0: primitive selector (PATTERNS-safe) — true when this terminal's
  // workspace is the active one, or when no workspaceId was provided.
  const wsActive = useWorkspaces((s) =>
    workspaceId ? s.activeId === workspaceId : true,
  );
  // Mirrors termRef as state so the WebGL effect re-binds when the terminal
  // instance is recreated (cmd/cwd change re-runs the main effect).
  const [termInst, setTermInst] = useState<XTerm | null>(null);
  // Set by the main effect once the PTY is up: refits the tile when the
  // renderer's cell width changed under it (the WebGL addon floors the
  // device char width, the DOM renderer does not: 7.5 against 7.83 px at
  // 13 px on a Retina screen). Without it the first fit, made with the DOM
  // renderer's cells, stayed until a layout change: the 2026-10-20 Mac walk's
  // first shell tile got 120 columns where 125 fit, ~40 px short.
  const refitOnRendererChange = useRef<(() => void) | null>(null);
  // QoL 1.168 (D3): Settings › Scrollback, on open tiles too — xterm takes
  // a new scrollback live (a smaller one drops the oldest lines).
  const scrollbackLines = useSettings((s) => s.settings.terminals.scrollbackLines);
  useEffect(() => {
    if (!termInst) return;
    const lines = terminalScrollback(scrollbackLines);
    if (termInst.options.scrollback !== lines) termInst.options.scrollback = lines;
  }, [termInst, scrollbackLines]);
  // QoL 1.168 (block 10, A7): Settings › Terminal text size (⌘= / ⌘− / ⌘0
  // in the tile), on open tiles too. Challenger item 3: the size is drawn at
  // once, the tile refits (and the shell gets the columns that now fit) once
  // the size rests, and a hidden workspace's tiles take it when shown.
  const textPx = useTextSize("terminals");
  const sizeRefit = useRef<ReturnType<typeof trailing> | null>(null);
  useEffect(() => {
    if (!termInst || !wsActive) return;
    if (termInst.options.fontSize === textPx) return;
    termInst.options.fontSize = textPx;
    sizeRefit.current ??= trailing(() => refitOnRendererChange.current?.(), REFIT_AFTER_SIZE_MS);
    sizeRefit.current.run();
  }, [termInst, textPx, wsActive]);
  useEffect(() => () => sizeRefit.current?.cancel(), []);
  const commandBlocksEnabled = useSettings(
    (s) => s.settings.behavior.commandBlocksEnabled,
  );
  const [blocks, setBlocks] = useState<CommandBlock[]>([]);
  const [blocksOpen, setBlocksOpen] = useState(false);
  const blocksRef = useRef<CommandBlock[]>([]);
  blocksRef.current = blocks;

  useEffect(() => {
    if (!containerRef.current) return;
    const initialTheme = xtermThemeFor(theme, accent);
    const term = new XTerm({
      ...shellTileTerminalOptions(initialTheme, useSettings.getState().settings.terminals.scrollbackLines, {
        textSize: textSizeNow("terminals"),
      }),
      // 1.168.1 (C1): what an agent drew for the other theme stays legible.
      minimumContrastRatio: minimumContrastFor(cliVendorOf(vendorCmd)),
    });
    termRef.current = term;
    // 1.168.1 (#13): wide emoji take two cells, as Claude Code and Codex
    // assume (`allowProposedApi` is in `shellTileTerminalOptions`).
    installWideChars(term);
    // The program's redraw after a theme report is a resize's, not work: the
    // same rebaseline (Challenger, C1).
    themeReportsRef.current = trackThemeReports(term, isDarkTerminalTheme(theme), {
      onReport: () => {
        rebaselineUntil = Date.now() + RESIZE_REBASELINE_MS;
        if (ptyId) useTiles.getState().noteResize(ptyId);
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchAddonRef.current = search;
    // v0.9.0 C2: inline image preview via sixel/iTerm graphics protocols.
    // Conservative size cap so a runaway image stream doesn't bloat memory.
    const image = new ImageAddon({
      sixelSupport: true,
      sixelSizeLimit: 25_000_000,
      iipSupport: true,
      iipSizeLimit: 25_000_000,
    });
    term.loadAddon(image);
    term.open(containerRef.current);
    // SL-0 app tester: test-bridge builds read terminals from the buffer
    // (WebGL leaves no text in the DOM). Dropped from every other build.
    if (__PLY_TEST_BRIDGE__) testTerminals()?.add(term);
    // Windows (W4): right-click copies a selection or pastes, as in
    // Windows Terminal (nothing on the Mac). A shell tile only (not Claude
    // or Codex): a paste of several lines without bracketed paste asks
    // first (lib/terminalPaste).
    // QoL 1.168 (block 10; Challenger item 6): Screen reader support, on
    // the tile that has the keyboard only.
    const stopReader = followScreenReader(term);
    const undoPaste = installTerminalPaste(containerRef.current, term, {
      shell: readinessKind === "shell",
    });
    // QoL 1.168 (block 4, D6): web addresses and the workspace's file paths
    // in the output are links (⌘-click / Ctrl-click). A tile only: it knows
    // its workspace and folder.
    const links = workspaceId && cwd ? installTerminalLinks(term, () => ({ workspaceId, cwd })) : null;
    fit.fit();
    setTermInst(term);

    // v1.63.0: batch term.write behind rAF (+ hidden-window fallback) so
    // multi-event bursts collapse into one parse/render pass per frame.
    // GH #70: the readiness scan is scheduled once xterm has parsed the
    // batch, so it never reads a screen the last output has not reached.
    // Windows (group B walk, tiles' parity with the Builder): ConPTY output
    // that leaves the screen as it was — Claude's modes re-sent on a focus
    // change or mouse report, the repaint of a same-size resize — is not the
    // session working. There the tile's output stamp (silence → waiting, the
    // dot, the Inbox rows) moves once xterm has drawn a batch and the screen
    // changed (`lib/screenChange.ts`); the Mac stamps on arrival, as before.
    const byScreen = stampsOnScreenChange(isWindows());
    const readinessByScreen = readinessNotedOnScreenChange(isWindows(), readinessKind);
    const screenWatch = screenChangeTracker();
    // 1.177.0 Compare (walk round 4): the quiet clock Compare reads counts
    // only output that changed what the tile shows and was not its own
    // resize redraw — a focus change's re-sent modes, a repaint of the same
    // screen, never restart it. Claude and Codex tiles only.
    const compareWatch = screenTileId && cliVendorOf(vendorCmd) ? screenChangeTracker() : null;
    // Scrolled while a batch was parsed: real output even when the screen it
    // leaves reads as before (the same line printed again and again).
    // Reset as each batch is handed to xterm, so a wheel scroll between
    // batches is not counted; xterm parses batches in order.
    let scrolledInBatch = false;
    // Not a buffer switch's event (xterm 6): `watchContentScroll`.
    const scrollWatch = byScreen ? watchContentScroll(term, () => (scrolledInBatch = true)) : null;
    const batcher = createWriteBatcher((data) => {
      scrolledInBatch = false;
      term.write(data, () => {
        const scrolled = scrolledInBatch;
        scrolledInBatch = false;
        if (compareWatch && ptyId) {
          const drawnAt = Date.now();
          const changed = compareWatch.changed(screenRows(term).join("\n"), scrolled);
          lastWorkStamp = workStamp(lastWorkStamp, drawnAt, changed, rebaselineUntil, sizeChangedAt);
          // Round 8: drawn and changed, redraws included (Compare's echo check).
          if (changed) lastDrawnStamp = drawnAt;
        }
        if (byScreen && ptyId && screenWatch.changed(screenRows(term).join("\n"), scrolled)) {
          useTiles.getState().markOutput(ptyId);
          // A shell's readiness counts the same output: PowerShell under
          // ConPTY has no PTY probe and no command blocks, so output quiet
          // decides, and a repaint that leaves the prompt as it was must not
          // read as a command running.
          // Not the app's own refit: its re-wrap and ConPTY's repaint of it
          // are no command (`readinessNotesDraw`).
          if (readinessByScreen && readinessNotesDraw(true, Date.now(), rebaselineUntil)) {
            noteReadinessData();
          }
        }
        scheduleReadinessScan();
      });
    });

    // v0.10.0 Command Blocks: the OSC 133 handler is registered
    // unconditionally so toggling the setting doesn't tear down the PTY. The
    // indicator UI keys off `commandBlocksEnabled`; without the shell
    // integration snippet the marks never arrive, so this is harmless when
    // the user hasn't opted in. See lib/commandBlocks for what each mark does.
    const commandBlocks = trackCommandBlocks(term, (closed) => {
      setBlocks((prev) => {
        const next = [...prev, closed];
        if (next.length <= MAX_COMMAND_BLOCKS) return next;
        const dropped = next.slice(0, next.length - MAX_COMMAND_BLOCKS);
        for (const b of dropped) disposeBlock(b);
        return next.slice(next.length - MAX_COMMAND_BLOCKS);
      });
    });

    let ptyId: string | null = null;
    let pty: GuardedPty | null = null;

    // #47: dictation. Space is Ply's only while this tile's prompt is idle:
    // the Codex composer is what the screen shows waiting, or the shell
    // itself holds the terminal's foreground with its line editor active —
    // a positive prompt signal, so neither a command nor a builtin `read`
    // waiting for input qualifies.
    // `commandBlocks.open()` is an OSC 133 command still running (with the integration
    // snippet); the alternate screen is a full-screen program. A shell must
    // also have bracketed paste on: the transcript goes in as a paste, which
    // a line editor inserts literally even in vi command mode, where typed
    // characters would run as editing commands. zsh (macOS default), bash
    // 5.1+ and fish enable it; macOS /bin/bash 3.2 does not and gets none —
    // GH #68: a held Space there says so once (`lacksBracketedPaste`), and
    // the doctor row "Dictation in shell tiles" gives the same advice.
    let shellAtPrompt = false;
    const shellAtLineEditor = () =>
      commandBlocks.open() === null && term.buffer.active.type === "normal";
    const shellCanTakeText = () =>
      term.modes.bracketedPasteMode && shellAtLineEditor();
    const dictation = dictationTarget
      ? new DictationController({
          tileId: dictationTarget.tileId,
          mode: dictationTarget.mode,
          isIdle: () => {
            if (!ptyId) return false;
            if (dictationTarget.mode === "codex-tui") {
              // Not `matchesCodexTurnIdle`: dictation is the member's own
              // words into their own draft, so a `!` draft does not stop it.
              return matchesCodexComposerIdle(settledTail(screenRows(term), 20).join("\n"));
            }
            return shellAtPrompt && shellCanTakeText();
          },
          // Re-checked as the text lands: for a shell, ask the PTY afresh
          // rather than trust the last scan, since a program started during
          // transcription would take the text as keystrokes.
          // GH #67: a refusal logs what it judged, so a false negative can be
          // read back from Ply.log.
          canInsert: async () => {
            const id = ptyId;
            if (!id) return false;
            const tileId = dictationTarget.tileId;
            if (dictationTarget.mode === "codex-tui") {
              const tail = settledTail(screenRows(term), 20).join("\n");
              if (matchesCodexComposerIdle(tail)) return true;
              logDictationRefusal(
                `dictation: composer not idle for tile ${tileId}`,
                codexComposerRows(tail),
              );
              return false;
            }
            const before = shellCanTakeText();
            const promptIdle = before
              ? await ptyPromptIdle(id).catch(() => "unknown (IPC failed)")
              : "not asked";
            if (promptIdle === true && ptyId === id && shellCanTakeText()) return true;
            logDictationRefusal(
              `dictation: shell not at its prompt for tile ${tileId} ` +
                `(bracketed paste ${term.modes.bracketedPasteMode}, ` +
                `command running ${commandBlocks.open() !== null}, ` +
                `screen ${term.buffer.active.type}, prompt idle ${promptIdle})`,
              settledTail(screenRows(term), 12),
            );
            return false;
          },
          lacksBracketedPaste: () =>
            dictationTarget.mode === "shell" &&
            ptyId !== null &&
            shellAtPrompt &&
            !term.modes.bracketedPasteMode &&
            shellAtLineEditor(),
          emitSpace: () => term.input(" ", true),
          // A bracketed paste through the tile's own input path, for the
          // Codex TUI and a shell alike: literal text, never keystrokes that
          // an editor binding could act on, and never an Enter.
          insertText: (text) => term.paste(text),
        })
      : null;
    const onDictationBlur = () => dictation?.blur();
    term.textarea?.addEventListener("blur", onDictationBlur);

    // Intercept Cmd-F before xterm sends ^F to the PTY. Returning false from
    // attachCustomKeyEventHandler tells xterm to ignore the event entirely
    // (xterm's own keydown listener returns early; it does not cancel it).
    // Windows (W5): Ctrl for ⌘, and Ctrl+C copies a selection — see
    // lib/terminalKeys.ts for which keys stay the shell's.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // 1.174.0 E5 (Windows): a Plyloft key in its terminal form
      // (Ctrl+Shift+K, Ctrl+Alt+T…) is the app's — App.tsx answers it in the
      // capture phase; xterm never sends it on as a control byte. Plain Ctrl
      // letters stay the program's. Never on the Mac.
      // 1.177.0 (N3): Compare's chord is the app's only while Compare is on
      // here; off, Ctrl+Shift+Y stays the program's as before.
      const formId = terminalFormShortcut(e);
      // 1.179.0: with two pairs, only inside a paired place (the tile with
      // the keyboard is this one); outside both it stays the program's.
      if (formId && (formId !== "comparePass" ||
          (workspaceId &&
            useCompare.getState().byWorkspace[workspaceId]?.on &&
            effectiveCenterMode(useUi.getState().centerMode, workspaceId) === "terminals" &&
            comparePassNow(workspaceId).swallow))) {
        return false;
      }
      const action = terminalKeyAction(e, term.hasSelection());
      if (action === "find") {
        if (e.type === "keydown") {
          setSearchOpen(true);
          // Defer focus until the input mounts.
          requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          });
        }
        return false;
      }
      // ⌘V (Mac), Ctrl+V and Ctrl+Shift+V (Windows): kept from xterm (on
      // Windows it would send ^V) with no preventDefault — the web view's
      // own paste then fires a paste event on xterm's textarea and xterm's
      // paste listener inserts the text, bracketed when the app asked for
      // it: exactly one insertion path. Until this fix the tile cancelled
      // that event (v1.25.1, against a double paste) and read
      // navigator.clipboard instead, which made WebKit ask for a click on
      // its "Paste" callout whenever another app had written the clipboard.
      // Copy keys (Windows) write the selection. lib/terminalKeys.ts.
      if (handleTerminalClipboardKey(e, term)) return false;
      // QoL 1.168 (block 10, A7): ⌘= / ⌘− / ⌘0 (Ctrl on Windows) size
      // every terminal's text; the shell never sees them.
      const zoom = zoomKeyAction(e);
      if (zoom) {
        if (e.type === "keydown") {
          e.preventDefault();
          zoomText("terminals", zoom);
        }
        return false;
      }
      if (dictation?.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      // 1.169.0 (B1): ⌥←/⌥→ (Alt+arrows on Windows) still move a word, as
      // under xterm 5 (lib/terminalKeys.ts).
      if (handleAltArrowKey(e, term)) return false;
      return true;
    });

    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let dataDisposable: ReturnType<typeof term.onData> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let cancelled = false;

    // v1.34.0 "wants you": debounced prompt-box scan. The PTY data event
    // stamps lastOutputAt (silence -> wants-you); this timer fires ~700ms
    // after output settles and reads the terminal tail to refine the label
    // to "asking you" when it looks like Claude's idle input box. 700ms <<
    // the 10s silence threshold so promptBoxIdle is fresh by the time a
    // tile becomes wants-you. See src/lib/attention.ts.
    let promptBoxTimer: ReturnType<typeof setTimeout> | null = null;
    // v1.105.0: Codex TUI tiles get their own matcher; shells never match.
    const matchesPromptBox = promptBoxMatcherFor(vendorCmd);
    const vendor = cliVendorOf(vendorCmd);
    // 1.177.0 Compare: the screen now, read on demand (never stored).
    let lastDataStamp = 0;
    // Review H1: the last output that was not this tile's own resize redraw.
    let lastWorkStamp = 0;
    // Round 8 (review M1): the last batch xterm drew that changed the screen.
    let lastDrawnStamp = 0;
    const unregisterScreen =
      screenTileId && vendor
        ? registerTileScreen(screenTileId, () => {
            if (!ptyId) return null;
            const rows = screenRows(term);
            return {
              ...liveScreenFacts(vendor, rows, inputRowCells(term, vendor)),
              overlay: vendor === "codex" && codexOverlayOpen(settledTail(rows, 20).join("\n")),
              lastOutputAt: lastDataStamp > 0 ? lastDataStamp : null,
              lastWorkOutputAt: lastWorkStamp > 0 ? lastWorkStamp : null,
              lastDrawnAt: lastDrawnStamp > 0 ? lastDrawnStamp : null,
              lastInputAt,
              holds: (text) => (vendor === "codex" ? codexComposerHoldsPaste(settledTail(rows, 20).join("\n"), text) : null),
              shape: screenShape(rows),
            };
          }, () => (lastDataStamp > 0 ? lastDataStamp : null), () => {
            // Round 8 (review M2): the member's text written straight to the PTY.
            lastInputAt = Date.now();
          })
        : null;
    const PROMPT_BOX_SETTLE_MS = 700;
    const PROMPT_BOX_TAIL_ROWS = 20;
    const schedulePromptBoxScan = () => {
      if (promptBoxTimer) clearTimeout(promptBoxTimer);
      promptBoxTimer = setTimeout(() => {
        promptBoxTimer = null;
        if (!ptyId) return;
        // #47: the settled tail, not the last raw rows — an inline TUI
        // (Codex) starts at the top of a fresh screen, below which a tall
        // tile is blank.
        const rows = settledTail(screenRows(term), PROMPT_BOX_TAIL_ROWS);
        const tail = rows.join("\n");
        const idleNow = matchesPromptBox(tail);
        const emptyNow = promptInputEmpty(vendorCmd, tail);
        // QoL 1.168 (walk lane 1): a draft is text the member typed, drawn
        // plain; the CLI's dim placeholder or suggestion is none (closing
        // the tile then asks nothing). Text alone is the answer where the
        // cells cannot be read.
        const cells = vendor ? inputRowCells(term, vendor) : null;
        const draftNow = emptyNow ? false : cells ? inputRowHasDraft(cells) : true;
        useTiles.getState().markPromptBox(ptyId, idleNow, emptyNow, draftNow);
        // 1.177.0 Compare: a question or a numbered menu in view (the header
        // may read "Your turn"), kept on the tile for the relay bar's line.
        if (vendor) useTiles.getState().markMenu(ptyId, decisionMatcherFor(vendor)(tail) || choiceMenuInView(vendor, tail));
        // 1.177.0 Compare: a Codex tile whose buffer is back at its start
        // screen after a turn was on it started a new conversation (`/new`).
        if (vendor === "codex") {
          // On either buffer (Codex 0.171+ lives on the alternate screen;
          // walk, Windows, 2026-11-25), and not once the flag is set
          // (nothing can change it).
          const buf = term.buffer.active;
          const flagged = Object.values(useTiles.getState().byWorkspace).some((w) =>
            w.tiles.some((t) => t.ptyId === ptyId && t.newConversation === true),
          );
          if (!flagged) {
            const f = codexScreenFacts(buf.baseY + term.rows, (i) => buf.getLine(i)?.translateToString(true) ?? "");
            useTiles.getState().markCodexScreen(ptyId, f.turn, f.start);
          }
        }
        // Terminals block P2: the member's name, passed to the CLI as
        // `/rename` — only at an idle prompt with nothing typed, never over
        // a draft (owner, 2026-10-21).
        // Terminals block P3: what the session waits on the member for — a
        // question or permission (the Builder's matchers), the folder-trust
        // question, the usage limit, the bypass warning (the Builder's
        // backend rules, read on the drawn screen).
        if (vendor) {
          const id = ptyId;
          const decision = decisionMatcherFor(vendor)(tail);
          const screen = settledTail(screenRows(term), 40).join("\n");
          void tileScreenBlock(screen)
            .then((block) => {
              if (ptyId !== id) return;
              useTiles
                .getState()
                .markQuestion(id, block ? block.kind : decision ? "decision" : null, block?.resetsAt ?? null);
            })
            .catch(() => useTiles.getState().markQuestion(id, decision ? "decision" : null));
        }
        if (idleNow && emptyNow) {
          const name = useTiles.getState().takePendingCliRename(ptyId);
          if (name) {
            // Round 8 (review M2): the member's rename typed for them is their input.
            lastInputAt = Date.now();
            void passNameToCli(ptyId, name).finally(() => {
              lastInputAt = Date.now();
            });
          }
        }
        if (dictationTarget?.mode === "shell") {
          const id = ptyId;
          ptyPromptIdle(id)
            .then((idle) => {
              if (ptyId === id) shellAtPrompt = idle === true;
            })
            .catch(() => {
              shellAtPrompt = false;
            });
        }
      }, PROMPT_BOX_SETTLE_MS);
    };
    // Terminals block P2 walk: a name the member has just given is typed as
    // soon as the prompt is idle and empty — not at the session's next
    // output, which could be after a `/clear` (and name the wrong
    // conversation). Not idle now: the next settled scan types it.
    const unsubPendingRename = useTiles.subscribe((s, prev) => {
      if (!ptyId || !vendor) return;
      const name = pendingCliRenameOf(s.byWorkspace, ptyId);
      if (name && name !== pendingCliRenameOf(prev.byWorkspace, ptyId)) schedulePromptBoxScan();
    });

    // GH #70: the header chip's readiness scan. Throttled rather than
    // debounced, so a screen that never stops redrawing (Codex's composer
    // animation, a spinner) is still judged. What counts as activity is the
    // prompt matcher's verdict and the text above the prompt, not the bytes:
    // an idle redraw leaves both alone. A shell asks the PTY who holds the
    // foreground and whether the shell is editing its prompt line, with an
    // open OSC 133 command block as the busy signal where the PTY cannot
    // answer at all; when the verdict is unknown (a builtin `read`, a shell
    // with no line editor), any output counts. See lib/tileHeaderStatus.
    /** A resize reflows the screen; the redraw that follows is not activity
     *  — the same window the needs-you silence clock ignores it for. */
    const RESIZE_REBASELINE_MS = RESIZE_REDRAW_MS;
    let readinessSeq = 0;
    /** Output this soon after the user's own input is its echo (a shell's
     *  line editor, Claude's box redrawing a draft), not activity. */
    const INPUT_ECHO_MS = 250;
    let lastInputAt = 0;
    let lastDataAt = 0;
    let dataSinceScan = false;
    // Activity starts at the spawn, not at 0: a first scan that cannot say
    // (a shell with no line editor) must not read Ready before the tile has
    // been quiet for the window.
    let scanMemory = { ...FRESH_SCAN_MEMORY, activityAt: Date.now() };
    let rebaselineUntil = 0;
    /** When this tile's own columns or rows last changed (refitRebaselining). */
    let sizeChangedAt = 0;
    /** When this tile last refitted while its header read Ready: its late
     *  repaint settles (B3 walk). 0: never, or it was working. */
    let refitAt = 0;
    const scanReadiness = async () => {
      const id = ptyId;
      if (!id || !readinessKind) return;
      const seq = ++readinessSeq;
      const sawData = dataSinceScan;
      dataSinceScan = false;
      // No output since the last scan (a recheck, or a late parse): the
      // scan's own time stamps whatever it counts.
      const dataAt = sawData ? lastDataAt : Date.now();
      let idle: boolean | null;
      let status: string | null = null;
      let signature = "";
      // QoL 1.168 (M2, M3): a permission prompt, background work in the footer.
      let waiting = false;
      let background = false;
      let running = false;
      if (readinessKind === "shell") {
        const state = await ptyPromptState(id).catch(() => null);
        if (seq !== readinessSeq || ptyId !== id) return;
        idle = shellVerdict(state, commandBlocks.open() !== null);
      } else {
        ({ idle, status, signature, waiting, background, running } = readinessProbe(readinessKind, screenRows(term)));
      }
      const scannedAt = Date.now();
      scanMemory = foldScan(scanMemory, {
        idle,
        status,
        signature,
        sawData,
        dataAt,
        rebaselining: refitRebaselining({
          now: scannedAt,
          ownUntil: rebaselineUntil,
          sizeChangedAt,
          layoutAt: lastLayoutRefitAt(),
          windowMs: RESIZE_REBASELINE_MS,
        }),
        settling: refitAt > 0 && scannedAt < refitAt + RESIZE_SETTLE_MS,
        now: scannedAt,
        // B3: a Claude or Codex screen's verdict, not output quiet — but a
        // turn it shows running still counts its output.
        screen: readinessKind !== "shell",
        running,
      });
      const verdict = scanMemory.lastVerdict ?? null;
      useTiles.getState().markReadiness(id, readinessKind, {
        lastOutputAt: scanMemory.activityAt,
        matcherIdle: verdict,
        waiting,
        background,
        running,
      });
      // 1.177.1: a menu the member answered gives way to the work it started
      // (only the "decision" kind: a trust, usage-limit or Bypass screen is
      // read again by the settled scan).
      if (readinessKind !== "shell" && questionGoneWhileWorking({ running, waiting })) {
        const t = Object.values(useTiles.getState().byWorkspace)
          .flatMap((w) => w.tiles)
          .find((x) => x.ptyId === id);
        if (t?.question === "decision") useTiles.getState().markQuestion(id, null);
        if (t?.menuInView) useTiles.getState().markMenu(id, false);
      }
      const recheck = readinessRecheckMs(readinessKind, verdict, status !== null);
      if (recheck !== null && !cancelled) readinessScans.request(recheck);
      // 1.177.1: a verdict held through a redraw window is judged again once
      // the window ends, output or not (`rebaselineEndsAt`).
      const windowEnd = rebaselineEndsAt({
        now: scannedAt,
        ownUntil: rebaselineUntil,
        sizeChangedAt,
        layoutAt: lastLayoutRefitAt(),
        windowMs: RESIZE_REBASELINE_MS,
      });
      if (windowEnd !== null && !cancelled) readinessScans.request(Math.max(0, windowEnd - scannedAt) + 50);
    };
    // Stamped on arrival; the scan itself follows the parse (see batcher).
    const noteReadinessData = () => {
      if (!readinessKind) return;
      const now = Date.now();
      if (now - lastInputAt < INPUT_ECHO_MS) return;
      lastDataAt = now;
      dataSinceScan = true;
    };
    // A batch parsed after a scan started always gets a scan of its own.
    const scheduleReadinessScan = () => {
      if (!readinessKind || cancelled) return;
      readinessScans.request(READINESS_SCAN_MS);
    };
    const readinessScans = createScanScheduler(() => void scanReadiness(), {
      now: () => Date.now(),
      setTimeout: (run, ms) => window.setTimeout(run, ms),
      clearTimeout: (timer) => window.clearTimeout(timer as number),
    });

    // 1.176.0 R7: the tile's PTY id is its own, and it listens before the
    // spawn: what arrives first is held (`lib/earlyPtyEvents`) and handed to
    // the handlers below once the spawn returned, in order, each once.
    const wantedId = newPtyId();
    let spawnAt = 0;
    // The died-at-once facts (`lib/startFailure`): typing, the program's
    // screen set-up, and its first output as text (bounded).
    let typedSinceSpawn = false;
    let drewScreen = false;
    let firstOutput = "";
    const FIRST_OUTPUT_CHARS = 64 * 1024;
    const outputDecoder = new TextDecoder();
    const noteStartOutput = (data: Uint8Array) => {
      if (!cli || drewScreen || firstOutput.length >= FIRST_OUTPUT_CHARS) return;
      firstOutput += outputDecoder.decode(data, { stream: true });
      if (setsUpScreen(firstOutput)) drewScreen = true;
    };
    const handleData = (data: Uint8Array) => {
      if (!ptyId) return;
      noteStartOutput(data);
      lastDataStamp = Date.now();
      // markOutput coalesces (1s) and the prompt-box scan debounces
      // (700ms) — both fire on enqueue; the ≤50ms flush lag is
      // absorbed by their own windows.
      if (!byScreen) useTiles.getState().markOutput(ptyId);
      batcher.push(data);
      schedulePromptBoxScan();
      // Windows: a shell's output is noted once drawn, if it changed
      // the screen (the batcher's callback above).
      if (!readinessByScreen) noteReadinessData();
    };
    const handleExit = (code: number | null) => {
      if (!ptyId) return;
      // 1.174.0 E2 (Challenger 1): a scan settling after the exit would
      // read the banner's screen and clear what it ended on.
      if (promptBoxTimer) {
        clearTimeout(promptBoxTimer);
        promptBoxTimer = null;
      }
      pty?.close();
      // Final output must land before the exit banner.
      batcher.flush();
      term.writeln(
        "\r\n\x1b[2m[process exited" +
          (code != null ? ` (code ${code})` : "") +
          "]\x1b[0m",
      );
      // The neutral ended state at once; Repair only once the backend
      // confirms the tool itself doesn't start (`lib/startFailure`).
      if (onExit) onExit(code);
      const tool = cli;
      if (
        tool &&
        onStartFailed &&
        exitAsksBackend({
          cli: tool,
          code,
          elapsedMs: Date.now() - spawnAt,
          typed: typedSinceSpawn,
          closedByPlyloft: isPtyClosing(ptyId),
          drewScreen,
          resumed: resumesConversation(tool, args),
          output: firstOutput,
          windows: isWindows(),
        })
      ) {
        void cliStartVerdict(tool)
          .then((verdict) => {
            const failed = verdictStartFailure(tool, verdict);
            if (failed && !cancelled) onStartFailed(failed);
          })
          .catch(() => {});
      }
    };
    const gate = ptyEventGate((ev) => (ev.kind === "data" ? handleData(ev.data) : handleExit(ev.code)));

    (async () => {
      try {
        // 1.176.0 R5: a Codex start waits (in that check) for the automatic
        // update under way; the tile says why it hasn't started yet.
        const updateWait = cli === "codex" ? codexStartWaitText(useDoctor.getState().codexUpdating) : null;
        if (updateWait) term.writeln(`\x1b[2m${updateWait}\x1b[0m`);
        // R3: the CLI's path on disk first, looked for again when it is gone.
        if (cli) await cliFreshCheck(cli);
        // R3 review 3: closed (or superseded) during the check: nothing to
        // start — not a whole Claude with its session row, killed at once.
        if (cancelled) return;
        // R7: listening first (the GH #70 gap): the shell's first prompt, a
        // CLI's last words and its exit all reach this tile. Under the id
        // asked for until the spawn returns, then the one it returned (the
        // same, from this backend).
        unlistenData = await onPtyData((eventId, data) => {
          if (eventId === (ptyId ?? wantedId)) gate.push({ kind: "data", data });
        });
        unlistenExit = await onPtyExit((eventId, code) => {
          if (eventId === (ptyId ?? wantedId)) gate.push({ kind: "exit", code });
        });
        if (cancelled) {
          // Closed while subscribing: the cleanup may have run between the
          // two awaits (it then let go of the first): each goes once.
          const [data, exit] = [unlistenData, unlistenExit];
          unlistenData = null;
          unlistenExit = null;
          data?.();
          exit?.();
          return;
        }
        spawnAt = Date.now();
        ptyId = await ptySpawn({
          cmd,
          args,
          cwd: cwd ?? null,
          workspaceId: workspaceId ?? null,
          cols: term.cols,
          rows: term.rows,
          tryTarget: tryTarget ?? null,
          cli: cli ?? null,
          id: wantedId,
          account: cli === "claude" ? (account ?? null) : null,
        });
        if (cancelled && ptyId) {
          gate.close();
          await ptyKill(ptyId);
          return;
        }
        ptyIdRef.current = ptyId;
        // Closing the tile kills the PTY before the xterm unmounts: its blur
        // and the grid's reflow must not reach a gone session (lib/ptyGone).
        if (ptyId) pty = guardPty(ptyId, { write: ptyWrite, resize: ptyResize });
        if (onPtyId && ptyId) onPtyId(ptyId);
        // GH #70: a shell already idle at its prompt is judged by the
        // foreground probe, whatever it printed (now never lost: R7).
        scheduleReadinessScan();

        const enc = new TextEncoder();
        dataDisposable = term.onData((data) => {
          // 1.169.0 (B3): xterm's own replies to the program — a DA1 answer
          // (the bundled ConPTY asks at every start), focus in/out, the
          // colour-scheme and OSC 11 answers, cursor and mouse reports — go
          // to the PTY, but they are not the member typing: no input stamp
          // (its echo window would hide real output), never a submitted line.
          const input = memberInput(data);
          if (input.typed) {
            typedSinceSpawn = true;
            // A submitted line may start a command that prints nothing; the
            // echo's scan re-asks the PTY who holds the foreground.
            if (data.includes("\r")) shellAtPrompt = false;
            lastInputAt = Date.now();
            // GH #70: a submitted line can start a program that prints
            // nothing (`read -s answer; sleep 30`), so the scan cannot wait
            // for output.
            if (input.submitted) {
              scheduleReadinessScan();
              // QoL 1.168 (D7): a turn starts with the member's own line.
              if (ptyId) useTiles.getState().markSubmitted(ptyId);
            }
          }
          pty?.write(enc.encode(data));
        });
        // R7: what came before the spawn returned, in order — after the
        // input path exists, so xterm's replies to a held query (a DA1, a
        // cursor report) reach the program.
        gate.open();

        const refit = () => {
          try {
            rebaselineUntil = Date.now() + RESIZE_REBASELINE_MS;
            // …and for the silence clock: a waiting session stays waiting
            // through the TUI's redraw (lib/attention outputRestartsSilence).
            if (ptyId) useTiles.getState().noteResize(ptyId);
            // B3 walk: every other tile resized in the same layout change
            // keeps rebaselining through this refit's window.
            noteLayoutRefit();
            // Armed only on a tile whose header reads Ready now (the rule of
            // tileHeaderStatus): a starting or working tile keeps counting.
            refitAt =
              scanMemory.lastVerdict !== false && Date.now() - scanMemory.activityAt >= READY_QUIET_MS
                ? Date.now()
                : 0;
            const before = [term.cols, term.rows];
            fit.fit();
            if (term.cols !== before[0] || term.rows !== before[1]) sizeChangedAt = Date.now();
            pty?.resize(term.cols, term.rows);
          } catch {
            // ignore transient resize errors
          }
        };
        if (!cancelled) {
          // The renderer swap (the WebGL effect below) changes the cell
          // width with no resize of the pane: refit then (when the size
          // actually changes; same columns, nothing is sent).
          refitOnRendererChange.current = () => {
            const before = [term.cols, term.rows];
            const dims = fit.proposeDimensions();
            if (!dims || (dims.cols === before[0] && dims.rows === before[1])) return;
            refit();
          };
        }
        if (containerRef.current) {
          resizeObserver = new ResizeObserver(refit);
          resizeObserver.observe(containerRef.current);
        }
      } catch (e) {
        gate.close();
        // R3 review 3: a superseded effect's term is disposed; its
        // replacement owns the tile.
        if (cancelled) return;
        // QoL 1.168 block 8 (A5): plain words first, the raw text dimmed.
        term.writeln("");
        // R3: a CLI not there even after looking again keeps these words;
        // R7: with its typed shape (or the OS refusing to run it) the tile
        // offers Repair above the terminal, and the way on says so.
        const cliGone = decodeCliUnavailable(e);
        const failed = spawnStartFailure(cli, e);
        for (const line of terminalFailureLines(
          "This session didn't start.",
          cliGone ? cliGone.message : e,
          terminalWayOn(failed),
        ))
          term.writeln(line);
        if (failed && !ptyId && onStartFailed) onStartFailed(failed);
        // No PTY means no exit event will ever come: the tile ends here, as a
        // crash, instead of counting "Working" for a process that never ran.
        // A cancelled spawn belongs to a superseded effect (the command
        // changed), whose replacement owns the tile's state.
        if (!cancelled && !ptyId && onExit) onExit(null);
      }
    })();

    return () => {
      cancelled = true;
      gate.close();
      refitOnRendererChange.current = null;
      pty?.close();
      dictation?.dispose();
      unregisterScreen?.();
      term.textarea?.removeEventListener("blur", onDictationBlur);
      if (promptBoxTimer) clearTimeout(promptBoxTimer);
      unsubPendingRename();
      readinessScans.cancel();
      readinessSeq++;
      if (dataDisposable) dataDisposable.dispose();
      // R7: each listener goes once (the spawn path may let go of them too).
      const [stopData, stopExit] = [unlistenData, unlistenExit];
      unlistenData = null;
      unlistenExit = null;
      stopData?.();
      stopExit?.();
      if (resizeObserver) resizeObserver.disconnect();
      if (ptyId) ptyKill(ptyId).catch(() => {});
      ptyIdRef.current = null;
      searchAddonRef.current = null;
      termRef.current = null;
      themeReportsRef.current = null;
      setTermInst(null);
      batcher.dispose(); // before term.dispose: final flush targets a live term
      scrollWatch?.dispose();
      undoPaste();
      stopReader();
      links?.dispose();
      if (__PLY_TEST_BRIDGE__) testTerminals()?.delete(term);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd, JSON.stringify(args), cwd]);

  // v1.63.0: GPU renderer, active workspace only. Loading the WebGL addon on
  // every warmed-hidden terminal would blow past the browser's ~16 WebGL
  // context cap (8 warmed workspaces × several tiles), so hidden terminals
  // stay on the DOM renderer and the addon is loaded/disposed on activation
  // flips. Context loss (GPU reset, cap pressure) falls back to the DOM
  // renderer until the next flip — never retried in a loop.
  useEffect(() => {
    const term = termInst;
    if (!term || !wsActive) return;
    let addon: WebglAddon | null = null;
    let cancelled = false;
    // Tier-4 fix: defer context creation off the activation critical path.
    // Creating N WebGL contexts synchronously on workspace switch stalled
    // the switch ~0.5s; the jitter spreads the per-terminal creations so
    // they don't all land in the same frame. (No requestIdleCallback —
    // WKWebView support is unreliable.)
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const candidate = new WebglAddon();
        candidate.onContextLoss(() => {
          try {
            candidate.dispose();
          } catch {
            // ignore
          }
          addon = null;
          // Back on the DOM renderer, whose cells can be wider.
          refitOnRendererChange.current?.();
        });
        term.loadAddon(candidate);
        addon = candidate;
        // Not on the dispose below (a workspace switched away): the tile is
        // hidden then, and a PTY resize there would make every switch redraw
        // the shell or TUI twice. Coming back reloads WebGL, the same cells.
        refitOnRendererChange.current?.();
      } catch {
        // WebGL unavailable — DOM renderer is always correct.
        addon = null;
      }
    }, 60 + Math.random() * 240);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      try {
        addon?.dispose();
      } catch {
        // already disposed (context loss or term.dispose) — ignore
      }
      addon = null;
    };
  }, [termInst, wsActive]);

  // Live-react to theme/accent changes (system flip or settings override)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    term.refresh(0, term.rows - 1);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  // Legacy listener: Tauri WindowEvent::DragDrop is bridged through
  // `atelier:window-drop`. Under v0.6.1's `dragDropEnabled: false`, this never
  // fires (Hard Rule #6) — but we keep the listener harmless in case the
  // setting is ever re-enabled selectively.
  useEffect(() => {
    function onDrop(e: Event) {
      const detail = (e as CustomEvent).detail as {
        paths: string[];
        x: number;
        y: number;
      };
      const node = containerRef.current;
      if (!node) return;
      const host = node.closest(".terminal-host");
      if (host && host.classList.contains("hidden")) return;
      const wsHost = node.closest(".workspace-host");
      if (wsHost && wsHost.classList.contains("hidden")) return;
      const gridHost = node.closest(".tile-grid-host");
      if (gridHost && gridHost.classList.contains("hidden")) return;
      if (node.offsetParent === null) return;
      const r = node.getBoundingClientRect();
      if (
        detail.x < r.left ||
        detail.x > r.right ||
        detail.y < r.top ||
        detail.y > r.bottom
      ) {
        return;
      }
      const id = ptyIdRef.current;
      if (!id) return;
      const text = shellQuoteJoin(detail.paths) + " ";
      const enc = new TextEncoder();
      if (screenTileId) noteTileInput(screenTileId);
      ptyWrite(id, enc.encode(text)).catch(() => {});
    }
    window.addEventListener("atelier:window-drop", onDrop);
    return () => window.removeEventListener("atelier:window-drop", onDrop);
  }, []);

  // v0.7.3: HTML5 drop handlers on the terminal pane. With dragDropEnabled
  // off (Hard Rule #6), this is the only path for drops to reach the PTY.
  // Handles two source types:
  //   1. Internal drag from FilesPanel → dataTransfer text/plain has the
  //      absolute path; write it shell-quoted into the PTY.
  //   2. External Finder drop → dataTransfer.files has File objects (no
  //      `.path` property in WebView), so we round-trip the bytes through
  //      `fs_save_dropped_file` to get a real filesystem path back — read
  //      whole first, by `saveDroppedFile` (GH #230).
  function pasteIntoPty(paths: string[]) {
    const id = ptyIdRef.current;
    if (!id || paths.length === 0) return;
    const text = shellQuoteJoin(paths) + " ";
    const enc = new TextEncoder();
    // Round 8 (review M2): a dropped path is the member's input.
    if (screenTileId) noteTileInput(screenTileId);
    ptyWrite(id, enc.encode(text)).catch(() => {});
  }

  /** D4: the hint and the tile's drop border on (a label) or off (null). */
  function showDropHint(label: string | null) {
    if (hintStaleRef.current !== null) {
      window.clearTimeout(hintStaleRef.current);
      hintStaleRef.current = null;
    }
    setDropHint((now) => (now === label ? now : label));
    wrapRef.current?.closest(".tile")?.classList.toggle("tile-drop-active", label !== null);
    if (label !== null) {
      // A drag that leaves without a dragleave (cancelled, the window lost)
      // stops sending dragover: the label and border go with it. The depth
      // count is left alone — the drag may still be over, and its next
      // dragover shows the label again.
      hintStaleRef.current = window.setTimeout(() => showDropHint(null), DROP_HINT_STALE_MS);
    }
  }

  useEffect(
    () => () => {
      if (hintStaleRef.current !== null) window.clearTimeout(hintStaleRef.current);
    },
    [],
  );

  function handleHtmlDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrag(e, TERMINAL_DROP_KINDS)) return;
    dragDepthRef.current += 1;
  }

  function handleHtmlDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!acceptsDrag(e, TERMINAL_DROP_KINDS)) return;
    // Moving between the pane's own children is a leave and an enter: the
    // hint goes only when the drag has left the pane altogether.
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      showDropHint(null);
    }
  }

  async function handleHtmlDrop(e: React.DragEvent<HTMLDivElement>) {
    dragDepthRef.current = 0;
    showDropHint(null);
    if (!acceptsDrag(e, TERMINAL_DROP_KINDS)) return;
    e.preventDefault();
    e.stopPropagation();
    const dt = e.dataTransfer;
    if (!dt) return;
    // 1. Internal path from FilesPanel, a dragged URL, or any sender that set
    //    text/plain. `text/uri-list` is read because the pane's marker says
    //    it takes `uri`: a URL dragged from another browser carries it, and
    //    on WebKit it can arrive without a text/plain twin.
    const internalPath =
      dt.getData("application/x-atelier-path") ||
      dt.getData("text/plain") ||
      firstUriListEntry(dt.getData("text/uri-list"));
    if (internalPath && (!dt.files || dt.files.length === 0)) {
      pasteIntoPty([internalPath]);
      return;
    }
    // 2. External files from Finder — materialize to cache dir, then paste.
    if (dt.files && dt.files.length > 0) {
      const saved: string[] = [];
      const refused: DropRefusal[] = [];
      const files = Array.from(dt.files);
      const seq = ++addingSeqRef.current;
      setAdding(addingWords(files.map((f) => f.name)));
      for (const f of files) {
        try {
          // GH #230: read whole, or refused as incomplete — never a prefix.
          saved.push(await saveDroppedFile(f));
        } catch (err) {
          // A file left out of the paste is said, not only logged.
          console.error("save dropped file failed:", err);
          refused.push({ name: f.name, error: err });
        }
      }
      pasteIntoPty(saved);
      // 1.172.2 D2: one toast for the drop, in plain words.
      toastDropRefusals(refused, "terminal", saved.length);
      // Typed, or refused (the toast says why): the line goes either way —
      // unless a later drop took it over.
      if (addingSeqRef.current === seq) setAdding(null);
    }
  }

  /** The first real entry of a `text/uri-list` payload: the format allows
   *  `#`-prefixed comment lines and several URLs, one per line. */
  function firstUriListEntry(raw: string): string {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) return trimmed;
    }
    return "";
  }

  function handleHtmlDragOver(e: React.DragEvent<HTMLDivElement>) {
    // GH #138: the same question the pane's `data-drop-accepts` marker asks.
    // The shell's guard refuses an unaccepted payload in the capture phase;
    // claiming it here afterwards would put the copy cursor back on a drop
    // that lands nowhere.
    if (!acceptsDrag(e, TERMINAL_DROP_KINDS)) return;
    // Must call preventDefault on dragover for the drop event to fire.
    if (e.dataTransfer) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
    // D4: said for a file or a project path, never for dragged text or a URL.
    const payload = dragPayloadFor(e);
    if (payload.files || payload.path) {
      showDropHint(dropHintWords(readinessKind, payload.files ? dragFileCount(e.dataTransfer) : 1));
    }
  }

  function findNext(value: string) {
    const addon = searchAddonRef.current;
    if (!addon) return;
    addon.findNext(value, {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      incremental: true,
    });
  }

  function findPrevious(value: string) {
    const addon = searchAddonRef.current;
    if (!addon) return;
    addon.findPrevious(value, {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchValue("");
    const addon = searchAddonRef.current;
    if (addon) addon.clearDecorations();
    // Return focus to xterm so the user can keep typing.
    requestAnimationFrame(() => termRef.current?.focus());
  }

  // v0.10.0 v2: jump the viewport to the selected command: its prompt and
  // command line at the top, the output below (`blockScrollLine`; the
  // 2026-10-20 walk: anchoring on the output hid the command line). No-op if
  // the marker is gone (block scrolled past the buffer limit) or the
  // terminal is unmounted.
  const scrollToBlock = useCallback((b: CommandBlock) => {
    const term = termRef.current;
    if (!term) return;
    const line = blockScrollLine(b, term.rows);
    if (line === null) return;
    term.scrollToLine(line);
  }, []);

  // Dispose remaining decorations + markers on unmount.
  useEffect(() => {
    return () => {
      for (const b of blocksRef.current) disposeBlock(b);
    };
  }, []);

  return (
    <div
      className="terminal-pane-wrap"
      // GH #138: the shell's drop guard refuses drops no registered zone
      // accepts. One list, shared with `handleHtmlDragOver`/`handleHtmlDrop`
      // above, so the marker and the handlers cannot drift apart.
      ref={wrapRef}
      data-drop-zone="terminal"
      data-drop-accepts={acceptsAttr(TERMINAL_DROP_KINDS)}
      onDragEnter={handleHtmlDragEnter}
      onDragOver={handleHtmlDragOver}
      onDragLeave={handleHtmlDragLeave}
      onDrop={handleHtmlDrop}
    >
      {/* A shell tile's xterm keeps a left gutter for the command-block
          marks (terminals.css), whether or not Command blocks is on: the
          marks draw whenever the shell prints OSC 133, and a gutter that
          came and went would resize the PTY. */}
      <div
        ref={containerRef}
        className={readinessKind === "shell" ? "terminal-pane is-shell" : "terminal-pane"}
      />
      {/* D4: over the terminal, never in the way of the drop (no pointer
          events); inside a hidden workspace's host it is hidden with it. */}
      {dropHint && (
        <div className="terminal-drop-hint" aria-hidden="true">
          <span>{dropHint}</span>
        </div>
      )}
      {adding && (
        <div className="terminal-drop-adding" role="status" title={adding}>
          {adding}
        </div>
      )}
      {searchOpen && (
        <div className="terminal-search">
          <input
            ref={searchInputRef}
            type="text"
            value={searchValue}
            placeholder="Search…"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const v = e.target.value;
              setSearchValue(v);
              if (v) findNext(v);
              else searchAddonRef.current?.clearDecorations();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (e.shiftKey) findPrevious(searchValue);
                else findNext(searchValue);
              }
            }}
          />
          <button
            type="button"
            onClick={() => findPrevious(searchValue)}
            disabled={!searchValue}
            title="Previous (Shift-Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => findNext(searchValue)}
            disabled={!searchValue}
            title="Next (Enter)"
          >
            ↓
          </button>
          <button type="button" onClick={closeSearch} title="Close (Esc)" aria-label="Close search">
            <Icon name="close" size="sm" />
          </button>
        </div>
      )}
      {commandBlocksEnabled && blocks.length > 0 && (
        <CommandBlocksIndicator
          blocks={blocks}
          open={blocksOpen}
          onToggle={() => setBlocksOpen((v) => !v)}
          onClose={() => setBlocksOpen(false)}
          onPick={scrollToBlock}
        />
      )}
    </div>
  );
}

function CommandBlocksIndicator({
  blocks,
  open,
  onToggle,
  onClose,
  onPick,
}: {
  blocks: CommandBlock[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (b: CommandBlock) => void;
}) {
  const successCount = blocks.filter(
    (b) => b.exitCode != null && b.exitCode === 0,
  ).length;
  const failCount = blocks.filter(
    (b) => b.exitCode != null && b.exitCode !== 0,
  ).length;
  const recent = blocks.slice(-15).reverse();
  return (
    <div className="terminal-blocks">
      <button
        type="button"
        className="terminal-blocks-badge"
        onClick={onToggle}
        title="Recent commands"
      >
        <span className="terminal-blocks-ok">✓ {successCount}</span>
        {failCount > 0 && (
          <span className="terminal-blocks-fail"> · ✗ {failCount}</span>
        )}
      </button>
      {open && (
        <div className="terminal-blocks-popover">
          <div className="terminal-blocks-popover-head">
            <span>Recent commands</span>
            <button type="button" onClick={onClose} title="Close" aria-label="Close recent commands">
              <Icon name="close" size="sm" />
            </button>
          </div>
          <ul className="terminal-blocks-list">
            {recent.map((b) => {
              const elapsed =
                b.endedAt != null ? Math.max(0, b.endedAt - b.startedAt) : 0;
              const elapsedStr =
                elapsed >= 1000
                  ? `${(elapsed / 1000).toFixed(1)}s`
                  : `${elapsed}ms`;
              const scrollable = !!b.marker && !b.marker.isDisposed;
              return (
                <li key={b.id} className="terminal-blocks-item">
                  <button
                    type="button"
                    className="terminal-blocks-item-button"
                    onClick={() => {
                      if (scrollable) onPick(b);
                    }}
                    disabled={!scrollable}
                    title={
                      scrollable
                        ? "Scroll terminal to this command"
                        : "Out of scrollback"
                    }
                  >
                    <span
                      className={`terminal-blocks-dot ${
                        b.exitCode === 0 ? "ok" : "fail"
                      }`}
                    >
                      {b.exitCode === 0 ? "✓" : `✗ ${b.exitCode ?? "?"}`}
                    </span>
                    <span className="terminal-blocks-time">{elapsedStr}</span>
                    <span className="terminal-blocks-when">
                      {new Date(b.startedAt).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
