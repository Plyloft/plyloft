// Skills hub H8 (R5): Copy to… — the destination picker, the sentence that
// says who gets what and when (R18.4), one card per workspace picked, a
// destination refused with its reason, and H6b's sheet first for a copy that
// brings a script.
import { describe, expect, it } from "vitest";
import { CopyToFlow, cardToOpen, createLabel, madeWords } from "../components/allSkills/CopyToFlow";
import type { CopyFrom, CopyMade, CopyTargets, KanbanCard, ScriptsReview } from "../ipc";
import { useToasts } from "../store/toastStore";
import { useAllSkills, openCopyTo, closeCopyTo } from "../store/allSkillsStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, fireEvent, renderUi, screen, waitFor } from "./render";

const FROM: CopyFrom = { kind: "workspace", workspaceId: "astra", skill: "deploy-notes" };

const TARGETS: CopyTargets = {
  skill: "deploy-notes",
  fromWords: "Astra",
  claude: true,
  codex: true,
  cardTitle: "Skill: copy deploy-notes from Astra",
  localReason: null,
  uncommittedNote: null,
  targets: [
    { workspaceId: "lyra", name: "Lyra", repo: "acme/lyra", target: { kind: "ready" } },
    { workspaceId: "vega", name: "Vega", repo: "acme/vega", target: { kind: "replace" } },
    { workspaceId: "orion", name: "Orion", repo: "acme/orion", target: { kind: "refused", why: "Orion already has it, linked to Astra." } },
    { workspaceId: "astra2", name: "astra-2", repo: "acme/astra", target: { kind: "refused", why: "astra-2 is the same repository as Astra." } },
  ],
};

function card(id: string, title = "Skill: copy deploy-notes from Astra"): KanbanCard {
  return {
    id,
    workspaceId: id,
    title,
    kind: { type: "skill", verb: "copy", skill: "deploy-notes", origin: { kind: "workspace", source: "acme/astra", name: "deploy-notes", version: { commit: "c", contentId: "v" } } },
  } as unknown as KanbanCard;
}

const MADE: CopyMade = {
  cards: [
    { workspaceId: "lyra", name: "Lyra", card: card("lyra") },
    { workspaceId: "vega", name: "Vega", card: card("vega") },
  ],
  refused: [],
};

const SCRIPT: ScriptsReview = {
  skill: "deploy-notes",
  plugin: "",
  commit: "c".repeat(40),
  scriptsIds: ["s-1"],
  firstTime: true,
  approvedAt: null,
  author: null,
  files: [
    { path: "scripts/check.sh", kind: "script", executable: true, size: 20, change: "new", text: "#!/bin/sh\n", tooLarge: false, copies: [] },
    { path: "SKILL.md", kind: "text", executable: false, size: 40, change: "new", text: "---\n", tooLarge: false, copies: [] },
  ],
};

const INDEX_VIEW = {
  index: { schemaVersion: 1, builtAt: null, workspaces: [], team: null, thisMac: null, plyloft: null },
  refreshing: false,
  reading: [],
};

function box(name: RegExp): HTMLInputElement {
  return screen.getByRole("checkbox", { name }) as HTMLInputElement;
}

