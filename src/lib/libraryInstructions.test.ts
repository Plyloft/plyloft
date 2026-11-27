// Tier 3 pure test (GH #101, ADR 0005; BOARDS.md §5). Run with Node 22+:
//   node --experimental-strip-types src/lib/libraryInstructions.test.ts
//
// The Instructions page's own decisions: what the Procedure row offers, what a
// queued publish puts on it, what a Value row's hint says, and the flow's
// Before/After preview. The doctor's sentences are Rust's and are tested there
// (`instruction_files.rs`); nothing here restates them.
import assert from "node:assert/strict";
import {
  FLOW_PREVIEW_LINES,
  NEVER_OVERRIDE_MARKER,
  PROCEDURE_LABEL,
  STEP_LABEL,
  behindHere,
  fileAskBuilder,
  fileHint,
  instructionNotes,
  instructionRow,
  instructionTransient,
  instructionsStatus,
  moreLines,
  personalDetails,
  personalHint,
  previewLines,
} from "./libraryInstructions.ts";
import { refusalConcerns, refusalPage } from "./uxError.ts";
import type { InstructionFileRow, InstructionProcedure } from "../ipc.ts";
import type { LibraryStateLike } from "./sharedLibrary.ts";

let passed = 0;

const needsSetUp: InstructionProcedure = {
  status: "agents-missing",
  sentence: "Only CLAUDE.md — Codex reads nothing here.",
  step: "promote-claude-shared",
};
const quiet: InstructionProcedure = {
  status: "compliant",
  sentence: "Shared through AGENTS.md — both CLIs read the same file.",
  step: null,
};

function file(name: string, over: Partial<InstructionFileRow> = {}): InstructionFileRow {
  return {
    name,
    lines: 212,
    hint: "The house rules for this repository — 212 lines.",
    openInCode: `/repo/${name}`,
    // GH #142: the reading view's path, which a row with a checkout copy never
    // carries — `file_rows` sets one or the other, never both.
    readOnlyPath: null,
    located: "both",
    ...over,
  };
}

function state(over: Partial<LibraryStateLike> = {}): LibraryStateLike {
  return {
    shared: true,
    branch: "staging",
    readOnly: false,
    repository: "MatteoB-adv/lyra-jun-2025",
    pending: [],
    branchSkills: [],
    ...over,
  };
}

// ── The Procedure row: one sentence, at most one step ────────────────────

{
  const row = instructionRow(needsSetUp, [file("CLAUDE.md")], null, { readOnly: false });
  assert.equal(row.label, PROCEDURE_LABEL);
  assert.equal(row.sentence, needsSetUp.sentence);
  assert.equal(row.action, STEP_LABEL);
  assert.equal(row.transient, null);
  assert.equal(row.opens, null, "the step is the row's right side, not a chevron");

  // Afterwards the procedure goes quiet: no action, and the board's `›` onto the
  // file that now holds the shared instructions.
  const after = instructionRow(
    quiet,
    [file("AGENTS.md"), file("CLAUDE.md")],
    null,
    { readOnly: false },
  );
  assert.equal(after.action, null);
  assert.equal(after.opens, "/repo/AGENTS.md");

  // A shared file the checkout does not carry: still no action, and nothing to
  // open — Ply offers Code only a file it may write.
  const notYet = instructionRow(
    quiet,
    [file("AGENTS.md", { openInCode: null, located: "branchOnly" })],
    null,
    { readOnly: false, branch: "staging" },
  );
  assert.equal(notYet.opens, null);
  // GH #101 review 1 (MAJOR): the branch having it is not the agents here reading
  // it. The board's sentence stays and the gap is said after it, with no step —
  // pulling is git's job, not a button Ply may put on this row.
  assert.ok(notYet.sentence.startsWith(quiet.sentence), notYet.sentence);
  assert.match(
    notYet.sentence,
    /AGENTS\.md is not that yet in your project folder — Ask the Builder to bring staging here so the agents here read it too\./,
  );
  assert.equal(notYet.action, null, "no invented step");
  // Both files behind, and both named.
  const bothBehind = instructionRow(
    quiet,
    [
      file("AGENTS.md", { openInCode: null, located: "branchOnly" }),
      file("CLAUDE.md", { located: "bothDiffering" }),
    ],
    null,
    { readOnly: false, branch: "staging" },
  );
  assert.match(bothBehind.sentence, /AGENTS\.md and CLAUDE\.md are not that yet/);
  // Nothing behind: the board's sentence alone.
  assert.equal(after.sentence, quiet.sentence);
  assert.deepEqual(behindHere([file("AGENTS.md"), file("CLAUDE.md")]), []);
  assert.deepEqual(
    behindHere([
      file("AGENTS.md", { located: "branchOnly" }),
      file("CLAUDE.md", { located: "checkoutOnly" }),
    ]),
    ["AGENTS.md"],
    "a file only this checkout has is not the agents being behind",
  );

  // Read-only: the sentence, and no button that could only fail.
  const reader = instructionRow(needsSetUp, [file("CLAUDE.md")], null, { readOnly: true });
  assert.equal(reader.action, null);
  assert.equal(reader.sentence, needsSetUp.sentence);
  passed += 1;
}

