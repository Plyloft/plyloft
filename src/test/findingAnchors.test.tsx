// CL-6: the Challenger's findings on the review diff — under the line they
// name with their state in words, P3 collapsed, "This line changed since
// the review" when the fix moved it, findings without a line in the list
// only, and the list and the diff linking to each other.
import { beforeEach, describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { act, waitFor } from "@testing-library/react";
import { CardReviewPanel } from "../components/CardReviewPanel";
import { ChallengerFindings } from "../components/ChallengerFindings";
import type { BuilderReview, FindingAnchor, KanbanCard, LedgerFinding, ReviewDiff } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { useUi } from "../store/uiStore";
import { renderUi, screen } from "./render";

const WS = "ws-1";

const card: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Tidy the parser",
  columnId: "in_progress",
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  builder: { vendor: "claude", bypass: false, ptyId: "pty-1", sessionLost: false, startedAt: 1, snapshots: [] },
  createdAt: 1,
  updatedAt: 1,
} as KanbanCard;

const anchor = (over: Partial<FindingAnchor>): FindingAnchor => ({
  id: "F1",
  severity: "P2",
  state: "open",
  nonBlocking: false,
  title: "Loses edits",
  body: "Saving twice drops the first edit.",
  reason: null,
  round: 1,
  updatedRound: 1,
  path: "src/a.ts",
  reviewedLine: 11,
  line: 11,
  fate: "same",
  ...over,
});

const diff: ReviewDiff = {
  cardId: "card-1",
  baseBranch: "main",
  cardBranch: "card/card-1",
  generatedAt: 1,
  files: [
    {
      path: "src/a.ts",
      kind: "modified",
      hunks: [
        { header: "@@ -10,3 +10,4 @@", oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, body: " keep\n-gone\n+new a\n+new b\n tail\n" },
      ],
    },
  ],
  anchors: [
    anchor({}),
    anchor({ id: "F2", severity: "P3", nonBlocking: true, title: "Naming", body: "Call it saveOnce.", line: 13 }),
    anchor({ id: "F4", severity: "P1", state: "still-open", updatedRound: 2, reason: "Still races.", title: "Races", body: "Two saves race.", reviewedLine: 25, line: 12, fate: "changed" }),
    anchor({ id: "F5", path: "src/untouched.ts", title: "Old bug", line: 3 }),
    anchor({ id: "F6", nonBlocking: true, preExisting: true, title: "Old leak", body: "Leaks a handle.", reviewedLine: 10, line: 10 }),
  ],
};

const ledgerFinding = (id: string, title: string, over: Partial<LedgerFinding> = {}): LedgerFinding => ({
  id,
  severity: "P2",
  preExisting: false,
  location: null,
  reason: null,
  title,
  body: `${title}, in full.`,
  reviewId: "rev-1",
  round: 1,
  state: "open",
  updatedRound: 1,
  ...over,
});

const review: BuilderReview = {
  snapshotN: 2,
  provider: "codex",
  degraded: false,
  status: "done",
  verdict: "changes_requested",
  reviewId: "rev-2",
  at: 1,
  ledger: [
    ledgerFinding("F1", "Loses edits", { path: "src/a.ts", line: 11, reviewedRevision: "abc" }),
    ledgerFinding("F2", "Naming", { severity: "P3", note: true, path: "src/a.ts", line: 13 }),
    ledgerFinding("F3", "No tests for the parser"),
    ledgerFinding("F4", "Races", { severity: "P1", state: "still-open", updatedRound: 2 }),
    ledgerFinding("F5", "Old bug"),
  ],
};

function Page() {
  const c = useKanban((s) => s.byWorkspace[WS]?.cards[0]);
  return c ? (
    <>
      <ChallengerFindings card={c} review={review} />
      <details data-testid="see-the-diff">
        <summary>See the diff</summary>
        <CardReviewPanel workspaceId={WS} card={c} />
      </details>
    </>
  ) : null;
}

const anchorEl = (id: string) => document.querySelector(`[data-ply-diff-anchor="${id}"]`) as HTMLElement | null;

// PR #375: the panel reads a Builder card's branch tip (none here).
beforeEach(() => tauri().fixture("card_review_tip", null));

