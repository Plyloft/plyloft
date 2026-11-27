// GH #250 / #277 → 1.174.0 (DR3): Ship batch is the one Release sheet now.
// Its ready cards are rows under hairlines with the accent's checkbox; no row
// repeats "verified", only a card shipped without checks says so; how far
// the release goes is a ChoiceList in outcome words, from how Ship it ships
// when nothing is chosen; the folder on another branch or a project not set
// up say so before the press.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ReleaseSheet } from "../components/ReleaseSheet";
import type { KanbanCard } from "../ipc";
import { SET_UP_LABEL } from "../lib/projectSetup";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { PRO_GATES, setPlanGates } from "./planGates";
import { relAudit, relScope, releaseFixtures } from "./releaseFixtures";

const card = (id: string, ws: string, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id,
  workspaceId: ws,
  title: `Card ${id}`,
  columnId: "complete",
  verifyStatus: "passed",
  shipStatus: "unshipped",
  worktreePath: `/tmp/ply-test/${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function seed() {
  useWorkspaces.setState({ workspaces: [{ id: "ws-1", name: "Ply", cwd: "/tmp/ply-test" }] as never, activeId: "ws-1" });
  useKanban.setState({
    byWorkspace: {
      "ws-1": {
        cards: [
          card("a", "ws-1", {
            title: "Settings search: Italian, French, German and Spanish words find their settings too",
          }),
          card("b", "ws-1", { verifyStatus: "skipped" }),
        ],
        loaded: true,
      },
    },
  } as never);
  setPlanGates(PRO_GATES);
}

const two = relScope({ readyCardIds: ["a", "b"] });

describe("the Release sheet's ready cards (GH #250, #277; DR3)", () => {
  it("lists ready cards as hairline rows without a VERIFIED pill; only a skipped one says so", async () => {
    seed();
    renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, { fixtures: releaseFixtures(two) });
    const list = await screen.findByRole("group", { name: "Also ready, not on main yet" });
    const sheet = list.closest(".ux-sheet") as HTMLElement;
    expect(list.textContent).not.toMatch(/verified/i);
    expect(sheet.querySelector(".kanban-card-lifecycle, [class*='ship-audit'], [class*='ship-batch']")).toBeNull();
    const rows = list.querySelectorAll(".ux-check-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Checked and approved");
    expect(rows[1].textContent).toContain("Checks skipped");
    for (const box of within(list).getAllByRole("checkbox")) {
      expect(box.className).toBe("ux-checkbox");
      expect((box as HTMLInputElement).checked).toBe(true);
    }
  });

  it("says when the project's folder is on another branch, for a release kept on this Mac", async () => {
    seed();
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(two, relAudit({ branch: "feature", branchOk: false, targetBranch: "main" })),
    });
    const sheet = await screen.findByRole("dialog", { name: "Release Ply" });
    await r.user.click(await within(sheet).findByRole("radio", { name: /On this Mac only/ }));
    await waitFor(() =>
      expect(within(sheet).getByRole("alert").textContent).toBe(
        "This project's folder is on feature, and a release is made from main. Switch it to main, then release.",
      ),
    );
    expect((within(sheet).getByRole("button", { name: "Release v3.0.2" }) as HTMLButtonElement).disabled).toBe(true);
    // On GitHub it is made from main on GitHub: the folder's branch doesn't matter.
    await r.user.click(within(sheet).getByRole("radio", { name: /^Put the version on GitHub(?!, with)/ }));
    await waitFor(() => expect(within(sheet).queryByRole("alert")).toBeNull());
  });

  it("offers Set up for a project with no settings, with the press off", async () => {
    seed();
    renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(two, relAudit({ branch: "master", branchOk: false, targetBranch: null as never })),
    });
    const sheet = await screen.findByRole("dialog", { name: "Release Ply" });
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toMatch(/isn't set up for releases yet/);
    expect(within(sheet).getByRole("button", { name: SET_UP_LABEL })).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Release v3.0.2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // 1.174.0 (A1, SL-1c): nothing chosen, the release follows How Ship it
  // ships — Put the version on GitHub where Ship it goes to GitHub; off until it is read.
  it("nothing chosen, starts at Put the version on GitHub where Ship it goes to GitHub, once that is read", async () => {
    seed();
    let answer!: (on: boolean) => void;
    const reading = new Promise<boolean>((res) => (answer = res));
    renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1", areaId: null }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(two), workspace_ship_offers_pr: () => reading },
    });
    const press = (await screen.findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    await act(async () => answer(true));
    await waitFor(() => expect(press.disabled).toBe(false));
    const kinds = screen.getByRole("radiogroup", { name: "How far it goes" });
    expect(within(kinds).getByRole("radio", { name: /^Put the version on GitHub(?!, with)/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("asks nothing about areas without them, and is titled by the project", async () => {
    seed();
    renderUi(<ReleaseSheet ask={{ workspaceId: "ws-1" }} onClose={() => {}} />, { fixtures: releaseFixtures(two) });
    expect(await screen.findByRole("dialog", { name: "Release Ply" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Release which area?" })).toBeNull();
  });

  it("is a migrated file, and the retired sheets are gone", () => {
    const migrated = JSON.parse(readFileSync("docs/ux-language/migrated.json", "utf8")).files as string[];
    expect(migrated).toContain("src/components/ReleaseSheet.tsx");
    for (const gone of ["ShipBatchModal", "ReleaseAreaSheet", "ReleaseFlow"]) {
      expect(migrated).not.toContain(`src/components/${gone}.tsx`);
    }
    const app = readFileSync("src/App.css", "utf8");
    expect(app).not.toMatch(/\.kanban-card-lifecycle|\.ship-audit-|\.ship-batch-/);
  });
});