describe("Copy to…", () => {
  it("lists every other workspace with what a copy there would do, and says who gets what once each card ships", async () => {
    let closed = 0;
    const { tauri } = renderUi(<CopyToFlow from={FROM} onClose={() => (closed += 1)} />, {
      fixtures: {
        skills_hub_copy_targets: TARGETS,
        skills_hub_copy_review: null,
        skills_hub_copy_to: MADE,
        skills_hub_index: INDEX_VIEW,
        skills_hub_index_refresh: null,
      },
      withToasts: true,
    });
    await screen.findByRole("heading", { name: /Copy deploy-notes to/ });
    expect(tauri.callsOf("skills_hub_copy_targets")[0]?.args).toEqual({ from: FROM });
    expect(document.body.textContent).toContain("Doesn't have it yet.");
    expect(document.body.textContent).toContain("Has a different deploy-notes. Its card would replace it and link it.");
    // R5 AC 4 and the Challenger edge: refused with the reason, never pickable.
    expect(box(/Orion/).disabled).toBe(true);
    expect(document.body.textContent).toContain("Orion already has it, linked to Astra.");
    expect(box(/astra-2/).disabled).toBe(true);
    expect(document.body.textContent).toContain("astra-2 is the same repository as Astra.");
    const create = () => screen.getByRole("button", { name: /^Create|Making/ }) as HTMLButtonElement;
    expect(create().disabled).toBe(true);

    await act(async () => fireEvent.click(box(/Lyra/)));
    // R5 AC 3: the sentence names who, which CLIs and when.
    expect(document.body.textContent).toContain(
      "Lyra gets deploy-notes for Claude and Codex once card “Skill: copy deploy-notes from Astra” ships. Everyone who opens acme/lyra gets it from then on; sessions already open keep what they have.",
    );
    await act(async () => fireEvent.click(box(/Vega/)));
    expect(document.body.textContent).toContain("Lyra and Vega each get a card “Skill: copy deploy-notes from Astra”.");
    expect(create().textContent).toBe("Create 2 cards");

    await act(async () => fireEvent.click(create()));
    await waitFor(() => expect(tauri.callsOf("skills_hub_copy_to")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_copy_to")[0]?.args).toEqual({
      from: FROM,
      workspaceIds: ["lyra", "vega"],
      replace: ["vega"],
    });
    await waitFor(() => expect(closed).toBe(1));
    const toast = useToasts.getState().toasts[0];
    expect(toast?.title).toBe("2 cards made");
    expect(toast?.action?.label).toBe("Open Lyra");
    // Windows walk: only the workspaces it touched are read again.
    await waitFor(() => expect(tauri.callsOf("skills_hub_index_refresh")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_index_refresh")[0]?.args).toMatchObject({ workspaceIds: ["lyra", "vega"] });
  });

  it("shows the scripts sheet first for a copy that brings a script, and copies with its OK", async () => {
    const { tauri } = renderUi(<CopyToFlow from={FROM} onClose={() => {}} />, {
      fixtures: { skills_hub_copy_targets: TARGETS, skills_hub_copy_review: SCRIPT, skills_hub_copy_to: MADE, skills_hub_index: INDEX_VIEW, skills_hub_index_refresh: null },
    });
    await screen.findByRole("heading", { name: /Copy deploy-notes to/ });
    await act(async () => fireEvent.click(box(/Lyra/)));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create 1 card" })));
    await screen.findByRole("heading", { name: /brings a script/ });
    expect(tauri.callsOf("skills_hub_copy_to")).toHaveLength(0);
    expect(document.body.textContent).toContain("Copying puts these files in Lyra through a card, a script among them.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "OK, copy" })));
    await waitFor(() => expect(tauri.callsOf("skills_hub_copy_to")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_copy_to")[0]?.args).toMatchObject({ workspaceIds: ["lyra"], scriptsOk: ["s-1"] });
  });

  it("says when the link stays on this Mac, and when the origin has uncommitted changes", async () => {
    renderUi(<CopyToFlow from={FROM} onClose={() => {}} />, {
      fixtures: {
        skills_hub_copy_targets: {
          ...TARGETS,
          localReason: "The link is kept on this Mac only: Notes has no GitHub repository a committed link could name.",
          uncommittedNote: "Astra's copy has changes that aren't committed; the copy takes the committed version.",
        },
      },
    });
    await screen.findByRole("heading", { name: /Copy deploy-notes to/ });
    expect(document.body.textContent).toContain("has no GitHub repository a committed link could name.");
    expect(document.body.textContent).toContain("the copy takes the committed version");
  });

  it("names every card it made and every workspace it couldn't, in one toast", () => {
    expect(createLabel(1)).toBe("Create 1 card");
    const one = madeWords({ cards: [MADE.cards[0]], refused: [{ workspaceId: "x", name: "Vega", why: "Vega isn't a git repository." }] });
    expect(one.title).toBe("Card made in Lyra: Skill: copy deploy-notes from Astra");
    expect(one.body).toContain("Not in Vega: Vega isn't a git repository.");
  });

  it("links at once, with no card, a workspace that already has the copy when the link stays on this Mac", async () => {
    let closed = 0;
    const local: CopyTargets = {
      ...TARGETS,
      fromWords: "Notes",
      cardTitle: "Skill: copy deploy-notes from Notes",
      localReason: "The link is kept on this Mac only: Notes has no GitHub repository a committed link could name.",
      targets: [
        { workspaceId: "lyra", name: "Lyra", repo: null, target: { kind: "linkHere" } },
        { workspaceId: "vega", name: "Vega", repo: null, target: { kind: "ready" } },
      ],
    };
    const made: CopyMade = { cards: [], refused: [], linked: [{ workspaceId: "lyra", name: "Lyra" }] };
    const { tauri } = renderUi(<CopyToFlow from={FROM} onClose={() => (closed += 1)} />, {
      fixtures: { skills_hub_copy_targets: local, skills_hub_copy_review: null, skills_hub_copy_to: made, skills_hub_index: INDEX_VIEW, skills_hub_index_refresh: null },
      withToasts: true,
    });
    await screen.findByRole("checkbox", { name: /Lyra/ });
    expect(document.body.textContent).toMatch(/It is linked to Notes on this (Mac|PC) at once: no card needed\./);
    await act(async () => fireEvent.click(box(/Lyra/)));
    expect(document.body.textContent).toContain("Lyra is linked at once: it has this version already.");
    expect(document.body.textContent).not.toContain("once card");
    const button = screen.getByRole("button", { name: "Link it" });
    await act(async () => fireEvent.click(box(/Vega/)));
    expect(button.textContent).toBe("Create 1 card");
    expect(document.body.textContent).toContain("Vega gets deploy-notes");
    await act(async () => fireEvent.click(box(/Vega/)));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Link it" })));
    await waitFor(() => expect(closed).toBe(1));
    expect(tauri.callsOf("skills_hub_copy_to")[0]?.args).toMatchObject({ workspaceIds: ["lyra"] });
    expect(useToasts.getState().toasts[0]?.title).toBe("Linked in Lyra");
  });

  it("Esc closes the scripts sheet first, then the picker, wherever the keyboard is", async () => {
    let closed = 0;
    renderUi(<CopyToFlow from={FROM} onClose={() => (closed += 1)} />, {
      fixtures: { skills_hub_copy_targets: TARGETS, skills_hub_copy_review: SCRIPT, skills_hub_copy_to: MADE, skills_hub_index: INDEX_VIEW, skills_hub_index_refresh: null },
    });
    await screen.findByRole("checkbox", { name: /Lyra/ });
    await act(async () => fireEvent.click(box(/Lyra/)));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create 1 card" })));
    await screen.findByRole("heading", { name: /brings a script/ });
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await screen.findByRole("heading", { name: /Copy deploy-notes to/ });
    expect(closed).toBe(0);
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(closed).toBe(1);
  });

  it("follows the pick order, and the toast opens a warm workspace before a cold one (Mac walk)", async () => {
    const { tauri } = renderUi(<CopyToFlow from={FROM} onClose={() => {}} />, {
      fixtures: { skills_hub_copy_targets: TARGETS, skills_hub_copy_review: null, skills_hub_copy_to: MADE, skills_hub_index: INDEX_VIEW, skills_hub_index_refresh: null },
    });
    // The heading is there before the list: wait for the list itself.
    await screen.findByRole("checkbox", { name: /Vega/ });
    await act(async () => fireEvent.click(box(/Vega/)));
    await act(async () => fireEvent.click(box(/Lyra/)));
    expect(document.body.textContent).toContain("Vega and Lyra each get a card");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create 2 cards" })));
    await waitFor(() => expect(tauri.callsOf("skills_hub_copy_to")).toHaveLength(1));
    expect(tauri.callsOf("skills_hub_copy_to")[0]?.args).toMatchObject({ workspaceIds: ["vega", "lyra"] });
    const made: CopyMade = { cards: [{ workspaceId: "vega", name: "Vega", card: card("vega") }, { workspaceId: "lyra", name: "Lyra", card: card("lyra") }], refused: [] };
    expect(cardToOpen(made, (id) => id === "lyra")?.name).toBe("Lyra");
    expect(cardToOpen(made, () => false)?.name).toBe("Vega");
    expect(madeWords(made).body).toBe("Vega, Lyra each have a card to ship.");
  });

  it("tells two workspaces of one name apart by their path (Windows walk)", async () => {
    useWorkspaces.setState({
      workspaces: [
        { id: "g1", name: "ghpr", cwd: "C:\\ply-test\\a\\ghpr" },
        { id: "g2", name: "ghpr", cwd: "C:\\ply-test\\b\\ghpr" },
      ] as never,
    });
    const twins: CopyTargets = {
      ...TARGETS,
      targets: [
        { workspaceId: "g1", name: "ghpr", repo: "acme/ci", target: { kind: "ready" } },
        { workspaceId: "g2", name: "ghpr", repo: "acme/ci", target: { kind: "ready" } },
      ],
    };
    renderUi(<CopyToFlow from={FROM} onClose={() => {}} />, {
      fixtures: { skills_hub_copy_targets: twins, skills_hub_copy_review: null, skills_hub_index: INDEX_VIEW },
    });
    await screen.findByRole("checkbox", { name: /a\\ghpr/ });
    expect(screen.getByRole("checkbox", { name: /ghpr · acme\/ci · …\\a\\ghpr/ })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /ghpr · acme\/ci · …\\b\\ghpr/ })).toBeTruthy();
    useWorkspaces.setState({ workspaces: [] });
  });

  it("opened from a Library row, closing it leaves All skills too", () => {
    act(() => openCopyTo(FROM));
    expect(useUi.getState().allSkillsOpen).toBe(true);
    expect(useAllSkills.getState().copy).toEqual(FROM);
    act(() => closeCopyTo());
    expect(useAllSkills.getState().copy).toBeNull();
    expect(useUi.getState().allSkillsOpen).toBe(false);
  });
});
