// 1.175.0 B1 (SEC-1, scene 1.7): Promote to Team of a repository skill whose
// text asks to run things goes through this page instead of acting at once
// (the proof: it went with nothing on screen). The page says where it goes,
// what its text asks for and what happens on the other computers; pressing
// Share is this computer's OK for that text. No new button: Cancel and Share.
import { CBtn, StatusLine } from "../ux";
import { machineWords } from "../../lib/platform";
import { shareAsksLine, type StrongestAsk } from "../../lib/skillAsks";

export function ShareAskingFlow({
  name,
  asks,
  teamRepo,
  note,
  refusal,
  busy,
  onCancel,
  onShare,
}: {
  name: string;
  asks: StrongestAsk;
  /** `owner/repo` of the team library, when known. */
  teamRepo: string | null;
  /** Which copy Promote shares, when it isn't this project folder's. */
  note?: string | null;
  /** Round 2 (G6): why the press would be refused, in the backend's words —
   *  said in place of the status line, with the button off, as a personal
   *  skill's Share page says it (`PromoteFlow`). */
  refusal?: string | null;
  busy: boolean;
  onCancel: () => void;
  onShare: () => void;
}) {
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">Share · 1 step</p>
      <h2 className="ux-flow-title">
        Share <span className="ux-mono-fg">{name}</span>
      </h2>
      <p className="ux-page-lede">
        {machineWords(
          `Goes to ${teamRepo ?? "your team's repository"} on GitHub. Everyone on your team can read it, and every Mac gets it at its next refresh.`,
        )}
      </p>
      {note && <StatusLine state="empty">{note}</StatusLine>}
      {refusal ? (
        <StatusLine state="aborted">{refusal}</StatusLine>
      ) : (
        <StatusLine state="empty">{machineWords(shareAsksLine(asks))}</StatusLine>
      )}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn tone="accent" onClick={onShare} disabled={busy || !!refusal}>
          {busy ? "Sharing…" : teamRepo ? `Share with ${teamRepo}` : "Share"}
        </CBtn>
      </div>
    </div>
  );
}
