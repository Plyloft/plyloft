// 1.175.0 B2 (SEC-4): "Run the install step on this Mac?" — a release is
// done and the step the repository runs after it changed (or is new to this
// computer). Opened by the release toast's Review and the Inbox row's Decide.
// Focus is on Not now: nothing runs unless the person says so.
import { useRef, useState } from "react";
import {
  ALLOW_AND_RUN,
  INSTALL_OK_COVERS,
  INSTALL_SHEET_TITLE,
  installSheetHint,
  installSheetLede,
} from "../lib/checksConsent";
import { installAllowAndRun } from "../lib/checksConsentIpc";
import { plainFailure } from "../lib/plainError";
import { machineWords } from "../lib/platform";
import { useChecksConsent } from "../store/checksConsentStore";
import { pushToast } from "../store/toastStore";
import { CBtn, Sheet } from "./ux";

export function InstallConsentSheet() {
  const workspaceId = useChecksConsent((s) => s.installSheet);
  const view = useChecksConsent((s) => (s.installSheet ? s.byWorkspace[s.installSheet]?.install : undefined));
  const close = useChecksConsent((s) => s.closeInstallSheet);
  const load = useChecksConsent((s) => s.load);
  const notNow = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!workspaceId || !view || !view.needsOk || !view.current) return null;
  const tag = view.waiting?.tag ?? null;
  const dismiss = () => {
    setError(null);
    close();
  };
  const allow = async () => {
    if (busy || !view.current) return;
    setBusy(true);
    setError(null);
    try {
      const said = await installAllowAndRun(workspaceId, view.current);
      pushToast({ kind: "info", title: tag ? `${tag}'s install step started` : "The install step started", body: said });
      close();
    } catch (e) {
      // "The install step changed since you looked…", "Plyloft couldn’t
      // record your choice…", or why the step itself didn't start.
      setError(plainFailure(e).sentence);
      await load(workspaceId);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      size="confirm"
      title={INSTALL_SHEET_TITLE}
      lede={installSheetLede(view, Date.now())}
      onClose={dismiss}
      canDismiss={!busy}
      initialFocusRef={notNow}
      actions={
        <>
          {/* consents.html, scene 2.4: Not now is a plain button that has the
              focus; Allow and run is the sheet's one accent button. */}
          <CBtn ref={notNow} disabled={busy} onClick={dismiss}>
            Not now
          </CBtn>
          <CBtn tone="accent" disabled={busy} onClick={() => void allow()}>
            {ALLOW_AND_RUN}
          </CBtn>
        </>
      }
    >
      <div className="ux-versions" data-ply-install-versions="">
        {view.approved && (
          <div>
            <div className="ux-versions-key">{machineWords("Allowed on this Mac")}</div>
            <div className="ux-versions-value ux-versions-value--was">{view.approved}</div>
          </div>
        )}
        <div>
          <div className="ux-versions-key">{view.approved ? "Now in the repository" : "The repository's install step"}</div>
          <div className="ux-versions-value">{view.approved ? <mark>{view.current}</mark> : view.current}</div>
        </div>
      </div>
      <p className="ux-sheet-hint">{machineWords(installSheetHint(tag))}</p>
      <p className="ux-sheet-hint">{INSTALL_OK_COVERS}</p>
      {error && (
        <p className="ux-sheet-hint" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  );
}
