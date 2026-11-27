// 1.175.0 F7 (UX-7; owner I9): "Turn on" in line for "Fix failing checks by
// itself" — Turn on switches this card and the project's default on and
// says where they live, with Undo (both off again; the offer stays
// answered); Not now hides it for the project; never on a review card.
import { beforeEach, describe, expect, it } from "vitest";
import type { KanbanCard } from "../ipc";
import { AutoFixOffer, useAutoFixTurnedOn } from "../components/AutoFixOffer";
import { TURNED_ON_CLOSED_LINE } from "../lib/prAutoFixOffer";
import { CardNowNote } from "../components/CardNowNote";
import { resetPrAutoFixForTests, stepCard } from "../store/prAutoFixStore";
import { useUi } from "../store/uiStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { resetToastsForTests, useToasts } from "../store/toastStore";
import { setPlatformForTests } from "../lib/platform";
import { renderUi, screen, tauri, waitFor } from "./render";

const WS = "ws-1";
const card = (patch: Partial<KanbanCard> = {}): KanbanCard =>
  ({
    id: "card-1",
    workspaceId: WS,
    title: "Add sum",
    columnId: "in_progress",
    prUrl: "https://github.com/o/r/pull/8",
    pr: { number: 8, state: "open", checks: "failing", headSha: "aaa", checkedAt: 2 },
    builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [], ptyId: "pty1", permissions: "editsCopy" },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }) as KanbanCard;

function seed(c: KanbanCard, ws: Record<string, unknown> = {}) {
  useKanban.setState({ byWorkspace: { [WS]: { cards: [c], loaded: true } } } as never);
  useWorkspaces.setState({ workspaces: [{ id: WS, name: "lyra", cwd: "/tmp/lyra", ...ws }] } as never);
}

beforeEach(() => {
  setPlatformForTests("mac");
  useAutoFixTurnedOn.setState({ cards: {} });
  resetPrAutoFixForTests();
  tauri().fixture("card_set_pr_auto_fix", (args: Record<string, unknown>) => ({ ...card(), prAutoFix: args.on }));
  tauri().fixture("workspace_set_fix_failing_checks", (args: Record<string, unknown>) => (args.on ? 5 : null));
  tauri().fixture("workspace_fix_failing_checks_offered", null);
});

