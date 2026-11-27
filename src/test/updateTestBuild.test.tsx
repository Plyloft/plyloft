// n16 — "Plyloft Test" (a test-bridge build) never checks for, offers or
// installs a release update: the updater's `check` is never called, and the
// flow stays idle, so the sidebar row never says "Plyloft x is available".
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

const updater = vi.hoisted(() => ({
  check: vi.fn(async () => ({ version: "9.9.9" })),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("../testBridge/isTestBuild", () => ({ isTestBuild: true }));

import {
  UpdatePrompt,
  UpdateStatusRow,
  setUpdateFlowForTests,
  updateFlow,
} from "../components/UpdatePrompt";
import { renderUi } from "./render";

afterEach(() => setUpdateFlowForTests(null));

describe("a test build and release updates", () => {
  it("never reads the feed, on launch, on refocus or on Install", async () => {
    setUpdateFlowForTests(null);
    const view = renderUi(
      <>
        <UpdatePrompt />
        <UpdateStatusRow />
      </>,
    );
    view.tauri.allowUnhandled();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await updateFlow().runCheck("poll");
      updateFlow().openFromBanner();
      await updateFlow().confirmInstall();
    });
    expect(updater.check).not.toHaveBeenCalled();
    expect(updateFlow().getState().kind).toBe("idle");
    expect(document.body.textContent).not.toContain("is available");
  });
});