describe("Reviewer findings on the diff (CL-6)", () => {
  beforeEach(() => {
    useUi.setState({ reviewRoundFilter: {}, findingFocus: null, diffAnchorIds: {}, findingLists: {} });
    useKanban.setState({ byWorkspace: { [WS]: { cards: [card], loaded: true } } } as never);
  });

  it("puts each finding under its line, with its state in words, P3 collapsed", async () => {
    renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    // Under the added line 11 (row 2), not inside the lines' listbox.
    const f1 = anchorEl("F1")!;
    expect(f1.closest("[role=listbox]")).toBeNull();
    const run = f1.closest(".card-review-anchors")!.previousElementSibling!;
    expect(run.lastElementChild!.getAttribute("data-ply-diff-row")).toBe("2");
    expect(f1.getAttribute("aria-label")).toBe("Reviewer finding F1, should fix, open, line 11");
    expect(f1.textContent).toContain("F1 · Should fix — Loses edits");
    expect(f1.textContent).toContain("Open");
    // A P2 that asks for changes shows its text.
    const f1Toggle = screen.getByRole("button", { name: /F1 · Should fix — Loses edits/ });
    expect(f1Toggle.getAttribute("aria-expanded")).toBe("true");
    expect(f1.textContent).toContain("Saving twice drops the first edit.");
    // CL-11 (walks): the header counts lines, not files by kind.
    expect(document.querySelector("[data-ply-review-summary]")?.textContent).toBe("1 file changed · +2 −1");
    // The P3 is one line until opened.
    const f2 = anchorEl("F2")!;
    const f2Toggle = screen.getByRole("button", { name: /F2 · Minor — Naming · Small note · nothing to do/ });
    expect(f2Toggle.getAttribute("aria-expanded")).toBe("false");
    expect(f2.textContent).not.toContain("Call it saveOnce.");
    f2Toggle.click();
    await waitFor(() => expect(anchorEl("F2")!.textContent).toContain("Call it saveOnce."));
    expect(f2Toggle.getAttribute("aria-expanded")).toBe("true");
    // The line comments keep their own look: the anchor is not a line.
    expect(f1.classList.contains("card-review-line")).toBe(false);
    // Every line is still an option, in runs cut by the findings; a later
    // run's list is named as the hunk's, continued.
    expect(screen.getAllByRole("option")).toHaveLength(5);
    const lists = screen.getAllByRole("listbox").map((l) => l.getAttribute("aria-label"));
    expect(lists[0]).toBe("Lines of src/a.ts, @@ -10,3 +10,4 @@");
    expect(lists.slice(1).every((label) => label === "Lines of src/a.ts, @@ -10,3 +10,4 @@, continued")).toBe(true);
    // A pre-existing P2 is named so and starts collapsed, like a P3.
    const f6Toggle = screen.getByRole("button", { name: /F6 · Should fix — pre-existing — Old leak · Small note · nothing to do/ });
    expect(f6Toggle.getAttribute("aria-expanded")).toBe("false");
    expect(anchorEl("F6")!.textContent).not.toContain("Leaks a handle.");
  });

  it("says the line changed since the review, and shows findings on files the diff doesn't show", async () => {
    renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F4")).toBeTruthy());
    const f4 = anchorEl("F4")!;
    expect(f4.getAttribute("data-ply-anchor-fate")).toBe("changed");
    expect(f4.textContent).toContain("This line changed since the review. It was line 25.");
    expect(f4.textContent).toContain("Still open");
    expect(f4.textContent).toContain("Raised in round 1 · still open after round 2: Still races.");
    const elsewhere = document.querySelector("[data-ply-anchors-elsewhere]")!;
    expect(elsewhere.textContent).toContain("Findings on files these changes don't touch");
    expect(elsewhere.textContent).toContain("src/untouched.ts");
    expect(elsewhere.contains(anchorEl("F5"))).toBe(true);
    expect(document.querySelector("[data-ply-anchor-intro]")!.textContent).toContain(
      "The Reviewer's 5 findings are under the lines they name.",
    );
  });

  it("keeps a finding without a line in the list only", async () => {
    renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    expect(document.querySelector("[data-ply-finding-id='F3']")).toBeTruthy();
    expect(anchorEl("F3")).toBeNull();
    // Waited for, as the test below does: under load the list's button can
    // come after the diff's anchor (stress run of the chat follow-ups).
    expect(await screen.findByRole("button", { name: "Show F1 in the changes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show F3 in the changes" })).toBeNull();
  });

  // F3/F9 review (deflake): under a loaded machine the full-page `getByRole`
  // walks alone outran the 1 s default waits. Each step now waits for the one
  // thing it needs — the button, then the focus the effect gives it — with a
  // bound that load cannot reach, and the test its own budget.
  const SLOW = { timeout: 8000 };
  it("links the list and the diff both ways", async () => {
    const { user } = renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F2")).toBeTruthy(), SLOW);
    const seeTheDiff = screen.getByTestId("see-the-diff") as HTMLDetailsElement;
    expect(seeTheDiff.open).toBe(false);
    // From the list to the P3 on the diff: the diff opens, the finding opens and takes the focus.
    await user.click(await screen.findByRole("button", { name: "Show F2 in the changes" }, SLOW));
    const f2Toggle = anchorEl("F2")!.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(f2Toggle.textContent).toMatch(/F2 · Minor — Naming/);
    await waitFor(() => expect(document.activeElement).toBe(f2Toggle), SLOW);
    expect(seeTheDiff.open).toBe(true);
    expect(f2Toggle.getAttribute("aria-expanded")).toBe("true");
    // Back to the list: the finding's disclosure opens and takes the focus.
    await user.click(await screen.findByRole("button", { name: "Show F2 in the findings list" }, SLOW));
    const item = document.querySelector("[data-ply-finding-id='F2'] details") as HTMLDetailsElement;
    await waitFor(() => expect(document.activeElement).toBe(item.querySelector("summary")), SLOW);
    expect(item.open).toBe(true);
    expect(useUi.getState().findingFocus).toBeNull();
  }, 20000);

  it("brings the whole list back when a round's view hides the finding", async () => {
    useUi.getState().setReviewRoundFilter(card.id, { round: 2, ids: ["F4"], reviewId: "rev-2" });
    const { user } = renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    expect(document.querySelector("[data-ply-finding-id='F1']")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show F1 in the findings list" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector("[data-ply-finding-id='F1'] summary")),
    );
    expect(useUi.getState().reviewRoundFilter[card.id]).toBeUndefined();
  });

  it("drops an ask for a finding nothing shows", async () => {
    renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    act(() => useUi.getState().focusFinding({ cardId: card.id, findingId: "F9", to: "diff" }));
    await waitFor(() => expect(useUi.getState().findingFocus).toBeNull());
    // A list whose ledger doesn't hold the finding leaves the ask alone.
    act(() => useUi.getState().focusFinding({ cardId: card.id, findingId: "F9", to: "list" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useUi.getState().findingFocus?.findingId).toBe("F9");
    act(() => useUi.getState().focusFinding(null));
  });

  it("lets an unclaimed ask expire, so a list mounted later doesn't take the focus", async () => {
    const { rerender } = renderUi(<CardReviewPanel workspaceId={WS} card={card} />, {
      fixtures: { card_review_diff: diff },
    });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    act(() => useUi.getState().focusFinding({ cardId: card.id, findingId: "F1", to: "list" }));
    expect(useUi.getState().findingFocus?.findingId).toBe("F1");
    await waitFor(() => expect(useUi.getState().findingFocus).toBeNull(), { timeout: 2000 });
    rerender(<ChallengerFindings card={card} review={review} />);
    const summary = document.querySelector("[data-ply-finding-id='F1'] summary");
    expect(summary).toBeTruthy();
    expect(document.activeElement).not.toBe(summary);
    // A consumer ignores an ask older than the limit, even one still stored.
    useUi.setState({ findingFocus: { cardId: card.id, findingId: "F2", to: "list", at: Date.now() - 5000 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).not.toBe(document.querySelector("[data-ply-finding-id='F2'] summary"));
    expect((document.querySelector("[data-ply-finding-id='F2'] details") as HTMLDetailsElement).open).toBe(false);
  });

  // Walk of #386 (step 4): someone else's pull request's diff has no line
  // comments, so its legend names only the Challenger's findings.
  it("on someone else's pull request, the legend has no line comments", async () => {
    const pr: KanbanCard = {
      ...card,
      builder: { ...card.builder!, ptyId: null, startedAt: 0 },
      prReview: {
        url: "https://github.com/o/r/pull/12",
        number: 12,
        repo: "o/r",
        title: "Add the retry",
        author: "octo",
        baseRef: "main",
        headRef: "retry-upload",
        headSha: "1".repeat(40),
        branchHead: "1".repeat(40),
        crossRepository: false,
        pushable: false,
        fixNote: null,
        state: "open",
        checkedAt: 1,
      },
    } as KanbanCard;
    useKanban.setState({ byWorkspace: { [WS]: { cards: [pr], loaded: true } } } as never);
    renderUi(<Page />, { fixtures: { card_review_diff: diff } });
    await waitFor(() => expect(anchorEl("F1")).toBeTruthy());
    const intro = document.querySelector("[data-ply-anchor-intro]")!.textContent!;
    expect(intro).toContain("The Reviewer's 5 findings are under the lines they name.");
    expect(intro).not.toContain("Line comments");
    expect(screen.queryByText(/Click a line to comment on it/)).toBeNull();
  });

  it("draws nothing extra for a diff without findings", async () => {
    renderUi(<Page />, { fixtures: { card_review_diff: { ...diff, anchors: undefined } } });
    await screen.findByText(/Click a line to comment on it/);
    expect(document.querySelector("[data-ply-diff-anchor]")).toBeNull();
    expect(document.querySelector("[data-ply-anchor-intro]")).toBeNull();
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /on the diff/ })).toBeNull();
  });
});
