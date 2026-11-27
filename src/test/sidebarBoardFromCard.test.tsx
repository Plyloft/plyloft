// U12: on a card page the sidebar's Board was marked as the current page and
// did nothing; the only way back was the crumb. It lands on the Board now, as
// every other destination lands on its own. The card stays selected from
// elsewhere: Code → Board comes back to it.
import { describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { goToCenterMode, useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen } from "./render";

function onCardPage() {
  act(() => {
    seedBoard([boardCard("c1", { title: "The card", notes: "x" })]);
    useUi.setState({ selectedCardId: { [BOARD_WS]: "c1" }, centerMode: { [BOARD_WS]: "board" } });
  });
}

describe("the Board press on a card page (U12)", () => {
  it("the sidebar's Board goes back to the Board", async () => {
    onCardPage();
    const r = renderUi(<WorkspaceSidebar env={null} />, {
      fixtures: { drain_status: { draining: false, startedAt: null }, ship_pending_count: 0, ship_pending_cards: null, ship_unverified_count: 0 },
    });
    r.tauri.allowUnhandled();
    await r.user.click(screen.getByRole("button", { name: /^Board/ }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBeNull();
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
  });

  it("from another mode it comes back to the card; other modes never close it", () => {
    onCardPage();
    act(() => goToCenterMode(BOARD_WS, "code"));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("code");
    act(() => goToCenterMode(BOARD_WS, "board"));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c1");
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    act(() => goToCenterMode(BOARD_WS, "board"));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBeNull();
  });
});
