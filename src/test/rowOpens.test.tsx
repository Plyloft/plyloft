// GH #181: a row that opens must not swallow the controls it holds.
//
// A `Row` with `onOpen` used to be `role="button"` itself. A button's children
// are presentational, so what the row held — `On this Mac`'s `Details` and its
// `Reveal in Finder`, a Library row's step button and `⋯`, a switch — was, to
// VoiceOver, part of one big button. Now the row is a plain container and its
// label is the open control: a real `<button>` named by the row's title, first
// in the row, so Tab reaches it and then each control in order.
//
// jsdom has no accessibility tree, and testing-library's role queries find a
// button inside a `role="button"` just as happily, so a role query alone would
// pass on the old row. `exposed()` asserts what makes a control exposed: no
// ancestor of it is a button. Put `role: "button"` back on the row (Row.tsx) and
// every `exposed()` below fails, as does the Tab order (the row takes a stop).
import { describe, expect, it, vi } from "vitest";
import { InstructionsPage } from "../components/library/InstructionsPage";
import { useInstructionsData } from "../components/library/useInstructionsData";
import { SkillRow } from "../components/library/SkillRow";
import { SkillsPage } from "../components/library/SkillsPage";
import { useSkillsData } from "../components/library/useSkillsData";
import { CBtn, Details, Group, Row } from "../components/ux";
import type { InstructionsView, ProjectSkillsView } from "../ipc";
import type { SkillRow as SkillRowModel } from "../lib/librarySkills";
import type { LibraryStateLike } from "../lib/sharedLibrary";
import { PROCEDURE_LABEL } from "../lib/libraryInstructions";
import { useEditor } from "../store/editorStore";
import { useLibrary } from "../store/libraryStore";
import { nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

/** Whether `el` is exposed as its own control: no ancestor is a button. */
function exposed(el: HTMLElement): boolean {
  let up = el.parentElement;
  while (up) {
    if (up.tagName === "BUTTON" || up.getAttribute("role") === "button") return false;
    up = up.parentElement;
  }
  return true;
}

function rowOf(el: HTMLElement): HTMLElement {
  const row = el.closest<HTMLElement>(".ux-row");
  if (!row) throw new Error("not in a row");
  return row;
}

// ── The Instructions page: `On this Mac` and the Procedure row ───────────────

const WS = "ws-181";
const ROOT = "/Users/someone/code/project";
const PERSONAL = "/Users/someone/.claude/CLAUDE.md";
const AGENTS = `${ROOT}/AGENTS.md`;

const view: InstructionsView = {
  shared: false,
  branch: null,
  readOnly: false,
  repository: null,
  workspaceRoot: ROOT,
  files: [
    {
      name: "AGENTS.md",
      lines: 3,
      hint: "Codex reads it.",
      openInCode: AGENTS,
      readOnlyPath: null,
      located: "both",
    },
  ],
  // Compliant, no step: the Procedure row reads its sentence and opens AGENTS.md.
  procedure: { status: "compliant", sentence: "Both CLIs read the same instructions.", step: null },
  plan: null,
  personal: [{ rel: ".claude/CLAUDE.md", path: PERSONAL, cli: "Claude", lines: 2 }],
  errors: [],
} as InstructionsView;

const instructionFixtures = {
  library_instructions_view: () => view,
  knowledge_project_state: () => {
    throw new Error("not shared");
  },
  personal_instruction_read: () => "# Mine\n",
  personal_instruction_reveal: () => null,
  fs_read_text_file: () => "# Agents\n",
};

function InstructionsHost() {
  const data = useInstructionsData(WS, true);
  return <InstructionsPage workspaceId={WS} data={data} />;
}

const opened = (path: string) =>
  useEditor.getState().byWorkspace[WS]?.openFiles.some((f) => f.path === path) ?? false;

async function personalRow() {
  const open = await screen.findByRole("button", { name: ".claude/CLAUDE.md" });
  return { open, row: rowOf(open) };
}

describe("Instructions › On this Mac: the row's controls are its own", () => {
  it("is not a button; its label is, and Details and Reveal in Finder are exposed", async () => {
    const { user } = renderUi(<InstructionsHost />, { fixtures: instructionFixtures });
    const { open, row } = await personalRow();

    expect(row.getAttribute("role")).toBeNull();
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(open.tagName).toBe("BUTTON");
    // Named by the row's title, described by its hint.
    expect(open.getAttribute("aria-describedby")).toBeTruthy();

    const summary = within(row).getByText("Details", { selector: "summary" });
    expect(exposed(summary)).toBe(true);
    await user.click(summary);
    const reveal = within(row).getByRole("button", { name: "Reveal in Finder" });
    expect(exposed(reveal)).toBe(true);

    // Neither control opens the row.
    await user.click(reveal);
    await waitFor(() => expect(tauri().callsOf("personal_instruction_reveal")).toHaveLength(1));
    await nextFrame();
    expect(tauri().callsOf("personal_instruction_read")).toEqual([]);
    expect(opened(PERSONAL)).toBe(false);
  });

  it("Tab reaches the open button, then Details, then what Details holds — no stop on the row", async () => {
    const { user } = renderUi(<InstructionsHost />, { fixtures: instructionFixtures });
    const { open, row } = await personalRow();
    const summary = within(row).getByText("Details", { selector: "summary" });
    await user.click(summary); // open it, so Reveal in Finder is on the way

    open.focus();
    expect(document.activeElement).toBe(open);
    await user.tab();
    expect(document.activeElement).toBe(summary);
    await user.tab();
    expect(document.activeElement).toBe(
      within(row).getByRole("button", { name: "Reveal in Finder" }),
    );
    // …and backwards from the open button leaves the row: the row takes no stop.
    open.focus();
    await user.tab({ shift: true });
    expect(row.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(row);
  });

  it("Enter on the open button opens the file", async () => {
    const { user } = renderUi(<InstructionsHost />, { fixtures: instructionFixtures });
    const { open } = await personalRow();
    open.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(opened(PERSONAL)).toBe(true));
    expect(tauri().callsOf("personal_instruction_read")).toHaveLength(1);
  });

  it("a mouse press on the row's body (its hint) still opens it", async () => {
    const { user } = renderUi(<InstructionsHost />, { fixtures: instructionFixtures });
    const { row } = await personalRow();
    const hint = row.querySelector<HTMLElement>(".ux-row-hint");
    if (!hint) throw new Error("no hint on the row");
    await user.click(hint);
    await waitFor(() => expect(opened(PERSONAL)).toBe(true));
    expect(tauri().callsOf("personal_instruction_read")).toHaveLength(1);
  });

  it("the Procedure row that opens is a row with an open button named by its title", async () => {
    const { user } = renderUi(<InstructionsHost />, { fixtures: instructionFixtures });
    const open = await screen.findByRole("button", { name: PROCEDURE_LABEL });
    const row = rowOf(open);
    expect(row.getAttribute("data-kind")).toBe("procedure");
    expect(row.getAttribute("role")).toBeNull();
    open.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(opened(AGENTS)).toBe(true));
    // One open per press: the button's click and the row's are one path.
    expect(tauri().callsOf("fs_read_text_file")).toHaveLength(1);
  });
});

