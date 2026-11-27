// 1.176.2 (A5F-07, A5F-12, A5F-13): a view closed before `listen()` answered
// leaves no listener behind, and the discussion panel never shows another
// card's discussion.
import { describe, expect, it } from "vitest";
import { PlanChallengePanel } from "../components/PlanChallengePanel";
import { IntakeConversation } from "../components/IntakeConversation";
import type { DiscussionView } from "../ipc";
import { boardCard } from "./boardFixtures";
import { act, renderUi, tauri } from "./render";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

describe("Plan challenge panel", () => {
  it("leaves no listener when closed before listen answered", async () => {
    const r = renderUi(<PlanChallengePanel card={boardCard("a")} offer={false} onChallenge={() => {}} />, {
      fixtures: { discussion_list: [] },
    });
    r.unmount();
    await flush();
    expect(tauri().listeners("discussion://changed")).toBe(0);
  });

  it("drops a discussion read for the card it moved on from", async () => {
    const view = (cardId: string): DiscussionView =>
      ({ record: { id: `d-${cardId}`, cardId, startedAt: 1 } }) as unknown as DiscussionView;
    let release: (v: DiscussionView[]) => void = () => {};
    const slow = new Promise<DiscussionView[]>((res) => (release = res));
    let calls = 0;
    const r = renderUi(<PlanChallengePanel card={boardCard("a")} offer onChallenge={() => {}} />, {
      fixtures: { discussion_list: () => (++calls === 1 ? slow : []) },
    });
    r.rerender(<PlanChallengePanel card={boardCard("b")} offer onChallenge={() => {}} />);
    await flush();
    // A's read answers late, with a discussion of A (the list is the workspace's).
    release([view("a")]);
    await flush();
    // Card b has no discussion: its panel still offers the challenge.
    expect(r.container.textContent ?? "").toContain("Challenge the plan before it is built");
  });
});

describe("terminal views closed during subscription", () => {
  it("a planning conversation closed at once leaves no listener", async () => {
    tauri().allowUnhandled();
    const r = renderUi(<IntakeConversation cardId="c" ptyId="p1" />);
    r.unmount();
    await flush();
    for (const e of ["pty://data", "pty://exit", "intake://swept"]) expect(tauri().listeners(e)).toBe(0);
  });
});
