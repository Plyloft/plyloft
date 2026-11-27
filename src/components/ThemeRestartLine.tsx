import { useEffect, useReducer, useState } from "react";
import { CBtn } from "./ux";
import { useColorScheme } from "../hooks/useColorScheme";
import { ptyConsoleHost, ptySessionLightness } from "../ipc";
import { isWindows } from "../lib/platform";
import { isDarkTerminalTheme } from "../lib/themeReports";
import {
  dismissedFor,
  dismissFor,
  forgetDismissal,
  offersThemeRestart,
  THEME_REOPEN_WORDS,
  THEME_RESTART_WORDS,
} from "../lib/themeRestart";

/**
 * 1.168.1 (#6, Windows): a Claude session started in the other light/dark
 * says so, with Restart when `onRestart` is given (lib/themeRestart). The
 * light/dark it started in is the backend's, recorded at spawn. 1.169.0
 * (B2): only on the system ConPTY (`pty_console_host`).
 */
export function ThemeRestartLine({
  ptyId,
  vendor,
  onRestart,
  className = "ux-card-muted",
}: {
  ptyId: string | null | undefined;
  vendor: string | null | undefined;
  onRestart?: () => Promise<unknown>;
  className?: string;
}) {
  const nowDark = isDarkTerminalTheme(useColorScheme());
  const windows = isWindows();
  const asks = windows && vendor === "claude" && !!ptyId;
  const [startedDark, setStartedDark] = useState<boolean | null>(null);
  // 1.169.0 (B2): on the bundled ConPTY Claude follows the switch live.
  // A backend that can't say is taken for the system ConPTY (the line is
  // the safe side); until it answers, no line.
  const [consoleHost, setConsoleHost] = useState<"bundled" | "system" | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStartedDark(null);
    if (!asks || !ptyId) return;
    let live = true;
    ptySessionLightness(ptyId)
      .then((l) => {
        if (!live) return;
        if (l === null) forgetDismissal(ptyId);
        setStartedDark(l === null ? null : l === "dark");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asks, ptyId]);

  useEffect(() => {
    if (!asks) return;
    let live = true;
    ptyConsoleHost()
      .then((h) => live && setConsoleHost(h === "bundled" ? "bundled" : "system"))
      .catch(() => live && setConsoleHost("system"));
    return () => {
      live = false;
    };
  }, [asks]);

  // Back to the session's own light/dark: a later flip asks again.
  useEffect(() => {
    if (ptyId && startedDark !== null && nowDark === startedDark) forgetDismissal(ptyId);
  }, [ptyId, nowDark, startedDark]);

  if (!asks || !ptyId) return null;
  if (!offersThemeRestart({ windows, consoleHost, vendor, startedDark, nowDark, dismissedFor: dismissedFor(ptyId) })) {
    return null;
  }
  return (
    <div className={`${className} ply-theme-restart`} role="status" data-ply-theme-restart="">
      <span>{onRestart ? THEME_RESTART_WORDS : THEME_REOPEN_WORDS}</span>{" "}
      {onRestart && (
        <CBtn
          tone="quiet"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRestart().finally(() => setBusy(false));
          }}
        >
          Restart
        </CBtn>
      )}
      <CBtn
        tone="quiet"
        onClick={() => {
          dismissFor(ptyId, nowDark);
          rerender();
        }}
      >
        Dismiss
      </CBtn>
    </div>
  );
}