// ── The Library: a skill row with its step and its ⋯ ─────────────────────────

const SKILL_CWD = "/Users/someone/code/project";
const skillsView: ProjectSkillsView = {
  workspaceId: WS,
  workspaceName: "project",
  cwd: SKILL_CWD,
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
const MIRROR = "/Users/someone/Library/Application Support/com.mbadv.ply/projects/ws-181/shared_library";
const libraryState = {
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
      description: "Ships the app to staging.",
      dir: `${MIRROR}/.claude/skills/deploy`,
      claude: true,
      codex: true,
      differs: false,
      codexDir: `${MIRROR}/.agents/skills/deploy`,
    },
  ],
  skipped: [],
  suppliedToCheckout: ["deploy"],
  branchCodex: { reaches: true, refused: null },
} as LibraryStateLike;

function SkillsHost() {
  const data = useSkillsData(WS, true);
  return <SkillsPage workspaceId={WS} cwd={SKILL_CWD} data={data} />;
}

describe("Library › a skill row: its controls are its own", () => {
  it("every control in the row is exposed; pressing one does not open the skill", async () => {
    const { user } = renderUi(<SkillsHost />, {
      fixtures: {
        project_skills_view: () => skillsView,
        knowledge_project_state: () => libraryState,
        personal_skills_view: () => ({ skills: [], rootsPresent: [], errors: [] }),
        skills_hub_links: () => ({ links: [], unreadable: [] }),
        ply_skills_view: () => ({ skills: [], problem: null }),
        // What the skill's own page reads once it opens.
        fs_list_dir: () => [],
        skill_history: () => [],
        fs_read_text_file: () => "# deploy\n",
      },
    });
    const open = await screen.findByRole("button", { name: "deploy" });
    const row = rowOf(open);
    expect(row.getAttribute("role")).toBeNull();

    const controls = within(row)
      .getAllByRole("button")
      .filter((b) => b !== open);
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(exposed(control)).toBe(true);

    const openSkill = () => useLibrary.getState().byWorkspace[WS]?.openSkill ?? null;
    const more = within(row).getByRole("button", { name: "More for deploy" });
    expect(controls).toContain(more);
    await user.click(more);
    expect(openSkill()).toBeNull();

    await user.keyboard("{Escape}");
    open.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(openSkill()).not.toBeNull());
  });
});

