// Skills hub H2 (Windows walk): the open Library kept "In the team library 3"
// after this Mac left the team, until the member switched views. Its rows
// are read again when the pull record says the team rows changed (leaving,
// rejoining, switching off, a pull that brought a commit), and not on a pull
// that brought nothing.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { useSkillsData } from "../components/library/useSkillsData";
import type { LibraryPullView } from "../ipc";
import { useSkillsHub } from "../store/skillsHubStore";
import { renderUi } from "./render";

const WS = "ws-team-follows";
const NOW = Date.now();

function pull(over: Partial<LibraryPullView> = {}): LibraryPullView {
  return {
    library: "team:acme/team",
    repo: "acme/team",
    teamName: "Acme",
    hasClone: true,
    lastPullAt: NOW,
    lastPullCommit: "abc",
    lastAttemptAt: NOW,
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

function Host({ active }: { active: boolean }) {
  useSkillsData(WS, active);
  return null;
}

function render(active: boolean) {
  return renderUi(<Host active={active} />, {
    fixtures: {
      project_skills_view: () => ({
        workspaceId: WS,
        workspaceName: "p",
        cwd: "/p",
        skills: [],
        team: [],
        configured: true,
        hasClone: true,
        canPromote: false,
      }),
      knowledge_project_state: () => {
        throw new Error("not shared");
      },
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
    },
  });
}

afterEach(() => useSkillsHub.setState({ team: null }));

describe("the Library's team section follows the pull record", () => {
  it("reads its rows again on leaving or a new commit, not on an empty pull", async () => {
    useSkillsHub.setState({ team: pull() });
    const { tauri } = render(true);
    await act(async () => {});
    const reads = () => tauri.callsOf("project_skills_view").length;
    expect(reads()).toBe(1);

    await act(async () => useSkillsHub.setState({ team: pull({ lastPullAt: NOW + 60_000 }) }));
    expect(reads()).toBe(1);

    await act(async () => useSkillsHub.setState({ team: pull({ leftAt: NOW, hasClone: false }) }));
    expect(reads()).toBe(2);

    await act(async () => useSkillsHub.setState({ team: pull({ lastPullCommit: "def" }) }));
    expect(reads()).toBe(3);
  });

  it("a hidden Library doesn't read; becoming visible reads once", async () => {
    useSkillsHub.setState({ team: pull() });
    const { tauri, rerender } = render(false);
    await act(async () => {});
    await act(async () => useSkillsHub.setState({ team: pull({ switchedOff: true }) }));
    expect(tauri.callsOf("project_skills_view")).toHaveLength(0);
    rerender(<Host active />);
    await act(async () => {});
    expect(tauri.callsOf("project_skills_view")).toHaveLength(1);
  });
});
