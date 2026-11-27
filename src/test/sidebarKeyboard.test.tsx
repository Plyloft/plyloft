// UX-0.7: a workspace in the sidebar is reachable and usable by keyboard.
//
// The row used to be a `div role="button"` with no tabIndex and no key
// handler, holding the icon chip and the remove `×` as plain spans: nothing
// in it was reachable by Tab, and rename was double-click only. Following the
// GH #181 pattern (see rowOpens.test.tsx), the row is now a plain container
// and its name is a real button; its other controls are buttons beside it,
// never inside another button.
//
// UX-3.3: the workspaces moved into the switcher's popover. The intent holds
// there: the switcher opens from the keyboard, a workspace opens with Enter
// and renames with F2, and its ⋯ (Rename, Icon and colour, Remove) is a
// button of its own.
import { describe, expect, it } from "vitest";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { act, nextFrame, renderUi, screen, tauri } from "./render";
import { useShip } from "../store/shipStore";
import { SHIP_BATCH_BY_PROJECT, shipBatchTitle } from "../lib/boardSemantics";
import { FREE_GATES, setPlanGates } from "./planGates";
import { useKanban } from "../store/kanbanStore";
import { boardCard } from "./boardFixtures";

const readyCard = (id: string) => boardCard(id, { columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped", workspaceId: "a" } as never);

function ws(id: string, name: string): Workspace {
  return {
    id,
    name,
    cwd: `/Users/someone/code/${name}`,
    createdAt: 1,
    lastOpenedAt: 1,
    openFiles: [],
    activeFile: null,
  };
}

/** No ancestor of `el` is a button: it is exposed as its own control. */
function exposed(el: HTMLElement): boolean {
  let up = el.parentElement;
  while (up) {
    if (up.tagName === "BUTTON" || up.getAttribute("role") === "button") return false;
    up = up.parentElement;
  }
  return true;
}

async function renderSidebar() {
  tauri().allowUnhandled();
  tauri().fixture("drain_status", { draining: false, startedAt: null });
  tauri().fixture("ship_pending_count", 0);
  tauri().fixture("ship_pending_cards", null);
  tauri().fixture("ship_unverified_count", 0);
  act(() => {
    useWorkspaces.setState({
      workspaces: [ws("a", "alpha"), ws("b", "beta")],
      activeId: "a",
    });
  });
  const r = renderUi(<WorkspaceSidebar env={null} />);
  await nextFrame();
  return r;
}

/** Open the switcher from the keyboard: focus its trigger, press Enter. */
async function openSwitcher(r: Awaited<ReturnType<typeof renderSidebar>>) {
  screen.getByRole("button", { name: /switch workspace/ }).focus();
  await r.user.keyboard("{Enter}");
  await nextFrame();
  return screen.getByRole("dialog", { name: "Workspaces" });
}

describe("a sidebar workspace by keyboard", () => {
  it("exposes its name and its ⋯ as buttons", async () => {
    const r = await renderSidebar();
    await openSwitcher(r);
    const name = screen.getByRole("button", { name: "beta" });
    const more = screen.getByRole("button", { name: "More for beta" });
    for (const el of [name, more]) {
      expect(el.tagName).toBe("BUTTON");
      expect(exposed(el)).toBe(true);
    }
  });

  it("opens with Enter and renames with F2", async () => {
    const r = await renderSidebar();
    await openSwitcher(r);
    screen.getByRole("button", { name: "beta" }).focus();
    await r.user.keyboard("{Enter}");
    expect(useWorkspaces.getState().activeId).toBe("b");

    await openSwitcher(r);
    screen.getByRole("button", { name: "beta" }).focus();
    await r.user.keyboard("{F2}");
    expect(screen.getByDisplayValue("beta").tagName).toBe("INPUT");
  });
});

// SP-D: the sidebar's ship row is the Ship batch's — it counts what a batch
// takes, so it says the batch, never "ready to ship" (the Board's chip, which
// an approved Builder card in In progress carries without being in a batch).
describe("the sidebar's Ship batch row", () => {
  it("says Release N cards…, with the batch's title", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 5);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "alpha")], activeId: "a" });
      useShip.setState({ pendingCount: 5 });
      // Challenger P3-2: the active project's own two ready cards; the
      // backend's count over every project (5) is not the row's.
      useKanban.setState({ byWorkspace: { a: { cards: [readyCard("c1"), readyCard("c2")], loaded: true } } } as never);
    });
    renderUi(<WorkspaceSidebar env={null} />);
    const row = await screen.findByText("Release 2 cards…");
    expect(screen.queryByText("Release 5 cards…")).toBeNull();
    // 1.174.1 P3: its N is the active project's count (its ready cards, not
    // the backend's 5 over every project); a release is of one project (one
    // area) at a time.
    expect(row.closest("[title]")?.getAttribute("title")).toBe(SHIP_BATCH_BY_PROJECT);
    expect(SHIP_BATCH_BY_PROJECT).toBe("Release the cards that are ready, one project at a time");
    expect(shipBatchTitle(2)).toBe("Release 2 cards together, as one version");
    expect(shipBatchTitle(1)).toBe("Release 1 card together, as one version");
    expect(screen.queryByText(/ready to ship/i)).toBeNull();
  });

  // 1.171.0 E3 (owner D5): two or more cards, on every plan.
  it("is drawn on Free too", async () => {
    tauri().allowUnhandled();
    tauri().fixture("drain_status", { draining: false, startedAt: null });
    tauri().fixture("ship_pending_count", 5);
    tauri().fixture("ship_pending_cards", null);
    tauri().fixture("ship_unverified_count", 0);
    act(() => {
      useWorkspaces.setState({ workspaces: [ws("a", "alpha")], activeId: "a" });
      useShip.setState({ pendingCount: 5 });
      // Challenger P3-2: the active project's own two ready cards; the
      // backend's count over every project (5) is not the row's.
      useKanban.setState({ byWorkspace: { a: { cards: [readyCard("c1"), readyCard("c2")], loaded: true } } } as never);
    });
    const r = renderUi(<WorkspaceSidebar env={null} />);
    await screen.findByText("Release 2 cards…");
    act(() => setPlanGates(FREE_GATES));
    expect(screen.getByText("Release 2 cards…")).toBeTruthy();
    r.unmount();
    act(() => setPlanGates(null));
  });
});
