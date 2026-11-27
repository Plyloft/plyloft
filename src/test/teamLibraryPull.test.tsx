// Skills hub H2 (R1, R16, R17): the team library's pull line, the question
// when GitHub no longer lets this account read it (nothing switches off until
// the member confirms), leaving the team, and the toast a pull raises.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { TeamLibraryNotices, TeamLibraryPullLine, TeamReadError } from "../components/TeamLibraryPull";
import type { LibraryPullView } from "../ipc";
import { showPulledToast, useSkillsHub } from "../store/skillsHubStore";
import { useToasts } from "../store/toastStore";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi, screen } from "./render";
import { setPlatformForTests } from "../lib/platform";

const NOW = Date.now();

function view(over: Partial<LibraryPullView> = {}): LibraryPullView {
  return {
    library: "team:acme/team",
    repo: "acme/team",
    teamName: "Acme",
    hasClone: true,
    lastPullAt: NOW - 4 * 60_000,
    lastPullCommit: "abc",
    lastAttemptAt: NOW - 4 * 60_000,
    lastError: null,
    heldBack: null,
    switchedOff: false,
    accessLost: null,
    keptLastCopy: false,
    leftAt: null,
    cloneKept: null,
    login: "matteo",
    ...over,
  };
}

afterEach(() => {
  useSkillsHub.setState({ team: null });
  useToasts.setState({ toasts: [] });
});

describe("TeamLibraryPullLine", () => {
  it("says when the library was last updated", () => {
    useSkillsHub.setState({ team: view() });
    renderUi(<TeamLibraryPullLine asNote />);
    expect(screen.getByText("Updated 4 minutes ago")).toBeTruthy();
  });

  it("says offline and keeps the time of the last copy", () => {
    useSkillsHub.setState({ team: view({ lastError: "offline", lastPullAt: NOW - 2 * 3_600_000 }) });
    renderUi(<TeamLibraryPullLine />);
    expect(screen.getByText("Last updated 2 hours ago · offline")).toBeTruthy();
  });
});

describe("TeamLibraryNotices (R16)", () => {
  it("asks, and switches off only after the member confirms", async () => {
    useSkillsHub.setState({ team: view({ accessLost: NOW, lastPullAt: NOW - 3 * 86_400_000 }) });
    const onChanged = vi.fn();
    const { tauri } = renderUi(<TeamLibraryNotices onChanged={onChanged} />, {
      fixtures: { skills_hub_library_switch: () => view({ switchedOff: true, hasClone: false }) },
    });
    expect(
      screen.getByText(
        "acme/team isn't reachable with matteo's GitHub account any more. Your sessions still get the copy from 3 days ago.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Switch it off on this/ }));
    // The sheet first; nothing is switched off yet.
    expect(tauri.callsOf("skills_hub_library_switch")).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Switch it off" }));
    await act(async () => {});
    expect(tauri.callsOf("skills_hub_library_switch")[0]?.args).toEqual({ on: false });
    expect(onChanged).toHaveBeenCalled();
    expect(useSkillsHub.getState().team?.switchedOff).toBe(true);
    expect(screen.getByRole("button", { name: "Switch it back on" })).toBeTruthy();
  });

  it("Keep the last copy answers it without switching anything off", async () => {
    useSkillsHub.setState({ team: view({ accessLost: NOW }) });
    const { tauri } = renderUi(<TeamLibraryNotices onChanged={() => {}} />, {
      fixtures: { skills_hub_keep_last_copy: () => view({ accessLost: NOW, keptLastCopy: true }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep the last copy" }));
    await act(async () => {});
    expect(tauri.callsOf("skills_hub_keep_last_copy")).toHaveLength(1);
    expect(tauri.callsOf("skills_hub_library_switch")).toHaveLength(0);
    expect(screen.queryByText(/isn't reachable/)).toBeNull();
  });

  it("says when this Mac is no longer in the team (R17)", () => {
    useSkillsHub.setState({ team: view({ leftAt: NOW, hasClone: false }) });
    renderUi(<TeamLibraryNotices onChanged={() => {}} />);
    expect(screen.getByText(/You're no longer in Acme's team\./)).toBeTruthy();
    expect(screen.getByText(/Skills copied into repositories stay as they are\./)).toBeTruthy();
  });

  it("(Reviewer) says this PC on Windows, in the notice and the line", () => {
    setPlatformForTests("windows");
    try {
      useSkillsHub.setState({ team: view({ leftAt: NOW, hasClone: false }) });
      const { unmount } = renderUi(<TeamLibraryNotices onChanged={() => {}} />);
      expect(screen.getByText(/Its library left this PC\./)).toBeTruthy();
      expect(screen.queryByText(/this Mac/)).toBeNull();
      unmount();
      useSkillsHub.setState({ team: view({ switchedOff: true }) });
      renderUi(<TeamLibraryPullLine />);
      expect(screen.getByText("Switched off on this PC · sessions get no team skills")).toBeTruthy();
    } finally {
      setPlatformForTests(null);
    }
  });
});

describe("TeamReadError (Windows walk: offline in Settings › Team)", () => {
  it("says offline plainly, with git's words behind Show details", () => {
    useSkillsHub.setState({ team: view({ lastError: "offline", lastPullAt: NOW - 2 * 3_600_000 }) });
    const raw =
      "Could not pull the team repo: git fetch failed: fatal: unable to access 'https://github.com/acme/team.git/': Could not resolve host: github.com";
    const { container } = renderUi(<TeamReadError error={raw} />);
    expect(screen.getByText("Couldn't reach GitHub. New sessions use the copy from 2 hours ago.")).toBeTruthy();
    expect(screen.getByText("Show details")).toBeTruthy();
    expect(container.querySelector("pre")?.textContent).toContain("Could not resolve host");
  });

  it("shows any other error as it is", () => {
    renderUi(<TeamReadError error="team.json is not readable: EOF" />);
    expect(screen.getByText("team.json is not readable: EOF")).toBeTruthy();
    expect(screen.queryByText("Show details")).toBeNull();
  });
});

describe("the pull toast (R1, R14)", () => {
  it("is one toast naming who changed what, with Show when a workspace is open", () => {
    useWorkspaces.setState({ activeId: "ws1" } as never);
    showPulledToast({
      library: "team:acme/team",
      teamName: "Acme",
      changes: [
        { skill: "review-rules", authors: ["Ana"] },
        { skill: "deploy", authors: ["Ana"] },
        { skill: "check", authors: ["Ana"] },
      ],
    });
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe("Ana changed review-rules and 2 more");
    expect(toasts[0].action?.label).toBe("Show");
  });

  it("raises nothing for a pull that changed no skill", () => {
    showPulledToast({ library: "team:acme/team", teamName: "Acme", changes: [] });
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
