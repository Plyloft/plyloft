// Skills hub H10 (R6): My library in All skills — the create sheet, Use it
// on this Mac, the gone state with its three ways out, Add to My library
// with the two-computer compare, on every plan.
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { MyLibraryPanel, MyLibrarySkillActions } from "../components/allSkills/MyLibrary";
import type { MyLibraryCompare, MyLibraryView } from "../ipc";
import type { HubRow } from "../lib/allSkills";
import { useMyLibrary } from "../store/myLibraryStore";
import { useAllSkills } from "../store/allSkillsStore";
import { renderUi, screen } from "./render";
import { resetToastsForTests } from "../store/toastStore";

const NOW = Date.now();

function view(over: Partial<MyLibraryView> = {}): MyLibraryView {
  return {
    repo: "matteo/plyloft-skills",
    account: "matteo",
    hasClone: true,
    lastPullAt: NOW - 4 * 60_000,
    lastAttemptAt: NOW - 4 * 60_000,
    lastError: null,
    goneAt: null,
    defaultName: "plyloft-skills",
    accounts: [],
    plugin: "mine",
    ...over,
  };
}

const NONE = view({ repo: null, account: null, hasClone: false, lastPullAt: null, accounts: [{ login: "matteo", active: true }] });

function row(over: Partial<HubRow> = {}): HubRow {
  return {
    key: "thisMac:sql-style",
    scope: "thisMac",
    name: "sql-style",
    description: "SQL style.",
    claude: true,
    codex: true,
    claudeId: "a",
    codexId: "a",
    twinsDiffer: false,
    legacyCodex: false,
    dir: "/Users/m/.claude/skills/sql-style",
    changedAt: null,
    tooManyFiles: false,
    needsOk: false,
    offHere: false,
    workspaceId: null,
    workspaceName: null,
    repo: null,
    missing: false,
    fromCheckout: false,
    placeholder: false,
    path: null,
    ...over,
  } as HubRow;
}

/** Every render here may read All skills again behind it, and look for a
 *  My library on GitHub. */
const BASE = {
  skills_hub_index: () => ({ index: useAllSkills.getState().index, refreshing: false, reading: [] }),
  skills_hub_index_refresh: () => null,
  my_library_find: () => null,
};

function choose(label: string) {
  fireEvent.click(screen.getByText(label, { selector: ".ux-choice-label" }));
}

afterEach(() => {
  useMyLibrary.setState({ view: null, found: null, foundFor: null, sheet: null });
});

