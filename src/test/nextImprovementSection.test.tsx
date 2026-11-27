// 1.173.0 (E3): Next improvement above the Board — every state (first use,
// running with Stop, the slate, nothing worth doing, an unreadable answer,
// one AI, the offer after a card shipped, All
// areas), the three presses and the IPC each makes, where focus goes, the
// direction sheet a refused start opens, the Inbox row's press, and the
// direction question opening by itself (E1's carried item).
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderUi, screen, waitFor, within } from "./render";
import { boardCard, BOARD_WS, seedBoard } from "./boardFixtures";
import { NextImprovementSection } from "../components/NextImprovementSection";
import { NiDirectionSheetHost } from "../components/NiDirectionSheet";
import { SettingConflictHost } from "../components/SettingConflictHost";
import type { NiDirectionView, NiIdea, NiRound, NiRoundView } from "../ipc";
import { emptyNiDirection } from "../ipc";
import { useNextImprovement, niKey } from "../store/nextImprovementStore";
import { useAccount } from "../store/accountStore";
import { useInbox } from "../store/inboxStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { onDirectionForConflicts, useSettingConflict } from "../store/settingConflictStore";
import { useAreas } from "../store/areaStore";
import { useToasts } from "../store/toastStore";
import { useSettings } from "../store/settingsStore";
import { skipChapter } from "../lib/tutorial/tutorialEngine";
import { useDoctor } from "../store/doctorStore";
import type { DoctorReport } from "../ipc";

/** A6 (D2c): a card shipped on this Mac, so Next improvement shows by itself. */
function shippedBefore() {
  useSettings.setState((s) => ({
    settings: { ...s.settings, nextImprovement: { view: {}, firstCardShippedAt: "2026-10-01T09:00:00.000Z" } },
  }));
}

function idea(id: string, patch: Partial<NiIdea> = {}): NiIdea {
  return {
    id,
    title: `Idea ${id}`,
    saw: `saw ${id}`,
    change: `change ${id}`,
    better: `better ${id}`,
    removes: `removes ${id}`,
    check: `check ${id}`,
    size: "S",
    risk: "low",
    sources: ["https://baymard.com/blog/pricing"],
    where: [`src/${id}.astro:10`],
    dismissed: false,
    ...patch,
  };
}

function round(patch: Partial<NiRound> = {}): NiRound {
  return {
    id: "r1",
    number: 1,
    status: "ready",
    startedAt: Date.now() - 20 * 60_000,
    endedAt: Date.now() - 12 * 60_000,
    areaName: "",
    approaches: ["simplify"],
    lookAt: "https://www.lyrappc.com",
    proposer: "claude",
    second: "codex",
    oneAi: false,
    folder: "",
    rejectedCount: 0,
    branch: "main",
    revision: "abc",
    phases: [],
    looked: { pages: ["a"], files: 2, browser: false, web: true },
    ideas: [idea("a"), idea("b")],
    setAside: [{ idea: idea("x", { title: "Exit-intent pop-up" }), reason: "you said no pop-ups", by: "secondOpinion" }],
    ...patch,
  };
}

function view(r: NiRound | null, byline: string | null = "Claude proposed, Codex gave a second opinion"): NiRoundView {
  return { workspaceId: BOARD_WS, area: "default", round: r, byline, elapsedMs: r?.status === "running" ? 4 * 60_000 : null };
}

function direction(patch: Partial<NiDirectionView> = {}): NiDirectionView {
  return {
    area: "default",
    areaName: "",
    path: ".atelier/next-improvement/default.json",
    shared: true,
    readOnly: false,
    readOnlyReason: null,
    notice: null,
    keptHere: null,
    exists: false,
    direction: emptyNiDirection(),
    draft: {
      direction: emptyNiDirection(),
      from: ["readme"],
      lookAt: null,
      audience: { text: "PPC agencies", source: "readme" },
    },
    lookAtHint: null,
    pending: null,
    problem: null,
    problemTechnical: null,
    ...patch,
  };
}

function render(fixtures: Record<string, unknown> = {}) {
  seedBoard([]);
  return renderUi(
    <>
      <NextImprovementSection workspaceId={BOARD_WS} />
      <NiDirectionSheetHost />
      <SettingConflictHost />
    </>,
    { fixtures },
  );
}

// Hidden, folded and offers answered are kept in this browser's storage.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // none
  }
  shippedBefore();
});

const section = () => screen.getByRole("region", { name: "Next improvement" });

function niRow(workspaceId: string, area: string) {
  return {
    id: `next-improvement:${workspaceId}:${area}:r1`,
    kind: "next_improvement_ideas" as const,
    // A5: the ideas row is News.
    group: "news" as const,
    workspaceId,
    workspaceName: "Lyra",
    cardId: null,
    runId: null,
    title: "Next improvement: 2 ideas",
    detail: null,
    url: null,
    at: 1,
    seenAt: 1,
    seenEligible: true,
  };
}

function twoAreas(held = false) {
  const area = (id: string, first: boolean) => ({
    id,
    name: id === "app" ? "App" : "Site",
    path: id,
    root: false,
    first,
    targetBranch: null,
    branch: "main",
    versionFiles: null,
    tagPrefix: "",
    label: `area:${id}`,
    lookAt: null,
  });
  return {
    shared: true,
    readOnly: false,
    defined: [],
    areas: [area("app", true), area("site", false)],
    workspaceBranch: "main",
    check: { errors: [], warnings: [] },
    problem: held ? "Two areas share a folder." : null,
    held,
  };
}

