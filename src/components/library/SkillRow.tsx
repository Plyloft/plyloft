import type { ReactNode } from "react";
import {
  AvailabilityChips,
  CBtn,
  DuplicateChip,
  MoreMenu,
  Row,
  RowValue,
  Toggle,
  type MenuItem,
} from "../ux";
import type { SkillMenuEntry, SkillRow as SkillRowModel } from "../../lib/librarySkills";
import { machineWords } from "../../lib/platform";
import { plyMacSwitchOverruled } from "../../lib/plySkillSwitch";
import { busyActionLabel, sentenceEnd } from "../../lib/skillCards";
import { InlineMd } from "../InlineMd";
import { TeamMark } from "../ProMark";

/**
 * UX language card 4 (GH #96; BOARDS.md §3 "Skill row"): mono name, the chips
 * of the CLIs it reaches, the description's first sentence, at most one action,
 * the `⋯`, and a `›` that opens the skill.
 *
 * Everything on it is decided by `lib/librarySkills.ts`; this file only draws.
 */
export function SkillRow({
  row,
  onOpen,
  onAction,
  onMenu,
  onSwitch,
  busy = false,
  busyLine = null,
  also = null,
}: {
  row: SkillRowModel;
  onOpen: () => void;
  onAction: () => void;
  onMenu: (entry: SkillMenuEntry) => void;
  /** GH #106: a Ply skill's switch. Called for no other scope. */
  onSwitch: (on: boolean) => void;
  /** A write about this row is running: its action and its `⋯` wait for it,
   *  so a second press cannot start a second write. The `›` stays live —
   *  opening the skill writes nothing. */
  busy?: boolean;
  /** Publish-sheet walk: what the busy press is doing, on the hint's line —
   *  for a press from the `⋯`, whose only other sign is the `⋯` greyed. */
  busyLine?: string | null;
  /** 1.174.0 (X3): "also in My library", in the value column. */
  also?: string | null;
}) {
  // GH #106, BOARDS.md §3's `Comes with Ply` rows: "a plain 15 px name, a hint
  // and a toggle". Its own shape, not the Skill row's with pieces removed —
  // the name is the file's own heading rather than a directory in mono, there is
  // no action and no `⋯`. Cold read 2026-10-19: the availability chips are
  // drawn like every other row's, so the section says which CLIs get them.
  // The `›` stays, because that page has to be reachable.
  if (row.ply) {
    return (
      <Row
        kind="toggle"
        label={row.ply.title}
        chips={
          <>
            <AvailabilityChips claude={row.claude} codex={row.codex} />
            {row.duplicate && <DuplicateChip>{row.duplicate.chip}</DuplicateChip>}
          </>
        }
        hint={
          (row.notes?.length ?? 0) === 0 ? (
            row.hint
          ) : (
            <>
              {row.hint}
              {/* Skills hub H9: which level decides, when it isn't this Mac's
                  switch beside it. */}
              {(row.notes ?? []).map((note) => (
                <span key={note}>
                  <br />
                  {machineWords(sentenceEnd(note))}
                </span>
              ))}
            </>
          )
        }
        onOpen={onOpen}
      >
        {/* Named and described by the row through `RowContext`, so the switch
            needs no label of its own and every id is a `useId`. A click on it
            does not open the page: `Row` ignores a click that came from a
            nested control. */}
        {/* Mac re-walk: this Mac's switch, quieter while a level above
            decides the other way here; the hint (its description) says so. */}
        <Toggle checked={row.ply.on} onChange={onSwitch} overruled={plyMacSwitchOverruled(row.ply.switch)} />
      </Row>
    );
  }
  const items: MenuItem[] = row.menu.map((entry) =>
    entry === "divider"
      ? "divider"
      : {
          label: entry.label,
          danger: "danger" in entry ? entry.danger : undefined,
          // F4: an entry shown off, with its reason under it.
          disabled: "disabled" in entry ? entry.disabled : undefined,
          hint: "hint" in entry ? entry.hint : undefined,
          onSelect: () => onMenu(entry),
        },
  );
  return (
    <Row
      kind="item"
      mono
      label={row.name}
      state={
        row.transient?.kind === "publishing"
          ? "publishing"
          : row.transient?.kind === "pullRequest" ||
              row.transient?.kind === "blocked" ||
              row.transient?.kind === "retrying" ||
              row.transient?.kind === "needsOk"
            ? "waiting"
            : row.transient?.kind === "removedUpstream" || row.linkState === "removed"
              ? "removed"
              : undefined
      }
      chips={
        <>
          <AvailabilityChips claude={row.claude} codex={row.codex} />
          {row.duplicate && <DuplicateChip>{row.duplicate.chip}</DuplicateChip>}
          {/* GH #105: the branch carries both copies and they say different
              things. An outline chip, like the duplicate's: it is a fact about
              the skill, and the action beside it is what to do about it. */}
          {row.drift && <DuplicateChip>{row.drift.chip}</DuplicateChip>}
          {/* Skills hub H3a: a linked copy's state, as an outline chip. */}
          {row.linkChip && <DuplicateChip>{row.linkChip}</DuplicateChip>}
        </>
      }
      hint={
        <>
          {row.hint}
          {row.notes.map((note) => (
            <span key={note}>
              <br />
              {/* A fragment, so `Row`'s own `forMachine` does not reach it. */}
              {/* SP-5 walk: a note's `code` is drawn, not shown as backticks. */}
              {/* H4 Windows re-walk: each note ends as a sentence, so the row
                  read aloud (or copied) never runs one into the next. */}
              <InlineMd text={machineWords(sentenceEnd(note))} links={false} />
            </span>
          ))}
          {busy && busyLine && (
            <>
              <br />
              <span className="ux-row-signal ux-row-signal--running" role="status">
                <span className="ux-row-signal-dot" aria-hidden />
                {busyLine}
              </span>
            </>
          )}
          {row.transient && (
            <>
              <br />
              {/* The state's words sit on the hint's line, so the mark on the
                  row is never the only thing that says what is happening. */}
              <span
                className={
                  row.transient.kind === "publishing"
                    ? "ux-row-signal ux-row-signal--running"
                    : row.transient.kind === "pullRequest" ||
                        row.transient.kind === "blocked" ||
                        row.transient.kind === "needsOk"
                      ? "ux-row-signal ux-row-signal--aborted"
                      : "ux-row-signal"
                }
                // F3/F9 review: git's own text, for whoever asks — never the line.
                title={row.transient.kind === "retrying" ? row.transient.details : undefined}
              >
                <span className="ux-row-signal-dot" aria-hidden />
                {row.transient.line}
              </span>
            </>
          )}
        </>
      }
      action={
        row.action &&
        wrapReveal(
          row.actionOnHover === true && !busy,
          // H4 Windows re-walk 2: a press that is working says so — Update
          // pulls the team library first (seconds on Windows), and a disabled
          // button with its old label read as a press that did nothing.
          <CBtn size="sm" tone="strong" disabled={busy} aria-busy={busy || undefined} onClick={onAction}>
            {busy ? busyActionLabel(row.action.id) : row.action.label}
            {row.scope === "team" && row.action.id === "install" && <TeamMark />}
          </CBtn>,
        )
      }
      more={items.length > 0 ? <MoreMenu items={items} label={`More for ${row.name}`} disabled={busy} /> : undefined}
      onOpen={onOpen}
    >
      {also ? <RowValue>{also}</RowValue> : null}
    </Row>
  );
}

/**
 * Cold read 2026-10-19: a row whose action shows only while the row is
 * hovered or holds focus (`On this Mac`'s `Share with Team…`, on many rows at
 * once). Hidden by opacity, never removed: Tab still reaches the button, and
 * reaching it shows it (`:focus-within`).
 */
function wrapReveal(reveal: boolean, button: ReactNode): ReactNode {
  return reveal ? <span className="ux-row-action-reveal">{button}</span> : button;
}
