import { useEffect, useRef, useState } from "react";
import { legacyInstallProbe, legacyInstallRemove, type LegacyInstall, type LegacyRemoval } from "../lib/legacyInstallIpc";
import { isWindows } from "../lib/platform";
import { CBtn, FailureText, Sheet } from "./ux";
import { failure, type Failure } from "../lib/failure";

/**
 * 2026-09-30: the "Ply" app (this app's earlier name) left beside Plyloft
 * after the rename. On
 * Windows its updater installed an older Plyloft over a newer one, so at
 * launch Plyloft offers to remove it — asking first, in one sentence. The
 * profile is shared (same identifier) and stays. "Not now" lasts for this
 * launch: the old copy can still downgrade Plyloft, so the next launch asks
 * again. Rust detects again on Remove; this sheet never sends a path.
 */
export function legacyInstallSentence(found: LegacyInstall, windows: boolean): string {
  // "Ply" is this app's earlier name, not necessarily an older version: a
  // Ply.app that updated itself can be newer than this Plyloft.
  const name = `${found.version ? `Ply ${found.version}` : "Ply"} (this app under its earlier name)`;
  const where = found.location;
  if (found.allUsers) {
    return `${name} is still installed in ${where} for every user of this PC and can install an older Plyloft over this one; Windows needs an administrator to remove it, so uninstall it from Settings → Apps → Installed apps and leave the option to delete app data unticked — your workspaces, settings and boards stay as they are.`;
  }
  return windows
    ? `${name} is still installed in ${where} and can install an older Plyloft over this one, so Plyloft will move it and its shortcuts to the Recycle Bin — your workspaces, settings and boards are shared with Plyloft and stay as they are.`
    : `${name} is still in ${where} beside Plyloft, which can open the wrong copy, so Plyloft will move it to the Trash — your workspaces, settings and boards are shared with Plyloft and stay as they are.`;
}

/** After a removal: what went where, and every shortcut left for the
 *  person (an administrator's, or one whose target could not be read). */
export function legacyInstallDoneSentence(done: LegacyRemoval): string {
  const lines = [`Ply was moved to ${done.bin}: ${done.moved.join(", ")}.`];
  if (done.adminShortcuts.length > 0) {
    lines.push(
      `Its shortcut for every user of this PC (${done.adminShortcuts.join(", ")}) needs an administrator to delete it.`,
    );
  }
  if (done.unmatchedShortcuts.length > 0) {
    lines.push(
      `Plyloft could not confirm that ${done.unmatchedShortcuts.join(", ")} opens Ply, so it left it; delete it if it does.`,
    );
  }
  return lines.join(" ");
}

export function LegacyInstallPrompt() {
  const [found, setFound] = useState<LegacyInstall | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  // A confirm that removes something opens on the safe choice.
  const safeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let live = true;
    legacyInstallProbe()
      .then((answer) => {
        if (live && answer) setFound(answer);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (done) {
    return (
      <Sheet
        title="Ply is removed"
        size="confirm"
        onClose={() => setDone(null)}
        initialFocusRef={primaryRef}
        actions={
          <CBtn ref={primaryRef} tone="accent" onClick={() => setDone(null)}>
            OK
          </CBtn>
        }
      >
        <p className="ux-sheet-text">{done}</p>
      </Sheet>
    );
  }
  if (!found) return null;

  async function remove() {
    setBusy(true);
    setFailure(null);
    try {
      const removal = await legacyInstallRemove();
      setFound(null);
      if (removal) setDone(legacyInstallDoneSentence(removal));
    } catch (e) {
      setFailure(failure("The old app wasn't removed, and nothing was moved. Details says why.", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Ply is still installed"
      size="confirm"
      onClose={() => setFound(null)}
      canDismiss={!busy}
      initialFocusRef={found.allUsers ? primaryRef : safeRef}
      actions={
        found.allUsers ? (
          <CBtn ref={primaryRef} tone="accent" onClick={() => setFound(null)}>
            OK
          </CBtn>
        ) : (
          <>
            <CBtn ref={safeRef} onClick={() => setFound(null)} disabled={busy}>
              Not now
            </CBtn>
            <CBtn tone="accent" onClick={() => void remove()} disabled={busy}>
              {failed ? "Retry" : "Remove Ply"}
            </CBtn>
          </>
        )
      }
    >
      <p className="ux-sheet-text">{legacyInstallSentence(found, isWindows())}</p>
      {failed && (
        <div className="ux-sheet-alert" role="alert">
          <FailureText failure={failed} />
        </div>
      )}
    </Sheet>
  );
}
