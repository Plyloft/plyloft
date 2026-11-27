// QoL 1.168 (F4, owner D6): the notification permission row — Setup's Your
// AI step and Settings › Claude and Codex — says what the system allows and
// offers the one action that moves it on.
import { afterEach, describe, expect, it } from "vitest";
import { NotificationAccessRow } from "../components/NotificationAccessRow";
import { setPlatformForTests } from "../lib/platform";
import { notificationRowWords } from "../lib/notificationAccessWords";
import { renderUi, screen } from "./render";

afterEach(() => setPlatformForTests(null));

describe("the notification row", () => {
  it("on a Mac not asked yet: one sentence why, and Allow asks macOS", async () => {
    setPlatformForTests("mac");
    let asked = false;
    const r = renderUi(<NotificationAccessRow />, {
      fixtures: {
        notification_access: () => (asked ? "allowed" : "not-asked"),
        notification_request_access: () => {
          asked = true;
          return "allowed";
        },
      },
    });
    expect(await screen.findByText(/while you're in another app\. macOS asks you once\./)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Allow notifications" }));
    expect(r.tauri.callsOf("notification_request_access")).toHaveLength(1);
    expect(await screen.findByText("Notifications are on")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send a test" })).toBeTruthy();
  });

  it("turned off: the system's settings are the way back", async () => {
    setPlatformForTests("mac");
    const r = renderUi(<NotificationAccessRow />, {
      fixtures: { notification_access: "denied", notification_open_settings: null },
    });
    await r.user.click(await screen.findByRole("button", { name: "Open System Settings" }));
    expect(r.tauri.callsOf("notification_open_settings")).toHaveLength(1);
  });

  it("on Windows: on with no prompt, and a test to see one", async () => {
    setPlatformForTests("windows");
    const r = renderUi(<NotificationAccessRow />, {
      fixtures: { notification_access: "allowed", notification_send_test: null },
    });
    expect(await screen.findByText(/Windows needs no permission for it\./)).toBeTruthy();
    await r.user.click(screen.getByRole("button", { name: "Send a test" }));
    expect(r.tauri.callsOf("notification_send_test")).toHaveLength(1);
    expect(r.tauri.callsOf("notification_request_access")).toHaveLength(0);
  });

  it("a development build that can't tell offers the test that makes macOS ask", () => {
    expect(notificationRowWords("unknown", false).action).toBe("test");
    expect(notificationRowWords("not-asked", true).action).toBe("test");
    expect(notificationRowWords("denied", true).actionLabel).toBe("Open Windows Settings");
  });
});
