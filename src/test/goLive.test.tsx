// 1.173.0 (D2): the Ship step's "When it merges" and Board ⋯ › How this
// goes live, drawn from D1's reading (mockups/deploy.html scenes 1–3).
// F2: Release… on each block and in the Board's ⋯ (scene 2).
import { describe, expect, it } from "vitest";
import { KanbanBoard } from "../components/KanbanBoard";
import { GoLiveSheet } from "../components/GoLiveSheet";
import { WhenItMerges } from "../components/WhenItMerges";
import type { DeployMap, RailwayService, WhatRedeploys } from "../ipc";
import { GO_LIVE_NOTHING, GO_LIVE_READS_WHEN } from "../lib/goLive";
import { act, renderUi, screen, waitFor, within } from "./render";
import { useUi } from "../store/uiStore";
import { useShip } from "../store/shipStore";
import { useAreas } from "../store/areaStore";
import { markReleaseScopesStale, useReleaseScopes } from "../store/releaseScopeStore";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar";
import { SHIP_BATCH_BY_AREA } from "../lib/boardSemantics";
import { useToasts } from "../store/toastStore";
import { FREE_GATES, setPlanGates } from "./planGates";
import { boardCard, seedBoard, BOARD_WS } from "./boardFixtures";

const service = (over: Partial<RailwayService>): RailwayService => ({
  environment: "production",
  name: "svc",
  repo: "acme/monorepo",
  branch: "main",
  rootDirectory: null,
  watchPatterns: [],
  domains: [],
  cron: null,
  thisRepository: true,
  ...over,
});
const site = service({ name: "site-production", rootDirectory: "site", domains: ["www.example.com"] });
const app = service({ name: "app-production", domains: ["app.example.com"] });

const what: WhatRedeploys = {
  targetBranch: "main",
  services: [
    { service: site, reason: "inRoot", rebuildsOnAnyChange: true, domains: site.domains },
    { service: app, reason: "anyChange", rebuildsOnAnyChange: true, domains: app.domains },
  ],
  checks: [{ file: "ci.yml", name: "CI", jobs: ["backend", "frontend", "site"] }],
  project: "acme-project",
  railwayReadAt: Date.now() - 3 * 60_000,
  changed: 4,
};

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("When it merges (scene 1)", () => {
  it("lists the addresses first, the restart with its reason, then the checks", async () => {
    renderUi(<WhenItMerges workspaceId="ws-1" cardId="c1" version="1" />, {
      fixtures: {
        release_scopes: [], deploy_what_changes: () => what },
    });
    expect(await screen.findByText("When it merges")).toBeTruthy();
    expect(screen.getByText("read from Railway 3 min ago")).toBeTruthy();
    const rows = [...document.querySelectorAll("[data-ply-when-row]")];
    expect(rows.map((r) => r.getAttribute("data-ply-when-row"))).toEqual(["updates", "too", "checks"]);
    expect(text(rows[0])).toContain("www.example.com updates");
    expect(text(rows[0])).toContain("Railway service site-production · built from site/");
    expect(text(rows[1])).toContain("app.example.com restarts too");
    // A warn dot, never the failure one; the colour on the dot only.
    expect(rows[1].querySelector(".ux-status--warn")).toBeTruthy();
    expect(rows[1].querySelector(".ux-status--aborted")).toBeNull();
    expect(text(rows[1])).toContain("Its service rebuilds on any change in the repository");
    expect(screen.getByRole("button", { name: "How to make it rebuild only for its own changes" })).toBeTruthy();
    expect(text(rows[2])).toContain("GitHub runs 3 checks first");
    expect(text(rows[2])).toContain("backend, frontend and site, from ci.yml");
  });

  // 1.174.0 (C1, BCI-16): when Railway was read is a line under the title,
  // not a count; the section ends with the whole picture, one quiet press.
  it("says when it was read under its title, and How this goes live… opens the sheet", async () => {
    const { user, tauri } = renderUi(<WhenItMerges workspaceId="ws-1" cardId="c1" version="1" />, {
      fixtures: { release_scopes: [], deploy_what_changes: () => what },
    });
    tauri.allowUnhandled();
    const ago = await screen.findByText("read from Railway 3 min ago");
    expect(ago.matches("p[data-ply-when-read-ago]")).toBe(true);
    expect(document.querySelector("[data-ply-when-it-merges] .ux-section-count")).toBeNull();
    const press = screen.getByRole("button", { name: "How this goes live…" });
    expect(press.className).not.toMatch(/accent/);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(press);
    expect(await screen.findByRole("dialog", { name: /^How this goes live/ })).toBeTruthy();
  });

  it("draws nothing when there is nothing to read, or the reading fails", async () => {
    const { container } = renderUi(<WhenItMerges workspaceId="ws-1" cardId="c1" version="1" />, {
      fixtures: {
        release_scopes: [], deploy_what_changes: () => null },
    });
    await act(async () => {});
    expect(container.querySelector("[data-ply-when-it-merges]")).toBeNull();
  });
});

const read = (state: DeployMap["railway"]["state"], services: RailwayService[] = []): DeployMap["railway"] => ({
  state,
  project: "acme-project",
  services,
  message: null,
  readAt: Date.now(),
});

