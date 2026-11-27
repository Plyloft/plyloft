// 1.174.0 (DR4, release.html states 6–9, 11): the Release sheet following a
// release — a row per step with the dot on the step under way, Stop (asked
// first once the release is on GitHub), Update the release, done, and one
// that can't go on by itself; the sidebar's row; "this PC" on Windows.
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseSheet } from "../components/ReleaseSheet";
import { ReleaseStatusRow } from "../components/SidebarStatus";
import type { PendingReleaseView, ReleasePrRecord } from "../ipc";
import { setPlatformForTests } from "../lib/platform";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { useErrorBlocks } from "../store/errorBlockStore";
import { forgetSaidStopsForTests } from "../store/releaseStopNotice";
import { act, renderUi, screen, waitFor, within } from "./render";
import { PRO_GATES, setPlanGates } from "./planGates";
import { relAudit, relScope, releaseFixtures } from "./releaseFixtures";

const WS = "ws-1";

function seed() {
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: WS });
  useKanban.setState({ byWorkspace: { [WS]: { cards: [], loaded: true } } } as never);
  setPlanGates(PRO_GATES);
}

const pr = (over: Partial<ReleasePrRecord> = {}): ReleasePrRecord => ({
  step: "merging",
  branch: "plyloft/release-v3.0.2",
  head: "h",
  number: 391,
  url: "https://github.com/acme/app/pull/391",
  waiting: null,
  outdated: false,
  checksRun: [],
  checksNotRun: [],
  ...over,
});

const record = (over: Partial<PendingReleaseView> = {}): PendingReleaseView => ({
  version: "3.0.2",
  tag: "v3.0.2",
  branch: "main",
  commitSha: "",
  cardIds: [],
  releaseKind: "push_only",
  stoppedAt: null,
  cause: null,
  output: null,
  bound: null,
  createdAt: 1,
  stage: "committing",
  problem: null,
  pr: pr(),
  mergedCardIds: ["m1", "m2"],
  sinceTag: "v3.0.1",
  otherChanges: 1,
  ...over,
});

function Host() {
  const ask = useUi((s) => s.releaseSheet);
  return ask ? <ReleaseSheet ask={ask} onClose={() => useUi.getState().setReleaseSheet(null)} /> : null;
}
const openSheet = () => act(() => useUi.getState().setReleaseSheet({ workspaceId: WS, areaId: null }));

afterEach(() => {
  setPlatformForTests(null);
  forgetSaidStopsForTests();
});

