// GH #174: a personal instruction file opens in Code for reading.
//
// The real Instructions page, fed by its real data hook (`useInstructionsData`)
// through the stubbed Tauri layer, with the real `EditorPanel` beside it — the
// way the app shows the two. The fixture is a member's `~/.claude/CLAUDE.md`,
// listed by `library_instructions_view` exactly as Rust lists it.
//
// Pressing the row's `›` must: read the file through `personal_instruction_read`
// (Rust's guard) with the path Rust listed, open it in the editor store with the
// read-only flag (place `this-mac`, `readOnlyLine`'s words), and never call
// `fs_write_text_file` — not on the press, not on ⌘S. The control is the
// checkout's `CLAUDE.md` on the same page: its `›` opens a writable tab, and ⌘S
// there does write, so the refusals are the flag's doing and not the harness's.
import { describe, expect, it } from "vitest";
import { EditorPanel } from "../components/EditorPanel";
import { InstructionsPage } from "../components/library/InstructionsPage";
import { useInstructionsData } from "../components/library/useInstructionsData";
import type { InstructionsView } from "../ipc";
import { useEditor } from "../store/editorStore";
import { useToasts } from "../store/toastStore";
import { fireEvent, nextFrame, renderUi, screen, tauri, waitFor, within } from "./render";

const WS = "ws-174";
const PERSONAL = "/Users/someone/.claude/CLAUDE.md";
const PERSONAL_TEXT = "# Mine\nAlways answer in English.\n";
const CHECKOUT = "/Users/someone/code/project/CLAUDE.md";
const CHECKOUT_TEXT = "# Project\n";
// The line the editor draws over a personal instruction file — the literal
// words, not the function's output, so a change to them is seen here.
const PERSONAL_LINE =
  "Read-only — your own instruction file on this Mac, which every session here reads. " +
  "Plyloft reads it and never writes it; edit it in your own editor.";

const view: InstructionsView = {
  shared: false,
  branch: null,
  readOnly: false,
  repository: null,
  workspaceRoot: "/Users/someone/code/project",
  files: [
    {
      name: "CLAUDE.md",
      lines: 1,
      hint: "Claude Code reads it.",
      openInCode: CHECKOUT,
      readOnlyPath: null,
      located: "both",
    },
  ],
  procedure: { status: "compliant", sentence: "Both CLIs read the same instructions.", step: null },
  plan: null,
  personal: [{ rel: ".claude/CLAUDE.md", path: PERSONAL, cli: "Claude", lines: 2 }],
  errors: [],
} as InstructionsView;

const fixtures = {
  library_instructions_view: () => view,
  // An unshared workspace: the queue read is refused, which the page treats as
  // ordinary.
  knowledge_project_state: () => {
    throw new Error("not shared");
  },
  personal_instruction_read: ({ path }: Record<string, unknown>) => {
    if (path !== PERSONAL) throw new Error("That is not one of this Mac's instruction files.");
    return PERSONAL_TEXT;
  },
  fs_read_text_file: ({ path }: Record<string, unknown>) => {
    if (path !== CHECKOUT) throw new Error(`unexpected read of ${String(path)}`);
    return CHECKOUT_TEXT;
  },
  fs_write_text_file: () => null,
};

function Host() {
  const data = useInstructionsData(WS, true);
  return (
    <>
      <InstructionsPage workspaceId={WS} data={data} />
      <EditorPanel workspaceId={WS} />
    </>
  );
}

function openFile(path: string) {
  return useEditor.getState().byWorkspace[WS]?.openFiles.find((f) => f.path === path);
}

/** The `On this Mac` row for `rel`: the element that carries the row's `›`. */
async function row(rel: string): Promise<HTMLElement> {
  const label = await screen.findByText(rel);
  const el = label.closest<HTMLElement>(".ux-row");
  if (!el) throw new Error(`no row for ${rel}`);
  return el;
}

function pressSave(container: HTMLElement) {
  const cm = container.querySelector<HTMLElement>(".cm-content");
  if (!cm) throw new Error("no CodeMirror content element");
  fireEvent.keyDown(cm, { key: "s", code: "KeyS", keyCode: 83, metaKey: true });
}