describe("How this goes live (scenes 2–3)", () => {
  it("is in the Board's ⋯ and opens the page", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: {
        release_scopes: [], project_config_get: null, ship_pending_cards: [] } });
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    await r.user.click(screen.getByRole("menuitem", { name: "How this goes live" }));
    expect(await screen.findByRole("dialog", { name: /How this goes live/ })).toBeTruthy();
  });

  // 1.174.0 (DS5, G2 walk): ⋯ › Where the cards live opens Project ›
  // General at its Board part.
  it("Where the cards live in the Board's ⋯ opens General's board part", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { project_config_get: null, ship_pending_cards: [] } });
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    await r.user.click(screen.getByRole("menuitem", { name: /^Where the cards live/ }));
    expect(useUi.getState().settingsOverlayOpen).toBe(true);
    expect(useUi.getState().settingsSection).toBe("board");
  });

  // 1.174.0 (DS8): Settings search's Elsewhere entry asks the Board.
  it("a Settings search's ask opens it on the Board", async () => {
    act(() => seedBoard([boardCard("draft")]));
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, { fixtures: { release_scopes: [], project_config_get: null, ship_pending_cards: [] } });
    void r;
    act(() => useUi.getState().askBoard(BOARD_WS, "go-live"));
    expect(await screen.findByRole("dialog", { name: /How this goes live/ })).toBeTruthy();
    expect(useUi.getState().boardAsk).toBeNull();
  });

  it("shows where cards go, what changes, and Railway's line with Read again", async () => {
    const map: DeployMap = { repo: "acme/monorepo", railway: read("ok", [site, app]), workflows: [] };
    let asked = 0;
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: (args: { refresh: boolean | null }) => {
          if (args?.refresh) asked++;
          return map;
        },
        areas_get: {
          shared: false,
          readOnly: false,
          defined: [],
          areas: [],
          workspaceBranch: "main",
          check: { errors: [], warnings: [] },
          problem: null,
          held: false,
        },
      },
    });
    const block = await screen.findByText("main, as pull requests");
    const page = text(block.closest("[data-ply-go-live]"));
    expect(page).toContain("Cards go to");
    expect(page).toContain("www.example.com updates · app.example.com updates");
    expect(page).toContain("Not released yet");
    expect(text(document.querySelector("[data-ply-go-live-railway]"))).toContain(
      "Railway: signed in · project acme-project",
    );
    await r.user.click(screen.getByRole("button", { name: "Read again" }));
    expect(asked).toBe(1);
  });

  it("says each service's latest deploy in words beside a dot (1.173.0 walk)", async () => {
    const map: DeployMap = {
      repo: "acme/monorepo",
      railway: read("ok", [{ ...site, deployStatus: "SUCCESS" }, { ...app, deployStatus: "FAILED" }]),
      workflows: [],
    };
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: map,
        areas_get: {
          shared: false,
          readOnly: false,
          defined: [],
          areas: [],
          workspaceBranch: "main",
          check: { errors: [], warnings: [] },
          problem: null,
          held: false,
        },
      },
    });
    await screen.findByText(/^Right now · read /);
    const now = document.querySelector("[data-ply-go-live-now]")!;
    const lines = [...now.querySelectorAll(".ux-status")];
    expect(lines.map((l) => l.textContent)).toEqual(["www.example.com · Live", "app.example.com · Last deploy failed"]);
    expect(lines.map((l) => l.className)).toEqual(["ux-status ux-status--done", "ux-status ux-status--aborted"]);
  });

  it("reads Railway again as it opens when its reading caught a deploy under way", async () => {
    const asked: (boolean | null)[] = [];
    const stale: DeployMap = {
      repo: "acme/monorepo",
      railway: { ...read("ok", [{ ...app, deployStatus: "DEPLOYING" }]), readAt: Date.now() - 5 * 60_000 },
      workflows: [],
    };
    const fresh: DeployMap = { ...stale, railway: { ...read("ok", [{ ...app, deployStatus: "SUCCESS" }]), readAt: Date.now() } };
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: (args: { refresh: boolean | null }) => {
          asked.push(args?.refresh ?? null);
          return args?.refresh ? fresh : stale;
        },
        areas_get: {
          shared: false,
          readOnly: false,
          defined: [],
          areas: [],
          workspaceBranch: "main",
          check: { errors: [], warnings: [] },
          problem: null,
          held: false,
        },
      },
    });
    expect(await screen.findByText("app.example.com · Live")).toBeTruthy();
    expect(asked).toEqual([false, true]);
    expect(screen.getByText("Right now · read just now")).toBeTruthy();
  });

  it("with nothing to read says so in one calm line", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: () => ({ repo: "acme/site", railway: read("noCli"), workflows: [] }),
      },
    });
    expect(await screen.findByText(GO_LIVE_NOTHING)).toBeTruthy();
    expect(screen.getByText(GO_LIVE_READS_WHEN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read again" })).toBeNull();
  });

  it("says Railway wasn't read when its command is missing in a project that uses it (1.173.0 Windows walk)", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: () => ({ repo: "acme/site", railway: read("noCli"), workflows: [], railwayFiles: true }),
      },
    });
    expect(await screen.findByText(/Plyloft can't read Railway on this (Mac|PC): the railway program isn't installed\./)).toBeTruthy();
    expect(screen.queryByText(GO_LIVE_READS_WHEN)).toBeNull();
  });

  it("says when the only link is another project's, on a folder above", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        deploy_map_get: () => ({ repo: "acme/site", railway: read("otherProject"), workflows: [] }),
      },
    });
    expect(await screen.findByText(/the link Plyloft sees is on a folder above this project, so it's another project's/)).toBeTruthy();
    expect(screen.getByText(GO_LIVE_NOTHING)).toBeTruthy();
  });

  it("with several areas and nothing to read says the calm line once, above the blocks", async () => {
    const areas = [
      { id: "app", name: "App", path: "", root: true, first: true, targetBranch: null, branch: "main", versionFiles: null, tagPrefix: "", label: "app", lookAt: null },
      { id: "site", name: "Site", path: "site", root: false, first: false, targetBranch: null, branch: "main", versionFiles: null, tagPrefix: "site-", label: "site", lookAt: null },
    ];
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        ship_pending_cards: [],
        areas_releases: [],
        areas_get: {
          shared: true,
          readOnly: false,
          defined: [],
          areas,
          workspaceBranch: "main",
          check: { errors: [], warnings: [] },
          problem: null,
          held: false,
        },
        deploy_map_get: () => ({ repo: "acme/monorepo", railway: read("noCli"), workflows: [] }),
      },
    });
    expect(await screen.findAllByText(GO_LIVE_NOTHING)).toHaveLength(1);
    expect(await screen.findAllByText("Nothing Plyloft can see")).toHaveLength(2);
  });
});

