// UX-5.6: the Board's second view — the same cards as the columns (same
// search and filters), as compact rows grouped by attention: Title · Status ·
// Builder · Checks · Updated. Sortable; rows can be selected and the
// eligible ones shipped together through the one Ship batch sheet. CL-9:
// or grouped by stage (To do → Finished), with each row's attention said
// in its own column.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePageVisible } from "../hooks/usePageVisible";
import type { KanbanCard, SwarmStatus } from "../ipc";
import { useUi } from "../store/uiStore";
import { machineWords } from "../lib/platform";
import { TEAM_BOARD_READ_ONLY_MESSAGE } from "../lib/teamGateCardWrites";
import { useCardPresenter } from "../hooks/useCardLive";
import { useBuilder } from "../store/builderStore";
import { useSettings } from "../store/settingsStore";
import { effectiveBuilderVendor } from "../lib/cardPage";
import { presentationStage } from "../lib/cardPresentation";
import {
  ATTENTION_COLUMNS,
  isShipBatchEligible,
  SHIP_BATCH_RULE,
  shipBatchLeftOut,
  shipBatchShown,
  shipBatchTitle,
  type AttentionGroups,
} from "../lib/boardSemantics";
import {
  ATTENTION_DOT,
  ATTENTION_LABEL,
  BOARD_BUILDER_LABEL,
  boardListRow,
  sortBoardRows,
  sortStageRows,
  stageGroups,
  updatedLabel,
  type BoardListRow,
  type BoardListSort,
  type BoardListSortKey,
  type ListGrouping,
} from "../lib/boardList";
import { CBtn, Icon, ListView, StateWord, type ListColumn } from "./ux";
import { useLiveReviewTips } from "./useReviewTip";

/** 1.171.0 E3 (owner D5): the selection bar's words where Ship N isn't
 *  offered — with one card the batch would take. */
export const LIST_SHIP_ONE = "Select two or more to ship them together";
/** SP-D: nothing selected is one the batch takes. */
export const LIST_NONE_IN_BATCH = "None of these can be released with others yet";

/** How often the List reads its rows' times again while a session runs. */
export const BOARD_LIST_TICK_MS = 30_000;

