// Challenger on a pull request, as the person meets it: Board › Review a
// pull request lists the repository's open pull requests and makes the card;
// the card's page says what the Challenger said of the pull request's current
// head and offers Review / Review again — and, on the member's own pull
// request only, Fix with the Builder and Send the fixes to GitHub. Nothing is posted to
// GitHub: no command here writes to it. Only Tauri is a stub.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readFileSync } from "node:fs";
import { filesHint } from "../components/CardMore";
import { PrReviewPanel } from "../components/PrReviewPanel";
import { PrReviewSheet } from "../components/PrReviewSheet";
import type { BuilderReview, BuilderState, KanbanCard, PrList, PrReview } from "../ipc";
import { useUi } from "../store/uiStore";
import { useBuilder } from "../store/builderStore";
import {
  fixOffered,
  mergeOffered,
  prReviewCardState,
  prReviewLabel,
  prStatusWord,
  pushOffered,
  reviewOffer,
  reviewOnly,
  reviewPressLabel,
} from "../lib/prReview";
import { builderNeverStarted, notStartedOnPrWords, verdictOwed } from "../lib/challengerReview";
import { LineCommentList } from "../components/LineComments";
import { pressOnce, prPushPressKey } from "../lib/pressOnce";
import { chatScopeLine } from "../lib/chatView";
import { deriveAttentionColumn, isShipBatchEligible, readyToShipForStage } from "../lib/boardSemantics";
import { deriveBoardCardState } from "../lib/cardPresentation";
import { cardTimeline } from "../lib/cardPage";
import { fireEvent, nextFrame, renderUi, screen, waitFor } from "./render";

/** QoL 14.3 (C20): the card's one primary button, or the press under ⋯. */
async function press(user: { click: (el: Element) => Promise<void> }, name: string): Promise<HTMLButtonElement> {
  const shown = screen.queryByRole("button", { name });
  if (shown) return shown as HTMLButtonElement;
  if (!screen.queryByRole("menu")) await user.click(screen.getByRole("button", { name: "More for this review" }));
  return screen.getByRole("menuitem", { name }) as HTMLButtonElement;
}

/** The one accent button of the review's Now. */
function primary(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>("[data-ply-pr-primary]");
}

const WS = "ws-1";
const HEAD = "1111111111111111111111111111111111111111";
const NEXT = "2222222222222222222222222222222222222222";
const FIX = "3333333333333333333333333333333333333333";

function pr(over: Partial<PrReview> = {}): PrReview {
  return {
    url: "https://github.com/o/r/pull/12",
    number: 12,
    repo: "o/r",
    title: "Add the retry",
    author: "octo",
    baseRef: "main",
    headRef: "retry-upload",
    headSha: HEAD,
    branchHead: HEAD,
    crossRepository: false,
    pushable: false,
    fixNote: "This is octo's pull request: the Reviewer only reviews it, and the Builder doesn't change it.",
    state: "open",
    checkedAt: 1,
    ...over,
  };
}

function review(over: Partial<BuilderReview> = {}): BuilderReview {
  return {
    snapshotN: 1,
    provider: "codex",
    degraded: false,
    status: "done",
    verdict: "approve",
    at: 2,
    ...over,
  } as BuilderReview;
}

function builder(over: Partial<BuilderState> = {}): BuilderState {
  return {
    vendor: "claude",
    bypass: false,
    startedAt: 0,
    snapshots: [{ n: 1, sha: HEAD, at: 1 }],
    review: review(),
    ...over,
  } as BuilderState;
}

function card(prOver: Partial<PrReview> = {}, b: Partial<BuilderState> | null = {}): KanbanCard {
  return {
    id: "card-x-pr12",
    workspaceId: WS,
    title: "Review: Add the retry",
    notes: "Pull request #12 by @octo: Add the retry",
    columnId: "in_progress",
    worktreePath: "/tmp/ply-test/card-x-pr12",
    branchName: "plyloft/card-xpr12-review-add-the-retry",
    prReview: pr(prOver),
    builder: b === null ? undefined : builder(b),
    createdAt: 1,
    updatedAt: 1,
  } as KanbanCard;
}

