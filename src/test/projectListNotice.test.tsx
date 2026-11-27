// 1.175.0 (R3; owner, 2026-11-09): a project list that couldn't be read no
// longer stops the launch. Plyloft starts with no projects and says so once,
// with where the file is (`unreadable_notices.rs::project_list_notice`). The
// words are `STRINGS-immediacy.md`'s; the refused case's are proposed there.
import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { sayProjectListNotice } from "../lib/unreadableNotices";
import { setPlatformForTests } from "../lib/platform";
import { computeTtl, useToasts } from "../store/toastStore";
import { tauri } from "./render";

const lastToast = () => useToasts.getState().toasts.slice(-1)[0];

describe("the project list couldn't be read", () => {
  it("set aside: says Plyloft started with none, and shows the file in Finder", async () => {
    tauri().fixture("project_list_notice", { kind: "setAside", path: "/c/workspaces.json.broken-17" });
    tauri().fixture("project_list_notice_reveal", null);
    await sayProjectListNotice();
    const toast = lastToast();
    expect(toast?.kind).toBe("error");
    expect(toast?.title).toBe("Your project list couldn't be read");
    expect(toast?.body).toBe("Plyloft started with none. The old file is kept.");
    expect(toast?.details).toBe("The old file is kept as /c/workspaces.json.broken-17.");
    expect(toast?.action?.label).toBe("Show in Finder");
    // With an action it stays until dismissed: the app shows no projects by then.
    expect(computeTtl(toast!)).toBeNull();
    toast?.action?.onClick();
    await waitFor(() => expect(tauri().callsOf("project_list_notice_reveal")).toHaveLength(1));
    // The path is the backend's own: the page sends none.
    expect(tauri().callsOf("project_list_notice_reveal")[0]?.args).toEqual({});
  });

  it("refused: says the file was left as it is, with the reason behind Details", async () => {
    const why =
      "The project list was saved by a newer Plyloft (version 2; this one knows up to 1), so it was left as it is. Update Plyloft to change it.";
    tauri().fixture("project_list_notice", { kind: "refused", path: "/c/workspaces.json", why });
    await sayProjectListNotice();
    const toast = lastToast();
    expect(toast?.title).toBe("Your project list couldn't be read");
    expect(toast?.body).toBe(
      "Plyloft started with none and left the file as it is. A newer Plyloft may have saved it: update Plyloft to open your projects.",
    );
    // Round 4 (T7): and the way out when Plyloft is already up to date.
    expect(toast?.details).toBe(
      `${why} The file is /c/workspaces.json.\nIf Plyloft is already up to date: quit Plyloft, move that file somewhere else, and open Plyloft again to start with no projects.`,
    );
    expect(toast?.action?.label).toBe("Show in Finder");
  });

  it("on Windows the action says File Explorer", async () => {
    setPlatformForTests("windows");
    tauri().fixture("project_list_notice", { kind: "setAside", path: "C:\\cfg\\workspaces.json.broken-17" });
    await sayProjectListNotice();
    expect(lastToast()?.action?.label).toBe("Show in File Explorer");
    expect(lastToast()?.details).toBe("The old file is kept as C:\\cfg\\workspaces.json.broken-17.");
  });

  it("says nothing when the list was read, and never throws", async () => {
    await sayProjectListNotice();
    expect(useToasts.getState().toasts).toHaveLength(0);
    tauri().fixture("project_list_notice", () => {
      throw "no backend";
    });
    await expect(sayProjectListNotice()).resolves.toBeUndefined();
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  // Pressing the action takes the toast away: when the file can't be shown,
  // the notice comes back with the reason behind Details, so the path stays
  // within reach.
  it("comes back when the file can't be shown", async () => {
    tauri().fixture("project_list_notice", { kind: "setAside", path: "/c/workspaces.json.broken-17" });
    tauri().fixture("project_list_notice_reveal", () => {
      throw "open failed: no such file";
    });
    await sayProjectListNotice();
    const first = lastToast();
    first?.action?.onClick();
    await waitFor(() => expect(lastToast()?.details).toContain("open failed: no such file"));
    const again = lastToast();
    expect(again?.id).not.toBe(first?.id);
    expect(again?.title).toBe("Your project list couldn't be read");
    expect(again?.details).toContain("The old file is kept as /c/workspaces.json.broken-17.");
    expect(again?.action?.label).toBe("Show in Finder");
    expect(tauri().callsOf("project_list_notice")).toHaveLength(1);
  });
});
