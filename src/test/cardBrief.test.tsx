// v1.154.1 (walk F19): the brief typed in "What you want" was saved only by
// Save or a blur the page happened to get — a card left with its brief typed
// stayed a Draft, and moving to another card dropped the text. It now saves
// a moment after typing stops, on blur, and when the card is left.
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { useLicense } from "../store/licenseStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { act, renderUi, screen, waitFor, within } from "./render";
import { setTeamAllowed } from "./planGates";

vi.mock("../components/BuilderSession", () => ({
  BuilderSession: ({ cardId }: { cardId: string }) => {
    useEffect(() => {}, []);
    return <div data-testid={`terminal-${cardId}`} />;
  },
}));
vi.mock("../components/OutcomeScreen", () => ({
  OutcomeScreen: () => <div data-testid="outcome" />,
}));

type PatchArgs = { workspaceId: string; cardId: string; patch: Partial<KanbanCard> };

function open(cards: KanbanCard[], patchDelayMs = 0, workspace: Parameters<typeof seedBoard>[1] = {}) {
  seedBoard(cards, workspace);
  useUi.setState({ selectedCardId: { [BOARD_WS]: cards[0].id }, centerMode: { [BOARD_WS]: "board" } });
  useBuilder.setState({ byCard: {}, vendorPref: {}, trustAsking: {} });
  const view = renderUi(<CardDetailPanel workspaceId={BOARD_WS} />, {
    fixtures: {
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      verify_list_inflight: [],
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      worktree_env_proposal: [],
      kanban_card_patch: async (args: Record<string, unknown>) => {
        const { cardId, patch } = args as PatchArgs;
        if (patchDelayMs) await new Promise((r) => setTimeout(r, patchDelayMs));
        return { ...cards.find((c) => c.id === cardId)!, ...patch, updatedAt: Date.now() };
      },
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const brief = () => screen.getByRole("textbox", { name: "What you want" }) as HTMLTextAreaElement;
const now = () => within(screen.getByRole("region", { name: "Now" }));
const patches = (view: ReturnType<typeof open>) =>
  view.tauri.callsOf("kanban_card_patch").map((c) => [c.args.cardId, (c.args.patch as Partial<KanbanCard>).notes]);

describe("the card's brief saves itself (walk F19)", () => {
  it("a moment after typing stops, without Save or a blur — and the title-only card keeps Ready to start", async () => {
    const view = open([boardCard("c1", { title: "Add nod" })]);
    // 1.171.0 C1 (CF5): a card with only its title is Ready to start already.
    expect(now().getByText("Ready to start")).toBeTruthy();
    expect(now().getByText(/^Claude gets only the title/)).toBeTruthy();
    fireEvent.change(brief(), { target: { value: "Add nod() to greet.js" } });
    expect(patches(view)).toEqual([]);
    await waitFor(() => expect(patches(view)).toEqual([["c1", "Add nod() to greet.js"]]), { timeout: 3000 });
    await waitFor(() => expect(now().queryByText(/^Claude gets only the title/)).toBeNull());
    expect(now().getByText("Ready to start")).toBeTruthy();
  });

  it("on blur, at once", async () => {
    const view = open([boardCard("c1")]);
    fireEvent.change(brief(), { target: { value: "Now" } });
    fireEvent.focusOut(brief());
    await waitFor(() => expect(patches(view)).toEqual([["c1", "Now"]]));
  });

  it("when another card is opened before it saved", async () => {
    const view = open([boardCard("c1"), boardCard("c2", { notes: "Second" })]);
    fireEvent.change(brief(), { target: { value: "First brief" } });
    act(() => useUi.getState().selectCard(BOARD_WS, "c2"));
    await waitFor(() => expect(patches(view)).toEqual([["c1", "First brief"]]));
    expect(brief().value).toBe("Second");
  });

  it("when the card page is closed", async () => {
    const view = open([boardCard("c1")]);
    fireEvent.change(brief(), { target: { value: "Closed with it typed" } });
    act(() => useUi.getState().selectCard(BOARD_WS, null));
    await waitFor(() => expect(patches(view)).toEqual([["c1", "Closed with it typed"]]));
  });

  it("keeps what is typed while an earlier save lands", async () => {
    const view = open([boardCard("c1")], 400);
    fireEvent.change(brief(), { target: { value: "abc" } });
    fireEvent.focusOut(brief());
    fireEvent.change(brief(), { target: { value: "abcd" } });
    await waitFor(() => expect(patches(view)[0]).toEqual(["c1", "abc"]));
    // The first save reconciles the card to "abc"; the box keeps "abcd"…
    await new Promise((r) => setTimeout(r, 500));
    expect(brief().value).toBe("abcd");
    // …and saves it too.
    await waitFor(() => expect(patches(view)[patches(view).length - 1]).toEqual(["c1", "abcd"]), { timeout: 3000 });
  });

  it("on a card linked to a GitHub issue, waits for the blur — a pause never edits the issue", async () => {
    useLicense.setState({
      info: { status: "none", team: null, seats: null, issuedAt: null, expiresAt: null, teamRepo: null },
      loaded: true,
    } as never);
    setTeamAllowed(true);
    const view = open([boardCard("g1", { ghIssueNumber: 62 } as Partial<KanbanCard>)], 0, {
      kanbanSyncMode: "githubIssues",
      githubOwnerRepo: "o/lyra",
    } as never);
    expect(brief().disabled).toBe(false);
    fireEvent.change(brief(), { target: { value: "Synced once" } });
    await new Promise((r) => setTimeout(r, 2000));
    // Each kanban_card_patch of the brief runs gh issue edit: none on a pause.
    expect(patches(view)).toEqual([]);
    fireEvent.focusOut(brief());
    await waitFor(() => expect(patches(view)).toEqual([["g1", "Synced once"]]));
    // Leaving the card after the blur sends nothing more.
    act(() => useUi.getState().selectCard(BOARD_WS, null));
    await new Promise((r) => setTimeout(r, 50));
    expect(patches(view)).toHaveLength(1);
  });
});

// 1.172.0 (C1; CP-11, CP-12, CP-13, CF B4): a card not built yet is
// brief-first — one Brief block (What you want, the setup sentence, the plan
// the Builder follows, More detail) right under Now; once built it sits
// before the Activity.
describe("the Brief block (1.172.0 C1)", () => {
  const region = (name: string) => screen.getByRole("region", { name });
  const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  // 1.175.0 F10 (UX-10): no facts line before the first build — the
  // Brief's sentence says it, with the card's one Change….
  it("a card not built yet: Now, then the Brief, then the Activity — no facts line, one Change…", () => {
    open([boardCard("c1", { notes: "Add a dark mode" })]);
    const nowBox = region("Now");
    const briefBlock = region("Brief");
    expect(document.querySelector(".ux-props--line")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Change…" })).toHaveLength(1);
    expect(document.querySelector(".ux-card-body")!.firstElementChild).toBe(nowBox);
    expect(briefBlock.getAttribute("data-ply-card-brief-block")).toBe("first");
    expect(follows(nowBox, briefBlock)).toBe(true);
    expect(follows(briefBlock, region("Activity"))).toBe(true);
    // In the block, in order: What you want, its setup sentence, More detail.
    const parts = [
      within(briefBlock).getByRole("textbox", { name: "What you want" }),
      briefBlock.querySelector("[data-ply-brief-setup]")!,
      within(briefBlock).getByRole("textbox", { name: "More detail (optional)" }),
    ];
    expect(follows(parts[0], parts[1]) && follows(parts[1], parts[2])).toBe(true);
    // One Brief, its parts in heading navigation (Challenger minor 2).
    expect(within(briefBlock).getAllByRole("heading").map((h) => [h.tagName, h.textContent])).toEqual([
      ["H2", "What you want"],
      ["H3", "More detail (optional)"],
    ]);
    // No plan written yet: no plan field.
    expect(within(briefBlock).queryByText("The plan (what the Builder follows)")).toBeNull();
    // The brief is on the page once.
    expect(screen.getAllByRole("region", { name: "Brief" })).toHaveLength(1);
  });

  // 1.174.0 (C1, P8): once built, the brief folds after the Activity —
  // What you asked, its first line, Show — and opens on Show.
  it("a card being built: the Brief is folded after the Activity with its first line, and has no setup sentence", async () => {
    open([
      boardCard("c1", {
        notes: "Add a dark mode",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        lastRunStatus: "running",
        builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
    const fold = screen.getByRole("button", { name: /^What you asked/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toBe("What you askedAdd a dark modeShow");
    expect(screen.queryByRole("region", { name: "Brief" })).toBeNull();
    expect(follows(region("Activity"), fold)).toBe(true);
    act(() => fold.click());
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(fold.textContent).toBe("What you askedHide");
    const briefBlock = region("Brief");
    expect(briefBlock.getAttribute("data-ply-card-brief-block")).toBe("");
    expect(follows(region("Activity"), briefBlock)).toBe(true);
    // The fold names it: no second "What you want" heading.
    expect(within(briefBlock).queryByRole("heading", { name: "What you want" })).toBeNull();
    expect(briefBlock.querySelector("[data-ply-brief-setup]")).toBeNull();
  });

  it("a done card with nothing in More detail shows no empty field (C1)", () => {
    open([boardCard("c1", { notes: "Add a dark mode", shipStatus: "shipped", columnId: "complete" })]);
    act(() => screen.getByRole("button", { name: /^What you asked/ }).click());
    expect(within(region("Brief")).queryByRole("textbox", { name: "More detail (optional)" })).toBeNull();
  });

  it("says who builds it, how it asks and who reviews it; Change… goes to the card's pickers", async () => {
    const { user } = open([boardCard("c1", { notes: "Add a dark mode" })]);
    const setup = region("Brief").querySelector<HTMLElement>("[data-ply-brief-setup]")!;
    expect(setup.textContent).toBe(
      "Claude builds it in a copy of your project, with its own permission setting; Codex reviews it. Change…" +
        // 1.176.3: what it uses, and that it can be undone — always shown.
        "It uses your own Claude and ChatGPT plans, the same allowance as when you use them yourself. Your project does not change until you ship the result. You can delete the card, and its copy once it has one, from its ⋯ menu.",
    );
    const change = within(setup).getByRole("button", { name: "Change…" });
    await user.click(change);
    // 1.175.0 F10: the card's one Change… — a disclosure; the pickers open
    // right under the sentence, and the focus stays on it.
    const pickers = await waitFor(() => document.querySelector("[data-ply-card-pickers]") as HTMLElement);
    expect(change.getAttribute("aria-expanded")).toBe("true");
    expect(follows(setup, pickers)).toBe(true);
    expect(pickers.closest('[aria-label="Brief"]')).toBeTruthy();
    expect(document.activeElement).toBe(change);
  });

  it("follows the card's own Permissions choice", () => {
    open([boardCard("c1", { notes: "Add a dark mode", builderPermissions: "editsCopy" } as Partial<KanbanCard>)]);
    expect(region("Brief").querySelector("[data-ply-brief-setup]")!.textContent).toMatch(
      /^Claude builds it in a copy of your project, changing files there without asking; Codex reviews it\./,
    );
  });

  it("a planned card: The plan (what the Builder follows) as text, Edit opens it, a blur saves it as edited", async () => {
    const view = open([
      boardCard("c1", { notes: "Add a dark mode", intakeStatus: "ready", dispatchPrompt: "1. Add a toggle\n2. Save it" }),
    ]);
    const briefBlock = region("Brief");
    const plan = briefBlock.querySelector<HTMLElement>("[data-ply-brief-plan]")!;
    expect(within(plan).getByRole("heading", { level: 3, name: "The plan (what the Builder follows)" })).toBeTruthy();
    expect(plan.querySelector(".ux-card-brief-plan")!.textContent).toBe("1. Add a toggle\n2. Save it");
    expect(within(plan).queryByRole("textbox")).toBeNull();
    // After What you want, before More detail.
    expect(follows(within(briefBlock).getByRole("textbox", { name: "What you want" }), plan)).toBe(true);
    expect(follows(plan, within(briefBlock).getByRole("textbox", { name: "More detail (optional)" }))).toBe(true);
    await view.user.click(within(plan).getByRole("button", { name: "Edit" }));
    const field = within(plan).getByRole("textbox", { name: "The plan (what the Builder follows)" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "1. Add a toggle" } });
    fireEvent.focusOut(field);
    await waitFor(() =>
      expect(
        view.tauri
          .callsOf("kanban_card_patch")
          .some((c) => (c.args.patch as Partial<KanbanCard>).dispatchPrompt === "1. Add a toggle"),
      ).toBe(true),
    );
    const calls = view.tauri.callsOf("kanban_card_patch");
    const patch = calls[calls.length - 1].args.patch as Partial<KanbanCard>;
    expect(typeof patch.dispatchPromptEditedAt).toBe("number");
    expect(within(plan).queryByRole("textbox")).toBeNull();
  });

  it("a planned card plans again from Plan it first ▾, not the ⋯", async () => {
    const { user } = open([
      boardCard("c1", { notes: "Add a dark mode", intakeStatus: "ready", dispatchPrompt: "1. Add a toggle" }),
    ]);
    await user.click(now().getByRole("button", { name: "Plan it first" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^Plan again with Claude/),
      expect.stringMatching(/^Plan with two AIs/),
    ]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More for this card" }));
    expect(screen.queryByRole("menuitem", { name: /Plan again/ })).toBeNull();
  });

  it("More detail is the card's longer notes, saved on blur", async () => {
    const view = open([boardCard("c1", { notes: "Add a dark mode", knowledge: "Staging is behind the VPN." })]);
    const more = within(region("Brief")).getByRole("textbox", { name: "More detail (optional)" }) as HTMLTextAreaElement;
    expect(more.value).toBe("Staging is behind the VPN.");
    fireEvent.change(more, { target: { value: "Staging is behind the VPN. Use the test login." } });
    fireEvent.focusOut(more);
    await waitFor(() =>
      expect(
        view.tauri
          .callsOf("kanban_card_patch")
          .some((c) => (c.args.patch as Partial<KanbanCard>).knowledge === "Staging is behind the VPN. Use the test login."),
      ).toBe(true),
    );
  });

  it("a done card's plan and More detail are read, not changed", () => {
    open([
      boardCard("c1", {
        notes: "Add a dark mode",
        knowledge: "Staging is behind the VPN.",
        dispatchPrompt: "1. Add a toggle",
        intakeStatus: "ready",
        shipStatus: "shipped",
        columnId: "complete",
      }),
    ]);
    act(() => screen.getByRole("button", { name: /^What you asked/ }).click());
    const briefBlock = region("Brief");
    expect(briefBlock.getAttribute("data-ply-card-brief-block")).toBe("");
    expect(within(briefBlock).queryByRole("button", { name: "Edit" })).toBeNull();
    expect((within(briefBlock).getByRole("textbox", { name: "More detail (optional)" }) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  // 1.174.0 (C1, Challenger 2): a press that asks for a built card's brief
  // shows it first, then puts the cursor in it.
  it("asked for on a built card, the folded brief opens and takes the cursor", async () => {
    const { focusNewCardBrief } = await import("../components/followUpFocus");
    focusNewCardBrief("c1");
    open([
      boardCard("c1", {
        notes: "Add a dark mode",
        columnId: "in_progress",
        worktreePath: "/tmp/wt/c1",
        lastRunStatus: "running",
        builder: { vendor: "claude", bypass: false, ptyId: "p1", sessionLost: false, startedAt: 1, snapshots: [] },
      } as Partial<KanbanCard>),
    ]);
    await waitFor(() => expect(document.activeElement).toBe(brief()));
    expect(screen.getByRole("button", { name: "What you asked, Hide" })).toBeTruthy();
  });

  it("a new card opened from the Board starts on What you want; another card opens on Now", async () => {
    const { focusNewCardBrief } = await import("../components/followUpFocus");
    focusNewCardBrief("c1");
    open([boardCard("c1", { title: "Add nod" }), boardCard("c2", { title: "Old" })]);
    await waitFor(() => expect(document.activeElement).toBe(brief()));
    act(() => useUi.getState().selectCard(BOARD_WS, "c2"));
    await waitFor(() => expect(document.activeElement).not.toBe(brief()));
    expect(document.activeElement?.closest("[aria-label='Now']")).not.toBeNull();
  });
});
