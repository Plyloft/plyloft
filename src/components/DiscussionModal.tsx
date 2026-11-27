import { showBackendText } from "../lib/backendMarks";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cardIssueProblem } from "../lib/issueProblem";
import {
  discussionAbort,
  discussionLaunch,
  discussionList,
  discussionPrepare,
  discussionResume,
  discussionRetry,
  onDiscussionChanged,
  type DiscussionLegKind,
  type DiscussionView,
} from "../ipc";
import {
  deriveDiscussionPresentation,
  discussionParticipantsLine,
  singleVendorLine,
  type DiscussionPresentation,
  type DiscussionSection,
} from "../lib/discussionPresentation";
import { discussionBlocker, singleInstalled, vendorOption, vendorReadiness } from "../lib/vendorReadiness";
import { useDoctor } from "../store/doctorStore";
import { useSettings } from "../store/settingsStore";
import { CBtn, Details, Icon, Segmented, Sheet } from "./ux";
import { pushErrorToast } from "../lib/errorToast";

/** GH #279: a verdict as a quiet word — "Partly accepted", never coloured
 *  text. */
function verdictWord(disposition: string): string {
  const words = disposition.replace(/[_-]+/g, " ").trim().toLowerCase();
  const plain = words.replace(/^partially\b/, "partly");
  return plain ? plain[0].toUpperCase() + plain.slice(1) : plain;
}

function sentenceCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

type Props = {
  workspaceId: string;
  initialCardId?: string | null;
  /** v1.109.0 (Plan challenge): prefill the problem with the card brief. */
  initialProblem?: string;
  /** 1.175.0 (B3 round 2): the card is of a GitHub issue. Its title and
   *  text are the issue's: the prefill is asked of the backend, which
   *  quotes them and marks what GitHub hides (`cardIssueProblem`); the
   *  field stays empty until it answers, and when it can't. */
  issueCard?: boolean;
  /** v1.109.0 (D15): the Builder's vendor synthesizes the plan challenge. */
  initialSynthesizer?: "claude" | "codex";
  onClose: () => void;
};

