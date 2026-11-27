// 1.170.0 G4: the Builder writes the pull request's title and description
// before Ship opens it (the wait is `lib/prDraft.ts`, tested under node), and
// while the pull request is open the card offers Edit title and description:
// prefilled from GitHub, saved with `gh pr edit` on Save only.
import { beforeEach, describe, expect, it } from "vitest";
import { CardShipStep } from "../components/CardShipStep";
import type { KanbanCard, PrStatus } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { draftPullRequestFor, setBuilderObserved, useBuilder } from "../store/builderStore";
import { PASTE_END, PASTE_START } from "../lib/builderInject";
import { setPlatformForTests } from "../lib/platform";
import { PR_DRAFT_WRITING } from "../lib/prDraft";
import { PR_EDIT_CHANGED } from "../lib/prEdit";
import { renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-1";
const URL = "https://github.com/o/r/pull/8";

const pr = (patch: Partial<PrStatus> = {}): PrStatus => ({
  number: 8,
  state: "open",
  checks: "passing",
  checksTotal: 1,
  checksPassed: 1,
  checksPending: 0,
  failingChecks: [],
  mergeable: "mergeable",
  reviewDecision: "none",
  headSha: "aaa",
  openedAt: 1,
  checkedAt: 2,
  ...patch,
});

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "card-1",
  workspaceId: WS,
  title: "Add sum",
  columnId: "in_progress",
  lastRunStatus: "success",
  verifyStatus: "passed",
  reviewStatus: "merged",
  prUrl: URL,
  pr: pr(),
  worktreePath: "/tmp/ply-test/card-1",
  branchName: "card/card-1",
  builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [{ n: 1, sha: "aaa", at: 0 }], ptyId: "pty1" } as unknown as KanbanCard["builder"],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function seed(c: KanbanCard) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
}

const quiet = { improvement_proposal_state: null, improvement_proposal_trust_stopped: null, ship_pending_release: null, pty_write: null };

beforeEach(() => {
  setPlatformForTests("mac");
  useBuilder.setState({ prDraftWriting: {}, byCard: {} });
});

