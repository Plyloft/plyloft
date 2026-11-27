// Skills hub H6a (R15): the *Needs your OK* sheet for a team-library skill.
//
// It lists every file, scripts first, each one's text a press away; says what
// new sessions get meanwhile; and its OK approves exactly the version shown —
// a pull that landed meanwhile is refused by the backend, and the sheet reads
// the new version instead of approving it unseen.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent } from "@testing-library/react";
import { ScriptApprovalFlow, bringsWords, fileHint, ledeOf } from "../components/library/ScriptApprovalFlow";
import type { ScriptsReview } from "../ipc";
import { renderUi, screen } from "./render";
import { HeldVersion } from "../components/library/HeldVersion";

const REVIEW: ScriptsReview = {
  skill: "check-migrations",
  plugin: "ply-team",
  commit: "a".repeat(40),
  scriptsIds: ["s1"],
  firstTime: false,
  approvedAt: Date.UTC(2026, 9, 3, 12),
  author: "Ana",
  files: [
    {
      path: "scripts/check.sh",
      kind: "script",
      executable: true,
      size: 1229,
      change: "changed",
      text: "#!/bin/sh\npsql \"$DATABASE_URL\" -c 'select 1'\n",
      tooLarge: false,
      copies: [],
    },
    {
      path: "diagram.png",
      kind: "extra",
      executable: false,
      size: 38000,
      change: "unchanged",
      text: null,
      tooLarge: false,
      copies: [],
    },
    {
      path: "SKILL.md",
      kind: "text",
      executable: false,
      size: 4100,
      change: "unchanged",
      text: "---\ndescription: d\n---\n",
      tooLarge: false,
      copies: [],
    },
  ],
};

