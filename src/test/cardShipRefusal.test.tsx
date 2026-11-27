// GH #151: Ship and Land's fast-forward refusal, as the person meets it — the
// card's real Ship press (`OutcomeScreen`'s runner, which the card's primary
// `Ship` calls), the real error-block store, the real toast stack and the real
// Ship step. Only Tauri is a stub: `card_ship` rejects with the value
// `worktrees::ShipError::LocalBranchRefused` serialises to, the way the Rust
// tests `ship_refuses_…` / `land_refuses_…` pin it.
//
//  1. The press announces it (`Show`, no body), and the Ship step draws the
//     block with both ways out.
//  2. `Show` lands on the card's Ship step.
//  3. `Move the local copy to Trash` posts only the refusal's own trashable
//     paths — never the folder it also named — and the block goes when the
//     fast-forward after it succeeds; the retried Ship then goes through.
//  4. Control: any other rejection is still the old toast, with no block.
//  5. Review 1: a Sync meeting the same refusal while the Ship step holds it
//     is not a second "Ship stopped" toast; a changed one is Sync's news, on
//     Sync's page. A landed retry takes only the Ship step's block off (the
//     condition is Sync's to clear); an attempt that never reached the
//     fast-forward check (`verify_pending`) leaves it.
import { describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { CardShipStep } from "../components/CardShipStep";
import { LocalBranchBlock } from "../components/errors/LocalBranchBlock";
import { useKanban } from "../store/kanbanStore";
import type { KanbanCard, LocalBranchRefused, ShipOutcome, TrashedThenSynced } from "../ipc";
import { cardWorkChanged, observeLocalBranch, observeShipAttempt, useErrorBlocks } from "../store/errorBlockStore";
import { useToasts } from "../store/toastStore";
import { useLibrary } from "../store/libraryStore";
import { shipRefusedFor } from "../lib/shipRefusal";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { act, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = "ws-1";
const SKILL = ".claude/skills/deploy/SKILL.md";

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

/** What `card_ship` rejects with on GH #88's refusal (a skill that differs,
 *  and a folder standing where origin adds a file). */
const refused: LocalBranchRefused = {
  operation: "land",
  localBranch: {
    branch: "staging",
    outcome: {
      kind: "untrackedDiffers",
      behind: 1,
      from: "759ae1a",
      to: "3ec1ef1",
      paths: [SKILL, "notes"],
      items: [
        { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
        { kind: "file", name: "notes", paths: ["notes"], directory: true },
      ],
      output: `error: Untracked working tree file '${SKILL}' would be overwritten by merge.`,
      repeated: false,
    },
  },
};

const trashed: TrashedThenSynced = {
  trashed: [SKILL],
  inTrash: ["/Users/someone/.Trash/SKILL.md"],
  nothingInTheWay: false,
  branch: "staging",
  outcome: { kind: "fastForwarded", from: "759ae1a", to: "3ec1ef1", commits: 1 },
};

const landed: ShipOutcome = {
  kind: "local_merge",
  merged: true,
  conflictingPaths: [],
  fellBack: false,
};

type Runner = (mode: "merge_live" | "pr") => Promise<void>;

function render(cardShip: unknown) {
  useWorkspaces.setState({
    workspaces: [{ id: WS, name: "Ply", cwd: "/tmp/ply-test" } as never],
    activeId: WS,
  });
  let runner: Runner | null = null;
  const view = renderUi(
    <>
      <OutcomeScreen
        workspaceId={WS}
        card={card}
        onShipReady={(run) => {
          runner = run as Runner | null;
        }}
      />
      <section aria-label="Ship step">
        <CardShipStep card={card} onOpenRelease={() => {}} />
      </section>
      {/* GH #183: the condition's own pages — the Library and Settings ›
          Worktrees — each draw it from one line, as the app does. */}
      <section aria-label="Library">
        <LocalBranchBlock workspaceId={WS} on="library" />
      </section>
      <section aria-label="Worktrees">
        <LocalBranchBlock workspaceId={WS} on="worktrees" />
      </section>
    </>,
    {
      withToasts: true,
      fixtures: {
        card_ship: cardShip,
        worktree_trash_untracked: trashed,
        card_outcome: { filesChanged: 1, verifyConfigured: false, isRecon: false, reconVerdictNegative: false },
        // What the Outcome screen and the Ship step read on the way, answered
        // empty: none of it is what this test is about.
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
        // GH #222 review 2: the Ship step reads the recorded release.
        ship_pending_release: { release: null, unreadable: null },
        // Try it TI-5: a land asks whether the project has a start command
        // (none here) before its Shipped toast.
        project_try_command_get: { command: null, approved: true, shared: false, readOnly: false, hasConfig: true, detection: { kind: "none" } },
      },
    },
  );
  // QoL 1.168 block 8 (A2): a refusal's toast is never replaced by the next
  // one, so a test that goes on past it closes it, as the person would;
  // `keepToast` leaves it up for the tests that read it.
  const ship = async ({ keepToast = false }: { keepToast?: boolean } = {}) => {
    await waitFor(() => expect(runner).not.toBeNull());
    await act(async () => {
      await runner!("merge_live");
    });
    if (keepToast) return;
    act(() => {
      const shown = useToasts.getState().toasts[0];
      if (shown && shown.kind !== "info") useToasts.getState().dismiss(shown.id);
    });
  };
  return { ...view, ship };
}

const shipStep = () => within(screen.getByRole("region", { name: "Ship step" }));
const library = () => within(screen.getByRole("region", { name: "Library" }));
const worktrees = () => within(screen.getByRole("region", { name: "Worktrees" }));
const LIBRARY_BLOCK = "Local staging can't be updated.";

describe("Ship's fast-forward refusal on the card's Ship step (GH #151)", () => {
  it("is announced, drawn on the Ship step with both ways out, and Show lands there", async () => {
    const { user, ship } = render(() => {
      throw refused;
    });
    await ship({ keepToast: true });

    // 1. The toast says it happened and leads to the page — no raw sentence.
    const toast = await screen.findByText(
      "Ship stopped: local staging can't be updated — nothing was changed.",
    );
    expect(screen.queryByText(/The card wasn.t shipped/)).toBeNull();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.queryByText(/untrackedDiffers|UntrackedDiffers/)).toBeNull();

    // The block, on the Ship step, with both ways out.
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();
    expect(shipStep().getByRole("button", { name: "Publish your version" })).toBeTruthy();
    expect(shipStep().getByRole("button", { name: "Move the local copy to Trash" })).toBeTruthy();
    // UX P-A Windows walk 1: the real press is a failed Ship on every
    // surface (`lib/shipRefusal.ts`), not only this block and the toast.
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(true);

    // 2. `Show` opens the card on its Ship step.
    useUi.setState({ selectedCardId: {}, cardStep: {} });
    const show = within(toast.closest(".toast") as HTMLElement).getByRole("button", { name: "Show" });
    await user.click(show);
    expect(useUi.getState().selectedCardId[WS]).toBe(card.id);
    expect(useUi.getState().cardStep[card.id]).toBe("ship");
    expect(useUi.getState().centerMode[WS]).toBe("board");
  });

  it("Publish your version says the branch already holds it, not that it is being published (owner-fixes Windows walk)", async () => {
    const { user, ship, tauri: stub } = render(() => {
      throw refused;
    });
    stub.fixture("project_skill_publish", { follows: null, outcome: "current" });
    stub.fixture("project_skill_publish_review", null);
    await ship();
    await user.click(shipStep().getByRole("button", { name: "Publish your version" }));
    await waitFor(() => expect(stub.callsOf("project_skill_publish")).toHaveLength(1));
    expect(await screen.findByText("Your version is already on staging.")).toBeTruthy();
    expect(screen.queryByText(/Publishing your version/)).toBeNull();
  });

  // Owner, 2026-10-19 (R15): a version that brings a new or changed script
  // shows its files first, on the skill's Library page; nothing is published.
  it("Publish your version of a skill that brings a script opens its publish sheet", async () => {
    const { user, ship, tauri: stub } = render(() => {
      throw refused;
    });
    stub.fixture("project_skill_publish", { follows: null, outcome: "published" });
    stub.fixture("project_skill_publish_review", { skill: "deploy", scriptsIds: ["publish:x"], files: [] });
    await ship();
    await user.click(shipStep().getByRole("button", { name: "Publish your version" }));
    await waitFor(() => expect(stub.callsOf("project_skill_publish_review")).toHaveLength(1));
    const skill = (stub.callsOf("project_skill_publish_review")[0]?.args as { skill: string }).skill;
    await waitFor(() =>
      expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "publish", key: `repository:${skill}` }),
    );
    expect(stub.callsOf("project_skill_publish")).toHaveLength(0);
  });

  // Challenger: with two skills, the sheet's OK publishes only the one it
  // shows, so the press says which one waits; a refusal that came after the
  // first went says that one is on its way.
  it("Publish your version of two skills, one with a script, says which one waits", async () => {
    const two: LocalBranchRefused = {
      ...refused,
      localBranch: {
        ...refused.localBranch,
        outcome: {
          ...(refused.localBranch.outcome as Extract<typeof refused.localBranch.outcome, { kind: "untrackedDiffers" }>),
          paths: [".claude/skills/style/SKILL.md", SKILL],
          items: [
            { kind: "skill", name: "style", paths: [".claude/skills/style/SKILL.md"], directory: false },
            { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
          ],
        },
      },
    };
    const { user, ship, tauri: stub } = render(() => {
      throw two;
    });
    stub.fixture("project_skill_publish_review", () => null);
    stub.fixture("project_skill_publish", (args: Record<string, unknown>) => {
      if (args.skill === "deploy") throw new Error("deploy changed while you were reading it, here or on staging, so you haven't said OK to what it brings now.");
      return { follows: null, outcome: "published" };
    });
    await ship();
    await user.click(shipStep().getByRole("button", { name: "Publish your versions" }));
    await waitFor(() =>
      expect(useLibrary.getState().byWorkspace[WS]?.flow).toEqual({ kind: "publish", key: "repository:deploy" }),
    );
    expect(await screen.findByText("Look at deploy's files first.")).toBeTruthy();
    expect(screen.getByText("Your version of style is on its way to staging.")).toBeTruthy();
  });

  it("Publish your versions, the second with a script, publishes nothing and says the first waits", async () => {
    const two: LocalBranchRefused = {
      ...refused,
      localBranch: {
        ...refused.localBranch,
        outcome: {
          ...(refused.localBranch.outcome as Extract<typeof refused.localBranch.outcome, { kind: "untrackedDiffers" }>),
          paths: [".claude/skills/style/SKILL.md", SKILL],
          items: [
            { kind: "skill", name: "style", paths: [".claude/skills/style/SKILL.md"], directory: false },
            { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
          ],
        },
      },
    };
    const { user, ship, tauri: stub } = render(() => {
      throw two;
    });
    stub.fixture("project_skill_publish", { follows: null, outcome: "published" });
    stub.fixture("project_skill_publish_review", (args: Record<string, unknown>) =>
      args.skill === "deploy" ? { skill: "deploy", scriptsIds: ["publish:x"], files: [] } : null,
    );
    await ship();
    await user.click(shipStep().getByRole("button", { name: "Publish your versions" }));
    expect(await screen.findByText("Look at deploy's files first")).toBeTruthy();
    expect(screen.getByText("style waits: after OK, publish, press Publish your versions again.")).toBeTruthy();
    expect(stub.callsOf("project_skill_publish")).toHaveLength(0);
  });

  it("Move the local copy to Trash posts only the refusal's paths, then Ship goes through", async () => {
    let answer: unknown = () => {
      throw refused;
    };
    const { user, ship, tauri: stub } = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    await ship();
    await user.click(shipStep().getByRole("button", { name: "Move the local copy to Trash" }));
    await user.click(await screen.findByRole("button", { name: "Move to Trash" }));

    await waitFor(() => expect(stub.callsOf("worktree_trash_untracked")).toHaveLength(1));
    // Only what the refusal named and the Trash can take: the skill's file,
    // never the folder `notes` (GH #102 review 2), never anything else.
    expect(stub.callsOf("worktree_trash_untracked")[0].args).toEqual({
      workspaceId: WS,
      paths: [SKILL],
      // UX P-A (Windows walk 2): pressed on this card's Ship step.
      cardId: card.id,
    });
    // The fast-forward went through: the block is gone, and the toast says so.
    await waitFor(() =>
      expect(shipStep().queryByText("Ship stopped: local staging can't be updated.")).toBeNull(),
    );
    expect(await screen.findByText(/You can ship again now\./)).toBeTruthy();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.shipStep ?? null).toBeNull();

    // Ship again: it lands.
    answer = landed;
    await ship();
    expect(await screen.findByText("Shipped")).toBeTruthy();
    expect(stub.callsOf("card_ship")).toHaveLength(2);
  });

  it("control: any other reason Ship stops is still its own toast, and draws no block", async () => {
    const { ship } = render(() => {
      throw "ship aborted: staging and origin/staging have diverged (1 ahead, 1 behind).";
    });
    await ship({ keepToast: true });
    expect(await screen.findByText(/The card wasn.t shipped/)).toBeTruthy();
    expect(useToasts.getState().toasts[0]?.body).toBe(
      "It's still ready to ship. Try Ship it again.",
    );
    // GH #261: git's words wait behind the toast's Details, not in its line.
    expect(screen.queryByText(/have diverged/)).toBeNull();
    expect(useToasts.getState().toasts[0]?.details).toMatch(/have diverged/);
    expect(shipStep().queryByRole("button", { name: /Move the local cop/ })).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch ?? null).toBeNull();
    expect(tauri().callsOf("worktree_trash_untracked")).toHaveLength(0);
  });

  it("review 1: a Sync meeting the same refusal is silent; a changed one is Sync's news", async () => {
    const { user } = render(() => {
      throw refused;
    });
    const refusalToasts = () =>
      useToasts.getState().toasts.filter((t) => /can't be updated/.test(t.title));
    act(() => {
      observeShipAttempt(WS, [card.id], "ship", { refused });
    });
    // The next reconcile reports the same refusal, `repeated: false` (Sync's
    // own guard never heard of Ship's announcement).
    act(() => {
      observeLocalBranch(WS, refused.localBranch);
    });
    expect(refusalToasts()).toHaveLength(1);
    expect(refusalToasts()[0].title).toBe(
      "Ship stopped: local staging can't be updated — nothing was changed.",
    );
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();

    // A different refusal: Sync's words, and `Show` goes to Sync's page.
    const other = {
      branch: "staging",
      outcome: {
        ...refused.localBranch.outcome,
        paths: ["tool.sh"],
        items: [{ kind: "file" as const, name: "tool.sh", paths: ["tool.sh"], directory: false }],
      },
    };
    act(() => {
      observeLocalBranch(WS, other);
    });
    // One toast at a time (GH #296): Sync's news replaces Ship's.
    expect(refusalToasts()).toHaveLength(1);
    expect(refusalToasts()[0].title).toBe("Local staging can't be updated — nothing was changed.");
    const toast = screen.getByText("Local staging can't be updated — nothing was changed.");
    useUi.setState({ settingsSection: null });
    await user.click(within(toast.closest(".toast") as HTMLElement).getByRole("button", { name: "Show" }));
    expect(useUi.getState().settingsSection).toBe("worktrees");
  });

  // UX P-A (Windows walk 2): the target Diverged, so the fast-forward let the
  // Land through, and git refused the card's squash-merge over untracked
  // files the card adds. The same typed refusal, marked `atMerge`.
  const AGENTS = ".agents/skills/walk-rule/SKILL.md";
  const CLAUDE = ".claude/skills/walk-rule/SKILL.md";
  const atMerge: LocalBranchRefused = {
    operation: "land",
    atMerge: true,
    localBranch: {
      branch: "trunk",
      outcome: {
        kind: "untrackedDiffers",
        behind: 0,
        from: "759ae1a",
        to: "3ec1ef1",
        paths: [AGENTS, CLAUDE],
        items: [
          { kind: "file", name: AGENTS, paths: [AGENTS], directory: false },
          { kind: "skill", name: "walk-rule", paths: [CLAUDE], directory: false },
        ],
        output:
          "error: The following untracked working tree files would be overwritten by merge:\n\t" +
          `${AGENTS}\n\t${CLAUDE}\nPlease move or remove them before you merge.\nAborting`,
        repeated: false,
      },
    },
  };

  it("(Windows walk 2) a merge refused over untracked files is the block on the Ship step, in the card's words, never a Sync's", async () => {
    const diverged: TrashedThenSynced = {
      trashed: [AGENTS, CLAUDE],
      inTrash: ["/Users/someone/.Trash/a", "/Users/someone/.Trash/b"],
      nothingInTheWay: false,
      branch: "trunk",
      outcome: { kind: "diverged", ahead: 1, behind: 3 },
    };
    const { user, ship, tauri: stub } = render(() => {
      throw atMerge;
    });
    stub.fixture("worktree_trash_untracked", diverged);
    await ship();
    expect(screen.queryByText(/The card wasn.t shipped/)).toBeNull();
    expect(shipStep().getByText("Ship stopped: local trunk can't be updated.")).toBeTruthy();
    expect(
      shipStep().getByText(/would be overwritten by the card's copies, so git didn't merge the card\./),
    ).toBeTruthy();
    expect(shipStep().queryByText(/differ from the ones on trunk/)).toBeNull();
    expect(shipStep().getByText("Nothing was merged or changed — not your copies, not trunk.")).toBeTruthy();
    expect(shipStep().getByRole("button", { name: "Publish your version" })).toBeTruthy();
    expect(shipStep().getByRole("button", { name: "Move the local copies to Trash" })).toBeTruthy();
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(true);
    // Not the Library's or Settings' block: a Sync never met these files…
    expect(library().queryByText("Local trunk can't be updated.")).toBeNull();
    expect(worktrees().queryByText("Local trunk can't be updated.")).toBeNull();
    // …and a Sync's outcome (the branch is still Diverged) says nothing of them.
    act(() => {
      observeLocalBranch(WS, { branch: "trunk", outcome: { kind: "diverged", ahead: 1, behind: 3 } });
    });
    expect(shipStep().getByText("Ship stopped: local trunk can't be updated.")).toBeTruthy();

    // The Trash moves them, naming the card, and the block goes though the
    // fast-forward after it is still Diverged: the merge's way is clear.
    await user.click(shipStep().getByRole("button", { name: "Move the local copies to Trash" }));
    await user.click(await screen.findByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(stub.callsOf("worktree_trash_untracked")).toHaveLength(1));
    expect(stub.callsOf("worktree_trash_untracked")[0].args).toEqual({
      workspaceId: WS,
      paths: [AGENTS, CLAUDE],
      cardId: card.id,
    });
    await waitFor(() => expect(shipStep().queryByText("Ship stopped: local trunk can't be updated.")).toBeNull());
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(false);
  });

  it("(Windows walk 2) a merge's refusal goes with the next land that reaches its merge, conflict or not", async () => {
    let answer: unknown = () => {
      throw atMerge;
    };
    const { ship } = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    await ship();
    expect(shipStep().getByText("Ship stopped: local trunk can't be updated.")).toBeTruthy();
    answer = { ...landed, merged: false, conflictingPaths: ["README.md"] };
    await ship({ keepToast: true });
    // P-E: the one ship-conflict toast.
    expect(await screen.findByText(/Ship stopped: your main branch changed the same lines/)).toBeTruthy();
    expect(shipStep().queryByText("Ship stopped: local trunk can't be updated.")).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch ?? null).toBeNull();
  });

  // Immediacy walk 8.3 (Mac): the card's work changed (a Bring in, a new
  // snapshot) — a merge's refusal of the old work no longer stops it; a
  // fast-forward refusal is the workspace's, left to Sync.
  it("walk 8.3: a merge's refusal goes when the card's work changes; a fast-forward one stays", async () => {
    const { ship } = render(() => {
      throw atMerge;
    });
    await ship();
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(true);
    act(() => cardWorkChanged(WS, "another-card"));
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(true);
    act(() => cardWorkChanged(WS, card.id));
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(false);
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch ?? null).toBeNull();

    act(() => {
      observeShipAttempt(WS, [card.id], "ship", { refused });
    });
    act(() => cardWorkChanged(WS, card.id));
    expect(shipRefusedFor(useErrorBlocks.getState().byWorkspace, WS, card.id)).toBe(true);
  });

  it("review 1: a landed retry takes the Ship step's block off, and leaves the condition to Sync", async () => {
    let answer: unknown = () => {
      throw refused;
    };
    const { ship } = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    await ship();
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();
    // Published elsewhere, say, and landed — possibly offline, where the
    // check passes with nothing fast-forwarded.
    answer = landed;
    await ship();
    expect(await screen.findByText("Shipped")).toBeTruthy();
    expect(shipStep().queryByText("Ship stopped: local staging can't be updated.")).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.shipStep ?? null).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch?.paths).toEqual([SKILL, "notes"]);
  });

  it("review 1: an attempt that never reached the check (verify_pending) leaves the block", async () => {
    let answer: unknown = () => {
      throw refused;
    };
    const { ship } = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    await ship();
    answer = { ...landed, kind: "verify_pending", merged: false, recoverySha: "abcdef1234" };
    await ship({ keepToast: true });
    expect(await screen.findByText("Not shipped yet — checking first.")).toBeTruthy();
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();
    expect(shipStep().getByRole("button", { name: "Move the local copy to Trash" })).toBeTruthy();
  });

  it("review 2: a card that then ships as a PR loses the Ship step's block, not the condition", async () => {
    let answer: unknown = () => {
      throw refused;
    };
    const { ship } = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    await ship();
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();
    // PR mode never runs the fast-forward check, but the card has shipped.
    answer = { ...landed, kind: "pr", merged: false, prUrl: "https://github.com/o/r/pull/9" };
    await ship();
    expect(await screen.findByText(/^On GitHub: pull request #9/)).toBeTruthy();
    expect(shipStep().queryByText(/Ship stopped/)).toBeNull();
    expect(shipStep().queryByText(/Then ship again/)).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.shipStep ?? null).toBeNull();
    // The checkout's condition is Sync's: still there for Library / Worktrees.
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch?.paths).toEqual([SKILL, "notes"]);
  });
});

