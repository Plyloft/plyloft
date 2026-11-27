import { forMachine } from "./Page";
import type { ReactNode } from "react";

/** The bar's name where its changes are published. */
export const PUBLISH_BAR_LABEL = "Changes not published yet";
/** Where they are only saved on this Mac (Settings › Project › Areas kept
 *  here): the name agrees with "stays on this Mac only". */
export const SAVE_BAR_LABEL = "Changes not saved yet";

/**
 * UX language card 2 (BOARDS.md §2 "Publish bar", SHEET.md "PublishBar"):
 * the bar a page raises from its bottom while it holds changes nobody else
 * has. Left: the sentence, and under it one jump per change that scrolls to
 * its row. Right: the actions, never more than three.
 *
 * The page reserves 48 px at its end (`.ux-page-footer` is sticky), so the
 * bar never covers the last row.
 */
export function PublishBar({
  sentence,
  detail,
  jumps,
  actions,
  state = "draft",
  label = PUBLISH_BAR_LABEL,
}: {
  sentence: ReactNode;
  /** The second line: what is true while a publish waits. */
  detail?: ReactNode;
  /** One per change, numbered as the row's mark is. */
  jumps?: { n: number; label: string; onSelect: () => void }[];
  actions: ReactNode;
  /** `waiting` and `publishing` carry a dot instead of jumps. */
  state?: "draft" | "waiting" | "publishing";
  /** The bar's name for a screen reader, in the words its sentence uses: a
   *  page that saves on this Mac only names it "Changes not saved yet". */
  label?: string;
}) {
  const dot =
    state === "publishing"
      ? "ux-publish-dot ux-publish-dot--running"
      : "ux-publish-dot ux-publish-dot--empty";
  return (
    <div className="ux-publish" role="region" aria-label={label}>
      <div className="ux-publish-main">
        <p className="ux-publish-sentence">
          {state !== "draft" && <span className={dot} aria-hidden />}
          {forMachine(sentence)}
        </p>
        {/* G2 Windows walk: "this PC" on Windows, as every page line. */}
        {detail && <p className="ux-publish-detail">{forMachine(detail)}</p>}
        {jumps && jumps.length > 0 && (
          <div className="ux-publish-jumps">
            {jumps.map((j) => (
              <button
                key={j.n}
                type="button"
                className="ux-publish-jump"
                onClick={j.onSelect}
              >
                <span className="ux-publish-jump-n">{j.n}</span>
                {j.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="ux-publish-actions">{actions}</div>
    </div>
  );
}
