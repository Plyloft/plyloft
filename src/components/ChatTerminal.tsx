import { machineWords } from "../lib/platform";
import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { chatScreen, onPtyData, onPtyExit, ptyWrite, type ChatScreenSnapshot } from "../ipc";
import { PLAN_VIEW_ONLY } from "../lib/planExchangeView";
import { useColorScheme } from "../hooks/useColorScheme";
import { useSettings } from "../store/settingsStore";
import { xtermThemeFor } from "../lib/xtermTheme";
import { installWideChars, WIDE_CHAR_OPTIONS } from "../lib/xtermUnicode";
import { isDarkTerminalTheme, trackThemeReports, type ThemeReports } from "../lib/themeReports";
import { installTerminalClipboardKeys } from "../lib/terminalKeys";
import { followScreenReader } from "./terminalReading";
import { installTerminalPaste } from "../lib/terminalPaste";
import { concatChunks, createWriteBatcher } from "../lib/xtermBatch";
import { replayJoin } from "../lib/builderAttach";
import { registerTestTerminal } from "../testBridge/registerTerminal";
import { rawError } from "../lib/cardPage";
import { CHAT_PTY_COLS, CHAT_PTY_ROWS, CHAT_TERMINAL_RIGHTS } from "../lib/chatView";

type Attach = "attaching" | "live" | "gone" | { failed: string };

/**
 * Card chat: "Show terminal" — an xterm on the chat's hidden Claude PTY,
 * for a screen Plyloft doesn't know or a menu Claude waits on. Plyloft never
 * answers those; the member does, with their own keystrokes.
 *
 * The PTY is the backend's (`PtyRegistry::spawn_chat`): this view never
 * spawns, kills or **resizes** it. It is drawn at the chat grid's own size
 * (40 × 120), in a pane that scrolls both ways: a terminal fitted to the
 * view made Claude repaint at another size, and the Mac walk of 30e79013
 * saw that repaint garble the first paint (rows doubled, the old paint's
 * pieces left, the composer cut off — F2). The first paint is
 * `chat_screen`'s grid — screen and terminal modes — written with the
 * `pty://data` held since subscribing, from the grid's byte offset on
 * (`lib/builderAttach.ts`), in one direct write; the live stream follows
 * through the batcher, which xterm's write queue keeps in order.
 */
