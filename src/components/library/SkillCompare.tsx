import { CBtn, Section, StatusLine } from "../ux";
import { InlineMd } from "../InlineMd";
import {
  MARK_LABEL,
  compareSkillText,
  compareSummary,
  type CompareAction,
  type ComparedLine,
} from "../../lib/librarySkills";

/**
 * UX language card 5 (GH #100; BOARDS.md §4 "Duplicate (state B)", corrected):
 * `Compare` — the two `SKILL.md`, side by side, **under the skill's page**.
 *
 * Nothing wins (ADR 0005, corrected on the boards 2026-09-17): both copies reach
 * the agents, so this answers the one question a duplicate raises — do they say
 * the same thing? A differing line carries the 2 px `--fg` bar, the `--hover`
 * background and the mark in its own column; no run-state colour, because a
 * difference is not a run state, and never colour alone — `≠ + −` say it, and
 * the sentence underneath says it in words.
 *
 * GH #96 had this as a sub-page of the **list**, reading both files itself. Board
 * 3 puts it under the skill's own header, and the reading has moved up to the
 * Library (`useSkillsData.pairTexts`): the same two texts decide whether the
 * notice is silenced on this Mac — their content ids are the mute's key — so
 * reading them here as well would be two answers to one question.
 */
export function SkillCompare({
  name,
  left,
  right,
  error,
  actions,
  busy,
  onAction,
  onHide,
  title = "The two versions, side by side",
  pair = false,
  hideButton = true,
  note = null,
}: {
  name: string;
  /**
   * The two sides, each named by **where it is**: a scope (`Repository · in use
   * here`) for a duplicated name, and a CLI's root for the branch's own two
   * copies (GH #105). The words are the caller's, because only the caller knows
   * which pair of files this is; `place` is the phrase the summary sentence puts
   * a count into ("2 lines only in the team library").
   */
  left: { label: string; meaning: string; place: string; text: string | null };
  right: { label: string; meaning: string; place: string; text: string | null };
  /** Why one of the two could not be read. */
  error: string | null;
  /** `Keep both` · `Remove from <branch>` · `Promote this one to Team`, or
   *  `Align` for the branch's own two copies. Empty while there is nothing to
   *  act on — which is what a read-only collaborator sees. */
  actions: CompareAction[];
  busy: boolean;
  onAction: (action: CompareAction) => void;
  /**
   * Put the comparison away again.
   *
   * The board does not draw it, because it draws the moment the comparison
   * opens. It is needed: once `Keep both` has silenced the notice the comparison
   * is reached from the `⋯`, and there is no notice left to toggle — without this
   * the only way out would be leaving the page.
   */
  onHide: () => void;
  /** The section's heading. Skills hub H4 (Mac walk): a linked copy's
   *  Compare names the file instead of claiming a layout. */
  title?: string;
  /** H4 Mac walk: keep the two side by side down to a narrow flow (a
   *  container query), as the 3-way Compare keeps its three. */
  pair?: boolean;
  /** H4 Windows walk: a flow that draws its own Close leaves out this
   *  section's Hide (it read as hiding the section, and closed the view). */
  hideButton?: boolean;
  /** Walk follow-ups 2026-10-19: which copy the actions below share, when it
   *  isn't the side shown (the row's own note, word for word). */
  note?: string | null;
}) {
  const lines =
    left.text != null && right.text != null
      ? compareSkillText(left.text, right.text)
      : null;

  return (
    <Section
      title={title}
      count={
        hideButton ? (
          <CBtn tone="quiet" size="sm" onClick={onHide}>
            Hide
          </CBtn>
        ) : undefined
      }
    >
      {error && (
        <StatusLine state="aborted">
          Plyloft could not read both copies of <span className="ux-mono-fg">{name}</span>,
          so there is nothing to compare. Nothing was changed. {error}
        </StatusLine>
      )}
      {lines && (
        <>
          <div className={pair ? "ux-compare ux-compare--pair" : "ux-compare"}>
            <Side heading={`${left.label} · ${left.meaning}`} lines={lines} side="left" />
            <Side heading={`${right.label} · ${right.meaning}`} lines={lines} side="right" />
          </div>
          {/* The two sides are named by where they live, not "left" and "right":
              under 760 px of column they are stacked, and there is no left. */}
          <p className="ux-compare-summary">
            {compareSummary(lines, left.place, right.place)}
          </p>
          {note && (
            <p className="ux-compare-summary">
              <InlineMd text={note} links={false} />
            </p>
          )}
          {/* One action per way out (BOARDS.md §4). `Keep both` is first and
              primary: it is the one that changes nothing anybody else can see. */}
          {actions.length > 0 && (
            <div className="ux-compare-actions">
              {actions.map((action, i) => (
                <CBtn
                  key={action.id}
                  tone={i === 0 ? "accent" : action.id === "remove-from-branch" ? "danger" : "quiet"}
                  disabled={busy}
                  onClick={() => onAction(action)}
                >
                  {action.label}
                </CBtn>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function Side({
  heading,
  lines,
  side,
}: {
  heading: string;
  lines: ComparedLine[];
  side: "left" | "right";
}) {
  const kept = lines.filter((l) => (side === "left" ? l.left : l.right) !== null);
  return (
    <div className="ux-compare-side">
      <div className="ux-compare-head">
        {heading} · {kept.length === 1 ? "1 line" : `${kept.length} lines`}
      </div>
      <div className="ux-compare-lines">
        {lines.map((line, i) => {
          const text = side === "left" ? line.left : line.right;
          const no = side === "left" ? line.leftNo : line.rightNo;
          if (text === null) {
            // The other side of a one-sided line: a neutral blank that only
            // keeps the two columns level (owner, 2026-10-20). No mark, no
            // `(nothing here)`, no bar or shading — drawn as a removed line it
            // read as a deletion opposite a pure addition. Out of the reading
            // too: the `+` on the other side already says "only here".
            return (
              <div key={i} className="ux-compare-line ux-compare-line--blank" aria-hidden="true">
                <span className="ux-compare-no" />
                <span className="ux-compare-mark" />
                <span className="ux-compare-text">{" "}</span>
              </div>
            );
          }
          // **This column's** mark, not the pair's: `+` sits with the text, as
          // BOARDS.md §4 draws it. One mark for both columns made the empty one
          // announce "only here" (review 1, MAJOR).
          const mark = side === "left" ? line.leftMark : line.rightMark;
          return (
            <div
              key={i}
              className={
                mark === ""
                  ? "ux-compare-line"
                  : "ux-compare-line ux-compare-line--diff"
              }
            >
              <span className="ux-compare-no">{no ?? ""}</span>
              {/* The mark is the non-colour half of the signal, so it is not
                  hidden from a screen reader either: `role="img"` with the word
                  it stands for. An identical line's column is empty and stays
                  out of the reading. */}
              {mark === "" ? (
                <span className="ux-compare-mark" aria-hidden />
              ) : (
                <span className="ux-compare-mark" role="img" aria-label={MARK_LABEL[mark]}>
                  {mark}
                </span>
              )}
              <span className="ux-compare-text">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
