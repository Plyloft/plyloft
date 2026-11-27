// GH #317: Diagnostics, Dictation and Worktrees lead with words. No absolute
// path (`/Users/…`, `/opt/…`) or branch name is drawn in a row's first layer;
// each is still one step away, behind the row's ⋯ (`Copy where it is`, `Copy
// the branch name`) or a Details.
import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { DiagnosticsPage } from "../components/settings/DiagnosticsPage";
import { DictationPage } from "../components/settings/DictationPage";
import { WorktreesPage, worktreeHint } from "../components/settings/WorktreesPage";
import type { DoctorReport, KanbanCard } from "../ipc";
import { useKanban } from "../store/kanbanStore";
import { act, renderUi, screen, waitFor } from "./render";

const ABSOLUTE = /\/Users\/|\/opt\//;

/** What is drawn outside an unopened menu and outside the body of a Details
 *  (its summary stays: that is on screen). */
function firstLayer(): string {
  const copy = document.body.cloneNode(true) as HTMLElement;
  for (const d of copy.querySelectorAll("details")) {
    for (const child of [...d.children]) if (child.tagName !== "SUMMARY") child.remove();
  }
  return copy.textContent ?? "";
}

describe("GH #317: paths behind ⋯ and Details", () => {
  it("Diagnostics: a tool's row says what it is for, and its place is in ⋯", async () => {
    const report = {
      tools: [
        {
          id: "gh",
          name: "GitHub command",
          required: false,
          found: true,
          path: "/opt/homebrew/bin/gh",
          version: "2.100.0",
          versionOk: true,
          detail: "Found. Opens pull requests from Plyloft.",
          installCmd: "brew install gh",
          docsUrl: "https://cli.github.com",
          reviewer: null,
        },
      ],
      teamSkills: null,
      projectSkills: null,
      microphone: null,
      whisperModel: null,
      dictationShell: null,
      sharedDefinition: null,
      probeError: null,
      allRequiredOk: true,
    } as unknown as DoctorReport;
    const { user } = renderUi(<DiagnosticsPage scope="this-mac" />, {
      fixtures: {
        dependency_doctor: () => report,
        build_cache_status: () => ({
          workspaceId: "w1",
          workspaceName: "atelier",
          enabled: true,
          status: { path: "/Users/me/code/atelier/.atelier-worktrees/.cargo-target", bytes: 2_000_000, exists: true },
        }),
      },
    });
    // 1.174.0 (DS7): "gh 2.100.0 · <sentence>" under what it is for.
    const hint = await screen.findByText("gh 2.100.0 · Found. Opens pull requests from Plyloft.");
    await screen.findByText("Build cache");
    expect(firstLayer()).not.toMatch(ABSOLUTE);
    // The build cache's own file names are in its Details, not its line.
    const cacheRow = screen.getByText("Build cache").closest(".ux-row") as HTMLElement;
    expect(cacheRow.textContent).not.toMatch(/shared-cargo-target|target\//);

    const row = hint.closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "More about gh" }));
    expect(screen.getByRole("menuitem", { name: "Copy where it is" })).toBeTruthy();
  });

  it("Dictation: the model and whisper.cpp say Ready and Installed, not where they are", async () => {
    const { user } = renderUi(<DictationPage scope="this-mac" />, {
      fixtures: {
        dictation_status: () => ({
          whisperCli: "/opt/homebrew/bin/whisper-cli",
          models: [
            {
              id: "small",
              fileName: "ggml-small.bin",
              path: "/Users/me/Library/Application Support/com.mbadv.ply/whisper/ggml-small.bin",
              present: true,
              sizeBytes: 488_000_000,
              approxBytes: 466_000_000,
              downloading: false,
            },
            {
              id: "base",
              fileName: "ggml-base.bin",
              path: "/Users/me/Library/Application Support/com.mbadv.ply/whisper/ggml-base.bin",
              present: false,
              sizeBytes: null,
              approxBytes: 148_000_000,
              downloading: false,
            },
          ],
        }),
      },
    });
    await screen.findByText("Installed");
    await waitFor(() => expect(firstLayer()).toMatch(/On this Mac — /));
    expect(firstLayer()).not.toMatch(ABSOLUTE);
    await user.click(screen.getByRole("button", { name: "More about whisper.cpp" }));
    expect(screen.getByRole("menuitem", { name: "Copy where it is" })).toBeTruthy();
  });

  it("Worktrees: a checkout reads as its card, with the path and branch in ⋯", async () => {
    act(() =>
      useKanban.setState({
        byWorkspace: {
          w1: {
            cards: [{ id: "card-1", title: "Fix the sidebar", columnId: "in_progress" } as KanbanCard],
            loaded: true,
          },
        },
      } as never),
    );
    const { user } = renderUi(<WorktreesPage scope="repository" workspaceId="w1" />, {
      fixtures: {
        worktree_list: () => [
          {
            dirName: "card-1",
            branchName: "card/fix-the-sidebar",
            worktreePath: "/Users/me/code/atelier/.atelier-worktrees/card-1",
            exists: true,
          },
          {
            dirName: "card-gone",
            branchName: "card/gone",
            worktreePath: "/Users/me/code/atelier/.atelier-worktrees/card-gone",
            exists: true,
          },
        ],
        worktree_kept_list: () => [
          {
            path: "/Users/me/.Trash/atelier-kept/card-9",
            dirName: "card-9",
            cardId: "card-9",
            stagedAtMs: 0,
            bytes: 10,
          },
        ],
      },
    });
    const title = await screen.findByText("Fix the sidebar");
    expect(screen.getByText("card · Working")).toBeTruthy();
    expect(screen.getByText("A card copy no card owns")).toBeTruthy();
    expect(firstLayer()).not.toMatch(ABSOLUTE);
    expect(firstLayer()).not.toMatch(/card\/fix-the-sidebar/);

    const row = title.closest(".ux-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "More for Fix the sidebar" }));
    expect(screen.getByRole("menuitem", { name: "Copy the branch name" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy where it is" })).toBeTruthy();
  });
});

// 1.171.0 A3 (LG-19): a card nobody started is never "in Todo".
// 1.174.0 (DS5, scene 11): "card", then the Board's own column name.
describe("a card copy's hint", () => {
  it("says it is a card's, and where the card is in the Board's words", () => {
    expect(worktreeHint("todo")).toBe("card · Not started");
    expect(worktreeHint("complete")).toBe("card · Done");
    expect(worktreeHint("in_progress")).toBe("card · Working");
  });
});

// 1.174.0 B4 (round 1): `worktree_list` runs off the main thread, so a read
// for the workspace left behind can answer after the current one's.
describe("Worktrees: only the latest read is shown", () => {
  it("a slow answer for the previous workspace doesn't replace the current one", async () => {
    const cardOf = (id: string, title: string) => ({ id, title, columnId: "in_progress" }) as KanbanCard;
    act(() =>
      useKanban.setState({
        byWorkspace: {
          w1: { cards: [cardOf("old-1", "Left behind")], loaded: true },
          w2: { cards: [cardOf("new-1", "Current one")], loaded: true },
        },
      } as never),
    );
    let answerW1: (v: unknown) => void = () => {};
    const row = (dirName: string) => ({ dirName, branchName: `card/${dirName}`, worktreePath: `/p/${dirName}`, exists: true });
    const r = renderUi(<WorktreesPage scope="repository" workspaceId="w1" />, {
      fixtures: {
        worktree_list: ({ workspaceId }: Record<string, unknown>) =>
          workspaceId === "w1" ? new Promise((resolve) => (answerW1 = resolve)) : [row("new-1")],
        worktree_kept_list: () => [],
      },
    });
    r.tauri.allowUnhandled();
    r.rerender(<WorktreesPage scope="repository" workspaceId="w2" />);
    expect(await screen.findByText("Current one")).toBeTruthy();
    await act(async () => answerW1([row("old-1")]));
    await waitFor(() => expect(r.tauri.callsOf("worktree_list")).toHaveLength(2));
    expect(screen.getByText("Current one")).toBeTruthy();
    expect(screen.queryByText("Left behind")).toBeNull();
  });
});
