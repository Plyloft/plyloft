// 1.174.0 (DR3, D1(b)): the one Release sheet (mockups/release.html states
// 2, 2b, 3, 4, 5 and the refusals of state 9). A release takes everything on
// the area's branch since its last tag, plus the ready cards ticked, on
// every plan; focus on Cancel; one filled button with the real tag.
import { describe, expect, it } from "vitest";
import { ReleaseSheet } from "../components/ReleaseSheet";
import type { KanbanCard, PendingReleaseView } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { useUi } from "../store/uiStore";
import { act, renderUi, screen, waitFor, within } from "./render";
import { FREE_GATES, PRO_GATES, setPlanGates } from "./planGates";
import { relAudit, relScope, releaseFixtures } from "./releaseFixtures";

const WS = "ws-1";
const ready = (id: string, title: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id,
    workspaceId: WS,
    title,
    columnId: "complete",
    verifyStatus: "passed",
    shipStatus: "unshipped",
    worktreePath: `/tmp/ply-test/${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as KanbanCard;

function seed(cards: KanbanCard[] = [ready("r1", "Blog: RSS feed for posts")]) {
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/ply-test" }] as never, activeId: WS });
  useKanban.setState({ byWorkspace: { [WS]: { cards, loaded: true } } } as never);
}

const sheetOf = async (title: string) => (await screen.findByRole("dialog", { name: title })) as HTMLElement;

describe("the Release sheet (DR3)", () => {
  it("says what is in it, ticks the ready card, starts on Cancel, one filled button with the tag", async () => {
    seed();
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope({ readyCardIds: ["r1"] })),
    });
    const sheet = await sheetOf("Release lyra");
    await waitFor(() => expect(sheet.textContent).toContain("What’s in it"));
    expect(sheet.textContent).toContain("A new version of lyra with everything on main since v3.0.1, released 12 days ago.");
    expect(sheet.textContent).toContain("2 cards · 1 other change");
    expect(sheet.textContent).toContain("Privacy: list Google Cloud KMS");
    expect(sheet.textContent).toContain("Pull request #382 · merged 3 days ago");
    expect(sheet.textContent).toContain("1 other change on main · not from a card");
    // Ticked by default (owner).
    const box = within(sheet).getByRole("checkbox", { name: /Blog: RSS feed for posts/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(sheet.textContent).toContain("Checked and approved · goes into the release as its own change");
    // Patch by default.
    expect(within(sheet).getByRole("radio", { name: /v3\.0\.2/ }).getAttribute("aria-checked")).toBe("true");
    // One filled button, with the real tag; focus on Cancel.
    await waitFor(() => expect(sheet.querySelectorAll(".cbtn--accent")).toHaveLength(1));
    expect(within(sheet).getByRole("button", { name: "Release v3.0.2" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(sheet.textContent).toContain("Cards go to main · 3 changes, 1 more card");
  });

  it("releases with the ticked cards, the version and how far it goes, then says it is released", async () => {
    seed();
    setPlanGates(PRO_GATES);
    let closed = false;
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => (closed = true)} />, {
      fixtures: {
        ...releaseFixtures(relScope({ readyCardIds: ["r1"] })),
        release_area: { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "push_only", installLog: "", tag: "v3.0.2" },
        kanban_load: { cards: [] },
      },
      withToasts: true,
    });
    const sheet = await sheetOf("Release lyra");
    const press = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(within(sheet).getByRole("radio", { name: /^Put the version on GitHub(?!, with)/ }));
    await r.user.click(press);
    // DR4: done here — the sheet says so; Done closes it.
    const done = await screen.findByRole("dialog", { name: "v3.0.2 is released" });
    await r.user.click(within(done).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(closed).toBe(true));
    expect(r.tauri.callsOf("release_area")[0]?.args).toMatchObject({
      request: { workspaceId: WS, areaId: null, cardIds: ["r1"], releaseKind: "push_only", version: "3.0.2", skipVerify: false },
    });
    r.tauri.allowUnhandled();
  });

  it("with no ready card releases what is on main; with nothing new it says so and stays off", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const empty = relScope({ cards: [], cardsTotal: 0, otherChanges: [], otherTotal: 0 });
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, { fixtures: releaseFixtures(empty) });
    const sheet = await sheetOf("Release lyra");
    await waitFor(() => expect(sheet.textContent).toContain("Nothing new on main since v3.0.1, released 12 days ago."));
    expect((within(sheet).getByRole("button", { name: "Release v3.0.2" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
  });

  it("on Free too, ticks every ready card, with no Pro mark, and releases them together", async () => {
    seed([ready("r1", "Blog: RSS feed for posts"), ready("r2", "Search: index the glossary")]);
    setPlanGates(FREE_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope({ readyCardIds: ["r1", "r2"] })),
        release_area: { commitSha: "abc12345", shippedVersion: "3.0.2", releaseKind: "push_only", installLog: "", tag: "v3.0.2" },
        kanban_load: { cards: [] },
      },
    });
    const sheet = await sheetOf("Release lyra");
    const first = (await within(sheet).findByRole("checkbox", { name: /Blog: RSS feed/ })) as HTMLInputElement;
    const second = within(sheet).getByRole("checkbox", { name: /Search: index the glossary/ }) as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(true);
    expect(second.disabled).toBe(false);
    expect(sheet.textContent).not.toMatch(/\bPro\b/);
    expect(within(sheet).queryByRole("button", { name: "Part of Pro" })).toBeNull();
    const press = within(sheet).getByRole("button", { name: "Release v3.0.2" }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(press);
    await waitFor(() => expect(r.tauri.callsOf("release_area")).toHaveLength(1));
    expect(r.tauri.callsOf("release_area")[0]?.args).toMatchObject({ request: { cardIds: ["r1", "r2"] } });
    expect(screen.queryByRole("dialog", { name: /part of Pro/ })).toBeNull();
    r.tauri.allowUnhandled();
  });

  it("a card's own Release… ticks that card only", async () => {
    seed([ready("r1", "Blog: RSS feed for posts"), ready("r2", "Search: index the glossary")]);
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null, cardIds: ["r2"] }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope({ readyCardIds: ["r1", "r2"] })),
    });
    const sheet = await sheetOf("Release lyra");
    const r1 = (await within(sheet).findByRole("checkbox", { name: /Blog: RSS feed/ })) as HTMLInputElement;
    const r2 = within(sheet).getByRole("checkbox", { name: /Search: index/ }) as HTMLInputElement;
    expect(r1.checked).toBe(false);
    expect(r2.checked).toBe(true);
  });

  it("asks which area when two have something; opens the only one that has", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const site = relScope({ area: "site", name: "Site", tagPrefix: "site-", sinceTag: "site-v3.0.1" });
    const app = relScope({ area: "app", name: "App", targetBranch: "staging", sinceTag: "app-v1.4.0", cardsTotal: 1, otherTotal: 0 });
    const blog = relScope({ area: "blog", name: "Blog", sinceTag: "blog-v0.3.0", cards: [], cardsTotal: 0, otherChanges: [], otherTotal: 0 });
    const docs = relScope({ area: "docs", name: "Docs", refusal: "Docs has no version file of its own. Add one in Settings › Areas." });
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS }} onClose={() => {}} />, {
      // The areas not read yet: the sheet asks (or opens the only one).
      fixtures: { ...releaseFixtures(site), release_scopes: [site, app, blog, docs], areas_get: null },
    });
    const which = await sheetOf("Release which area?");
    await waitFor(() => expect(which.textContent).toContain("2 cards and 1 other change on main since site-v3.0.1"));
    expect(which.textContent).toContain("1 card on staging since app-v1.4.0");
    expect(which.textContent).toContain("Nothing new for Blog since blog-v0.3.0.");
    expect(within(which).queryByRole("button", { name: "Release Blog…" })).toBeNull();
    // A tidy table (A0): one row per area, the actions in its one column; a
    // refused area carries its fix.
    expect(which.querySelectorAll(".ux-row")).toHaveLength(4);
    expect(within(which).getByRole("button", { name: "Open Areas" })).toBeTruthy();
    await r.user.click(within(which).getByRole("button", { name: "Release Site…" }));
    expect(await sheetOf("Release Site")).toBeTruthy();
    r.unmount();
    renderUi(<ReleaseSheet ask={{ workspaceId: WS }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(app), release_scopes: [app, blog], areas_get: null },
    });
    expect(await sheetOf("Release App")).toBeTruthy();
  });

  it("Stop the release that took it back says so, never as a failure", async () => {
    seed();
    setPlanGates(PRO_GATES);
    function Host() {
      const ask = useUi((s) => s.releaseSheet);
      return ask ? <ReleaseSheet ask={ask} onClose={() => useUi.getState().setReleaseSheet(null)} /> : null;
    }
    const r = renderUi(<Host />, {
      fixtures: {
        ...releaseFixtures(relScope({ readyCardIds: ["r1"] })),
        release_area: () => {
          throw { stopped: { tag: "v3.0.2", version: "3.0.2", onGithub: null, here: null, github: true } };
        },
      },
      withToasts: true,
    });
    act(() => useUi.getState().setReleaseSheet({ workspaceId: WS, areaId: null }));
    const sheet = await sheetOf("Release lyra");
    const press = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(press);
    await waitFor(() => expect(useUi.getState().releaseSheet).toBeNull());
    await waitFor(() =>
      expect(document.body.textContent).toContain("v3.0.2 is stopped. Nothing went to GitHub, and the release was taken back."),
    );
    r.tauri.allowUnhandled();
  });

  // DR2 schema migration, frontend side: a recorded release with no card of
  // its own (`cardIds: []`) goes on from here, with Dismiss beside it.
  it("goes on with a recorded release that has no card of its own", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const pending: PendingReleaseView = {
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
      pr: {
        step: "merging",
        branch: "plyloft/release-v3.0.2",
        head: "h",
        number: 391,
        url: "https://github.com/acme/app/pull/391",
        waiting: null,
        outdated: false,
        checksRun: [],
        checksNotRun: [],
      },
      mergedCardIds: ["m1"],
      sinceTag: "v3.0.1",
      otherChanges: 1,
    };
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope(), relAudit({ pendingRelease: pending })),
    });
    // DR4: the sheet follows it, with Stop.
    const sheet = await sheetOf("Releasing v3.0.2");
    expect(within(sheet).getByRole("button", { name: "Stop the release" })).toBeTruthy();
    r.unmount();
    // Stopped while it was being made: Continue makes it again, with no card.
    const again = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(
        relScope(),
        relAudit({ pendingRelease: { ...pending, pr: { ...pending.pr!, step: "building", number: null, url: null, waiting: "Plyloft was quit while it was making it." } } }),
      ),
    });
    const stopped = await sheetOf("Releasing v3.0.2");
    const go = within(stopped).getByRole("button", { name: "Continue v3.0.2" });
    again.tauri.fixture("release_area", () => new Promise(() => {}));
    await again.user.click(go);
    expect(again.tauri.callsOf("release_area")[0]?.args).toMatchObject({
      request: { cardIds: [], version: "3.0.2", releaseKind: "push_only" },
    });
  });

  it("on this Mac only: brings a main that is behind up to date first; off when both moved on", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope({ localBehind: 4 })),
    });
    const sheet = await sheetOf("Release lyra");
    const local = await within(sheet).findByRole("radio", { name: /On this Mac only/ });
    await r.user.click(local);
    expect(sheet.textContent).toContain(
      "This Mac’s main is 4 changes behind main on GitHub. Plyloft brings it up to date first; nothing is sent to GitHub.",
    );
    r.unmount();
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope({ diverged: true, localAhead: 1, localBehind: 2 })),
    });
    const again = await sheetOf("Release lyra");
    const off = (await within(again).findByRole("radio", { name: /On this Mac only/ })) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(again.textContent).toContain("This Mac’s main and GitHub’s both have changes the other doesn’t.");
  });

  it("refuses a tag that exists, and a second release of the area, before the press", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(
        relScope({ inFlight: { tag: "v3.0.2", version: "3.0.2", prNumber: 391, prUrl: null, step: "open", problem: null } }),
      ),
    });
    const sheet = await sheetOf("Release lyra");
    await waitFor(() =>
      expect(sheet.textContent).toContain("v3.0.2 is on its way (release pull request #391). Only one release of lyra at a time."),
    );
    r.unmount();
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(
        relScope({
          versions: [
            { kind: "patch", version: "3.0.2", tag: "v3.0.2", taken: true },
            { kind: "minor", version: "3.1.0", tag: "v3.1.0", taken: false },
          ],
        }),
      ),
    });
    const second = await sheetOf("Release lyra");
    // The taken patch can't be chosen: the next free one is the default.
    expect(((await within(second).findByRole("radio", { name: /v3\.0\.2/ })) as HTMLButtonElement).disabled).toBe(true);
    expect(within(second).getByRole("radio", { name: /v3\.1\.0/ }).getAttribute("aria-checked")).toBe("true");
  });

  // Re-walk (Mac): two choices of one kind (the patch moved past a taken
  // one, and the taken one) — one checked, and the press sends that version.
  it("checks one version only when two share a kind, and releases that one", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(
          relScope({
            versions: [
              { kind: "patch", version: "1.0.2", tag: "v1.0.2", taken: false },
              { kind: "patch", version: "1.0.1", tag: "v1.0.1", taken: true, onItsWay: true },
              { kind: "minor", version: "1.1.0", tag: "v1.1.0", taken: false },
            ],
          }),
        ),
        release_area: () => new Promise(() => {}),
      },
    });
    const sheet = await sheetOf("Release lyra");
    const group = await within(sheet).findByRole("radiogroup", { name: "Version" });
    const checked = within(group).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((c) => c.textContent)).toEqual([expect.stringContaining("v1.0.2")]);
    const press = within(sheet).getByRole("button", { name: "Release v1.0.2" }) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(press);
    expect(r.tauri.callsOf("release_area")[0]?.args).toMatchObject({ request: { version: "1.0.2" } });
  });

  // L walk (Mac): every taken version between the last one and the first
  // free one has its row, disabled, saying why — none is skipped in silence.
  it("lists every taken version the default skipped, each with its reason", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(
        relScope({
          versions: [
            { kind: "patch", version: "1.0.3", tag: "v1.0.3", taken: false },
            { kind: "asIs", version: "1.0.0", tag: "v1.0.0", taken: true, onItsWay: true },
            { kind: "patch", version: "1.0.1", tag: "v1.0.1", taken: true, onItsWay: true },
            { kind: "patch", version: "1.0.2", tag: "v1.0.2", taken: true, onItsWay: true },
            { kind: "minor", version: "1.1.0", tag: "v1.1.0", taken: false },
          ],
        }),
      ),
    });
    const sheet = await sheetOf("Release lyra");
    const group = await within(sheet).findByRole("radiogroup", { name: "Version" });
    for (const v of ["v1.0.0", "v1.0.1", "v1.0.2"]) {
      const row = within(group).getByRole("radio", { name: new RegExp(v.replace(/\./g, "\\.")) }) as HTMLButtonElement;
      expect(row.disabled).toBe(true);
      expect(row.textContent).toContain(`GitHub already has a release branch for ${v}`);
    }
    const checked = within(group).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((c) => c.textContent)).toEqual([expect.stringContaining("v1.0.3")]);
  });

  it("keeps the technical words under Details", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: releaseFixtures(relScope()),
    });
    const sheet = await sheetOf("Release lyra");
    await waitFor(() => expect(sheet.textContent).toContain("Technical details"));
    const details = sheet.querySelector(".ux-flow-disk") as HTMLElement;
    expect(details.closest("details")).toBeTruthy();
    expect(details.textContent).toContain("Release branch plyloft/release-v3.0.2");
    // Outside Details, no branch or tag mechanics.
    const outside = sheet.textContent!.replace(details.closest("details")!.textContent!, "");
    expect(outside).not.toMatch(/plyloft\/release-/);
    expect(outside).not.toMatch(/integration branch|ships onto/i);
  });

  // Walk fix (DR3 early walk): never titled by the project before its area
  // is read; a refusal goes once the version changes.
  it("is titled by its area, not the project, while it reads", async () => {
    seed([]);
    setPlanGates(PRO_GATES);
    renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: "site" }} onClose={() => {}} />, {
      fixtures: {
        ...releaseFixtures(relScope({ area: "site", name: "Site" })),
        release_scope: () => new Promise(() => {}),
        areas_get: null,
      },
    });
    expect(await screen.findByRole("dialog", { name: "Release" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Release lyra" })).toBeNull();
  });

  it("drops a refusal once the version changes, and says the foot's line in words", async () => {
    seed();
    setPlanGates(PRO_GATES);
    const r = renderUi(<ReleaseSheet ask={{ workspaceId: WS, areaId: null }} onClose={() => {}} />, {
      fixtures: { ...releaseFixtures(relScope({ readyCardIds: ["r1"] })), release_area: () => Promise.reject("v3.0.2 is on GitHub already; pick a different version.") },
    });
    const sheet = await sheetOf("Release lyra");
    const press = (await within(sheet).findByRole("button", { name: "Release v3.0.2" })) as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    await r.user.click(press);
    // The press follows the release in its own view; back here it says why.
    const back = await sheetOf("Release lyra");
    expect(await within(back).findByRole("alert")).toBeTruthy();
    await r.user.click(within(back).getByRole("radio", { name: /v3\.1\.0/ }));
    await waitFor(() => expect(within(back).queryByRole("alert")).toBeNull());
    expect(back.querySelector(".ux-release-foot")?.textContent).toContain("Cards go to main");
  });

  it("opens from the App host on every Release…, and closes", async () => {
    seed([]);
    setPlanGates(FREE_GATES);
    function Host() {
      const ask = useUi((s) => s.releaseSheet);
      return ask ? <ReleaseSheet ask={ask} onClose={() => useUi.getState().setReleaseSheet(null)} /> : null;
    }
    const r = renderUi(<Host />, { fixtures: releaseFixtures(relScope()) });
    act(() => useUi.getState().setReleaseSheet({ workspaceId: WS, areaId: null }));
    const sheet = await sheetOf("Release lyra");
    await r.user.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(useUi.getState().releaseSheet).toBeNull();
  });
});
