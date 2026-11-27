// 1.172.0 D1 (T7 CP-4, card-page B5): the card's ⋯ as the person meets it —
// the real CardDetailPanel over the real stores, the terminals and the
// Outcome screen stand-ins (as in cardPage.test.tsx). The ⋯ is in headed
// groups (Build, Ship, Session, Card) with Delete last and apart; nothing in
// it repeats what Now offers for the same card; it is walked with the keys;
// run history's switch and Clear are beside the runs, not in it.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { DoctorReport, KanbanCard } from "../ipc";
import { useDoctor } from "../store/doctorStore";
import { useUi } from "../store/uiStore";
import { useBuilder } from "../store/builderStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { renderUi, screen, waitFor, within } from "./render";
import { nowDuplicates } from "../lib/cardMoreMenu";
import { RECORD_RUNS_LABEL } from "../components/KanbanRunHistory";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => <div data-testid="builder-terminal" data-card={cardId} />,
}));
vi.mock("../components/CardReviewPanel", () => ({
  CardReviewPanel: () => <div data-testid="review-diff" />,
}));
vi.mock("../components/IntakeConversation", () => ({
  IntakeConversation: () => <div data-testid="intake-terminal" />,
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: ({
    onShipReady,
    onPresentationChange,
  }: {
    onShipReady?: (run: (() => Promise<void>) | null) => void;
    onPresentationChange?: (s: { loading: boolean; filesChanged: number | null; shipBusy: boolean }) => void;
  }) => {
    useEffect(() => {
      onShipReady?.(async () => {});
      const t = setTimeout(() => onPresentationChange?.({ loading: false, filesChanged: 3, shipBusy: false }));
      return () => {
        clearTimeout(t);
        onShipReady?.(null);
      };
    }, [onShipReady, onPresentationChange]);
    return <div data-testid="outcome" />;
  },
}));

function open(card: KanbanCard) {
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" } });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    withToasts: true,
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      kanban_card_worktree_state: {
        disposition: "remove",
        path: null,
        branch: null,
        dirtyFiles: 0,
        unpushedCommits: 0,
        liveSession: false,
        unreadable: false,
        busy: null,
        cardBranch: null,
        cardBranchCommits: null,
      },
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const nowRegion = () => screen.getByRole("region", { name: "Now" });
const moreButton = () => screen.getByRole("button", { name: "More for this card" });
const moreMenu = () => screen.getByRole("menu", { name: "More for this card" });

/** The menu as the person reads it: `# Group` for a group, then its items. */
function menuOutline(menu: HTMLElement): string[] {
  const out: string[] = [];
  for (const child of Array.from(menu.children)) {
    if (child.getAttribute("role") === "group") {
      const heading = document.getElementById(child.getAttribute("aria-labelledby")!)!;
      out.push(`# ${heading.textContent}`);
      for (const row of Array.from(child.children)) {
        if (row === heading) continue;
        if (row.getAttribute("role") === "separator") out.push("—");
        else out.push(accessibleName(row as HTMLElement));
      }
    } else if (child.getAttribute("role") === "separator") out.push("—");
    else out.push(accessibleName(child as HTMLElement));
  }
  return out;
}

/** A menu's items, of every kind (menuitem, a radio, a switch). */
const menuItems = (menu: HTMLElement) => Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));

/** An item's name: its label, without the hint drawn under it. */
function accessibleName(el: HTMLElement): string {
  // 1.173.0 A3 re-walk: an item with a hint is named by its label span
  // (aria-labelledby); the hint is its description.
  const by = el.getAttribute("aria-labelledby");
  const labelled = by ? document.getElementById(by) : null;
  if (labelled) return (labelled.textContent ?? "").trim();
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? "").trim();
}

const session = { vendor: "claude" as const, bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: Date.now() - 60_000, snapshots: [] };
const liveBuilder = () =>
  useBuilder.setState({
    byCard: {
      c1: { workspaceId: BOARD_WS, ptyId: "pty-1", vendor: "claude", startedAt: Date.now() - 60_000, lastOutputAt: Date.now(), promptBoxIdle: false, pending: [] } as never,
    },
  });

/** A card in each state the ⋯ changes in. `live` puts its Builder's session
 *  in the store, as a running one is. */
const bothReady = () =>
  useDoctor.setState({
    report: {
      tools: ["git", "claude", "codex"].map((id) => ({
        id,
        name: id,
        required: false,
        found: true,
        path: `/bin/${id}`,
        version: "1.0.0",
        versionOk: true,
        detail: "",
        installCmd: "",
        docsUrl: "",
        reviewer: null,
      })),
      teamSkills: null,
      projectSkills: null,
      microphone: null,
      whisperModel: null,
      dictationShell: null,
      sharedDefinition: null,
      probeError: null,
      allRequiredOk: true,
      aiReady: true,
    } as DoctorReport,
  });

