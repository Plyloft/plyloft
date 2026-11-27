// UX-5.7: the Board's filter — Needs you, the card's state, its Builder.
// Combined (AND) with each other and with "Find a card"; the same filter
// narrows the columns and the List.
import { useState } from "react";
import type { BoardFilter } from "../lib/boardFilter";
import { boardFilterCount } from "../lib/boardFilter";
import { BOARD_BUILDER_LABEL, type BoardBuilder } from "../lib/boardList";
import { CBtn, Icon, Popover } from "./ux";
import { machineWords } from "../lib/platform";

export function BoardFilterMenu({
  filter,
  onChange,
  onClear,
  needsYouCount,
  states,
  builders,
}: {
  filter: BoardFilter;
  onChange: (patch: Partial<BoardFilter>) => void;
  onClear: () => void;
  needsYouCount: number;
  /** The states on this Board now, with their words, in column order. */
  states: ReadonlyArray<{ state: string; label: string }>;
  builders: readonly BoardBuilder[];
}) {
  const [open, setOpen] = useState(false);
  const count = boardFilterCount(filter);
  const toggle = <T,>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...list.filter((x) => x !== item), item] : list.filter((x) => x !== item);
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      label="Filter the cards"
      trigger={
        <CBtn
          aria-label={count > 0 ? `Filter, ${count} on` : "Filter"}
          aria-expanded={open}
          title="Filter the cards"
          active={count > 0}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="filter" />
          {count > 0 && <span className="board-filter-count">{count}</span>}
        </CBtn>
      }
    >
      <div className="board-filter">
        <label className="board-filter-option">
          <input
            type="checkbox"
            checked={filter.needsYouOnly}
            onChange={(e) => onChange({ needsYouOnly: e.target.checked })}
          />
          Needs you only
          <span className="board-filter-muted">{needsYouCount}</span>
        </label>
        {states.length > 0 && (
          <fieldset className="board-filter-group">
            <legend className="board-filter-legend">State</legend>
            {states.map((s) => (
              <label key={s.state} className="board-filter-option">
                <input
                  type="checkbox"
                  checked={filter.states.includes(s.state)}
                  onChange={(e) =>
                    onChange({ states: toggle(filter.states, s.state, e.target.checked) })
                  }
                />
                {/* 1.171.0 (B1): "Shipped · only on this Mac" is "this PC" on Windows. */}
                {machineWords(s.label)}
              </label>
            ))}
          </fieldset>
        )}
        {builders.length > 0 && (
          <fieldset className="board-filter-group">
            <legend className="board-filter-legend">Builder</legend>
            {builders.map((b) => (
              <label key={b} className="board-filter-option">
                <input
                  type="checkbox"
                  checked={filter.builders.includes(b)}
                  onChange={(e) =>
                    onChange({ builders: toggle(filter.builders, b, e.target.checked) })
                  }
                />
                {BOARD_BUILDER_LABEL[b]}
              </label>
            ))}
          </fieldset>
        )}
        <div className="board-filter-foot">
          <CBtn size="sm" disabled={count === 0} onClick={onClear}>
            Clear filters
          </CBtn>
        </div>
      </div>
    </Popover>
  );
}