describe("On this Mac: a personal instruction file", () => {
  it("opens read-only through Rust's guard, and ⌘S writes nothing", async () => {
    const { user, container } = renderUi(<Host />, { fixtures });
    const personal = await row(".claude/CLAUDE.md");
    // GH #181: the row is not a button; its label is, named by the file.
    expect(personal.getAttribute("role")).toBeNull();
    expect(within(personal).getByRole("button", { name: ".claude/CLAUDE.md" })).toBeTruthy();
    expect(personal.querySelector(".ux-row-chevron")?.textContent).toBe("›");

    await user.click(personal);
    await waitFor(() => expect(openFile(PERSONAL)).toBeDefined());

    // The bytes came from Rust's guarded read, asked with the path Rust listed —
    // never from a general-purpose read of a path the window holds.
    expect(tauri().callsOf("personal_instruction_read")).toEqual([
      { cmd: "personal_instruction_read", args: { path: PERSONAL } },
    ]);
    expect(tauri().callsOf("fs_read_text_file")).toEqual([]);

    const file = openFile(PERSONAL)!;
    expect(file.content).toBe(PERSONAL_TEXT);
    expect(file.readOnly).toEqual({ place: "this-mac", line: PERSONAL_LINE });
    expect(useEditor.getState().byWorkspace[WS]?.activePath).toBe(PERSONAL);

    await nextFrame();
    expect(container.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe(
      "false",
    );
    pressSave(container);
    await nextFrame();
    expect(tauri().callsOf("fs_write_text_file")).toEqual([]);
    expect(openFile(PERSONAL)?.initialContent).toBe(PERSONAL_TEXT);
  });

  it("toggling its Details opens nothing", async () => {
    const { user } = renderUi(<Host />, { fixtures });
    const personal = await row(".claude/CLAUDE.md");
    const summary = personal.querySelector<HTMLElement>("summary");
    if (!summary) throw new Error("no Details on the row");

    await user.click(summary);
    await nextFrame();
    expect(tauri().callsOf("personal_instruction_read")).toEqual([]);
    expect(openFile(PERSONAL)).toBeUndefined();
  });
});

describe("the same path already open, writable and edited (GH #174 review 1)", () => {
  // A workspace rooted at `~/.claude`: its `CLAUDE.md` is a checkout file and
  // `On this Mac`'s personal file at once. Its writable tab has unsaved edits.
  it("`›` keeps the edits, brings that tab forward and says why", async () => {
    useEditor.getState().open(WS, PERSONAL, PERSONAL_TEXT);
    useEditor.getState().setContent(WS, PERSONAL, PERSONAL_TEXT + "unsaved\n");
    useEditor.getState().open(WS, CHECKOUT, CHECKOUT_TEXT);
    const { user } = renderUi(<Host />, { fixtures, withToasts: true });

    await user.click(await row(".claude/CLAUDE.md"));
    expect(
      await screen.findByText(
        "This file has unsaved changes in its editable tab; save or discard them first.",
      ),
    ).toBeTruthy();

    const file = openFile(PERSONAL)!;
    expect(file.content).toBe(PERSONAL_TEXT + "unsaved\n");
    expect(file.readOnly).toBeUndefined();
    expect(useEditor.getState().byWorkspace[WS]?.activePath).toBe(PERSONAL);
    expect(tauri().callsOf("fs_write_text_file")).toEqual([]);
  });
});

describe("In this repository: the checkout's copy (the control)", () => {
  it("opens writable, and ⌘S there does write", async () => {
    const { user, container } = renderUi(<Host />, { fixtures });
    const label = await screen.findByText("CLAUDE.md");
    const checkout = label.closest<HTMLElement>(".ux-row")!;

    await user.click(checkout);
    await waitFor(() => expect(openFile(CHECKOUT)).toBeDefined());
    expect(openFile(CHECKOUT)?.readOnly).toBeUndefined();
    expect(tauri().callsOf("personal_instruction_read")).toEqual([]);

    await nextFrame();
    const cm = container.querySelector<HTMLElement>(".cm-content")!;
    expect(cm.getAttribute("contenteditable")).toBe("true");
    await user.click(cm);
    await user.keyboard("typed ");
    await waitFor(() => expect(openFile(CHECKOUT)?.content).toContain("typed "));
    pressSave(container);
    await waitFor(() => expect(tauri().callsOf("fs_write_text_file")).toHaveLength(1));
    expect(tauri().callsOf("fs_write_text_file")[0].args.path).toBe(CHECKOUT);
  });
});

describe("a failed open says it in words (GH #297)", () => {
  it("the raw error waits behind Details; the page's own refusal is the line", async () => {
    const { user } = renderUi(<Host />, {
      fixtures: {
        ...fixtures,
        personal_instruction_read: () => {
          throw new Error("EACCES: permission denied, open '/Users/someone/.claude/CLAUDE.md'");
        },
      },
    });
    await user.click(await row(".claude/CLAUDE.md"));
    await waitFor(() => expect(useToasts.getState().toasts.length).toBe(1));
    const toast = useToasts.getState().toasts[0];
    expect(toast.title).toBe("Couldn't open the file in Code");
    expect(toast.body).toBeUndefined();
    expect(toast.details).toMatch(/EACCES/);
  });
});
