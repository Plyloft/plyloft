// 1.173.0 (E5): the direction editor (mockup next-improvement.html scene 2)
// — its four answers and their hints, each approach's own line, who proposes
// with two AIs and with one (and the Codex note), Save and Save and prepare
// proposals, the "Not to propose again" list with Remove, a read-only Mac,
// an unshared setup, a direction waiting for a choice, a save that waits in
// a pull request, the draft it starts from and where focus goes.
import { describe, expect, it } from "vitest";
import { act, renderUi, screen, waitFor, within } from "./render";
import { NiDirectionSheetHost } from "../components/NiDirectionSheet";
import { SettingConflictHost } from "../components/SettingConflictHost";
import type { DoctorReport, NiDirection, NiDirectionView, NiRoundView } from "../ipc";
import { emptyNiDirection } from "../ipc";
import { openDirectionEditor, useNextImprovement, niKey } from "../store/nextImprovementStore";
import { useDoctor } from "../store/doctorStore";
import { useToasts } from "../store/toastStore";
import { useSettingConflict } from "../store/settingConflictStore";
import { useWorkMode } from "../store/workModeStore";
import { setPlatformForTests } from "../lib/platform";
import { useAreas } from "../store/areaStore";
import type { AreasView } from "../ipc";

const WS = "ws-ni";

function direction(patch: Partial<NiDirectionView> = {}): NiDirectionView {
  return {
    area: "site",
    areaName: "Site",
    path: ".atelier/next-improvement/site.json",
    shared: true,
    readOnly: false,
    readOnlyReason: null,
    notice: null,
    keptHere: null,
    exists: false,
    direction: emptyNiDirection(),
    draft: {
      direction: { ...emptyNiDirection(), avoid: "Pop-ups" },
      from: ["readme"],
      lookAt: null,
      audience: { text: "PPC agencies", source: "readme" },
    },
    lookAtHint: { url: "https://www.lyrappc.com", source: "railway" },
    pending: null,
    problem: null,
    problemTechnical: null,
    ...patch,
  };
}

function saved(d: Partial<NiDirection> = {}): NiDirection {
  return {
    ...emptyNiDirection(),
    audience: "PPC agencies",
    better: "They start a trial without help.",
    avoid: "Pop-ups",
    lookAt: "https://www.lyrappc.com",
    approaches: ["simplify", "fix"],
    ...d,
  };
}

function report(claude: boolean, codex: boolean): DoctorReport {
  return {
    tools: [
      { id: "claude", found: claude } as never,
      { id: "codex", found: codex, versionOk: true, auth: { signedIn: true } } as never,
    ],
  } as unknown as DoctorReport;
}

function roundView(): NiRoundView {
  return { workspaceId: WS, area: "site", round: null, byline: null, elapsedMs: null };
}

async function open(fixtures: Record<string, unknown>, thenStart = false, area: string | null = "site") {
  const r = renderUi(
    <>
      <NiDirectionSheetHost />
      <SettingConflictHost />
    </>,
    { fixtures },
  );
  act(() => openDirectionEditor(WS, area, thenStart));
  const sheet = await screen.findByRole("dialog", { name: "Direction for Site" });
  await within(sheet).findByRole("textbox", { name: "For whom" });
  return { ...r, sheet };
}

const field = (sheet: HTMLElement, name: string) => within(sheet).getByRole("textbox", { name }) as HTMLTextAreaElement;

