import { useState } from "react";
import type { KanbanCard } from "../ipc";
import {
  ADD_BLOCKER_LABEL,
  blockerCandidates,
  blockersOf,
  cardLanded,
  dependentsOf,
} from "../lib/cardDependencies";
import type { CardPresentation } from "../lib/cardPresentation";
import { useCardPresenter } from "../hooks/useCardLive";
import { CBtn, Icon, Popover, SearchField, StateWord } from "./ux";

/** GH #263: a blocker in the property is named plainly — its issue, else
 *  its title — never in quotes; the quotes belong in sentences. */
function blockerLabel(card: Pick<KanbanCard, "title" | "ghIssueNumber">): string {
  return card.ghIssueNumber ? `#${card.ghIssueNumber}` : card.title;
}

/** P-A (UX P1 point 2): the blocker's dot and word are its Board card's —
 *  `presentCard`, from the same live facts. */
function blockerDot(b: KanbanCard, p: CardPresentation) {
  if (cardLanded(b)) return "done" as const;
  if (b.archived) return "empty" as const;
  return p.dot.state;
}

/**
 * C7 (UX-7.3): the card page's "Blocked by" property — the cards this one
 * waits for, each a link to it with its state in a word and a way to stop
 * waiting, and "Add" with a picker that searches this workspace's cards. The
 * picker never offers the card itself, an archived card, one already chosen
 * or one that would close a cycle; the backend refuses those anyway.
 * 1.174.0 (C2, BCI-11): the facts line draws it read-only, and only when
 * the card names a blocker (`blockedByShown`); Change… draws it to change,
 * with *Add a blocker* — never "Nothing".
 */
export function BlockedByValue({
  card,
  cards,
  readOnly,
  onOpen,
  onChange,
}: {
  card: KanbanCard;
  cards: readonly KanbanCard[];
  readOnly: boolean;
  onOpen: (cardId: string) => void;
  /** The whole new list; the caller writes it and says any refusal. */
  onChange: (blockedBy: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const present = useCardPresenter();
  const blockers = blockersOf(card, cards);
  const candidates = picking ? blockerCandidates(card, cards, query).slice(0, 8) : [];
  const ids = card.blockedBy ?? [];
  return (
    <span className="ux-card-deps">
      {blockers.map((b) => {
        const p = present(b);
        return (
        <span key={b.id} className="ux-card-dep" data-ply-rule={p.rule}>
          {/* GH #301: the dot is the blocker's own state, as its Board card
              draws it — a card that has not started is not running. */}
          <StateWord state={blockerDot(b, p)}>
            <CBtn
              tone="quiet"
              className="ux-card-dep-link"
              title={`${b.title} — ${p.blocked ?? p.headline}`}
              onClick={() => onOpen(b.id)}
            >
              {blockerLabel(b)}
            </CBtn>
          </StateWord>
          {!readOnly && (
            <CBtn
              tone="quiet"
              className="ux-card-dep-remove"
              aria-label={`Stop waiting for ${b.title}`}
              title={`Stop waiting for ${b.title}`}
              onClick={() => onChange(ids.filter((id) => id !== b.id))}
            >
              <Icon name="close" size="sm" />
            </CBtn>
          )}
        </span>
        );
      })}
      {!readOnly && (
        <span className="ux-card-deps-foot">
          <Popover
            open={picking}
            onClose={() => {
              setPicking(false);
              setQuery("");
            }}
            label="Wait for another card"
            trigger={
              <CBtn
                tone="quiet"
                aria-haspopup="dialog"
                aria-expanded={picking}
                onClick={() => setPicking((p) => !p)}
              >
                <Icon name="blockedBy" size="sm" />
                {ADD_BLOCKER_LABEL}
              </CBtn>
            }
          >
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Find a card"
              onEnter={() => {
                const first = candidates[0];
                if (!first) return;
                onChange([...ids, first.id]);
                setPicking(false);
                setQuery("");
              }}
            />
            <div className="ux-card-picker" role="list" aria-label="Cards this one can wait for">
              {candidates.length === 0 ? (
                <p className="ux-card-picker-empty">
                  {query ? "No card matches." : "No other card can be waited for."}
                </p>
              ) : (
                candidates.map((c) => (
                  <span key={c.id} role="listitem">
                    <CBtn
                      tone="quiet"
                      className="ux-card-picker-item"
                      title={c.ghIssueNumber ? `#${c.ghIssueNumber} ${c.title}` : c.title}
                      onClick={() => {
                        onChange([...ids, c.id]);
                        setPicking(false);
                        setQuery("");
                      }}
                    >
                      {/* GH #264: a long title ends in an ellipsis; the whole
                          title is the item's tooltip. */}
                      <span className="ux-card-picker-title">
                        {c.ghIssueNumber ? `#${c.ghIssueNumber} ${c.title}` : c.title}
                      </span>
                    </CBtn>
                  </span>
                ))
              )}
            </div>
          </Popover>
        </span>
      )}
    </span>
  );
}

/** C7 (UX-7.3): the cards that wait for this one, as links. */
export function BlocksValue({
  card,
  cards,
  onOpen,
}: {
  card: KanbanCard;
  cards: readonly KanbanCard[];
  onOpen: (cardId: string) => void;
}) {
  const dependents = dependentsOf(card, cards);
  if (dependents.length === 0) return <span className="ux-card-deps-none">Nothing</span>;
  return (
    <span className="ux-card-deps">
      {dependents.map((d) => (
        <CBtn key={d.id} tone="quiet" className="ux-card-dep-link" title={d.title} onClick={() => onOpen(d.id)}>
          {d.title}
        </CBtn>
      ))}
    </span>
  );
}