const STATES: Array<[string, () => KanbanCard, (() => void)?]> = [
  ["a card with only its title", () => boardCard("c1")],
  ["a card ready to start", () => boardCard("c1", { notes: "Do it" })],
  // Build with both is Now's alternative here (both CLIs found).
  ["a card ready to start, Claude and Codex both found", () => boardCard("c1", { notes: "Do it" }), bothReady],
  ["a card ready to start with an agent", () => boardCard("c1", { notes: "Do it", agentConfigId: "agent-1" })],
  ["a card being planned", () => boardCard("c1", { notes: "Do it", intakeStatus: "active" })],
  [
    "a card being built",
    () =>
      boardCard("c1", {
        notes: "Do it",
        columnId: "in_progress",
        lastRunStatus: "running",
        worktreePath: "/tmp/wt/c1",
        builder: session,
      }),
    liveBuilder,
  ],
  [
    "a card whose session is closed",
    () =>
      boardCard("c1", {
        notes: "Do it",
        columnId: "in_progress",
        lastRunStatus: "success",
        worktreePath: "/tmp/wt/c1",
        builder: { ...session, ptyId: null, snapshots: [{ n: 1, sha: "aaaaaaa1", at: Date.now() - 30_000 }] },
      }),
  ],
  [
    "a card whose checks failed",
    () =>
      boardCard("c1", {
        notes: "Do it",
        columnId: "complete",
        verifyStatus: "failed",
        worktreePath: "/tmp/wt/c1",
        builder: { ...session, ptyId: null, snapshots: [{ n: 1, sha: "aaaaaaa1", at: Date.now() - 30_000 }] },
      }),
  ],
  [
    "a card ready to ship",
    () =>
      boardCard("c1", {
        notes: "Do it",
        columnId: "complete",
        lastRunStatus: "success",
        verifyStatus: "passed",
        worktreePath: "/tmp/wt/c1",
      }),
  ],
  [
    "a shipped card",
    () =>
      boardCard("c1", {
        notes: "Do it",
        columnId: "complete",
        shipStatus: "shipped",
        shipHistory: [{ commitSha: "abc12345", shippedVersion: "1.161.0", releaseKind: "local", shippedAt: Date.now() - 60_000 }],
      }),
  ],
];

describe("the card's ⋯ in groups (1.172.0 D1)", () => {
  it("a card ready to start: Build, then Card with Delete last and apart", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it" }));
    await user.click(moreButton());
    const outline = menuOutline(moreMenu());
    // 1.172.0 (C1): planning is Plan it first ▾'s, Build with both Start
    // build ▾'s — the ⋯ has neither.
    expect(outline).not.toContain("Plan with two AIs…");
    expect(outline).not.toContain("Build with both");
    expect(outline.slice(-4)).toEqual(["# Card", "Archive", "—", "Delete card…"]);
    expect(outline).not.toContain("# Ship");
    expect(outline).not.toContain("# Session");
  });

  it("a card being built: Session holds closing it and the terminal in its copy", async () => {
    liveBuilder();
    const { user } = open(
      boardCard("c1", { notes: "Do it", columnId: "in_progress", lastRunStatus: "running", worktreePath: "/tmp/wt/c1", builder: session }),
    );
    await user.click(moreButton());
    const outline = menuOutline(moreMenu());
    const at = outline.indexOf("# Session");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(outline.slice(at + 1, at + 3)).toEqual(["Close the Builder session…", "Open a terminal in the card's copy"]);
    expect(outline.slice(-1)[0]).toBe("Delete card…");
  });

  it("a card ready to ship: Release… under Ship, before Session and Card", async () => {
    const { user } = open(
      boardCard("c1", { notes: "Do it", columnId: "complete", lastRunStatus: "success", verifyStatus: "passed", worktreePath: "/tmp/wt/c1" }),
    );
    await user.click(moreButton());
    const outline = menuOutline(moreMenu());
    expect(outline.indexOf("# Ship")).toBeGreaterThanOrEqual(0);
    expect(outline[outline.indexOf("# Ship") + 1]).toBe("Release…");
    expect(outline.indexOf("# Ship")).toBeLessThan(outline.indexOf("# Session"));
    expect(outline.indexOf("# Session")).toBeLessThan(outline.indexOf("# Card"));
  });

  it("names each group for a screen reader", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it" }));
    await user.click(moreButton());
    const menu = moreMenu();
    expect(within(menu).getByRole("group", { name: "Card" })).toBeTruthy();
    expect(within(within(menu).getByRole("group", { name: "Card" })).getByRole("menuitem", { name: "Delete card…" })).toBeTruthy();
    expect(within(menu).queryByRole("group", { name: "Build" })).toBeNull();
  });

  it.each(STATES)("has nothing Now offers on %s", async (_what, card, setup) => {
    setup?.();
    const { user } = open(card());
    // Wait for the result's presentation (Ship it comes once it is read).
    await waitFor(() => expect(document.querySelector("[data-ply-primary-action-id]")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    const region = nowRegion();
    const nowNames = within(region)
      .queryAllByRole("button")
      .map((b) => accessibleName(b))
      .filter((n) => n && !n.startsWith("Other ways"));
    // The primary's ▾ choices are Now's too.
    const chevron = within(region).queryByRole("button", { name: /^Other ways/ });
    if (chevron && !(chevron as HTMLButtonElement).disabled) {
      await user.click(chevron);
      const menu = screen.getByRole("menu", { name: chevron.getAttribute("aria-label")! });
      nowNames.push(...menuItems(menu).map((m) => accessibleName(m)));
      await user.keyboard("{Escape}");
    }
    // …and Plan it first ▾'s (1.172.0 C1).
    const planFirst = within(region).queryByRole("button", { name: "Plan it first" });
    if (planFirst) {
      await user.click(planFirst);
      nowNames.push(...menuItems(screen.getByRole("menu", { name: /Plan it first/ })).map((m) => accessibleName(m)));
      await user.keyboard("{Escape}");
    }
    expect(nowNames.length).toBeGreaterThan(0);
    await user.click(moreButton());
    const moreNames = menuItems(moreMenu())
      .map((m) => accessibleName(m));
    expect(moreNames).toContain("Delete card…");
    expect(nowDuplicates(nowNames, moreNames)).toEqual([]);
    // Never the run history's switch or Clear.
    expect(moreNames.filter((n) => /run history/i.test(n))).toEqual([]);
  });

  it("is walked with the keys: first item focused, ↓ ↑ across groups, Home, End on Delete, Esc back to ⋯", async () => {
    liveBuilder();
    const { user } = open(
      boardCard("c1", { notes: "Do it", columnId: "in_progress", lastRunStatus: "running", worktreePath: "/tmp/wt/c1", builder: session }),
    );
    // The page settles first (it puts focus on Now's title as it opens).
    await waitFor(() => expect(document.querySelector("[data-ply-primary-action-id]")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    moreButton().focus();
    await user.keyboard("{Enter}");
    const items = menuItems(moreMenu()).filter((i) => !(i as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(items[0]);
    // Headings are never stopped on: ↓ goes from one group's last item to
    // the next group's first.
    for (let i = 1; i < items.length; i += 1) {
      await user.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(items[i]);
    }
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowUp}");
    expect(accessibleName(document.activeElement as HTMLElement)).toBe("Delete card…");
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{End}");
    expect(accessibleName(document.activeElement as HTMLElement)).toBe("Delete card…");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "More for this card" })).toBeNull();
    expect(document.activeElement).toBe(moreButton());
  });
});

