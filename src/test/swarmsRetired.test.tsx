// G4 (launch D8): no new swarm starts from the Board. A card's start with a
// template that never ran dispatches no swarm; a card that ran one and is
// started again at the cap is left queued, its old swarm unlinked so the
// pump starts it when a slot frees.
import { describe, expect, it } from "vitest";
import { useKanban } from "../store/kanbanStore";
import type { KanbanCard } from "../ipc";
import { tauri } from "./tauri";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";

function stub(atCap: boolean) {
  const t = tauri();
  t.allowUnhandled();
  t.fixture("kanban_card_advance_to_in_progress", ({ cardId }: Record<string, unknown>) => {
    const card = useKanban.getState().byWorkspace[BOARD_WS].cards.find((c) => c.id === cardId)!;
    // As the backend does (G4): a template that never ran stays behind.
    return {
      ...card,
      columnId: "in_progress",
      worktreePath: `/w/${card.id}`,
      swarmTemplateId: card.linkedSwarmId ? card.swarmTemplateId : null,
    } satisfies KanbanCard;
  });
  t.fixture("card_compose_dispatch_prompt", () => "the brief");
  t.fixture("swarm_card_slot_status", () => ({
    runningCardSwarms: atCap ? 3 : 0,
    suspendedCardSwarms: 0,
    cap: 3,
  }));
  t.fixture("kanban_card_set_run_state", ({ cardId, patch }: Record<string, unknown>) => {
    const card = useKanban.getState().byWorkspace[BOARD_WS].cards.find((c) => c.id === cardId)!;
    return { ...card, ...(patch as object) };
  });
  return t;
}

describe("starting a card after the swarm UI went (G4)", () => {
  it("dispatches no swarm for a template that never ran", async () => {
    seedBoard([boardCard("fresh", { swarmTemplateId: "feature" })]);
    const t = stub(false);
    await useKanban.getState().moveCard("fresh", "in_progress");
    expect(t.callsOf("kanban_card_advance_to_in_progress")).toHaveLength(1);
    expect(t.callsOf("swarm_card_slot_status")).toHaveLength(0);
    expect(t.callsOf("swarm_start")).toHaveLength(0);
    const card = useKanban.getState().byWorkspace[BOARD_WS].cards[0];
    expect(card.swarmTemplateId ?? null).toBeNull();
  });

  it("leaves a card that ran a swarm queued at the cap, its old swarm unlinked", async () => {
    seedBoard([boardCard("again", { swarmTemplateId: "feature", linkedSwarmId: "old-swarm", lastRunStatus: "failed" })]);
    const t = stub(true);
    await useKanban.getState().moveCard("again", "in_progress");
    expect(t.callsOf("swarm_start")).toHaveLength(0);
    const runState = t.callsOf("kanban_card_set_run_state");
    expect(runState).toHaveLength(1);
    expect(runState[0].args.patch).toMatchObject({ linkedSwarmId: null, lastRunStatus: null });
    const card = useKanban.getState().byWorkspace[BOARD_WS].cards[0];
    expect(card.linkedSwarmId ?? null).toBeNull();
    expect(card.swarmTemplateId).toBe("feature");
  });
});
