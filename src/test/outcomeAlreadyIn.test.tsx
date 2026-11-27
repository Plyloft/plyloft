// GH #191 review: a card with nothing to ship because its commits are already
// in origin/<target> says so on the Outcome screen, instead of "no changes
// yet". Only Tauri is a stub: `card_outcome` answers the way the Rust
// `card_outcome` fills `alreadyIn` (`worktrees::card_already_in_origin`).
import { describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import type { CardOutcome, KanbanCard } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor } from "./render";

const WS = "ws-1";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Fix the header",
  columnId: "complete",
  verifyStatus: "passed",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};

function render(
  outcome: CardOutcome,
  props: { nowOffersRedo?: boolean; nowOffersShipMenu?: boolean; onRedoReady?: (open: (() => void) | null) => void } = {},
  more: Record<string, unknown> = {},
) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  return renderUi(<OutcomeScreen workspaceId={WS} card={card} {...props} />, {
    fixtures: {
      card_outcome: outcome,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      reviewer_list: [],
      verify_status: null,
      card_overlap_check: [],
      card_review_diff: {
        cardId: card.id,
        baseBranch: "staging",
        cardBranch: "card/card-1",
        files: [],
        generatedAt: 1,
      },
      dependency_doctor: {
        tools: [],
        teamSkills: null,
        projectSkills: null,
        microphone: null,
        whisperModel: null,
      },
      kanban_load: [card],
      ...more,
    },
  });
}

const base: CardOutcome = {
  filesChanged: 0,
  verifyConfigured: false,
  isRecon: false,
  reconVerdictNegative: false,
};

describe("Outcome with nothing to ship (GH #191)", () => {
  it("says the work is already in origin/<target> when it is", async () => {
    render({ ...base, alreadyIn: "origin/staging" });
    expect(
      await screen.findByText("This card's work is already in origin/staging — nothing to ship."),
    ).toBeTruthy();
    expect(screen.queryByText(/has no changes yet/)).toBeNull();
  });

  it("still says no changes yet when nothing was done", async () => {
    render({ ...base, alreadyIn: null });
    expect(
      await screen.findByText("This card's copy has no changes yet — nothing to ship."),
    ).toBeTruthy();
    expect(screen.queryByText(/already in/)).toBeNull();
  });

  it("counts files when there are some", async () => {
    render({ ...base, filesChanged: 1 });
    expect(await screen.findByText(/1 file\s*changed\./)).toBeTruthy();
  });
});