// ── 1.173.0 (F2): Release… from the project ─────────────────────────────

const twoAreas = [
  { id: "site", name: "Site", path: "site", root: false, first: false, targetBranch: null, branch: "main", versionFiles: null, tagPrefix: "site-", label: "site", lookAt: null },
  { id: "app", name: "App", path: "", root: true, first: true, targetBranch: "staging", branch: "staging", versionFiles: null, tagPrefix: "", label: "app", lookAt: null },
];
const areasView = (areas: typeof twoAreas) => ({
  shared: true,
  readOnly: false,
  defined: [],
  areas,
  workspaceBranch: "main",
  check: { errors: [], warnings: [] },
  problem: null,
  held: false,
});
const group = (area: string, name: string, cardIds: string[]) => ({
  area,
  name,
  cardIds,
  refusal: null,
  branch: area === "app" ? "staging" : "main",
  tagPrefix: area === "app" ? "" : `${area}-`,
});
const nothingMap = () => ({ repo: "acme/monorepo", railway: read("noCli"), workflows: [] });
/** 1.174.0 (DR5): an area's `release_scopes` entry, nothing new since its tag. */
const scopeOf = (area: string | null, name: string | null, targetBranch: string) => ({
  workspaceId: "ws-1",
  area,
  name,
  tagPrefix: area && area !== "app" ? `${area}-` : "",
  targetBranch,
  sinceTag: null as string | null,
  sinceAt: null as number | null,
  cards: [],
  cardsTotal: 0,
  otherChanges: [],
  otherTotal: 0,
  readyCardIds: [] as string[],
  refusal: null as string | null,
  inFlight: null as unknown,
});

