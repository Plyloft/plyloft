// GH #261 and #306: the card's result section says a failure once, where the
// person is looking, in words — never `String(err)` as a toast's line or as
// the report.
//
//  1. A Ship that fails on the open card page draws the card's ErrorBlock (the
//     caller's `onFailure`) and pushes no toast; the block names the merge
//     conflict in plain words, git's text only in Details (#306).
//  2. The same failure while the card page is not on screen leaves a pointer
//     toast (`Show`), not a second copy of the error.
//  3. An audit report that can't be rendered is an ErrorBlock, not
//     `render error: …` (#261).
import { describe, expect, it, vi } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { ErrorBlock } from "../components/ux";
import { cardActionError } from "../lib/cardPage";
import type { KanbanCard } from "../ipc";
import type { UxError } from "../lib/uxError";
import { useToasts } from "../store/toastStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, waitFor } from "./render";

vi.mock("../lib/markdown", () => {
  const fail = () => {
    throw new Error("marked: unexpected token at 12:4");
  };
  return { renderMarkdown: fail, renderAgentMarkdown: fail };
});

const WS = "ws-1";
const CONFLICT =
  "git merge failed: CONFLICT (content): Merge conflict in src/lib/settingsSearch.ts\nAutomatic merge failed; fix conflicts and then commit the result.";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Deploy skill",
  columnId: "complete",
  verifyStatus: "passed",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  createdAt: 1,
  updatedAt: 1,
};

type Runner = (mode: "merge_live" | "pr") => Promise<void>;

function render(opts: { recon?: boolean } = {}) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  let runner: Runner | null = null;
  const errors: UxError[] = [];
  function Host() {
    return (
      <OutcomeScreen
        workspaceId={WS}
        card={card}
        onShipReady={(run) => {
          runner = run as Runner | null;
        }}
        onFailure={(action, cause) => (errors.push(cardActionError(action, cause)), true)}
      />
    );
  }
  const view = renderUi(<Host />, {
    withToasts: true,
    fixtures: {
      card_ship: () => {
        throw CONFLICT;
      },
      card_outcome: {
        filesChanged: 1,
        verifyConfigured: false,
        isRecon: opts.recon ?? false,
        reconVerdictNegative: false,
        reconSummaryMd: opts.recon ? "# Audit\n\nShip it." : null,
      },
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
    },
  });
  const ship = async () => {
    await waitFor(() => expect(runner).not.toBeNull());
    await act(async () => {
      await runner!("merge_live");
    });
  };
  return { ...view, ship, errors };
}

describe("the card's result failures (GH #261, #306)", () => {
  it("says a failed Ship once, on the open card, naming the conflict", async () => {
    const { ship, errors } = render();
    act(() => {
      useUi.setState({
        centerMode: { [WS]: "board" },
        selectedCardId: { [WS]: card.id },
      });
    });
    await ship();
    expect(useToasts.getState().toasts).toEqual([]);
    expect(errors).toHaveLength(1);
    const [error] = errors;
    // F8 (I10): "the card's changes conflict with …" (was "the card's branch conflicts with …").
    expect(error.title).toMatch(/the card's changes conflict with your main branch on this Mac/);
    expect(error.happened).toContain("src/lib/settingsSearch.ts");
    expect(error.details).toBe(CONFLICT);

    // Drawn, the words come first and git's text only inside Details.
    const block = renderUi(<ErrorBlock error={error} density="dense" />);
    const details = block.container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Automatic merge failed");
  });

  it("points to the card when its page is not on screen", async () => {
    const { ship } = render();
    act(() => {
      useUi.setState({ centerMode: { [WS]: "terminals" }, selectedCardId: { [WS]: card.id } });
    });
    await ship();
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("Ship it didn't go through for “Deploy skill”.");
    expect(toasts[0].body).toBeUndefined();
    expect(toasts[0].action?.label).toBe("Show");
  });

  it("draws an unrenderable audit report as an ErrorBlock, not `render error: …`", async () => {
    render({ recon: true });
    expect(await screen.findByText("The audit's report couldn't be loaded.")).toBeTruthy();
    expect(screen.queryByText(/render error/)).toBeNull();
  });
});