// CL-11 (walks): a local-only repository offered a pull request and Merge
// when checks pass (1.171.0 B3: Ship ▾'s pull request choices). Without a remote they are not offered, and the card
// says why; Ship (a local merge) stays.
describe("Outcome in a repository with no remote (CL-11)", () => {
  it("says pull requests need a remote instead of offering one", async () => {
    render({ ...base, filesChanged: 2, hasRemote: false });
    expect(await screen.findByText(/This project is only on this Mac, so Ship it merges the card here\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
  });

  it("offers them with a remote, or when it isn't known", async () => {
    for (const hasRemote of [true, undefined]) {
      const view = render({ ...base, filesChanged: 2, hasRemote });
      expect(await screen.findByRole("button", { name: "On GitHub, merge when checks pass" })).toBeTruthy();
      expect(screen.queryByText(/This project is only on this Mac, so Ship it merges/)).toBeNull();
      view.unmount();
    }
  });

  // R10: an origin on another host has no pull request either — said with
  // its host; Ship (a local merge) stays.
  it("says pull requests need a project on GitHub when origin is elsewhere", async () => {
    render({ ...base, filesChanged: 2, hasRemote: false, originHost: "gitlab.com" });
    expect(
      await screen.findByText("Pull requests need a project on GitHub; this project is on gitlab.com."),
    ).toBeTruthy();
    expect(screen.queryByText(/this repository has none/)).toBeNull();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
  });

  // R10 (Challenger): GitHub's host but no repository in the address — said
  // as such, never "origin is on github.com".
  it("says an origin on GitHub isn't a repository address it can read", async () => {
    render({ ...base, filesChanged: 2, hasRemote: false, originUnreadable: "https://github.com/o" });
    expect(
      await screen.findByText("This project's GitHub address isn't a repository Plyloft can read: https://github.com/o."),
    ).toBeTruthy();
    expect(screen.queryByText(/origin is on github\.com/)).toBeNull();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
  });
});

// SP-2: "The result", once — one overlap warning, nothing Now already
// offers, and the team sentence only in the button's title.
describe("the result says each thing once (SP-2)", () => {
  it("on its own it offers Not right and Ship ▾'s two pull request choices, what each does in its title", async () => {
    render({ ...base, filesChanged: 2 });
    const pr = (await screen.findByRole("button", { name: "On GitHub, merge when checks pass" })) as HTMLButtonElement;
    expect(pr.title).toBe("Opens the pull request and merges it once GitHub's checks pass.");
    const only = screen.getByRole("button", { name: "On GitHub, pull request only (I merge it)" }) as HTMLButtonElement;
    expect(only.title).toBe("Opens the pull request and leaves the merge to you.");
    expect(screen.queryByText(/Opens the pull request/)).toBeNull();
    expect(screen.getByRole("button", { name: "Not right — tell them what's wrong" })).toBeTruthy();
    // 1.171.0 B3 (CP-6): no checkbox named like the pull request's own press.
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
  });

  it("draws neither when Now offers them; the form Now opens stays", async () => {
    let openRedo: (() => void) | null = null;
    render({ ...base, filesChanged: 2 }, {
      nowOffersRedo: true,
      nowOffersShipMenu: true,
      onRedoReady: (fn) => {
        openRedo = fn;
      },
    });
    expect(await screen.findByText(/2 files\s*changed\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not right — tell them what's wrong" })).toBeNull();
    await waitFor(() => expect(openRedo).not.toBeNull());
    act(() => openRedo!());
    expect(screen.getByRole("textbox", { name: "What's wrong" })).toBeTruthy();
  });

  it("warns about overlapping edits once, in the amber callout, with no glyph", async () => {
    const { container } = render({ ...base, filesChanged: 2 }, {}, {
      card_overlap_check: [{ kind: "local_card", otherId: "card-2", otherTitle: "Another card", files: ["src/a.ts"] }],
    });
    expect(await screen.findByText("Shipping both may conflict on:")).toBeTruthy();
    expect(screen.getAllByText("Overlapping edits")).toHaveLength(1);
    const note = screen.getByRole("note");
    expect(note.classList.contains("ux-conflict")).toBe(true);
    expect(note.querySelector("svg")).toBeTruthy();
    expect(note.textContent).toContain("card “Another card”");
    expect(container.textContent).not.toContain("⚠");
  });

  // Round 2 (Challenger F3): the audit's quick wins say the same once too.
  it("in an audit's quick wins: one overlap callout, and no PR when Now's menu holds it", async () => {
    const recon: CardOutcome = {
      ...base,
      isRecon: true,
      filesChanged: 2,
      reconSummaryMd: "## Recommendation\n\nShip the quick wins.",
    };
    const overlaps = {
      card_overlap_check: [{ kind: "local_card", otherId: "card-2", otherTitle: "Another card", files: ["src/a.ts"] }],
    };
    const view = render(recon, {}, overlaps);
    expect(await screen.findByText("Shipping both may conflict on:")).toBeTruthy();
    expect(screen.getAllByText("Overlapping edits")).toHaveLength(1);
    const pr = screen.getByRole("button", { name: "On GitHub, merge when checks pass", hidden: true }) as HTMLButtonElement;
    expect(pr.title).toBe("Opens the pull request and merges it once GitHub's checks pass.");
    view.unmount();
    render(recon, { nowOffersShipMenu: true }, overlaps);
    expect(await screen.findByText("Shipping both may conflict on:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "On GitHub, merge when checks pass", hidden: true })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Merge when checks pass", hidden: true })).toBeNull();
  });
});