export function ChatTerminal({
  workspaceId,
  cardId,
  ptyId,
  id,
  readOnly = false,
  rights,
  readScreen,
}: {
  workspaceId: string;
  cardId: string;
  ptyId: string;
  /** The element Show terminal's button controls. */
  id?: string;
  /** Plan with two AIs (§6): view-only — no keystroke is sent (the backend
   *  refuses a plan lane's `pty_write` too). */
  readOnly?: boolean;
  /** The line above the terminal (default: the Chat's rights, or the plan
   *  lane's view-only line when `readOnly`). */
  rights?: string;
  /** The first paint's source (default: the card's Chat, `chat_screen`). */
  readScreen?: () => Promise<ChatScreenSnapshot | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // 1.168.1 (C1): light/dark changes reach the program (lib/themeReports).
  const themeReportsRef = useRef<ThemeReports | null>(null);
  const theme = useColorScheme();
  const accent = useSettings((s) => s.settings.appearance.accent);
  const [attach, setAttach] = useState<Attach>("attaching");

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const term = new XTerm({
      fontFamily: 'SF Mono, Menlo, "Cascadia Mono", Consolas, monospace',
      fontSize: 12,
      cols: CHAT_PTY_COLS,
      rows: CHAT_PTY_ROWS,
      cursorBlink: true,
      scrollback: 2000,
      theme: xtermThemeFor(theme, accent),
      ...WIDE_CHAR_OPTIONS,
    });
    // 1.168.1 (#13): wide emoji take two cells, as the TUI assumes.
    installWideChars(term);
    termRef.current = term;
    themeReportsRef.current = trackThemeReports(term, isDarkTerminalTheme(theme));
    term.open(host);
    const unregisterTestTerminal = registerTestTerminal(term);
    // Windows: right-click copies a selection or pastes, as in a tile; a
    // TUI runs here, so a paste of several lines goes in as is.
    const undoPaste = installTerminalPaste(host, term, { shell: false });
    installTerminalClipboardKeys(term);
    // QoL 1.168 (block 10): Screen reader support, while it has the keyboard
    // (its text size stays fixed).
    const stopReader = followScreenReader(term);
    const batcher = createWriteBatcher((data) => term.write(data));
    const enc = new TextEncoder();

    let cancelled = false;
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let dataDisposable: { dispose(): void } | null = null;
    // `pty://data` from the moment of subscribing is held until the first
    // paint is in, then written from the grid's offset on: a byte the grid
    // already holds is not written twice, and none after it is lost.
    let replaying: Uint8Array[] | null = null;
    const join = replayJoin((data) => {
      if (replaying) replaying.push(data);
      else batcher.push(data);
    });

    (async () => {
      try {
        const offData = await onPtyData((id, data, offset) => {
          if (cancelled || id !== ptyId) return;
          join.live({ data, offset });
        });
        if (cancelled) return offData();
        unlistenData = offData;
        const offExit = await onPtyExit((id) => {
          if (cancelled || id !== ptyId) return;
          batcher.flush();
          setAttach("gone");
        });
        if (cancelled) return offExit();
        unlistenExit = offExit;
        const screen = await (readScreen ? readScreen() : chatScreen(workspaceId, cardId));
        if (cancelled) return;
        if (!screen || screen.ptyId !== ptyId) {
          setAttach("gone");
          return;
        }
        // The grid's size (40 × 120 unless something resized the PTY), so
        // its paint lands where it was drawn.
        if (screen.cols !== term.cols || screen.rows !== term.rows) {
          term.resize(Math.max(1, screen.cols), Math.max(1, screen.rows));
        }
        replaying = [];
        join.replay(new TextEncoder().encode(screen.formatted), screen.offset);
        const replay = concatChunks(replaying);
        replaying = null;
        setAttach("live");
        if (!readOnly) {
          dataDisposable = term.onData((data) => {
            ptyWrite(ptyId, enc.encode(data)).catch(() => {
              // The session ended meanwhile: its exit says so.
            });
          });
        }
        term.write(replay, () => {
          if (!cancelled && !readOnly) term.focus();
        });
      } catch (e) {
        if (!cancelled) setAttach({ failed: rawError(e) });
      }
    })();

    return () => {
      cancelled = true;
      // The view never kills or resizes the PTY: hiding it leaves Claude
      // as it was.
      dataDisposable?.dispose();
      unlistenData?.();
      unlistenExit?.();
      termRef.current = null;
      themeReportsRef.current = null;
      batcher.dispose();
      undoPaste();
      unregisterTestTerminal();
      stopReader();
      term.dispose();
    };
    // The terminal is made once per PTY; the theme follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId, workspaceId, cardId, readOnly]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeFor(theme, accent);
    term.refresh(0, term.rows - 1);
    themeReportsRef.current?.notify(isDarkTerminalTheme(theme));
  }, [theme, accent]);

  return (
    <div
      id={id}
      className="ux-chat-terminal"
      data-ply-chat-terminal={ptyId}
      data-ply-chat-terminal-state={typeof attach === "string" ? attach : "failed"}
      data-ply-chat-terminal-readonly={readOnly ? "" : undefined}
    >
      <p className="ux-chat-terminal-rights">{rights ?? (readOnly ? PLAN_VIEW_ONLY : machineWords(CHAT_TERMINAL_RIGHTS))}</p>
      {/* Claude's own 120 × 40: the pane scrolls rather than resizing it. */}
      <div className="ux-chat-terminal-scroll" tabIndex={-1}>
        <div ref={containerRef} className="ux-chat-terminal-pane" aria-label="Claude's terminal for this chat" />
      </div>
      {attach === "gone" && (
        <p className="ux-chat-terminal-note" role="status">
          {readOnly
            ? "This plan session's terminal has closed."
            : "This chat's terminal has closed. Your next message starts Claude again."}
        </p>
      )}
      {typeof attach === "object" && (
        <p className="ux-chat-terminal-note" role="alert">
          The terminal didn't open: {attach.failed}
        </p>
      )}
    </div>
  );
}