describe("F7: Turn on in line", () => {
  it("Turn on switches the card and the project on; Undo switches both off", async () => {
    seed(card());
    const { user } = renderUi(<AutoFixOffer card={card()} />);
    expect(screen.getByText(/^Plyloft can do this by itself, starting with this failure:/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.getByText(/is on for this project's cards, starting with this failure, which Plyloft is fixing now/)).toBeTruthy());
    expect(tauri().callsOf("card_set_pr_auto_fix")[0].args).toMatchObject({ workspaceId: WS, cardId: "card-1", on: true });
    expect(tauri().callsOf("workspace_set_fix_failing_checks")[0].args).toEqual({ id: WS, on: true });
    expect(tauri().callsOf("workspace_fix_failing_checks_offered")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(tauri().callsOf("card_set_pr_auto_fix")).toHaveLength(2));
    expect(tauri().callsOf("card_set_pr_auto_fix")[1].args).toMatchObject({ on: false });
    expect(tauri().callsOf("workspace_set_fix_failing_checks")[1].args).toEqual({ id: WS, on: false });
    // Never a merge, never a push from here.
    expect(tauri().calls.some((c) => /merge|push/.test(c.cmd))).toBe(false);
  });

  it("Not now hides it for the project and switches nothing", async () => {
    seed(card());
    const { user } = renderUi(<AutoFixOffer card={card()} />);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull());
    expect(tauri().callsOf("workspace_fix_failing_checks_offered")).toHaveLength(1);
    expect(tauri().callsOf("card_set_pr_auto_fix")).toHaveLength(0);
    expect(useWorkspaces.getState().workspaces[0].fixFailingChecksOffered).toBe(true);
  });

  it("never on a review card, nor once answered; says when the Builder asks first", () => {
    seed(card(), { fixFailingChecksOffered: true });
    const answered = renderUi(<AutoFixOffer card={card()} />);
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    answered.unmount();
    seed(card({ prReview: { number: 3 } as never }));
    const review = renderUi(<AutoFixOffer card={card({ prReview: { number: 3 } as never })} />);
    expect(screen.queryAllByRole("button", { name: "Turn on" })).toHaveLength(0);
    review.unmount();
    const asks = card({ builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [], ptyId: "pty1", permissions: "asks" } as never });
    seed(asks);
    renderUi(<AutoFixOffer card={asks} />);
    expect(screen.getByText(/it never merges\. Codex asks before every change in this card, so its automatic fixes wait for your OK/)).toBeTruthy();
  });

  // Round 2: the project's default failed after the card's switch went on —
  // the card's goes back, so "Nothing was changed" is true.
  it("puts the card's switch back when the project's default can't be set", async () => {
    seed(card());
    tauri().fixture("workspace_set_fix_failing_checks", () => {
      throw new Error("disk full");
    });
    const { user } = renderUi(<AutoFixOffer card={card()} />);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(tauri().callsOf("card_set_pr_auto_fix")).toHaveLength(2));
    expect(tauri().callsOf("card_set_pr_auto_fix").map((c) => c.args.on)).toEqual([true, false]);
    await waitFor(() =>
      expect([...useToasts.getState().toasts, ...((useToasts.getState() as { queue?: { title: string }[] }).queue ?? [])].map((t) => t.title)).toContain(
        "Couldn't change Fix failing checks by itself",
      ),
    );
    expect(tauri().callsOf("workspace_fix_failing_checks_offered")).toHaveLength(0);
  });

  // Walk 7: with the session alive the fix starts at once, Now's primary
  // changes, and the line with Undo went with it — never seen.
  it("keeps the turned-on line with Undo after Now's primary changes, until the card is left or the try ends", async () => {
    seed(card());
    useUi.setState({ selectedCardId: { [WS]: "card-1" } } as never);
    const note = (c: KanbanCard, actionId: string) => <CardNowNote card={c} actionId={actionId} noPullRequestWords={null} onlyHere={false} />;
    const view = renderUi(note(card(), "pr-fix"));
    await view.user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    // The try starts: Now's primary is another press now.
    view.rerender(note(card({ prAutoFix: true }), "open-builder"));
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    // The try ended (its fix pushed: GitHub has another head): the line goes.
    view.rerender(note(card({ prAutoFix: true, pr: { number: 8, state: "open", checks: "pending", headSha: "bbb", checkedAt: 3 } as never }), "open-builder"));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    view.unmount();
    // Turned on again on another failure, then the person leaves the card:
    // gone, and not back on return.
    useAutoFixTurnedOn.setState({ cards: { "card-1": { workspaceId: WS, head: "aaa", at: Date.now() } } });
    const again = renderUi(note(card({ prAutoFix: true }), "open-builder"));
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    useUi.setState({ selectedCardId: { [WS]: "card-2" } } as never);
    useUi.setState({ selectedCardId: { [WS]: "card-1" } } as never);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
    again.unmount();
  });

  // Walk 7: Turn on with the Builder session closed said "which Plyloft is
  // fixing now", and nothing started.
  it("says the fix waits for the Builder session when it is closed", async () => {
    const closed = card({ builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [], ptyId: null, permissions: "editsCopy" } as never });
    seed(closed);
    const { user } = renderUi(<AutoFixOffer card={closed} />);
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy());
    expect(screen.queryByText(/which Plyloft is fixing now/)).toBeNull();
    expect(screen.getByText(TURNED_ON_CLOSED_LINE)).toBeTruthy();
  });

  // Walk 7: Turn on then Undo left the toast "…Plyloft starts once that's
  // settled…", no longer true.
  it("Undo takes away the toast that said the fix would start", async () => {
    const closed = card({ prAutoFix: true, worktreePath: "/tmp/ply-test/card-1", builder: { vendor: "codex", bypass: false, startedAt: 0, snapshots: [{ n: 1, sha: "aaa", at: 0 }], ptyId: null, permissions: "editsCopy" } as never });
    seed(closed);
    resetToastsForTests();
    tauri().fixture("card_pr_auto_fix_stop", closed);
    await stepCard(closed);
    expect(tauri().callsOf("card_pr_auto_fix_stop")[0]?.args).toMatchObject({ reason: "session_closed" });
    const waiting = () =>
      [...useToasts.getState().toasts, ...((useToasts.getState() as { queue?: { body?: string }[] }).queue ?? [])].filter((t) =>
        /starts once that's settled/.test(t.body ?? ""),
      );
    await waitFor(() => expect(waiting()).toHaveLength(1));
    useAutoFixTurnedOn.setState({ cards: { "card-1": { workspaceId: WS, head: "aaa", at: Date.now() } } });
    const { user } = renderUi(<AutoFixOffer card={closed} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(tauri().callsOf("card_set_pr_auto_fix")).toHaveLength(1));
    await waitFor(() => expect(waiting()).toHaveLength(0));
  });
});
