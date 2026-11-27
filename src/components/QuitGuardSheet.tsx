import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CBtn, Sheet } from "./ux";
import { fileNames, quitSheetWords, saveFailedLine, type QuitLoss } from "../lib/quitGuard";
import { saveFiles, unsavedFiles } from "../lib/editorSave";
import {
  answerQuit,
  askWorkingSetting,
  confirmQuit,
  quitAsksNow,
  quitLossNow,
  registerQuitHost,
  useQuitGuard,
} from "../store/quitGuardStore";
import { useSettings } from "../store/settingsStore";
import { builderScreensReadFailing } from "../store/builderStore";
import { useQuitMergeCount } from "../hooks/useQuitMergeCount";
import { quitMergeNote } from "../lib/deliveryWords";
import { isMac } from "../lib/platform";
import { installAtQuitWithin, updateFlow } from "./UpdatePrompt";

/** What a quit would lose now; the sheet's opening reading if it can't be
 *  read. `unsure`: the Builder screens weren't read when the sheet opened, or
 *  their read is failing now — each off-screen Builder counts as at work
 *  (review H1: never "Nothing is running" from a stale reading). */
function liveLoss(opened: QuitLoss, unsure: boolean): QuitLoss {
  try {
    return quitLossNow({ unsure });
  } catch {
    return opened;
  }
}

/** A scheduled, downloaded update installs as the Mac quits. */
export function installsAtQuit(): boolean {
  return isMac() && updateFlow().canInstallAtQuit();
}

/** `app://quit-asked`, from `lib.rs::request_quit`. */
interface QuitAsked {
  generation: number;
}

/**
 * QoL 1.168 S1-2: the sheet before Plyloft ends — "2 files have unsaved
 * changes · 1 session is working: Save all and quit / Quit anyway / Cancel".
 *
 * Mounted once in the App, above Setup. Two ways in: a quit Rust started
 * (`app://quit-asked`: the menu's Quit and ⌘Q, the tray, Ctrl+Shift+Q, the
 * Windows close sheet's Quit), answered through `quit_ack` / `quit_answer` —
 * with nothing to lose the ack quits at once and no sheet shows; and
 * `confirmQuit` from the page itself (the updater's relaunch). Rust never
 * waits on a page that is not listening, so a hung page cannot keep Plyloft
 * open.
 */
export function QuitGuardSheet() {
  const ask = useQuitGuard((s) => s.ask);
  useEffect(() => registerQuitHost(), []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<QuitAsked>("app://quit-asked", (event) => {
      const { generation } = event.payload;
      // QoL 1.168 G1: a scheduled update ("Install when my work is done")
      // is put in place before a Mac quit, so the ack holds the quit while it
      // installs — the sheet says "Installing…". Never on Windows, where the
      // installer would open Plyloft again.
      const installs = installsAtQuit();
      // 1.176.2 (review round 2, M1): the Builders no terminal shows are
      // read now, before the answer (a cached reading may be 5 s old).
      quitAsksNow()
        .catch(() => true)
        .then((asks) => invoke<boolean>("quit_ack", { generation, ask: installs || asks }))
        .then((show) => {
          if (!show) return;
          void confirmQuit("quit")
            .then(async (ok) => {
              if (ok && installsAtQuit()) await installAtQuitWithin();
              return ok;
            })
            // Rust waits for this answer once acked: whatever went wrong
            // above, it always gets one (stay, so nothing is lost).
            .catch(() => false)
            .then((ok) => invoke("quit_answer", { choice: ok ? "quit" : "stay" }).catch(() => {}));
        })
        .catch(() => {});
    })
      .then((u) => {
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
        invoke("quit_listening").catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
        invoke("quit_not_listening").catch(() => {});
      }
    };
  }, []);

  if (!ask) return null;
  return <QuitGuardSheetView key={ask.id} />;
}

function QuitGuardSheetView() {
  const ask = useQuitGuard((s) => s.ask)!;
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // 1.171.0 B2 (K4): pull requests that wait for Plyloft's own merge are
  // said here — never a reason to ask, and never a hold on the quit.
  // 1.172.0 B2: every workspace's, and the releases Plyloft merges itself.
  const mergeNote = quitMergeNote(useQuitMergeCount());
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // 1.177.1 (item 21): while the sheet is open its words follow what is
  // going on (a turn that ends, a file saved elsewhere), read once a second;
  // it never answers by itself.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const loss = busy ? ask.loss : liveLoss(ask.loss, !ask.screensRead || builderScreensReadFailing());
  const words = quitSheetWords(loss, ask.reason, {
    askWorking: askWorkingSetting(),
    workingAcknowledged: ask.workingAcknowledged,
  });

  const rememberIfAsked = async () => {
    if (!remember || !words.dontAsk) return;
    try {
      await useSettings.getState().update((s) => ({
        ...s,
        behavior: { ...s.behavior, confirmQuitWithWorkingSessions: false },
      }));
    } catch {
      // The quit still happens; the next one asks again.
    }
  };

  const quitAnyway = async () => {
    if (busy) return;
    setBusy(true);
    await rememberIfAsked();
    answerQuit(ask.id, true);
  };

  const saveAllAndQuit = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    // What is unsaved now, not when the sheet opened.
    const notSaved = await saveFiles(unsavedFiles());
    if (notSaved.length > 0) {
      setFailed(saveFailedLine(notSaved));
      setBusy(false);
      return;
    }
    await rememberIfAsked();
    answerQuit(ask.id, true);
  };

  const cancel = () => {
    if (busy) return;
    answerQuit(ask.id, false);
  };

  const names = fileNames(loss.files);
  return (
    <Sheet
      title={words.title}
      lede={words.lede}
      size="confirm"
      onClose={cancel}
      canDismiss={!busy}
      initialFocusRef={words.saveAll ? saveRef : cancelRef}
      leadAction={
        <CBtn tone="danger" disabled={busy} onClick={() => void quitAnyway()}>
          {words.anyway}
        </CBtn>
      }
      actions={
        <>
          <CBtn ref={cancelRef} tone="ghost" disabled={busy} onClick={cancel}>
            {words.cancel}
          </CBtn>
          {words.saveAll && (
            <CBtn ref={saveRef} tone="accent" disabled={busy} onClick={() => void saveAllAndQuit()}>
              {words.saveAll}
            </CBtn>
          )}
        </>
      }
    >
      {names.length > 0 && (
        <p className="ux-sheet-text" data-ply-quit-files>
          {names.join(", ")}
        </p>
      )}
      {words.workingNote && <p className="ux-sheet-text">{words.workingNote}</p>}
      {mergeNote && (
        <p className="ux-sheet-text" data-ply-quit-merges>
          {mergeNote}
        </p>
      )}
      {failed && (
        <p className="ux-sheet-alert" role="alert">
          {failed}
        </p>
      )}
      {words.dontAsk && (
        <>
          <label className="ux-sheet-check">
            <input
              type="checkbox"
              className="ux-checkbox"
              checked={remember}
              disabled={busy}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {words.dontAsk}
          </label>
          {words.dontAskHint && <p className="ux-sheet-hint">{words.dontAskHint}</p>}
        </>
      )}
    </Sheet>
  );
}