describe("the Release sheet following a release (DR4)", () => {
  it("reopens on a release on its way: a row per step, Close, Open on GitHub and Stop, no filled button", async () => {
    seed();
    renderUi(<Host />, { fixtures: releaseFixtures(relScope(), relAudit({ pendingRelease: record() })) });
    openSheet();
    const sheet = (await screen.findByRole("dialog", { name: "Releasing v3.0.2" })) as HTMLElement;
    expect(sheet.textContent).toContain("2 cards and 1 other change from main.");
    const rows = [...sheet.querySelectorAll("[data-ply-release-step]")].map((r) => [r.getAttribute("data-ply-release-step"), r.textContent]);
    expect(rows.map((r) => r[0])).toEqual(["done", "done", "done", "running", "todo"]);
    // G2 walk (Mac): a finished step has a quiet tick, never a coloured dot.
    expect(sheet.querySelectorAll(".ux-status--done")).toHaveLength(0);
    expect(sheet.querySelectorAll("[data-ply-release-step='done'] svg")).toHaveLength(3);
    expect(rows[2][1]).toContain("Release pull request #391 opened on GitHub");
    expect(rows[3][1]).toContain("Waiting for GitHub’s checks");
    expect(sheet.textContent).toContain(
      "You can close this and quit Plyloft: GitHub merges it by itself, and Plyloft tags it the next time it’s open.",
    );
    for (const name of ["Stop the release", "Open on GitHub", "Close"]) {
      expect(within(sheet).getByRole("button", { name })).toBeTruthy();
    }
    expect(sheet.querySelectorAll(".cbtn--accent")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Close"));
  });

  it("Stop on GitHub asks first; Keep it going keeps it, Stop the release turns its merging off", async () => {
    seed();
    const r = renderUi(<Host />, {
      withToasts: true,
      fixtures: {
        ...releaseFixtures(relScope(), relAudit({ pendingRelease: record() })),
        release_stop: { stopping: false, said: "Its auto-merge is off; release pull request #391 stays open." },
      },
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
    await r.user.click(within(sheet).getByRole("button", { name: "Stop the release" }));
    const ask = await screen.findByRole("dialog", { name: "Stop v3.0.2?" });
    expect(ask.textContent).toContain("Release pull request #391 stays open on GitHub: close it there if you don’t want it. Nothing was tagged.");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Keep it going"));
    await r.user.click(within(ask).getByRole("button", { name: "Keep it going" }));
    expect(r.tauri.callsOf("release_stop")).toHaveLength(0);
    await r.user.click(within(sheet).getByRole("button", { name: "Stop the release" }));
    await r.user.click(within(await screen.findByRole("dialog", { name: "Stop v3.0.2?" })).getByRole("button", { name: "Stop the release" }));
    await waitFor(() => expect(r.tauri.callsOf("release_stop")).toHaveLength(1));
    await waitFor(() => expect(useUi.getState().releaseSheet).toBeNull());
    expect(document.body.textContent).toContain("v3.0.2 is stopped");
  });

  // Windows G2 walk: the stop was carried out by another press (the
  // poller's), so `release_stop` said `stopping` and no `{ stopped }` came
  // back here. The toast comes once the record goes, on its event or on
  // the one-second look, and only once.
  for (const via of ["the record's event", "the fallback look"] as const) {
    it(`a stop another press carries out is said once it settles, on ${via}`, async () => {
      seed();
      let pending: PendingReleaseView | null = record();
      const r = renderUi(<Host />, {
        withToasts: true,
        fixtures: {
          ...releaseFixtures(relScope(), relAudit({ pendingRelease: record() })),
          release_stop: { stopping: true, said: null },
          ship_pending_release: () => ({ release: pending, unreadable: null }),
        },
      });
      openSheet();
      const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
      await r.user.click(within(sheet).getByRole("button", { name: "Stop the release" }));
      await r.user.click(within(await screen.findByRole("dialog", { name: "Stop v3.0.2?" })).getByRole("button", { name: "Stop the release" }));
      await waitFor(() => expect(r.tauri.callsOf("release_stop")).toHaveLength(1));
      expect(document.body.textContent).not.toContain("v3.0.2 is stopped");
      pending = null;
      if (via === "the record's event") {
        await act(async () => r.tauri.emit("ship-pending-release-changed", WS));
        await waitFor(() => expect(document.body.textContent).toContain("v3.0.2 is stopped"), { timeout: 500 });
      } else {
        await waitFor(() => expect(document.body.textContent).toContain("v3.0.2 is stopped"), { timeout: 2500 });
      }
      expect(document.body.textContent).toContain("Plyloft turned off merging #391 by itself; release pull request #391 stays open on GitHub.");
      await act(async () => r.tauri.emit("ship-pending-release-changed", WS));
      await new Promise((ok) => setTimeout(ok, 1200));
      expect(document.body.textContent?.split("v3.0.2 is stopped").length).toBe(2);
    });
  }

  it("while it is made on this Mac, Stop takes it back without asking", async () => {
    seed();
    const r = renderUi(<Host />, {
      fixtures: {
        ...releaseFixtures(relScope(), relAudit({ pendingRelease: record({ pr: pr({ step: "building", number: null, url: null }) }) })),
        release_stop: { stopping: true, said: null },
      },
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
    expect(sheet.textContent).toContain("Nothing is on GitHub yet. Stop takes it back.");
    await r.user.click(within(sheet).getByRole("button", { name: "Stop the release" }));
    await waitFor(() => expect(r.tauri.callsOf("release_stop")).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: /^Stop / })).toBeNull();
  });

  it("behind main on GitHub: Update the release is the one filled button", async () => {
    seed();
    const r = renderUi(<Host />, {
      fixtures: {
        ...releaseFixtures(relScope(), relAudit({ pendingRelease: record({ pr: pr({ step: "open", outdated: true }) }) })),
        ship_release_update: "Brought main's 2 new changes in and sent it.",
        ship_pending_release: { release: null, unreadable: null },
      },
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
    expect(sheet.textContent).toContain("Behind main on GitHub");
    const update = within(sheet).getByRole("button", { name: "Update the release" });
    expect(update.className).toContain("cbtn--accent");
    await r.user.click(update);
    await waitFor(() => expect(r.tauri.callsOf("ship_release_update")).toHaveLength(1));
  });

  it("one that can't go on by itself says why and what stays, with Dismiss and no Stop", async () => {
    seed();
    renderUi(<Host />, {
      fixtures: releaseFixtures(
        relScope(),
        relAudit({ pendingRelease: record({ problem: "Release pull request #391 was closed on GitHub without merging." }) }),
      ),
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "v3.0.2 can't go on by itself" });
    expect(sheet.textContent).toContain("Nothing was tagged, and nothing in it is lost: the changes are still on main.");
    expect(within(sheet).getByRole("button", { name: "Dismiss v3.0.2…" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Stop the release" })).toBeNull();
  });

  it("done here: every step ticked, Done is the one filled button and has the focus", async () => {
    seed();
    const r = renderUi(<Host />, {
      fixtures: {
        ...releaseFixtures(relScope()),
        release_area: { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "local", installLog: "", tag: "v3.0.2" },
        kanban_load: { cards: [] },
      },
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Release lyra" });
    await r.user.click(await within(sheet).findByRole("radio", { name: /On this Mac only/ }));
    const press = within(sheet).getByRole("button", { name: "Release v3.0.2" }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(press);
    const done = await screen.findByRole("dialog", { name: "v3.0.2 is released" });
    expect(done.textContent).toContain("2 cards and 1 other change, made and tagged on this Mac.");
    expect([...done.querySelectorAll("[data-ply-release-step]")].every((s) => s.getAttribute("data-ply-release-step") === "done")).toBe(true);
    const finished = within(done).getByRole("button", { name: "Done" });
    expect(finished.className).toContain("cbtn--accent");
    await r.user.click(finished);
    expect(useUi.getState().releaseSheet).toBeNull();
    r.tauri.allowUnhandled();
  });

  // DR4 round 1: GitHub's checks failed; a record dismissed after a problem
  // is never said released.
  it("says GitHub's checks failed on the merge step", async () => {
    seed();
    renderUi(<Host />, {
      fixtures: releaseFixtures(relScope(), relAudit({ pendingRelease: record({ pr: pr({ checksFailed: true, waiting: "Checks failed on GitHub for #391 (test)." }) }) })),
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
    const merge = [...sheet.querySelectorAll("[data-ply-release-step]")][3];
    expect(merge.getAttribute("data-ply-release-step")).toBe("warn");
    expect(merge.textContent).toContain("GitHub’s checks failed");
  });

  it("a record that goes after a problem (Dismiss) is never said released", async () => {
    seed();
    let pending: PendingReleaseView | null = record({ pr: pr({ step: "merged" }), problem: "Its tag couldn't be pushed." });
    const r = renderUi(<Host />, {
      fixtures: { ...releaseFixtures(relScope(), relAudit()), ship_audit: () => relAudit({ pendingRelease: pending }) },
    });
    openSheet();
    expect(await screen.findByRole("dialog", { name: "v3.0.2 can't go on by itself" })).toBeTruthy();
    pending = null;
    await act(async () => r.tauri.emit("ship-pending-release-changed", WS));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "v3.0.2 can't go on by itself" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "v3.0.2 is released" })).toBeNull();
  });

  // G2 walk (Mac): Show it draws the progress view at once from the
  // record this computer knows, never the empty sheet first.
  it("draws the progress view at once from the known record", async () => {
    seed();
    act(() => useErrorBlocks.getState().setUnpublished(WS, record()));
    renderUi(<Host />, {
      fixtures: { ...releaseFixtures(relScope(), relAudit({ pendingRelease: record() })), ship_audit: () => new Promise(() => {}) },
    });
    openSheet();
    expect(await screen.findByRole("dialog", { name: "Releasing v3.0.2" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /^Release lyra|^Release$/ })).toBeNull();
  });

  // Re-walk (Mac): a record at Tagged is released — the title says so.
  it("a record at Tagged is said released, with Done", async () => {
    seed();
    renderUi(<Host />, {
      fixtures: releaseFixtures(relScope(), relAudit({ pendingRelease: record({ pr: pr({ step: "tagged" }) }) })),
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "v3.0.2 is released" });
    expect(within(sheet).getByRole("button", { name: "Done" }).className).toContain("cbtn--accent");
    expect(screen.queryByRole("dialog", { name: "Releasing v3.0.2" })).toBeNull();
  });

  it("says this PC on Windows", async () => {
    setPlatformForTests("windows");
    seed();
    renderUi(<Host />, {
      fixtures: releaseFixtures(relScope(), relAudit({ pendingRelease: record({ pr: pr({ plyloftMerges: true }) }) })),
    });
    openSheet();
    const sheet = await screen.findByRole("dialog", { name: "Releasing v3.0.2" });
    expect(sheet.textContent).toContain("Made on this PC from main on GitHub");
    expect(sheet.textContent).toContain("Plyloft merges it once the checks pass, only while Plyloft is open on this PC.");
    expect(sheet.textContent).not.toContain("this Mac");
  });
});

describe("the sidebar's release row (DR4, state 11)", () => {
  it("says the release on its way and opens the sheet", async () => {
    seed();
    const r = renderUi(<ReleaseStatusRow workspaceId={WS} />, {
      fixtures: { ship_pending_release: { release: record({ pr: pr({ step: "building" }) }), unreadable: null } },
    });
    expect(await screen.findByText(/Releasing v3\.0\.2 · checks running/)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Show it" }));
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: WS, areaId: null });
  });

  it("says when GitHub's checks failed", async () => {
    seed();
    renderUi(<ReleaseStatusRow workspaceId={WS} />, {
      fixtures: { ship_pending_release: { release: record({ pr: pr({ checksFailed: true }) }), unreadable: null } },
    });
    expect(await screen.findByText(/v3\.0\.2 is waiting · GitHub's checks failed/)).toBeTruthy();
  });

  it("is not drawn without a release on its way", async () => {
    seed();
    const r = renderUi(<ReleaseStatusRow workspaceId={WS} />, {
      fixtures: { ship_pending_release: { release: null, unreadable: null } },
    });
    await waitFor(() => expect(r.tauri.callsOf("ship_pending_release")).toHaveLength(1));
    expect(screen.queryByText(/Releasing/)).toBeNull();
  });
});