export function BoardList({
  workspaceId,
  groups,
  statusOf,
  doneFooter,
  doneHidden = [],
  onShipSelected,
  empty,
  readOnly = false,
  grouping = "attention",
  onShipFilled,
}: {
  workspaceId: string;
  groups: AttentionGroups;
  /** CL-9: by attention (the columns) or by stage, To do → Finished. */
  grouping?: ListGrouping;
  statusOf: (card: KanbanCard) => SwarmStatus | null;
  /** UX-5.8: Done's "Show all N", as on the columns. */
  doneFooter?: ReactNode;
  /** P-D2 Mac walk: the Done cards past the latest ten, not drawn until
   *  "Show all N" — each heading they belong under says "10 of 12", so the
   *  count is the rows shown and says what is left out. */
  doneHidden?: readonly KanbanCard[];
  onShipSelected: (cardIds: string[]) => void;
  empty?: ReactNode;
  /** GH #252: a read-only Board ships nothing; the reason is the title. */
  readOnly?: boolean;
  /** 1.174.0 (A4, owner): the selection bar's Ship N is the List's filled
   *  button while it shows; the header's New card is bordered meanwhile. */
  onShipFilled?: (filled: boolean) => void;
}) {
  const selectCard = useUi((s) => s.selectCard);
  const [sort, setSort] = useState<BoardListSort>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const now = Date.now();
  // P-A (UX P1 point 2): a row says what the Board card, the card page and
  // the Inbox say — `presentCard`, from the same live facts (the live tips
  // of open Builder sessions included, so "Ready to ship" is the page's).
  const presenter = useCardPresenter();
  void statusOf;
  void workspaceId;
  const listed = useMemo(
    () => ATTENTION_COLUMNS.flatMap((column) => groups[column.id]),
    [groups],
  );
  const tips = useLiveReviewTips(listed);
  // 1.172 A3 (C1 note): a row's "· 2m" and its Updated column move on by
  // themselves, as the card page's waiting line does — every 30 s while a
  // listed card has a live session or runs, and the window is shown.
  const pageVisible = usePageVisible();
  const [tick, setTick] = useState(0);
  // 1.171.0 re-walk (step 4): a card with no session yet names the AI its
  // page shows (its own pick, else Settings'), never "None".
  const vendorPref = useBuilder((s) => s.vendorPref);
  const builderDefault = useSettings((s) => s.settings.behavior.builderVendor);

  const listGroups = useMemo(() => {
    const presented = (card: KanbanCard) => presenter(card, tips.get(card.id) ?? null);
    const rowOf = (card: KanbanCard) =>
      boardListRow(card, presented(card), effectiveBuilderVendor(vendorPref[card.id], card, builderDefault));
    const ofTotal = (shown: number, hidden: number): string | undefined =>
      hidden > 0 ? `${shown} of ${shown + hidden}` : undefined;
    if (grouping === "stage") {
      const hiddenByStage = new Map<string, number>();
      for (const card of doneHidden) {
        const stage = presentationStage(card, presented(card)) ?? "to-do";
        hiddenByStage.set(stage, (hiddenByStage.get(stage) ?? 0) + 1);
      }
      // CL-9: each row keeps its attention word, so nothing that needs the
      // person is hidden by the stage it is in. The stage is read off the
      // same presentation as the row's word.
      return stageGroups(groups, (card) => presentationStage(card, presented(card)))
        .map((stage) => ({
          key: stage.id,
          label: stage.label,
          count: ofTotal(stage.cards.length, hiddenByStage.get(stage.id) ?? 0),
          // Round 2 (F1): a column sort keeps what needs the person first.
          rows: sortStageRows(
            stage.cards.map(({ card, attention }) => ({ ...rowOf(card), attention })),
            sort,
          ),
        }))
        .filter((g) => g.rows.length > 0);
    }
    return ATTENTION_COLUMNS.map((column) => ({
      key: column.id,
      label: column.label,
      count: column.id === "done" ? ofTotal(groups.done.length, doneHidden.length) : undefined,
      rows: sortBoardRows(groups[column.id].map(rowOf), sort),
    })).filter((g) => g.rows.length > 0);
    // `tick`: read again on the clock, so the times on the rows move on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, doneHidden, sort, grouping, tips, presenter, vendorPref, builderDefault, tick]);
  // A3 Challenger: and while a row runs with no session open — checks
  // running, the Challenger reviewing, shipping, a fix round after the
  // session closed: its running line is timed too.
  const ticking =
    pageVisible &&
    listGroups.some((g) => g.rows.some((r) => Boolean(r.card.builder?.ptyId) || r.run.live || r.run.state === "running"));
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setTick((n) => n + 1), BOARD_LIST_TICK_MS);
    return () => window.clearInterval(id);
  }, [ticking]);

  // Only what is on screen stays selected: a filter or a state change that
  // takes a row away takes its tick with it.
  const shown = new Map<string, KanbanCard>();
  for (const g of listGroups) for (const r of g.rows) shown.set(r.id, r.card);
  const selected = new Set([...picked].filter((id) => shown.has(id)));
  const shippable = [...selected].filter((id) => isShipBatchEligible(shown.get(id)!));
  // 1.171.0 E3 (owner D5): the batch is for two or more cards — as the
  // header's Ship N and the sidebar's row.
  // 1.171.0 walk fix (Blocks E+F, step 2): a card its page calls ready that
  // the batch leaves out says why, in F1's words (session open, not saved,
  // not approved…): beside the note when one card is left out ("Its" is
  // that card), every reason in its title.
  const shipFilled =
    selected.size > 0 && !readOnly && shipBatchShown(shippable.length);
  useEffect(() => {
    onShipFilled?.(shipFilled);
  }, [onShipFilled, shipFilled]);
  useEffect(() => () => onShipFilled?.(false), [onShipFilled]);
  const leftOut = [...selected]
    .map((id) => shipBatchLeftOut(shown.get(id)!))
    .filter((why): why is string => why != null);

  const columns: ListColumn<BoardListRow>[] = [
    { key: "title", label: "Title", primary: true, sortable: true, cell: (r) => r.title },
    {
      key: "status",
      label: "Status",
      sortable: true,
      // GH #248: a long "Blocked by …" is cut at the column, the whole on
      // hover; the title takes the free width. 1.171.0 (B1): "Shipped · only
      // on this Mac" reads "this PC" on Windows.
      width: "lg",
      tooltip: (r) => machineWords(r.status),
      // P-A: the cell carries the rule its word came from (`data-ply-rule`).
      // Mac walk 3: on the cell itself, which the tester's tree names by its
      // words ("Ready to ship", rule=…), as the Board card's node.
      cellData: (r) => ({ "data-ply-rule": r.rule }),
      cell: (r) =>
        r.blocked ? (
          <span className="ux-state">
            <Icon name="blockedBy" size="sm" />
            {r.status}
          </span>
        ) : (
          <StateWord state={r.run.state} live={r.run.live}>
            {r.status}
          </StateWord>
        ),
    },
    ...(grouping === "stage"
      ? [
          {
            key: "attention",
            label: "Attention",
            sortable: true,
            // CL-10: "Needs you" fits 144px; 96px cut it.
            width: "md" as const,
            tooltip: (r: BoardListRow) => (r.attention ? ATTENTION_LABEL[r.attention] : undefined),
            cell: (r: BoardListRow) =>
              r.attention ? (
                <StateWord state={ATTENTION_DOT[r.attention]}>
                  {ATTENTION_LABEL[r.attention]}
                </StateWord>
              ) : null,
          },
        ]
      : []),
    {
      key: "builder",
      label: "Builder",
      sortable: true,
      width: "sm",
      cell: (r) => BOARD_BUILDER_LABEL[r.builder],
    },
    { key: "checks", label: "Checks", sortable: true, width: "sm", cell: (r) => r.checks },
    {
      key: "updated",
      label: "Updated",
      sortable: true,
      width: "sm",
      cell: (r) => updatedLabel(r.updatedAt, now),
    },
  ];

  return (
    <div className="board-list">
      <ListView
        label="Cards"
        columns={columns}
        groups={listGroups}
        sort={sort ?? undefined}
        onSort={(next) => setSort({ key: next.key as BoardListSortKey, dir: next.dir })}
        selected={selected}
        onSelect={(id, on) =>
          setPicked((cur) => {
            const next = new Set(cur);
            if (on) next.add(id);
            else next.delete(id);
            return next;
          })
        }
        onOpen={(r) => selectCard(workspaceId, r.id)}
        rowLabel={(r) => r.title}
        empty={empty}
        selectionBar={
          <>
            <span className="board-list-bar-count">{selected.size} selected</span>
            {readOnly ? (
              <span className="board-list-bar-note" title={TEAM_BOARD_READ_ONLY_MESSAGE}>
                This board is read-only
              </span>
            ) : shippable.length === 1 ? (
              <span className="board-list-bar-note">{LIST_SHIP_ONE}</span>
            ) : shipBatchShown(shippable.length) ? (
              <CBtn
                size="sm"
                tone="accent"
                title={shipBatchTitle(shippable.length)}
                onClick={() => onShipSelected(shippable)}
              >
                <Icon name="shipBatch" size="sm" />
                Ship {shippable.length}
              </CBtn>
            ) : (
              // SP-D: a card can be Ready to ship and still not in a batch
              // (an approved Builder card in In progress ships from its page).
              <span
                className="board-list-bar-note"
                title={leftOut.length > 0 ? [...new Set(leftOut)].join("\n") : SHIP_BATCH_RULE}
              >
                {leftOut.length === 1 ? `${LIST_NONE_IN_BATCH}. ${leftOut[0]}` : LIST_NONE_IN_BATCH}
              </span>
            )}
            <CBtn size="sm" tone="quiet" onClick={() => setPicked(new Set())}>
              Clear
            </CBtn>
          </>
        }
      />
      {doneFooter}
    </div>
  );
}
