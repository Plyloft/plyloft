import { showBackendText } from "../lib/backendMarks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  reviewerCapabilityProbe,
  reviewerList,
  reviewerRun,
  type ReviewerCapability,
  type ReviewerCapabilityLevel,
  type ReviewerView,
} from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { pushToast } from "../store/toastStore";
import { isFolderTrustRefusal } from "../lib/claudeReviewTrust";
import { incompleteReasonWords, reviewBaseWords } from "../lib/challengerReview";
import { ClaudeReviewTrustStep } from "./ClaudeReviewTrust";
import { Details } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

const LABEL: Record<ReviewerCapabilityLevel, string> = {
  "os-sandboxed": "OS sandboxed",
  "harness-enforced": "Harness enforced",
  "prompt-only": "Prompt only",
};

type Provider = "claude" | "codex";

export function IndependentReview({
  workspaceId,
  cardId,
  onFreshnessChange,
  onRerunStaleReady,
}: {
  workspaceId: string;
  cardId: string;
  onFreshnessChange?: (freshness: "none" | "fresh" | "stale") => void;
  onRerunStaleReady?: (handler: (() => Promise<void>) | null) => void;
}) {
  const doctor = useDoctor((state) => state.report);
  const refreshDoctor = useDoctor((state) => state.refresh);
  const [reviews, setReviews] = useState<ReviewerView[]>([]);
  const [busy, setBusy] = useState<Provider | null>(null);
  // Claude's probe stopped at its folder-trust question: the trust step
  // below says what to do.
  const [trustRefused, setTrustRefused] = useState(false);

  const load = useCallback(async () => {
    try {
      setReviews(await reviewerList(workspaceId, cardId));
    } catch {
      setReviews([]);
    }
  }, [workspaceId, cardId]);

  useEffect(() => {
    setReviews([]);
    void load();
    if (!doctor) void refreshDoctor();
  }, [cardId, load, doctor, refreshDoctor]);

  const capabilities = useMemo(() => {
    const result = new Map<Provider, ReviewerCapability>();
    for (const tool of doctor?.tools ?? []) {
      if ((tool.id === "claude" || tool.id === "codex") && tool.reviewer) {
        result.set(tool.id, tool.reviewer);
      }
    }
    return result;
  }, [doctor]);

  const latest = useMemo(() => {
    const result = new Map<Provider, ReviewerView>();
    for (const review of reviews) {
      const provider = review.record.provider;
      if (
        (provider === "claude" || provider === "codex") &&
        !result.has(provider)
      ) {
        result.set(provider, review);
      }
    }
    return result;
  }, [reviews]);

  const freshness = useMemo<"none" | "fresh" | "stale">(() => {
    const values = [...latest.values()];
    if (values.some((review) => review.valid)) return "fresh";
    if (values.some((review) => review.stale)) return "stale";
    return "none";
  }, [latest]);
  useEffect(() => {
    onFreshnessChange?.(freshness);
  }, [cardId, freshness, onFreshnessChange]);

  const probe = async (provider: Provider) => {
    setBusy(provider);
    try {
      await reviewerCapabilityProbe(provider);
      await refreshDoctor();
      pushToast({
        kind: "info",
        title: "Reviewer proof updated",
        body: `${provider === "claude" ? "Claude" : "Codex"} was tested against a real denied write.`,
      });
    } catch (error) {
      if (provider === "claude" && isFolderTrustRefusal(String(error))) setTrustRefused(true);
      pushErrorToast("Reviewer probe failed", error);
    } finally {
      setBusy(null);
    }
  };

  const run = useCallback(async (provider: Provider) => {
    setBusy(provider);
    try {
      await reviewerRun(workspaceId, cardId, provider);
      await load();
    } catch (error) {
      pushErrorToast("Independent review failed", error);
    } finally {
      setBusy(null);
    }
  }, [workspaceId, cardId, load]);

  const staleProvider = useMemo(
    () =>
      (["claude", "codex"] as const).find(
        (provider) => latest.get(provider)?.stale,
      ) ?? null,
    [latest],
  );
  useEffect(() => {
    if (!staleProvider) {
      onRerunStaleReady?.(null);
      return;
    }
    const rerun = () => run(staleProvider);
    onRerunStaleReady?.(rerun);
    return () => onRerunStaleReady?.(null);
  }, [onRerunStaleReady, run, staleProvider]);

  return (
    <section className="independent-review">
      <div className="independent-review-heading">
        <div>
          <h5>Independent AI review</h5>
          <p>
            Reviews the saved work in a separate, read-only copy of the
            repository.
          </p>
        </div>
      </div>

      {(["claude", "codex"] as const).map((provider) => {
        const capability = capabilities.get(provider);
        const review = latest.get(provider);
        if (capability && !capability.installed) return null;
        return (
          <div className="independent-review-provider" key={provider}>
            <div className="independent-review-provider-head">
              <strong>{provider === "claude" ? "Claude" : "Codex"}</strong>
              {capability?.level && (
                <span
                  className={`independent-review-chip ${
                    capability.eligible ? "is-valid" : "is-warning"
                  }`}
                >
                  {LABEL[capability.level]}
                </span>
              )}
              {review?.stale && (
                <span className="independent-review-chip is-warning">
                  Stale revision
                </span>
              )}
              {review?.valid && (
                <span className="independent-review-chip is-valid">
                  Valid review
                </span>
              )}
            </div>

            {!capability?.eligible ? (
              <div className="independent-review-action">
                <p>
                  {capability?.proof ??
                    "Load Settings › Setup and account › Diagnostics to check this provider."}
                </p>
                {provider === "claude" && capability?.installed && (
                  <ClaudeReviewTrustStep
                    workspaceId={workspaceId}
                    refused={trustRefused}
                    density="dense"
                    onTrusted={() => setTrustRefused(false)}
                  />
                )}
                {capability?.installed && (
                  <button
                    type="button"
                    className="outcome-btn"
                    disabled={busy !== null}
                    onClick={() => void probe(provider)}
                  >
                    {busy === provider ? "Probing…" : "Run reviewer probe"}
                  </button>
                )}
              </div>
            ) : (
              <div className="independent-review-action">
                <p>Enforced by {capability.proof}</p>
                <button
                  type="button"
                  className="outcome-btn"
                  disabled={busy !== null}
                  onClick={() => void run(provider)}
                >
                  {busy === provider
                    ? "Reviewing…"
                    : review
                      ? "Review this revision again"
                      : "Review with this provider"}
                </button>
              </div>
            )}

            {review && (
              <ReviewResult review={review} />
            )}
          </div>
        );
      })}
    </section>
  );
}

