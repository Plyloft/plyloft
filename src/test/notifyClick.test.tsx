// QoL 1.168 (Challenger 3, 4): one gate for every notification the window
// sends, and what a click on one does — through the stores, as the app runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWaitingNotifier } from "../store/waitingNotifier";
import { gatedNotify } from "../store/notifyGate";
import { onWindowFront } from "../store/notifyTargetOpen";
import { setNotificationAccessCache } from "../store/notificationAccessCache";
import { useWorkspaces, type Workspace } from "../store/workspaceStore";
import { useSettings } from "../store/settingsStore";
import { useBuilder } from "../store/builderStore";
import { useUi } from "../store/uiStore";
import { useToasts } from "../store/toastStore";
import { act } from "./render";
import { tauri } from "./tauri";

const sent: string[] = [];
class FakeNotification {
  static permission = "granted";
  constructor(title: string) {
    sent.push(title);
  }
}
const ws = (id: string, name: string): Workspace => ({ id, name, cwd: `/code/${name}`, createdAt: 1, lastOpenedAt: 1, openFiles: [], activeFile: null });

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const card = (cardId: string) => ({ kind: "card" as const, workspaceId: "b", cardId, name: `Card ${cardId}` });

describe("notifications from the window", () => {
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("Notification", FakeNotification);
    const s = useSettings.getState().settings;
    useSettings.setState({ settings: { ...s, behavior: { ...s.behavior, notifyOnSessionWaiting: true, notifyOnAgentDone: true } } });
    act(() => useWorkspaces.setState({ workspaces: [ws("a", "alpha"), ws("b", "beta")], activeId: "a" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a click within 20 s opens the card; later, a toast offers it", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    tauri().allowUnhandled();
    setNotificationAccessCache("allowed");
    const t0 = Date.now();
    gatedNotify({ cardKey: "b::c1", title: "Ready to ship", body: "beta · Card c1", target: card("c1") }, t0);
    await settle();
    expect(sent).toEqual(["Ready to ship"]);
    act(() => onWindowFront(Date.now() + 5_000));
    expect(useWorkspaces.getState().activeId).toBe("b");
    expect(useUi.getState().selectedCardId.b).toBe("c1");

    gatedNotify({ cardKey: "b::c2", title: "Changes requested", body: "beta · Card c2", target: card("c2") });
    await settle();
    act(() => onWindowFront(Date.now() + 60_000));
    expect(useUi.getState().selectedCardId.b).toBe("c1");
    expect(useToasts.getState().toasts[0]?.title).toBe("From the notification: Card c2");
  });

  it("arms nothing when the system doesn't let notifications through, or the person is in Plyloft", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    setNotificationAccessCache("unknown");
    gatedNotify({ cardKey: "b::c1", title: "Ready to ship", body: "x", target: card("c1") });
    await settle();
    act(() => onWindowFront(Date.now() + 1_000));
    expect(useUi.getState().selectedCardId.b).toBeUndefined();

    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    setNotificationAccessCache("allowed");
    gatedNotify({ cardKey: "b::c3", title: "Ready to ship", body: "x", target: card("c3") });
    await settle();
    act(() => onWindowFront(Date.now() + 1_000));
    expect(useUi.getState().selectedCardId.b).toBeUndefined();
  });

  it("one card is told once whichever notifier tells it; a finishing Builder isn't", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const step = createWaitingNotifier();
    step(Date.now());
    gatedNotify({ cardKey: "b::k1", title: "Ready to ship", body: "beta · Login", target: card("k1") });
    act(() => useBuilder.setState({ byCard: { k1: { workspaceId: "b", vendor: "claude", startedAt: 1, turnIdle: true, pending: [] } as never } }));
    step(Date.now());
    await settle();
    expect(sent).toEqual(["Ready to ship"]);

    sent.length = 0;
    const again = createWaitingNotifier();
    again(Date.now());
    act(() =>
      useBuilder.setState({
        byCard: { k2: { workspaceId: "b", vendor: "claude", startedAt: 1, turnIdle: true, pending: [] } as never },
        selfCheck: { k2: {} as never },
      }),
    );
    again(Date.now());
    await settle();
    expect(sent).toEqual([]);
  });

  it("a burst is three banners, then one that counts the rest", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) gatedNotify({ cardKey: `b::c${i}`, title: `Card ${i}`, body: "x", target: null }, t0 + i);
    await settle();
    expect(sent).toEqual(["Card 0", "Card 1", "Card 2"]);
    const { flushNotifyGate } = await import("../store/notifyGate");
    flushNotifyGate(t0 + 31_000, "a");
    await settle();
    expect(sent[sent.length - 1]).toBe("2 more updates");
  });
});
