import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CBtn, Details, Sheet } from "./ux";
import {
  skillRootIgnoreFix,
  skillRootIgnorePlan,
  type IgnoreEdit,
  type IgnorePlan,
} from "../ipc";

/**
 * GH #215: `Un-ignore` on a gitignored skill root — the fix the project-skills
 * row offers, in Settings › Diagnostics and in the Dependency Doctor alike.
 *
 * Pressing it only *reads*: `skill_root_ignore_plan` works out, against git,
 * which lines to append to which file (the file whose rule ignores the root,
 * as `git check-ignore -v` names it). The confirmation shows exactly those
 * lines and that file. Cancel closes it and invokes nothing. Confirm sends the
 * same edits back; the backend re-derives the plan and writes only if it still
 * matches, then runs the doctor's check again. The row re-reads the doctor and
 * shows the outcome sentence, including "still ignored" — the next press then
 * explains rather than adding the same lines again.
 */
export function useSkillRootIgnoreFix({
  workspaceId,
  status,
  onChecked,
}: {
  workspaceId: string | null;
  /** The row's report. The note belongs to the re-read the fix asked for;
   *  any later read (Look again, a workspace switch) replaces it. */
  status: unknown;
  /** Re-read the doctor so the row shows the new condition. */
  onChecked: () => Promise<unknown> | void;
}): {
  start: () => void;
  busy: boolean;
  /** The last outcome or failure, for the row's hint. */
  note: string | null;
  sheet: ReactNode;
} {
  const [plan, setPlan] = useState<IgnorePlan | null>(null);
  const [busy, setBusy] = useState(false);
  // The note belongs to the re-read the fix asks for: it survives that one
  // new report, and the next (Look again, a workspace switch) clears it.
  // Counted rather than flagged, so it doesn't matter whether the re-read's
  // render lands before or after `onChecked` resolves.
  const [reads, setReads] = useState(0);
  const [noted, setNoted] = useState<{ text: string; at: number } | null>(null);
  const lastStatus = useRef(status);
  const readsRef = useRef(0);
  useEffect(() => {
    if (lastStatus.current === status) return;
    lastStatus.current = status;
    readsRef.current += 1;
    setReads(readsRef.current);
  }, [status]);
  const setNote = useCallback((text: string | null) => {
    setNoted(text == null ? null : { text, at: readsRef.current });
  }, []);
  const note = noted && reads - noted.at <= 1 ? noted.text : null;
  const recheck = useCallback(async () => {
    await onChecked();
  }, [onChecked]);

  const start = useCallback(() => {
    if (!workspaceId) {
      setNote("Open the workspace first — the fix is for its repository.");
      return;
    }
    setBusy(true);
    setNote(null);
    skillRootIgnorePlan(workspaceId)
      .then((next) => {
        if (next.roots.length === 0) {
          setNote("Git no longer ignores any skill root here. Nothing to add.");
          void recheck();
        } else {
          setPlan(next);
        }
      })
      .catch((e) => setNote(`Plyloft couldn't work out the lines; nothing was changed. ${String(e)}`))
      .finally(() => setBusy(false));
  }, [workspaceId, recheck, setNote]);

  const applyEdits = useCallback(async () => {
    if (!plan || !workspaceId) return;
    const edits = plan.edits;
    setPlan(null);
    setBusy(true);
    try {
      const outcome = await skillRootIgnoreFix(workspaceId, edits);
      setNote(outcome.sentence);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
      await recheck();
    }
  }, [plan, workspaceId, recheck, setNote]);

  const sheet = plan ? (
    <IgnoreFixSheet plan={plan} onCancel={() => setPlan(null)} onConfirm={() => void applyEdits()} />
  ) : null;

  return { start, busy, note, sheet };
}

function lineCount(edits: IgnoreEdit[]): number {
  return edits.reduce((sum, edit) => sum + edit.lines.length, 0);
}

const REACH: Record<IgnoreEdit["reach"], string> = {
  repository:
    "Reaches everyone who opens the repository once you commit it with the skills. Plyloft doesn't commit.",
  untracked:
    "Git doesn't track this file yet: it reaches everyone once you add and commit it with the skills. Plyloft doesn't commit.",
  checkout:
    "Git ignores this file itself, so it is never committed: the lines work in this checkout only, and teammates and card worktrees don't get them.",
  clone: "This clone only, and every worktree of it: git never commits this file.",
};

function IgnoreFixSheet({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: IgnorePlan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = lineCount(plan.edits);
  const canFix = plan.edits.length > 0;
  // The title names what the lines un-ignore; a root they can't is below.
  const fixed = [...new Set(plan.edits.flatMap((edit) => edit.roots))];
  const roots = (canFix ? fixed : plan.roots).join(" and ");
  return (
    <Sheet
      size="confirm"
      title={canFix ? `Let Git see ${roots}?` : `Plyloft can't let Git see ${roots}`}
      lede={
        canFix
          ? plan.edits.length > 1
            ? "Plyloft adds these lines to the end of each file. Nothing already in them changes."
            : "Plyloft adds these lines to the end of the file. Nothing already in it changes."
          : plan.refused.some((refusal) => refusal.suggestion)
            ? "Nothing was changed. Below: what ignores it, why Plyloft won't add a line for it, and the edit to make by hand."
            : "Nothing was changed. Below: what ignores it, and why Plyloft won't add a line for it."
      }
      onClose={onCancel}
      actions={
        canFix ? (
          <>
            <CBtn tone="strong" onClick={onCancel}>
              Cancel
            </CBtn>
            <CBtn tone="accent" onClick={onConfirm}>
              {count === 1 ? "Add 1 line" : `Add ${count} lines`}
            </CBtn>
          </>
        ) : (
          <CBtn tone="strong" onClick={onCancel}>
            Close
          </CBtn>
        )
      }
    >
      {plan.edits.map((edit) => (
        <div className="ux-sheet-change" key={edit.file}>
          <p className="ux-sheet-change-label">
            Add to <span className="ux-mono-fg">{edit.file}</span>
          </p>
          <pre className="ux-output ux-mono-fg" aria-label={`Lines added to ${edit.file}`}>
            {edit.lines.join("\n")}
          </pre>
          <p className="ux-sheet-change-why">{REACH[edit.reach]}</p>
          {edit.rules.length > 0 && (
            <Details summary="The rules these lines answer">
              <pre className="ux-output">{edit.rules.join("\n")}</pre>
            </Details>
          )}
        </div>
      ))}
      {plan.refused.map((refusal) => (
        <div className="ux-sheet-change" key={refusal.root}>
          <p className="ux-sheet-change-label">
            <span className="ux-mono-fg">{refusal.root}</span> stays ignored
          </p>
          <p className="ux-sheet-change-why">{refusal.reason}</p>
          {refusal.suggestion && (
            <pre className="ux-output ux-mono-fg" aria-label={`Edit to make for ${refusal.root}`}>
              {refusal.suggestion}
            </pre>
          )}
          {refusal.rule && (
            <Details>
              <pre className="ux-output">{refusal.rule}</pre>
            </Details>
          )}
        </div>
      ))}
    </Sheet>
  );
}
