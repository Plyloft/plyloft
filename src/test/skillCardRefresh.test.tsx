// Skills hub H3a, Mac walk 2: a skill card whose library moved on says so
// itself — its Now callout offers Refresh card, read from the card and this
// Mac's team clone (`skills_hub_card_behind`), not only from a refused Ship's
// toast that goes away. Refresh card rebuilds the card and Now is back to
// Ready to ship.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import type { KanbanCard } from "../ipc";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { refreshSkillCard, resetSkillCardBehindForTests } from "../components/useSkillCardBehind";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { renderUi, screen, waitFor, within } from "./render";

vi.mock("../components/BuilderSession", () => ({ BuilderSession: () => <div /> }));
vi.mock("../components/CardReviewPanel", () => ({ CardReviewPanel: () => <div /> }));
vi.mock("../components/IntakeConversation", () => ({ IntakeConversation: () => <div /> }));
vi.mock("../components/OutcomeScreen", async () => {
  const { useEffect } = await import("react");
  return {
    OutcomeScreen: ({
      onPresentationChange,
    }: {
      onPresentationChange?: (s: { loading: boolean; filesChanged: number | null; shipBusy: boolean }) => void;
    }) => {
      // As the real screen's fetch lands: two files changed.
      useEffect(() => {
        const t = setTimeout(() => onPresentationChange?.({ loading: false, filesChanged: 2, shipBusy: false }));
        return () => clearTimeout(t);
      }, [onPresentationChange]);
      return <div data-testid="outcome" />;
    },
  };
});

function skillCard(contentId: string): KanbanCard {
  return boardCard("skill-1", {
    title: "Skill: update team-style from the team library",
    notes: "Plyloft made this card.",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/ply-test/skill-1",
    branchName: "atelier/card-skill-1",
    kind: {
      type: "skill",
      verb: "update",
      skill: "team-style",
      origin: { kind: "team", source: "acme/team", name: "team-style", version: { commit: `c-${contentId}`, contentId } },
    },
  });
}

function open(card: KanbanCard, behind: () => unknown) {
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
      skills_hub_card_behind: behind,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const now = () => within(screen.getByRole("region", { name: "Now" }));

beforeEach(() => {
  resetSkillCardBehindForTests();
  useToasts.setState({ toasts: [] });
});

describe("a skill card behind its library", () => {
  it("offers Refresh card in Now before any Ship, and is Ready to ship once refreshed", async () => {
    let behind = true;
    const { user, tauri } = open(skillCard("ruby"), () => behind);
    expect(await now().findByText("The team changed this skill again")).toBeTruthy();
    const primary = now().getByRole("button", { name: "Refresh card" });
    tauri.fixture("skills_hub_card_refresh", () => {
      behind = false;
      return skillCard("jade");
    });
    tauri.fixture("kanban_load", () => [skillCard("jade")]);
    await user.click(primary);
    await waitFor(() => expect(tauri.calls.some((c) => c.cmd === "skills_hub_card_refresh")).toBe(true));
    expect(await now().findByText("Ready to ship")).toBeTruthy();
    expect(now().queryByRole("button", { name: "Refresh card" })).toBeNull();
    expect(useToasts.getState().toasts.some((t) => t.title === "Card refreshed")).toBe(true);
  });

  // Windows walk (H6b step 9): the teammate changed a script upstream, which
  // Refresh card won't take in unseen — Now says so up front and offers the
  // way that works, and a refusal says its sentence in the toast's body.
  it("says a newer version with a changed script is shown first, and offers Delete card", async () => {
    open(skillCard("ruby"), () => ({ behind: true, showsFirst: "script" }));
    expect(await now().findByText("The team changed this skill again")).toBeTruthy();
    expect(
      now().getByText(
        "The team library's newer version of this skill brings a new or changed script, so Plyloft won't put it in this card without showing it to you. Delete this card, then press Update in the Library: it shows every file first.",
      ),
    ).toBeTruthy();
    expect(now().getByRole("button", { name: "Delete card" })).toBeTruthy();
    expect(now().queryByRole("button", { name: "Refresh card" })).toBeNull();
  });

  it("names a file that is not text when only one is new or changed", async () => {
    open(skillCard("ruby"), () => ({ behind: true, showsFirst: "file" }));
    expect(await now().findByText(/brings a new or changed file that is not text, so Plyloft won't/)).toBeTruthy();
    expect(now().getByRole("button", { name: "Delete card" })).toBeTruthy();
  });

  it("a refused refresh says why in the toast's body, not only under Details", async () => {
    const why =
      "The team library's newer team-check brings a new or changed script, so Plyloft won't put it in this card without showing it to you. Delete this card and press Update in the Library: it shows every file first.";
    const { tauri } = open(skillCard("ruby"), () => ({ behind: true, showsFirst: null }));
    expect(await now().findByRole("button", { name: "Refresh card" })).toBeTruthy();
    tauri.fixture("skills_hub_card_refresh", () => {
      throw new Error(why);
    });
    await refreshSkillCard(BOARD_WS, "skill-1");
    const toast = useToasts.getState().toasts.find((t) => t.title === "Couldn't refresh the card");
    expect(toast?.body).toBe(why);
    expect(toast?.details).toBeUndefined();
    // The card's Now follows: Delete card, not a Refresh that is refused again.
    expect(await now().findByRole("button", { name: "Delete card" })).toBeTruthy();
  });

  it("is an ordinary Ready to ship while the card carries the library's version", async () => {
    open(skillCard("jade"), () => false);
    expect(await now().findByText("Ready to ship")).toBeTruthy();
    expect(now().queryByRole("button", { name: "Refresh card" })).toBeNull();
  });
});
