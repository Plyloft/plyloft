import { useState } from "react";
import { CBtn, ChoiceList, StatusLine } from "../ux";
import type { Compare3, Compare3File } from "../../ipc";
import {
  KEEP_MINE_LABEL,
  PROPOSE_UPSTREAM_LABEL,
  TAKE_UPSTREAM_LABEL,
  choiceLines,
  compare3StatusLabel,
} from "../../lib/skillCards";
import { markedLines } from "../../lib/threeWay";
import { workingLabel, workingLine } from "./LinkCompareFlow";

/** The member's answer to a copy changed on both sides (R3). */
export type BothChangedChoice = "keepMine" | "takeUpstream" | "propose";

/**
 * Skills hub H4 (R3; mockup 4 "3-way compare"): a linked copy changed here
 * and in its library. Every file that differs, with whose change it is
 * (*both* / *only you* / *only the team*); for the chosen file the three
 * versions side by side — *before* (the version this copy started from),
 * the library *now*, and *here* — each line the library or this repository
 * changed marked with `+` (never colour alone). Then the three choices, each
 * with what it does: **Keep mine**, **Take upstream**, **Propose mine
 * upstream**. Nothing is lost either way, and nothing happens until a card
 * ships or a pull request merges.
 *
 * Without the version it started from on this Mac it is 2-way and says so;
 * Keep mine and Take upstream still work.
 */
export function ThreeWayCompareFlow({
  name,
  compare,
  error,
  busy,
  onHide,
  onChoose,
}: {
  name: string;
  compare: Compare3 | null;
  error: string | null;
  busy: boolean;
  onHide: () => void;
  onChoose: (choice: BothChangedChoice) => void;
}) {
  const [file, setFile] = useState<string | null>(null);
  const [choice, setChoice] = useState<BothChangedChoice>("keepMine");
  if (!compare && !error) {
    return <StatusLine state="running">Reading the three versions of {name}…</StatusLine>;
  }
  if (!compare) {
    return (
      <div className="ux-flow">
        <p className="ux-flow-eyebrow">Compare · {name}</p>
        <StatusLine state="aborted">
          Plyloft could not read the versions of <span className="ux-mono-fg">{name}</span>. Nothing was changed. {error}
        </StatusLine>
        <div className="ux-flow-actions">
          <CBtn tone="quiet" onClick={onHide}>
            Close
          </CBtn>
        </div>
      </div>
    );
  }
  const words = compare.originWords;
  const shown: Compare3File | undefined =
    compare.files.find((f) => f.path === file) ?? compare.files[0];
  const lines = choiceLines(words);
  const proposeBlocked = compare.proposeBlocked;
  const picked = choice === "propose" && proposeBlocked ? "keepMine" : choice;
  return (
    <div className="ux-flow ux-flow--wide">
      <p className="ux-flow-eyebrow">Compare · {name}</p>
      <h2 className="ux-flow-title">
        <span className="ux-mono-fg">{name}</span> changed in {words} and here
      </h2>
      <p className="ux-page-lede">
        Both sides changed it since this repository linked it. Choose what this repository keeps; nothing is lost
        either way.
      </p>
      {compare.note && <p className="ux-card-muted">{compare.note}</p>}
      {compare.keptNote && <p className="ux-card-muted">{compare.keptNote}</p>}
      {compare.files.length === 0 ? (
        <p className="ux-card-muted">The two versions hold the same files now.</p>
      ) : (
        <>
          <div className="ux-compare-files" role="list" aria-label={`Files of ${name} that differ`}>
            {compare.files.map((f) => (
              <button
                key={f.path}
                type="button"
                role="listitem"
                className={f.path === shown?.path ? "ux-compare-file ux-compare-file--on" : "ux-compare-file"}
                aria-current={f.path === shown?.path ? "true" : undefined}
                onClick={() => setFile(f.path)}
              >
                <span className="ux-mono-fg">{f.path}</span>
                <span className="cchip cchip--outline">{compare3StatusLabel(f.status, words)}</span>
              </button>
            ))}
          </div>
          {shown && <ThreeColumns compare={compare} file={shown} />}
        </>
      )}
      <ChoiceList
        value={picked}
        onChange={setChoice}
        label={`What this repository keeps of ${name}`}
        options={[
          { value: "keepMine", label: KEEP_MINE_LABEL, hint: lines.keepMine },
          { value: "takeUpstream", label: TAKE_UPSTREAM_LABEL, hint: lines.takeUpstream },
          {
            value: "propose",
            label: PROPOSE_UPSTREAM_LABEL,
            hint: proposeBlocked ?? lines.propose,
            disabled: proposeBlocked != null,
          },
        ]}
      />
      {busy && <StatusLine state="running">{workingLine(picked, words)}</StatusLine>}
      <div className="ux-flow-actions">
        <CBtn tone="quiet" onClick={onHide} disabled={busy}>
          Close
        </CBtn>
        <CBtn tone="accent" onClick={() => onChoose(picked)} disabled={busy}>
          {busy
            ? workingLabel(picked)
            : picked === "keepMine"
              ? KEEP_MINE_LABEL
              : picked === "takeUpstream"
                ? TAKE_UPSTREAM_LABEL
                : PROPOSE_UPSTREAM_LABEL}
        </CBtn>
      </div>
    </div>
  );
}

export function ThreeColumns({
  compare,
  file,
}: {
  compare: Pick<Compare3, "baseLabel" | "upstreamLabel" | "hereLabel">;
  file: Compare3File;
}) {
  if (file.notShown) {
    return (
      <p className="ux-card-muted">
        <span className="ux-mono-fg">{file.path}</span> isn't text Plyloft can show (or is over 1 MB).
      </p>
    );
  }
  const sides: { heading: string; text: string | null; marked: boolean }[] = [
    ...(compare.baseLabel != null ? [{ heading: `Before · ${compare.baseLabel}`, text: file.base, marked: false }] : []),
    { heading: compare.upstreamLabel, text: file.upstream, marked: true },
    { heading: compare.hereLabel, text: file.here, marked: true },
  ];
  return (
    <div className={sides.length === 3 ? "ux-compare ux-compare--three" : "ux-compare"}>
      {sides.map((side) => {
        const rows = markedLines(compare.baseLabel != null ? file.base : null, side.text, side.marked);
        return (
          <div key={side.heading} className="ux-compare-side">
            <div className="ux-compare-head">
              {side.heading} · {side.text == null ? "not there" : rows.length === 1 ? "1 line" : `${rows.length} lines`}
            </div>
            <div className="ux-compare-lines">
              {side.text == null ? (
                <div className="ux-compare-line">
                  <span className="ux-compare-text">(nothing here)</span>
                </div>
              ) : (
                rows.map((row, i) => (
                  <div key={i} className={row.changed ? "ux-compare-line ux-compare-line--diff" : "ux-compare-line"}>
                    <span className="ux-compare-no">{i + 1}</span>
                    {row.changed ? (
                      <span className="ux-compare-mark" role="img" aria-label="changed since before">
                        +
                      </span>
                    ) : (
                      <span className="ux-compare-mark" aria-hidden />
                    )}
                    <span className="ux-compare-text">{row.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
