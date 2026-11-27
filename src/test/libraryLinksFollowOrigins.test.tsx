// Skills hub H8 (Mac re-walk): lyra's Library kept "Linked to astra — not
// available" after astra went back to main, and "Linked on this Mac to notes
// · up to date" after notes was removed, while All skills was right. A
// link's state depends on another workspace, so the Library reads its links
// again when All skills read this workspace, when All skills closes back to
// it, and when a workspace is added or removed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { useSkillsData } from "../components/library/useSkillsData";
import { useAllSkills } from "../store/allSkillsStore";
import { useUi } from "../store/uiStore";
import { useWorkspaces } from "../store/workspaceStore";
import { renderUi } from "./render";

const WS = "ws-links-follow";

function Host() {
  useSkillsData(WS, true);
  return null;
}

afterEach(() => {
  vi.useRealTimers();
  useUi.setState({ allSkillsOpen: false });
});

describe("the Library's links follow their origins", () => {
  it("reads the links again after All skills read this workspace, closed, or a workspace went", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { tauri } = renderUi(<Host />, {
      fixtures: {
        project_skills_view: () => ({ workspaceId: WS, workspaceName: "lyra", cwd: "/l", skills: [], team: [], configured: false, hasClone: false, canPromote: false }),
        knowledge_project_state: () => {
          throw new Error("not shared");
        },
        personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
        skills_hub_links: () => ({ links: [], unreadable: [] }),
        ply_skills_view: () => ({ skills: [], problem: null }),
      },
    });
    await act(async () => {});
    const reads = () => tauri.callsOf("skills_hub_links").length;
    expect(reads()).toBe(1);
    const settle = async () => {
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
    };

    // All skills read lyra again (its page opening, Read again).
    const index = useAllSkills.getState().index;
    await act(async () =>
      useAllSkills.setState({ index: { ...index, workspaces: [{ id: WS, name: "lyra", repo: null, rows: [] } as never] } }),
    );
    await settle();
    expect(reads()).toBe(2);

    // All skills closed back to the Library.
    await act(async () => useUi.setState({ allSkillsOpen: true }));
    await act(async () => useUi.setState({ allSkillsOpen: false }));
    await settle();
    expect(reads()).toBe(3);

    // A workspace removed.
    await act(async () => useWorkspaces.setState({ workspaces: [{ id: "notes" } as never] }));
    await settle();
    expect(reads()).toBe(4);
  });
});