// 1.174.0 (DR5, release.html state 10): one column, in the order things
// happen; Releases says the last tag and what is new since, with Release
// <Area>… beside it only when it can act, and Show it while one is on its way.
describe("How this goes live: one column, Release where it can act (DR5)", () => {
  it("reads top to bottom, and says each area's last release and what is new since", async () => {
    let shown = 0;
    const day = 24 * 3600_000;
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => shown++} />, {
      fixtures: {
        project_config_get: null,
        areas_releases: [],
        areas_get: areasView(twoAreas),
        deploy_map_get: () => ({ repo: "acme/monorepo", railway: read("ok", [{ ...site, deployStatus: "SUCCESS" }]), workflows: [] }),
        ship_pending_cards: [{ workspaceId: "ws-1", cardIds: [], areas: [] }],
        release_scopes: [
          { ...scopeOf("site", "Site", "main"), sinceTag: "site-v3.0.1", sinceAt: Date.now() - 12 * day, cardsTotal: 4, otherTotal: 2 },
          {
            ...scopeOf("app", "App", "staging"),
            sinceTag: "app-v1.4.0",
            inFlight: { tag: "app-v1.4.1", version: "1.4.1", prNumber: 391, prUrl: null, step: "merging", problem: null },
          },
        ],
      },
    });
    const siteRow = await screen.findByText("site-v3.0.1, 12 days ago · 4 cards and 2 other changes since");
    const block = siteRow.closest("[data-ply-go-live-block]") as HTMLElement;
    const labels = [...block.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toEqual(["Cards go to", "Then", "Right now", "Releases"]);
    expect(text(block.querySelector(".ux-section-count"))).toMatch(/^· read (just now|\d+ min ago)$/);
    expect(within(block).getByRole("button", { name: "Release Site…" })).toBeTruthy();
    // No button anywhere is off.
    for (const b of screen.getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(false);
    const app = document.querySelector("[data-ply-go-live-releases='app']") as HTMLElement;
    expect(text(app)).toContain("app-v1.4.1 on its way · waiting for GitHub's checks");
    expect(within(app).queryByRole("button", { name: "Release App…" })).toBeNull();
    await r.user.click(within(app).getByRole("button", { name: "Show it" }));
    expect(shown).toBe(1);
    // 1.174.0 (DR3): Show it opens the Release sheet on that area.
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: "app" });
    act(() => useUi.getState().setReleaseSheet(null));
  });

  // DR5 round 1 (blocker) → DR3: changes on main and no card ready — the
  // press opens the Release sheet on the area, with no card to tick.
  it("Release <Area>… with no ready card opens the Release sheet on that area", async () => {
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        project_config_get: null,
        areas_releases: [],
        areas_get: areasView(twoAreas),
        deploy_map_get: nothingMap,
        ship_pending_cards: [{ workspaceId: "ws-1", cardIds: [], areas: [] }],
        release_scopes: [
          {
            ...scopeOf("site", "Site", "main"),
            throughGithub: true,
            sinceTag: "site-v3.0.1",
            otherTotal: 2,
            versions: [{ kind: "patch", version: "3.0.2", tag: "site-v3.0.2", taken: false }],
          },
          scopeOf("app", "App", "staging"),
        ],
      },
    });
    await r.user.click(await screen.findByRole("button", { name: "Release Site…" }));
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: "site", cardIds: [] });
    expect(r.tauri.callsOf("release_area")).toHaveLength(0);
    act(() => useUi.getState().setReleaseSheet(null));
  });

  // DR3: Show it is the Release sheet's, on every plan.
  it("on Free, a release on its way has Show it too", async () => {
    act(() => setPlanGates(FREE_GATES));
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: [],
        release_scopes: [
          {
            ...scopeOf(null, null, "main"),
            inFlight: { tag: "v1.0.1", version: "1.0.1", prNumber: 3, prUrl: null, step: "merging", problem: null },
          },
        ],
      },
    });
    expect(await screen.findByText("v1.0.1 on its way · waiting for GitHub's checks")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Show it" }));
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: null });
    act(() => {
      useUi.getState().setReleaseSheet(null);
      setPlanGates(null);
    });
  });

  it("reads the releases again when the workspace's release record changes", async () => {
    let reads = 0;
    const { tauri } = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: [],
        release_scopes: () => {
          reads++;
          return [];
        },
      },
    });
    await waitFor(() => expect(reads).toBe(1));
    await act(async () => tauri.emit("ship-pending-release-changed", "ws-1"));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => tauri.emit("ship-pending-release-changed", "ws-other"));
    expect(reads).toBe(2);
  });

  it("nothing new since the last tag: the row says so, with no button", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: [],
        release_scopes: [{ ...scopeOf(null, null, "main"), sinceTag: "v1.4.0", sinceAt: Date.now() - 24 * 3600_000 }],
      },
    });
    expect(await screen.findByText("v1.4.0, yesterday · nothing new on main since")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
  });
});

