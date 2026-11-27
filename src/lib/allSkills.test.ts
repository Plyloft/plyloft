// Skills hub H7: All skills' joins — Used in, filters, the list, the muted
// count. Run with:
//
//     node --experimental-strip-types src/lib/allSkills.test.ts

import assert from "node:assert/strict";
import type { HubIndex, HubIndexRow, HubIndexWorkspace, SkillLinkState } from "../ipc.ts";
import {
  applyIndexEvent,
  attentionCount,
  DEFAULT_FILTERS,
  EMPTY_INDEX,
  filterRows,
  flattenIndex,
  GROUP_CAP,
  itemOffsets,
  keepWorkspaces,
  listItems,
  nameIndex,
  rowKeys,
  rowNotes,
  scopeCounts,
  statusWords,
  stepKey,
  updatesChip,
  usedIn,
  usedInEntryWords,
  usedInLine,
  copyFromOf,
  copySentence,
  linkedFrom,
  targetNote,
  sortTargets,
  visibleRange,
  workspaceHints,
  type HubRow,
} from "./allSkills.ts";

// A small `describe`/`it`/`expect` over node:assert, so the cases read as
// they would under vitest.
let failures = 0;
let passed = 0;
let group = "";
function describe(name: string, fn: () => void) {
  group = name;
  fn();
}
function it(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures += 1;
    console.error(`✗ ${group} › ${name}\n`, error);
  }
}
function expect(actual: unknown) {
  const own = {
    toBe: (want: unknown) => assert.equal(actual, want),
    toEqual: (want: unknown) => assert.deepEqual(actual, want),
    toHaveLength: (n: number) => assert.equal((actual as unknown[]).length, n),
    toMatch: (re: RegExp) => assert.match(String(actual), re),
    toContain: (item: unknown) =>
      assert.ok(
        typeof actual === "string" ? actual.includes(String(item)) : (actual as unknown[]).includes(item),
        `${JSON.stringify(actual)} contains ${JSON.stringify(item)}`,
      ),
    toMatchObject: (want: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(want)) assert.deepEqual((actual as Record<string, unknown>)[k], v, k);
    },
    toBeGreaterThan: (n: number) => assert.ok((actual as number) > n, `${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => assert.ok((actual as number) >= n, `${actual} >= ${n}`),
    toBeLessThanOrEqual: (n: number) => assert.ok((actual as number) <= n, `${actual} <= ${n}`),
    toBeNull: () => assert.equal(actual, null),
  };
  return {
    ...own,
    not: {
      toContain: (item: unknown) => assert.ok(!(actual as unknown[]).includes(item), `${JSON.stringify(item)} absent`),
    },
  };
}

function skill(name: string, over: Partial<HubIndexRow> = {}): HubIndexRow {
  return {
    name,
    description: `${name} does a thing. More words.`,
    claude: true,
    codex: true,
    claudeId: `id-${name}`,
    codexId: `id-${name}`,
    twinsDiffer: false,
    legacyCodex: false,
    dir: `/x/${name}`,
    changedAt: null,
    tooManyFiles: false,
    needsOk: false,
    offHere: false,
    ...over,
  };
}

function linked(name: string, state: SkillLinkState, over: Partial<HubIndexRow> = {}): HubIndexRow {
  return skill(name, {
    link: { originKind: "team", originWords: "the team library", source: "acme/team", plugin: "acme", name, state },
    ...over,
  });
}

function ws(id: string, rows: HubIndexRow[], over: Partial<HubIndexWorkspace> = {}): HubIndexWorkspace {
  return { id, name: id, path: `/code/${id}`, state: "ok", source: "checkout", repo: `acme/${id}`, readAt: 1, rows, ...over };
}

/** R4 AC: a team skill linked in 4 workspaces and present by name only in
 *  1 shows Used in 5; a second checkout of one of those repositories is
 *  listed and not counted twice. */
const INDEX: HubIndex = {
  ...EMPTY_INDEX,
  workspaces: [
    ws("acme-web", [linked("review-rules", "upToDate"), skill("deploy-notes")]),
    ws("astra", [linked("review-rules", "updateAvailable"), skill("deploy-notes", { claudeId: "other", codexId: "other" })]),
    ws("lyra", [linked("review-rules", "modifiedHere")]),
    ws("ops", [linked("review-rules", "bothChanged")]),
    ws("site", [skill("review-rules", { claudeId: "differs", codexId: "differs" })]),
    // A second checkout of acme/web.
    ws("acme-web-2", [linked("review-rules", "upToDate")], { repo: "acme/acme-web" }),
    ws("gone", [linked("review-rules", "updateAvailable")], { state: "missing" }),
    ws("never", [], { state: "missing" }),
  ],
  team: {
    repo: "acme/team",
    readAt: 1,
    problem: null,
    rows: [skill("review-rules", { plugin: "acme", claudeId: "id-review-rules" }), skill("check", { plugin: "acme", needsOk: true })],
  },
  thisMac: { repo: null, readAt: 1, problem: null, rows: [skill("sql-style", { codex: false, codexId: null })] },
  plyloft: { repo: null, readAt: 1, problem: null, rows: [skill("card-brief", { offHere: true })] },
};

const rows = flattenIndex(INDEX);
const names = nameIndex(rows);
const byKey = (key: string) => rows.find((r) => r.key === key)!;
const copies = (row: HubRow) => usedIn(row, names, "acme/team").entries;

describe("flattenIndex", () => {
  it("gives every row its scope and key, and a missing folder never read one row", () => {
    expect(rows.filter((r) => r.scope === "repository" && !r.placeholder)).toHaveLength(9);
    expect(byKey("team:acme:review-rules").scope).toBe("team");
    expect(byKey("thisMac:sql-style").scope).toBe("thisMac");
    expect(byKey("plyloft:card-brief").scope).toBe("plyloft");
    const placeholder = byKey("missing:never");
    expect(placeholder.placeholder).toBe(true);
    expect(placeholder.missing).toBe(true);
    expect(byKey("repository:gone:review-rules").missing).toBe(true);
  });
});

describe("Used in", () => {
  it("joins a team skill's linked copies first, then the same name, and counts by repository", () => {
    const used = usedIn(byKey("team:acme:review-rules"), names, "acme/team");
    const words = used.entries.map((e) => [e.row.workspaceId, e.relation, e.state]);
    expect(words).toEqual([
      ["acme-web", "linked", "upToDate"],
      ["acme-web-2", "linked", "upToDate"],
      ["astra", "linked", "updateAvailable"],
      ["gone", "linked", "updateAvailable"],
      ["lyra", "linked", "modifiedHere"],
      ["ops", "linked", "bothChanged"],
      ["site", "differs", null],
    ]);
    // 4 linked + 1 by name = 5; the second checkout of acme/web and the
    // folder not found are listed but not counted.
    expect(used.count).toBe(5);
    expect(usedInLine(byKey("team:acme:review-rules"), used)).toMatch(/^Used in 5: acme-web \(linked · up to date\)/);
  });

  it("tells same content from same name for a repository skill, with its own copy as here", () => {
    const used = usedIn(byKey("repository:acme-web:deploy-notes"), names, "acme/team");
    expect(used.entries.map((e) => [e.row.workspaceId, e.relation])).toEqual([
      ["acme-web", "here"],
      ["astra", "differs"],
    ]);
    const same = flattenIndex({ ...EMPTY_INDEX, workspaces: [ws("a", [skill("x")]), ws("b", [skill("x")])] });
    const sameUsed = usedIn(same[0], nameIndex(same), null);
    expect(sameUsed.entries.map((e) => e.relation)).toEqual(["here", "sameContent"]);
    expect(sameUsed.count).toBe(2);
  });

  it("says how many updates a team skill's copies have", () => {
    expect(updatesChip(usedIn(byKey("team:acme:review-rules"), names, "acme/team"))).toBe("3 updates");
  });

  it("joins a My library skill's linked copies (origin library) as linked, not same content (H10)", () => {
    const link = { originKind: "library", originWords: "My library", source: "matteo/plyloft-skills", plugin: "mine", name: "walk-style", state: "upToDate" as const };
    const mine = flattenIndex({
      ...EMPTY_INDEX,
      myLibrary: { repo: "matteo/plyloft-skills", readAt: 1, problem: null, rows: [skill("walk-style", { plugin: "mine" })] },
      workspaces: [ws("lyra", [skill("walk-style", { link })]), ws("other", [skill("walk-style")])],
    });
    const row = mine.find((r) => r.key === "myLibrary:walk-style")!;
    const used = usedIn(row, nameIndex(mine), null, "matteo/plyloft-skills");
    expect(used.entries.map((e) => [e.row.workspaceId, e.relation])).toEqual([
      ["lyra", "linked"],
      ["other", "sameContent"],
    ]);
    expect(usedInLine(row, used)).toMatch(/^Used in 2: lyra \(linked · up to date\)/);
    // A link to someone else's My library is not this one's.
    expect(usedIn(row, nameIndex(mine), null, "ana/plyloft-skills").entries[0].relation).toBe("sameContent");
  });

  it("says on the row when a library skill is too long for Windows here (H10)", () => {
    const [row] = flattenIndex({ ...EMPTY_INDEX, myLibrary: { repo: "m/p", readAt: 1, problem: null, rows: [skill("walk-long", { tooLongHere: true })] } });
    expect(rowNotes(row, false)).toContain("Path too long for Windows · sessions on this Mac don't get it");
  });

  it("names Plyloft's skills as used in every session", () => {
    const row = byKey("plyloft:card-brief");
    expect(usedInLine(row, usedIn(row, names, null))).toBe("Used in every session Plyloft starts");
  });
});

describe("the muted count", () => {
  it("counts updates, conflicts, removals and approvals, never a folder not found", () => {
    // astra update + ops both changed + team check needsOk; `gone` is missing.
    expect(attentionCount(rows)).toBe(3);
  });
});

describe("filters", () => {
  const now = 1_000_000_000;
  const run = (patch: Partial<typeof DEFAULT_FILTERS>) =>
    filterRows(rows, { ...DEFAULT_FILTERS, ...patch }, now, copies).map((r) => r.key);

  it("text matches name and description", () => {
    expect(run({ text: "SQL-STYLE" })).toEqual(["thisMac:sql-style"]);
    expect(run({ text: "card-brief does" })).toEqual(["plyloft:card-brief"]);
  });

  it("state: a copy's own, and a library row by its copies", () => {
    expect(run({ state: "updateAvailable" })).toEqual([
      "repository:astra:review-rules",
      "repository:gone:review-rules",
      "team:acme:review-rules",
    ]);
    expect(run({ state: "bothChanged" })).toEqual(["repository:ops:review-rules", "team:acme:review-rules"]);
    expect(run({ state: "notLinked" })).toEqual([
      "repository:acme-web:deploy-notes",
      "repository:astra:deploy-notes",
      "repository:site:review-rules",
    ]);
    expect(run({ state: "needsALook" })).toContain("team:acme:check");
    expect(run({ state: "needsALook" })).not.toContain("repository:gone:review-rules");
  });

  it("changed recently: within the week", () => {
    const fresh = flattenIndex({ ...EMPTY_INDEX, workspaces: [ws("a", [skill("new", { changedAt: now - 1000 }), skill("old", { changedAt: now - 30 * 86_400_000 })])] });
    expect(filterRows(fresh, { ...DEFAULT_FILTERS, state: "changedRecently" }, now, () => []).map((r) => r.name)).toEqual(["new"]);
  });

  it("workspace: its repository rows, and the library rows used there", () => {
    expect(run({ workspaces: ["lyra"] })).toEqual(["repository:lyra:review-rules", "team:acme:review-rules"]);
  });

  it("CLI", () => {
    expect(run({ cli: "claudeOnly" })).toEqual(["thisMac:sql-style"]);
    expect(run({ cli: "codexOnly" })).toEqual([]);
  });

  it("counts each scope (a placeholder is no skill)", () => {
    const counts = scopeCounts(rows);
    expect(counts).toMatchObject({ all: 13, repository: 9, team: 2, thisMac: 1, plyloft: 1, myLibrary: 0 });
  });
});

describe("the list", () => {
  it("groups by scope with headings, and a group over the cap waits for Show all", () => {
    const many = flattenIndex({
      ...EMPTY_INDEX,
      workspaces: [ws("big", Array.from({ length: GROUP_CAP + 7 }, (_, i) => skill(`s${String(i).padStart(3, "0")}`)))],
      thisMac: { repo: null, readAt: 1, problem: null, rows: [skill("mine")] },
    });
    const items = listItems(many, "all", {});
    expect(items[0]).toMatchObject({ kind: "head", scope: "repository", count: GROUP_CAP + 7 });
    expect(items.filter((i) => i.kind === "row")).toHaveLength(GROUP_CAP + 1);
    expect(items.find((i) => i.kind === "more")).toMatchObject({ scope: "repository", hidden: 7 });
    expect(listItems(many, "all", { repository: true }).filter((i) => i.kind === "row")).toHaveLength(GROUP_CAP + 8);
    expect(listItems(many, "thisMac", {}).map((i) => i.kind)).toEqual(["head", "row"]);
  });

  it("windows the items over the scroll", () => {
    const items = listItems(rows, "all", {});
    const offsets = itemOffsets(items);
    expect(offsets[offsets.length - 1]).toBeGreaterThan(0);
    // No layout yet: the first items.
    expect(visibleRange(offsets, 0, 0)).toEqual([0, Math.min(items.length, 30)]);
    const [from, to] = visibleRange(offsets, 200, 100, 0);
    expect(offsets[from]).toBeLessThanOrEqual(200);
    expect(offsets[to]).toBeGreaterThanOrEqual(300);
  });

  it("the arrows step through rows and stop at the ends", () => {
    const keys = rowKeys(listItems(rows, "all", {}));
    expect(stepKey(keys, null, 1)).toBe(keys[0]);
    expect(stepKey(keys, keys[0], -1)).toBe(keys[0]);
    expect(stepKey(keys, keys[0], 1)).toBe(keys[1]);
    expect(stepKey(keys, keys[keys.length - 1], 1)).toBe(keys[keys.length - 1]);
    expect(stepKey([], null, 1)).toBeNull();
  });
});

describe("the stream", () => {
  it("replaces a workspace as it is read and adds a new one", () => {
    const next = applyIndexEvent(INDEX, { kind: "workspace", workspace: ws("lyra", []) });
    expect(next.workspaces.find((w) => w.id === "lyra")!.rows).toEqual([]);
    expect(next.workspaces).toHaveLength(INDEX.workspaces.length);
    const added = applyIndexEvent(INDEX, { kind: "workspace", workspace: ws("fresh", [skill("a")]) });
    expect(added.workspaces[added.workspaces.length - 1].id).toBe("fresh");
    expect(applyIndexEvent(INDEX, { kind: "started", workspaceIds: [], whole: true })).toBe(INDEX);
    expect(applyIndexEvent(INDEX, { kind: "done", builtAt: 5, workspaceIds: [] }).builtAt).toBe(5);
  });

  it("keeps only the app's workspaces, the same object when nothing changed", () => {
    const ids = INDEX.workspaces.map((w) => w.id);
    expect(keepWorkspaces(INDEX, ids)).toBe(INDEX);
    expect(keepWorkspaces(INDEX, ["lyra"]).workspaces.map((w) => w.id)).toEqual(["lyra"]);
  });
});

describe("words", () => {
  it("a row's notes say what the chips can't", () => {
    expect(rowNotes(byKey("repository:gone:review-rules"), false)[0]).toBe("Folder not found · /code/gone");
    expect(rowNotes(byKey("repository:astra:review-rules"), true)).toEqual([
      "Linked to the team library · update available",
      "Reading…",
    ]);
    expect(rowNotes(byKey("plyloft:card-brief"), false)).toContain("Off on this Mac");
    const onBranch = { ...byKey("repository:astra:review-rules"), link: null, branchOnly: true, branch: "walk-1014" };
    expect(rowNotes(onBranch, false)).toEqual(["On walk-1014 only · not in this checkout yet"]);
  });

  it("the status line counts workspaces and folders not found", () => {
    expect(statusWords(INDEX, false, 0, 0)).toBe("8 workspaces · 2 folders not found · not read yet");
    expect(statusWords({ ...INDEX, builtAt: 0 }, false, 0, 5 * 60_000)).toContain("read 5 min ago");
    expect(statusWords(INDEX, true, 3, 0)).toContain("reading 3…");
  });
});

describe("the Workspaces picker", () => {
  it("tells apart workspaces of one name by the end of their path", () => {
    const hints = workspaceHints([
      { id: "a", name: "ghpr", cwd: "/Users/me/code/ghpr" },
      { id: "b", name: "ghpr", cwd: "/Users/me/walk/ghpr" },
      { id: "c", name: "ghpr", cwd: "E:\\walk\\ghpr" },
      { id: "d", name: "lyra", cwd: "/Users/me/code/lyra" },
    ]);
    expect(hints.get("a")).toBe("…/code/ghpr");
    expect(hints.get("b")).toBe("…/me/walk/ghpr");
    expect(hints.get("c")).toBe("E:\\walk\\ghpr");
    expect(hints.get("d")).toBe(null);
  });
});

describe("Copy to… (Skills hub H8)", () => {
  const fromAstra = (state: SkillLinkState, over: Partial<NonNullable<HubIndexRow["link"]>> = {}) =>
    skill("deploy-notes", {
      claudeId: "copy",
      codexId: "copy",
      link: { originKind: "workspace", originWords: "astra", source: "acme/astra", plugin: null, name: "deploy-notes", state, ...over },
    });
  const index: HubIndex = {
    ...EMPTY_INDEX,
    workspaces: [
      ws("astra", [skill("deploy-notes")]),
      ws("lyra", [fromAstra("upToDate")]),
      ws("vega", [fromAstra("updateAvailable")]),
      // A link kept on this Mac names its workspace, not a repository.
      ws("notes", [skill("deploy-notes", { claudeId: "n", codexId: "n" })], { repo: null }),
      ws("orion", [fromAstra("upToDate", { source: "", originWorkspace: "notes", local: true, originWords: "notes" })]),
      ws("site", [skill("deploy-notes", { claudeId: "x", codexId: "x" })]),
    ],
    thisMac: { repo: null, readAt: 1, problem: null, rows: [skill("sql-style")] },
  };
  const rows = flattenIndex(index);
  const names = nameIndex(rows);
  const row = (key: string) => rows.find((r) => r.key === key)!;

  it("joins the copies of a workspace's skill to it, by its repository or the workspace a local link names", () => {
    const astra = usedIn(row("repository:astra:deploy-notes"), names, null);
    expect(astra.entries.map((e) => [e.row.workspaceId, e.relation, e.state])).toEqual([
      ["astra", "here", null],
      ["lyra", "linked", "upToDate"],
      ["vega", "linked", "updateAvailable"],
      ["notes", "differs", null],
      ["orion", "differs", null],
      ["site", "differs", null],
    ]);
    const notes = usedIn(row("repository:notes:deploy-notes"), names, null);
    expect(notes.entries.find((e) => e.row.workspaceId === "orion")?.relation).toBe("linked");
    // From a copy, its origin is named as where it was copied from.
    const lyra = usedIn(row("repository:lyra:deploy-notes"), names, null);
    const origin = lyra.entries.find((e) => e.row.workspaceId === "astra")!;
    expect(origin.relation).toBe("origin");
    expect(usedInEntryWords(origin)).toBe("astra (where it was copied from)");
  });

  it("names one origin when two checkouts of its repository are here, and lists no more than it counts (Mac walk)", () => {
    const twoCheckouts: HubIndex = {
      ...EMPTY_INDEX,
      workspaces: [
        ws("astra-2", [skill("deploy-notes")], { repo: "acme/astra" }),
        ws("astra", [skill("deploy-notes")]),
        ws("lyra", [fromAstra("upToDate", { originWorkspace: "astra" })]),
        ws("vega", [fromAstra("upToDate", { originWorkspace: "astra" })]),
      ],
    };
    const all = flattenIndex(twoCheckouts);
    const n = nameIndex(all);
    const find = (key: string) => all.find((r) => r.key === key)!;
    const lyra = usedIn(find("repository:lyra:deploy-notes"), n, null);
    expect(lyra.entries.filter((e) => e.relation === "origin").map((e) => e.row.workspaceId)).toEqual(["astra"]);
    expect(lyra.entries.map((e) => e.row.workspaceId)).not.toContain("astra-2");
    const astra = usedIn(find("repository:astra:deploy-notes"), n, null);
    expect(astra.entries.map((e) => [e.row.workspaceId, e.relation])).toEqual([
      ["astra", "here"],
      ["lyra", "linked"],
      ["vega", "linked"],
    ]);
    expect(astra.count).toBe(astra.entries.length);
    // Mac re-walk: from the other checkout, the copies are linked — to astra.
    const other = usedIn(find("repository:astra-2:deploy-notes"), n, null);
    expect(other.entries.map((e) => [e.row.workspaceId, e.relation])).toEqual([
      ["astra-2", "here"],
      ["lyra", "linkedElsewhere"],
      ["vega", "linkedElsewhere"],
    ]);
    expect(usedInEntryWords(other.entries[1])).toBe("lyra (linked to astra · up to date)");
    // Windows walk: from one copy, its sibling copy is linked to astra too.
    const fromLyra = usedIn(find("repository:lyra:deploy-notes"), n, null);
    const vega = fromLyra.entries.find((e) => e.row.workspaceId === "vega")!;
    expect(vega.relation).toBe("linkedElsewhere");
    expect(usedInEntryWords(vega)).toBe("vega (linked to astra · up to date)");
    // …whatever each copy holds now (one updated, the other not).
    const apart = flattenIndex({
      ...twoCheckouts,
      workspaces: twoCheckouts.workspaces.map((w) =>
        w.id === "vega" ? ws("vega", [{ ...fromAstra("updateAvailable", { originWorkspace: "astra" }), claudeId: "old", codexId: "old" }]) : w,
      ),
    });
    const lyraApart = usedIn(apart.find((r) => r.key === "repository:lyra:deploy-notes")!, nameIndex(apart), null);
    expect(usedInEntryWords(lyraApart.entries.find((e) => e.row.workspaceId === "vega")!)).toBe("vega (linked to astra · update available)");
    // An older cache with no origin workspace: still one origin entry.
    const old = flattenIndex({
      ...twoCheckouts,
      workspaces: twoCheckouts.workspaces.map((w) =>
        w.id === "lyra" ? ws("lyra", [fromAstra("upToDate")]) : w,
      ),
    });
    const oldUsed = usedIn(old.find((r) => r.key === "repository:lyra:deploy-notes")!, nameIndex(old), null);
    expect(oldUsed.entries.filter((e) => e.relation === "origin")).toHaveLength(1);
  });

  it("offers Copy to… where there is something committed to copy, never for Plyloft", () => {
    expect(copyFromOf(row("repository:astra:deploy-notes"))).toEqual({ kind: "workspace", workspaceId: "astra", skill: "deploy-notes" });
    expect(copyFromOf(row("thisMac:sql-style"))).toEqual({ kind: "thisMac", skill: "sql-style" });
    expect(copyFromOf({ ...row("repository:astra:deploy-notes"), branchOnly: true })).toBeNull();
    expect(copyFromOf({ ...row("repository:astra:deploy-notes"), missing: true })).toBeNull();
    expect(copyFromOf({ ...row("thisMac:sql-style"), scope: "plyloft" })).toBeNull();
    const team = { ...row("thisMac:sql-style"), scope: "team" as const, plugin: "acme" };
    expect(copyFromOf(team)).toEqual({ kind: "team", plugin: "acme", skill: "sql-style" });
  });

  it("reads the copies again with their origin", () => {
    expect(linkedFrom(rows, "astra", "acme/astra").sort()).toEqual(["lyra", "vega"]);
    expect(linkedFrom(rows, "notes", null)).toEqual(["orion"]);
    expect(linkedFrom(rows, "site", "acme/site")).toEqual([]);
  });

  it("says who gets what, for which CLIs, and when (R18.4)", () => {
    const facts = { skill: "deploy-notes", claude: true, codex: false, cardTitle: "Skill: copy deploy-notes from astra" };
    expect(copySentence(facts, [])).toBe("Pick the workspaces that get it.");
    expect(copySentence(facts, [{ name: "lyra", repo: "acme/lyra" }])).toBe(
      "lyra gets deploy-notes for Claude once card “Skill: copy deploy-notes from astra” ships. Everyone who opens acme/lyra gets it from then on; sessions already open keep what they have.",
    );
    expect(copySentence(facts, [{ name: "lyra", repo: null }])).toContain("Everyone who opens lyra's repository");
    expect(copySentence({ ...facts, codex: true }, [{ name: "a", repo: null }, { name: "b", repo: null }, { name: "c", repo: null }])).toBe(
      "a, b and c each get a card “Skill: copy deploy-notes from astra”. Once a card ships, everyone who opens that repository gets deploy-notes for Claude and Codex. Sessions already open keep what they have; new ones get it.",
    );
    expect(targetNote({ kind: "sameContent" }, "deploy-notes", "astra")).toBe("Has the same deploy-notes, not linked. Its card only links it to astra.");
    expect(targetNote({ kind: "refused", why: "lyra already has it, linked to astra." }, "x", "astra")).toBe("lyra already has it, linked to astra.");
    // Mac re-walk: a local link's line says so, as the Library does.
    const localRow = row("repository:orion:deploy-notes");
    expect(rowNotes(localRow, false)[0]).toMatch(/^Linked on this (Mac|PC) to notes · up to date$/);
    expect(rowNotes({ ...localRow, link: { ...localRow.link!, state: "notAvailable" } }, false)[0]).toMatch(
      /^Linked on this (Mac|PC) to notes — not available on this (Mac|PC)$/,
    );
    // Mac walk: pickable first, then link/replace, then refused; by name.
    const sorted = sortTargets([
      { name: "zeta", target: { kind: "refused", why: "x" } },
      { name: "Vega", target: { kind: "replace" } },
      { name: "lyra", target: { kind: "ready" } },
      { name: "alpha", target: { kind: "refused", why: "x" } },
      { name: "Astra", target: { kind: "ready" } },
      { name: "notes", target: { kind: "linkHere" } },
    ] as const);
    expect(sorted.map((t) => t.name)).toEqual(["Astra", "lyra", "notes", "Vega", "alpha", "zeta"]);
    // Challenger: a local link to copies already there needs no card.
    expect(targetNote({ kind: "linkHere" }, "scratch", "notes")).toMatch(/^Has the same scratch, not linked\. It is linked to notes on this (Mac|PC) at once: no card needed\.$/);
  });
});

if (failures > 0) {
  console.error(`allSkills: ${failures} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`allSkills: ${passed} passed`);
