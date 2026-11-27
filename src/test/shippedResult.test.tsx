// QoL 1.168 (C8, C15): a shipped card's "The result" says what shipped — its
// files, its checks, the Challenger's word — never an empty section; and the
// Shipping section never says "Nothing has shipped yet" while a ship runs.
import { describe, expect, it } from "vitest";
import { OutcomeScreen } from "../components/OutcomeScreen";
import { CardShipStep } from "../components/CardShipStep";
import { VerifyPanel } from "../components/VerifyPanel";
import type { KanbanCard } from "../ipc";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen, within } from "./render";

const WS = "ws-1";
const shipped: KanbanCard = {
  id: "card-1",
  workspaceId: WS,
  title: "Add a tagline",
  columnId: "complete",
  shipStatus: "shipped",
  verifyStatus: "passed",
  worktreePath: null,
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  shipHistory: [{ commitSha: "0123456789abcdef0123456789abcdef01234567", shippedVersion: "1.2.0", releaseKind: "local", shippedAt: new Date(2026, 9, 21).getTime() }],
  verifyHistory: [
    { verifyRunId: "r1", status: "passed", endedAt: 1, steps: [{ kind: "npm test", passed: true, elapsedMs: 4000 }] },
  ],
  createdAt: 1,
  updatedAt: 1,
} as unknown as KanbanCard;

function seed() {
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "notes-app", cwd: "/tmp/ply-test" } as never], activeId: WS });
}

describe("a shipped card's result (C8)", () => {
  it("lists the shipped commit's files and the checks that ran", async () => {
    seed();
    const { tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={shipped} />, {
      fixtures: {
        card_shipped_changes: {
          commit: shipped.commitSha,
          subject: "Land card: Add a tagline",
          files: [
            { path: "src/App.tsx", added: 4, removed: 1 },
            { path: "logo.png", added: null, removed: null },
          ],
          totalFiles: 2,
          sharedWith: 0,
        },
      },
    });
    tauri.allowUnhandled();
    // 1.171.0 B1 (Challenger 6): a land here says where it is.
    expect(screen.getByText(/^Shipped as v1\.2\.0, only on this Mac, on 21 Oct/)).toBeTruthy();
    const files = await screen.findByRole("list", { name: "The files that shipped" });
    expect(within(files).getByText("src/App.tsx")).toBeTruthy();
    expect(within(files).getByText("+4 −1")).toBeTruthy();
    expect(within(files).getByText("binary")).toBeTruthy();
    expect(screen.getByText(/2 files changed — Land card: Add a tagline\./)).toBeTruthy();
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("Passed")).toBeTruthy();
    expect(within(checks).getByText("npm test")).toBeTruthy();
    expect(tauri.callsOf("card_shipped_changes")).toHaveLength(1);
  });

  // 1.172.0 D2 (CP-26, walk#6): a step's name, never its kind; and with no
  // checks set up the facts line says so — the receipt doesn't again.
  it("names a step by its name, and has no Checks block when none are set up", () => {
    seed();
    const named = {
      ...shipped,
      verifyHistory: [{ verifyRunId: "r1", status: "passed", endedAt: 1, steps: [{ kind: "claude-qa", passed: true, elapsedMs: 1 }] }],
    } as unknown as KanbanCard;
    const { tauri, unmount } = renderUi(<OutcomeScreen workspaceId={WS} card={named} />, { fixtures: { card_shipped_changes: null } });
    tauri.allowUnhandled();
    const checks = screen.getByRole("region", { name: "Checks" });
    expect(within(checks).getByText("Claude's review").getAttribute("title")).toBe("claude-qa");
    expect(within(checks).queryByText("claude-qa")).toBeNull();
    unmount();
    const none = { ...shipped, verifyHistory: [{ verifyRunId: "r1", status: "passed", endedAt: 1, steps: [] }] } as unknown as KanbanCard;
    renderUi(<OutcomeScreen workspaceId={WS} card={none} />, { fixtures: { card_shipped_changes: null } }).tauri.allowUnhandled();
    expect(screen.queryByRole("region", { name: "Checks" })).toBeNull();
  });

  it("says a merged pull request merged, with its title, never a version it didn't release (D8)", async () => {
    seed();
    const merge = "fedcba9876543210fedcba9876543210fedcba98";
    const mergedPr = {
      ...shipped,
      title: "Notes page",
      reviewStatus: "merged",
      commitSha: merge,
      shippedVersion: "1.0.0",
      prUrl: "https://github.com/o/notes-app/pull/122",
      pr: {
        number: 122, state: "merged", checks: "passing", checksTotal: 1, checksPassed: 1, checksPending: 0,
        failingChecks: [], mergeable: "unknown", reviewDecision: "none", mergeCommit: merge,
        mergedAt: new Date(2026, 9, 21).getTime(), title: "Add a notes page",
      },
      shipHistory: [{ commitSha: merge, shippedVersion: "1.0.0", releaseKind: "local", shippedAt: new Date(2026, 9, 21).getTime() }],
    } as unknown as KanbanCard;
    const { tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={mergedPr} />, {
      fixtures: {
        card_shipped_changes: {
          commit: merge,
          subject: "chore: snapshot 1 for Notes page (#122)",
          files: [{ path: "notes.md", added: 3, removed: 0 }],
          totalFiles: 1,
          sharedWith: 0,
        },
      },
    });
    tauri.allowUnhandled();
    expect(await screen.findByText(/1 file changed — Add a notes page\./)).toBeTruthy();
    expect(screen.getByText(/^Merged on GitHub as pull request #122 on 21 Oct/)).toBeTruthy();
    expect(screen.queryByText(/Shipped as v1\.0\.0/)).toBeNull();
    expect(screen.queryByText(/chore: snapshot 1/)).toBeNull();
  });

  it("says a batch release is shared, never listing the release's files as this card's", async () => {
    seed();
    const { tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={shipped} />, {
      fixtures: {
        card_shipped_changes: { commit: shipped.commitSha, subject: "Release v1.2.0", files: [], totalFiles: 0, sharedWith: 2 },
      },
    });
    tauri.allowUnhandled();
    expect(await screen.findByText(/^Shipped in a release with 2 other cards\./)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "The files that shipped" })).toBeNull();
  });

  it("says in words when the shipped commit isn't on this computer, never raw git", async () => {
    seed();
    const { tauri } = renderUi(<OutcomeScreen workspaceId={WS} card={shipped} />, {
      fixtures: {
        card_shipped_changes: () => {
          throw new Error("The shipped commit isn't in this computer's copy of the project yet (it may have been merged on GitHub and not pulled here).");
        },
      },
    });
    tauri.allowUnhandled();
    expect(await screen.findByText(/The shipped commit isn't in this computer's copy/)).toBeTruthy();
  });
});

