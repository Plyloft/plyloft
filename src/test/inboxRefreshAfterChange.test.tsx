// A change the Inbox must show (Remove from Team): a read already running may
// predate it, so one more follows. Other refreshes stay coalesced.
import { describe, expect, it } from "vitest";
import { useInbox } from "../store/inboxStore";
import { tauri } from "./tauri";

type Feed = { generatedAt: number; windowDays: number; events: never[] };
const feed = (generatedAt: number): Feed => ({ generatedAt, windowDays: 28, events: [] });

function held() {
  const answers: ((value: Feed) => void)[] = [];
  tauri().allowUnhandled();
  tauri().fixture("inbox_feed", () => new Promise<Feed>((resolve) => answers.push(resolve)));
  return answers;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("refreshAfterChange", () => {
  it("reads once more after the read in flight, and that newer read is what stays", async () => {
    const answers = held();
    void useInbox.getState().refresh();
    await settle();
    void useInbox.getState().refreshAfterChange();
    // A second ask while running is still one more read.
    void useInbox.getState().refreshAfterChange();
    expect(tauri().callsOf("inbox_feed")).toHaveLength(1);
    answers[0](feed(1));
    await settle();
    expect(tauri().callsOf("inbox_feed")).toHaveLength(2);
    answers[1](feed(2));
    await settle();
    expect(useInbox.getState().feed?.generatedAt).toBe(2);
    expect(useInbox.getState().loading).toBe(false);
    expect(tauri().callsOf("inbox_feed")).toHaveLength(2);
  });

  it("reads straight away when nothing is running", async () => {
    const answers = held();
    void useInbox.getState().refreshAfterChange();
    await settle();
    expect(tauri().callsOf("inbox_feed")).toHaveLength(1);
    answers[0](feed(3));
    await settle();
    expect(useInbox.getState().feed?.generatedAt).toBe(3);
  });

  it("leaves a plain refresh during a read coalesced", async () => {
    const answers = held();
    void useInbox.getState().refresh();
    await settle();
    void useInbox.getState().refresh();
    answers[0](feed(4));
    await settle();
    expect(tauri().callsOf("inbox_feed")).toHaveLength(1);
  });
});
