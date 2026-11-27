import { useEffect, useState } from "react";
import { prReviewCreate, prReviewList, type PrList, type PrListItem } from "../ipc";
import { CBtn, ErrorBlock, Group, Row, Segmented, Sheet, StatusLine, TextField } from "./ux";
import { plainError } from "../lib/plainError";
import type { UxError } from "../lib/uxError";
import { useDoctor } from "../store/doctorStore";
import { useKanban } from "../store/kanbanStore";
import { useSettings } from "../store/settingsStore";
import { newCardBuilderVendor } from "../lib/settingsShape";
import { useUi } from "../store/uiStore";
import { pushToast } from "../store/toastStore";
import { showPlanRefusal } from "../store/planPrompts";
import { otherVendor, vendorOption, vendorReadiness, VENDOR_NAME } from "../lib/vendorReadiness";

type Vendor = "claude" | "codex";

/**
 * Challenger on a pull request: Board › ⋯ › Review a pull request. Lists the
 * repository's open pull requests (as the workspace's GitHub account) or
 * takes a pasted link; Review makes the card "Review: <title>" and starts
 * the Challenger chosen here on it. Nothing is posted to GitHub.
 */
export function PrReviewSheet({
  workspaceId,
  onClose,
  initialNumber = null,
}: {
  workspaceId: string;
  onClose: () => void;
  /** QoL 14.2 (F7): the pull request the Inbox row is about, picked. */
  initialNumber?: number | null;
}) {
  const [list, setList] = useState<PrList | null>(null);
  // QoL 1.168 block 8 (A5): the error shape, the raw text behind Details.
  const [listError, setListError] = useState<UxError | null>(null);
  const [picked, setPicked] = useState<number | null>(initialNumber);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UxError | null>(null);
  const readiness = vendorReadiness(useDoctor((s) => s.report));
  const builderDefault = useSettings((s) => newCardBuilderVendor(s.settings.behavior));
  const [challenger, setChallenger] = useState<Vendor>(() => {
    const preferred = otherVendor(builderDefault === "codex" ? "codex" : "claude");
    return readiness[preferred].ready ? preferred : otherVendor(preferred);
  });

  useEffect(() => {
    let live = true;
    prReviewList(workspaceId)
      .then((next) => live && setList(next))
      .catch(
        (e: unknown) =>
          live &&
          setListError(
            plainError("Plyloft couldn't list the pull requests", e, {
              todo: "Paste the pull request's link below instead, or close this and try again.",
            }),
          ),
      );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const input = pasted.trim() || (picked != null ? String(picked) : "");
  const vendorReady = readiness[challenger].ready;

  async function review() {
    if (!input || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await prReviewCreate(workspaceId, input, challenger);
      await useKanban.getState().loadFromDisk(workspaceId, true);
      useUi.getState().selectCard(workspaceId, made.card.id, true);
      onClose();
      if (made.existing) {
        pushToast({ kind: "info", title: "This pull request already has a card", body: made.card.title });
      } else if (made.reviewError) {
        pushToast({ kind: "warn", title: "The card is made; its review didn't start", body: made.reviewError });
      }
    } catch (e) {
      if (showPlanRefusal(e)) {
        onClose();
        return;
      }
      setError(plainError("No review was started", e, { todo: "Check the pull request, then press Review again." }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Review a pull request"
      lede="The Reviewer reviews an open pull request of this repository, read-only, on a card of its own. Its findings stay here in Plyloft: nothing is posted to GitHub."
      onClose={onClose}
      canDismiss={!busy}
      actions={
        <>
          <CBtn tone="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </CBtn>
          <CBtn
            tone="strong"
            onClick={() => void review()}
            disabled={!input || busy || !vendorReady}
            data-ply-pr-review-begin=""
          >
            {busy ? "Starting the review…" : "Review"}
          </CBtn>
        </>
      }
    >
      <Group label="Pull request">
        {list == null && !listError && <StatusLine state="running">Reading the open pull requests…</StatusLine>}
        {listError && <ErrorBlock error={listError} />}
        {list && list.prs.length === 0 && (
          <p className="ux-card-muted">{list.repo} has no open pull requests.</p>
        )}
        {list && list.prs.length > 0 && (
          <ul className="pr-review-list" aria-label={`Open pull requests of ${list.repo}`}>
            {list.prs.map((pr) => (
              <PrChoice
                key={pr.number}
                pr={pr}
                checked={picked === pr.number && !pasted.trim()}
                onPick={() => {
                  setPicked(pr.number);
                  setPasted("");
                  // Walk of #386 (step 2): a refusal is of the pull request it named.
                  setError(null);
                }}
              />
            ))}
          </ul>
        )}
        <Row kind="text" label="Or paste its link" hint="A pull request of this repository, like https://github.com/owner/name/pull/12.">
          <TextField
            value={pasted}
            onChange={(next) => {
              setPasted(next);
              setError(null);
            }}
            onEnter={() => void review()}
            label="Pull request link"
            wide
            placeholder="https://github.com/…/pull/…"
          />
        </Row>
      </Group>
      <Group label="Reviewer">
        <Row kind="text" label="Reviewed by" hint="The Reviewer reads the pull request in a pinned, read-only copy.">
          <Segmented
            label="Reviewer"
            value={challenger}
            onChange={setChallenger}
            options={[vendorOption("claude", VENDOR_NAME.claude, readiness), vendorOption("codex", VENDOR_NAME.codex, readiness)]}
          />
        </Row>
      </Group>
      {error && <ErrorBlock error={error} />}
    </Sheet>
  );
}

function PrChoice({ pr, checked, onPick }: { pr: PrListItem; checked: boolean; onPick: () => void }) {
  const facts = [
    pr.author ? (pr.mine ? "yours" : `by @${pr.author}`) : null,
    pr.crossRepository ? "from a fork" : null,
    pr.draft ? "draft" : null,
    pr.cardId ? "has a card" : null,
    `${pr.headRef} → ${pr.baseRef}`,
  ].filter(Boolean);
  return (
    <li>
      <label className="pr-review-choice">
        <input type="radio" name="pr-review-choice" checked={checked} onChange={onPick} />
        <span className="pr-review-choice-title">
          #{pr.number} {pr.title}
        </span>
        <span className="ux-card-muted-inline">{facts.join(" · ")}</span>
      </label>
    </li>
  );
}