describe("Watch it ship (C15)", () => {
  it("says it is shipping, not that nothing has shipped", () => {
    seed();
    const card = { ...shipped, shipStatus: undefined, shipHistory: [], commitSha: null, worktreePath: "/tmp/wt" } as unknown as KanbanCard;
    const { tauri, rerender } = renderUi(<CardShipStep card={card} onOpenRelease={() => {}} shipping />);
    tauri.allowUnhandled();
    expect(screen.getByText("Shipping now. This fills in when it's done.")).toBeTruthy();
    expect(screen.queryByText(/Nothing has shipped yet/)).toBeNull();
    rerender(<CardShipStep card={card} onOpenRelease={() => {}} />);
    expect(screen.getByText(/Nothing has shipped yet/)).toBeTruthy();
  });
});

describe("A merged pull request's ship history (D8)", () => {
  it("names the pull request and never the version stamped at the merge", async () => {
    seed();
    const merge = "fedcba9876543210fedcba9876543210fedcba98";
    const card = {
      ...shipped,
      reviewStatus: "merged",
      commitSha: merge,
      prUrl: "https://github.com/o/notes-app/pull/122",
      pr: {
        number: 122, state: "merged", checks: "passing", checksTotal: 1, checksPassed: 1, checksPending: 0,
        failingChecks: [], mergeable: "unknown", reviewDecision: "none", mergeCommit: merge, title: "Add a notes page",
      },
      shipHistory: [{ commitSha: merge, shippedVersion: "1.0.0", releaseKind: "local", shippedAt: new Date(2026, 9, 21).getTime() }],
    } as unknown as KanbanCard;
    const { tauri } = renderUi(<CardShipStep card={card} onOpenRelease={() => {}} />);
    tauri.allowUnhandled();
    const history = await screen.findByRole("region", { name: "Ship history" });
    expect(within(history).getByText("Pull request #122")).toBeTruthy();
    expect(within(history).queryByText("1.0.0")).toBeNull();
    expect(within(history).getByText(merge)).toBeTruthy();
  });
});

describe("Checks failed in the result (Reviewer block 5, item 6)", () => {
  const failed = {
    ...shipped,
    shipStatus: undefined,
    verifyStatus: "failed",
    worktreePath: "/tmp/wt",
    builder: { vendor: "claude", bypass: false, sessionLost: false, startedAt: 1, snapshots: [{ n: 1, sha: "s1", at: 1 }] },
    verifyHistory: [{ verifyRunId: "r1", status: "failed", endedAt: 1, steps: [{ kind: "npm test", passed: false, elapsedMs: 1, reason: "boom" }] }],
  } as unknown as KanbanCard;

  it("offers Fix with the Builder, unless the Now box already does", async () => {
    seed();
    const first = renderUi(<VerifyPanel card={failed} />, { fixtures: { verify_status: null } });
    first.tauri.allowUnhandled();
    expect(await screen.findByRole("button", { name: "Fix with the Builder" })).toBeTruthy();
    first.unmount();
    const second = renderUi(<VerifyPanel card={failed} offerFix={false} />, { fixtures: { verify_status: null } });
    second.tauri.allowUnhandled();
    expect(screen.queryByRole("button", { name: "Fix with the Builder" })).toBeNull();
  });
});