describe("the direction editor (scene 2)", () => {
  it("is named for the area it opened for from the first frame, as its title says (1.173.0 re-walk)", async () => {
    const site = { id: "site", name: "Site", path: "site", root: false, first: false, targetBranch: null, branch: "main", versionFiles: null, tagPrefix: "site-", label: "site", lookAt: null };
    act(() =>
      useAreas.setState((st) => ({ views: { ...st.views, [WS]: { areas: [site] } as unknown as AreasView } })),
    );
    let answer: (v: NiDirectionView) => void = () => {};
    renderUi(<NiDirectionSheetHost />, {
      fixtures: { ni_direction_get: () => new Promise<NiDirectionView>((resolve) => (answer = resolve)) },
    });
    act(() => openDirectionEditor(WS, "site", false));
    // Still reading: already "Direction for Site", never "this project".
    const sheet = await screen.findByRole("dialog", { name: "Direction for Site" });
    expect(sheet.querySelector("h2")?.textContent).toBe("Direction for Site");
    await act(async () => answer(direction()));
    expect(screen.getByRole("dialog", { name: "Direction for Site" })).toBe(sheet);
    act(() => useAreas.setState((st) => ({ views: { ...st.views, [WS]: undefined } })));
  });

  it("starts from the draft, never drafting what better means: its hint, the address and its source, focus on For whom", async () => {
    const { sheet, user } = await open({ ni_direction_get: direction() });
    expect(within(sheet).getByText(/Plyloft read your README to help with the direction\./)).toBeTruthy();
    // C9 (P14): For whom starts empty, focused, the README's words offered.
    const whom = field(sheet, "For whom");
    expect(whom.value).toBe("");
    expect(whom.placeholder).toBe("Who uses Site, in a few words");
    await waitFor(() => expect(document.activeElement).toBe(whom));
    const offered = sheet.querySelector<HTMLElement>("[data-ni-audience-suggestion]")!;
    expect(offered.textContent).toBe("Your README starts: “PPC agencies” Use it");
    await user.click(within(offered).getByRole("button", { name: "Use it" }));
    expect(whom.value).toBe("PPC agencies");
    // Round 1: focus goes to the field it filled.
    expect(document.activeElement).toBe(whom);
    expect(sheet.querySelector("[data-ni-audience-suggestion]")).toBeNull();
    expect(field(sheet, "What “better” means here").value).toBe("");
    expect(sheet.querySelector("[data-ni-better-hint]")?.textContent).toMatch(/Plyloft doesn't guess this one/);
    expect(field(sheet, "What you don’t want").value).toBe("Pop-ups");
    expect(field(sheet, "Where to look at it").value).toBe("https://www.lyrappc.com");
    expect(sheet.querySelector("[data-ni-where-hint]")?.textContent).toBe(
      "Found in Railway. Empty: it reads only the code and the web, and says so.",
    );
    // Nothing to save until "better" says something.
    expect((within(sheet).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(sheet).getByRole("button", { name: "Save and prepare proposals" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a hint from package.json says so; an address typed over it says what empty means", async () => {
    const r = await open({
      ni_direction_get: direction({ lookAtHint: { url: "https://lyra.dev", source: "packageJson" } }),
    });
    expect(r.sheet.querySelector("[data-ni-where-hint]")?.textContent).toMatch(/^From package\.json\./);
    const where = field(r.sheet, "Where to look at it");
    await r.user.clear(where);
    await r.user.type(where, "https://other.example");
    expect(r.sheet.querySelector("[data-ni-where-hint]")?.textContent).toBe(
      "Empty: it reads only the code and the web, and says so.",
    );
  });

  it("each approach has its one line; none ticked says it polishes", async () => {
    const r = await open({ ni_direction_get: direction() });
    const line = (a: string) => r.sheet.querySelector(`[data-ni-approach="${a}"]`)!.textContent;
    expect(line("polish")).toBe("PolishFinish what's there: words, spacing, states, small frictions.");
    expect(line("simplify")).toMatch(/Each idea must remove more than it adds\./);
    expect(line("grow")).toMatch(/Something new, one at a time, tied to “better” above\./);
    expect(line("fix")).toMatch(/What's broken or untrue: errors, slow pages, accessibility\./);
    expect(r.sheet.querySelector("[data-ni-no-approach]")?.textContent).toBe("None ticked: it polishes.");
    await r.user.click(within(r.sheet).getByRole("checkbox", { name: /Simplify/ }));
    expect(r.sheet.querySelector("[data-ni-no-approach]")).toBeNull();
  });

  it("with two AIs: the segment Claude · Codex / Codex · Claude, and the note when Codex proposes", async () => {
    useDoctor.setState({ report: report(true, true) } as never);
    const r = await open({ ni_direction_get: direction() });
    const group = within(r.sheet).getByRole("group", { name: "Proposes · second opinion" });
    const claude = within(group).getByRole("button", { name: "Claude · Codex" });
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(r.sheet.querySelector("[data-ni-proposer-note]")).toBeNull();
    await r.user.click(within(group).getByRole("button", { name: "Codex · Claude" }));
    expect(r.sheet.querySelector("[data-ni-proposer-note]")?.textContent).toBe(
      "Codex reads the code only; Claude also reads the pages at Where to look at it.",
    );
  });

  it("with one AI: it proposes and gives the second opinion separately, and says why", async () => {
    useDoctor.setState({ report: report(true, false) } as never);
    const r = await open({ ni_direction_get: direction() });
    expect(within(r.sheet).queryByRole("group", { name: "Proposes · second opinion" })).toBeNull();
    expect(r.sheet.querySelector("[data-ni-one-ai]")?.textContent).toBe("Claude · then Claude again, in a separate session");
    expect(within(r.sheet).getByText(/Codex isn't installed on this (Mac|PC)\./)).toBeTruthy();
  });

  it("with Codex alone, it says Codex reads the code only", async () => {
    useDoctor.setState({ report: report(false, true) } as never);
    const r = await open({ ni_direction_get: direction() });
    expect(r.sheet.querySelector("[data-ni-one-ai]")?.textContent).toBe("Codex · then Codex again, in a separate session");
    expect(r.sheet.querySelector("[data-ni-proposer-note]")?.textContent).toBe(
      "Codex reads the code only, not the pages at Where to look at it.",
    );
  });

  it("Save writes the four answers, the approaches and who proposes, and closes", async () => {
    useDoctor.setState({ report: report(true, true) } as never);
    const r = await open({
      ni_direction_get: direction(),
      ni_direction_save: ({ direction: d }: { direction: NiDirection }) => direction({ exists: true, draft: null, direction: d }),
    });
    await r.user.type(field(r.sheet, "What “better” means here"), "They start a trial without help.");
    expect(r.sheet.querySelector("[data-ni-better-hint]")).toBeNull();
    await r.user.click(within(r.sheet.querySelector<HTMLElement>("[data-ni-audience-suggestion]")!).getByRole("button", { name: "Use it" }));
    await r.user.click(within(r.sheet).getByRole("checkbox", { name: /Fix/ }));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Codex · Claude" }));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [call] = r.tauri.callsOf("ni_direction_save");
    const args = call.args as { workspaceId: string; area: string; direction: NiDirection };
    expect(args.workspaceId).toBe(WS);
    expect(args.area).toBe("site");
    expect(args.direction).toMatchObject({
      audience: "PPC agencies",
      better: "They start a trial without help.",
      avoid: "Pop-ups",
      lookAt: "https://www.lyrappc.com",
      approaches: ["fix"],
      proposer: "codex",
    });
    expect(r.tauri.callsOf("ni_round_start")).toHaveLength(0);
    expect(useNextImprovement.getState().directions[niKey(WS, "site")]?.exists).toBe(true);
  });

  it("Save and prepare proposals saves, then starts a round", async () => {
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved() }),
      ni_direction_save: direction({ exists: true, draft: null, direction: saved() }),
      ni_round_start: roundView(),
    });
    // A saved direction is what it says: no drafted lede.
    expect(within(r.sheet).queryByText(/read your README/)).toBeNull();
    expect(field(r.sheet, "What “better” means here").value).toBe("They start a trial without help.");
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save and prepare proposals" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(r.tauri.callsOf("ni_direction_save")).toHaveLength(1);
    expect(r.tauri.callsOf("ni_round_start")[0].args).toEqual({ workspaceId: WS, area: "site" });
    expect(useNextImprovement.getState().rounds[niKey(WS, "site")]).toBeTruthy();
  });

  it("a start that fails after the save keeps the sheet up and says the direction is saved", async () => {
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved() }),
      ni_direction_save: direction({ exists: true, draft: null, direction: saved() }),
      ni_round_start: () => Promise.reject("Next improvement is already preparing ideas for this area."),
    });
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save and prepare proposals" }));
    expect((await within(r.sheet).findByRole("alert")).textContent).toMatch(/^The direction is saved\. /);
  });

  it("a save waiting in a pull request says so plainly", async () => {
    const pending = {
      state: "pullRequest" as const,
      message: "Waiting in a pull request until it merges.",
      technical: null,
      pullRequest: null,
      conflicts: [],
    };
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved() }),
      ni_direction_save: direction({ exists: true, draft: null, direction: saved(), pending }),
    });
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const toast = [...useToasts.getState().toasts, ...useToasts.getState().queue].find((t) => t.title === "Direction saved");
    expect(toast?.body).toBe("Waiting in a pull request until it merges.");
  });

  it("Not to propose again (N) opens the list; Remove takes a row off with its index, title and time", async () => {
    const rejected = [
      { title: "Exit-intent pop-up", reason: "no pop-ups", at: 10, by: "matteo" },
      { title: "A blog", reason: "not now", at: 20 },
    ];
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved({ rejected }) }),
      ni_unreject: direction({ exists: true, draft: null, direction: saved({ rejected: [rejected[0]] }) }),
    });
    const link = within(r.sheet).getByRole("button", { name: "Not to propose again (2)" });
    expect(link.getAttribute("aria-expanded")).toBe("false");
    expect(r.sheet.querySelector("[data-ni-rejected]")).toBeNull();
    await r.user.click(link);
    const list = r.sheet.querySelector<HTMLElement>("[data-ni-rejected]")!;
    await waitFor(() => expect(document.activeElement).toBe(within(list).getByRole("heading", { name: "Not to propose again" })));
    expect(within(list).getByText("no pop-ups · matteo")).toBeTruthy();
    await r.user.type(field(r.sheet, "What you don’t want"), " and banners");
    await r.user.click(within(list).getByRole("button", { name: "Remove “A blog”" }));
    expect(r.tauri.callsOf("ni_unreject")[0].args).toEqual({ workspaceId: WS, area: "site", index: 1, title: "A blog", at: 20 });
    expect(await within(r.sheet).findByRole("button", { name: "Not to propose again (1)" })).toBeTruthy();
    expect(within(r.sheet).queryByText("A blog")).toBeNull();
    // What was typed stays.
    expect(field(r.sheet, "What you don’t want").value).toBe("Pop-ups and banners");
  });

  it("no ideas set aside: no link", async () => {
    const r = await open({ ni_direction_get: direction() });
    expect(within(r.sheet).queryByRole("button", { name: /Not to propose again/ })).toBeNull();
  });

  it("a read-only Mac sees the values and why, with no Save and no Remove", async () => {
    const rejected = [{ title: "A blog", reason: "not now", at: 20 }];
    const r = await open({
      ni_direction_get: direction({
        exists: true,
        draft: null,
        direction: saved({ rejected }),
        readOnly: true,
        readOnlyReason: "This Mac can't publish to this repository.",
      }),
    });
    expect(within(r.sheet).getByText(/can't publish to this repository\./)).toBeTruthy();
    expect(field(r.sheet, "For whom").readOnly).toBe(true);
    expect(field(r.sheet, "What “better” means here").value).toBe("They start a trial without help.");
    expect(within(r.sheet).getByText("https://www.lyrappc.com")).toBeTruthy();
    expect((within(r.sheet).getByRole("checkbox", { name: /Fix/ }) as HTMLInputElement).disabled).toBe(true);
    expect(within(r.sheet).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(r.sheet).queryByRole("button", { name: "Save and prepare proposals" })).toBeNull();
    expect(within(r.sheet).getByRole("button", { name: "Close" })).toBeTruthy();
    await r.user.click(within(r.sheet).getByRole("button", { name: "Not to propose again (1)" }));
    expect(within(r.sheet).queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  // E6: an unshared project keeps the direction on this computer.
  const KEPT = "Kept on this Mac until you share this project's setup.";

  it("an unshared project is editable, says it is kept on this Mac, and offers the banner's Share", async () => {
    let reads = 0;
    const r = await open({
      ni_direction_get: () => (++reads > 1 ? direction() : direction({ shared: false })),
      ni_direction_save: ({ direction: d }: { direction: NiDirection }) => direction({ shared: false, exists: true, draft: null, direction: d }),
      workspace_adoption_status: { githubRepo: "me/lyra", hasDefinition: false, boardRepo: null, action: { kind: "ask" } },
      workspace_adoption_share: { alreadyShared: false, board: "local", localCards: 0, boardHeld: null },
      workspace_list: { workspaces: [], activeId: null },
    });
    r.tauri.allowUnhandled();
    expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toMatch(new RegExp(`^${KEPT}`));
    expect(r.sheet.querySelector("[data-ni-cant-save]")).toBeNull();
    expect(field(r.sheet, "For whom").readOnly).toBe(false);
    expect(within(r.sheet).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(r.sheet).queryByText(/needs the shared setup|Share this project's setup first/)).toBeNull();
    // C9 (NIW-1): said beside Save; Share it… opens what sharing does.
    expect(r.sheet.querySelector("[data-ni-kept-here]")!.closest(".ux-sheet-note")).not.toBeNull();
    expect(within(r.sheet).queryByRole("button", { name: "Share the setup" })).toBeNull();
    const shareIt = await within(r.sheet).findByRole("button", { name: "Share it…" });
    await r.user.click(shareIt);
    const share = await within(r.sheet).findByRole("button", { name: "Share the setup" });
    // Round 1: the region it opens is named by aria-controls, and its press
    // takes focus.
    const region = document.getElementById(shareIt.getAttribute("aria-controls")!);
    expect(region?.contains(share)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(share));
    // It says what sharing does, as the banner does.
    expect(r.sheet.querySelector("[data-ni-share-body]")?.textContent).toMatch(/commits \.atelier\/workspace\.json to me\/lyra/);
    await r.user.click(share);
    expect(r.tauri.callsOf("workspace_adoption_share")[0].args).toEqual({ workspaceId: WS });
    // Shared: the direction is read again and is the repository's.
    await waitFor(() => expect(r.sheet.querySelector("[data-ni-kept-here]")).toBeNull());
    expect(useToasts.getState().recent.some((t) => t.title === "Couldn't share this workspace")).toBe(false);
  });

  it("an unshared project saves on this computer", async () => {
    const r = await open({
      ni_direction_get: direction({ shared: false }),
      ni_direction_save: ({ direction: d }: { direction: NiDirection }) => direction({ shared: false, exists: true, draft: null, direction: d }),
      workspace_adoption_status: { githubRepo: null, hasDefinition: false, boardRepo: null, action: { kind: "none" } },
    });
    await r.user.type(field(r.sheet, "What “better” means here"), "They start a trial without help.");
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save" }));
    const [call] = r.tauri.callsOf("ni_direction_save");
    expect((call.args as { direction: NiDirection }).direction.better).toBe("They start a trial without help.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("solo mode: kept on this Mac, editable, and no trip to Settings › Setup", async () => {
    useWorkMode.setState({ mode: "solo" });
    const r = await open({
      ni_direction_get: direction({ shared: false }),
      workspace_adoption_status: { githubRepo: "me/lyra", hasDefinition: false, boardRepo: null, action: { kind: "none" } },
    });
    expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toBe("Kept on this Mac only.");
    expect(within(r.sheet).queryByRole("button", { name: "Share it…" })).toBeNull();
    expect(within(r.sheet).queryByRole("button", { name: "Open Settings › Setup" })).toBeNull();
    expect(within(r.sheet).queryByText(/Work with a team/)).toBeNull();
    expect(within(r.sheet).getByRole("button", { name: "Save and prepare proposals" })).toBeTruthy();
  });

  it("a Mac that said Not on this Mac is offered Share with no dead end", async () => {
    const r = await open({
      ni_direction_get: direction({ shared: false }),
      workspace_adoption_status: { githubRepo: "me/lyra", hasDefinition: false, boardRepo: null, action: { kind: "none" } },
    });
    await within(r.sheet).findByRole("button", { name: "Share it…" });
    expect(within(r.sheet).queryByText(/needs the shared setup/)).toBeNull();
    expect(within(r.sheet).getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("an unshared project without GitHub still saves here, with no Share", async () => {
    const r = await open({
      ni_direction_get: direction({ shared: false }),
      workspace_adoption_status: { githubRepo: null, hasDefinition: false, boardRepo: null, action: { kind: "none" } },
    });
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toBe("Kept on this Mac only.");
    expect(within(r.sheet).queryByRole("button", { name: "Share it…" })).toBeNull();
    expect(within(r.sheet).getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("on Windows it says this PC", async () => {
    setPlatformForTests("windows");
    try {
      const r = await open({
        ni_direction_get: direction({ shared: false }),
        workspace_adoption_status: { githubRepo: null, hasDefinition: false, boardRepo: null, action: { kind: "none" } },
      });
      expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toBe("Kept on this PC only.");
    } finally {
      setPlatformForTests(null);
    }
  });

  it("a shared setup found on another branch: only the short line", async () => {
    const r = await open({
      ni_direction_get: direction({ shared: false }),
      workspace_adoption_status: {
        githubRepo: "me/lyra",
        hasDefinition: false,
        boardRepo: null,
        action: { kind: "setupElsewhere", here: null, branch: "dev", name: "Lyra" },
      },
    });
    await waitFor(() => expect(r.tauri.callsOf("workspace_adoption_status").length).toBeGreaterThan(0));
    expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toBe("Kept on this Mac only.");
    expect(within(r.sheet).queryByRole("button", { name: "Share it…" })).toBeNull();
  });

  it("on Windows, a shareable project says this PC in the long line", async () => {
    setPlatformForTests("windows");
    try {
      const r = await open({
        ni_direction_get: direction({ shared: false }),
        workspace_adoption_status: { githubRepo: "me/lyra", hasDefinition: false, boardRepo: null, action: { kind: "ask" } },
      });
      await within(r.sheet).findByRole("button", { name: "Share it…" });
      expect(r.sheet.querySelector("[data-ni-kept-here]")?.textContent).toMatch(
        /^Kept on this PC until you share this project's setup\./,
      );
    } finally {
      setPlatformForTests(null);
    }
  });

  it("a read-only Mac showing the direction it kept says why", async () => {
    const words = "Kept on this Mac until this computer can save to the repository.";
    const r = await open({
      ni_direction_get: direction({
        exists: true,
        draft: null,
        direction: saved(),
        readOnly: true,
        readOnlyReason: "This Mac can't publish to this repository.",
        keptHere: words,
      }),
    });
    expect(r.sheet.querySelector("[data-ni-kept-local]")?.textContent).toBe(words);
    expect(r.sheet.querySelector("[data-ni-kept-here]")).toBeNull();
    expect(field(r.sheet, "What “better” means here").value).toBe("They start a trial without help.");
  });

  it("the repository's direction kept over this computer's is said once", async () => {
    const notice = "The repository already had a direction, so Plyloft uses it. The one kept on this Mac wasn't moved.";
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved(), notice }),
      ni_direction_notice_seen: null,
    });
    expect(r.sheet.querySelector("[data-ni-notice]")?.textContent).toBe(notice);
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_notice_seen")[0]?.args).toEqual({ workspaceId: WS, area: "site" }));
  });

  it("a direction waiting for a choice says so; Choose… opens the question", async () => {
    const conflict = { field: "ni-site-better" } as never;
    const r = await open({
      ni_direction_get: direction({
        exists: true,
        draft: null,
        direction: saved(),
        pending: { state: "conflict", message: "x", technical: null, pullRequest: null, conflicts: [conflict] },
      }),
    });
    const line = r.sheet.querySelector<HTMLElement>("[data-ni-waiting]")!;
    expect(line.textContent).toMatch(/^Waiting for your choice/);
    const calls: [string, string | null | undefined][] = [];
    useSettingConflict.setState({ show: async (w: string, f?: string | null) => (calls.push([w, f]), true) } as never);
    await r.user.click(within(line).getByRole("button", { name: "Choose…" }));
    expect(calls).toEqual([[WS, "ni-site-better"]]);
  });

  it("a start refused for a missing direction offers only Save and prepare proposals; Esc closes", async () => {
    const r = await open({ ni_direction_get: direction() }, true);
    expect(within(r.sheet).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(r.sheet).getByRole("button", { name: "Save and prepare proposals" })).toBeTruthy();
    await r.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useNextImprovement.getState().directionAsk).toBeNull();
  });
});

describe("C9: suggestions, and where it saves before the press", () => {
  it("an address only the README gives is offered, never filled in (NIW-2)", async () => {
    const r = await open({ ni_direction_get: direction({ lookAtHint: { url: "https://plyloft.com", source: "readme" } }) });
    const where = field(r.sheet, "Where to look at it");
    expect(where.value).toBe("");
    // Round 1: the address is on its own line, not in the placeholder.
    expect((where as unknown as HTMLInputElement).placeholder).toBe("https://…");
    const offered = r.sheet.querySelector<HTMLElement>("[data-ni-suggestion]")!;
    expect(offered.textContent).toMatch(/^Your README links: https:\/\/plyloft\.com/);
    await r.user.click(within(offered).getByRole("button", { name: "Use it" }));
    expect(where.value).toBe("https://plyloft.com");
    expect(document.activeElement).toBe(where);
  });

  it("a shared setup names the cards' branch beside Save; a pull request says so (NIW-1)", async () => {
    const r = await open({ ni_direction_get: direction({ savesTo: "launch" }) });
    const note = r.sheet.querySelector<HTMLElement>("[data-ni-saves-to]")!;
    expect(note.closest(".ux-sheet-note")).not.toBeNull();
    expect(note.textContent).toBe(
      "Saved in this project's shared setup: a small commit to launch on GitHub, so your other computers and your team see it.",
    );
    r.unmount();
    const pr = await open({
      ni_direction_get: direction({
        savesTo: "launch",
        pending: { state: "pullRequest", message: "Waiting in a pull request.", technical: null, pullRequest: null, conflicts: [] } as never,
      }),
    });
    expect(pr.sheet.querySelector("[data-ni-saves-to]")?.textContent).toMatch(/a small commit as a pull request to launch on GitHub/);
    pr.unmount();
    // Round 1 (owner): GitHub said the branch takes a pull request — said
    // before the first save, nothing waiting yet.
    const protectedBranch = await open({ ni_direction_get: direction({ savesTo: "launch", savesViaPullRequest: true }) });
    expect(protectedBranch.sheet.querySelector("[data-ni-saves-to]")?.textContent).toBe(
      "Saved in this project's shared setup: a small commit as a pull request to launch on GitHub, so your other computers and your team see it.",
    );
  });

  it("a read-only Mac names no branch", async () => {
    const r = await open({ ni_direction_get: direction({ savesTo: null, readOnly: true, readOnlyReason: "This Mac can't publish to this repository." }) });
    expect(r.sheet.querySelector("[data-ni-saves-to]")).toBeNull();
  });
});

describe("the direction editor, Reviewer round 1", () => {
  it("Save sends the repository's direction as it is now with only what was changed here", async () => {
    let reads = 0;
    const r = await open({
      ni_direction_get: () =>
        ++reads === 1
          ? direction({ exists: true, draft: null, direction: saved() })
          : direction({ exists: true, draft: null, direction: saved({ audience: "In-house marketers", approaches: ["grow"] }) }),
      ni_direction_save: ({ direction: d }: { direction: NiDirection }) => direction({ exists: true, draft: null, direction: d }),
    });
    await r.user.type(field(r.sheet, "What you don’t want"), " and banners");
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.tauri.callsOf("ni_direction_save")).toHaveLength(1));
    const sent = (r.tauri.callsOf("ni_direction_save")[0].args as { direction: NiDirection }).direction;
    expect(sent.avoid).toBe("Pop-ups and banners");
    // Untouched here, changed in the repository meanwhile: the fresh value.
    expect(sent.audience).toBe("In-house marketers");
    expect(sent.approaches).toEqual(["grow"]);
  });

  it("a change arriving while it is open refreshes the answers nobody touched", async () => {
    let reads = 0;
    const r = await open({
      ni_direction_get: () =>
        ++reads === 1
          ? direction({ exists: true, draft: null, direction: saved() })
          : direction({ exists: true, draft: null, direction: saved({ audience: "In-house marketers", avoid: "Countdowns" }) }),
    });
    await r.user.type(field(r.sheet, "What you don’t want"), " and banners");
    await act(async () => {
      r.tauri.emit("ni://direction", { workspaceId: WS, area: "site" });
    });
    await waitFor(() => expect(field(r.sheet, "For whom").value).toBe("In-house marketers"));
    expect(field(r.sheet, "What you don’t want").value).toBe("Pop-ups and banners");
  });

  it("an address E1 would refuse is said under the field and Save waits; E1's refusals are said as they are", async () => {
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved() }),
      ni_direction_save: () => Promise.reject("Where to look at it must be a web address (https://…), not “x”."),
    });
    const where = field(r.sheet, "Where to look at it");
    await r.user.clear(where);
    await r.user.type(where, "lyrappc.com");
    expect(r.sheet.querySelector("[data-ni-where-hint]")?.textContent).toBe("A web address starts with https:// (or http://).");
    expect((within(r.sheet).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(r.sheet).getByRole("button", { name: "Save and prepare proposals" }) as HTMLButtonElement).disabled).toBe(true);
    await r.user.clear(where);
    await r.user.type(where, "https://www.lyrappc.com");
    await r.user.click(within(r.sheet).getByRole("button", { name: "Save" }));
    expect((await within(r.sheet).findByRole("alert")).textContent).toMatch(/^Where to look at it must be a web address/);
  });

  it("while a choice waits, neither Save can be pressed", async () => {
    const conflict = { field: "ni-site-better" } as never;
    const r = await open({
      ni_direction_get: direction({
        exists: true,
        draft: null,
        direction: saved(),
        pending: { state: "conflict", message: "x", technical: null, pullRequest: null, conflicts: [conflict] },
      }),
    });
    expect((within(r.sheet).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(r.sheet).getByRole("button", { name: "Save and prepare proposals" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Remove on a list that moved reads it again", async () => {
    const rejected = [
      { title: "Exit-intent pop-up", reason: "no pop-ups", at: 10 },
      { title: "A blog", reason: "not now", at: 20 },
    ];
    let reads = 0;
    const r = await open({
      ni_direction_get: () =>
        ++reads === 1
          ? direction({ exists: true, draft: null, direction: saved({ rejected }) })
          : direction({ exists: true, draft: null, direction: saved({ rejected: [rejected[1]] }) }),
      ni_unreject: () => Promise.reject("That idea isn't on the list any more."),
    });
    await r.user.click(within(r.sheet).getByRole("button", { name: "Not to propose again (2)" }));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Remove “Exit-intent pop-up”" }));
    expect((await within(r.sheet).findByRole("alert")).textContent).toBe("That idea isn't on the list any more.");
    expect(await within(r.sheet).findByRole("button", { name: "Not to propose again (1)" })).toBeTruthy();
  });

  it("after Remove focus goes to the next row's Remove, the previous one, then the first field", async () => {
    const a = { title: "A", reason: "r", at: 1 };
    const b = { title: "B", reason: "r", at: 2 };
    const c = { title: "C", reason: "r", at: 3 };
    const answers = [[a, c], [a], []];
    let n = 0;
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved({ rejected: [a, b, c] }) }),
      ni_unreject: () => direction({ exists: true, draft: null, direction: saved({ rejected: answers[n++] }) }),
    });
    await r.user.click(within(r.sheet).getByRole("button", { name: "Not to propose again (3)" }));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Remove “B”" }));
    await waitFor(() => expect(document.activeElement).toBe(within(r.sheet).getByRole("button", { name: "Remove “C”" })));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Remove “C”" }));
    await waitFor(() => expect(document.activeElement).toBe(within(r.sheet).getByRole("button", { name: "Remove “A”" })));
    await r.user.click(within(r.sheet).getByRole("button", { name: "Remove “A”" }));
    await waitFor(() => expect(document.activeElement).toBe(field(r.sheet, "For whom")));
    expect(within(r.sheet).queryByRole("button", { name: /Not to propose again/ })).toBeNull();
  });

  it("with a saved direction the address found is offered, not filled in: Use it", async () => {
    const r = await open({
      ni_direction_get: direction({ exists: true, draft: null, direction: saved({ lookAt: "" }) }),
    });
    const where = field(r.sheet, "Where to look at it");
    expect(where.value).toBe("");
    // C9 round 1: the suggestion has its line; the placeholder is generic.
    expect(where.placeholder).toBe("https://…");
    const line = r.sheet.querySelector<HTMLElement>("[data-ni-suggestion]")!;
    expect(line.textContent).toMatch(/^Found in Railway: https:\/\/www\.lyrappc\.com/);
    await r.user.click(within(line).getByRole("button", { name: "Use it" }));
    expect(where.value).toBe("https://www.lyrappc.com");
    expect(r.sheet.querySelector("[data-ni-suggestion]")).toBeNull();
  });

  it("while a round runs for the area, only Save, with why", async () => {
    useNextImprovement.getState().setRound(niKey(WS, "site"), {
      ...roundView(),
      round: { status: "running" } as never,
    });
    const r = await open({ ni_direction_get: direction({ exists: true, draft: null, direction: saved() }) }, true);
    expect(within(r.sheet).getByText("Ideas are being prepared now; the next round follows this direction.")).toBeTruthy();
    expect(within(r.sheet).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(r.sheet).queryByRole("button", { name: "Save and prepare proposals" })).toBeNull();
  });

  it("a direction asking for Codex where only Claude is ready says Claude does it here", async () => {
    useDoctor.setState({
      report: {
        tools: [
          { id: "claude", found: true } as never,
          { id: "codex", found: true, versionOk: true, auth: { signedIn: false } } as never,
        ],
      } as unknown as DoctorReport,
    } as never);
    const r = await open({ ni_direction_get: direction({ exists: true, draft: null, direction: saved({ proposer: "codex" }) }) });
    expect(r.sheet.querySelector("[data-ni-stand-in]")?.textContent).toMatch(
      /^The direction asks Codex to propose; Claude does on this (Mac|PC) while Codex isn't signed in\.$/,
    );
  });

  it("with neither AI ready it says so instead of the choice", async () => {
    useDoctor.setState({ report: report(false, false) } as never);
    const r = await open({ ni_direction_get: direction() });
    expect(r.sheet.querySelector("[data-ni-none-ready]")?.textContent).toMatch(/^Neither Claude Code nor Codex is ready/);
    expect(within(r.sheet).queryByRole("group", { name: "Proposes · second opinion" })).toBeNull();
  });

  it("the three answers take at most 1000 characters", async () => {
    const r = await open({ ni_direction_get: direction() });
    for (const name of ["For whom", "What “better” means here", "What you don’t want"]) {
      expect(field(r.sheet, name).maxLength).toBe(1000);
    }
  });
});
