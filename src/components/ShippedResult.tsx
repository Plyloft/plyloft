import { useEffect, useState } from "react";
import { cardShippedChanges, type KanbanCard, type ShippedChanges } from "../ipc";
import { challengerFact, checksFact, dayWords, pushbackAccepted } from "../lib/cardPage";
import { useSettings } from "../store/settingsStore";
import { ownShipEntry, shippedWords } from "../lib/shipVersion";
import { shippedResultLine, whatShippedName } from "../lib/prStatus";
import { localShipOnGitHub } from "../lib/deliveryStage";
import { useSentToGitHub } from "../store/sentToGitHubStore";
import { StateWord, StatusLine } from "./ux";
import { cardHasNoChecks, checkStepWords } from "../lib/checksWords";

/**
 * QoL 1.168 (C8, block 5.3): "The result" of a card that shipped. Its copy of
 * the repository is gone, so the result can't be read from it any more; what
 * shipped is: the files its shipped commit changed (read from the project
 * folder's history, `card_shipped_changes`), the checks that ran before it
 * and the Challenger's last word. Activity's "See the changes" and "See the
 * checks" open this — never an empty section.
 */
export function ShippedResult({ card }: { card: KanbanCard }) {
  // 1.175.0 F3 walk (R13): a land here GitHub has since isn't "only here".
  const sent = useSentToGitHub((s) => s.byWorkspace[card.workspaceId]);
  const [changes, setChanges] = useState<ShippedChanges | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // 1.174.0 (DR2 round 1): the card's own ship, not a release that carried it.
  const commit = card.commitSha ?? ownShipEntry(card)?.commitSha ?? null;
  useEffect(() => {
    let cancelled = false;
    setChanges(null);
    setFailed(null);
    cardShippedChanges(card.workspaceId, card.id).then(
      (read) => {
        if (!cancelled) setChanges(read);
      },
      (e: unknown) => {
        // The backend's own sentences ("The shipped commit isn't in this
        // computer's copy…") are said; anything else is not shown raw.
        const said = e instanceof Error ? e.message : String(e);
        if (!cancelled) setFailed(/^(The|This) /.test(said) ? said : "Plyloft couldn't read what shipped.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [card.workspaceId, card.id, commit]);

  const now = Date.now();
  const shippedLine = shippedResultLine(card, shippedWords, (at) => dayWords(at, now), localShipOnGitHub(card, sent));
  const shippedName = whatShippedName(card, changes?.subject);
  const checks = checksFact(card, "shipped");
  const review = challengerFact(card, "shipped", useSettings.getState().settings.identity?.userEmail ?? null);
  const lastRun = card.verifyHistory?.[card.verifyHistory.length - 1] ?? null;
  const steps = lastRun?.steps ?? [];

  return (
    <div className="ux-card-outcome" data-ply-shipped-result="">
      <StatusLine state="done">{shippedLine}</StatusLine>

      {/* 1.172.0 D2: the section is What shipped; this is its files. */}
      <section className="ux-card-outcome-block" aria-label="The files">
        <h3 className="ux-card-subheading">The files</h3>
        {changes ? (
          <>
            <p className="ux-card-muted">
              {changes.sharedWith > 0
                ? // A batch release: its files are every card's, not this one's.
                  `Shipped in a release with ${changes.sharedWith} other card${changes.sharedWith === 1 ? "" : "s"}.`
                : changes.totalFiles === 0
                ? "The shipped commit changed no files."
                : `${changes.totalFiles} file${changes.totalFiles === 1 ? "" : "s"} changed${
                    shippedName ? ` — ${shippedName}` : ""
                  }.`}{" "}
              <code className="ux-card-mono">{changes.commit.slice(0, 10)}</code>
            </p>
            {changes.files.length > 0 && (
              <ul className="ux-card-ships" aria-label="The files that shipped">
                {changes.files.map((f) => (
                  <li key={f.path} className="ux-card-ship">
                    <code className="ux-card-mono">{f.path}</code>
                    <span className="ux-card-muted-inline">
                      {f.added == null ? "binary" : `+${f.added} −${f.removed ?? 0}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {changes.totalFiles > changes.files.length && (
              <p className="ux-card-muted">And {changes.totalFiles - changes.files.length} more.</p>
            )}
          </>
        ) : failed ? (
          <p className="ux-card-muted">{failed}</p>
        ) : (
          <p className="ux-card-muted">Reading what shipped…</p>
        )}
      </section>

      {/* 1.172.0 D2 (walk#6): with none set up, the facts line says so — once. */}
      {!cardHasNoChecks(card) && <section className="ux-card-outcome-block" aria-label="Checks">
        <div className="ux-card-challenge-head">
          <h3 className="ux-card-subheading">Checks</h3>
          <StateWord state={checks.state}>{checks.word}</StateWord>
        </div>
        {steps.length > 0 && (
          <ul className="ux-card-ships" aria-label="The checks">
            {steps.map((s, i) => (
              <li key={`${s.kind}-${i}`} className="ux-card-ship">
                <StateWord state={s.passed ? "done" : "aborted"}>
                  {/* 1.172.0 D2 (CP-26): its name; the kind is its tooltip. */}
                  <span title={s.kind} data-ply-check-kind={s.kind}>{checkStepWords(s.kind)}</span>
                </StateWord>
                <span className="ux-card-muted-inline">{s.passed ? "passed" : "failed"}</span>
                <span className="ux-card-ship-when">{Math.round(s.elapsedMs / 1000)}s</span>
              </li>
            ))}
          </ul>
        )}
      </section>}

      <section className="ux-card-outcome-block" aria-label="The Reviewer">
        <div className="ux-card-challenge-head">
          <h3 className="ux-card-subheading">The Reviewer</h3>
          <StateWord state={review.state}>{review.word}</StateWord>
        </div>
        {/* 1.174.0 C5 round 1: Activity's "Why it was skipped" lands here. */}
        {card.builder?.review && card.builder.review.status === "skipped" && !pushbackAccepted(card.builder.review) && <SkippedReviewLine />}
      </section>
    </div>
  );
}

/** 1.174.0 C5 round 1: why the review was skipped — where Activity's "Why
 *  it was skipped" lands (`data-ply-review-part="skipped"`, focusable). */
export function SkippedReviewLine() {
  return (
    <div data-ply-review-part="skipped" role="group" tabIndex={-1} aria-label="Why the review was skipped">
      <StatusLine state="empty">You skipped the review of the latest build.</StatusLine>
    </div>
  );
}