function ReviewResult({ review }: { review: ReviewerView }) {
  const { record } = review;
  return (
    <div className="independent-review-result">
      <p className="independent-review-revision">
        Reviewed <code>{record.reviewedRevision.slice(0, 12)}</code> with{" "}
        {record.providerVersion}.
        {record.passCount > 0 &&
          ` ${record.fileCount} file${record.fileCount === 1 ? "" : "s"}, reviewed in ${record.passCount} pass${record.passCount === 1 ? "" : "es"}.`}
        {record.verdict === "incomplete" &&
          ` Review incomplete (${incompleteReasonWords(record.incompleteReason)}).`}
      </p>
      {record.baseNote && (
        <div data-ply-review-base-note="">
          <p className="independent-review-revision">{reviewBaseWords(record.baseNote)}</p>
          <Details>{record.baseNote}</Details>
        </div>
      )}
      {record.sourceDirtyPaths.length > 0 && (
        <div className="independent-review-warning">
          Uncommitted source edits were excluded:{" "}
          {record.sourceDirtyPaths.join(", ")}
          {record.dirtyPathsTruncated ? " …" : ""}
        </div>
      )}
      {review.stale && (
        <div className="independent-review-warning">
          The card branch moved after this review. Run a fresh review before
          relying on the artifact.
        </div>
      )}
      {record.writeEscaped && (
        <div className="independent-review-error">
          The isolated tree changed. This result is invalid and the provider
          proof was downgraded.
        </div>
      )}
      {record.error && (
        <div className="independent-review-error">{showBackendText(record.error)}</div>
      )}
      {record.artifact && (
        <pre className="independent-review-artifact">{record.artifact}</pre>
      )}
    </div>
  );
}
