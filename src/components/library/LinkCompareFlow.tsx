import { useState } from "react";
import { CBtn, StatusLine } from "../ux";
import type { LinkCompare, LinkCompareFile } from "../../ipc";
import { compare3StatusLabel } from "../../lib/skillCards";
import { SkillCompare } from "./SkillCompare";

/** Skills hub H4 (R3): a choice under a *Modified here* compare. */
export interface LinkCompareChoice {
  id: "takeUpstream" | "propose";
  label: string;
  /** What it does, in one sentence (R18.4). */
  hint: string;
  /** Why it can't be pressed, said instead of the hint. */
  blocked?: string | null;
}

/** The pressed choice's button while it works. */
export function workingLabel(id: "keepMine" | "takeUpstream" | "propose"): string {
  return id === "propose" ? "Proposing…" : "Making the card…";
}

/** The line under the choices while one works. */
export function workingLine(id: "keepMine" | "takeUpstream" | "propose", originWords: string): string {
  return id === "propose"
    ? `Opening a pull request in ${originWords}… This can take a minute.`
    : "Making the card…";
}

/**
 * Skills hub H3a (R2, R3 as far as H3 goes; §9: free, read only): a linked
 * copy against where it came from, side by side.
 *
 * *Update available* shows this repository's copy and the library's version
 * now; *Modified here* shows the version it started from and this
 * repository's copy.
 *
 * H4 Mac walk: like the 3-way Compare, every file that differs is listed
 * with whose change it is (*only you* / *only the team*), and the chosen
 * file's two versions are drawn side by side (they stack only in a narrow
 * flow). A skill of many files can be read file by file.
 *
 * Skills hub H4 (R3): under a *Modified here* compare, the two ways on —
 * **Take upstream** (put the library's version back, by card) and
 * **Propose mine upstream** (a pull request in the library). Both on every
 * plan.
 */
export function LinkCompareFlow({
  name,
  compare,
  error,
  onHide,
  originWords = "the team library",
  choices = [],
  busy = false,
  onChoose,
}: {
  name: string;
  compare: LinkCompare | null;
  error: string | null;
  onHide: () => void;
  originWords?: string;
  choices?: LinkCompareChoice[];
  busy?: boolean;
  onChoose?: (id: LinkCompareChoice["id"]) => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [pressed, setPressed] = useState<LinkCompareChoice["id"] | null>(null);
  if (!compare && !error) {
    return <StatusLine state="running">Reading both versions of {name}…</StatusLine>;
  }
  const files = compare?.files;
  const shown: LinkCompareFile | undefined = files?.find((f) => f.path === file) ?? files?.[0];
  const side = (which: "left" | "right") => {
    const base = compare?.[which] ?? { label: "", meaning: "", place: "", text: null };
    if (!files) return base;
    // A file only one side has reads as empty on the other.
    return { ...base, text: shown ? (shown[which] ?? "") : base.text };
  };
  return (
    <div className="ux-flow ux-flow--wide">
      <p className="ux-flow-eyebrow">Compare · {name}</p>
      {compare?.note && <p className="ux-card-muted">{compare.note}</p>}
      {files && files.length > 0 && (
        <div className="ux-compare-files" role="list" aria-label={`Files of ${name} that differ`}>
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              role="listitem"
              className={f.path === shown?.path ? "ux-compare-file ux-compare-file--on" : "ux-compare-file"}
              aria-current={f.path === shown?.path ? "true" : undefined}
              onClick={() => setFile(f.path)}
            >
              <span className="ux-mono-fg">{f.path}</span>
              <span className="cchip cchip--outline">{compare3StatusLabel(f.status, originWords)}</span>
            </button>
          ))}
        </div>
      )}
      {compare && files && files.length === 0 ? (
        <p className="ux-card-muted">The two versions hold the same files now.</p>
      ) : shown?.notShown ? (
        <p className="ux-card-muted">
          <span className="ux-mono-fg">{shown.path}</span> isn't text Plyloft can show (or is over 1 MB).
        </p>
      ) : (
        <SkillCompare
          name={name}
          title={shown ? `The two versions of ${shown.path}` : "The two versions, side by side"}
          pair
          hideButton={false}
          left={side("left")}
          right={side("right")}
          error={error}
          actions={[]}
          busy={false}
          onAction={() => {}}
          onHide={onHide}
        />
      )}
      {compare && !files && compare.otherFiles.length > 0 && (
        <p className="ux-card-muted">Other files that differ: {compare.otherFiles.join(", ")}.</p>
      )}
      {compare && !files && compare.left.text == null && compare.right.text == null && (
        <p className="ux-card-muted">Neither version has a SKILL.md to show.</p>
      )}
      {compare && choices.length > 0 && (
        <>
          {choices.map((choice) => (
            <p key={choice.id} className="ux-card-muted">
              <strong>{choice.label}</strong> — {choice.blocked ?? choice.hint}
            </p>
          ))}
          <div className="ux-compare-actions">
            {choices.map((choice) => (
              <CBtn
                key={choice.id}
                tone="quiet"
                disabled={busy || choice.blocked != null}
                aria-busy={(busy && pressed === choice.id) || undefined}
                onClick={() => {
                  setPressed(choice.id);
                  onChoose?.(choice.id);
                }}
              >
                {busy && pressed === choice.id ? workingLabel(choice.id) : choice.label}
              </CBtn>
            ))}
          </div>
          {/* H4 Windows walk: a proposal can take most of a minute (a push and
              a pull request on GitHub); say so at once. */}
          {busy && pressed && <StatusLine state="running">{workingLine(pressed, originWords)}</StatusLine>}
        </>
      )}
      {/* H4 Windows walk: the 3-way's Close, here too (the section's
          "Hide" read as hiding the files, and closed the whole view). */}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onHide}>
          Close
        </CBtn>
      </div>
    </div>
  );
}
