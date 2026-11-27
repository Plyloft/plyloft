import { useState } from "react";
import { CBtn, Details, Flow, StatusLine, TextField } from "../ux";
import type { Failure } from "../../lib/failure";
import {
  DESCRIPTION_HINT,
  descriptionProblem,
  ignoredRefusal,
  nameProblem,
  nameTaken,
  newSkillClosingLine,
  newSkillPaths,
} from "../../lib/newSkill";

/**
 * Group B decision §3 (owner: "in the repository, for both CLIs"): the one
 * step `New skill…` opens in Library › Skills.
 *
 * A `Flow` in the centre with no navigation around it (PATTERNS.md §6), like
 * `Promote` and `Align`: the host takes the inner column away while it is up.
 * It asks two things — a name and the one-line description the agent decides
 * by — and says, before the button, where the two copies go and how they stay
 * in step. The text itself is written in Code (ADR 0005: the Library creates
 * the container, Code the content), so the flow opens Claude's copy there.
 *
 * Every check here is repeated by the backend (`create_new_skill`); these only
 * let the flow say the problem before the press. A gitignored root refuses the
 * flow outright and offers `Un-ignore`, the same fix the Skills page offers.
 */
export function NewSkillFlow({
  taken,
  branch,
  ignored,
  unignore,
  refusal,
  busy,
  onCancel,
  onCreate,
}: {
  /** The repository's names: the checkout's, what neither CLI loads, the branch's. */
  taken: Parameters<typeof nameTaken>[1];
  branch: string | null;
  /** The roots the flow writes that git ignores here. */
  ignored: string[];
  /** The page's `Un-ignore`, shown when a root is ignored. */
  unignore: { start: () => void; busy: boolean; note: string | null };
  /** Why the last press was refused, in the backend's words. */
  refusal: Failure | null;
  busy: boolean;
  onCancel: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // A field says its problem once it has something in it: an empty form is not
  // a list of errors.
  const nameSays = name === "" ? null : (nameProblem(name) ?? nameTaken(name, taken, branch));
  const descriptionSays = description === "" ? null : descriptionProblem(description);
  const blocked = ignored.length > 0;
  const ready =
    !blocked &&
    nameProblem(name) === null &&
    nameTaken(name, taken, branch) === null &&
    descriptionProblem(description) === null;
  const create = () => {
    if (ready && !busy) onCreate(name, description.trim());
  };
  return (
    <section aria-label="New skill">
      <Flow
        step="New skill · 1 step"
        title="A new skill in this repository"
        lede="Everyone who opens this repository gets it, in Claude and in Codex. You write what it says in Code."
        actions={
          <>
            <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
              Cancel
            </CBtn>
            <CBtn tone="accent" onClick={create} disabled={!ready || busy}>
              {busy ? "Creating…" : "Create and open in Code"}
            </CBtn>
          </>
        }
      >
        {blocked && (
          <div className="ux-flow-section">
            <StatusLine state="aborted">{ignoredRefusal(ignored)}</StatusLine>
            {unignore.note && <StatusLine state="empty">{unignore.note}</StatusLine>}
            <CBtn size="sm" tone="strong" disabled={unignore.busy} onClick={unignore.start}>
              {unignore.busy ? "Looking…" : "Let Git see it"}
            </CBtn>
          </div>
        )}
        <section className="ux-flow-section">
          <h3 className="ux-flow-heading">Name</h3>
          <TextField
            label="Name"
            value={name}
            onChange={(next) => setName(next.trim())}
            onEnter={create}
            placeholder="deploy-checklist"
            mono
            error={nameSays !== null}
            disabled={busy || blocked}
          />
          <p className="ux-page-lede">
            {nameSays ?? "Lowercase letters, digits and hyphens. It is the folder's name and the name Claude and Codex both use."}
          </p>
        </section>
        <section className="ux-flow-section">
          <h3 className="ux-flow-heading">Description</h3>
          <TextField
            label="Description"
            value={description}
            onChange={setDescription}
            onEnter={create}
            placeholder="Use when…"
            wide
            error={descriptionSays !== null}
            disabled={busy || blocked}
          />
          <p className="ux-page-lede">{descriptionSays ?? DESCRIPTION_HINT}</p>
        </section>
        {refusal && (
          <div>
            <StatusLine state="aborted">{refusal.sentence}</StatusLine>
            {refusal.details && (
              <Details>
                <pre className="ux-output">{refusal.details}</pre>
              </Details>
            )}
          </div>
        )}
        <StatusLine state="empty">{newSkillClosingLine(branch)}</StatusLine>
        <Details summary="Where it goes">
          <p className="ux-page-lede">
            Claude reads <span className="ux-mono-fg">{newSkillPaths(name).claude}</span> and
            Codex <span className="ux-mono-fg">{newSkillPaths(name).codex}</span>.
          </p>
        </Details>
      </Flow>
    </section>
  );
}
