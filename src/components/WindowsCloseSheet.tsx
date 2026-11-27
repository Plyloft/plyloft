import { useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CBtn, Sheet } from "./ux";
import { isWindows } from "../lib/platform";
import {
  CLOSE_SHEET,
  runningCounts,
  stopSentence,
  type WindowsCloseAction,
} from "../lib/closeChoice";
import { useTiles } from "../store/tileStore";
import { useBuilder } from "../store/builderStore";
import { useAgents } from "../store/agentStore";
import { useVerify } from "../store/verifyStore";
import { useShip } from "../store/shipStore";
import { useKanban } from "../store/kanbanStore";
import { useSwarms } from "../store/swarmStore";
import { useSettings } from "../store/settingsStore";
import { acknowledgeWorkingForQuit } from "../store/quitGuardStore";
import { useQuitMergeCount } from "../hooks/useQuitMergeCount";
import { ifYouQuitMergeNote } from "../lib/deliveryWords";

/** `window://close-asked`, from `lib.rs::windows_close_main`. */
interface CloseAsked {
  generation: number;
  tray: boolean;
}

/**
 * Windows (W4): the window's close (X, Alt+F4) with `behavior.windowsCloseAction`
 * on "ask" — keep Ply running in the notification area, or quit it. Rust
 * prevents the close and asks; this sheet acks the ask (an unacked ask falls
 * back to hiding), says what a quit would stop, and answers. "Don't ask
 * again" saves the choice through Settings before answering. Cancel or Esc
 * leaves the window open. An answer that never reached Rust keeps the
 * question up and starts the ask over; unmounting tells Rust nobody listens. Mounted once in the App; on the Mac it listens to nothing and
 * draws nothing — the Mac's close always hides.
 */
export function WindowsCloseSheet() {
  const [ask, setAsk] = useState<CloseAsked | null>(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isWindows()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<CloseAsked>("window://close-asked", (event) => {
      const payload = event.payload;
      invoke<boolean>("window_close_ack", { generation: payload.generation })
        .then((show) => {
          if (!show) return;
          setRemember(false);
          setBusy(false);
          setAsk(payload);
        })
        .catch(() => {});
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
        // Only now can an ask be heard: until this lands, a close hides.
        invoke("window_close_listening").catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
        // Unmounted (the first-run screen swaps the shell out, a reload):
        // never presumed listening, so a close hides at once.
        invoke("window_close_not_listening").catch(() => {});
      }
    };
  }, []);

  if (!ask) return null;

  const answer = async (choice: "tray" | "quit" | "stay") => {
    if (busy) return;
    setBusy(true);
    if (remember && choice !== "stay") {
      const saved: WindowsCloseAction = choice;
      try {
        await useSettings.getState().update((s) => ({
          ...s,
          behavior: { ...s.behavior, windowsCloseAction: saved },
        }));
      } catch {
        // The choice still happens; the next close asks again.
      }
    }
    const asked = ask;
    setAsk(null);
    // S1-2: this sheet already said what a quit stops, so the quit guard
    // that follows asks only about unsaved files.
    if (choice === "quit") acknowledgeWorkingForQuit();
    try {
      await invoke("window_close_answer", { choice });
    } catch {
      // The answer never reached Rust, which still holds the ask: start it
      // over, and keep the question up so it can be answered again.
      invoke("window_close_listening").catch(() => {});
      if (choice !== "stay") setAsk(asked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <WindowsCloseSheetView
      tray={ask.tray}
      remember={remember}
      busy={busy}
      keepRef={keepRef}
      onRemember={setRemember}
      onKeep={() => void answer("tray")}
      onQuit={() => void answer("quit")}
      onStay={() => void answer("stay")}
    />
  );
}

function WindowsCloseSheetView({
  tray,
  remember,
  busy,
  keepRef,
  onRemember,
  onKeep,
  onQuit,
  onStay,
}: {
  tray: boolean;
  remember: boolean;
  busy: boolean;
  keepRef: RefObject<HTMLButtonElement | null>;
  onRemember: (next: boolean) => void;
  onKeep: () => void;
  onQuit: () => void;
  onStay: () => void;
}) {
  const tiles = useTiles((s) => s.byWorkspace);
  const builders = useBuilder((s) => s.byCard);
  const agents = useAgents((s) => s.byWorkspace);
  const boards = useKanban((s) => s.byWorkspace);
  const swarms = useSwarms((s) => s.byWorkspace);
  const verifyJobs = useVerify((s) => s.inflight.length);
  const shipping = useShip((s) => s.shipping);
  const counts = runningCounts({
    tiles: Object.values(tiles).flatMap((w) => w.tiles),
    builderSessions: Object.keys(builders).length,
    runStatuses: Object.values(agents).flatMap((w) => w.runs.map((r) => r.status)),
    reviewStatuses: Object.values(boards).flatMap((w) =>
      w.cards.map((c) => c.builder?.review?.status ?? ""),
    ),
    swarmStatuses: Object.values(swarms).flatMap((w) => w.swarms.map((sw) => sw.status)),
    verifyJobs,
    shipping,
  });
  // 1.172.0 B2: every workspace's, and the releases Plyloft merges itself.
  const mergeNote = ifYouQuitMergeNote(useQuitMergeCount());
  return (
    <Sheet
      title={CLOSE_SHEET.title}
      lede={tray ? CLOSE_SHEET.lede : CLOSE_SHEET.ledeMinimized}
      size="confirm"
      onClose={onStay}
      canDismiss={!busy}
      initialFocusRef={keepRef}
      leadAction={
        <CBtn tone="danger" disabled={busy} onClick={onQuit}>
          {CLOSE_SHEET.quit}
        </CBtn>
      }
      actions={
        <>
          <CBtn tone="ghost" disabled={busy} onClick={onStay}>
            {CLOSE_SHEET.cancel}
          </CBtn>
          <CBtn ref={keepRef} tone="accent" disabled={busy} onClick={onKeep}>
            {tray ? CLOSE_SHEET.keep : CLOSE_SHEET.keepMinimized}
          </CBtn>
        </>
      }
    >
      <p className="ux-sheet-text">{stopSentence(counts)}</p>
      {/* 1.171.0 B2 (K4): Quit leaves these to Plyloft's next start. */}
      {mergeNote && (
        <p className="ux-sheet-text" data-ply-quit-merges>
          {mergeNote}
        </p>
      )}
      <label className="ux-sheet-check">
        <input
          type="checkbox"
          className="ux-checkbox"
          checked={remember}
          disabled={busy}
          onChange={(e) => onRemember(e.target.checked)}
        />
        {CLOSE_SHEET.dontAsk}
      </label>
      <p className="ux-sheet-hint">{CLOSE_SHEET.dontAskHint}</p>
    </Sheet>
  );
}