describe("ScriptApprovalFlow", () => {
  it("lists the files, scripts first, and shows a script's text on demand", async () => {
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="check-migrations" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => REVIEW },
    });
    expect(await screen.findByText("has a changed script", { exact: false })).toBeTruthy();
    expect(
      screen.getByText(
        "Ana changed a script in the team library. Agents may run it on this Mac when they use the skill. New sessions keep the version you approved on 3 Oct until you say OK.",
      ),
    ).toBeTruthy();
    const labels = screen.getAllByText(/^(scripts\/check\.sh|diagram\.png|SKILL\.md)$/).map((n) => n.textContent);
    expect(labels).toEqual(["scripts/check.sh", "diagram.png", "SKILL.md"]);
    expect(screen.getByText("Script")).toBeTruthy();
    expect(screen.getByText("executable")).toBeTruthy();
    expect(screen.getByText("Extra file")).toBeTruthy();
    expect(screen.queryByLabelText("scripts/check.sh text")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Show" })[0]);
    expect(screen.getByLabelText("scripts/check.sh text").textContent).toContain("select 1");
    expect(screen.getByRole("button", { name: "OK, use the new version" })).toBeTruthy();
  });

  it("approves exactly the commit and scripts it showed", async () => {
    const onDone = vi.fn();
    const { tauri } = renderUi(
      <ScriptApprovalFlow plugin="ply-team" skill="check-migrations" onDone={onDone} onCancel={() => {}} />,
      { fixtures: { skills_hub_scripts_review: () => REVIEW, skills_hub_approve: () => null } },
    );
    fireEvent.click(await screen.findByRole("button", { name: "OK, use the new version" }));
    await act(async () => {});
    expect(tauri.callsOf("skills_hub_approve")[0]?.args).toEqual({
      plugin: "ply-team",
      skill: "check-migrations",
      commit: "a".repeat(40),
      scriptsIds: ["s1"],
      library: null,
    });
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("reads the new version again when the library moved under the sheet", async () => {
    let reads = 0;
    const onDone = vi.fn();
    const { tauri } = renderUi(
      <ScriptApprovalFlow plugin="ply-team" skill="check-migrations" onDone={onDone} onCancel={() => {}} />,
      {
        fixtures: {
          skills_hub_scripts_review: () => {
            reads += 1;
            return REVIEW;
          },
          skills_hub_approve: () => {
            throw new Error("check-migrations changed while you were reading it. Open it again to see the new version.");
          },
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "OK, use the new version" }));
    await act(async () => {});
    await act(async () => {});
    expect(onDone).not.toHaveBeenCalled();
    expect(tauri.callsOf("skills_hub_scripts_review").length).toBe(2);
    expect(reads).toBe(2);
    expect(await screen.findByText(/changed while you were reading it/)).toBeTruthy();
  });

  it("Not now changes nothing", async () => {
    const onCancel = vi.fn();
    const { tauri } = renderUi(
      <ScriptApprovalFlow plugin="ply-team" skill="check-migrations" onDone={() => {}} onCancel={onCancel} />,
      { fixtures: { skills_hub_scripts_review: () => REVIEW } },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onCancel).toHaveBeenCalled();
    expect(tauri.callsOf("skills_hub_approve")).toHaveLength(0);
  });

  it("says there is nothing to approve once the skill needs no OK", async () => {
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="check-migrations" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => null },
    });
    expect(await screen.findByText("Nothing to approve any more. New sessions get it as it is.")).toBeTruthy();
  });

  it("words a first-time skill and a file it cannot show", () => {
    expect(ledeOf({ ...REVIEW, firstTime: true, approvedAt: null, author: null })).toBe(
      "Someone added it to the team library with a script. Agents may run it on this Mac when they use the skill. New sessions don't get it until you say OK.",
    );
    // (Challenger) A script added to a skill that was all text, and a skill
    // whose only new file is an image.
    expect(ledeOf({ ...REVIEW, firstTime: false, approvedAt: null })).toBe(
      "Ana added a script to it in the team library. Agents may run it on this Mac when they use the skill. New sessions keep the version from before the script until you say OK.",
    );
    expect(
      ledeOf({ ...REVIEW, firstTime: false, approvedAt: null, files: REVIEW.files.filter((f) => f.kind !== "script") }),
    ).toBe(
      "Ana added a file that is not text to it in the team library. Agents get it on this Mac when they use the skill. New sessions keep the version from before that file until you say OK.",
    );
    // Windows walk (H6b): after an OK, an image added beside an unchanged
    // script is what the heading and the lede name — not "a changed script".
    const imageOnly: ScriptsReview = {
      ...REVIEW,
      files: REVIEW.files.map((f) =>
        f.kind === "script" ? { ...f, change: "unchanged" } : f.kind === "extra" ? { ...f, change: "new" } : f,
      ),
    };
    expect(ledeOf(imageOnly)).toBe(
      "Ana added a file that is not text to it in the team library. Agents get it on this Mac when they use the skill. New sessions keep the version you approved on 3 Oct until you say OK.",
    );
    expect(bringsWords(imageOnly)).toBe("has a new file that is not text");
    const changedImage: ScriptsReview = {
      ...imageOnly,
      files: imageOnly.files.map((f) => (f.kind === "extra" ? { ...f, change: "changed" } : f)),
    };
    expect(bringsWords(changedImage)).toBe("has a changed file that is not text");
    expect(ledeOf(changedImage)).toContain("Ana changed a file that is not text in the team library.");
    // A new script beside a changed one: both, in one line.
    const both: ScriptsReview = {
      ...REVIEW,
      files: [...REVIEW.files, { ...REVIEW.files[0], path: "scripts/hello.ps1", change: "new" }],
    };
    expect(bringsWords(both)).toBe("has a new or changed script");
    expect(ledeOf(both)).toContain("Ana added or changed a script in the team library.");
    expect(bringsWords(REVIEW)).toBe("has a changed script");
    expect(bringsWords({ ...REVIEW, firstTime: true, approvedAt: null })).toBe("brings a script");
    expect(fileHint(REVIEW.files[1])).toBe("37.1 KB · unchanged · not text, so not shown");
    expect(fileHint({ ...REVIEW.files[0], text: null, tooLarge: true, size: 2 * 1024 * 1024 })).toBe(
      "2.0 MB · changed · too large to show here",
    );
  });
});

