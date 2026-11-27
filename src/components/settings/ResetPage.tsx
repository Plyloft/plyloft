import { useRef, useState } from "react";
import { CBtn, DangerZone, Row, Section, Sheet } from "../ux";
import { useSettings } from "../../store/settingsStore";
import { resetAllOnThisMac, resetAllPaths } from "../../lib/settingsFields";
import { pushToast } from "../../store/toastStore";
import { machineWords } from "../../lib/platform";

/**
 * UX language card 8 (GH #103; BOARDS.md §5 "Empty state and danger zone"):
 * Settings › Advanced › Reset. Since C9 (UX-9.3) it is not a page of its own:
 * it is the danger zone at the foot of Account › Diagnostics.
 *
 * One row, in a group bordered `--signal-aborted-border`, whose action is the
 * `--danger` button — text, transparent, the same border — and one
 * confirmation. The board's second row, `Forget this Mac's run history`, is
 * recorded there as "a feature nobody asked for" and is not built.
 *
 * What goes back is the preferences, not the file: `resetAllOnThisMac` keeps
 * the blocks that record something rather than prefer it. Replacing the whole
 * file — which is what `Reset all settings to defaults` did before this card —
 * brought the welcome screen back, switched every Ply skill on again, and
 * blanked the git identity stamped on shared records until the next launch.
 */
export function ResetThisMac() {
  const resetSettings = useSettings((s) => s.reset);
  const [asking, setAsking] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setBusy(true);
    // 1.176.3 (owner): every block it puts back goes back whatever wrote it
    // — Program folders Plyloft wrote after this window last heard too.
    resetSettings(resetAllOnThisMac, resetAllPaths())
      .then(() => {
        setAsking(false);
        // Review 2, optional: the sheet named what it keeps, so the toast does
        // too. "Every setting on this Mac" on its own is a wider claim than
        // what `resetAllOnThisMac` does.
        pushToast({
          kind: "info",
          title: "Every preference on this Mac is back to how Plyloft ships.",
          body: "Your workspaces, cards, notes and skills, the team this Mac is in and where team workspaces are cloned were kept.",
        });
      })
      .catch((e) =>
        pushToast({ kind: "error", title: "Couldn't reset this Mac", details: String(e) }),
      )
      .finally(() => setBusy(false));
  }

  return (
    <>
      {/* scope: none — the title says this Mac already; a mark read "Reset this Mac on this Mac" (G1 walk, 1.174.1 Windows walk). */}
      <Section title="Reset this Mac">
        <DangerZone>
          <Row
            kind="procedure"
            label="Reset all settings on this Mac"
            hint="Appearance, models, notifications and window sizes go back to how Plyloft ships. Your workspaces, cards and skills are untouched."
            action={
              <CBtn tone="danger" onClick={() => setAsking(true)}>
                Reset
              </CBtn>
            }
          />
        </DangerZone>
      </Section>
      {asking && (
        <Sheet
          title="Reset every setting on this Mac?"
          size="confirm"
          lede="The theme, the accent, the tile shell and program folders, the editor, the models and their effort, the notifications, where a workspace opens, dictation and the remembered window sizes all go back to how Plyloft ships. Kept: your workspaces, cards, notes and skills; the team this Mac is in and where team workspaces are cloned; and the answers you have already given Plyloft once."
          onClose={() => (busy ? undefined : setAsking(false))}
          initialFocusRef={cancelRef}
          actions={
            <>
              <CBtn ref={cancelRef} onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </CBtn>
              <CBtn tone="danger" className="ux-danger-fill" onClick={reset} disabled={busy}>
                {busy ? "Resetting…" : machineWords("Reset this Mac")}
              </CBtn>
            </>
          }
        />
      )}
    </>
  );
}
