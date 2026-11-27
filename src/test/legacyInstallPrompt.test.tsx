// 2026-09-30: the old "Ply" left beside Plyloft after the rename is offered for
// removal at launch, in one sentence that says the shared profile stays.
import { afterEach, describe, expect, it } from "vitest";
import { LegacyInstallPrompt, legacyInstallDoneSentence, legacyInstallSentence } from "../components/LegacyInstallPrompt";
import { setPlatformForTests } from "../lib/platform";
import type { LegacyInstall, LegacyRemoval } from "../lib/legacyInstallIpc";
import { renderUi, screen, waitFor, within } from "./render";

const oldPly: LegacyInstall = {
  version: "1.152.1",
  location: "C:\\Users\\u\\AppData\\Local\\Ply",
  shortcuts: ["C:\\Users\\u\\Desktop\\Ply.lnk"],
  adminShortcuts: [],
  unmatchedShortcuts: [],
  allUsers: false,
};

const moved: LegacyRemoval = {
  bin: "the Recycle Bin",
  moved: ["C:\\Users\\u\\AppData\\Local\\Ply", "C:\\Users\\u\\Desktop\\Ply.lnk"],
  adminShortcuts: [],
  unmatchedShortcuts: [],
};

afterEach(() => setPlatformForTests(null));

describe("LegacyInstallPrompt", () => {
  it("draws nothing when there is no old Ply", async () => {
    const { tauri } = renderUi(<LegacyInstallPrompt />, { fixtures: { legacy_install_probe: null } });
    await waitFor(() => expect(tauri.callsOf("legacy_install_probe")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks once, opens on Not now, says the profile stays, removes without a path and says what moved", async () => {
    setPlatformForTests("windows");
    const { user, tauri } = renderUi(<LegacyInstallPrompt />, {
      fixtures: { legacy_install_probe: oldPly, legacy_install_remove: moved },
    });
    const sheet = await screen.findByRole("dialog", { name: "Ply is still installed" });
    expect(sheet.textContent).toContain(
      "Ply 1.152.1 (this app under its earlier name) is still installed in C:\\Users\\u\\AppData\\Local\\Ply",
    );
    expect(sheet.textContent).not.toContain("old Ply");
    expect(sheet.textContent).toContain("Recycle Bin");
    expect(sheet.textContent).toContain("stay as they are");
    // A confirm that removes something opens on the safe choice.
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Not now" })));
    await user.click(within(sheet).getByRole("button", { name: "Remove Ply" }));
    const done = await screen.findByRole("dialog", { name: "Ply is removed" });
    expect(done.textContent).toContain("Ply was moved to the Recycle Bin: C:\\Users\\u\\AppData\\Local\\Ply");
    await user.click(within(done).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const calls = tauri.callsOf("legacy_install_remove");
    expect(calls).toHaveLength(1);
    expect(calls[0].args ?? {}).toEqual({});
  });

  it("shows a refusal and offers Retry; Not now closes without removing", async () => {
    const { user, tauri } = renderUi(<LegacyInstallPrompt />, {
      fixtures: {
        legacy_install_probe: oldPly,
        legacy_install_remove: () => {
          throw "couldn't move it to the Recycle Bin. Nothing was moved.";
        },
      },
    });
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Remove Ply" }));
    expect((await within(sheet).findByRole("alert")).textContent).toContain("Nothing was moved.");
    expect(within(sheet).getByRole("button", { name: "Retry" })).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("legacy_install_remove")).toHaveLength(1);
  });

  it("leaves an install for every user to an administrator, without a Remove", async () => {
    const { user, tauri } = renderUi(<LegacyInstallPrompt />, {
      fixtures: { legacy_install_probe: { ...oldPly, allUsers: true } },
    });
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("Installed apps");
    expect(within(sheet).queryByRole("button", { name: "Remove Ply" })).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauri.callsOf("legacy_install_remove")).toHaveLength(0);
  });

  it("after removing, names the shortcuts it left: an administrator's, and one it could not read", async () => {
    const common = "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Ply.lnk";
    const redirected = "C:\\Mac\\Home\\Desktop\\Ply.lnk";
    const { user } = renderUi(<LegacyInstallPrompt />, {
      fixtures: {
        legacy_install_probe: oldPly,
        legacy_install_remove: { ...moved, adminShortcuts: [common], unmatchedShortcuts: [redirected] },
      },
    });
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("button", { name: "Remove Ply" }));
    const done = await screen.findByRole("dialog", { name: "Ply is removed" });
    expect(done.textContent).toContain(common);
    expect(done.textContent).toContain("administrator");
    expect(done.textContent).toContain(`could not confirm that ${redirected} opens Ply`);
    await user.click(within(done).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(legacyInstallDoneSentence(moved)).not.toContain("administrator");
  });

  it("says Trash on a Mac, and never calls a possibly newer Ply.app old", () => {
    const mac = legacyInstallSentence({ ...oldPly, location: "/Applications/Ply.app", shortcuts: [] }, false);
    expect(mac).toContain("/Applications/Ply.app");
    expect(mac).toContain("Trash");
    expect(mac).toContain("stay as they are");
    expect(mac).toContain("earlier name");
    expect(mac).not.toMatch(/\bold\b/);
  });
});
