// QoL 1.168: "Ship N in a batch" reads the list again when the backend says
// a board changed (a Board not loaded here) and when the window comes back
// to the front — once per burst.
import { describe, expect, it, vi } from "vitest";
import { useShipReadyRefresh } from "../store/shipReadyHooks";
import { useShip } from "../store/shipStore";
import { act, renderUi, tauri } from "./render";

function Probe() {
  useShipReadyRefresh(100);
  return null;
}

describe("the Ship N list refresh", () => {
  it("re-reads on kanban://changed and on focus, debounced", async () => {
    let list = [{ workspaceId: "cold", cardIds: ["c1"] }];
    renderUi(<Probe />, {
      fakeTimers: true,
      fixtures: { ship_pending_cards: () => list, ship_pending_count: 0 },
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    const reads = () => tauri().callsOf("ship_pending_cards").length;
    const first = reads();
    expect(useShip.getState().pendingCount).toBe(1);

    list = [{ workspaceId: "cold", cardIds: ["c1", "c2"] }];
    await act(async () => {
      tauri().emit("kanban://changed", "cold");
      tauri().emit("kanban://changed", "cold");
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(reads()).toBe(first + 1);
    expect(useShip.getState().pendingCount).toBe(2);
  });
});
