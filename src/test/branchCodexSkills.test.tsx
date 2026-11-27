// GH #156: a skill whose Codex copy is only on the integration branch.
//
// The real Skills page, fed by its real data hook (`useSkillsData`) through the
// stubbed Tauri layer. `knowledge_project_state` answers the way
// `workspace_definition::app_library_state` does — with `branchCodex`, Rust's
// `branch_codex_skills::delivery` — and the row must draw what a Codex session
// Ply launches here really gets:
//
// - delivered: the `Codex` chip is lit beside `Claude`, and the #105 sentence
//   ("Codex reads it here once you pull") is gone;
// - refused (the member has a `ply-project` marketplace of their own): no `Codex`
//   chip, and the row says why in the overlay's own words;
// - no Codex home on this Mac: no chip, and nothing said.
import { describe, expect, it } from "vitest";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import type { BranchCodexDelivery, LibraryStateLike } from "../lib/sharedLibrary";
import type { ProjectSkillsView } from "../ipc";
import { renderUi, screen, waitFor } from "./render";

const WS = "ws-156";
const CWD = "/Users/someone/code/project";
const MIRROR = "/Users/someone/Library/Application Support/com.mbadv.ply/projects/ws-156/shared_library";

const view: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: CWD,
  // The checkout has none of it: the skill is only on the branch.
  skills: [],
  team: [],
  unloadable: [],
  rootsPresent: [],
  ignoredRoots: [],
  configured: false,
  hasClone: false,
  canPromote: false,
  promoteReason: null,
  promotePlugin: "ply-team",
  errors: [],
};

function libraryState(branchCodex: BranchCodexDelivery | undefined): LibraryStateLike {
  return {
    shared: true,
    branch: "staging",
    readOnly: false,
    repository: "someone/project",
    pending: [],
    branchSkills: ["deploy"],
    branchSkillRows: [
      {
        name: "deploy",
        codexName: null,
        description: "Ships the app to staging. Then checks it.",
        dir: `${MIRROR}/.claude/skills/deploy`,
        claude: true,
        codex: true,
        differs: false,
        codexDir: `${MIRROR}/.agents/skills/deploy`,
      },
    ],
    skipped: [],
    suppliedToCheckout: ["deploy"],
    ...(branchCodex === undefined ? {} : { branchCodex }),
  } as LibraryStateLike;
}

function Host() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={CWD} data={data} />;
}

function render(branchCodex: BranchCodexDelivery | undefined) {
  return renderUi(<Host />, {
    fixtures: {
      project_skills_view: () => view,
      knowledge_project_state: () => libraryState(branchCodex),
      personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
      skills_hub_links: () => ({ links: [], unreadable: [] }),
      ply_skills_view: () => ({ skills: [], problem: null }),
    },
  });
}

/** The row itself, holding its chips and hint. Its open control is a `button`
 *  named by the skill (GH #181: the label, not the row, is the button). */
async function deployRow(): Promise<HTMLElement> {
  const open = await screen.findByRole("button", { name: "deploy" });
  const row = open.closest<HTMLElement>(".ux-row");
  if (!row) throw new Error("the open button is not in a row");
  await waitFor(() => expect(row.textContent).toContain("Ships the app to staging."));
  return row;
}

const chipsOf = (row: HTMLElement) =>
  [...row.querySelectorAll(".ux-avail-chip")].map((chip) => chip.textContent);

const PULL_SENTENCE = "Codex reads it here once the folder has it. Ask the Builder to bring it here.";

describe("GH #156: a branch-only Codex copy on the Library row", () => {
  it("lights the Codex chip and drops the sentence when Plyloft delivers it", async () => {
    const { tauri } = render({ reaches: true, refused: null });
    const row = await deployRow();
    expect(chipsOf(row)).toEqual(["Claude", "Codex"]);
    expect(row.textContent).not.toContain(PULL_SENTENCE);
    expect(row.textContent).not.toContain("not in this checkout yet");
    // And the section no longer says the repository reaches one CLI only.
    expect(screen.queryByText("All 1 reach Claude only.")).toBeNull();
    expect(tauri.callsOf("knowledge_project_state")[0]?.args).toEqual({ workspaceId: WS });
  });

  it("keeps the chip dark and says why when the overlay refuses it", async () => {
    const reason =
      "you already have a Codex marketplace named `ply-project`, so Plyloft did not add " +
      "the branch's project skills marketplace";
    render({ reaches: false, refused: reason });
    const row = await deployRow();
    expect(chipsOf(row)).toEqual(["Claude"]);
    expect(row.textContent).toContain(
      "Codex's copy is on staging and not in your project folder yet, and Plyloft could not hand " +
        // SP-5 walk: the note's `code` is drawn as code, so its text has no backticks.
        `it to Codex on this Mac: ${reason.replace(/`/g, "")}. ${PULL_SENTENCE}`,
    );
    expect(row.querySelector("code.ux-md-code")?.textContent).toBe("ply-project");
  });

  it("says nothing on a Mac without Codex", async () => {
    render({ reaches: false, refused: null });
    const row = await deployRow();
    expect(chipsOf(row)).toEqual(["Claude"]);
    expect(row.textContent).not.toContain("Codex's copy");
  });

  it("draws what #105 drew for a state from an older build", async () => {
    render(undefined);
    const row = await deployRow();
    expect(chipsOf(row)).toEqual(["Claude"]);
    expect(row.textContent).toContain(PULL_SENTENCE);
    expect(screen.getByText("All 1 reach Claude only.")).toBeTruthy();
  });
});