// 1.175.0 B1 (SEC-1, proof P1): a skill of one SKILL.md whose text asks to
// run things. The same page, the same two buttons; in place of a list of
// script files it says what the text asks to be allowed to do.
describe("a skill whose text asks", () => {
  const TEXT = "---\nname: release-notes\nallowed-tools: Bash(git log:*), Bash(gh release create:*), Write, Edit\n---\n\nLast tag: !`git describe --tags --abbrev=0`\n";
  const asks = {
    unreadable: null,
    inline: [{ line: 6, command: "git describe --tags --abbrev=0" }],
    commands: { line: 3, tools: ["Bash(git log:*)", "Bash(gh release create:*)"], any: false },
    writes: { line: 3, tools: ["Write", "Edit"], any: false },
    hooks: null,
    // Y1: the backend's one rule says the widest; the page reads it.
    strongest: "commands" as const,
  };
  const FIRST: ScriptsReview = {
    skill: "release-notes",
    plugin: "ply-team",
    commit: "b".repeat(40),
    scriptsIds: ["t1"],
    firstTime: true,
    approvedAt: null,
    author: "example-teammate",
    files: [{ path: "SKILL.md", kind: "asks", executable: false, size: 2150, change: "new", text: TEXT, tooLarge: false, copies: [], asks }],
    // Y1 round 2: the review's own answer, over all its texts.
    asks: "commands",
  };

  it("says what it asks to be allowed to do, strongest first, and approves that exact version", async () => {
    const onDone = vi.fn();
    const { user, tauri, container } = renderUi(
      <ScriptApprovalFlow plugin="ply-team" skill="release-notes" onDone={onDone} onCancel={() => {}} />,
      { fixtures: { skills_hub_scripts_review: () => FIRST, skills_hub_approve: () => null } },
    );
    expect(await screen.findByText("asks to run commands", { exact: false })).toBeTruthy();
    expect(
      screen.getByText(
        "example-teammate added it to the team library. It brings no script, but its text lets agents run commands on this Mac without asking you. New sessions don't get it until you say OK.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What it asks to be allowed to do" })).toBeTruthy();
    const items = [...container.querySelectorAll("[data-ply-ask]")];
    expect(items.map((li) => li.getAttribute("data-ply-ask"))).toEqual(["inline", "commands", "writes"]);
    expect(items[0].textContent).toContain("Run a command as soon as the skill loads");
    expect(items[0].textContent).toContain("Written in the text, line 6.");
    expect(items[0].textContent).toContain("git describe --tags --abbrev=0");
    expect(items[1].textContent).toContain("Run these commands without asking you");
    expect(items[1].textContent).toContain("From `allowed-tools`, line 3.");
    expect(items[1].textContent).toContain("Bash(gh release create:*)");
    expect(items[2].textContent).toContain("Change files without asking you");
    // The text is the file, a press away, and the OK is for these bytes.
    expect(screen.getByText("2.1 KB · new · your OK is for this exact text")).toBeTruthy();
    expect(screen.getByText("Text")).toBeTruthy();
    expect(screen.queryByLabelText("SKILL.md text")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByLabelText("SKILL.md text").textContent).toBe(TEXT);
    expect(
      screen.getByText(
        "A skill that is only text and asks for none of this never asks. A skill delivered with a hooks file or an MCP server is refused, whatever you answer here. Your OK is for this Mac only; if SKILL.md changes, Plyloft asks again.",
      ),
    ).toBeTruthy();
    // The same two buttons, nothing added.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Hide", "Not now", "OK, use it"]);
    await user.click(screen.getByRole("button", { name: "OK, use it" }));
    expect(tauri.callsOf("skills_hub_approve")[0].args).toMatchObject({ skill: "release-notes", commit: "b".repeat(40), scriptsIds: ["t1"] });
    expect(onDone).toHaveBeenCalledWith(true);
  });

  it("says what changed in what it asks, with the two versions of the item that differs", async () => {
    const before = { ...asks, inline: [], commands: { line: 3, tools: ["Bash(git log:*)"], any: false } };
    const changed: ScriptsReview = {
      ...FIRST,
      firstTime: false,
      approvedAt: Date.UTC(2026, 9, 3, 12),
      files: [{ ...FIRST.files[0], change: "changed", asksBefore: before, textBefore: TEXT.replace(", Bash(gh release create:*)", "").replace("Last tag", "Tag") }],
    };
    const { user, container } = renderUi(
      <ScriptApprovalFlow plugin="ply-team" skill="release-notes" onDone={() => {}} onCancel={() => {}} />,
      { fixtures: { skills_hub_scripts_review: () => changed } },
    );
    expect(await screen.findByText("has a changed text", { exact: false })).toBeTruthy();
    expect(
      screen.getByText("example-teammate changed SKILL.md in the team library. New sessions keep the version you approved on 3 Oct until you say OK."),
    ).toBeTruthy();
    const chips = [...container.querySelectorAll("[data-ply-ask]")].map((li) => [li.getAttribute("data-ply-ask"), li.querySelector(".cchip")?.textContent]);
    expect(chips).toEqual([
      ["inline", "new"],
      ["commands", "changed"],
      ["writes", "unchanged"],
    ]);
    const commands = container.querySelector('[data-ply-ask="commands"]')!;
    expect(commands.textContent).toContain("You approved on 3 Oct");
    expect(commands.textContent).toContain("Now");
    expect([...commands.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Bash(gh release create:*)"]);
    expect(screen.getByText("2.1 KB · changed · 2 lines differ from the version you approved")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show both" }));
    expect(screen.getByLabelText("SKILL.md text you approved").textContent).toContain("Tag: !`git describe");
    expect(container.querySelectorAll("[data-ply-text-versions] mark")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "OK, use the new version" })).toBeTruthy();
  });

  it("says a text it couldn't read, with the file open", async () => {
    const unreadable: ScriptsReview = {
      ...FIRST,
      skill: "old-importer",
      files: [{ ...FIRST.files[0], asks: { unreadable: 3, inline: [], commands: null, writes: null, hooks: null, strongest: "unreadable" } }],
      asks: "unreadable",
    };
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="old-importer" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => unreadable },
    });
    expect(
      await screen.findByText(
        "Plyloft couldn't read the top of SKILL.md (line 3), so it can't tell what this skill asks for. Read the text before you say OK.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("SKILL.md text")).toBeTruthy();
    expect((screen.getByRole("button", { name: "OK, use it" }) as HTMLButtonElement).disabled).toBe(false);
  });

  // Y1 round 2 (the owner, 2026-11-09): a top Plyloft can't read is said
  // first — in the title and the lede — even when something known was found;
  // the sentence sits above the list of what was found, not in its place.
  it("says couldn't read first and still lists what it found", async () => {
    const found: ScriptsReview = {
      ...FIRST,
      skill: "old-importer",
      files: [{ ...FIRST.files[0], asks: { ...asks, unreadable: 3, strongest: "unreadable" } }],
      asks: "unreadable",
    };
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="old-importer" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => found },
    });
    const sentence = await screen.findByText(
      "Plyloft couldn't read the top of SKILL.md (line 3), so it can't tell what this skill asks for. Read the text before you say OK.",
    );
    expect(screen.getByText("has a text Plyloft couldn't read", { exact: false })).toBeTruthy();
    expect(screen.getByText(/It brings no script, but Plyloft couldn't read what its text asks for\./)).toBeTruthy();
    const list = document.querySelector(".ux-asks-list")!;
    expect(list.textContent).toContain("Run these commands without asking you");
    expect(list.textContent).toContain("Run a command as soon as the skill loads");
    expect(sentence.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Y1 round 2 (the review's first minor): with two asking texts the title
  // and the lede say the review's own answer, not the first file's.
  it("a skill with two asking texts says the review's answer in its title and lede", async () => {
    const atLoad = { unreadable: null, inline: [{ line: 6, command: "git status" }], commands: null, writes: null, hooks: null, strongest: "inline" as const };
    const tools = { unreadable: null, inline: [], commands: { line: 3, tools: ["Bash"], any: true }, writes: null, hooks: null, strongest: "commands" as const };
    const two: ScriptsReview = {
      ...FIRST,
      skill: "two-texts",
      files: [
        { ...FIRST.files[0], asks: atLoad },
        { ...FIRST.files[0], path: "inner/SKILL.md", asks: tools },
      ],
      asks: "commands",
    };
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="two-texts" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => two },
    });
    expect(await screen.findByText("asks to run commands", { exact: false })).toBeTruthy();
    expect(screen.getByText(/but its text lets agents run commands on this Mac without asking you\./)).toBeTruthy();
    expect(screen.queryByText("runs a command when it loads", { exact: false })).toBeNull();
    // Round 3: under the one heading, what each text asks — a list per text,
    // led by its file's path — so the list says what the title says.
    expect(screen.getAllByRole("heading", { name: "What it asks to be allowed to do" })).toHaveLength(1);
    const lists = [...document.querySelectorAll<HTMLElement>("[data-ply-asks-of]")];
    expect(lists.map((l) => l.dataset.plyAsksOf)).toEqual(["SKILL.md", "inner/SKILL.md"]);
    expect(lists.map((l) => l.querySelector(".ux-asks-path")?.textContent)).toEqual(["SKILL.md", "inner/SKILL.md"]);
    expect([...lists[0].querySelectorAll("[data-ply-ask]")].map((i) => i.getAttribute("data-ply-ask"))).toEqual(["inline"]);
    expect(lists[0].textContent).toContain("git status");
    expect([...lists[1].querySelectorAll("[data-ply-ask]")].map((i) => i.getAttribute("data-ply-ask"))).toEqual(["commands"]);
    expect(lists[1].textContent).toContain("Run these commands without asking you");
    expect(lists[1].textContent).toContain("Any command (Bash)");
  });

  // Round 3: with one asking text the list stands alone, with no path line.
  it("a skill with one asking text shows its list with no path above it", async () => {
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="release-notes" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => FIRST },
    });
    await screen.findByRole("heading", { name: "What it asks to be allowed to do" });
    expect(document.querySelectorAll("[data-ply-asks-of]")).toHaveLength(1);
    expect(document.querySelector(".ux-asks-path")).toBeNull();
  });

  it("keeps the script's words when a script is what is new, and still lists what the text asks", async () => {
    const both: ScriptsReview = {
      ...FIRST,
      files: [
        { path: "scripts/export.sh", kind: "script", executable: true, size: 1229, change: "new", text: "#!/bin/sh\n", tooLarge: false, copies: [] },
        FIRST.files[0],
      ],
    };
    renderUi(<ScriptApprovalFlow plugin="ply-team" skill="release-notes" onDone={() => {}} onCancel={() => {}} />, {
      fixtures: { skills_hub_scripts_review: () => both },
    });
    expect(await screen.findByText("brings a script", { exact: false })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What it asks to be allowed to do" })).toBeTruthy();
    expect(screen.getByText(/^Text-only skills never ask\./)).toBeTruthy();
  });

  it("is the Publish sheet for a project skill, in everyone's words", async () => {
    const publish: ScriptsReview = {
      ...FIRST,
      skill: "ship-checklist",
      author: null,
      files: [{ ...FIRST.files[0], asks: { unreadable: null, inline: [], commands: { line: 3, tools: ["Bash"], any: true }, writes: null, hooks: null, strongest: "commands" } }],
    };
    renderUi(
      <ScriptApprovalFlow
        plugin=""
        skill="ship-checklist"
        install={{ workspaceId: "ws", verb: "publish", branch: "staging", onConfirm: async () => {} }}
        onDone={() => {}}
        onCancel={() => {}}
      />,
      { fixtures: { project_skill_publish_review: () => publish } },
    );
    expect(
      await screen.findByText(
        "Publishing puts it on staging at once, with no card to review it. Everyone who works on this repository gets it, and its text lets their agents run commands without asking them.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Run these commands without asking")).toBeTruthy();
    expect(screen.getByText("Any command (Bash)")).toBeTruthy();
    expect(screen.getByText("Your OK is for this publish only: a later one whose SKILL.md changed asks again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "OK, publish" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

// Round 2 (G3; consents.html scene 1.4): the held skill's page shows the
// version the person's sessions use, and says which one it is.
describe("the page of a held skill", () => {
  const held = (over: Partial<ScriptsReview>): ScriptsReview => ({ ...REVIEW, files: [], ...over });

  it("shows the version approved here, with the line that says so", async () => {
    renderUi(<HeldVersion plugin="ply-team" skill="deploy-check" />, {
      fixtures: { skills_hub_scripts_review: () => held({ keptText: "---\ndescription: d\n---\n\ncheck one\n" }) },
    });
    expect(await screen.findByText("What you see below is the version you approved, the one your sessions use.")).toBeTruthy();
    expect(screen.getByLabelText("deploy-check, the version your sessions use").textContent).toContain("check one");
  });

  it("says the version from before for a text that never asked, and nothing when no session gets the skill", async () => {
    const before = renderUi(<HeldVersion plugin="ply-team" skill="notes" />, {
      fixtures: { skills_hub_scripts_review: () => held({ approvedAt: null, firstTime: false, keptText: "plain words\n" }) },
    });
    expect(await screen.findByText("What you see below is the version from before, the one your sessions use.")).toBeTruthy();
    before.unmount();
    const { tauri, container } = renderUi(<HeldVersion plugin="ply-team" skill="new" />, {
      fixtures: { skills_hub_scripts_review: () => held({ approvedAt: null, firstTime: true }) },
    });
    await vi.waitFor(() => expect(tauri.callsOf("skills_hub_scripts_review").length).toBeGreaterThan(0));
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText(/What you see below/)).toBeNull();
  });
});