describe("what a pull request card offers and where it sits on the Board", () => {
  it("reviews, reviews again on new commits, and stops once merged or closed", () => {
    const fresh = card({}, { snapshots: [], review: null });
    expect(reviewOffer(fresh)).toBe("review");
    expect(prReviewLabel(fresh)).toBe("Not reviewed yet");
    expect(deriveAttentionColumn(fresh, null)).toBe("needs-you");

    const running = card({}, { review: review({ status: "running", verdict: null }) });
    expect(reviewOffer(running)).toBe("running");
    expect(deriveAttentionColumn(running, null)).toBe("working");

    const approved = card();
    expect(reviewOffer(approved)).toBe("current");
    expect(prReviewLabel(approved)).toBe("Approved");
    expect(deriveAttentionColumn(approved, null)).toBe("waiting");
    expect(deriveBoardCardState(approved, null).label).toBe("Approved");

    const changes = card({}, { review: review({ verdict: "changes_requested" }) });
    expect(prReviewCardState(changes)).toBe("changes-requested");
    expect(deriveAttentionColumn(changes, null)).toBe("needs-you");

    const moved = card({ headSha: NEXT });
    expect(reviewOffer(moved)).toBe("newCommits");
    expect(deriveBoardCardState(moved, null).label).toBe("New commits to review");
    expect(deriveAttentionColumn(moved, null)).toBe("needs-you");

    const incomplete = card({}, { review: review({ verdict: "incomplete" }) });
    expect(reviewOffer(incomplete)).toBe("runAgain");
    expect(prReviewLabel(incomplete)).toBe("Review incomplete");

    const merged = card({ state: "merged" });
    expect(reviewOffer(merged)).toBe("closed");
    expect(deriveBoardCardState(merged, null).label).toBe("Pull request merged");
    expect(deriveAttentionColumn(merged, null)).toBe("done");
    expect(prReviewLabel(card({ state: "closed" }))).toBe("Pull request closed");
  });

  it("tells its story as the pull request's heads and the Builder's fixes", () => {
    const story = cardTimeline(
      card(
        { pushable: true, fixNote: null, heads: [1, 3] },
        {
          startedAt: 5,
          snapshots: [
            { n: 1, sha: HEAD, at: 1 },
            { n: 2, sha: FIX, at: 6 },
            { n: 3, sha: NEXT, at: 7 },
          ],
          review: review({ snapshotN: 3, status: "running", verdict: null }),
        },
      ),
    );
    const words = story.map((i) => i.text);
    expect(words[0]).toBe("Made to review pull request #12");
    expect(words).toContain("Read pull request #12");
    expect(words).toContain("Claude started fixing it");
    expect(words).toContain("Claude fixed it");
    expect(words).toContain("Read the pull request's new commits");
    expect(words).toContain("Codex is reviewing the pull request");
    expect(words.some((w) => /built it/.test(w))).toBe(false);
    expect(story.some((i) => i.link && ["review", "diff", "checks"].includes(i.link.kind))).toBe(false);
    // Someone else's: no Builder in its story at all.
    const theirs = cardTimeline(card({ heads: [1] }));
    expect(theirs.some((i) => /started/.test(i.text))).toBe(false);
  });

  it("never ships, and the Builder is the member's own pull request's only", () => {
    const theirs = card({}, { review: review({ verdict: "changes_requested" }) });
    expect(fixOffered(theirs)).toBe(false);
    expect(pushOffered(theirs)).toBe(false);
    const mine = card({ pushable: true, fixNote: null });
    expect(fixOffered(mine)).toBe(true);
    expect(pushOffered(mine)).toBe(false);
    const fixed = card(
      { pushable: true, fixNote: null },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    expect(pushOffered(fixed)).toBe(true);
    expect(fixOffered({ ...fixed, builder: { ...fixed.builder!, ptyId: "pty-1" } })).toBe(false);
    const verified = { ...fixed, verifyStatus: "passed" as const, columnId: "complete" as const };
    expect(readyToShipForStage(verified)).toBe(false);
    expect(isShipBatchEligible(verified)).toBe(false);
  });
});

describe("the card page of a pull request review", () => {
  const fixtures = {
    pr_review_refresh: () => card(),
    kanban_load: () => [card()],
  };

  it("someone else's: the review and its findings, Review again on new commits, no Builder", async () => {
    const moved = card({ headSha: NEXT });
    const { user, tauri } = renderUi(<PrReviewPanel card={moved} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, pr_review_start: () => moved },
    });
    expect(screen.getByText("New commits to review")).toBeTruthy();
    expect(screen.getByText(/Pull request #12 · by @octo · retry-upload → main/)).toBeTruthy();
    expect(screen.getByText(/octo's pull request: the Reviewer only reviews it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send the fixes to GitHub/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Ship/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(tauri.callsOf("pr_review_start")).toHaveLength(1));
    expect(tauri.callsOf("pr_review_start")[0].args).toEqual({ workspaceId: WS, cardId: "card-x-pr12" });
    // Read on open, never written.
    expect(tauri.callsOf("pr_review_refresh").length).toBeGreaterThan(0);
    expect(tauri.calls.some((c) => /comment|post|edit|merge/.test(c.cmd))).toBe(false);
  });

  it("the member's own: Fix with the Builder, then Send the fixes to GitHub sends the fix", async () => {
    const fixed = card(
      { pushable: true, fixNote: null },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    const { user, tauri } = renderUi(<PrReviewPanel card={fixed} onOpenSession={() => {}} />, {
      fixtures: {
        ...fixtures,
        card_pr_push_update: () => ({ card: fixed, pushed: true }),
      },
      withToasts: true,
    });
    expect(screen.getByText(/This is your pull request/)).toBeTruthy();
    expect(await press(user, "Fix with the Builder")).toBeTruthy();
    await user.click(await press(user, "Send the fixes to GitHub"));
    await waitFor(() => expect(tauri.callsOf("card_pr_push_update")).toHaveLength(1));
    expect(await screen.findByText("Pushed to pull request #12.")).toBeTruthy();
  });

  // 1.176.2 F2: the card's other Send the fixes to GitHub (its Shipping
  // section, its Now) and this one share one slot: while one runs, this
  // press sends nothing; once it ends, this one goes.
  it("sends nothing while another push of the same card runs, says so, and goes once it ends", async () => {
    const fixed = card(
      { pushable: true, fixNote: null },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    const { user, tauri } = renderUi(<PrReviewPanel card={fixed} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, card_pr_push_update: () => ({ card: fixed, pushed: true }) },
      withToasts: true,
    });
    let release!: () => void;
    const other = pressOnce(prPushPressKey(fixed.workspaceId, fixed.id), () => new Promise<void>((r) => (release = r)));
    // Review M2: a press well after the running one is answered, not silent.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_000);
    await user.click(await press(user, "Send the fixes to GitHub"));
    expect(tauri.callsOf("card_pr_push_update")).toHaveLength(0);
    expect(await screen.findByText("Sending the fixes to GitHub is still running.")).toBeTruthy();
    clock.mockRestore();
    release();
    await other;
    await user.click(await press(user, "Send the fixes to GitHub"));
    await waitFor(() => expect(tauri.callsOf("card_pr_push_update")).toHaveLength(1));
  });

  it("the member's own with new commits under an unpushed fix: Bring in the new commits, no Review again", async () => {
    const under = card(
      { pushable: true, fixNote: null, headSha: NEXT, branchHead: HEAD, heads: [1] },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    expect(prReviewLabel(under)).toBe("New commits under your fix");
    expect(pushOffered(under)).toBe(false);
    expect(deriveAttentionColumn(under, null)).toBe("needs-you");
    const { user, tauri } = renderUi(<PrReviewPanel card={under} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, pr_review_merge_head: () => under },
    });
    expect(screen.queryByRole("button", { name: "Review again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send the fixes to GitHub" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Bring in the new commits" }));
    await waitFor(() => expect(tauri.callsOf("pr_review_merge_head")).toHaveLength(1));
  });

  it("a fix ready to push is Needs you, with its checks said; changes asked make Fix the primary", () => {
    const ready = card(
      { pushable: true, fixNote: null, heads: [1] },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    const verified = { ...ready, verifyStatus: "passed" as const };
    expect(prReviewLabel(verified)).toBe("Fix ready to push");
    expect(deriveAttentionColumn(verified, null)).toBe("needs-you");
    const { unmount } = renderUi(<PrReviewPanel card={verified} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByText("The fix's checks passed.")).toBeTruthy();
    expect(screen.getByText(/Reviewer: Codex/)).toBeTruthy();
    unmount();
    const asked = card({ pushable: true, fixNote: null }, { review: review({ verdict: "changes_requested" }) });
    renderUi(<PrReviewPanel card={asked} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByRole("button", { name: "Fix with the Builder" }).className).toContain("accent");
    expect(screen.getByText("This is your pull request: Fix with the Builder works on this card's copy of its branch.")).toBeTruthy();
  });

  it("walk of lane 2: approved with nothing to push — Open on GitHub is the one press, and no push words", () => {
    const approved = card({ pushable: true, fixNote: null }, { review: review({ verdict: "approve" }) });
    renderUi(<PrReviewPanel card={approved} onOpenSession={() => {}} />, { fixtures });
    expect(primary()?.textContent).toBe("Open on GitHub");
    expect(document.querySelector("[data-ply-pr-push-words]")).toBeNull();
    expect(screen.queryByText(/Send the fixes to GitHub sends/)).toBeNull();
    // Re-check: no Fix sentence while Fix with the Builder isn't the press.
    expect(screen.queryByText(/This is your pull request/)).toBeNull();
  });

  it("someone else's diff opens read-only, in the pull request's words", async () => {
    const { user } = renderUi(<PrReviewPanel card={card()} onOpenSession={() => {}} />, {
      fixtures: {
        ...fixtures,
        card_review_diff: () => ({ cardId: "card-x-pr12", baseBranch: "main", cardBranch: "b", files: [], generatedAt: 1 }),
        reviewer_list: [],
        card_review_tip: null,
      },
    });
    await user.click(await press(user, "See the changes"));
    expect(await screen.findByText("The pull request changes nothing against its base.")).toBeTruthy();
  });

  it("merged, not built yet: Resume the Builder, no push, no Review again; then the merge builds into a fix ready to push", async () => {
    const notBuilt = card(
      { pushable: true, fixNote: null, headSha: NEXT, branchHead: NEXT, heads: [1], headMark: 2, merged: true, challenger: "codex" },
      { startedAt: 5, snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );
    expect(prReviewLabel(notBuilt)).toBe("Merged, not built yet");
    expect(pushOffered(notBuilt)).toBe(false);
    expect(fixOffered(notBuilt)).toBe(true);
    expect(deriveAttentionColumn(notBuilt, null)).toBe("needs-you");
    const { user, tauri, unmount } = renderUi(<PrReviewPanel card={notBuilt} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, builder_resume: () => ({ ptyId: "p", card: notBuilt }) },
    });
    for (const name of ["Review again", "Send the fixes to GitHub", "Bring in the new commits"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText(/merged into the card's branch but not built yet/)).toBeTruthy();
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Resume the Builder" }));
    unmount();
    const built = {
      ...notBuilt,
      verifyStatus: "passed" as const,
      builder: { ...notBuilt.builder!, snapshots: [...notBuilt.builder!.snapshots, { n: 3, sha: "6".repeat(40), at: 4 }], review: review({ snapshotN: 3 }) },
    };
    expect(prReviewLabel(built)).toBe("Fix ready to push");
    expect(pushOffered(built)).toBe(true);
    expect(pushOffered({ ...built, verifyStatus: "failed" })).toBe(false);
  });

  it("says when the Builder is the Reviewer's vendor", () => {
    const same = card({ pushable: true, fixNote: null, challenger: "claude" }, { startedAt: 5, vendor: "claude" });
    renderUi(<PrReviewPanel card={same} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByText("The Builder and the Reviewer are both Claude: the fix's review isn't by the other AI.")).toBeTruthy();
  });

  // Walk of #386 (step 7): the first Fix with the Builder met the setup
  // command this Mac hadn't allowed, and the card had no way on.
  it("the member's own whose setup needs this Mac's OK: Allow and run, then the Builder starts", async () => {
    const setup = {
      state: "failed" as const,
      approvalNeeded: true,
      command: "echo $PLYLOFT_PORT_BASE",
      reason: "The repository's setup command hasn't run on this Mac before: echo $PLYLOFT_PORT_BASE. Allow it here?",
      at: 5,
    };
    const asked = { ...card({ pushable: true, fixNote: null }, { review: review({ verdict: "changes_requested" }) }), worktreeSetup: setup };
    const allowed = { ...asked, worktreeSetup: { ...setup, state: "done" as const, approvalNeeded: false } };
    // The store's start (its claim, set-up and toasts) has tests of its own.
    const started: string[] = [];
    const realStart = useBuilder.getState().start;
    useBuilder.setState({ start: async (_ws, id) => void started.push(id) });
    onTestFinished(() => useBuilder.setState({ start: realStart }));
    const { tauri } = renderUi(<PrReviewPanel card={asked} onOpenSession={() => {}} />, {
      fixtures: {
        ...fixtures,
        kanban_load: () => [allowed],
        card_worktree_setup_retry: () => allowed,
      },
    });
    expect(document.querySelector("[data-ply-pr-fix-setup]")?.getAttribute("data-ply-pr-fix-setup")).toBe("approval");
    expect(screen.getByText("The setup command needs your OK")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start anyway" })).toBeTruthy();
    // The note's presses are the way on; Fix would only be refused again.
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow and run" }));
    await waitFor(() => expect(tauri.callsOf("card_worktree_setup_retry")).toHaveLength(1));
    expect(tauri.callsOf("card_worktree_setup_retry")[0].args).toMatchObject({ cardId: "card-x-pr12", allow: "echo $PLYLOFT_PORT_BASE" });
    await waitFor(() => expect(started).toEqual(["card-x-pr12"]));
    // The press is over (its reload done) before the next test.
    await waitFor(() => expect((screen.getByRole("button", { name: "Allow and run" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("the member's own: a Fix the setup refused is said by the setup, not as a failed start", async () => {
    const asked = card({ pushable: true, fixNote: null }, { review: review({ verdict: "changes_requested" }) });
    let pressed = 0;
    const realStart = useBuilder.getState().start;
    useBuilder.setState({
      start: async () => {
        pressed += 1;
        throw "The card's setup command needs your OK, so the Builder was not started. Allow and run it, or start anyway, from the card.";
      },
    });
    onTestFinished(() => useBuilder.setState({ start: realStart }));
    renderUi(<PrReviewPanel card={asked} onOpenSession={() => {}} />, { fixtures });
    fireEvent.click(screen.getByRole("button", { name: "Fix with the Builder" }));
    await waitFor(() => expect(pressed).toBe(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fix with the Builder" })).toBeTruthy());
    expect(screen.queryByText("The Builder didn't start")).toBeNull();
  });

  it("the Status word fits the pull request card", () => {
    const asked = card({}, { review: review({ verdict: "changes_requested" }), undeliveredVerdict: { snapshotN: 1, at: 2 } });
    expect(prStatusWord(asked)).toBe("Changes requested · review only");
    expect(reviewOnly(asked)).toBe(true);
    const mine = card({ pushable: true, fixNote: null }, { review: review({ verdict: "changes_requested" }), undeliveredVerdict: { snapshotN: 1, at: 2 } });
    expect(prStatusWord(mine)).toBe("Changes requested");
    expect(reviewOnly(mine)).toBe(false);
    // A Builder that never ran is owed nothing yet; its first session is.
    expect(verdictOwed(mine.builder)).toBeNull();
    expect(builderNeverStarted(mine.builder)).toBe(true);
    expect(verdictOwed({ ...mine.builder!, startedAt: 9, ptyId: "p1" })?.line).toBe("Claude doesn't have the findings yet");
    // A fix under way: the card's own words decide.
    expect(prStatusWord({ ...mine, lastRunStatus: "running" })).toBeNull();
    expect(prStatusWord({ ...mine, prReview: null })).toBeNull();
  });

  // Challenger of the walk-fix round: line comments on the member's own pull
  // request, before its first Builder, have no session to resume into.
  it("the member's own, Builder never started: Send to Builder waits for Fix with the Builder", () => {
    const comment = { id: "lc1", path: "sum.js", newStart: 3, newEnd: 3, quoted: "x", body: "why?", createdAt: 1, updatedAt: 1 };
    const mine = { ...card({ pushable: true, fixNote: null }, { review: review({ verdict: "changes_requested" }) }), lineComments: [comment] };
    const { unmount } = renderUi(<LineCommentList workspaceId={WS} card={mine} />, { fixtures });
    expect((screen.getByRole("button", { name: "Send to Builder (1)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Fix with the Builder starts it; send them once it has/)).toBeTruthy();
    unmount();
    renderUi(<LineCommentList workspaceId={WS} card={{ ...mine, builder: { ...mine.builder!, startedAt: 9 } }} />, { fixtures });
    expect((screen.getByRole("button", { name: "Send to Builder (1)" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the session section names no Fix with the Builder once the pull request is closed", () => {
    expect(notStartedOnPrWords("open")).toMatch(/Fix with the Builder starts it/);
    expect(notStartedOnPrWords("merged")).toBe("The Builder never started on this card.");
  });

  it("the Chat's scope line is the pull request's", () => {
    // 1.171.0 (E1): a card's own chat says where the Builder stands on a
    // line of its own (`chatBuilderLine`), not in the scope line.
    expect(chatScopeLine(null)).toMatch(/^Discussion only\..*can't change anything\.$/);
    expect(chatScopeLine({ pushable: false })).toContain("someone else's pull request: Plyloft only reviews it");
    expect(chatScopeLine({ pushable: false })).not.toContain("Builder");
    expect(chatScopeLine({ pushable: true })).toContain("Fix with the Builder, never here");
  });

  it("merged: says so and offers no review", () => {
    renderUi(<PrReviewPanel card={card({ state: "merged" })} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByText("Pull request merged")).toBeTruthy();
    expect(screen.getByText(/was merged. There is nothing more to review/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Review/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check GitHub" })).toBeNull();
  });
});

describe("Board › Review a pull request", () => {
  const list: PrList = {
    repo: "o/r",
    prs: [
      { number: 12, title: "Add the retry", url: "u12", author: "octo", headRef: "retry-upload", baseRef: "main", crossRepository: false, draft: false, mine: false, cardId: null },
      { number: 13, title: "Mine", url: "u13", author: "me", headRef: "mine", baseRef: "main", crossRepository: false, draft: false, mine: true, cardId: null },
    ],
  };

  it("lists the open pull requests and reviews the one picked, or a pasted link", async () => {
    const made = card();
    let closed = 0;
    const { user, tauri } = renderUi(<PrReviewSheet workspaceId={WS} onClose={() => (closed += 1)} />, {
      fixtures: {
        pr_review_list: () => list,
        pr_review_create: () => ({ card: made, existing: false }),
        kanban_load: () => [made],
      },
    });
    expect(await screen.findByText(/#12 Add the retry/)).toBeTruthy();
    expect(screen.getByText(/yours/)).toBeTruthy();
    const begin = screen.getByRole("button", { name: "Review" });
    expect((begin as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /#12 Add the retry/ }));
    await user.click(begin);
    await waitFor(() => expect(tauri.callsOf("pr_review_create")).toHaveLength(1));
    const args = tauri.callsOf("pr_review_create")[0].args;
    expect(args.workspaceId).toBe(WS);
    expect(args.input).toBe("12");
    expect(["claude", "codex"]).toContain(args.challenger);
    await waitFor(() => expect(closed).toBe(1));
    expect(useUi.getState().selectedCardId[WS]).toBe(made.id);
  });

  it("QoL 14.2 (G27): Copy findings puts them on the clipboard as Markdown; nothing reaches GitHub", async () => {
    const found = card({}, {
      review: review({
        verdict: "changes_requested",
        findings: [{ severity: "P1", title: "Token leaks", body: "The token is logged.", preExisting: false, pass: null, location: "src/a.ts:3" }],
      }),
    });
    const { user, tauri } = renderUi(<PrReviewPanel card={found} onOpenSession={() => {}} />, {
      fixtures: { pr_review_refresh: () => found, kanban_load: () => [found] },
      withToasts: true,
    });
    await user.click(screen.getByRole("button", { name: "Copy findings" }));
    const text = await navigator.clipboard.readText();
    expect(text).toContain("- **Serious** — Token leaks (`src/a.ts:3`)");
    expect(await screen.findByText("Findings copied.")).toBeTruthy();
    expect(tauri.calls.some((c) => /comment|post|edit/.test(c.cmd))).toBe(false);
  });

  it("QoL 14.2: opened from the Inbox, the pull request is already picked; nothing starts before Review", async () => {
    const made = card();
    const { user, tauri } = renderUi(<PrReviewSheet workspaceId={WS} initialNumber={12} onClose={() => {}} />, {
      fixtures: { pr_review_list: () => list, pr_review_create: () => ({ card: made, existing: false }), kanban_load: () => [made] },
    });
    const radio = (await screen.findByRole("radio", { name: /#12 Add the retry/ })) as HTMLInputElement;
    expect(radio.checked).toBe(true);
    expect(tauri.callsOf("pr_review_create")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(tauri.callsOf("pr_review_create")[0]?.args.input).toBe("12"));
  });

  it("says why when the repository can't be listed and still takes a link", async () => {
    const { user, tauri } = renderUi(<PrReviewSheet workspaceId={WS} onClose={() => {}} />, {
      fixtures: {
        pr_review_list: () => {
          throw "Review a pull request needs this workspace's repository on GitHub: its origin isn't a GitHub repository.";
        },
        pr_review_create: () => {
          throw "That pull request is in a/b, not in this workspace's repository (o/r).";
        },
      },
    });
    expect(await screen.findByText(/couldn't list the pull requests/)).toBeTruthy();
    // The Sheet takes the focus on its next frame: type after it, or a
    // frame that comes late takes the keys away from the field.
    await nextFrame();
    await user.type(screen.getByLabelText("Pull request link"), "https://github.com/a/b/pull/3");
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/not in this workspace's repository/)).toBeTruthy();
    expect(tauri.callsOf("pr_review_create")[0].args.input).toBe("https://github.com/a/b/pull/3");
  });

  // Walk of #386 (step 2): the refusal is of the link it named; picking
  // another pull request clears it.
  it("clears a refusal when another pull request is picked", async () => {
    const { user } = renderUi(<PrReviewSheet workspaceId={WS} onClose={() => {}} />, {
      fixtures: {
        pr_review_list: () => list,
        pr_review_create: () => {
          throw "That pull request is in someone/else, not in this workspace's repository (o/r).";
        },
      },
    });
    await screen.findByText(/#12 Add the retry/);
    await user.click(screen.getByRole("radio", { name: /#12 Add the retry/ }));
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("No review was started.")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: /#13 Mine/ }));
    expect(screen.queryByText("No review was started.")).toBeNull();
  });
});

describe("walk 2 of #386", () => {
  const fixtures = {
    pr_review_refresh: () => card(),
    kanban_load: () => [card()],
  };
  const fixed = (b: Partial<BuilderState> = {}, over: Partial<KanbanCard> = {}) =>
    ({
      ...card(
        { pushable: true, fixNote: null, heads: [1] },
        { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }), ...b },
      ),
      ...over,
    }) as KanbanCard;

  it("with the Builder's session open, Send the fixes to GitHub is shown disabled with why, and Close the Builder session closes it", async () => {
    const live = fixed({ startedAt: 5, ptyId: "pty-1" });
    const { user, tauri } = renderUi(<PrReviewPanel card={live} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, builder_close: null },
    });
    // QoL 14.3 (C20): the one press closes and pushes; Send the fixes to GitHub alone
    // waits under ⋯, with why.
    expect(primary()?.textContent).toBe("Close the session and send the fixes to GitHub");
    const push = await press(user, "Send the fixes to GitHub");
    expect(push.disabled).toBe(true);
    expect(screen.getAllByText(/Send the fixes to GitHub waits while the Builder's session is open/).length).toBeGreaterThan(0);
    await user.click(await press(user, "Close the Builder session"));
    await user.click(await screen.findByRole("button", { name: "Close session" }));
    await waitFor(() => expect(tauri.callsOf("builder_close")).toHaveLength(1));
    expect(tauri.callsOf("card_pr_push_update")).toHaveLength(0);
  });

  it("QoL 14.3: Close the session and send the fixes to GitHub closes, then pushes, after one confirm", async () => {
    const live = fixed({ startedAt: 5, ptyId: "pty-1" }, { verifyStatus: "passed" } as never);
    const { user, tauri } = renderUi(<PrReviewPanel card={live} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, builder_close: null, card_pr_push_update: () => ({ card: live, pushed: true }) },
    });
    // One accent button, whatever else is under ⋯.
    const accents = [...document.querySelectorAll("[data-ply-pr-review] button")].filter((b) => b.className.includes("accent"));
    expect(accents).toHaveLength(1);
    await user.click(primary()!);
    await user.click(await screen.findByRole("button", { name: "Close and push" }));
    await waitFor(() => expect(tauri.callsOf("card_pr_push_update")).toHaveLength(1));
    expect(tauri.callsOf("builder_close")).toHaveLength(1);
  });

  it("QoL 14.3: a session that didn't close is said, and nothing is pushed", async () => {
    const live = fixed({ startedAt: 5, ptyId: "pty-1" }, { verifyStatus: "passed" } as never);
    const { user, tauri } = renderUi(<PrReviewPanel card={live} onOpenSession={() => {}} />, {
      fixtures: { ...fixtures, kanban_load: () => [live], builder_close: null, card_pr_push_update: () => ({ card: live, pushed: true }) },
    });
    await user.click(primary()!);
    await user.click(await screen.findByRole("button", { name: "Close and push" }));
    expect(await screen.findByText(/The Builder's session didn't close/)).toBeTruthy();
    expect(tauri.callsOf("card_pr_push_update")).toHaveLength(0);
  });

  it("checks that are not set up are said so, not \"passed\"", () => {
    const none = fixed({}, {
      verifyStatus: "passed",
      verifyHistory: [{ verifyRunId: "v1", status: "passed", steps: [], startedAt: 1, endedAt: 2 }],
    } as never);
    renderUi(<PrReviewPanel card={none} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByText("No checks are set up for this project, so none ran on the fix.")).toBeTruthy();
    expect(screen.queryByText("The fix's checks passed.")).toBeNull();
  });

  it("no push while the Reviewer still reviews the fix, nor when it asked for changes", () => {
    const reviewing = fixed({ review: review({ snapshotN: 2, status: "running", verdict: null }) });
    expect(pushOffered(reviewing)).toBe(false);
    expect(prReviewLabel(reviewing)).toBe("Reviewing");
    renderUi(<PrReviewPanel card={reviewing} onOpenSession={() => {}} />, { fixtures });
    expect(screen.queryByRole("button", { name: "Send the fixes to GitHub" })).toBeNull();
    expect(pushOffered(fixed({ review: review({ snapshotN: 1 }) }))).toBe(false);
    expect(pushOffered(fixed({ waitingReview: { snapshotN: 2, requestedAt: 4 } } as never))).toBe(false);
    const asked = fixed({ review: review({ snapshotN: 2, verdict: "changes_requested" }) });
    expect(pushOffered(asked)).toBe(false);
    expect(prReviewLabel(asked)).toBe("Changes requested");
    expect(pushOffered(fixed({ review: review({ snapshotN: 2, status: "skipped", verdict: null }) }))).toBe(true);
  });

  it("the push and the pull request's close are in the Activity", () => {
    const pushed = card(
      {
        pushable: true,
        fixNote: null,
        heads: [1],
        headSha: FIX,
        state: "closed",
        closedAt: 20,
        pushes: [{ sha: FIX, over: HEAD, at: 10 }],
      },
      { startedAt: 2, snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }] },
    );
    const words = cardTimeline(pushed).map((i) => String(i.text));
    const push = "Pushed the fix to pull request #12";
    expect(words).toContain(push);
    expect(words).toContain("Pull request #12 was closed");
    expect(words.indexOf("Pull request #12 was closed")).toBeGreaterThan(words.indexOf(push));
  });

  it("the review box puts its presses on their own row", () => {
    const css = readFileSync("src/components/ux/ux.css", "utf8");
    expect(css).toMatch(/\.ux-card-pr-review > \.ux-callout \{\s*flex-wrap: wrap;/);
    expect(css).toMatch(/\.ux-card-pr-review > \.ux-callout > \.ux-callout-actions \{\s*flex: 1 1 100%;/);
    renderUi(<PrReviewPanel card={card()} onOpenSession={() => {}} />, { fixtures });
    expect(document.querySelector("section.ux-card-pr-review > .ux-callout > .ux-callout-actions")).toBeTruthy();
  });

  it("the Files hint names who gets the files on a pull request card", () => {
    expect(filesHint(card())).toBe("Drop files here. Ask about this card gets them, up to 5 MB each.");
    expect(filesHint(card({ pushable: true, fixNote: null }))).toMatch(/Ask about this card and the Builder/);
    expect(filesHint({ prReview: null })).toMatch(/planning conversation and the Builder/);
  });
});

describe("walk 3 of #386", () => {
  const fixtures = {
    pr_review_refresh: () => card(),
    kanban_load: () => [card()],
  };
  // An unpushed fix (snapshot 2) built on HEAD, with NEXT on GitHub on top.
  const under = (b: Partial<BuilderState> = {}, p: Partial<PrReview> = {}) =>
    card(
      { pushable: true, fixNote: null, headSha: NEXT, branchHead: HEAD, heads: [1], ...p },
      { startedAt: 5, snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }), ...b },
    );

  it("a failed press on one card isn't shown on another card", async () => {
    const a = under();
    const other = { ...card(), id: "card-y-pr29" } as KanbanCard;
    const { user, rerender, tauri } = renderUi(<PrReviewPanel card={a} onOpenSession={() => {}} />, {
      fixtures: {
        ...fixtures,
        pr_review_merge_head: () => {
          throw new Error("The pull request's new commits conflict with the card's fix, so nothing was merged.");
        },
      },
    });
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Bring in the new commits" }));
    expect(await screen.findByText("The new commits weren't brought in.")).toBeTruthy();
    rerender(<PrReviewPanel card={other} onOpenSession={() => {}} />);
    expect(screen.queryByText("The new commits weren't brought in.")).toBeNull();
  });

  it("with the Builder's session open, Bring in the new commits says why it waits on the page, with Close the Builder session", async () => {
    const { user } = renderUi(<PrReviewPanel card={under({ ptyId: "pty-1" })} onOpenSession={() => {}} />, { fixtures });
    expect(primary()?.textContent).toBe("Close the Builder session");
    expect(screen.getByText(/Bring in the new commits waits while the Builder's session is open/)).toBeTruthy();
    const bring = await press(user, "Bring in the new commits");
    expect(bring.disabled).toBe(true);
  });

  it("after a conflict Resume the Builder is the next step, and the same merge waits until the head or the fix moves", async () => {
    const conflicted = under({}, { mergeConflict: { head: NEXT, fix: FIX } });
    const { unmount, user } = renderUi(<PrReviewPanel card={conflicted} onOpenSession={() => {}} />, { fixtures });
    expect(primary()?.textContent).toBe("Resume the Builder");
    expect(screen.getByText(/would conflict again\. Resume the Builder and ask it to merge 222222222222/)).toBeTruthy();
    const bring = await press(user, "Bring in the new commits");
    expect(bring.disabled).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Fix with the Builder" })).toBeNull();
    unmount();
    // The pull request moved on: Bring in is the next step again.
    renderUi(<PrReviewPanel card={under({}, { headSha: "4".repeat(40), mergeConflict: { head: NEXT, fix: FIX } })} onOpenSession={() => {}} />, { fixtures });
    expect(primary()?.textContent).toBe("Bring in the new commits");
    expect(primary()?.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Resume the Builder" })).toBeNull();
  });

  it("after Bring in the new commits built the merge: Send the fixes to GitHub is the press, no Review again, and the Activity says the merge", () => {
    const merge = "5".repeat(40);
    const built = {
      ...card(
        { pushable: true, fixNote: null, headSha: NEXT, branchHead: NEXT, heads: [1], headMark: 2, merged: true, merges: [{ head: NEXT, at: 10, snapshot: 3 }], fixStarts: [2, 6] },
        {
          startedAt: 6,
          snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 7 }, { n: 3, sha: merge, at: 11 }],
          review: review({ snapshotN: 3 }),
        },
      ),
      verifyStatus: "passed",
    } as KanbanCard;
    expect(reviewOffer(built)).toBe("current");
    expect(prReviewLabel(built)).toBe("Fix ready to push");
    renderUi(<PrReviewPanel card={built} onOpenSession={() => {}} />, { fixtures });
    expect(screen.queryByRole("button", { name: "Review again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send the fixes to GitHub" }).className).toContain("accent");
    const words = cardTimeline(built).map((i) => String(i.text));
    expect(words).toContain("Read the pull request's new commits");
    expect(words).toContain("Merged the pull request's new commits");
    expect(words.filter((w) => w === "Claude fixed it")).toHaveLength(1);
    // Finding 9: each Fix with the Builder is its own entry.
    expect(words.filter((w) => w === "Claude started fixing it")).toHaveLength(2);
    // A changes-requested review of the merge says so, not "New commits to review".
    const asked = { ...built, builder: { ...built.builder!, review: review({ snapshotN: 3, verdict: "changes_requested" }) } } as KanbanCard;
    expect(prReviewLabel(asked)).toBe("Changes requested");
  });

  it("an approval on a pull request card isn't owed to a closed Builder session", () => {
    const b = builder({ startedAt: 5, review: review({ snapshotN: 1, at: 9 }), undeliveredVerdict: { snapshotN: 1, at: 9 } } as never);
    expect(verdictOwed(b, null, true)).toBeNull();
    expect(verdictOwed(b, null, false)).not.toBeNull();
    expect(verdictOwed({ ...b, ptyId: "p" }, null, true)).not.toBeNull();
  });

  it("the member's own pull request from a protected branch is review-only, and says why", () => {
    const note = "This pull request's branch is main: Plyloft reviews it but can't push fixes to it.";
    const own = card({ pushable: false, fixNote: note, headRef: "main", baseRef: "walk-base-11" });
    renderUi(<PrReviewPanel card={own} onOpenSession={() => {}} />, { fixtures });
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send the fixes to GitHub/ })).toBeNull();
    expect(chatScopeLine({ pushable: false, fixNote: note })).toContain("can't push fixes to it");
    expect(chatScopeLine({ pushable: false, fixNote: note })).not.toContain("someone else's");
  });
});

describe("walk 4 of #386", () => {
  const fixtures = {
    pr_review_refresh: () => card(),
    kanban_load: () => [card()],
  };
  // An unpushed fix (snapshot 2) built on HEAD; NEXT on GitHub conflicted.
  const conflicted = () =>
    card(
      { pushable: true, fixNote: null, headSha: NEXT, branchHead: HEAD, heads: [1], headMark: 1, mergeConflict: { head: NEXT, fix: FIX } },
      { startedAt: 5, snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );

  it("the Builder's own merge of the new commits, once Build done took the head in, is a fix ready to push and says the merge", () => {
    const merge = "5".repeat(40);
    // As the backend writes it (`adopt_head_in_fix`): the head in, the
    // conflict gone, snapshot 3 the merge; a resumed session is its own start.
    const built = {
      ...card(
        { pushable: true, fixNote: null, headSha: NEXT, branchHead: NEXT, heads: [1], headMark: 2, merges: [{ head: NEXT, at: 4, snapshot: 3 }], fixStarts: [5, 9] },
        { startedAt: 5, snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }, { n: 3, sha: merge, at: 11 }], review: review({ snapshotN: 3 }) },
      ),
      verifyStatus: "passed",
    } as KanbanCard;
    expect(prReviewLabel(built)).toBe("Fix ready to push");
    expect(pushOffered(built)).toBe(true);
    const items = cardTimeline(built);
    const words = items.map((i) => String(i.text));
    expect(words).toContain("Read the pull request's new commits");
    expect(words).toContain("Merged the pull request's new commits");
    expect(words.filter((w) => w === "Claude fixed it")).toHaveLength(1);
    // The first start and the resume, the newest with Open session.
    const starts = items.filter((i) => i.text === "Claude started fixing it");
    expect(starts.map((i) => i.at)).toEqual([5, 9]);
    expect(starts.map((i) => Boolean(i.link))).toEqual([false, true]);
  });

  it("a review-only card's Activity has no Open session", () => {
    const note = "This pull request's branch is main: Plyloft reviews it but can't push fixes to it.";
    const items = cardTimeline(card({ pushable: false, fixNote: note, fixStarts: [5] }, { startedAt: 5 }));
    const start = items.find((i) => i.text === "Claude started fixing it");
    expect(start).toBeTruthy();
    expect(start!.link).toBeUndefined();
  });

  it("with the alert of a failed press, the conflict's guidance stays on the page", async () => {
    const { user, tauri } = renderUi(<PrReviewPanel card={conflicted()} onOpenSession={() => {}} />, {
      fixtures: {
        ...fixtures,
        builder_resume: () => {
          throw new Error("The Builder's session couldn't start.");
        },
      },
    });
    tauri.allowUnhandled();
    await user.click(screen.getByRole("button", { name: "Resume the Builder" }));
    expect(await screen.findByText("The Builder didn't resume.")).toBeTruthy();
    expect(screen.getByText(/would conflict again\. Resume the Builder and ask it to merge 222222222222/)).toBeTruthy();
  });
});

describe("Mac walk 2026-10-17 of #386", () => {
  const PLAIN = "0e8982b4" + "4".repeat(32);
  // Card #26: the fix (snapshot 2) pushed, then two plain commits on GitHub,
  // read by a Sync — as the backend now writes it: no `merges` entry.
  const pushedThenMoved = (over: Partial<PrReview> = {}) =>
    card(
      { pushable: true, fixNote: null, headSha: PLAIN, branchHead: FIX, heads: [1], headMark: 2, pushes: [{ sha: FIX, over: HEAD, at: 4 }], ...over },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }], review: review({ snapshotN: 2 }) },
    );

  it("new commits on top of a pushed fix are new commits to review: Review again, not Bring in the new commits", async () => {
    const moved = pushedThenMoved();
    expect(mergeOffered(moved)).toBe(false);
    expect(pushOffered(moved)).toBe(false);
    expect(reviewOffer(moved)).toBe("newCommits");
    expect(prReviewLabel(moved)).toBe("New commits to review");
    expect(reviewPressLabel(reviewOffer(moved), moved)).toBe("Review again");
    renderUi(<PrReviewPanel card={moved} onOpenSession={() => {}} />, {
      fixtures: { pr_review_refresh: () => moved, kanban_load: () => [moved] },
    });
    expect(screen.getByRole("button", { name: "Review again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bring in the new commits" })).toBeNull();
    expect(screen.queryByText("New commits under your fix")).toBeNull();
  });

  it("after Review again the Activity says the new commits were read, once, and nothing merged", () => {
    const reviewed = card(
      { pushable: true, fixNote: null, headSha: PLAIN, branchHead: PLAIN, heads: [1, 3], headMark: 3, pushes: [{ sha: FIX, over: HEAD, at: 4 }] },
      { snapshots: [{ n: 1, sha: HEAD, at: 1 }, { n: 2, sha: FIX, at: 3 }, { n: 3, sha: PLAIN, at: 6 }], review: review({ snapshotN: 3, status: "running", verdict: undefined }) },
    );
    const words = cardTimeline(reviewed).map((i) => String(i.text));
    expect(words.filter((w) => w === "Read the pull request's new commits")).toHaveLength(1);
    expect(words.some((w) => w.startsWith("Merged the pull request's new commits"))).toBe(false);
  });

  it("a pushed fix the pull request was force-pushed off is a head to review again, not Approved", () => {
    // The fix (snapshot 2) pushed, then the branch on GitHub went back to HEAD.
    const off = pushedThenMoved({ headSha: HEAD });
    expect(mergeOffered(off)).toBe(false);
    expect(pushOffered(off)).toBe(false);
    expect(reviewOffer(off)).toBe("newCommits");
    expect(prReviewLabel(off)).toBe("New commits to review");
    expect(reviewPressLabel(reviewOffer(off), off)).toBe("Review again");
    // Still on the pushed fix: approved, as before.
    expect(prReviewLabel(pushedThenMoved({ headSha: FIX }))).toBe("Approved");
  });
});