describe("A land that really fast-forwarded takes the condition down, in every workspace (GH #183)", () => {
  function refusedThen(next: unknown) {
    let answer: unknown = () => {
      throw refused;
    };
    const view = render((args: Record<string, unknown>) =>
      typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer,
    );
    return { ...view, landNext: () => (answer = next) };
  }

  it("a refusal, then a land that fast-forwarded, in a workspace without GitHub sync: the block is gone", async () => {
    const { ship, landNext, tauri: stub } = refusedThen({ ...landed, fastForwarded: true });
    await ship();
    // The refusal is up where the checkout's condition lives (the skill's
    // paths put it on the Library) and on the Ship step.
    expect(library().getByText(LIBRARY_BLOCK)).toBeTruthy();
    expect(shipStep().getByText("Ship stopped: local staging can't be updated.")).toBeTruthy();

    // Without GitHub-issues sync, Sync's reconcile returns early: it is not
    // what takes the block down here.
    expect(useWorkspaces.getState().workspaces[0].kanbanSyncMode).toBeUndefined();
    await act(async () => {
      await useKanban.getState().reconcileGithub(WS);
    });
    expect(stub.callsOf("kanban_github_reconcile")).toHaveLength(0);
    expect(library().getByText(LIBRARY_BLOCK)).toBeTruthy();

    // The land that fast-forwarded (Rust's `fastForwarded: true`).
    landNext();
    await ship();
    expect(await screen.findByText("Shipped")).toBeTruthy();
    expect(library().queryByText(LIBRARY_BLOCK)).toBeNull();
    expect(worktrees().queryByText(LIBRARY_BLOCK)).toBeNull();
    expect(shipStep().queryByText(/Ship stopped/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Move the local copy to Trash" })).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch ?? null).toBeNull();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.shipStep ?? null).toBeNull();
  });

  it("an offline land (no fastForwarded) leaves the condition's block up", async () => {
    // Offline, with no origin or ahead, the check lets the land through with
    // nothing fast-forwarded: Rust says `fastForwarded: false`.
    const { ship, landNext } = refusedThen({ ...landed, fastForwarded: false });
    await ship();
    landNext();
    await ship();
    expect(await screen.findByText("Shipped")).toBeTruthy();
    expect(library().getByText(LIBRARY_BLOCK)).toBeTruthy();
    expect(library().getByRole("button", { name: "Move the local copy to Trash" })).toBeTruthy();
    expect(useErrorBlocks.getState().byWorkspace[WS]?.localBranch?.paths).toEqual([SKILL, "notes"]);
    // The card did ship, so its own Ship step no longer says "Then ship again".
    expect(shipStep().queryByText(/Ship stopped/)).toBeNull();
  });

  it("a land that fast-forwarded in another workspace leaves this one's block alone", async () => {
    const { ship } = refusedThen(landed);
    await ship();
    act(() => {
      observeShipAttempt("ws-other", ["card-9"], "merge", {
        passedGate: true,
        shipped: true,
        fastForwarded: true,
      });
    });
    expect(library().getByText(LIBRARY_BLOCK)).toBeTruthy();
  });
});
