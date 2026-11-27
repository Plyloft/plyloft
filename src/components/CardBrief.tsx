import { useEffect, useId, useRef, useState } from "react";

import { CBtn } from "./ux";
import { machineWords } from "../lib/platform";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import {
  BRIEF_MORE_DETAIL_LABEL,
  BRIEF_PLAN_LABEL,
  BRIEF_SETUP_CHANGE_LABEL,
  BRIEF_SETUP_CHANGE_TITLE,
} from "../lib/briefSetup";

/**
 * 1.172.0 (C1; CP-12, CF B4): under What you want on a card not built yet —
 * who builds it, how it asks, who reviews it — and Change…, which takes the
 * person to the card's own pickers.
 */
export function BriefSetupLine({
  line,
  more,
  onChange,
  open,
  controls,
}: {
  line: string;
  /** 1.176.3: the sentences after it (what it uses, that it can be undone). */
  more?: string;
  /** Absent: the facts line's Change… is the card's one (F10). */
  onChange?: () => void;
  /** F10: the card's one Change… before the build — a disclosure. */
  open?: boolean;
  controls?: string;
}) {
  return (
    <>
      <p className="ux-card-muted ux-card-brief-setup" data-ply-brief-setup="">
        {machineWords(line)}{" "}
        {onChange && (
        <CBtn
          tone="quiet"
          size="sm"
          title={BRIEF_SETUP_CHANGE_TITLE}
          aria-expanded={open}
          aria-controls={controls}
          data-ply-card-change=""
          onClick={onChange}
        >
          {BRIEF_SETUP_CHANGE_LABEL}
        </CBtn>
        )}
        {more && (
          <>
            <br />
            <span data-ply-brief-setup-more="">{machineWords(more)}</span>
          </>
        )}
      </p>
    </>
  );
}

/**
 * 1.172.0 (C1, CP-13): the plan a planning conversation wrote (the card's
 * `dispatchPrompt`), in the Brief block — read as text, Edit opens it as a
 * field. It is what Start build sends; it was "The plan Claude wrote" under
 * More about this card.
 */
export function BriefPlan({
  plan,
  onPlan,
  onCommit,
  edited,
  locked,
  readOnly,
}: {
  plan: string;
  onPlan: (next: string) => void;
  onCommit: () => void;
  /** Changed by the person since the planning conversation wrote it. */
  edited: boolean;
  /** Claude (or Codex) is still writing it. */
  locked: boolean;
  /** A done card's brief is read, not changed (1.171.0 E2). */
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (locked || readOnly) setEditing(false);
  }, [locked, readOnly]);
  const canEdit = !locked && !readOnly;
  return (
    <div className="ux-card-field" data-ply-brief-plan="">
      <div className="ux-card-brief-plan-head">
        <h3 id={headingId} className="ux-card-field-label">
          {BRIEF_PLAN_LABEL}
        </h3>
        {edited && (
          <span className="ux-card-field-note" title="Edited since the planning conversation wrote it">
            · edited by you
          </span>
        )}
        {canEdit && !editing && (
          <>
            <span className="ux-card-field-note" aria-hidden="true">
              ·
            </span>
            <CBtn tone="quiet" size="sm" aria-describedby={headingId} onClick={() => setEditing(true)}>
              Edit
            </CBtn>
          </>
        )}
      </div>
      {editing ? (
        <textarea
          ref={field}
          className="ux-card-textarea ux-card-textarea--mono"
          aria-labelledby={headingId}
          rows={8}
          value={plan}
          onChange={(e) => onPlan(e.target.value)}
          onBlur={() => {
            onCommit();
            setEditing(false);
          }}
        />
      ) : (
        <p className="ux-card-plain ux-card-brief-plan">
          {plan}
        </p>
      )}
      {locked && <p className="ux-card-muted">It can be edited once the planning conversation has finished.</p>}
    </div>
  );
}

/**
 * 1.172.0 (C1, CP-13): "More detail (optional)" — the card's `knowledge`,
 * which goes to the Builder with the brief. It was "Notes for the Builder"
 * under More about this card: the same field, in the Brief block.
 */
export function BriefMoreDetail({
  value,
  onChange,
  onCommit,
  ownedReadOnly,
  readOnly,
}: {
  value: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  /** A GitHub board without a team licence: the owned fields can't change. */
  ownedReadOnly: boolean;
  /** A done card's brief is read, not changed (1.171.0 E2). */
  readOnly: boolean;
}) {
  const headingId = useId();
  return (
    <div className="ux-card-field" data-ply-brief-more="">
      <h3 id={headingId} className="ux-card-field-label">
        {BRIEF_MORE_DETAIL_LABEL}
      </h3>
      <textarea
        className="ux-card-textarea"
        aria-labelledby={headingId}
        rows={3}
        value={value}
        disabled={ownedReadOnly}
        readOnly={readOnly}
        title={ownedReadOnly ? TEAM_BOARD_READ_ONLY_MESSAGE : undefined}
        placeholder="Anything longer the Builder should know: links, constraints, what was tried."
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
      />
    </div>
  );
}
