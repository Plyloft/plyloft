// 1.173.0 (E5 Challenger round 2): `shareWorkspaceSetup`, the banner's
// Share that Next improvement's direction editor also presses — the share
// call, "Already shared", a GitHub Issues board taking this Mac's local
// cards, and the error toast.
import { describe, expect, it } from "vitest";
import { tauri } from "./tauri";
import { shareWorkspaceSetup } from "../components/AdoptionBanner";
import { useToasts } from "../store/toastStore";

const WS = "ws-share";
const status = { boardRepo: "me/board", githubRepo: "me/lyra" };

function allToasts() {
  const s = useToasts.getState();
  return [...s.toasts, ...s.queue, ...s.recent];
}

describe("shareWorkspaceSetup", () => {
  it("shares, and says Already shared when someone shared meanwhile", async () => {
    const t = tauri();
    t.fixture("workspace_adoption_share", { alreadyShared: true, board: "local", localCards: 0, boardHeld: null });
    t.fixture("workspace_list", { workspaces: [], activeId: null });
    t.allowUnhandled();
    expect(await shareWorkspaceSetup(WS, status)).toBe(true);
    expect(t.callsOf("workspace_adoption_share")[0].args).toEqual({ workspaceId: WS });
    expect(allToasts().find((x) => x.title === "Already shared")?.body).toBe(
      "Someone shared this repository meanwhile; Plyloft uses its setup.",
    );
    expect(t.callsOf("kanban_github_push_local")).toHaveLength(0);
  });

  it("a GitHub Issues board takes this Mac's local cards", async () => {
    const t = tauri();
    t.fixture("workspace_adoption_share", { alreadyShared: false, board: "githubIssues", localCards: 2, boardHeld: null });
    t.fixture("kanban_github_push_local", { pushed: 2, failed: 0 });
    t.fixture("workspace_list", { workspaces: [], activeId: null });
    t.allowUnhandled();
    expect(await shareWorkspaceSetup(WS, status)).toBe(true);
    expect(t.callsOf("kanban_github_push_local")[0].args).toEqual({ workspaceId: WS });
    expect(allToasts().some((x) => x.title === "Already shared")).toBe(false);
    expect(allToasts().some((x) => /me\/board/.test(`${x.title} ${x.body ?? ""}`))).toBe(true);
  });

  it("a refused share says Couldn't share this workspace, git's words behind Details", async () => {
    const t = tauri();
    t.fixture("workspace_adoption_share", () => Promise.reject(new Error("fatal: could not read from remote")));
    t.fixture("workspace_list", { workspaces: [], activeId: null });
    t.allowUnhandled();
    expect(await shareWorkspaceSetup(WS, status)).toBe(false);
    const toast = allToasts().find((x) => x.title === "Couldn't share this workspace");
    expect(toast?.kind).toBe("error");
    expect(toast?.details).toBe("fatal: could not read from remote");
    // 1.176.2 (E1): git's own text is never the line; the app's sentence is.
    expect(toast?.body).toBe("Something went wrong; Details has the tool's own words.");
  });
});
