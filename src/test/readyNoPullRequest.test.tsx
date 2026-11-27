// 1.169.1 walk (D1, R10): a card Ready to ship on a project that can't open
// pull requests says why under its Ship it — the result, which says it too,
// is closed in that state. A GitHub project says nothing.
import { describe, expect, it, vi } from "vitest";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { NO_REMOTE_WORDS, originElsewhereWords } from "../components/OutcomeScreen";
import type { CardOutcome } from "../ipc";
import { useUi } from "../store/uiStore";
import { BOARD_WS, boardCard, seedBoard } from "./boardFixtures";
import { fireEvent, renderUi, screen, waitFor, within } from "./render";
import { ONLY_ON_THIS_MAC } from "../lib/putOnGithub";
import { PutOnGithubHost } from "../components/PutOnGithubSheet";

vi.mock("../components/CardReviewPanel", () => ({ CardReviewPanel: () => <div data-testid="review-diff" /> }));
vi.mock("../components/BuilderSession", () => ({ BuilderSession: () => <div data-testid="builder-terminal" /> }));

const base: CardOutcome = { filesChanged: 2, verifyConfigured: false, isRecon: false, reconVerdictNegative: false };

function renderReady(outcome: CardOutcome, extra: Record<string, unknown> = {}) {
  const card = boardCard("c1", {
    notes: "x",
    columnId: "complete",
    lastRunStatus: "success",
    verifyStatus: "passed",
    worktreePath: "/tmp/ply-test/c1",
    branchName: "card/c1",
  });
  seedBoard([card]);
  useUi.setState({ selectedCardId: { [BOARD_WS]: card.id }, centerMode: { [BOARD_WS]: "board" }, cardStep: {}, cardDiffOpen: {} });
  const view = renderUi(
    <>
      <CardDetailPanel workspaceId={BOARD_WS} />
      <PutOnGithubHost />
    </>,
    {
    fixtures: {
      card_outcome: outcome,
      card_overlap_check: [],
      reviewer_list: [],
      verify_status: null,
      improvement_proposal_state: null,
      improvement_proposal_trust_stopped: null,
      ship_pending_release: { release: null, unreadable: null },
      card_review_tip: null,
      ...extra,
    },
  });
  view.tauri.allowUnhandled();
  return view;
}

const now = () => document.querySelector<HTMLElement>('section[aria-label="Now"]');

describe("Ready to ship where no pull request can be opened (1.169.1 walk)", () => {
  it("says why under Ship it on a project whose origin is on gitlab.com", async () => {
    renderReady({ ...base, hasRemote: false, originHost: "gitlab.com" });
    await waitFor(() => expect(now()?.getAttribute("data-ply-state-headline")).toBe("ready-to-ship"));
    await waitFor(() =>
      expect(now()!.querySelector('[data-ply-no-remote="now"]')?.textContent).toBe(originElsewhereWords("gitlab.com")),
    );
  });

  it("says why on a project with no origin — and, GitHub not connected, Connect GitHub first", async () => {
    renderReady({ ...base, hasRemote: false }, { setup_github_status: () => ({ accounts: [] }) });
    await waitFor(() =>
      expect(now()?.querySelector('[data-ply-no-remote="now"]')?.textContent).toBe(ONLY_ON_THIS_MAC),
    );
    // 1.175.0 F3: the approved row starts with CL-11's sentence.
    expect(ONLY_ON_THIS_MAC.startsWith(NO_REMOTE_WORDS)).toBe(true);
    expect(await within(now()!).findByRole("button", { name: "Connect GitHub first" })).toBeTruthy();
  });

  it("1.175.0 F3: GitHub connected, Put it on GitHub… opens its sheet, focus on Cancel, nothing run", async () => {
    const view = renderReady(
      { ...base, hasRemote: false },
      {
        setup_github_status: () => ({ accounts: [{ login: "octocat", active: true, state: "signed-in", scopes: null }] }),
        put_on_github_preview: () => ({ branch: "main", commits: 42, unsavedFiles: 3, name: "lyra" }),
      },
    );
    const press = await within(now()!).findByRole("button", { name: "Put it on GitHub…" });
    fireEvent.click(press);
    const sheet = await screen.findByRole("dialog", { name: /on GitHub\?/ });
    expect(within(sheet).getByText("octocat")).toBeTruthy();
    expect(within(sheet).getByText("Only you. It's private; you can change that on GitHub.")).toBeTruthy();
    expect(
      within(sheet).getByText("main, with its 42 commits. Changes not saved in Git stay on this Mac (3 files)."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Cancel" })));
    expect(view.tauri.callsOf("put_on_github").length).toBe(0);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /on GitHub\?/ })).toBeNull());
    expect(view.tauri.callsOf("put_on_github").length).toBe(0);
  });

  it("1.175.0 F3: on another host, no Put it on GitHub…", async () => {
    renderReady(
      { ...base, hasRemote: false, originHost: "gitlab.com" },
      { setup_github_status: () => ({ accounts: [{ login: "octocat", active: true, state: "signed-in", scopes: null }] }) },
    );
    await waitFor(() =>
      expect(now()!.querySelector('[data-ply-no-remote="now"]')?.textContent).toBe(originElsewhereWords("gitlab.com")),
    );
    expect(within(now()!).queryByRole("button", { name: /Put it on GitHub|Connect GitHub first/ })).toBeNull();
  });

  it("says nothing on a GitHub project", async () => {
    renderReady({ ...base, hasRemote: true });
    await waitFor(() => expect(now()?.getAttribute("data-ply-state-headline")).toBe("ready-to-ship"));
    // The Ship ▾ choices are there once the result has loaded.
    await waitFor(() => expect(now()!.querySelector('[aria-label^="Other ways"]')).toBeTruthy());
    expect(now()!.querySelector('[data-ply-no-remote="now"]')).toBeNull();
  });
});