describe("Release… from How this goes live (F2)", () => {
  // 1.174.0 (DR5, P28): no button that is off — Release <Area>… only where
  // there is something to release.
  it("has Release <Area>… on a block with something to release, and none on one without", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        areas_releases: [],
        areas_get: areasView(twoAreas),
        deploy_map_get: nothingMap,
        ship_pending_cards: [{ workspaceId: "ws-1", cardIds: ["s1", "s2"], areas: [group("site", "Site", ["s1", "s2"])] }],
      },
    });
    const site = (await screen.findByRole("button", { name: "Release Site…" })) as HTMLButtonElement;
    expect(site.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Release App…" })).toBeNull();
    expect(screen.queryByText(/Nothing to release/)).toBeNull();
    // The button sits in its block's Releases row.
    expect(site.closest("[data-ply-go-live-releases]")?.getAttribute("data-ply-go-live-releases")).toBe("site");
    expect(document.querySelector("[data-ply-go-live-releases='app'] button")).toBeNull();
  });

  it("without areas: one Release…; one ready card opens the Release sheet with it", async () => {
    let closed = 0;
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => closed++} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: [{ workspaceId: "ws-1", cardIds: ["c1"] }],
      },
    });
    const button = (await screen.findByRole("button", { name: "Release…" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await r.user.click(button);
    expect(closed).toBe(1);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: null, cardIds: ["c1"] });
  });

  it("with nothing to release, no Release… at all", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [], project_config_get: null, deploy_map_get: nothingMap, ship_pending_cards: [] },
    });
    expect(await screen.findByText("Not released yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
    expect(screen.queryByText(/Nothing to release/)).toBeNull();
  });

  // 1.174.0 (DR5): releasing what is on main is free, so the button carries
  // no Pro mark, on every plan.
  it("two ready cards open the release on them; no Pro mark on the button", async () => {
    act(() => setPlanGates(FREE_GATES));
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        areas_releases: [],
        areas_get: areasView(twoAreas),
        deploy_map_get: nothingMap,
        ship_pending_cards: [{ workspaceId: "ws-1", cardIds: ["s1", "s2", "a1"], areas: [group("site", "Site", ["s1", "s2"]), group("app", "App", ["a1"])] }],
      },
    });
    const site = await screen.findByRole("button", { name: "Release Site…" });
    expect(site.querySelector("[data-ply-pro-mark]")).toBeNull();
    expect(screen.getByRole("button", { name: "Release App…" }).querySelector("[data-ply-pro-mark]")).toBeNull();
    act(() => setPlanGates(null));
    await r.user.click(site);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: "site", cardIds: ["s1", "s2"] });
  });

  // Challenger round 1: a refused area says its own reason, never "nothing
  // to release" — and never another area's.
  it("an area refused for its version file says so, with no button, while the other area is ready", async () => {
    act(() =>
      seedBoard(
        [
          boardCard("s1", { columnId: "complete", verifyStatus: "passed", area: "site" }),
          boardCard("a1", { columnId: "complete", verifyStatus: "passed", area: "app" }),
        ],
      ),
    );
    const why = "Site has no version file of its own. Add one in Settings › Project › Areas.";
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [
          { ...scopeOf("site", "Site", "main"), refusal: "Site has no version file of its own. Add one in Settings › Project › Areas." },
          { ...scopeOf("app", "App", "staging"), readyCardIds: ["a1"] },
        ],
        project_config_get: null,
        areas_releases: [],
        areas_get: areasView(twoAreas),
        deploy_map_get: nothingMap,
        ship_pending_cards: [
          {
            workspaceId: "ws-1",
            cardIds: ["s1", "a1"],
            areas: [{ ...group("site", "", ["s1"]), area: null, refusal: why, branch: "", tagPrefix: "" }, group("app", "App", ["a1"])],
          },
        ],
      },
    });
    const app = (await screen.findByRole("button", { name: "Release App…" })) as HTMLButtonElement;
    expect(app.disabled).toBe(false);
    await waitFor(() => expect(text(document.querySelector("[data-ply-go-live-releases='site']"))).toBe(why));
    expect(screen.queryByRole("button", { name: "Release Site…" })).toBeNull();
  });

  it("before the ready cards are read, no Release… and nothing untrue", async () => {
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [], project_config_get: null, deploy_map_get: nothingMap, ship_pending_cards: () => new Promise(() => {}) },
    });
    expect(await screen.findByText("Not released yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
    expect(screen.queryByText(/Nothing to release/)).toBeNull();
  });

  // 1.174.0 (DR3): an approved Builder card with its session open is offered
  // Release… on its own page only; it no longer decides the project's.
  it("a card only its own page can release doesn't make a project Release…", async () => {
    act(() =>
      seedBoard(
        [
          boardCard("b1", {
            title: "Pricing table",
            columnId: "in_progress",
            verifyStatus: "passed",
            worktreePath: "/wt/b1",
            builder: {
              ptyId: "pty-1",
              snapshots: [{ n: 1 }],
              review: { status: "done", verdict: "approve", snapshotN: 1 },
            } as never,
          }),
        ],
      ),
    );
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [], project_config_get: null, deploy_map_get: nothingMap, ship_pending_cards: [] },
    });
    expect(await screen.findByText("Not released yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
  });

  // Round 2 follow-up: a list that can't be read never leaves Release… on
  // "Reading…" for good — the Board's own ready cards stand in, and with
  // none it says so, with Read again.
  it("when the ready cards can't be read, says so and reads again", async () => {
    let fail = true;
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: () => (fail ? Promise.reject(new Error("boom")) : [{ workspaceId: "ws-1", cardIds: ["c1"] }]),
        ship_pending_count: () => Promise.reject(new Error("boom")),
      },
    });
    const said = await screen.findByText("Plyloft couldn't read which cards are ready.");
    expect(said.nextElementSibling?.textContent).toBe("Read again");
    expect(screen.queryByRole("button", { name: "Release…" })).toBeNull();
    expect(screen.queryByText("Reading…")).toBeNull();
    fail = false;
    await r.user.click(within(said.parentElement!).getByRole("button", { name: "Read again" }));
    expect(await screen.findByRole("button", { name: "Release…" })).toBeTruthy();
    expect(useShip.getState().pendingFailed).toBe(false);
  });

  it("when the ready cards can't be read, the Board's own ready card stands in", async () => {
    act(() => seedBoard([boardCard("c1", { columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped" })]));
    renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [],
        project_config_get: null,
        deploy_map_get: nothingMap,
        ship_pending_cards: () => Promise.reject(new Error("boom")),
        ship_pending_count: () => Promise.reject(new Error("boom")),
      },
    });
    const button = (await screen.findByRole("button", { name: "Release…" })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  // DR3: on Free the Release sheet opens too, on both of them.
  it("on Free, two ready cards open the Release sheet on them", async () => {
    act(() => setPlanGates(FREE_GATES));
    const r = renderUi(<GoLiveSheet workspaceId="ws-1" onClose={() => {}} />, {
      fixtures: {
        release_scopes: [], project_config_get: null, deploy_map_get: nothingMap, ship_pending_cards: [{ workspaceId: "ws-1", cardIds: ["c1", "c2"] }] },
    });
    const button = await screen.findByRole("button", { name: /^Release…/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await r.user.click(button);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: "ws-1", areaId: null, cardIds: ["c1", "c2"] });
    act(() => setPlanGates(null));
  });
});

// 1.174.0 (DR3, release.html state 1): Board ⋯ › Release Site… says what
// the area's release would carry, read when the ⋯ opens, and opens the one
// Release sheet; on All areas the sheet asks which area.
describe("Board ⋯ › Release Site… (DR3)", () => {
  const ready = (id: string, area: string) =>
    boardCard(id, { columnId: "complete", verifyStatus: "passed", shipStatus: "unshipped", area });
  const siteScope = { ...scopeOf("site", "Site", "main"), sinceTag: "site-v3.0.1", cardsTotal: 4, otherTotal: 2, readyCardIds: ["s1", "s2"] };
  const appScope = { ...scopeOf("app", "App", "staging"), sinceTag: "app-v1.4.0", readyCardIds: [] as string[] };

  function board(cardIds: string[], groups: ReturnType<typeof group>[], areaChosen: string | null, scopes: unknown[] = [siteScope, appScope]) {
    act(() => {
      seedBoard([ready("s1", "site"), ready("s2", "site"), ready("a1", "app")]);
      useShip.setState({ pending: [{ workspaceId: BOARD_WS, cardIds, areas: groups }] });
      useAreas.setState({ views: { [BOARD_WS]: areasView(twoAreas) as never }, chosen: { [BOARD_WS]: areaChosen } });
    });
    return renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { release_scopes: scopes.map((sc) => ({ ...(sc as object), workspaceId: BOARD_WS })), project_config_get: null },
    });
  }

  it("on All areas with two areas with something, the sheet asks which", async () => {
    // C13: the ⋯ has its Release… while the header has no Release N cards…
    // (one ready card); on Free too.
    act(() => setPlanGates(FREE_GATES));
    const r = board(["s1"], [group("site", "Site", ["s1"])], null, [
      siteScope,
      { ...appScope, cardsTotal: 1 },
    ]);
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = await screen.findByRole("menuitem", { name: /^Release…/ });
    await waitFor(() => expect(item.textContent).toContain("Asks which area to release"));
    await r.user.click(item);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS });
    act(() => setPlanGates(null));
  });

  it("on All areas with one area with something, it is that area's", async () => {
    // C13: the ⋯ has its Release… while the header has no Release N cards…
    // (one ready card); on Free too.
    act(() => setPlanGates(FREE_GATES));
    const r = board(["s1"], [group("site", "Site", ["s1"])], null);
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = await screen.findByRole("menuitem", { name: /^Release Site…/ });
    await waitFor(() =>
      expect(item.textContent).toContain("4 cards and 2 other changes on main since site-v3.0.1 · 2 more cards ready"),
    );
    await r.user.click(item);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS, areaId: "site" });
    act(() => setPlanGates(null));
  });

  // 1.174.1 P7 (T7): while it reads, it says so, and it turns on in the
  // open menu once the read finishes.
  it("says Reading… while what the area would release is read, then turns on in the open menu", async () => {
    act(() => {
      markReleaseScopesStale(BOARD_WS);
      useReleaseScopes.setState({ byWorkspace: {} });
    });
    let answer: (list: unknown[]) => void = () => {};
    const scopes = new Promise<unknown[]>((resolve) => {
      answer = resolve;
    });
    act(() => {
      seedBoard([ready("s1", "site")]);
      useShip.setState({ pending: [{ workspaceId: BOARD_WS, cardIds: ["s1"], areas: [group("site", "Site", ["s1"])] }] as never });
      useAreas.setState({ views: { [BOARD_WS]: areasView(twoAreas) as never }, chosen: { [BOARD_WS]: "site" } });
    });
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { release_scopes: () => scopes, project_config_get: null },
    });
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = (await screen.findByRole("menuitem", { name: /^Release Site…/ })) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain("Reading…");
    expect(item.getAttribute("aria-describedby")).toBeTruthy();
    await act(async () => answer([{ ...siteScope, workspaceId: BOARD_WS }, { ...appScope, workspaceId: BOARD_WS }]));
    // The same open menu: on, with what it would release.
    await waitFor(() => {
      const now = screen.getByRole("menuitem", { name: /^Release Site…/ }) as HTMLButtonElement;
      expect(now.disabled).toBe(false);
      expect(now.textContent).toContain("since site-v3.0.1");
      expect(now.textContent).not.toContain("Reading…");
    });
  });

  it("on an area, is off with nothing new there, and says since when", async () => {
    const r = board(["s1", "s2"], [group("site", "Site", ["s1", "s2"])], "app");
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = await screen.findByRole("menuitem", { name: /^Release App…/ });
    await waitFor(() => expect(item.textContent).toContain("Nothing new on staging since app-v1.4.0."));
    expect(item.getAttribute("aria-disabled") === "true" || (item as HTMLButtonElement).disabled).toBe(true);
  });

  it("on Free, carries no Pro mark", async () => {
    act(() => setPlanGates(FREE_GATES));
    const r = board(["s1"], [group("site", "Site", ["s1"])], "site");
    await r.user.click(screen.getByRole("button", { name: "More for the Board" }));
    const item = await screen.findByRole("menuitem", { name: /^Release Site…/ });
    await waitFor(() => expect(item.textContent).toContain("since site-v3.0.1"));
    expect(item.textContent).not.toMatch(/\bPro\b/);
    act(() => setPlanGates(null));
  });

  // 1.174.0 (DS8 → DR3): Settings search's Release… on the Board opens the
  // Release sheet as the ⋯ does, once what it reads is read.
  it("a Settings search's Release… with nothing to release says why, as the ⋯ does", async () => {
    board(["s1", "s2"], [group("site", "Site", ["s1", "s2"])], "app");
    act(() => useUi.getState().askBoard(BOARD_WS, "release"));
    await waitFor(() => expect(useUi.getState().boardAsk).toBeNull());
    const last = useToasts.getState().toasts.slice(-1)[0];
    expect(last?.kind).toBe("info");
    expect(last?.title).toBe("Nothing new on staging since app-v1.4.0.");
    expect(useUi.getState().releaseSheet).toBeNull();
  });

  it("a Settings search's Release… waits for a Board mounted fresh to read its areas and releases", async () => {
    let answer!: (v: unknown) => void;
    const scopes = new Promise((res) => (answer = res));
    act(() => {
      seedBoard([ready("s1", "site"), ready("s2", "site"), ready("a1", "app")]);
      useAreas.setState({ views: {}, chosen: { [BOARD_WS]: null } });
      // Asked from Settings while another mode was open: the Board mounts after.
      useUi.getState().askBoard(BOARD_WS, "release");
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { project_config_get: null, areas_get: areasView(twoAreas), release_scopes: () => scopes },
    });
    await waitFor(() => expect(useAreas.getState().views[BOARD_WS]).toBeTruthy());
    // What each area would release isn't read yet: the ask waits, nothing is said.
    expect(useUi.getState().boardAsk).not.toBeNull();
    await act(async () => answer([{ ...siteScope, workspaceId: BOARD_WS }, { ...appScope, workspaceId: BOARD_WS }]));
    await waitFor(() => expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS, areaId: "site" }));
    expect(useUi.getState().boardAsk).toBeNull();
    act(() => useUi.getState().setReleaseSheet(null));
  });

  // DS8 round 3: the ask never leaks, nor opens by itself later.
  function freshAsk(at = Date.now()) {
    act(() => {
      seedBoard([ready("s1", "site"), ready("a1", "app")]);
      useAreas.setState({ views: {}, failed: {}, chosen: { [BOARD_WS]: null } });
      useUi.setState({ boardAsk: { workspaceId: BOARD_WS, what: "release", at } });
    });
  }
  const lastToast = () => useToasts.getState().toasts.slice(-1)[0];

  it("a Settings search's Release… on a project whose areas can't be read ends, saying so", async () => {
    freshAsk();
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { project_config_get: null, areas_get: () => Promise.reject(new Error("git failed")) },
    });
    await waitFor(() => expect(useUi.getState().boardAsk).toBeNull());
    expect(lastToast()?.title).toBe("Plyloft couldn't read which cards are ready.");
    expect(useUi.getState().releaseSheet).toBeNull();
  });

  it("a Settings search's Release… that can't be answered ends after 10 s, saying so", async () => {
    freshAsk(Date.now() - 9_950);
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { project_config_get: null, areas_get: areasView(twoAreas), release_scopes: () => new Promise(() => {}) },
    });
    // What each area would release is never read: the ask ends by itself.
    await waitFor(() => expect(useUi.getState().boardAsk).toBeNull());
    expect(lastToast()?.title).toBe("Plyloft couldn't read which cards are ready.");
    expect(useUi.getState().releaseSheet).toBeNull();
  });

  it("a Settings search's Release… is dropped when the Board goes", async () => {
    freshAsk();
    const r = renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: { project_config_get: null, areas_get: areasView(twoAreas), release_scopes: () => new Promise(() => {}) },
    });
    expect(useUi.getState().boardAsk).not.toBeNull();
    r.unmount();
    await waitFor(() => expect(useUi.getState().boardAsk).toBeNull());
  });


  it("on an area, the header's Release N cards… opens that area's release with its cards", async () => {
    const r = board(["s1", "s2", "a1"], [group("site", "Site", ["s1", "s2"]), group("app", "App", ["a1"])], "site");
    const header = screen.getByRole("button", { name: "Release 2 cards…" });
    expect(header.title).toBe("Release 2 cards together, as one version");
    await r.user.click(header);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS, areaId: "site", cardIds: ["s1", "s2"] });
  });

  // 1.174.1 P3 (T3): its N is one area's — the area the sheet opens, or
  // the first it asks about — never every area's.
  it("on All areas, the header's Release N cards… counts one area and says a release is one area at a time", async () => {
    const r = board(["s1", "s2", "a1"], [group("site", "Site", ["s1", "s2"]), group("app", "App", ["a1"])], null);
    const header = screen.getByRole("button", { name: "Release 2 cards…" });
    expect(screen.queryByRole("button", { name: "Release 3 cards…" })).toBeNull();
    expect(header.title).toBe("Release the cards that are ready, one area at a time");
    await r.user.click(header);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS });
  });

  it("on All areas, once what each area would release is read, the header counts the area the sheet opens", async () => {
    const appIds = ["a1", "a2", "a3"];
    const nothing = { ...siteScope, cardsTotal: 0, otherTotal: 0, readyCardIds: [] as string[] };
    act(() => {
      markReleaseScopesStale(BOARD_WS);
      useReleaseScopes.setState({ byWorkspace: {} });
      seedBoard([ready("s1", "site"), ready("s2", "site"), ...appIds.map((id) => ready(id, "app"))]);
      useShip.setState({
        pending: [{ workspaceId: BOARD_WS, cardIds: ["s1", "s2", ...appIds], areas: [group("site", "Site", ["s1", "s2"]), group("app", "App", appIds)] }] as never,
      });
      useAreas.setState({ views: { [BOARD_WS]: areasView(twoAreas) as never }, chosen: { [BOARD_WS]: null } });
    });
    renderUi(<KanbanBoard workspaceId={BOARD_WS} />, {
      fixtures: {
        release_scopes: [nothing, { ...appScope, readyCardIds: appIds }].map((sc) => ({ ...sc, workspaceId: BOARD_WS })),
        project_config_get: null,
      },
    });
    // Before the read: the first area with ready cards.
    expect(screen.getByRole("button", { name: "Release 2 cards…" })).toBeTruthy();
    await act(async () => {
      await useReleaseScopes.getState().read(BOARD_WS);
    });
    // Only App has something: the sheet opens App, its three cards ticked.
    expect(await screen.findByRole("button", { name: "Release 3 cards…" })).toBeTruthy();
    // Challenger P3-1: one more App card ready after the read counts.
    act(() => {
      const more = [...appIds, "a4"];
      seedBoard([ready("s1", "site"), ready("s2", "site"), ...more.map((id) => ready(id, "app"))]);
      useShip.setState({
        pending: [{ workspaceId: BOARD_WS, cardIds: ["s1", "s2", ...more], areas: [group("site", "Site", ["s1", "s2"]), group("app", "App", more)] }] as never,
      });
    });
    expect(await screen.findByRole("button", { name: "Release 4 cards…" })).toBeTruthy();
  });

  it("the sidebar's Release N cards… counts and opens as the Board header does", async () => {
    act(() => {
      markReleaseScopesStale(BOARD_WS);
      useReleaseScopes.setState({ byWorkspace: {} });
      seedBoard([ready("s1", "site"), ready("s2", "site"), ready("a1", "app")]);
      useShip.setState({
        pending: [{ workspaceId: BOARD_WS, cardIds: ["s1", "s2", "a1"], areas: [group("site", "Site", ["s1", "s2"]), group("app", "App", ["a1"])] }] as never,
      });
      useAreas.setState({ views: { [BOARD_WS]: areasView(twoAreas) as never }, chosen: { [BOARD_WS]: null } });
      useUi.getState().setReleaseSheet(null);
    });
    const pending = [{ workspaceId: BOARD_WS, cardIds: ["s1", "s2", "a1"], areas: [group("site", "Site", ["s1", "s2"]), group("app", "App", ["a1"])] }];
    const r = renderUi(<WorkspaceSidebar env={null} />, {
      fixtures: {
        drain_status: { draining: false, startedAt: null },
        ship_pending_count: 3,
        ship_pending_cards: pending,
        ship_unverified_count: 0,
        areas_get: areasView(twoAreas),
      },
    });
    r.tauri.allowUnhandled();
    const row = await screen.findByText("Release 2 cards…");
    expect(screen.queryByText("Release 3 cards…")).toBeNull();
    const nav = row.closest("[title]") as HTMLElement;
    // Challenger P3-3: it asks which area, and its title says so.
    expect(nav.getAttribute("title")).toBe(SHIP_BATCH_BY_AREA);
    await r.user.click(nav);
    expect(useUi.getState().releaseSheet).toEqual({ workspaceId: BOARD_WS });
  });

  // Challenger P3-2: before the backend's list is read, the active project's
  // own count (the Board's ready cards of the first area), not every project's.
  it("the sidebar's Release N cards… counts the active project's area before the list is read", async () => {
    act(() => {
      markReleaseScopesStale(BOARD_WS);
      useReleaseScopes.setState({ byWorkspace: {} });
      seedBoard([ready("s1", "site"), ready("s2", "site"), ready("a1", "app")]);
      useShip.setState({ pending: null, pendingFailed: false, pendingCount: 5 } as never);
      useAreas.setState({ views: { [BOARD_WS]: areasView(twoAreas) as never }, chosen: { [BOARD_WS]: null } });
    });
    const r = renderUi(<WorkspaceSidebar env={null} />, {
      fixtures: {
        drain_status: { draining: false, startedAt: null },
        ship_pending_count: 5,
        ship_pending_cards: () => new Promise(() => {}),
        ship_unverified_count: 0,
        areas_get: areasView(twoAreas),
      },
    });
    r.tauri.allowUnhandled();
    const row = await screen.findByText("Release 2 cards…");
    expect(screen.queryByText("Release 5 cards…")).toBeNull();
    expect((row.closest("[title]") as HTMLElement).getAttribute("title")).toBe(SHIP_BATCH_BY_AREA);
  });
});