// ── The channel's transient states, off the same `pending` list ──────────

{
  assert.equal(instructionTransient(null, null), null);
  assert.equal(instructionTransient(state(), "staging"), null);
  // A skill in the queue is not this row's business.
  assert.equal(
    instructionTransient(
      state({
        pending: [
          { kind: "skill", name: "deploy", title: "deploy", removed: false, lastError: null, pullRequest: null },
        ],
      }),
      "staging",
    ),
    null,
  );

  const publishing = instructionTransient(
    state({
      pending: [
        { kind: "instructions", name: "AGENTS.md", title: "both CLIs read AGENTS.md", removed: false, lastError: null, pullRequest: null },
      ],
    }),
    "staging",
  );
  assert.deepEqual(publishing, { kind: "publishing", sentence: "Publishing to staging…" });

  const waiting = instructionTransient(
    state({
      pending: [
        {
          kind: "instructions",
          name: "AGENTS.md",
          title: "both CLIs read AGENTS.md",
          removed: false,
          lastError: null,
          pullRequest: { number: 412, url: "https://github.com/o/r/pull/412" },
        },
      ],
    }),
    "staging",
  );
  assert.equal(waiting?.kind, "pullRequest");
  assert.match(waiting!.sentence, /pull request #412/);

  // While something is happening the step is not offered again — a second press
  // would queue a second copy of the same change — and the waiting row's one
  // action is the pull request.
  const row = instructionRow(needsSetUp, [file("CLAUDE.md")], waiting, { readOnly: false });
  assert.equal(row.action, null);
  assert.equal(row.pullRequest, 412);
  assert.equal(row.sentence, waiting!.sentence);

  const failed = instructionTransient(
    state({
      pending: [
        { kind: "instructions", name: "AGENTS.md", title: "t", removed: false, lastError: "staging refused the push.", pullRequest: null },
      ],
    }),
    "staging",
  );
  assert.equal(failed?.kind, "error");
  assert.match(failed!.sentence, /It waits here; Plyloft tries again on the next Sync\./);
  assert.equal(
    instructionRow(needsSetUp, [], failed, { readOnly: false }).action,
    null,
  );
  passed += 1;
}

// ── A Value row's hint ──────────────────────────────────────────────────

{
  const here = file("CLAUDE.md");
  assert.equal(fileHint(here, { shared: true, branch: "staging" }, null), here.hint);

  // GH #101 review 1 (MAJOR): nothing delivers a root instruction file to a
  // checkout, so the hint must not promise a Sync will. It says what is true.
  const onlyOnBranch = file("AGENTS.md", { openInCode: null, located: "branchOnly" });
  assert.equal(
    fileHint(onlyOnBranch, { shared: true, branch: "staging" }, null),
    `${onlyOnBranch.hint} On staging only — Ask the Builder to bring it here.`,
  );
  for (const hint of [
    fileHint(onlyOnBranch, { shared: true, branch: "staging" }, null),
    fileHint(
      file("CLAUDE.md", { located: "bothDiffering" }),
      { shared: true, branch: "staging" },
      null,
    ),
  ]) {
    assert.ok(!/next Sync/.test(hint), `Sync does not deliver it: ${hint}`);
    assert.match(hint, /Ask the Builder to bring/);
  }
  assert.match(
    fileHint(
      file("CLAUDE.md", { located: "bothDiffering" }),
      { shared: true, branch: "staging" },
      null,
    ),
    /That is your copy; staging has a different one/,
  );
  assert.match(
    fileHint(
      file("CLAUDE.md", { located: "checkoutOnly" }),
      { shared: true, branch: "staging" },
      null,
    ),
    /In your project folder only — it reaches nobody else until it is on staging\./,
  );

  // GH #161: a copy the mirror has only because a queued change laid it there.
  // `staging` has not got it, so the hint never sends the member to pull it — it
  // says where the change waits, in the Procedure row's own words.
  const queued = file("AGENTS.md", { openInCode: null, located: "queued" });
  const view = { shared: true, branch: "staging" };
  const inPr = instructionTransient(
    state({
      pending: [
        {
          kind: "instructions",
          name: "AGENTS.md",
          title: "both CLIs read AGENTS.md",
          removed: false,
          lastError: null,
          pullRequest: { number: 375, url: "u" },
        },
      ],
    }),
    "staging",
  );
  assert.equal(
    fileHint(queued, view, inPr),
    `${queued.hint} Waiting in pull request #375 — not on staging until that is merged.`,
  );
  assert.equal(
    fileHint(queued, view, { kind: "publishing", sentence: "Publishing to staging…" }),
    `${queued.hint} Publishing to staging… it is not there yet.`,
  );
  // Blocked, failed, or read between the queue and the page: still never "on
  // staging only", and never a pull to make.
  for (const hint of [
    fileHint(queued, view, { kind: "blocked", sentence: NEVER_OVERRIDE_MARKER }),
    fileHint(queued, view, null),
  ]) {
    assert.equal(hint, `${queued.hint} Waiting here; staging does not carry it.`);
  }

  // GH #161 review 1 (MAJOR): the same change laid **over** a file the branch
  // carries — every `CLAUDE.md` the step writes its import line into. It is not
  // "not on staging": staging keeps its own copy until this lands, and saying
  // otherwise was the same mistake in the other direction.
  const over = file("CLAUDE.md", { located: "queuedOverBranch" });
  assert.equal(
    fileHint(over, view, inPr),
    `${over.hint} Waiting in pull request #375 — until that is merged, staging keeps the copy it has.`,
  );
  assert.equal(
    fileHint(over, view, { kind: "publishing", sentence: "Publishing to staging…" }),
    `${over.hint} Publishing to staging… until it lands, staging keeps the copy it has.`,
  );
  assert.equal(
    fileHint(over, view, null),
    `${over.hint} Waiting here; staging keeps the copy it has until this lands.`,
  );
  for (const hint of [
    fileHint(queued, view, inPr),
    fileHint(queued, view, { kind: "publishing", sentence: "Publishing to staging…" }),
    fileHint(queued, view, null),
    fileHint(over, view, inPr),
    fileHint(over, view, null),
  ]) {
    assert.ok(!/On staging only/.test(hint), hint);
    assert.ok(!/pull it|Ask the Builder/.test(hint), hint);
  }
  // Neither is something the checkout is told it is "behind" on: for `queued`
  // there is nothing on the branch to pull, and for `queuedOverBranch` this build
  // shows the queue's bytes and cannot say whether the branch's differ from the
  // checkout's. The Procedure row shows the transient's sentence anyway.
  assert.deepEqual(behindHere([queued, over]), []);
  assert.deepEqual(
    behindHere([file("AGENTS.md", { located: "branchOnly" }), queued, over]),
    ["AGENTS.md"],
  );
  passed += 1;
}

// ── The status line under the header ────────────────────────────────────

{
  const view = {
    shared: true,
    branch: "staging",
    readOnly: false,
    repository: "MatteoB-adv/lyra-jun-2025",
    workspaceRoot: "/repo",
    files: [],
    procedure: quiet,
    plan: null,
    personal: [],
    errors: [],
  };
  assert.equal(instructionsStatus(null), null);
  assert.match(instructionsStatus(view)!.text, /committed there for everyone/);
  assert.match(
    instructionsStatus({ ...view, readOnly: true })!.text,
    /needs write access to MatteoB-adv\/lyra-jun-2025/,
  );
  assert.match(
    instructionsStatus({ ...view, shared: false, branch: null })!.text,
    /travels with a card/,
  );
  passed += 1;
}

// ── The flow's Before/After preview ─────────────────────────────────────

{
  const body = Array.from({ length: 212 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const shim = "@AGENTS.md\n";
  // GH #101 review 2 (MINOR): the Before panel is called without `against` and
  // carries **no** marks. Marking it called every one of its lines `only here`
  // right above `The 212 lines move to AGENTS.md, unchanged.`
  const { lines, more } = previewLines(body);
  assert.equal(lines.length, FLOW_PREVIEW_LINES);
  assert.equal(lines[0].text, "line 1");
  assert.equal(lines[0].no, 1);
  assert.deepEqual(
    lines.map((l) => l.mark),
    ["", "", ""],
    "the Before panel draws no marks",
  );
  // The board: a 212-line CLAUDE.md shows its first lines and `… 209 more lines`.
  assert.equal(more, 209);
  assert.equal(moreLines(more), "… 209 more lines");

  // GH #101 review 1 (MINOR): BOARDS §5 lists `+ @AGENTS.md`, so the added line
  // carries its own panel's mark.
  const after = previewLines(shim, body);
  assert.deepEqual(after.lines, [{ no: 1, text: "@AGENTS.md", mark: "+" }]);
  assert.equal(after.more, 0);
  // Membership, not position: the step **prepends** the import, so the lines that
  // follow are unchanged and must not be marked.
  const prepended = previewLines(shim + body, body);
  assert.deepEqual(
    prepended.lines.map((l) => l.mark),
    ["+", "", ""],
    "a positional walk would call every following line changed",
  );
  // Counted, so a line repeated on one side only is still marked.
  assert.deepEqual(
    previewLines("a\na\n", "a\n").lines.map((l) => l.mark),
    ["", "+"],
  );
  // `undefined` is "no marks"; an explicit `null` is "the other panel has no
  // file", where every line here really is only here.
  assert.deepEqual(
    previewLines("a\nb\n").lines.map((l) => l.mark),
    ["", ""],
  );
  assert.deepEqual(
    previewLines("a\nb\n", null).lines.map((l) => l.mark),
    ["+", "+"],
  );
  assert.equal(moreLines(0), null);
  assert.equal(moreLines(1), "… 1 more line");
  // A file that isn't there yet has no lines at all.
  assert.deepEqual(previewLines(null, shim), { lines: [], more: 0 });
  passed += 1;
}

// ── `On this Mac`, and the refusals the page shows ──────────────────────

{
  const mine = {
    rel: ".claude/CLAUDE.md",
    path: "/Users/m/.claude/CLAUDE.md",
    cli: "Claude",
    lines: 1,
  };
  assert.equal(
    personalHint(mine),
    "Claude reads this before every session on this Mac — 1 line.",
  );
  assert.deepEqual(personalDetails(mine), [
    "/Users/m/.claude/CLAUDE.md",
    "Claude reads it · 1 line",
  ]);
  assert.equal(personalHint({ ...mine, lines: 2 }).endsWith("2 lines."), true);

  // A symlink on the branch is named, and a symlink on this Mac too — once each.
  const notes = instructionNotes(
    {
      shared: true,
      branch: "staging",
      readOnly: false,
      repository: null,
      workspaceRoot: "/repo",
      files: [],
      procedure: quiet,
      plan: null,
      personal: [],
      errors: [".claude/CLAUDE.md is a symlink, so Plyloft does not read it."],
    },
    state({ skipped: ["AGENTS.md is a symlink", ".claude/skills/x contains a symlink"] }),
  );
  assert.equal(notes.length, 2, JSON.stringify(notes));
  assert.match(notes[0], /Not loaded from staging: AGENTS\.md is a symlink/);
  assert.match(notes[1], /\.claude\/CLAUDE\.md is a symlink/);
  passed += 1;
}

// ── The never-override dead end, and where a refusal is said ────────────

{
  // GH #101 review 1 (MAJOR): a failure that is not a refused push gets its own
  // state, and the backend's sentence is the whole answer — "Ply tries again on
  // the next Sync" would be a promise the bases cannot keep.
  const blocked = instructionTransient(
    state({
      pending: [
        {
          kind: "instructions",
          name: "AGENTS.md",
          title: "both CLIs read AGENTS.md",
          removed: false,
          lastError: `AGENTS.md changed on staging since this edit began (other-mac changed it 2 min ago). ${NEVER_OVERRIDE_MARKER}, and the GitHub CLI isn't available to open a pull request instead — nothing was changed, on staging or here.`,
          pullRequest: null,
        },
      ],
    }),
    "staging",
  );
  assert.equal(blocked?.kind, "blocked");
  assert.ok(!/tries again on the next Sync/.test(blocked!.sentence), blocked!.sentence);
  assert.match(blocked!.sentence, /nothing was changed, on staging or here/);
  // An ordinary failure still reads as one.
  const ordinary = instructionTransient(
    state({
      pending: [
        { kind: "instructions", name: "AGENTS.md", title: "t", removed: false, lastError: "offline.", pullRequest: null },
      ],
    }),
    "staging",
  );
  assert.equal(ordinary?.kind, "error");
  assert.match(ordinary!.sentence, /tries again on the next Sync/);
  // Either way the step is not offered again.
  for (const t of [blocked, ordinary]) {
    assert.equal(instructionRow(needsSetUp, [], t, { readOnly: false }).action, null);
  }

  // GH #101 review 1 (MAJOR): a refusal is drawn, and `Show` lands, on the page
  // whose items are waiting.
  assert.equal(refusalPage({ kinds: ["instructions"] }), "instructions");
  assert.equal(refusalPage({ kinds: ["skill"] }), "skills");
  assert.equal(refusalPage({ kinds: ["skill", "instructions"] }), "instructions");
  assert.equal(refusalPage({}), "skills", "a report written before this field");
  assert.equal(refusalConcerns({ kinds: ["instructions"] }, "instructions"), true);
  assert.equal(refusalConcerns({ kinds: ["instructions"] }, "skills"), false);
  assert.equal(refusalConcerns({ kinds: ["knowledge"] }, "skills"), true);
  assert.equal(refusalConcerns({ kinds: ["knowledge"] }, "instructions"), false);
  assert.equal(refusalConcerns({}, "skills"), true, "every refusal was Skills' before #101");
  assert.equal(refusalConcerns({}, "instructions"), false);
  assert.equal(refusalConcerns({ kinds: [] }, "skills"), true);
  passed += 1;
}

// QoL 13.2 (D4): a copy here that isn't the branch's offers Ask the Builder,
// with the request; every other row offers nothing of the kind.
{
  assert.match(fileAskBuilder(file("AGENTS.md", { located: "branchOnly" }), "staging") ?? "", /^My project folder is behind staging\. I need it for AGENTS\.md\./);
  assert.ok(fileAskBuilder(file("CLAUDE.md", { located: "bothDiffering" }), null));
  assert.equal(fileAskBuilder(file("AGENTS.md", { located: "both" }), "staging"), null);
  assert.equal(fileAskBuilder(file("AGENTS.md", { located: "checkoutOnly" }), "staging"), null);
  passed += 1;
}

console.log(`libraryInstructions: ${passed}/8 passed`);
