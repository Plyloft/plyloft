import { CBtn, StatusLine } from "../ux";
import { moreLines, previewLines } from "../../lib/libraryInstructions";
import { MARK_LABEL } from "../../lib/librarySkills";
import type { InstructionFlowPlan } from "../../ipc";

/**
 * UX language card 6 (GH #101; BOARDS.md §5 "The flow"): the one step the
 * `Agent instructions` row opens.
 *
 * A surface of its own in the centre, with **no navigation around it**
 * (PATTERNS.md §6): the Library's inner column and its narrow controls go while
 * this is open — the host reads the flow out of `libraryStore` to do that, the
 * way #96's `PromoteFlow` does. Eyebrow, the question, what Ply will do, the
 * before and after of the file that changes, what changes on disk, whom it
 * reaches, then `Cancel` · `Set up`.
 *
 * Every string here is the backend's: the title, the lede, the disk lines and the
 * reach line are answers about files Rust read, and a second set of words in the
 * window would be a second opinion about them.
 */
export function InstructionsFlow({
  plan,
  busy,
  onCancel,
  onSetUp,
}: {
  plan: InstructionFlowPlan;
  busy: boolean;
  onCancel: () => void;
  onSetUp: () => void;
}) {
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">{plan.eyebrow}</p>
      <h2 className="ux-flow-title">{plan.title}</h2>
      <p className="ux-page-lede">{plan.lede}</p>
      <div className="ux-compare">
        {/* Marks on the After panel only, as BOARDS.md §5 draws them: the step's
            one added line is `+ @AGENTS.md`. Marking Before too called every one
            of its lines `only here` right above `The 212 lines move to AGENTS.md,
            unchanged.` (GH #101 review 2). */}
        <Side label={`Before · ${plan.compared}`} text={plan.before} />
        <Side
          label={`After · ${plan.compared}`}
          text={plan.after}
          against={plan.before}
        />
      </div>
      {plan.note && <p className="ux-compare-summary">{plan.note}</p>}
      <div className="ux-flow-section">
        <h3 className="ux-flow-heading">What changes on disk</h3>
        <ul className="ux-flow-disk">
          {plan.disk.map((line) => (
            <li key={line} className="ux-flow-disk-line">
              {line}
            </li>
          ))}
        </ul>
      </div>
      <StatusLine state="empty">{plan.reach}</StatusLine>
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn tone="accent" onClick={onSetUp} disabled={busy}>
          {busy ? "Setting up…" : "Set up"}
        </CBtn>
      </div>
    </div>
  );
}

/**
 * One of the two panels: its first lines, then how many more there are.
 *
 * `against` is the other panel's text, and only the After panel is given it — the
 * board marks the added line there and nowhere else. The mark is that panel's own
 * (`+` = only here) and carries `MARK_LABEL`'s word, so a reader who cannot see
 * the glyph gets it too: the per-column rule #100's review fixed.
 */
function Side({
  label,
  text,
  against,
}: {
  label: string;
  text: string | null;
  against?: string | null;
}) {
  // Called without `against` when this panel draws no marks, which is what the
  // Before panel is: passing `undefined` through would be a third meaning.
  const { lines, more } =
    against === undefined ? previewLines(text) : previewLines(text, against);
  const rest = moreLines(more);
  return (
    <div className="ux-compare-side">
      <p className="ux-compare-head">{label}</p>
      <div className="ux-compare-lines">
        {text == null && (
          <div className="ux-compare-line">
            <span className="ux-compare-text">(not in this repository yet)</span>
          </div>
        )}
        {lines.map((line) => (
          <div
            className={
              line.mark ? "ux-compare-line ux-compare-line--diff" : "ux-compare-line"
            }
            key={`${line.no}-${line.text}`}
          >
            <span className="ux-compare-no">{line.no}</span>
            <span
              className="ux-compare-mark"
              aria-label={line.mark ? MARK_LABEL[line.mark] : undefined}
            >
              {line.mark}
            </span>
            <span className="ux-compare-text">{line.text === "" ? " " : line.text}</span>
          </div>
        ))}
        {rest && (
          <div className="ux-compare-line">
            <span className="ux-compare-no" />
            <span className="ux-compare-mark" />
            <span className="ux-compare-text">{rest}</span>
          </div>
        )}
      </div>
    </div>
  );
}