describe("Library › a Plyloft skill row: its switch is its own (review 1, N3)", () => {
  // SkillRow's `Comes with Ply` branch: a toggle row that also opens the
  // skill's page. Only the fields that branch reads are given.
  const plyRow = {
    key: "ply:card-brief",
    name: "card-brief",
    hint: "Turns a rough idea into a brief an agent can work from.",
    duplicate: null,
    menu: [],
    ply: { title: "Card brief", on: true },
  } as unknown as SkillRowModel;

  function renderPly() {
    const onOpen = vi.fn();
    const onSwitch = vi.fn();
    const r = renderUi(
      <Group>
        <SkillRow
          row={plyRow}
          onOpen={onOpen}
          onAction={vi.fn()}
          onMenu={vi.fn()}
          onSwitch={onSwitch}
        />
      </Group>,
    );
    return { ...r, onOpen, onSwitch };
  }

  it("the switch is exposed, named by the row, and pressing it does not open the page", async () => {
    const { user, onOpen, onSwitch } = renderPly();
    const open = screen.getByRole("button", { name: "Card brief" });
    const row = rowOf(open);
    expect(row.getAttribute("role")).toBeNull();

    const toggle = within(row).getByRole("switch", { name: "Card brief" });
    expect(exposed(toggle)).toBe(true);
    await user.click(toggle);
    expect(onSwitch).toHaveBeenCalledWith(false);
    expect(onOpen).not.toHaveBeenCalled();

    // Tab: the open button, then the switch.
    open.focus();
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard(" ");
    expect(onSwitch).toHaveBeenCalledTimes(2);
    expect(onOpen).not.toHaveBeenCalled();

    // The row's body and its open button still open the page.
    await user.click(screen.getByText(plyRow.hint as string));
    expect(onOpen).toHaveBeenCalledTimes(1);
    open.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

// ── The layer's Row: a Procedure row with a step, a Details and `›` ───────────

describe("Row: an opening Procedure row that holds a step", () => {
  function renderRow(onOpen = vi.fn(), onStep = vi.fn()) {
    const r = renderUi(
      <Group>
        <Row
          kind="procedure"
          label="Choose zsh"
          hint="Plyloft runs your agents in your login shell."
          onOpen={onOpen}
          action={<CBtn onClick={onStep}>Choose</CBtn>}
        >
          <Details>
            <div>/bin/zsh</div>
          </Details>
        </Row>
      </Group>,
    );
    return { ...r, onOpen, onStep };
  }

  it("exposes the step and the summary, and names the open button by the title", () => {
    renderRow();
    const open = screen.getByRole("button", { name: "Choose zsh" });
    const row = rowOf(open);
    expect(row.getAttribute("role")).toBeNull();
    expect(open.getAttribute("aria-describedby")).toBe(
      row.querySelector(".ux-row-hint")?.id,
    );
    expect(exposed(screen.getByRole("button", { name: "Choose" }))).toBe(true);
    expect(exposed(screen.getByText("Details", { selector: "summary" }))).toBe(true);
    // The `›` stays what it was: decoration, hidden from the tree.
    expect(row.querySelector(".ux-row-chevron")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the step and the summary never open the row; the body and the label do, once each", async () => {
    const { user, onOpen, onStep } = renderRow();
    await user.click(screen.getByRole("button", { name: "Choose" }));
    expect(onStep).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText("Details", { selector: "summary" }));
    await user.click(screen.getByText("/bin/zsh"));
    expect(onOpen).not.toHaveBeenCalled();

    await user.click(screen.getByText("Plyloft runs your agents in your login shell."));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Choose zsh" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("Tab: the open button, the Details, the step; Enter and Space open", async () => {
    const { user, onOpen, onStep } = renderRow();
    await user.tab();
    const open = screen.getByRole("button", { name: "Choose zsh" });
    expect(document.activeElement).toBe(open);
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onOpen).toHaveBeenCalledTimes(2);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByText("Details", { selector: "summary" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose" }));
    await user.keyboard("{Enter}");
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("a row that does not open has no open button", () => {
    renderUi(<Row kind="procedure" label="Reveal log folder" action={<CBtn>Reveal</CBtn>} />);
    expect(screen.queryByRole("button", { name: "Reveal log folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal" })).toBeTruthy();
  });
});
