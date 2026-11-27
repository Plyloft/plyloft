// Skills hub H7 (Challenger): what makes All skills read folders after
// launch. A background pull of the team library runs every 10 minutes and
// mostly brings nothing; only one whose commit moved reads everything again.
// An OK given to a team skill's scripts reads the libraries alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryPullView } from "../ipc";

const bus = vi.hoisted(() => ({
  library: [] as (() => void)[],
  decision: [] as (() => void)[],
  definition: [] as ((r: unknown) => void)[],
  refresh: vi.fn(async (_ids?: string[], _libraries?: boolean) => {}),
}));

vi.mock("../ipc", async (original) => ({
  ...(await original<typeof import("../ipc")>()),
  onSkillsHubIndex: async () => () => {},
  onFileChange: async () => () => {},
  onWorkspaceDefinitionRefreshed: async (fn: (r: unknown) => void) => {
    bus.definition.push(fn);
    return () => {};
  },
  onSkillsHubLibrary: async (fn: () => void) => {
    bus.library.push(fn);
    return () => {};
  },
  onSkillsHubDecision: async (fn: () => void) => {
    bus.decision.push(fn);
    return () => {};
  },
  skillsHubIndexRefresh: bus.refresh,
}));

import { DEBOUNCE_MS, libraryKey, noteFileSaved, startAllSkillsSubscriptions, stopAllSkillsSubscriptions, useAllSkills } from "./allSkillsStore";
import { useSkillsHub } from "./skillsHubStore";

function record(over: Partial<LibraryPullView> = {}): LibraryPullView {
  return {
    library: "team",
    repo: "acme/skills",
    teamName: null,
    hasClone: true,
    lastPullAt: 1,
    lastPullCommit: "c1",
    lastAttemptAt: 1,
    lastError: null,
    heldBack: null,
    switchedOff: false,
    accessLost: null,
    keptLastCopy: false,
    leftAt: null,
    cloneKept: null,
    login: null,
    ...over,
  };
}

describe("All skills: what reads again after launch", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    bus.library = [];
    bus.decision = [];
    bus.definition = [];
    bus.refresh.mockClear();
    stopAllSkillsSubscriptions();
    useSkillsHub.setState({ team: null });
    useAllSkills.setState({ loaded: true });
    startAllSkillsSubscriptions();
    await vi.advanceTimersByTimeAsync(0);
  });
  afterEach(() => {
    stopAllSkillsSubscriptions();
    vi.useRealTimers();
  });

  const pull = (team: LibraryPullView) => {
    for (const fn of bus.library) fn();
    useSkillsHub.setState({ team });
    for (const fn of bus.decision) fn();
  };

  it("reads nothing for the record as first read, nor for a pull that brought nothing", async () => {
    useSkillsHub.setState({ team: record() });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    pull(record({ lastPullAt: 2, lastAttemptAt: 2 }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).not.toHaveBeenCalled();
  });

  it("reads everything when a pull moved the commit, once", async () => {
    useSkillsHub.setState({ team: record() });
    pull(record({ lastPullCommit: "c2" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).toHaveBeenCalledTimes(1);
    expect(bus.refresh).toHaveBeenCalledWith(undefined, false);
  });

  it("reads the libraries alone for an OK given to a team skill", async () => {
    useSkillsHub.setState({ team: record() });
    await vi.advanceTimersByTimeAsync(10_000);
    for (const fn of bus.decision) fn();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).toHaveBeenCalledWith([], true);
  });

  it("reads a workspace for a definition refresh only when its sync moved a skill", async () => {
    const report = (library: unknown, firstRead = false) => ({ workspaceId: "w1", library, firstRead });
    for (const fn of bus.definition) fn(report(null));
    for (const fn of bus.definition) fn(report({ updates: [{ kind: "knowledge" }], published: [] }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).not.toHaveBeenCalled();
    for (const fn of bus.definition) fn(report({ updates: [{ kind: "skill" }], published: [] }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).toHaveBeenCalledWith(["w1"], false);
  });

  it("hears of Plyloft's own save of a skill file (the watcher drops it)", async () => {
    noteFileSaved("w2", "/code/web/src/main.ts");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).not.toHaveBeenCalled();
    noteFileSaved("w2", "/code/web/.claude/skills/rules/SKILL.md");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(bus.refresh).toHaveBeenCalledWith(["w2"], false);
  });

  it("names a library's record by what moves the rows", () => {
    expect(libraryKey(record())).toBe(libraryKey(record({ lastPullAt: 9, lastAttemptAt: 9, lastError: "offline" })));
    expect(libraryKey(record())).not.toBe(libraryKey(record({ switchedOff: true })));
    expect(libraryKey(null)).toBe("none");
  });
});
