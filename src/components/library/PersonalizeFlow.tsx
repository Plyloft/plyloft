import { useState } from "react";
import { CBtn, ChoiceList, StatusLine } from "../ux";
import type { PlyPlace } from "../../ipc";
import { personalizeChoices } from "../../lib/plySkillSwitch";

/**
 * Skills hub H9 (R9; mockup 7 "Personalize…"): make your own copy of a skill
 * that comes with Plyloft — in this repository (a skill card, free) or in the
 * team library (published, R7). Either way Plyloft's own copy is switched off
 * where the copy applies: the card switches it off in this workspace once it
 * ships; the team default switches it off for the team, which only the team
 * owner may set — a member hears so here, before anything is written.
 */
export function PersonalizeFlow({
  name,
  title,
  place,
  solo,
  busy,
  onCancel,
  onPersonalize,
}: {
  name: string;
  /** The skill's own heading (`Write a good card brief`). */
  title: string;
  place: PlyPlace | null;
  solo: boolean;
  busy: boolean;
  onCancel: () => void;
  onPersonalize: (target: "repository" | "team") => void;
}) {
  const choices = personalizeChoices(name, place, solo);
  const [choice, setChoice] = useState<"repository" | "team">("repository");
  const repo = place?.repository ?? "this repository";
  return (
    <div className="ux-flow">
      <p className="ux-flow-eyebrow">Personalize · 1 step</p>
      <h2 className="ux-flow-title">
        Where should your own <span className="ux-mono-fg">{name}</span> live?
      </h2>
      <p className="ux-page-lede">
        {title} comes with Plyloft and can't be edited. Personalize copies it, with a link to the version it
        started from, so you can change it — and later see when Plyloft changes the original.
      </p>
      <ChoiceList
        value={choice}
        onChange={setChoice}
        label={`Where your ${name} goes`}
        options={choices.map((c) => ({ value: c.id, label: c.label, hint: c.hint }))}
      />
      <StatusLine state="empty">
        {choice === "repository"
          ? `Nothing changes until the card ships; then everyone who opens ${repo} gets your ${name} instead of ply:${name} once they pull it.`
          : `Published to the team library now; sessions get it from their next start.`}
      </StatusLine>
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </CBtn>
        <CBtn tone="accent" onClick={() => onPersonalize(choice)} disabled={busy}>
          {busy ? "Personalizing…" : choice === "repository" ? "Make the card" : "Personalize"}
        </CBtn>
      </div>
    </div>
  );
}