describe("run history beside the runs, not in the ⋯ (1.172.0 D1)", () => {
  const entry = {
    runId: "run-1",
    status: "done" as const,
    endedAt: Date.now() - 60_000,
    filesChangedCount: 2,
    topPaths: ["src/a.ts"],
    swarmCollisions: 0,
  };

  it("a card with runs: Details has the switch and Clear history…", async () => {
    const { user, tauri } = open(boardCard("c1", { notes: "Do it", agentConfigId: "agent-1", runHistory: [entry] }));
    tauri.fixture("kanban_card_patch", ({ cardId, patch }: Record<string, unknown>) => ({
      ...boardCard(cardId as string, { notes: "Do it", agentConfigId: "agent-1", runHistory: [entry] }),
      ...(patch as object),
    }));
    await user.click(document.querySelector<HTMLElement>("[data-ply-card-details]")!.closest("details")!.querySelector("summary")!);
    const block = document.querySelector<HTMLElement>("[data-ply-run-history]")!;
    expect(within(block).getByText("Run history (1)")).toBeTruthy();
    expect(within(block).getByRole("button", { name: "Clear history…" })).toBeTruthy();
    const toggle = within(block).getByRole("switch", { name: RECORD_RUNS_LABEL });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    await waitFor(() => expect(tauri.callsOf("kanban_card_patch")).toHaveLength(1));
    expect(tauri.callsOf("kanban_card_patch")[0].args.patch).toEqual({ suppressRunHistory: true });
  });

  it("a card that doesn't record its runs says so, with the switch off to turn it back on", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it", suppressRunHistory: true }));
    await user.click(document.querySelector<HTMLElement>("[data-ply-card-details]")!.closest("details")!.querySelector("summary")!);
    const block = document.querySelector<HTMLElement>("[data-ply-run-history]")!;
    expect(within(block).getByText("This card's runs aren't recorded.")).toBeTruthy();
    expect(within(block).getByRole("switch", { name: RECORD_RUNS_LABEL }).getAttribute("aria-checked")).toBe("false");
    expect(within(block).queryByRole("button", { name: "Clear history…" })).toBeNull();
  });

  it("a Builder card, whose runs are never recorded, shows no run history at all", async () => {
    const { user } = open(boardCard("c1", { notes: "Do it" }));
    await user.click(document.querySelector<HTMLElement>("[data-ply-card-details]")!.closest("details")!.querySelector("summary")!);
    expect(document.querySelector("[data-ply-run-history]")).toBeNull();
    await user.click(moreButton());
    expect(within(moreMenu()).queryByRole("menuitem", { name: /run history/i })).toBeNull();
  });
});
