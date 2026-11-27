import { useState } from "react";
import { CBtn, ChoiceList, StatusLine } from "../ux";

/** Which copy on the branch wins. */
export type AlignChoice = "claude" | "codex";

/**
 * UX language card 6 (GH #105; BOARDS.md §3 "Kept aligned"): the one step
 * `Align` opens when the branch's two copies of a skill disagree.
 *
 * A surface of its own in the centre, with **no navigation around it**
 * (PATTERNS.md §6) — the host takes the inner column away while a flow is open,
 * as it does for `Promote`. The question is the choice, so the choice is a radio
 * group (`ChoiceList`, whose option ids are `useId`-scoped: every warmed
 * workspace keeps its host mounted, so two of these can be in the document at
 * once). One commit either way, and the losing copy is replaced file for file —
 * which is what the sentence under the choice says before the button.
 *
 * Skills hub H5 (R12): `mode: "card"` is the same question in a workspace
 * with no shared channel — both copies changed, so nobody wins by the rule —
 * and the answer is a skill card instead of a commit on the branch.
 */
export function AlignFlow({
  name,
  branch,
  lines,
  busy,
  mode = "branch",
  onCancel,
  onAlign,
}: {
  name: string;
  branch: string | null;
  /** How long each copy is, when Ply has read them: the one difference a member
   *  can weigh without opening the comparison again. */
  lines: { claude: number | null; codex: number | null };
  busy: boolean;
  /** `branch`: one commit on the shared channel's branch (GH #105). `card`:
   *  a skill card (H5). */
  mode?: "branch" | "card";
  onCancel: () => void;
  onAlign: (choice: AlignChoice) => void;
}) {
  // Owner, 2026-10-19: nothing is chosen for the person — which copy wins is
  // theirs to say, so `Align` waits until they have said it.
  const [choice, setChoice] = useState<AlignChoice | null>(null);
  const card = mode === "card";
  const where = card ? "this repository" : (branch ?? "the integration branch");
  const at = card ? "in this repository" : `on ${where}`;
  const length = (count: number | null) =>
    count == null ? "" : count === 1 ? " — 1 line" : ` — ${count} lines`;
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">Align · 1 step</p>
      <h2 className="ux-flow-title">
        Which copy of <span className="ux-mono-fg">{name}</span> wins?
      </h2>
      <p className="ux-page-lede">
        Claude reads <span className="ux-mono-fg">.claude/skills/{name}</span> and
        Codex <span className="ux-mono-fg">.agents/skills/{name}</span>, and {at} the two are
        not the same file.
        {card ? " Both changed, so Plyloft can't tell which one is meant." : ""} The one you
        choose replaces the other, file for file.
      </p>
      <ChoiceList
        value={choice}
        onChange={setChoice}
        label={`Which copy of ${name} wins`}
        // Owner-fixes walk: the first ↓ went to the page — the question is
        // this surface's one step, so focus starts in it.
        autoFocus
        options={[
          {
            value: "claude",
            label: "Claude's copy",
            hint: `What .claude/skills/${name} holds ${at}${length(lines.claude)}. Codex's copy is replaced by it.`,
          },
          {
            value: "codex",
            label: "Codex's copy",
            hint: `What .agents/skills/${name} holds ${at}${length(lines.codex)}. Claude's copy is replaced by it.`,
          },
        ]}
      />
      <StatusLine state="empty">
        {card
          ? "One card, with one commit. Once it ships, everyone who opens this repository gets the same skill in Claude and in Codex, from their next session; your project folder is untouched."
          : `One commit on ${where}. Claude and Codex both get the same skill from then on; your project folder is untouched.`}
      </StatusLine>
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn
          tone="accent"
          onClick={() => choice !== null && onAlign(choice)}
          disabled={busy || choice === null}
        >
          {busy ? (card ? "Making the card…" : "Aligning…") : "Align"}
        </CBtn>
      </div>
    </div>
  );
}
