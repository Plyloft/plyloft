// 1.175.0 (D3, mockup two-people.html#d3): the card's notice when a part of
// its issue changed on GitHub while the member changed it here too. Calm: no
// tint, no bar; the two versions whole, side by side, with what differs in
// weight (never coloured, never "+" and "−"); two plain buttons of the same
// width, the focus on *Use GitHub's*. Nothing was written, and nothing is
// until one is pressed.
import { useEffect, useRef, useState } from "react";
import type { KanbanCard } from "../ipc";
import {
  conflictBody,
  conflictTitle,
  KEEP_MINE_LABEL,
  markedLines,
  USE_GITHUBS_LABEL,
  versionHeadings,
  type EditConflict,
} from "../lib/editConflict";
import { answerEditConflict } from "../lib/editConflictActions";
import { machineWords } from "../lib/platform";
import { CBtn } from "./ux";

function Version({ heading, text, other }: { heading: string; text: string; other: string }) {
  return (
    <div>
      <div className="ux-versions-key">{heading}</div>
      <div className="ux-versions-value ux-edit-conflict-text">
        {markedLines(text, other).map((l, i) => (
          <div key={i}>{l.differs ? <mark>{l.line}</mark> : l.line || " "}</div>
        ))}
      </div>
    </div>
  );
}

export function EditConflictNotice({ card, conflict }: { card: KanbanCard; conflict: EditConflict }) {
  const [busy, setBusy] = useState(false);
  const safe = useRef<HTMLButtonElement>(null);
  // The focus is on the safe answer when the question appears (it appears
  // after the field was left: the save is what raised it).
  useEffect(() => {
    safe.current?.focus();
  }, [conflict.part, conflict.theirs]);
  const mine = conflict.part === "title" ? card.title : (card.notes ?? "");
  const headings = versionHeadings(conflict);
  const answer = (keep: "github" | "mine") => {
    if (busy) return;
    setBusy(true);
    void answerEditConflict(card, conflict, keep).finally(() => setBusy(false));
  };
  return (
    <div className="ux-edit-conflict" role="group" aria-label={conflictTitle(conflict, Date.now())} data-ply-edit-conflict={conflict.part}>
      <p className="ux-edit-conflict-title">{conflictTitle(conflict, Date.now())}</p>
      <p className="ux-card-muted">{conflictBody(conflict.part, card.ghIssueNumber)}</p>
      <div className={conflict.part === "title" ? "ux-versions ux-versions--rows" : "ux-versions"}>
        <Version heading={headings.theirs} text={conflict.theirs} other={mine} />
        <Version heading={machineWords(headings.mine)} text={mine} other={conflict.theirs} />
      </div>
      <div className="ux-edit-conflict-actions">
        <CBtn ref={safe} size="sm" disabled={busy} onClick={() => answer("github")}>
          {USE_GITHUBS_LABEL}
        </CBtn>
        <CBtn size="sm" disabled={busy} onClick={() => answer("mine")}>
          {KEEP_MINE_LABEL}
        </CBtn>
      </div>
    </div>
  );
}