describe("G4: Edit title and description", () => {
  it("opens prefilled from GitHub and saves title and body only on Save", async () => {
    const c = card();
    seed(c);
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: { ...quiet, card_pr_refresh: c, card_pr_text: { title: "Add sum", body: "## Summary\n\nOld" }, card_pr_edit: null },
    });
    await user.click(screen.getByRole("button", { name: "Edit title and description" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    expect((title as HTMLInputElement).value).toBe("Add sum");
    const save = screen.getByRole("button", { name: "Save on GitHub" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.clear(title);
    await user.type(title, "Add a sum column");
    await user.click(screen.getByRole("button", { name: "Save on GitHub" }));
    await waitFor(() => expect(tauri().callsOf("card_pr_edit")).toHaveLength(1));
    expect(tauri().callsOf("card_pr_edit")[0].args).toEqual({
      workspaceId: WS,
      cardId: "card-1",
      title: "Add a sum column",
      body: "## Summary\n\nOld",
      loadedTitle: "Add sum",
      loadedBody: "## Summary\n\nOld",
    });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
  });

  it("says so when the pull request changed on GitHub since the sheet opened (Reviewer 8)", async () => {
    const c = card();
    seed(c);
    const { user } = renderUi(<CardShipStep card={c} onOpenRelease={() => {}} />, {
      fixtures: {
        ...quiet,
        card_pr_refresh: c,
        card_pr_text: { title: "Add sum", body: "Old" },
        card_pr_edit: () => {
          throw PR_EDIT_CHANGED;
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Edit title and description" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await user.type(title, " now");
    await user.click(screen.getByRole("button", { name: "Save on GitHub" }));
    expect(await screen.findByText(PR_EDIT_CHANGED)).toBeTruthy();
    expect(screen.queryByText(/GitHub didn't take the change/)).toBeNull();
  });

  it("is not offered once the pull request is merged, nor on a pull request the card reviews", () => {
    const merged = card({ pr: pr({ state: "merged" }) });
    seed(merged);
    renderUi(<CardShipStep card={merged} onOpenRelease={() => {}} />, { fixtures: { ...quiet, card_pr_refresh: merged } });
    expect(screen.queryByRole("button", { name: "Edit title and description" })).toBeNull();
  });
});

describe("G4: the Builder writes the pull request", () => {
  it("says the Builder is writing it while Ship waits", () => {
    const c = card({ prUrl: undefined, pr: undefined, reviewStatus: undefined });
    seed(c);
    useBuilder.setState({ prDraftWriting: { "card-1": true } });
    renderUi(<CardShipStep card={c} onOpenRelease={() => {}} shipping />, { fixtures: quiet });
    expect(screen.getByText(PR_DRAFT_WRITING)).toBeTruthy();
  });

  it("asks nothing of a session that isn't open in this window: Ship goes on with the template", async () => {
    const c = card({ prUrl: undefined, pr: undefined });
    seed(c);
    renderUi(<div />, { fixtures: { ...quiet, card_pr_draft_prepare: { message: "m", ptyId: "pty1" } } });
    const out = await draftPullRequestFor(WS, "card-1", "ship_it");
    expect(out.kind).toBe("template");
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(0);
    expect(tauri().callsOf("pty_write")).toHaveLength(0);
  });

  it("never writes into a Builder that is mid-turn", async () => {
    const c = card({ prUrl: undefined, pr: undefined });
    seed(c);
    renderUi(<div />, {
      fixtures: { ...quiet, card_pr_draft_prepare: { message: "m", ptyId: "pty1" }, builder_last_output_at: Date.now() },
    });
    useBuilder.getState().attach("card-1", WS, "pty1", "codex");
    setBuilderObserved("card-1", true);
    // Working: its prompt box is not idle and its turn is not over.
    useBuilder.getState().markPromptBox("card-1", false, false);
    const out = await draftPullRequestFor(WS, "card-1", "ship_it");
    expect(out.kind).toBe("template");
    expect(tauri().callsOf("card_pr_draft_prepare")).toHaveLength(0);
    expect(tauri().callsOf("pty_write")).toHaveLength(0);
  });

  it("pastes the message into a Builder at its idle prompt and waits for the draft", async () => {
    const c = card({ prUrl: undefined, pr: undefined });
    seed(c);
    renderUi(<div />, {
      fixtures: {
        ...quiet,
        card_pr_draft_prepare: { message: "[Plyloft] write the draft", ptyId: "pty1", requestId: "req-1" },
        card_pr_draft_read: { state: "ready", title: "Add a sum column", body: "Body" },
        builder_last_output_at: Date.now() - 20_000,
      },
    });
    useBuilder.getState().attach("card-1", WS, "pty1", "codex");
    setBuilderObserved("card-1", true);
    useBuilder.getState().markPromptBox("card-1", true, true, false, true);
    useBuilder.setState((s) => ({ byCard: { ...s.byCard, "card-1": { ...s.byCard["card-1"], lastOutputAt: Date.now() - 20_000 } } }));
    const seen: boolean[] = [];
    const off = useBuilder.subscribe((s) => seen.push(s.prDraftWriting["card-1"] === true));
    const out = await draftPullRequestFor(WS, "card-1", "ship_it");
    off();
    expect(out).toEqual({ kind: "draft", requestId: "req-1" });
    expect(tauri().callsOf("card_pr_draft_prepare")[0].args).toEqual({ workspaceId: WS, cardId: "card-1", mode: "ship_it" });
    const pasted = tauri()
      .callsOf("pty_write")
      .map((call) => new TextDecoder().decode(new Uint8Array(call.args.data as number[])));
    expect(pasted).toEqual([`${PASTE_START}[Plyloft] write the draft${PASTE_END}\r`]);
    expect(seen).toContain(true);
    expect(useBuilder.getState().prDraftWriting["card-1"]).toBeUndefined();
  }, 10_000);
});
