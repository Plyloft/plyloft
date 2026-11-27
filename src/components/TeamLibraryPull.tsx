import { useEffect, useState } from "react";
import { skillsHubKeepLastCopy, skillsHubLibrarySwitch } from "../ipc";
import { accessLostNotice, leftTeamNotice, libraryPullLine, offlineTeamLine } from "../lib/skillsHub";
import { GH_TROUBLE_DETAILS, splitErrors } from "../lib/ghTrouble";
import { isWindows, machineWords } from "../lib/platform";
import { useSkillsHub } from "../store/skillsHubStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { CBtn, Details, StatusLine } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/** A clock for "4 minutes ago" that ticks on its own, so the page around it
 *  does not re-render as it ages. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * Skills hub H2 (R1, R16): the team library's "Updated 4 minutes ago" — or
 * "Last updated 3 hours ago · offline" — in Settings › Team and the
 * Library's team section.
 */
export function TeamLibraryPullLine({ asNote = false }: { asNote?: boolean }) {
  const view = useSkillsHub((s) => s.team);
  const now = useNow();
  const line = libraryPullLine(view, now);
  if (!line) return null;
  if (asNote) return <p className="ux-section-note">{machineWords(line.text)}</p>;
  return <StatusLine state={line.state}>{machineWords(line.text)}</StatusLine>;
}

/**
 * Skills hub H2: the two notices about the team library that need words of
 * their own — R16's question when GitHub no longer lets this account read it
 * (nothing is switched off until the member says so), and R17's "You're no
 * longer in … team". `onChanged`: the page reads the team again.
 */
export function TeamLibraryNotices({ onChanged }: { onChanged: () => void }) {
  const view = useSkillsHub((s) => s.team);
  const setView = useSkillsHub((s) => s.set);
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const question = accessLostNotice(view, now);
  const left = leftTeamNotice(view);

  async function answer(run: () => Promise<typeof view>, failed: string) {
    setBusy(true);
    try {
      setView(await run());
      onChanged();
    } catch (e) {
      pushErrorToast(failed, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* (Challenger) "this Mac" in it: "this PC" on Windows. */}
      {left && <StatusLine state="aborted">{machineWords(left)}</StatusLine>}
      {question && (
        <>
          <StatusLine state="aborted">{question}</StatusLine>
          <div className="ux-section-note-action">
            <CBtn size="sm" tone="strong" disabled={busy} onClick={() => setConfirming(true)}>
              {machineWords("Switch it off on this Mac")}
            </CBtn>
            <CBtn
              size="sm"
              disabled={busy}
              onClick={() => void answer(skillsHubKeepLastCopy, "Couldn't keep the last copy")}
            >
              Keep the last copy
            </CBtn>
          </div>
        </>
      )}
      {view?.switchedOff && (
        <div className="ux-section-note-action">
          <CBtn
            size="sm"
            disabled={busy}
            onClick={() => void answer(() => skillsHubLibrarySwitch(true), "Couldn't switch it back on")}
          >
            Switch it back on
          </CBtn>
        </div>
      )}
      {confirming && view && (
        <ConfirmDialog
          title={machineWords(`Switch ${view.repo} off on this Mac?`)}
          body={machineWords(
            `Sessions from the next one get no team skills, and Plyloft stops pulling the library. ` +
              `Its copy on this Mac goes to ${isWindows() ? "the Recycle Bin" : "the Trash"}. Sessions already open keep what they have, ` +
              `and skills copied into repositories stay as they are.`,
          )}
          confirmLabel="Switch it off"
          destructive
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void answer(() => skillsHubLibrarySwitch(false), "Couldn't switch it off");
          }}
        />
      )}
    </>
  );
}

/**
 * Settings › Team's read error. Offline (Windows walk of H2): one plain line,
 * "Couldn't reach GitHub. New sessions use the copy from 4 minutes ago.",
 * with git's and gh's own words behind Show details. Anything else stays as
 * the read said it.
 */
export function TeamReadError({ error }: { error: string }) {
  const view = useSkillsHub((s) => s.team);
  const now = useNow();
  const offline = offlineTeamLine(error, view, now);
  if (!offline) return <StatusLine state="aborted">{error}</StatusLine>;
  return (
    <div className="ux-gh-trouble" data-ply-team-offline="">
      <StatusLine state="empty">{machineWords(offline)}</StatusLine>
      <Details summary={GH_TROUBLE_DETAILS}>
        <pre className="ux-output">{splitErrors(error).join("\n")}</pre>
      </Details>
    </div>
  );
}