describe("My library in All skills", () => {
  it("offers Create and, when GitHub has one, Use it on this Mac", async () => {
    useMyLibrary.setState({ view: NONE });
    const { tauri } = renderUi(<MyLibraryPanel skills={0} />, {
      fixtures: { ...BASE,
        my_library_status: () => NONE,
        my_library_find: () => "matteo/plyloft-skills",
        my_library_use: () => view(),
      },
    });
    expect(await screen.findByText("Your My library matteo/plyloft-skills is on GitHub — use it on this Mac.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Use it on this Mac/ }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_use")[0]?.args).toEqual({ repo: "matteo/plyloft-skills", account: "matteo" });
    expect(useMyLibrary.getState().view?.repo).toBe("matteo/plyloft-skills");
  });

  it("the create sheet seeds the chosen skills of this Mac and says what reaches where", async () => {
    useMyLibrary.setState({ view: NONE, sheet: "create" });
    useAllSkills.setState({
      index: { ...useAllSkills.getState().index, thisMac: { repo: null, readAt: NOW, problem: null, rows: [row(), row({ name: "my-review", key: "thisMac:my-review" })] } },
    });
    const { tauri } = renderUi(<MyLibraryPanel skills={0} />, {
      fixtures: { ...BASE, my_library_status: () => NONE, my_library_find: () => null, my_library_create: () => view() },
    });
    expect(screen.getByText(/Plyloft creates matteo\/plyloft-skills \(private\)\./)).toBeTruthy();
    expect(screen.getByText("Copies you link into shared repositories name this repository.")).toBeTruthy();
    choose("Start with skills from this Mac");
    fireEvent.click(screen.getByLabelText("my-review"));
    expect(screen.getByText(/get my-review from the next session, as mine:my-review, for Claude and Codex\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create on GitHub/ }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_create")[0]?.args).toEqual({ name: "plyloft-skills", account: "matteo", seed: ["my-review"] });
    expect(useMyLibrary.getState().sheet).toBeNull();
  });

  it("a token without repo shows Grant it", async () => {
    useMyLibrary.setState({ view: NONE, sheet: "create" });
    renderUi(<MyLibraryPanel skills={0} />, {
      fixtures: { ...BASE,
        my_library_status: () => NONE,
        my_library_find: () => null,
        my_library_create: () => {
          throw new Error("GitHub needs one more permission to create a private repository — Grant it, then try again. Nothing was created.");
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create on GitHub/ }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Grant it" })).toBeTruthy();
  });

  it("Grant it is offered only for gh's active account; another account is told how", async () => {
    const two = { ...NONE, accounts: [{ login: "matteo", active: true }, { login: "test", active: false }] };
    useMyLibrary.setState({ view: two, sheet: "create" });
    renderUi(<MyLibraryPanel skills={0} />, {
      fixtures: { ...BASE,
        my_library_status: () => two,
        my_library_create: () => {
          throw new Error("GitHub needs one more permission to create a private repository — Grant it, then try again. Nothing was created.");
        },
      },
    });
    fireEvent.change(screen.getByLabelText("GitHub account"), { target: { value: "test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create on GitHub/ }));
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Grant it" })).toBeNull();
    expect(screen.getByText(/gh auth switch -h github.com -u test, then gh auth refresh -h github.com -s repo/)).toBeTruthy();
  });

  it("a signed-out account says so, not gone", async () => {
    const out = view({ lastError: "signIn" });
    useMyLibrary.setState({ view: out });
    renderUi(<MyLibraryPanel skills={1} />, { fixtures: { ...BASE, my_library_status: () => out } });
    expect(screen.getByText("Last updated 4 minutes ago · matteo isn't signed in on this Mac")).toBeTruthy();
    expect(screen.getByText(/My library uses the GitHub account matteo, which isn't signed in on this Mac\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create it again/ })).toBeNull();
  });

  it("gone: the last copy keeps serving, with the three ways out; Stop asks first", async () => {
    const gone = view({ goneAt: NOW, lastError: "gone", lastPullAt: NOW - 3 * 86_400_000 });
    useMyLibrary.setState({ view: gone });
    const { tauri } = renderUi(<MyLibraryPanel skills={2} />, {
      fixtures: { ...BASE, my_library_status: () => gone, my_library_recreate: () => view(), my_library_forget: () => NONE },
    });
    expect(
      screen.getByText(
        "Your My library matteo/plyloft-skills isn't reachable with the GitHub account matteo any more. Your sessions still get the copy from 3 days ago.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Point to another repository…/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop using it on this Mac/ }));
    expect(tauri.callsOf("my_library_forget")).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Stop using it" }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_forget")).toHaveLength(1);
  });

  it("Create it again re-creates the repository", async () => {
    const gone = view({ goneAt: NOW, lastError: "gone" });
    useMyLibrary.setState({ view: gone });
    const { tauri } = renderUi(<MyLibraryPanel skills={2} />, {
      fixtures: { ...BASE, my_library_status: () => gone, my_library_recreate: () => view() },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create it again/ }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_recreate")).toHaveLength(1);
    expect(screen.getByText("Updated 4 minutes ago")).toBeTruthy();
  });

  it("Create My library opens the create sheet with no plan check", () => {
    useMyLibrary.setState({ view: NONE });
    renderUi(<MyLibraryPanel skills={0} />, { fixtures: { ...BASE, my_library_status: () => NONE } });
    fireEvent.click(screen.getByRole("button", { name: /Create My library/ }));
    expect(useMyLibrary.getState().sheet).toBe("create");
    expect(screen.queryByText(/part of Pro/)).toBeNull();
  });
});

describe("Add to My library (Promote → My library)", () => {
  const compare: MyLibraryCompare = {
    skill: "sql-style",
    otherId: "o1",
    otherAuthor: "matteo",
    otherAt: NOW - 60_000,
    twoWay: false,
    files: [{ path: "SKILL.md", status: "both", base: "v1\n", upstream: "v2\n", here: "v3\n", notShown: false }],
  };

  it("publishes, and a change from the other computer shows the compare; the answer names what it saw", async () => {
    useMyLibrary.setState({ view: view() });
    let first = true;
    const { tauri } = renderUi(<MyLibrarySkillActions row={row()} onBack={() => {}} />, {
      fixtures: { ...BASE,
        my_library_status: () => view(),
        my_library_publish: () => {
          if (first) {
            first = false;
            return { kind: "compare", compare };
          }
          return { kind: "published", skill: "sql-style", commit: "c" };
        },
      },
      withToasts: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /Add to My library/ }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_publish")[0]?.args).toEqual({
      source: { kind: "thisMac", skill: "sql-style" },
      choice: null,
      expected: null,
    });
    expect(screen.getByText("sql-style changed on another computer and on this Mac")).toBeTruthy();
    expect(screen.getByText(/Before · the version both started from/)).toBeTruthy();
    choose("Keep the other's");
    fireEvent.click(screen.getByRole("button", { name: "Keep the other's" }));
    await act(async () => {});
    expect(tauri.callsOf("my_library_publish")[1]?.args).toEqual({
      source: { kind: "thisMac", skill: "sql-style" },
      choice: "keepOther",
      expected: "o1",
    });
  });

  // 1.176.4 review (S2): a commit kept after a push the time limit stopped
  // is said calmly as kept — not as a failure — and All skills is read
  // again; commits set aside on the way are said too.
  it("a kept publish is an info toast, not an error, and earlier ones set aside are said", async () => {
    useMyLibrary.setState({ view: view() });
    const words = "GitHub didn't answer in time while Plyloft was adding `sql-style` to My library. It is kept in My library on this Mac, and may not be on GitHub yet: it goes there only when you add a skill to My library again and that push goes through.";
    const aside = "My library changed on GitHub while `old` waited on this Mac to go there, so My library on this Mac went back to GitHub's copy.";
    let calls = 0;
    const { tauri } = renderUi(<MyLibrarySkillActions row={row()} onBack={() => {}} />, {
      fixtures: { ...BASE,
        my_library_status: () => view(),
        my_library_publish: () => {
          calls += 1;
          return calls === 1
            ? { kind: "kept", skill: "sql-style", words, needsOk: false }
            : { kind: "published", skill: "sql-style", commit: "c", setAside: aside };
        },
      },
      withToasts: true,
    });
    const refreshes = tauri.callsOf("skills_hub_index").length;
    fireEvent.click(screen.getByRole("button", { name: /Add to My library/ }));
    await act(async () => {});
    const kept = screen.getByText(words);
    expect(kept.closest(".toast")?.className).toContain("toast-info");
    expect(screen.queryByText(words, { selector: ".ux-hub-actions *" })).toBeNull();
    expect(tauri.callsOf("skills_hub_index").length).toBeGreaterThan(refreshes);
    act(() => resetToastsForTests());
    fireEvent.click(screen.getByRole("button", { name: /Add to My library/ }));
    await act(async () => {});
    const toast = screen.getByText(aside).closest(".toast");
    expect(toast?.textContent).toContain("sql-style is in My library.");
  });

  // 1.175.0 B1: what waits is read from the sheet's own review, so the row
  // says a script for a script and, for a text that asks, what it asks for.
  const waitingReview = (files: object[]) => ({
    skill: "check",
    plugin: "mine",
    commit: "c".repeat(40),
    scriptsIds: ["s"],
    firstTime: true,
    approvedAt: null,
    author: null,
    files,
  });
  const file = (over: object) => ({ path: "SKILL.md", kind: "text", executable: false, size: 10, change: "new", text: "x", tooLarge: false, copies: [], ...over });

  it("a My library skill with a script gets Review", async () => {
    useMyLibrary.setState({ view: view() });
    renderUi(
      <MyLibrarySkillActions row={row({ scope: "myLibrary", key: "myLibrary:check", name: "check", needsOk: true, plugin: "mine" })} onBack={() => {}} />,
      {
        fixtures: {
          ...BASE,
          my_library_status: () => view(),
          skills_hub_scripts_review: () => waitingReview([file({ path: "scripts/check.sh", kind: "script" }), file({})]),
        },
      },
    );
    // Until the review is read, only that it waits.
    expect(screen.getByText("Needs your OK. New sessions on this Mac get it once you say OK.")).toBeTruthy();
    expect(await screen.findByText(/Needs your OK · it brings a script\. New sessions on this Mac get it once you say OK\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("a My library skill whose text asks says what it asks for", async () => {
    useMyLibrary.setState({ view: view() });
    const asks = { unreadable: null, inline: [], commands: { line: 3, tools: ["Bash"], any: true }, writes: null, hooks: null, strongest: "commands" };
    renderUi(
      <MyLibrarySkillActions row={row({ scope: "myLibrary", key: "myLibrary:check", name: "check", needsOk: true, plugin: "mine" })} onBack={() => {}} />,
      {
        fixtures: {
          ...BASE,
          my_library_status: () => view(),
          skills_hub_scripts_review: () => ({ ...waitingReview([file({ kind: "asks", asks })]), asks: "commands" }),
        },
      },
    );
    expect(
      await screen.findByText(
        "Needs your OK · it lets agents run commands without asking you. New sessions on this Mac get it once you say OK.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("with no My library yet, offers to create one", () => {
    useMyLibrary.setState({ view: NONE });
    renderUi(<MyLibrarySkillActions row={row()} onBack={() => {}} />, { fixtures: { ...BASE, my_library_status: () => NONE } });
    fireEvent.click(screen.getByRole("button", { name: /Create My library to add it/ }));
    expect(useMyLibrary.getState().sheet).toBe("create");
  });
});
