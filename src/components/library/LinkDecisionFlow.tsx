import { useState } from "react";
import { CBtn, ChoiceList, StatusLine } from "../ux";
import {
  KEEP_LABEL,
  KEEP_OLD_NAME_LABEL,
  REMOVE_LABEL,
  RENAME_HERE_LABEL,
  removedChoiceLines,
  renamedChoiceLines,
} from "../../lib/skillCards";

/** What the library did to a linked copy, and the answer. */
export type LinkDecision =
  | { kind: "removed"; choice: "keep" | "remove" }
  | { kind: "renamed"; choice: "rename" | "keepName" };

/**
 * Skills hub H4 (R8; mockup 3 "Removed from the team library"): the
 * library no longer has a linked skill, or has it under a new name. Two
 * choices, each a card in this workspace — nothing changes until it ships,
 * and sessions keep the repository's copy until then. *Keep* is the default
 * (it changes no skill file); *Remove* warns when the copy was changed here.
 */
export function LinkDecisionFlow({
  name,
  originWords,
  kind,
  renamedTo,
  modified,
  copies = 2,
  busy,
  onCancel,
  onDecide,
}: {
  name: string;
  originWords: string;
  kind: "removed" | "renamed";
  renamedTo: string | null;
  /** The copy here was changed since it was linked. */
  modified: boolean;
  /** How many copies the skill has here (Claude's, Codex's). */
  copies?: number;
  busy: boolean;
  onCancel: () => void;
  onDecide: (decision: LinkDecision) => void;
}) {
  const [removed, setRemoved] = useState<"keep" | "remove">("keep");
  const [renamed, setRenamed] = useState<"rename" | "keepName">("rename");
  const newName = renamedTo ?? "its new name";
  const removedLines = removedChoiceLines(originWords, modified, copies);
  const renamedLines = renamedChoiceLines(newName);
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">{kind === "removed" ? "Removed where it came from" : "Renamed where it came from"} · 1 step</p>
      <h2 className="ux-flow-title">
        {kind === "removed" ? (
          <>
            <span className="ux-mono-fg">{name}</span> was removed from {originWords}
          </>
        ) : (
          <>
            <span className="ux-mono-fg">{name}</span> is <span className="ux-mono-fg">{newName}</span> in{" "}
            {originWords} now
          </>
        )}
      </h2>
      <p className="ux-page-lede">
        {kind === "removed"
          ? `This repository still has its copy, and sessions keep using it until a card changes that.`
          : `This repository still has it as ${name}. Nothing changes until a card ships.`}
      </p>
      {kind === "removed" ? (
        <ChoiceList
          value={removed}
          onChange={setRemoved}
          label={`What happens to ${name} here`}
          options={[
            { value: "keep", label: KEEP_LABEL, hint: removedLines.keep },
            { value: "remove", label: REMOVE_LABEL, hint: removedLines.remove },
          ]}
        />
      ) : (
        <ChoiceList
          value={renamed}
          onChange={setRenamed}
          label={`What happens to ${name} here`}
          options={[
            { value: "rename", label: RENAME_HERE_LABEL, hint: renamedLines.rename },
            { value: "keepName", label: KEEP_OLD_NAME_LABEL, hint: renamedLines.keepName },
          ]}
        />
      )}
      <StatusLine state="empty">Either way it is one card in this workspace, ready to ship.</StatusLine>
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        {kind === "removed" ? (
          <CBtn
            tone={removed === "remove" ? "danger" : "accent"}
            onClick={() => onDecide({ kind: "removed", choice: removed })}
            disabled={busy}
          >
            {busy ? "Making the card…" : removed === "keep" ? KEEP_LABEL : REMOVE_LABEL}
          </CBtn>
        ) : (
          <CBtn tone="accent" onClick={() => onDecide({ kind: "renamed", choice: renamed })} disabled={busy}>
            {busy ? "Making the card…" : renamed === "rename" ? RENAME_HERE_LABEL : KEEP_OLD_NAME_LABEL}
          </CBtn>
        )}
      </div>
    </div>
  );
}
