import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationsPermitted } from "../lib/agentNotifier";
import { setPlatformForTests } from "../lib/platform";

// Windows: the notification plugin's page script reads "denied" until the
// permission is asked for, so Ply asks there (no prompt on the desktop). The
// Mac never prompts from here.
describe("notificationsPermitted", () => {
  afterEach(() => setPlatformForTests(null));

  it("asks on Windows when the plugin reads not granted", async () => {
    setPlatformForTests("windows");
    const requestPermission = vi.fn(async () => "granted" as const);
    const ok = await notificationsPermitted({ isPermissionGranted: async () => false, requestPermission });
    expect(ok).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("never asks on the Mac", async () => {
    setPlatformForTests("mac");
    const requestPermission = vi.fn(async () => "granted" as const);
    const ok = await notificationsPermitted({ isPermissionGranted: async () => false, requestPermission });
    expect(ok).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("does not ask when already granted", async () => {
    setPlatformForTests("windows");
    const requestPermission = vi.fn(async () => "granted" as const);
    expect(await notificationsPermitted({ isPermissionGranted: async () => true, requestPermission })).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