export function DiscussionModal({
  workspaceId,
  initialCardId = null,
  initialProblem,
  issueCard = false,
  initialSynthesizer,
  onClose,
}: Props) {
  const [views, setViews] = useState<DiscussionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [problem, setProblem] = useState(issueCard ? "" : (initialProblem ?? ""));
  useEffect(() => {
    if (!issueCard || !initialCardId) return;
    let live = true;
    void cardIssueProblem(workspaceId, initialCardId)
      // Null: the card has a plan of its own, which is Plyloft's text.
      .then((quoted) => live && setProblem((typed) => typed || (quoted ?? initialProblem ?? "")))
      .catch((error) => console.warn("discussion: the issue's text couldn't be quoted; the question stays empty:", error));
    return () => {
      live = false;
    };
    // Asked once, when the sheet opens on the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueCard, initialCardId, workspaceId]);
  const preferredSynthesizer = useSettings(
    (state) => state.settings.behavior.discussionSynthesizer,
  );
  const [synthesizer, setSynthesizer] = useState<"claude" | "codex">(
    initialSynthesizer ?? preferredSynthesizer,
  );
  const [preparing, setPreparing] = useState(false);
  // Why the last Prepare failed, kept in the sheet: toasts show one at a
  // time, and another one can replace it before it is read — in a walk the
  // first press's failure went unseen.
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [acting, setActingState] = useState(false);
  // TX6 round 1: the toast's Stop again runs a stale closure, so the
  // guard against overlapping presses reads a ref, never the render's state.
  const actingRef = useRef(false);
  const setActing = (value: boolean) => {
    actingRef.current = value;
    setActingState(value);
  };
  // OB-14 (§13.4, D5): with one vendor installed it takes both roles, in
  // separate sessions; the other is shown, disabled, with why.
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const only = singleInstalled(readiness);
  const blocker = discussionBlocker(readiness);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    const next = await discussionList(workspaceId);
    setViews(next);
    setSelectedId((current) => {
      if (current && next.some((view) => view.record.id === current)) {
        return current;
      }
      // v1.110.1: opened from a card, show only that card's discussions —
      // never an unrelated one from the workspace (it read as if the card
      // had already been discussed).
      if (initialCardId) {
        const cardMatch = next.find((view) => view.record.cardId === initialCardId);
        return cardMatch?.record.id ?? null;
      }
      return next[0]?.record.id ?? null;
    });
  }, [workspaceId, initialCardId]);

  useEffect(() => {
    inputRef.current?.focus();
    void refresh();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onDiscussionChanged((event) => {
      void refresh();
      if (event.error) {
        // 1.176.2 (E1, A3-91): discussion.rs's own state words, in words.
        pushErrorToast("Discussion worker stopped", event.error);
      }
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const hasActiveDiscussion = views.some(
    (view) => view.record.status === "running",
  );

  useEffect(() => {
    if (!hasActiveDiscussion) return;
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [hasActiveDiscussion, refresh]);

  useEffect(() => {
    setSynthesizer(preferredSynthesizer);
  }, [preferredSynthesizer]);

  const selected = useMemo(
    () => views.find((view) => view.record.id === selectedId) ?? null,
    [views, selectedId],
  );

  const prepare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!problem.trim() || preparing) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const record = await discussionPrepare(
        workspaceId,
        initialCardId,
        problem.trim(),
        synthesizer,
      );
      await refresh();
      setSelectedId(record.id);
      setProblem("");
    } catch (error) {
      setPrepareError(String(error));
      pushErrorToast("Discussion preflight failed", error);
    } finally {
      setPreparing(false);
    }
  };

  const launch = async () => {
    if (!selected || actingRef.current) return;
    setActing(true);
    try {
      await discussionLaunch(selected.record.id);
      await refresh();
    } catch (error) {
      pushErrorToast("Could not launch discussion", error);
    } finally {
      setActing(false);
    }
  };

  const resume = async () => {
    if (!selected || actingRef.current) return;
    setActing(true);
    try {
      await discussionResume(selected.record.id);
      await refresh();
    } catch (error) {
      pushErrorToast("The discussion didn't resume", error, { then: "Nothing changed in it. Try again." });
    } finally {
      setActing(false);
    }
  };

  const retry = async (kind: DiscussionLegKind) => {
    if (!selected || actingRef.current) return;
    setActing(true);
    try {
      await discussionRetry(selected.record.id, kind);
      await refresh();
    } catch (error) {
      pushErrorToast("The discussion didn't start again", error, { then: "Nothing changed in it. Try again." });
    } finally {
      setActing(false);
    }
  };

  const abort = async () => {
    if (!selected || actingRef.current) return;
    setActing(true);
    try {
      await discussionAbort(selected.record.id);
      await refresh();
    } catch (error) {
      // TX6 (E11): a stop that didn't land may leave it running, so the
      // toast offers the same stop again.
      pushErrorToast("The discussion didn't stop", error, { then: "It may still be running.", action: { label: "Stop again", onClick: () => void abort() } });
    } finally {
      setActing(false);
    }
  };

  return (
    <Sheet
      title="Independent discussion"
      // GH #279: the outcome in plain words; the pinning is in the preflight.
      lede={discussionParticipantsLine(only)}
      size="wide"
      onClose={onClose}
      canDismiss={!preparing && !acting}
      initialFocusRef={inputRef}
      actions={
        <CBtn onClick={onClose} disabled={preparing || acting}>
          Close
        </CBtn>
      }
    >
      <div className="discussion-workbench">
        <form className="discussion-new" onSubmit={prepare}>
          <textarea
            ref={inputRef}
            className="ux-sheet-textarea ux-sheet-textarea--prose"
            aria-label="Question"
            rows={3}
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            placeholder={only ? "What should they think through?" : "What should Claude and Codex think through?"}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="discussion-new-field">
            <span className="discussion-caption" id="discussion-writer">
              Answer written by
            </span>
            <Segmented
              label="Answer written by"
              value={synthesizer}
              options={[
                vendorOption("claude", "Claude", readiness),
                vendorOption("codex", "Codex", readiness),
              ]}
              onChange={(next) => {
                setSynthesizer(next);
                // 1.176.2 R2 (M1): only this field, on the settings as they
                // are when the save runs — never a copy taken at the click.
                void useSettings
                  .getState()
                  .update((latest) => ({
                    ...latest,
                    behavior: { ...latest.behavior, discussionSynthesizer: next },
                  }))
                  .catch((error) =>
                    pushErrorToast("Could not save synthesis default", error),
                  );
              }}
            />
          </div>
          {blocker && <p className="discussion-caption">{blocker}</p>}
          <CBtn
            tone="accent"
            type="submit"
            disabled={!problem.trim() || preparing || blocker !== null}
            title={blocker ?? undefined}
          >
            {preparing ? "Checking…" : "Prepare discussion"}
          </CBtn>
          {prepareError && !preparing && (
            <p className="discussion-error" role="alert">
              {`Discussion preflight failed: ${prepareError}`}
            </p>
          )}
        </form>

        <div className="discussion-body">
          <aside className="discussion-history">
            <strong>Recent</strong>
            {views.length === 0 && <p className="muted">No discussions yet.</p>}
            {views.map((view) => (
              <button
                type="button"
                key={view.record.id}
                className={view.record.id === selectedId ? "active" : ""}
                onClick={() => setSelectedId(view.record.id)}
              >
                <span>{view.record.problem}</span>
                <small>{view.record.status.replace(/_/g, " ")}</small>
              </button>
            ))}
          </aside>
          <main className="discussion-detail">
            {selected ? (
              <DiscussionDetail
                view={selected}
                acting={acting}
                onLaunch={launch}
                onResume={resume}
                onRetry={retry}
                onAbort={abort}
              />
            ) : (
              <div className="muted discussion-empty">
                Prepare a discussion to inspect its exact commit and dirty-file
                exclusion before any provider call starts.
              </div>
            )}
          </main>
        </div>
      </div>
    </Sheet>
  );
}

function DiscussionDetail({
  view,
  acting,
  onLaunch,
  onResume,
  onRetry,
  onAbort,
}: {
  view: DiscussionView;
  acting: boolean;
  onLaunch: () => void;
  onResume: () => void;
  onRetry: (kind: DiscussionLegKind) => void;
  onAbort: () => void;
}) {
  const presentation = deriveDiscussionPresentation(view);

  const runPrimaryAction = () => {
    if (presentation.primaryAction?.kind === "launch") onLaunch();
    if (presentation.primaryAction?.kind === "resume") onResume();
    if (presentation.primaryAction?.kind === "stop") onAbort();
  };

  return (
    <div className={`discussion-presentation ${presentation.mode}`}>
      {presentation.sections.map((section) => (
        <DiscussionSectionContent
          key={section}
          section={section}
          view={view}
          presentation={presentation}
          acting={acting}
          onPrimaryAction={runPrimaryAction}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function DiscussionSectionContent({
  section,
  view,
  presentation,
  acting,
  onPrimaryAction,
  onRetry,
}: {
  section: DiscussionSection;
  view: DiscussionView;
  presentation: DiscussionPresentation;
  acting: boolean;
  onPrimaryAction: () => void;
  onRetry: (kind: DiscussionLegKind) => void;
}) {
  switch (section) {
    case "outcome":
      return (
        <section className="discussion-outcome">
          <span className="discussion-eyebrow">What you will get</span>
          <strong>One answer, with disagreements kept visible.</strong>
          <p>
            {view.record.singleVendor
              ? singleVendorLine(view.record)
              : "Claude and Codex analyze the same commit independently, cross-review it, then one provider writes a bounded synthesis."}
          </p>
        </section>
      );
    case "pin":
      return <DiscussionPin view={view} showPaths />;
    case "action":
      if (presentation.mode === "preflight") {
        return (
          <section className="discussion-primary-action">
            <CBtn tone="accent" disabled={acting} onClick={onPrimaryAction}>
              {acting ? "Starting…" : presentation.primaryAction?.label}
            </CBtn>
            <span>Provider work starts only when you choose this.</span>
          </section>
        );
      }
      if (presentation.mode === "active" && presentation.primaryAction) {
        return (
          <section className="discussion-primary-action">
            <CBtn
              tone={
                presentation.primaryAction.kind === "stop" ? "danger" : "accent"
              }
              disabled={acting}
              onClick={onPrimaryAction}
            >
              {acting ? "Working…" : presentation.primaryAction.label}
            </CBtn>
            <span>
              {presentation.primaryAction.kind === "resume"
                ? "Continues from the blocked phase; completed paid legs are not replayed."
                : "Stops the discussion. No provider work restarts automatically."}
            </span>
          </section>
        );
      }
      if (presentation.mode === "terminal" && presentation.retryLegs.length > 0) {
        return (
          <section className="discussion-primary-action">
            {presentation.retryLegs.map((kind) => {
              const item = presentation.orderedLegs.find(
                (candidate) => candidate.kind === kind,
              );
              return (
                <CBtn
                  tone="accent"
                  key={kind}
                  disabled={acting}
                  onClick={() => onRetry(kind)}
                >
                  Retry {item?.label ?? "failed leg"}
                </CBtn>
              );
            })}
            <span>Only the selected failed leg runs again.</span>
          </section>
        );
      }
      return null;
    case "setup":
      return (
        <Details summary="Discussion setup">
          <DiscussionTrust presentation={presentation} compact />
          <DiscussionLegs presentation={presentation} />
        </Details>
      );
    case "status":
      return <DiscussionStatus view={view} presentation={presentation} />;
    case "legs":
      return (
        <Details summary="The five legs">
          <DiscussionLegs presentation={presentation} />
        </Details>
      );
    case "attempts":
      return <DiscussionAttempts presentation={presentation} />;
    case "synthesis":
      return <DiscussionSynthesis presentation={presentation} single={singleVendorLine(view.record)} />;
    case "disagreements":
      return <DiscussionLedger presentation={presentation} />;
    case "trust":
      return <DiscussionTrust presentation={presentation} />;
    default: {
      const unreachable: never = section;
      return unreachable;
    }
  }
}

function DiscussionPin({
  view,
  showPaths = false,
}: {
  view: DiscussionView;
  showPaths?: boolean;
}) {
  const { source } = view.record;
  const dirtyCount = source.dirtyPaths.length;
  return (
    <section
      className={`discussion-pin-warning${dirtyCount > 0 ? " dirty" : ""}${view.stale ? " stale" : ""}`}
    >
      <strong>
        Discussing commit {source.pinnedRevision.slice(0, 10)}
        {source.sourceRef ? ` from ${source.sourceRef}` : ""}
      </strong>
      <span>
        {dirtyCount > 0
          ? `${dirtyCount} changed file${dirtyCount === 1 ? " that isn't saved in a commit is" : "s that aren't saved in a commit are"} left out for both AIs.`
          : "Only what's saved in commits; the folder has no other changes."}
        {view.stale ? " The branch has moved on since; this result is out of date." : ""}
      </span>
      {showPaths && dirtyCount > 0 && (
        <code>
          {source.dirtyPaths.join("\n")}
          {source.dirtyPathsTruncated ? "\n…more paths were excluded" : ""}
        </code>
      )}
    </section>
  );
}

function DiscussionStatus({
  view,
  presentation,
}: {
  view: DiscussionView;
  presentation: DiscussionPresentation;
}) {
  return (
    <section className="discussion-status-card">
      <span className="discussion-eyebrow">Right now</span>
      <div className="discussion-status-row">
        <span className={`discussion-status ${view.record.status}`}>
          {presentation.statusLabel}
        </span>
        <strong>{presentation.phaseLabel}</strong>
      </div>
      {presentation.blockedProviders.length > 0 && (
        <p>
          Waiting for {presentation.blockedProviders.join(" and ")}. Authentication,
          quota, or provider availability must be restored before resuming.
        </p>
      )}
      <small>
        Pinned commit {presentation.trust.pinnedRevision.slice(0, 10)}
        {view.stale ? " · stale because the live ref moved" : ""}
      </small>
    </section>
  );
}

function DiscussionLegs({
  presentation,
}: {
  presentation: DiscussionPresentation;
}) {
  return (
    <div className="discussion-legs">
      {presentation.orderedLegs.map(({ kind, label, leg }) => (
        <div className="discussion-leg" key={kind}>
          <div>
            <strong>{label}</strong>
            <span>
              {leg.provider} {leg.version || "unproved"} ·{" "}
              {leg.capability?.replace("-", " ") ?? "no capability"}
            </span>
          </div>
          <span className={`discussion-leg-status ${leg.status}`}>{leg.status}</span>
          {leg.unavailable && (
            <p className="discussion-error">{showBackendText(leg.unavailable.reason)}</p>
          )}
          {leg.artifact != null && (
            <Details summary="Read completed artifact">
              <pre className="discussion-artifact">{JSON.stringify(leg.artifact, null, 2)}</pre>
            </Details>
          )}
        </div>
      ))}
    </div>
  );
}

function DiscussionAttempts({
  presentation,
}: {
  presentation: DiscussionPresentation;
}) {
  const total = presentation.orderedLegs.reduce(
    (count, { leg }) => count + leg.attemptHistory.length,
    0,
  );
  if (total === 0) return null;
  return (
    <Details summary={`Attempts · ${total}`}>
      <div className="discussion-attempts">
      {presentation.orderedLegs.map(({ kind, label, leg }) =>
        leg.attemptHistory.length > 0 ? (
          <section key={kind}>
            <strong>{label}</strong>
            {leg.attemptHistory.map((attempt) => (
              <div className="discussion-attempt" key={attempt.number}>
                #{attempt.number} · {attempt.status} · {leg.provider} ·{" "}
                {attempt.executable} {attempt.version || "unproved"} ·{" "}
                {attempt.capability?.replace("-", " ") ?? "no capability"}
                {attempt.error && <p>{showBackendText(attempt.error)}</p>}
                {attempt.diagnostics.map((diagnostic, index) => (
                  <code key={index}>{diagnostic}</code>
                ))}
              </div>
            ))}
          </section>
        ) : null,
      )}
      </div>
    </Details>
  );
}

function DiscussionSynthesis({
  presentation,
  single,
}: {
  presentation: DiscussionPresentation;
  /** OB-14 (D5): "Both views come from Claude, …", once, on the result. */
  single: string | null;
}) {
  const synthesis = presentation.synthesis;
  return (
    <section className="discussion-result">
      <span className="discussion-eyebrow">Answer</span>
      <h3>Synthesis</h3>
      {single && <p className="muted">{single}</p>}
      {synthesis ? <p>{synthesis.answer}</p> : <p>No valid synthesis was saved.</p>}
      {(synthesis?.agreements.length ?? 0) > 0 && (
        <Details summary="Where both analyses agree">
          <ul>
            {synthesis?.agreements.map((agreement) => (
              <li key={agreement}>{agreement}</li>
            ))}
          </ul>
        </Details>
      )}
      {(synthesis?.unresolvedQuestions.length ?? 0) > 0 && (
        // GH #279: the Callout's look — one tint, an icon beside the words,
        // no coloured bar.
        <div className="ux-callout ux-callout--warn discussion-unresolved-questions">
          <span className="ux-callout-icon">
            <Icon name="warning" />
          </span>
          <div className="ux-callout-text">
            <p className="ux-callout-title">Still unresolved</p>
            <ul>
              {synthesis?.unresolvedQuestions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function DiscussionLedger({
  presentation,
}: {
  presentation: DiscussionPresentation;
}) {
  return (
    <section className="discussion-ledger">
      <h3>
        {presentation.disagreements.length === 0
          ? "The analyses aligned"
          : `They disagreed on ${presentation.disagreements.length} ${
              presentation.disagreements.length === 1 ? "thing" : "things"
            }`}
      </h3>
      {presentation.disagreements.length === 0 && (
        <p className="muted">No disagreement was recorded by either cross-review.</p>
      )}
      {presentation.disagreements.map((item) => (
        // GH #279: the id and severity on a caption line of their own; the
        // verdict a quiet word, then its reason in plain text.
        <article key={item.entry.id}>
          <span className="discussion-caption">
            {item.entry.id} · {sentenceCase(item.entry.severity || "unspecified")}
          </span>
          <strong className="discussion-statement">{item.entry.statement}</strong>
          <p>{item.entry.rationale}</p>
          <p className="discussion-verdict">
            <span className="discussion-caption">
              {item.disposition ? verdictWord(item.disposition) : "Unresolved"}
            </span>
            <span>
              {item.disposition
                ? item.resolutionRationale
                : "The answer did not cover it."}
            </span>
          </p>
        </article>
      ))}
    </section>
  );
}

function DiscussionTrust({
  presentation,
  compact = false,
}: {
  presentation: DiscussionPresentation;
  compact?: boolean;
}) {
  return (
    <section className={`discussion-trust${compact ? " compact" : ""}`}>
      {!compact && <h3>Why you can trust this result</h3>}
      <p>
        Commit {presentation.trust.pinnedRevision.slice(0, 10)} · one bounded
        synthesis leg · {presentation.trust.synthesisAttemptCount} synthesis attempt
        {presentation.trust.synthesisAttemptCount === 1 ? "" : "s"}
      </p>
      <ul>
        {presentation.trust.participants.map((participant) => (
          <li key={participant.role}>
            {participant.role}: {participant.provider} {participant.version || "unproved"}
            {participant.capability
              ? ` · ${participant.capability.replace("-", " ")}`
              : " · no proved read-only capability"}
          </li>
        ))}
      </ul>
      <small>
        {presentation.trust.excludedPathCount === 1
          ? "1 changed file not saved in a commit was left out"
          : `${presentation.trust.excludedPathCount} changed files not saved in a commit were left out`}
        {presentation.trust.excludedPathsTruncated ? " (only the first ones are listed)" : ""}.
      </small>
    </section>
  );
}