/** A4: an idea's row — its title, size and risk, the one action, Details. */
function ideaEl(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-ni-idea="${id}"]`)?.closest<HTMLElement>(".ux-row");
    if (!el) throw new Error(`no idea ${id}`);
    return el;
  });
}

/** A4: what opens under an idea's row — Details (Saw, Removes and the rest,
 *  with Change it… and Don't propose this…), a change under way. Opens Details first when asked to and it is closed. */
async function detailsEl(id: string, open?: { user: { click: (el: Element) => Promise<void> } }): Promise<HTMLElement> {
  const row = await ideaEl(id);
  const find = () => document.querySelector<HTMLElement>(`[data-ni-idea-details="${id}"]`);
  if (open && !find()?.querySelector("[data-ni-details]")) {
    await open.user.click(within(row).getByRole("button", { name: "Details" }));
  }
  return waitFor(() => {
    const el = find();
    if (!el) throw new Error(`no details for ${id}`);
    return el;
  });
}

describe("first use (scene 1 → A6: one line, board.html 5b)", () => {
  it("one line with the true promise; Direction… opens the direction, focus on its first field", async () => {
    const r = render({ ni_direction_get: direction() });
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    const s = section();
    expect(s.getAttribute("data-ply-tour")).toBe("board-next-improvement");
    expect(s.getAttribute("data-ni-state")).toBe("first-use");
    expect(
      within(s).getByText(
        "Claude reads the code and proposes only what it can show is worth doing — often one idea, sometimes none · a few minutes, uses your Claude plan",
      ),
    ).toBeTruthy();
    // One line: the head alone, Prepare proposals bordered, the others quiet.
    expect(s.querySelector(".ni-body")).toBeNull();
    expect(within(s).getAllByRole("button").map((b) => b.textContent)).toEqual(["Prepare proposals", "Direction…", "Hide"]);
    expect(within(s).getByRole("button", { name: "Direction…" }).className).toMatch(/cbtn--quiet/);
    expect(within(s).getByRole("button", { name: "Hide" }).className).toMatch(/cbtn--quiet/);
    expect(s.textContent).not.toMatch(/up to five|10 minutes|Check the direction first/);
    await r.user.click(screen.getByRole("button", { name: "Direction…" }));
    const sheet = await screen.findByRole("dialog", { name: "Direction for this project" });
    // What Plyloft read to help is said in the sheet, not in the line.
    expect(sheet.textContent).toMatch(/Plyloft read your README to help with the direction/);
    const first = within(sheet).getByRole("textbox", { name: "For whom" });
    await waitFor(() => expect(document.activeElement).toBe(first));
    // C9 (P14): For whom starts empty; the README's words are offered.
    expect((first as HTMLTextAreaElement).value).toBe("");
    expect(sheet.querySelector("[data-ni-audience-suggestion]")?.textContent).toMatch(/^Your README starts: “PPC agencies”/);
    // Nothing starts and nothing is saved until a press.
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
    expect(r.tauri.callsOf("ni_direction_save")).toHaveLength(0);
  });

  it("Hide hides it on this Mac until shown again; its toast says where it went, Show it brings it back (C7, §1c)", async () => {
    const r = render({ ni_direction_get: direction() });
    await r.user.click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    const toast = useToasts.getState().toasts.slice(-1)[0]!;
    expect(toast.title).toBe("Next improvement is in the Board's ⋯ menu.");
    expect(toast.action?.label).toBe("Show it");
    act(() => toast.action!.onClick());
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    act(() => useNextImprovement.getState().show(niKey(BOARD_WS, null)));
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
  });

  it("without a direction, Prepare proposals opens the direction first, to save and prepare", async () => {
    const r = render({
      ni_direction_get: direction(),
      ni_round_start: () => Promise.reject("Write the direction first: who it is for and what better means here."),
    });
    await r.user.click(await screen.findByRole("button", { name: "Prepare proposals" }));
    const sheet = await screen.findByRole("dialog", { name: "Direction for this project" });
    expect(within(sheet).getByRole("button", { name: "Save and prepare proposals" })).toBeTruthy();
  });
});

describe("A6 (D2c): shown by itself after this person's first shipped card", () => {
  const notShipped = () =>
    useSettings.setState((s) => ({ settings: { ...s.settings, nextImprovement: { view: {} } } }));

  it("before it: nothing on the Board, the round still read; ⋯'s openEarly shows the line", async () => {
    notShipped();
    const r = render({ ni_direction_get: direction() });
    await waitFor(() => expect(r.tauri.callsOf("ni_round_get")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    // Nothing is read for a section nobody sees.
    expect(r.tauri.callsOf("ni_direction_get")).toHaveLength(0);
    act(() => useNextImprovement.getState().openEarly(BOARD_WS, niKey(BOARD_WS, null)));
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
  });

  it("a round already there shows it, shipped or not", async () => {
    notShipped();
    render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
  });

  it("every idea answered: answered, with what became of them — never 0 ideas (board.html 5e)", async () => {
    render({
      ni_round_get: view(round({ ideas: [idea("a", { cardId: "c1" }), idea("b", { dismissed: true })] })),
      ni_direction_get: direction({ exists: true }),
    });
    expect(await screen.findByText("Next improvement · answered")).toBeTruthy();
    expect(screen.getByText("1 made a card, 1 not to propose again · 12 min ago")).toBeTruthy();
    expect(screen.queryByText(/0 ideas/)).toBeNull();
    // Round 1: the head says it. C7 (P12): Prepare new proposals is in the
    // head, bordered, and nowhere else.
    expect(screen.queryByText("Every idea of this round has its answer.")).toBeNull();
    const head = section().querySelector<HTMLElement>(".ni-head")!;
    expect(within(head).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "",
      "Prepare new proposals",
      "Direction…",
      "Hide",
    ]);
    expect(screen.getAllByRole("button", { name: "Prepare new proposals" })).toHaveLength(1);
    expect(within(head).getByRole("button", { name: "Prepare new proposals" }).className).not.toMatch(/cbtn--(quiet|accent)/);
  });

  it("the first-use line waits for the direction, so the AI's name never changes", async () => {
    let answer: (v: unknown) => void = () => {};
    render({
      ni_direction_get: () => new Promise((resolve) => (answer = resolve)),
    });
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    expect(screen.queryByText(/reads the code and proposes/)).toBeNull();
    await act(async () => answer(direction({ direction: { ...emptyNiDirection(), proposer: "codex" } })));
    expect(await screen.findByText(/^Codex reads the code and proposes only/)).toBeTruthy();
    expect(screen.queryByText(/^Claude reads the code/)).toBeNull();
  });

  it("the tour's base chapter fully skipped shows it too; End the tour early doesn't", async () => {
    notShipped();
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        onboarding: { ...s.settings.onboarding, tutorial: skipChapter(null, "base", "2026-10-31T09:00:00Z") },
      },
    }));
    const r = render({ ni_direction_get: direction() });
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    r.unmount();
    // End the tour on an early step: the base chapter isn't closed.
    useSettings.setState((s) => ({
      settings: {
        ...s.settings,
        onboarding: { ...s.settings.onboarding, tutorial: { endedAt: "2026-10-31T09:00:00Z", done: { "base.how-it-works": "t" } } },
      },
    }));
    render({ ni_direction_get: direction() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
  });

  it("with a direction, Prepare proposals starts a round: running, the phases, Stop", async () => {
    const running = round({
      status: "running",
      // Challenger 5: the minutes are since it started, not a snapshot.
      startedAt: Date.now() - 4 * 60_000 - 5_000,
      endedAt: null,
      ideas: [],
      setAside: [],
      phases: [
        { id: "look", state: "done", words: "Claude looked at 9 pages of www.lyrappc.com" },
        { id: "read", state: "now", words: "reading the code" },
        { id: "second", state: "todo", words: "a second opinion" },
      ],
    });
    const r = render({
      ni_direction_get: direction({ exists: true, draft: null, direction: { ...emptyNiDirection(), better: "x", approaches: ["fix"] } }),
      ni_round_start: view(running),
      ni_round_stop: null,
    });
    await r.user.click(await screen.findByRole("button", { name: "Prepare proposals" }));
    expect(r.tauri.callsOf("ni_round_start")[0].args).toEqual({ workspaceId: BOARD_WS, area: null });
    expect(await screen.findByText("Preparing proposals")).toBeTruthy();
    expect(screen.getByText("Simplify · 4 min")).toBeTruthy();
    expect(screen.getByText(/Claude looked at 9 pages of www\.lyrappc\.com/).textContent).toBe("Done · Claude looked at 9 pages of www.lyrappc.com");
    expect(screen.getByText(/reading the code/).textContent).toBe("Now · reading the code");
    expect(screen.queryByText(/a second opinion/)).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Stop" }));
    expect(r.tauri.callsOf("ni_round_stop")).toHaveLength(1);
  });

  it("a start refused for a missing direction opens the direction sheet, to save and prepare", async () => {
    const r = render({
      ni_direction_get: direction({ exists: true, draft: null }),
      ni_round_start: () => Promise.reject("Write the direction first: who it is for and what better means here."),
    });
    await r.user.click(await screen.findByRole("button", { name: "Prepare proposals" }));
    await waitFor(() => expect(useNextImprovement.getState().directionAsk).toEqual({ workspaceId: BOARD_WS, area: null, thenStart: true }));
    const sheet = await screen.findByRole("dialog", { name: "Direction for this project" });
    expect(within(sheet).getByRole("button", { name: "Save and prepare proposals" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("another refusal is said in the section, in the app's words", async () => {
    const r = render({
      ni_direction_get: direction({ exists: true, draft: null }),
      ni_round_start: () => Promise.reject("Plyloft runs at most 3 AI chats at once and they're all answering; try again when one finishes."),
    });
    await r.user.click(await screen.findByRole("button", { name: "Prepare proposals" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Plyloft runs at most 3 AI chats at once");
  });
});

describe("the slate (scene 4) and its presses (scene 5)", () => {
  it("C7 (§1), C15: the head is the chevron, the title, a short sub-line and bordered presses; nothing filled; a new round with ideas still waiting", async () => {
    render({ ni_round_get: view(round({ areaName: "Site" })), ni_direction_get: direction({ exists: true }) });
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
    const head = section().querySelector<HTMLElement>(".ni-head")!;
    // The head holds the title, "Site · 12 min ago" and three short presses;
    // that it fits one line at 1280 (and in Segoe on Windows) is checked in
    // the G3 walk — jsdom has no layout.
    expect(head.querySelector(".ni-sub")!.textContent).toBe("Site · 12 min ago");
    const buttons = within(head).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Collapse Next improvement",
      "Prepare new proposals",
      "Direction…",
      "Hide",
    ]);
    expect(buttons[0].getAttribute("aria-expanded")).toBe("true");
    for (const b of buttons.slice(1)) expect(b.className).not.toMatch(/cbtn--(quiet|accent|strong)/);
    expect(section().querySelector(".cbtn--accent")).toBeNull();
  });

  it("arrives by ni://progress: the ideas, Details open on the first, set aside by the second opinion", async () => {
    const r = render({ ni_direction_get: direction({ exists: true }) });
    await screen.findByText("Next improvement");
    act(() => r.tauri.emit("ni://progress", view(round())));
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
    // C7 (NI-6): the sub-line is short; the rest is under How it looked.
    expect(within(section().querySelector<HTMLElement>(".ni-head")!).getByText("12 min ago")).toBeTruthy();
    expect(section().querySelector(".ni-head")!.textContent).not.toMatch(/Simplify|second opinion/);
    const a = await ideaEl("a");
    const b = await ideaEl("b");
    // A4 (VC-11): one row per idea — the title, the size and risk as words,
    // Details and Make it a card; Change it… and Don't propose this… are
    // under Details, in a list with a height of its own.
    expect(document.querySelector("[data-ni-list] [data-ni-idea='a']")).not.toBeNull();
    expect(within(a).queryByRole("button", { name: "Change it…" })).toBeNull();
    expect(within(a).getByRole("button", { name: "Hide details" }).getAttribute("aria-expanded")).toBe("true");
    // Details: saw, removes, change, better because, how to check, sources
    // (links), where, and how it looked — never a screenshot.
    const aDetails = await detailsEl("a");
    const grid = aDetails.querySelector("[data-ni-details]")!;
    for (const term of ["Saw", "Removes", "Change", "Better because", "How to check", "Sources", "Where", "How it looked"]) {
      expect(within(grid as HTMLElement).getByText(term)).toBeTruthy();
    }
    expect(within(aDetails).getByRole("button", { name: "Change it…" })).toBeTruthy();
    expect(within(aDetails).getByRole("button", { name: "Don't propose this…" })).toBeTruthy();
    expect(within(grid as HTMLElement).getByRole("button", { name: "baymard.com/blog/pricing" }).getAttribute("title")).toBe(
      "https://baymard.com/blog/pricing",
    );
    expect(
      within(grid as HTMLElement).getByText("Simplify · read 1 page and the code · Claude proposed, Codex gave a second opinion"),
    ).toBeTruthy();
    expect(aDetails.querySelector("img")).toBeNull();
    expect(document.querySelector('[data-ni-idea-details="b"]')).toBeNull();
    await r.user.click(within(b).getByRole("button", { name: "Details" }));
    expect(document.querySelector('[data-ni-idea-details="b"] [data-ni-details]')).not.toBeNull();
    await r.user.click(within(b).getByRole("button", { name: "Hide details" }));
    expect(document.querySelector('[data-ni-idea-details="b"]')).toBeNull();
    expect(within(a).getByText("Small change · low risk")).toBeTruthy();
    const aside = screen.getByRole("button", { name: "Set aside by the second opinion (1)" });
    expect(aside.getAttribute("aria-expanded")).toBe("false");
    await r.user.click(aside);
    expect(screen.getByText("“Exit-intent pop-up” — you said no pop-ups")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Reviewer/);
  });

  it("Make it a card: a Not started card with the brief and evidence, in the round's area, then marked", async () => {
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      kanban_card_create: (args: Record<string, unknown>) =>
        boardCard(String(args.cardId), { title: String(args.title), notes: String(args.notes) }),
      ni_round_mark: (args: Record<string, unknown>) =>
        view(round({ ideas: [idea("a", { cardId: String(args.cardId) }), idea("b")] })),
    });
    const a = await ideaEl("a");
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    const create = r.tauri.callsOf("kanban_card_create")[0].args;
    expect(create.title).toBe("Idea a");
    expect(create.columnId).toBe("todo");
    expect(create.area).toBeNull();
    expect(String(create.notes)).toMatch(/^## Expected\n- change a/);
    expect(String(create.notes)).toContain("## Manual checks");
    expect(String(create.notes)).toContain("- Where: `src/a.astro:10`");
    await waitFor(() => expect(r.tauri.callsOf("ni_round_mark")).toHaveLength(1));
    expect(r.tauri.callsOf("ni_round_mark")[0].args).toMatchObject({ ideaId: "a", cardId: create.cardId, dismissed: false });
    expect(await within(a).findByRole("button", { name: "Open the card" })).toBeTruthy();
    expect(screen.getByText("Next improvement · 1 idea")).toBeTruthy();
  });

  it("on Free, with another card in progress, Make it a card makes it at once", async () => {
    useAccount.setState({ gates: { teamAllowed: false } as never });
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      kanban_card_create: (args: Record<string, unknown>) => boardCard(String(args.cardId), { title: String(args.title) }),
      ni_round_mark: view(round()),
    });
    // Another card in progress (render seeds an empty board first).
    act(() => seedBoard([boardCard("busy", { title: "Changelog for 1.173.0", columnId: "in_progress" })]));
    const a = await ideaEl("a");
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    await waitFor(() => expect(r.tauri.callsOf("kanban_card_create")).toHaveLength(1));
    expect(screen.queryByRole("group", { name: "Make “Idea a” a card?" })).toBeNull();
    expect(screen.queryByRole("button", { name: /with Pro/ })).toBeNull();
  });

  it("Change it…: a field (focused), then only that idea is rewritten; Cancel stops it", async () => {
    const changing = round({ status: "running", change: { ideaId: "b", comment: "Keep the video", startedAt: 1 } });
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      ni_round_change: view(changing),
      ni_round_stop: null,
    });
    const b = await ideaEl("b");
    const bDetails = await detailsEl("b", r);
    await r.user.click(within(bDetails).getByRole("button", { name: "Change it…" }));
    const field = within(bDetails).getByRole("textbox", { name: "How should it change?" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await r.user.type(field, "Keep the video");
    await r.user.click(within(bDetails).getByRole("button", { name: "Rewrite it" }));
    expect(r.tauri.callsOf("ni_round_change")[0].args).toEqual({
      workspaceId: BOARD_WS,
      area: "default",
      ideaId: "b",
      comment: "Keep the video",
    });
    expect(await within(await detailsEl("b")).findByText("Claude is rewriting this idea…")).toBeTruthy();
    // The other ideas stay, with their presses.
    const a = await ideaEl("a");
    expect(within(a).getByRole("button", { name: "Make it a card" })).toBeTruthy();
    await r.user.click(within(b).getByRole("button", { name: "Cancel" }));
    expect(r.tauri.callsOf("ni_round_stop")).toHaveLength(1);
  });

  it("Don't propose this…: a popover asks why (focused); the reason goes to the repository, the idea is marked", async () => {
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      ni_reject: direction({ exists: true }),
      ni_round_mark: view(round({ ideas: [idea("a", { dismissed: true }), idea("b")] })),
    });
    await r.user.click(within(await detailsEl("a")).getByRole("button", { name: "Don't propose this…" }));
    const pop = await screen.findByRole("dialog", { name: "Don't propose “Idea a” again?" });
    expect(pop.textContent).toContain("Why, in one line. Next improvement won't propose this, or anything like it, in this project.");
    const why = within(pop).getByRole("textbox", { name: "Why" });
    await waitFor(() => expect(document.activeElement).toBe(why));
    const confirm = within(pop).getByRole("button", { name: "Don't propose it" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await r.user.type(why, "No pop-ups on the site, ever.");
    await r.user.click(confirm);
    expect(r.tauri.callsOf("ni_reject")[0].args).toEqual({
      workspaceId: BOARD_WS,
      area: "default",
      idea: "Idea a",
      reason: "No pop-ups on the site, ever.",
    });
    await waitFor(() => expect(r.tauri.callsOf("ni_round_mark")[0]?.args).toMatchObject({ ideaId: "a", dismissed: true }));
    await waitFor(() => expect(document.querySelector('[data-ni-idea="a"]')).toBeNull());
    expect(screen.getByText("Next improvement · 1 idea")).toBeTruthy();
    // Challenger 10: focus goes to the next idea's title.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Idea b"));
  });
});

describe("the other moments (scene 6)", () => {
  it("nothing worth doing: nothing this time, a good answer, Prepare proposals again in its row (C7, §3); Direction… to change it", async () => {
    const r = render({
      ni_round_get: view(round({ status: "nothing", ideas: [] })),
      ni_direction_get: direction({ exists: true }),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [] })),
    });
    expect(await screen.findByText("Next improvement · nothing this time")).toBeTruthy();
    const head = section().querySelector<HTMLElement>(".ni-head")!;
    expect(within(head).getByText("12 min ago")).toBeTruthy();
    // The head doesn't repeat the row's press.
    expect(within(head).queryByRole("button", { name: "Prepare new proposals" })).toBeNull();
    expect(screen.getByText("Nothing worth changing right now")).toBeTruthy();
    expect(
      screen.getByText(/^That's a good answer: nothing in this project is worth a card right now\. Claude looked at 1 page and the code; the second opinion agreed\. The one idea it had is under “Set aside”\.$/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try another approach…" })).toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Direction…" }));
    expect(useNextImprovement.getState().directionAsk).toMatchObject({ workspaceId: BOARD_WS, thenStart: false });
    // 1.173.0 Windows walk → C7: folded with no ideas, the chevron says Show
    // Next improvement; Direction… and Hide stay.
    await r.user.click(screen.getByRole("button", { name: "Collapse Next improvement" }));
    expect(screen.getByRole("button", { name: "Show Next improvement" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Show Next improvement's ideas" })).toBeNull();
    expect(screen.getByRole("button", { name: "Direction…" })).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Show Next improvement" }));
    // C15 (§3): Prepare proposals again opens the same popover.
    await r.user.click(screen.getByRole("button", { name: "Prepare proposals again" }));
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
    const pop = screen.getByRole("dialog", { name: "Next round" });
    expect(within(pop).getByText("Only for this round: the direction stays as it is, nothing is saved or shared.")).toBeTruthy();
    await r.user.click(within(pop).getByRole("button", { name: "Prepare proposals" }));
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(1);
    r.tauri.allowUnhandled();
  });

  it("one AI: the byline says the same AI gave itself a second opinion", async () => {
    render({
      ni_round_get: view(
        round({ oneAi: true, second: "claude" }),
        "Claude proposed, then gave itself a second opinion in a separate pass · Codex isn't ready on this computer",
      ),
      ni_direction_get: direction({ exists: true }),
    });
    expect(await screen.findByText(/then gave itself a second opinion in a separate pass · Codex isn't ready on this computer/)).toBeTruthy();
  });

  it("an answer that couldn't be read: the raw text behind Details, and Prepare proposals again", async () => {
    render({
      ni_round_get: view(
        round({ status: "unreadable", ideas: [], unreadable: { stage: "proposer", raw: "{not json", problem: "Your answer wasn't the JSON object asked for" } }),
      ),
      ni_direction_get: direction({ exists: true }),
    });
    expect(await screen.findByText("Couldn't read the ideas this time")).toBeTruthy();
    expect(screen.getByText("{not json")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare proposals" })).toBeTruthy();
  });

  it("after a card from here shipped, with ideas still waiting: a line above the slate, its pull request's number; nothing starts by itself", async () => {
    const shippedRound = round({ ideas: [idea("a", { cardId: "c1" }), idea("b")] });
    const r = render({
      ni_round_get: view(shippedRound),
      ni_direction_get: direction({ exists: true }),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [] })),
    });
    act(() =>
      seedBoard([
        boardCard("c1", { title: "Idea a", columnId: "complete", shipStatus: "shipped", prUrl: "https://github.com/o/r/pull/382" }),
      ]),
    );
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-ni-shipped]");
      if (!el) throw new Error("no line");
      return el;
    });
    expect(line.textContent).toContain("“Idea a” shipped");
    expect(line.textContent).toContain("pull request #382 · it came from Next improvement");
    // The slate is still there, under the line. C15: the head offers a new
    // round (the idea still waiting stays); the line doesn't repeat it.
    expect(screen.getByText("Next improvement · 1 idea")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Prepare new proposals" })).toHaveLength(1);
    expect(within(line).queryByRole("button", { name: "Prepare new proposals" })).toBeNull();
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
    await r.user.click(within(line).getByRole("button", { name: "Not now" }));
    expect(document.querySelector("[data-ni-shipped]")).toBeNull();
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
  });

  it("after a card from here shipped, nothing else waiting: the offer is the section", async () => {
    const r = render({
      ni_round_get: view(round({ ideas: [idea("a", { cardId: "c1" })] })),
      ni_direction_get: direction({ exists: true }),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [] })),
    });
    act(() => seedBoard([boardCard("c1", { title: "Idea a", columnId: "complete", shipStatus: "shipped" })]));
    expect(await screen.findByText("“Idea a” shipped")).toBeTruthy();
    expect(section().getAttribute("data-ni-state")).toBe("shipped");
    await r.user.click(screen.getByRole("button", { name: "Prepare new proposals" }));
    await r.user.click(within(screen.getByRole("dialog", { name: "Next round" })).getByRole("button", { name: "Prepare proposals" }));
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(1);
  });

  it("a direction field waiting on a choice: Waiting for your choice, Choose… opens C3's question", async () => {
    const conflict = {
      field: "ni-default-better",
      label: "Next improvement · What “better” means here",
      theirs: "Clear pricing.",
      changedAt: 1_700_000_000,
      author: "bob",
      device: null,
      samePerson: false,
      thisComputer: false,
      difference: { list: false, theirs: "Clear pricing.", mine: "Fast on a phone.", both: [], different: [], onlyMine: [], onlyTheirs: [] },
    };
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({
        exists: true,
        pending: { state: "conflict", message: null, technical: null, pullRequest: null, conflicts: [conflict as never] },
      }),
      workspace_definition_get: { conflicts: [conflict] },
    });
    expect(await screen.findByText("Waiting for your choice")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(useSettingConflict.getState().open?.conflict.field).toBe("ni-default-better"));
  });

  it("All areas with two areas: one area at a time, and the areas to pick", async () => {
    const area = (id: string, first: boolean) => ({
      id,
      name: id === "app" ? "App" : "Site",
      path: id,
      root: false,
      first,
      targetBranch: null,
      branch: "main",
      versionFiles: null,
      tagPrefix: "",
      label: `area:${id}`,
      lookAt: null,
    });
    const r = render({
      areas_get: {
        shared: true,
        readOnly: false,
        defined: [],
        areas: [area("app", true), area("site", false)],
        workspaceBranch: "main",
        check: { errors: [], warnings: [] },
        problem: null,
        held: false,
      },
      ni_direction_get: direction({ area: "site", areaName: "Site" }),
      ni_round_get: (args: Record<string, unknown>) => ({ ...view(null), area: args.area }),
    });
    expect(await screen.findByText("Next improvement works on one area at a time. Pick one:")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Site" }));
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    expect(r.tauri.callsOf("ni_round_get").slice(-1)[0].args).toEqual({ workspaceId: BOARD_WS, area: "site" });
  });
});

describe("the Inbox row and the direction question", () => {
  it("Look at the ideas opens the Board on the section, shown again and unfolded, its heading focused", async () => {
    const r = render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    await screen.findByText("Next improvement · 2 ideas");
    await r.user.click(screen.getByRole("button", { name: "Collapse Next improvement" }));
    await r.user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    act(() => useInbox.getState().open(niRow(BOARD_WS, "default")));
    expect(useUi.getState().centerMode[BOARD_WS]).toBe("board");
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
    expect(document.querySelector('[data-ni-idea="a"]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Next improvement · 2 ideas"));
  });

  it("Look at the ideas on a cold workspace with two areas: the area is chosen before its areas are read, and the reveal lands", async () => {
    const areas = twoAreas();
    let answerAreas: (v: unknown) => void = () => {};
    const r = render({
      areas_get: () => new Promise((resolve) => (answerAreas = resolve)),
      ni_round_get: (args: Record<string, unknown>) => ({ ...view(round({ areaName: "Site" })), area: args.area ?? "default" }),
      ni_direction_get: direction({ area: "site", areaName: "Site", exists: true }),
    });
    act(() => useInbox.getState().open(niRow(BOARD_WS, "site")));
    expect(useAreas.getState().chosen[BOARD_WS]).toBe("site");
    act(() => answerAreas(areas));
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
    expect(r.tauri.callsOf("ni_round_get").slice(-1)[0].args).toEqual({ workspaceId: BOARD_WS, area: "site" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Next improvement · 2 ideas"));
    expect(useNextImprovement.getState().reveal).toBeNull();
  });

  it("a direction field held by a refresh opens C3's question by itself where the person is (E1's carried item)", async () => {
    const conflict = {
      field: "ni-site-better",
      label: "Next improvement · What “better” means here (Site)",
      theirs: "Clear pricing.",
      changedAt: 1_700_000_000,
      author: "bob",
      device: null,
      samePerson: false,
      thisComputer: false,
      difference: { list: false, theirs: "Clear pricing.", mine: "Fast on a phone.", both: [], different: [], onlyMine: [], onlyTheirs: [] },
    };
    renderUi(<SettingConflictHost />, { fixtures: { workspace_definition_get: { conflicts: [conflict] } } });
    act(() => useWorkspaces.setState({ activeId: BOARD_WS }));
    const focus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      // Another area's direction: not this question — nor an area whose id
      // only starts the same (Challenger 14: "site" vs "site-app").
      act(() => onDirectionForConflicts(BOARD_WS, "app"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(useSettingConflict.getState().open).toBeNull();
      act(() => onDirectionForConflicts(BOARD_WS, "sit"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(useSettingConflict.getState().open).toBeNull();
      act(() => onDirectionForConflicts(BOARD_WS, "site"));
      await waitFor(() => expect(useSettingConflict.getState().open?.conflict.field).toBe("ni-site-better"));
      // Asked once this session: closing it leaves the Inbox row.
      act(() => useSettingConflict.getState().close());
      act(() => onDirectionForConflicts(BOARD_WS, "site"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(useSettingConflict.getState().open).toBeNull();
    } finally {
      document.hasFocus = focus;
    }
  });
});

describe("Reviewer round 1", () => {
  it("a source opens in the browser (open_web_link), and says so when it can't", async () => {
    const r = render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }), open_web_link: null });
    const a = await detailsEl("a");
    await r.user.click(within(a).getByRole("button", { name: "baymard.com/blog/pricing" }));
    expect(r.tauri.callsOf("open_web_link")[0].args).toEqual({ url: "https://baymard.com/blog/pricing" });
    expect(a.querySelector("a")).toBeNull();
  });

  it("the chevron folds the slate to one line and opens it again; a new round opens unfolded", async () => {
    const r = render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    const fold = await screen.findByRole("button", { name: "Collapse Next improvement" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    await r.user.click(fold);
    expect(document.querySelector("[data-ni-idea]")).toBeNull();
    expect(screen.getByText("Next improvement · 2 ideas")).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show Next improvement's ideas" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    // C7 (§1b): folded, the head is one line — the chevron, the title and
    // the presses, Direction… and Hide still there; no word "Collapse".
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Direction…" })).toBeTruthy();
    expect(section().querySelector(".ni-head .ni-sub")).toBeNull();
    expect(section().textContent).not.toMatch(/Collapse|Show the ideas/);
    await r.user.click(show);
    expect(document.querySelector('[data-ni-idea="a"]')).not.toBeNull();
    await r.user.click(screen.getByRole("button", { name: "Collapse Next improvement" }));
    act(() => r.tauri.emit("ni://progress", view(round({ id: "r2" }))));
    expect(await ideaEl("a")).toBeTruthy();
  });

  it("held areas: nothing at all", async () => {
    const r = render({ areas_get: twoAreas(true) });
    await waitFor(() => expect(r.tauri.callsOf("areas_get").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    r.tauri.allowUnhandled();
  });

  it("each workspace keeps its own: A's problem doesn't follow to B, and A's progress doesn't touch B", async () => {
    seedBoard([]);
    const r = renderUi(<NextImprovementSection workspaceId="ws-a" />, {
      fixtures: {
        ni_round_get: (args: Record<string, unknown>) => ({ ...view(args.workspaceId === "ws-a" ? round() : null), workspaceId: args.workspaceId }),
        ni_direction_get: (args: Record<string, unknown>) => direction({ exists: true, areaName: String(args.workspaceId) }),
        ni_round_start: () => Promise.reject("Plyloft runs at most 3 AI chats at once and they're all answering; try again when one finishes."),
      },
    });
    const a = await ideaEl("a");
    expect(a).toBeTruthy();
    // A press that failed on A.
    act(() => r.tauri.emit("ni://progress", { ...view(round({ ideas: [] , status: "stopped", reason: "You stopped the round." })), workspaceId: "ws-a" }));
    await r.user.click(await screen.findByRole("button", { name: "Prepare proposals" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Plyloft runs at most 3 AI chats");
    r.rerender(<NextImprovementSection workspaceId="ws-b" />);
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(section().getAttribute("data-ni-state")).toBe("first-use");
    // A's round moving on reaches A's key only.
    act(() => r.tauri.emit("ni://progress", { ...view(round({ id: "r9" })), workspaceId: "ws-a" }));
    expect(section().getAttribute("data-ni-state")).toBe("first-use");
    expect(useNextImprovement.getState().rounds[niKey("ws-b", null)]?.round ?? null).toBeNull();
  });

  // E6: an unshared project keeps its direction on this computer.
  it("an unshared project: Don't propose this… works, kept on this computer", async () => {
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true, shared: false }),
      ni_reject: direction({ exists: true, shared: false }),
      ni_round_mark: view(round({ ideas: [idea("a", { dismissed: true }), idea("b")] })),
    });
    await r.user.click(within(await detailsEl("a")).getByRole("button", { name: "Don't propose this…" }));
    const pop = await screen.findByRole("dialog", { name: "Don't propose “Idea a” again?" });
    expect(pop.textContent).not.toContain("Share this project's setup");
    await r.user.type(within(pop).getByRole("textbox", { name: "Why" }), "Not us.");
    await r.user.click(within(pop).getByRole("button", { name: "Don't propose it" }));
    expect(r.tauri.callsOf("ni_reject")[0].args).toMatchObject({ idea: "Idea a", reason: "Not us." });
  });

  it("an unshared project on first use: no trip to Settings › Setup", async () => {
    render({ ni_direction_get: direction({ shared: false }) });
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    expect(screen.queryByText(/Share this project's setup|Settings › Setup/)).toBeNull();
  });

  it("a later notice for the same area is new once the last one was seen", async () => {
    const notice = "The repository already had a direction, so Plyloft uses it. The one kept on this Mac wasn't moved.";
    const r = render({ ni_direction_get: direction({ exists: true, notice }), ni_direction_notice_seen: null });
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_notice_seen")).toHaveLength(1));
    act(() => r.tauri.emit("ni://direction", { workspaceId: BOARD_WS, area: "default" }));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_notice_seen")).toHaveLength(2));
    // Said again (the toast store folds a repeat into one line, ×2).
    await waitFor(() => expect(useToasts.getState().recent.find((t) => t.body === notice)?.times).toBe(2));
  });

  it("the repository's direction kept over this computer's: said once, as a toast", async () => {
    const notice = "The repository already had a direction, so Plyloft uses it. The one kept on this Mac wasn't moved.";
    const r = render({ ni_direction_get: direction({ exists: true, notice }), ni_direction_notice_seen: null });
    await waitFor(() => expect(useToasts.getState().recent.filter((t) => t.body === notice)).toHaveLength(1));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_notice_seen")[0]?.args).toEqual({ workspaceId: BOARD_WS, area: "default" }));
  });

  it("a read-only computer: the popover says why and the button stays off", async () => {
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true, readOnly: true, readOnlyReason: "GitHub doesn't let this account push to the repository." }),
    });
    await r.user.click(within(await detailsEl("a")).getByRole("button", { name: "Don't propose this…" }));
    const pop = await screen.findByRole("dialog", { name: "Don't propose “Idea a” again?" });
    expect(pop.textContent).toContain("GitHub doesn't let this account push to the repository.");
    expect((within(pop).getByRole("button", { name: "Don't propose it" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("focus after Make it a card: Open the card", async () => {
    let marks = 0;
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      kanban_card_create: (args: Record<string, unknown>) => boardCard(String(args.cardId), { title: String(args.title) }),
      ni_reject: direction({ exists: true }),
      ni_round_mark: (args: Record<string, unknown>) => {
        marks += 1;
        return view(
          round({
            ideas: [idea("a", { cardId: args.cardId ? String(args.cardId) : null }), idea("b", { dismissed: !!args.dismissed && args.ideaId === "b" })],
          }),
        );
      },
    });
    const a = await ideaEl("a");
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open the card"));
    expect(marks).toBe(1);
  });

  it("a focus request lands once: a later progress event leaves focus in another idea's Change it… field", async () => {
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      kanban_card_create: (args: Record<string, unknown>) => boardCard(String(args.cardId), { title: String(args.title) }),
      ni_round_mark: (args: Record<string, unknown>) => view(round({ ideas: [idea("a", { cardId: String(args.cardId) }), idea("b")] })),
    });
    const a = await ideaEl("a");
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Open the card"));
    const b = await detailsEl("b", r);
    await r.user.click(within(b).getByRole("button", { name: "Change it…" }));
    const field = within(b).getByRole("textbox", { name: "How should it change?" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await r.user.type(field, "Keep");
    const cardId = String(r.tauri.callsOf("kanban_card_create")[0].args.cardId);
    act(() => r.tauri.emit("ni://progress", view(round({ ideas: [idea("a", { cardId }), idea("b")] }))));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(field);
    expect((field as HTMLTextAreaElement).value).toBe("Keep");
  });

  it("a mark that fails after the card is made: the next press marks it again, and no second card", async () => {
    let fail = true;
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      kanban_card_create: (args: Record<string, unknown>) => boardCard(String(args.cardId), { title: String(args.title) }),
      ni_round_mark: (args: Record<string, unknown>) => {
        if (fail) return Promise.reject("io error");
        return view(round({ ideas: [idea("a", { cardId: String(args.cardId) }), idea("b")] }));
      },
    });
    const a = await ideaEl("a");
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The card is made, but Plyloft couldn't note it on the idea.");
    fail = false;
    await r.user.click(within(a).getByRole("button", { name: "Make it a card" }));
    await within(a).findByRole("button", { name: "Open the card" });
    expect(r.tauri.callsOf("kanban_card_create")).toHaveLength(1);
    const marks = r.tauri.callsOf("ni_round_mark");
    expect(marks).toHaveLength(2);
    expect(marks[1].args.cardId).toBe(marks[0].args.cardId);
  });

  it("the direction is read once per area: not again on the next mount, again after ni://direction, not while hidden", async () => {
    const r = render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    await screen.findByText("Next improvement · 2 ideas");
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_get")).toHaveLength(1));
    r.rerender(<></>);
    r.rerender(<NextImprovementSection workspaceId={BOARD_WS} />);
    await screen.findByText("Next improvement · 2 ideas");
    expect(r.tauri.callsOf("ni_direction_get")).toHaveLength(1);
    await r.user.click(screen.getByRole("button", { name: "Hide" }));
    act(() => r.tauri.emit("ni://direction", { workspaceId: BOARD_WS, area: "default" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.tauri.callsOf("ni_direction_get")).toHaveLength(1);
    act(() => useNextImprovement.getState().show(niKey(BOARD_WS, null)));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_get")).toHaveLength(2));
  });
});

describe("A4: the slate has a height and folds by itself once seen", () => {
  const leaveBoard = async (r: { unmount: () => void }) => {
    r.unmount();
    // The section is told it was left once React is done (StrictMode safe).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };

  it("a new round opens once; after leaving the Board it opens folded; Show is remembered for the round", async () => {
    const fx = { ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) };
    const first = render(fx);
    await ideaEl("a");
    // While on the Board it stays open.
    await act(async () => {});
    expect(document.querySelector("[data-ni-list]")).not.toBeNull();
    await leaveBoard(first);

    const back = render(fx);
    const show = await screen.findByRole("button", { name: "Show Next improvement's ideas" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-ni-idea]")).toBeNull();
    expect(screen.getByText("Next improvement · 2 ideas")).toBeTruthy();
    await back.user.click(show);
    await ideaEl("a");
    await leaveBoard(back);

    // Show is remembered for that round.
    render(fx);
    await ideaEl("a");
    expect(screen.getByRole("button", { name: "Collapse Next improvement" })).toBeTruthy();
  });

  it("another workspace or area keeps its own; a round seen elsewhere doesn't fold this one", async () => {
    const key = niKey(BOARD_WS, null);
    act(() => useNextImprovement.setState({ slate: { [niKey(BOARD_WS, "site")]: { seenRound: "r1", collapsed: true } } }));
    render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    await ideaEl("a");
    expect(useNextImprovement.getState().slate[key]).toEqual({ seenRound: "r1", collapsed: null });
    expect(useNextImprovement.getState().slate[niKey(BOARD_WS, "site")]).toEqual({ seenRound: "r1", collapsed: true });
  });

  it("a card opened over the Board is leaving it: the slate is folded when the Board comes back", async () => {
    render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    await ideaEl("a");
    act(() => useUi.setState((s) => ({ selectedCardId: { ...s.selectedCardId, [BOARD_WS]: "card-1" } })));
    act(() => useUi.setState((s) => ({ selectedCardId: { ...s.selectedCardId, [BOARD_WS]: null } })));
    expect(await screen.findByRole("button", { name: "Show Next improvement's ideas" })).toBeTruthy();
  });

  it("is kept in this Mac's settings: the round seen, and Collapse or Show for it", async () => {
    const { useSettings } = await import("../store/settingsStore");
    const { DEFAULT_SETTINGS } = await import("../lib/settingsShape");
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      settings_set: ({ settings }: Record<string, unknown>) => settings,
    });
    await ideaEl("a");
    await waitFor(() => expect(r.tauri.callsOf("settings_set").length).toBeGreaterThan(0));
    const key = niKey(BOARD_WS, null);
    const sent = () => {
      const calls = r.tauri.callsOf("settings_set");
      return (calls[calls.length - 1].args.settings as typeof DEFAULT_SETTINGS).nextImprovement?.view?.[key];
    };
    expect(sent()).toEqual({ seenRound: "r1" });
    await r.user.click(screen.getByRole("button", { name: "Collapse Next improvement" }));
    await waitFor(() => expect(sent()).toEqual({ seenRound: "r1", collapsed: true }));
    // Read back on another launch (the session's copy gone): folded.
    r.unmount();
    act(() => useNextImprovement.setState({ slate: {}, openNow: {} }));
    render({ ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) });
    expect(await screen.findByRole("button", { name: "Show Next improvement's ideas" })).toBeTruthy();
  });

  it("round 1: a view kept before settings were read is saved once they are", async () => {
    const { useSettings } = await import("../store/settingsStore");
    const { DEFAULT_SETTINGS } = await import("../lib/settingsShape");
    const r = render({
      ni_round_get: view(round()),
      ni_direction_get: direction({ exists: true }),
      settings_set: ({ settings }: Record<string, unknown>) => settings,
    });
    await ideaEl("a");
    expect(r.tauri.callsOf("settings_set")).toHaveLength(0);
    act(() => useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true }));
    await waitFor(() => expect(r.tauri.callsOf("settings_set")).toHaveLength(1));
    const sent = r.tauri.callsOf("settings_set")[0].args.settings as typeof DEFAULT_SETTINGS;
    expect(sent.nextImprovement?.view?.[niKey(BOARD_WS, null)]).toEqual({ seenRound: "r1" });
  });

  it("behind another note (folded) it draws nothing, reads its round, and isn't seen", async () => {
    seedBoard([]);
    const r = renderUi(<NextImprovementSection workspaceId={BOARD_WS} folded />, {
      fixtures: { ni_round_get: view(round()), ni_direction_get: direction({ exists: true }) },
    });
    await waitFor(() => expect(r.tauri.callsOf("ni_round_get")).toHaveLength(1));
    await waitFor(() => expect(useNextImprovement.getState().rounds[niKey(BOARD_WS, null)]?.round?.id).toBe("r1"));
    expect(screen.queryByRole("region", { name: "Next improvement" })).toBeNull();
    expect(useNextImprovement.getState().slate[niKey(BOARD_WS, null)]).toBeUndefined();
    r.rerender(<NextImprovementSection workspaceId={BOARD_WS} />);
    expect(await ideaEl("a")).toBeTruthy();
  });
});

// ── 1.174.0 C15 (NIW-4, P12): another round, an approach for it alone ──

describe("C15: Prepare new proposals with ideas still waiting", () => {
  const withDirection = () =>
    direction({ exists: true, direction: { ...emptyNiDirection(), better: "b", approaches: ["simplify"], proposer: "claude" } });

  it("§2c: the popover starts from the direction, focus on Prepare proposals, Esc closes it, nothing saved", async () => {
    const r = render({
      ni_round_get: view(round({ areaName: "Site", ideas: [idea("a")] })),
      ni_direction_get: withDirection(),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [idea("a", { carriedFrom: 1 })] })),
    });
    expect(await screen.findByText("Next improvement · 1 idea")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "Prepare new proposals" });
    await r.user.click(trigger);
    const pop = screen.getByRole("dialog", { name: "Next round" });
    // Preselected from the direction.
    const box = (a: string) => pop.querySelector<HTMLInputElement>(`[data-ni-round-approach="${a}"] input`)!;
    expect([box("polish").checked, box("simplify").checked, box("grow").checked, box("fix").checked]).toEqual([false, true, false, false]);
    expect(within(pop).getByText("Take things away. Each idea must remove more than it adds.")).toBeTruthy();
    expect(pop.querySelector("[data-ni-round-who]")!.textContent).toBe("Claude proposes, Codex gives a second opinion · Change…");
    expect(
      within(pop).getByText("Only for this round: the direction stays as it is, nothing is saved or shared. The open idea stays below."),
    ).toBeTruthy();
    expect(document.activeElement).toBe(within(pop).getByRole("button", { name: "Prepare proposals" }));
    await r.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Next round" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
    // Polish, Codex proposing: for this round only.
    await r.user.click(trigger);
    const again = screen.getByRole("dialog", { name: "Next round" });
    await r.user.click(again.querySelector<HTMLInputElement>('[data-ni-round-approach="polish"] input')!);
    await r.user.click(again.querySelector<HTMLInputElement>('[data-ni-round-approach="simplify"] input')!);
    await r.user.click(within(again).getByRole("button", { name: "Change…" }));
    expect(again.querySelector("[data-ni-round-who]")!.textContent).toBe("Codex proposes, Claude gives a second opinion · Change…");
    await r.user.click(within(again).getByRole("button", { name: "Prepare proposals" }));
    expect(r.tauri.callsOf("ni_round_start")[0].args).toEqual({
      workspaceId: BOARD_WS,
      area: null,
      approaches: ["polish"],
      proposer: "codex",
    });
    // Nothing of the direction is written for a round.
    expect(r.tauri.callsOf("ni_direction_save")).toHaveLength(0);
  });

  it("§2: while it runs, the last round's idea stays below with its line, and can still be made a card", async () => {
    const running = round({
      id: "r2",
      number: 2,
      status: "running",
      endedAt: null,
      areaName: "Site",
      phases: [{ id: "read", state: "now", words: "Reading site/" }],
      ideas: [idea("a", { carriedFrom: 1 }), idea("b", { carriedFrom: 1 })],
    });
    const r = render({ ni_round_get: view(running), ni_direction_get: withDirection() });
    expect(await screen.findByText("Preparing proposals for Site")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText("The 2 ideas from the last round stay below until you answer them.")).toBeTruthy();
    const a = await ideaEl("a");
    expect(within(a).getByText("From the last round")).toBeTruthy();
    expect((within(a).getByRole("button", { name: "Make it a card" }) as HTMLButtonElement).disabled).toBe(false);
    // No Change it… while the round runs.
    const details = await detailsEl("a", r);
    expect(within(details).queryByRole("button", { name: "Change it…" })).toBeNull();
    expect(within(details).getByRole("button", { name: "Don't propose this…" })).toBeTruthy();
  });

  it("after: the sub-line says the approach chosen for that round; the carried idea is marked", async () => {
    render({
      ni_round_get: view(
        round({
          areaName: "Site",
          endedAt: Date.now() - 5_000,
          approaches: ["polish"],
          approachesOverride: ["polish"],
          ideas: [idea("n"), idea("a", { carriedFrom: 1 })],
        }),
      ),
      ni_direction_get: withDirection(),
    });
    expect(await screen.findByText("Next improvement · 2 ideas")).toBeTruthy();
    expect(section().querySelector(".ni-head .ni-sub")!.textContent).toBe("Site · Polish, this round · just now");
    expect(within(await ideaEl("a")).getByText("From the last round")).toBeTruthy();
    expect(within(await ideaEl("n")).queryByText("From the last round")).toBeNull();
  });
});

// ── 1.174.0 C8 (P13): what is already a card ──

describe("C8: an idea that repeats a card", () => {
  it("§2: the round says it read the cards already planned", async () => {
    const running = round({
      id: "r2",
      status: "running",
      endedAt: null,
      areaName: "Site",
      ideas: [],
      plannedCount: 3,
      phases: [
        { id: "read", state: "done", words: "Read site/" },
        { id: "planned", state: "done", words: "read the 3 cards already planned for Site, so it won't propose them again" },
        { id: "second", state: "now", words: "Codex is giving a second opinion on 2 ideas" },
      ],
    });
    render({ ni_round_get: view(running), ni_direction_get: direction({ exists: true }) });
    expect(await screen.findByText(/read the 3 cards already planned for Site, so it won't propose them again/)).toBeTruthy();
  });

  it("§2b: Set aside names the card, and its title opens it", async () => {
    const repeat = {
      idea: idea("v", { title: "Pricing page: add the viewport tag the home page already has" }),
      reason: "already a card: Pricing page: add the viewport line the home page already has",
      by: "check" as const,
      card: { id: "c7", title: "Pricing page: add the viewport line the home page already has" },
    };
    const r = render({
      ni_round_get: view(round({ ideas: [idea("a")], setAside: [repeat, round().setAside[0]] })),
      ni_direction_get: direction({ exists: true }),
    });
    act(() => seedBoard([boardCard("c7", { title: "Pricing page: add the viewport line the home page already has" })]));
    await r.user.click(await screen.findByRole("button", { name: "Set aside (2)" }));
    const line = document.querySelector<HTMLElement>('[data-ni-set-aside-card="c7"]')!;
    expect(line.textContent).toBe(
      "“Pricing page: add the viewport tag the home page already has” — already a card: Pricing page: add the viewport line the home page already has · by Plyloft's check",
    );
    await r.user.click(within(line).getByRole("button", { name: "Pricing page: add the viewport line the home page already has" }));
    expect(useUi.getState().selectedCardId[BOARD_WS]).toBe("c7");
  });

  it("§2b: a card no longer on the Board is named without a link", async () => {
    const repeat = {
      idea: idea("v", { title: "Viewport tag" }),
      reason: "already a card: Viewport line",
      by: "check" as const,
      card: { id: "gone", title: "Viewport line" },
    };
    const r = render({
      ni_round_get: view(round({ ideas: [idea("a")], setAside: [repeat] })),
      ni_direction_get: direction({ exists: true }),
    });
    await r.user.click(await screen.findByRole("button", { name: "Set aside (1)" }));
    expect(screen.getByText("“Viewport tag” — already a card: Viewport line · by Plyloft's check")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Viewport line" })).toBeNull();
  });
});

describe("C15 round 1", () => {
  it("one AI ready: the popover says the same AI twice, with no Change…; nothing ticked, no start", async () => {
    useDoctor.setState({
      report: { tools: [{ id: "claude", found: true }, { id: "codex", found: false }] } as unknown as DoctorReport,
    });
    const r = render({
      ni_round_get: view(round({ ideas: [idea("a")] })),
      ni_direction_get: direction({ exists: true, direction: { ...emptyNiDirection(), better: "b", approaches: ["fix"], proposer: "codex" } }),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [] })),
    });
    await r.user.click(await screen.findByRole("button", { name: "Prepare new proposals" }));
    const pop = screen.getByRole("dialog", { name: "Next round" });
    expect(pop.querySelector("[data-ni-round-who]")!.textContent).toBe("Claude · then Claude again, in a separate session");
    expect(within(pop).queryByRole("button", { name: "Change…" })).toBeNull();
    await r.user.click(pop.querySelector<HTMLInputElement>('[data-ni-round-approach="fix"] input')!);
    const go = within(pop).getByRole("button", { name: "Prepare proposals" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await r.user.click(pop.querySelector<HTMLInputElement>('[data-ni-round-approach="grow"] input')!);
    await r.user.click(go);
    expect(r.tauri.callsOf("ni_round_start")[0].args).toEqual({ workspaceId: BOARD_WS, area: null, approaches: ["grow"], proposer: "claude" });
    useDoctor.setState({ report: null });
  });

  it("a round that ended early is tried again with its own choice", async () => {
    const r = render({
      ni_round_get: view(
        round({ status: "failed", ideas: [], reason: "x", approachesOverride: ["polish"], proposerOverride: "codex" }),
      ),
      ni_direction_get: direction({ exists: true }),
      ni_round_start: view(round({ id: "r2", status: "running", ideas: [] })),
    });
    expect(await screen.findByText("The round didn't finish")).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Prepare proposals" }));
    expect(r.tauri.callsOf("ni_round_start")[0].args).toEqual({ workspaceId: BOARD_WS, area: null, approaches: ["polish"], proposer: "codex" });
  });
});

// 1.174.0 (C11, P15; next-improvement.html §5b): Start fresh was chosen —
// the area's first time offers the direction written before the areas.
describe("C11: a direction written before the areas", () => {
  const project = { ...emptyNiDirection(), audience: "PPC agencies", better: "They start a trial.", approaches: ["polish"] };
  const site = (patch: Partial<NiDirectionView> = {}) =>
    direction({ area: "site", areaName: "Site", path: ".atelier/next-improvement/site.json", beforeAreas: project, ...patch });

  it("the area's first time says so: Use it for Site copies it here, Check the direction first… opens it", async () => {
    const r = render({ ni_direction_get: site(), ni_direction_adopt_project: () => ["site"] });
    expect(await screen.findByText("You wrote a direction before this project had areas.")).toBeTruthy();
    const s = section();
    expect(s.getAttribute("data-ni-state")).toBe("before-areas");
    // A6's one line, with the sentence (§5b): no Prepare proposals.
    expect(s.querySelector(".ni-body")).toBeNull();
    expect(within(s).getAllByRole("button").map((b) => b.textContent)).toEqual(["Use it for Site", "Check the direction first…", "Hide"]);
    expect(within(s).getByRole("button", { name: "Check the direction first…" }).className).not.toMatch(/cbtn--quiet/);
    expect(s.textContent).not.toMatch(/default/i);
    expect(s.querySelectorAll(".cbtn--accent")).toHaveLength(0);
    await r.user.click(within(s).getByRole("button", { name: "Check the direction first…" }));
    const sheet = await screen.findByRole("dialog", { name: /Site/ });
    await waitFor(() => expect((within(sheet).getByRole("textbox", { name: "For whom" }) as HTMLTextAreaElement).value).toBe("PPC agencies"));
    await r.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await r.user.click(within(section()).getByRole("button", { name: "Use it for Site" }));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_adopt_project")).toHaveLength(1));
    expect(r.tauri.callsOf("ni_direction_adopt_project")[0].args).toEqual({ workspaceId: BOARD_WS, areas: ["site"], direction: null });
  });

  it("Check the direction first… then Save: this area's copy, as checked, with the list from before", async () => {
    const r = render({ ni_direction_get: site(), ni_direction_adopt_project: () => ["site"] });
    await r.user.click(await screen.findByRole("button", { name: "Check the direction first…" }));
    const sheet = await screen.findByRole("dialog", { name: /Site/ });
    const who = within(sheet).getByRole("textbox", { name: "For whom" }) as HTMLTextAreaElement;
    await waitFor(() => expect(who.value).toBe("PPC agencies"));
    // Round 3: nothing of the README is offered while checking it.
    expect(sheet.textContent).not.toMatch(/README/);
    await r.user.clear(who);
    await r.user.type(who, "Agencies on the site");
    await r.user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_adopt_project")).toHaveLength(1));
    const args = r.tauri.callsOf("ni_direction_adopt_project")[0].args as { areas: string[]; direction: { audience: string; better: string } };
    expect(args.areas).toEqual(["site"]);
    expect(args.direction.audience).toBe("Agencies on the site");
    expect(args.direction.better).toBe("They start a trial.");
    expect(r.tauri.callsOf("ni_direction_save")).toHaveLength(0);
  });

  it("an area with its own direction, or no direction from before: the usual first time", async () => {
    render({ ni_direction_get: site({ beforeAreas: null }) });
    expect(await screen.findByRole("button", { name: "Prepare proposals" })).toBeTruthy();
    expect(screen.queryByText("You wrote a direction before this project had areas.")).toBeNull();
  });
});
