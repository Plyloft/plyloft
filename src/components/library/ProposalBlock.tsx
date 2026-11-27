import { useId } from "react";
import { CBtn, DuplicateChip } from "../ux";
import {
  DIFF_MARK_LABEL,
  PROPOSAL_CHIP,
  PROPOSAL_DISMISS,
  PROPOSAL_PROMOTE,
  proposalApproveLabel,
  proposalByline,
  proposalDiff,
  proposalFootnote,
  proposalNoDiff,
  proposalSourceLine,
  type ProposalView,
} from "../../lib/proposals";
import { machineWords } from "../../lib/platform";

/**
 * UX language card 8 (GH #104; BOARDS.md §4 "Improvement proposal (state C)"):
 * the Challenger's one suggested change, on its target's own page.
 *
 * A block above the page's own content: `--raised`, `--border-strong`, radius
 * 10, padding 16 — the duplicate notice's shape, because it is the same kind of
 * thing (something Ply has noticed about this file, with a way out). Then the
 * outlined eyebrow chip, `from the Challenger · 2 hours ago` (`from your
 * correction · …` when that is its source), the reason, the
 * change in words, and the diff in a `--panel-bg` group with line numbers and
 * the `+` mark.
 *
 * **The added lines are never run-state green.** The board tinted them
 * `--signal-done-bg`; run-state colours are not decoration (BOARDS.md §4, the
 * correction), so an added line carries Compare's neutral treatment — the 2 px
 * `--fg` bar and a `--hover` background — and the mark says which it is in a
 * column of its own, for a reader who sees no colour at all.
 *
 * Everything it *says* comes from `lib/proposals.ts`; this file draws.
 */
export function ProposalBlock({
  view,
  busy,
  onApprove,
  onDismiss,
  nowMs,
  target,
  onPromote,
}: {
  view: ProposalView;
  busy: boolean;
  onApprove: () => void;
  onDismiss: () => void;
  /**
   * GH #271: away from its target's own page (the Skills list), the block says
   * which skill it is about — the name and the section it is listed under —
   * and the name opens that skill's page. `onOpen` is null while no row of
   * that name is loaded: the name is then said, not offered.
   */
  target?: { name: string; scope: string; onOpen: (() => void) | null };
  /** GH #271: a personal skill's words-only proposal asks for a Promote, and
   *  offers it here when the page can start one. */
  onPromote?: () => void;
  /** Handed in so the byline is a pure function of the render, and the tests
   *  of `proposalByline` are the tests of what is on screen. */
  nowMs: number;
}) {
  const reasonId = useId();
  const diff = proposalDiff(view);
  // GH #104 walk (C2): the answer's SOURCE, when it named one.
  const source = proposalSourceLine(view);

  return (
    <div className="ux-proposal">
      <div className="ux-proposal-head">
        <DuplicateChip>{PROPOSAL_CHIP}</DuplicateChip>
        <span className="ux-proposal-byline">{proposalByline(view.createdAt, nowMs, view.source)}</span>
      </div>
      {target && (
        <p className="ux-proposal-target">
          About{" "}
          {target.onOpen ? (
            <CBtn tone="quiet" size="sm" className="ux-proposal-target-link" onClick={target.onOpen}>
              {target.name}
            </CBtn>
          ) : (
            <span className="ux-proposal-target-name">{target.name}</span>
          )}
          {` · ${machineWords(target.scope)}`}
        </p>
      )}
      <p id={reasonId} className="ux-proposal-reason">
        {view.reason}
      </p>
      {source && (
        <p className="ux-proposal-source" data-ply-proposal-source="">
          {source}
        </p>
      )}
      <p className="ux-proposal-words">{view.words}</p>
      {diff ? (
        <div className="ux-proposal-diff">
          <div className="ux-proposal-diff-head">
            <span className="ux-mono-fg">{diff.path}</span>
            <span>{diff.count}</span>
          </div>
          <div className="ux-proposal-diff-lines">
            {diff.lines.map((line, i) => (
              <div
                key={i}
                className={
                  line.hunk
                    ? "ux-proposal-line ux-proposal-line--hunk"
                    : line.mark === ""
                      ? "ux-proposal-line"
                      : "ux-proposal-line ux-proposal-line--diff"
                }
              >
                <span className="ux-proposal-no">{line.no ?? ""}</span>
                {/* The mark is the non-colour half of the signal, so it is not
                    hidden from a screen reader either: `role="img"` with the
                    word it stands for — the diff's word, not Compare's. */}
                {line.mark === "" ? (
                  <span className="ux-proposal-mark" aria-hidden />
                ) : (
                  <span
                    className="ux-proposal-mark"
                    role="img"
                    aria-label={DIFF_MARK_LABEL[line.mark]}
                  >
                    {line.mark}
                  </span>
                )}
                <span className="ux-proposal-text">{line.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* A personal, Team or Ply target: the proposal is words only, and says
           so rather than leaving an empty space where a diff would be. */
        <p className="ux-proposal-nodiff">{machineWords(proposalNoDiff(view))}</p>
      )}
      {view.canApprove && view.copiesNote && (
        <p className="ux-proposal-source" data-ply-proposal-copies="">
          {view.copiesNote}
        </p>
      )}
      <div className="ux-proposal-actions">
        {/* No `Approve and publish` for a read-only collaborator, and none for
            a proposal with no diff to publish: a button that cannot work is not
            offered (PATTERNS.md §3). The sentence under the actions is what
            explains the one that is there. */}
        {view.canApprove && (
          <CBtn
            tone="accent"
            disabled={busy}
            aria-describedby={reasonId}
            onClick={onApprove}
          >
            {proposalApproveLabel(view)}
          </CBtn>
        )}
        {!diff && view.scope === "this-mac" && onPromote && (
          <CBtn tone="accent" disabled={busy} onClick={onPromote}>
            {PROPOSAL_PROMOTE}
          </CBtn>
        )}
        <CBtn tone="quiet" disabled={busy} onClick={onDismiss}>
          {PROPOSAL_DISMISS}
        </CBtn>
        {view.canApprove ? (
          <span className="ux-proposal-beside">{proposalFootnote(view)}</span>
        ) : (
          view.approveBlocked && (
            <span className="ux-proposal-beside" data-ply-proposal-blocked="">
              {view.approveBlocked}
            </span>
          )
        )}
      </div>
    </div>
  );
}
