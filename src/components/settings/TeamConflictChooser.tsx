// QoL block 13.3 (G8): the team library conflict resolver. Under the
// collision block on Settings › Team: one row per file both sides changed,
// Keep mine / Keep theirs / Keep both, and one button that puts them
// together on this computer — never a publish (Publish is the next press,
// and Undo goes back to the backup the reapply recorded first).
import { useState } from "react";
import type { ReapplyChoice } from "../../ipc";
import { basename } from "../../lib/paths";
import { CHOICE_LABELS, SETTLE_LABEL, choiceMeaning, allChosen } from "../../lib/teamLibraryRecovery";
import { CBtn, Group, Row, Segmented } from "../ux";

export function TeamConflictChooser({
  paths,
  busy,
  initial,
  onSettle,
}: {
  /** Repo-relative, as the collision named them. */
  paths: string[];
  busy: boolean;
  /** Challenger (block 13): the choices already made for these files in an
   *  earlier round — a later commit's collision keeps them. */
  initial?: Record<string, ReapplyChoice>;
  onSettle: (choices: Record<string, ReapplyChoice>) => void;
}) {
  const [choices, setChoices] = useState<Record<string, ReapplyChoice>>(() =>
    Object.fromEntries(Object.entries(initial ?? {}).filter(([path]) => paths.includes(path))),
  );
  const ready = allChosen(paths, choices);
  // File names only (the folders are in the block's Details) — unless two
  // files share a name, which only their paths tell apart.
  const names = paths.map((p) => basename(p));
  const nameOf = (path: string) =>
    names.filter((n) => n === basename(path)).length > 1 ? path : basename(path);
  return (
    <div className="ux-flow" data-testid="team-conflict-chooser">
      <Group label="Which version the team library keeps">
        {paths.map((path) => (
          <Row key={path} kind="choice" label={nameOf(path)} mono>
            <Segmented<ReapplyChoice | "">
              label={`Which version of ${nameOf(path)} to keep`}
              value={choices[path] ?? ""}
              onChange={(next) => {
                if (next) setChoices((prev) => ({ ...prev, [path]: next }));
              }}
              options={CHOICE_LABELS}
            />
          </Row>
        ))}
      </Group>
      <p className="ux-section-note">{choiceMeaning()}</p>
      <div className="ux-flow-actions">
        <CBtn tone="accent" onClick={() => onSettle(choices)} disabled={busy || !ready}>
          {busy ? "Putting them together…" : SETTLE_LABEL}
        </CBtn>
      </div>
    </div>
  );
}
