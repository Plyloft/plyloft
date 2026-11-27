import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIFF_MARK_LABEL,
  PROPOSAL_CHIP,
  PROPOSAL_FOOTNOTE,
  countsAsCorrection,
  correctionPayload,
  observeBuilderTyping,
  proposalApproveLabel,
  proposalByline,
  proposalDiff,
  proposalFootnote,
  proposalIsFor,
  proposalNoDiff,
  proposalPage,
  proposalTarget,
  proposalShipLine,
  proposalSourceLine,
  relativeWhen,
  type ProposalView,
} from "./proposals.ts";

/**
 * GH #104: the three surfaces' view models, and the one frontend half of the
 * friction rule. BOARDS.md §4 "Improvement proposal (state C)" fixes every
 * string asserted here.
 */

const DIFF = [
  "--- a/.claude/skills/deploy/SKILL.md",
  "+++ b/.claude/skills/deploy/SKILL.md",
  "@@ -3,3 +3,5 @@",
  " # Deploy",
  "+Check that a rollback test exists before pushing.",
  "+Stop and say so when one is missing.",
  "-Push it.",
  " Done.",
  "",
].join("\n");

function skillProposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    target: { kind: "skill", name: "deploy", path: ".claude/skills/deploy/SKILL.md" },
    label: "deploy",
    scope: "repository",
    path: ".claude/skills/deploy/SKILL.md",
    cardId: "card-88",
    cardRef: "#88",
    reason: "After card #88: three rounds with the Reviewer over missing rollback tests.",
    words:
      "The change asks the deploy skill to check that a rollback test exists before it pushes. Two lines are added; one is removed.",
    diff: DIFF,
    createdAt: 1_800_000_000_000,
    canApprove: true,
    ...over,
  };
}

// ── The byline ───────────────────────────────────────────────────────

{
  const at = 1_800_000_000_000;
  assert.equal(
    proposalByline(at, at + 2 * 3600 * 1000),
    "from the Reviewer · 2 hours ago",
    "the board's byline, verbatim",
  );
  // GH #104 walk 2: a lesson from the human's own correction is theirs.
  assert.equal(
    proposalByline(at, at + 2 * 3600 * 1000, "the human's correction: \"use a calc prefix\""),
    "from your correction · 2 hours ago",
  );
  assert.equal(proposalByline(at, at + 60_000, "The human's correction 2: 'use calc'"), "from your correction · 1 minute ago");
  assert.equal(proposalByline(at, at, "review round 2"), "from the Reviewer · just now");
  assert.equal(proposalByline(at, at, "the Verify failure"), "from the Reviewer · just now");
  assert.equal(proposalByline(at, at, null), "from the Reviewer · just now");
  assert.equal(proposalByline(at, at, "  "), "from the Reviewer · just now");
  assert.equal(relativeWhen(at, at), "just now");
  assert.equal(relativeWhen(at, at + 59_000), "just now");
  assert.equal(relativeWhen(at, at + 60_000), "1 minute ago");
  assert.equal(relativeWhen(at, at + 4 * 60_000), "4 minutes ago");
  assert.equal(relativeWhen(at, at + 3600_000), "1 hour ago");
  assert.equal(relativeWhen(at, at + 25 * 3600_000), "1 day ago");
  assert.equal(relativeWhen(at, at + 3 * 24 * 3600_000), "3 days ago");
  // A clock that went backwards says "just now", never a negative age.
  assert.equal(relativeWhen(at, at - 10_000), "just now");
}

// ── The block's diff ─────────────────────────────────────────────────

{
  const diff = proposalDiff(skillProposal());
  assert.ok(diff, "a repository proposal draws its diff");
  assert.equal(diff.path, ".claude/skills/deploy/SKILL.md", "the file, in mono, on the header");
  assert.equal(diff.count, "2 lines added, 1 removed", "the board's count");

  // The hunk header is a separator, not content.
  assert.equal(diff.lines[0].hunk, true);
  assert.equal(diff.lines[0].mark, "");
  assert.equal(diff.lines[0].no, null);

  const body = diff.lines.filter((line) => !line.hunk);
  assert.deepEqual(
    body.map((line) => [line.no, line.mark, line.text]),
    [
      [3, "", "# Deploy"],
      [4, "+", "Check that a rollback test exists before pushing."],
      [5, "+", "Stop and say so when one is missing."],
      [null, "−", "Push it."],
      [6, "", "Done."],
    ],
    "numbers are the changed file's, read off the hunk header; a removed line has none",
  );

  // Only the marked lines carry the bar and the `--hover` background.
  assert.deepEqual(
    body.filter((line) => line.mark !== "").map((line) => line.mark),
    ["+", "+", "−"],
  );

  // The marks are #100's glyphs with the diff's own words: `+` is "added"
  // here, not Compare's "only here".
  assert.equal(DIFF_MARK_LABEL["+"], "added");
  assert.equal(DIFF_MARK_LABEL["−"], "removed");

  // An added-only diff says just the one number, as the board draws it.
  const added = proposalDiff(
    skillProposal({
      diff: [
        "--- a/AGENTS.md",
        "+++ b/AGENTS.md",
        "@@ -1,1 +1,2 @@",
        " # Atelier",
        "+A rule.",
        "",
      ].join("\n"),
    }),
  );
  assert.equal(added?.count, "1 line added");
}

{
  // Words only: no diff to draw, and nothing half-drawn in its place.
  assert.equal(proposalDiff(skillProposal({ diff: null })), null);
  // Something that is not a diff is not rendered as plain lines either.
  assert.equal(proposalDiff(skillProposal({ diff: "please add a rollback check" })), null);
  assert.equal(proposalDiff(skillProposal({ diff: "" })), null);
}

// ── The Inbox row's words live in Rust ──────────────────────────────

{
  // GH #104 review 1 (NIT): `inbox::derive_proposal_events` composes the row, so
  // a second copy here would be dead code free to drift from what people read.
  // The strings are asserted against the Rust that builds them.
  const rust = readFileSync(
    new URL("../../src-tauri/src/inbox.rs", import.meta.url),
    "utf8",
  );
  assert.match(rust, /A suggested skill change is waiting — \{label\}/);
  assert.match(rust, /A suggested change to \{label\} is waiting/);
  assert.match(rust, /After card \{\} · \{\}/);
  assert.doesNotMatch(
    readFileSync(new URL("./proposals.ts", import.meta.url), "utf8"),
    /proposalInboxItem/,
    "no second copy of the row's words",
  );
}

// ── The Ship-step line ───────────────────────────────────────────────

{
  assert.deepEqual(proposalShipLine(skillProposal()), {
    line: "A suggested skill change is waiting — deploy",
    action: "See the change",
  });
  assert.equal(
    proposalShipLine(
      skillProposal({
        target: { kind: "instructions", file: "CLAUDE.md" },
        label: "CLAUDE.md",
        scope: "repository",
      }),
    ).line,
    "A suggested change to CLAUDE.md is waiting",
  );
}

// ── Which page all three open ────────────────────────────────────────

{
  assert.equal(proposalPage(skillProposal()), "skills");
  assert.equal(
    proposalPage(
      skillProposal({
        target: { kind: "elsewhere", name: "deploy", scope: "this-mac" },
        scope: "this-mac",
      }),
    ),
    "skills",
    "a personal skill is still on the Skills page",
  );
  assert.equal(
    proposalPage(skillProposal({ target: { kind: "instructions", file: "AGENTS.md" } })),
    "instructions",
  );
}

{
  const skill = skillProposal();
  const at = (name: string, scope: ProposalView["scope"]) =>
    proposalIsFor(skill, { page: "skill", name, scope });
  assert.equal(at("deploy", "repository"), true);
  assert.equal(at("other", "repository"), false);
  // Review 1 (MINOR): the same name at another scope is another skill. The block
  // must not be drawn over a file it is not about.
  assert.equal(at("deploy", "this-mac"), false);
  assert.equal(at("deploy", "team"), false);
  assert.equal(at("deploy", "ply"), false);
  assert.equal(proposalIsFor(skill, { page: "instructions", file: "AGENTS.md" }), false);
  assert.equal(proposalIsFor(skill, { page: "skills-list" }), true);
  assert.equal(proposalIsFor(null, { page: "skills-list" }), false);
  // GH #271: the list carries it only under a scope that lists its target.
  assert.equal(proposalIsFor(skill, { page: "skills-list", scope: "all" }), true);
  assert.equal(proposalIsFor(skill, { page: "skills-list", scope: "repository" }), true);
  assert.equal(proposalIsFor(skill, { page: "skills-list", scope: "ply" }), false);
  assert.equal(proposalIsFor(skill, { page: "skills-list", scope: "this-mac" }), false);

  const instructions = skillProposal({
    target: { kind: "instructions", file: "AGENTS.md" },
    label: "AGENTS.md",
    scope: "repository",
  });
  assert.equal(proposalIsFor(instructions, { page: "instructions", file: "AGENTS.md" }), true);
  assert.equal(proposalIsFor(instructions, { page: "instructions", file: "CLAUDE.md" }), false);
  assert.equal(
    proposalIsFor(instructions, { page: "skills-list" }),
    false,
    "the instructions' block never appears on Skills",
  );

  // A personal skill's proposal lands on the page of **that** copy, the one the
  // Library lists under This Mac — and on no other of the same name.
  const personal = skillProposal({
    target: { kind: "elsewhere", name: "deploy", scope: "this-mac" },
    scope: "this-mac",
  });
  assert.equal(proposalIsFor(personal, { page: "skill", name: "deploy", scope: "this-mac" }), true);
  assert.equal(
    proposalIsFor(personal, { page: "skill", name: "deploy", scope: "repository" }),
    false,
    "never over the repository's own deploy",
  );
}

// ── A read-only collaborator, and a words-only proposal ──────────────

{
  const readOnly = skillProposal({ canApprove: false });
  assert.equal(readOnly.canApprove, false, "no Approve for a read-only collaborator");
  // The block still says what the change is: the reason, the words and the diff
  // are all there to read.
  assert.ok(proposalDiff(readOnly));
  assert.equal(PROPOSAL_CHIP, "Suggested skill change");
  assert.equal(PROPOSAL_FOOTNOTE, "Publishing reaches everyone who opens this repository.");
}

// ── SP-5: a solo user's Approve commits, and says so ─────────────────

{
  assert.equal(proposalApproveLabel({ commitTo: "main" }), "Approve and commit to main");
  assert.equal(proposalApproveLabel({ commitTo: null }), "Approve and publish");
  assert.equal(proposalApproveLabel({}), "Approve and publish", "an older backend's view");
  assert.match(proposalFootnote({ commitTo: "staging" }), /^A commit on staging .* nothing is pushed\.$/);
  assert.equal(proposalFootnote({}), PROPOSAL_FOOTNOTE);
}

// ── The correction rule (the friction rule's frontend half) ─────────

{
  // The plain text of a submission.
  assert.equal(correctionPayload("use the other path"), "use the other path");
  assert.equal(correctionPayload("   "), "");
  assert.equal(correctionPayload("\u001b[A\u001b[B"), "", "arrow keys are not content");
  assert.equal(correctionPayload("\u0003"), "", "ctrl-C is not content");
  assert.equal(
    correctionPayload("\u001b[200~two lines\u001b[201~"),
    "two lines",
    "a bracketed paste's markers are not content",
  );
  assert.equal(correctionPayload("abc\u007f\u007f"), "a", "backspace deletes");
  assert.equal(correctionPayload("ab\b"), "a");
}

{
  const idle = { answered: true, atPrompt: true };
  // What counts: a human typing a sentence at an idle Builder.
  assert.equal(countsAsCorrection({ payload: "use the other path", ...idle }), true);
  assert.equal(countsAsCorrection({ payload: "no, use the other path", ...idle }), true);

  // Before the first answer, nothing is a correction: those are the vendor's own
  // start-up questions being answered.
  assert.equal(
    countsAsCorrection({ payload: "yes", answered: false, atPrompt: true }),
    false,
  );

  // Review 1 (MAJOR), each shape it named:
  // a bare Return.
  assert.equal(countsAsCorrection({ payload: "", ...idle }), false);
  assert.equal(countsAsCorrection({ payload: "   ", ...idle }), false);
  // a permission answer, judged two ways — by the screen, and by the payload
  // itself when the scan had not caught up.
  assert.equal(
    countsAsCorrection({ payload: "some words", answered: true, atPrompt: false }),
    false,
    "a question is in view, or a turn is running: this is an answer, not a correction",
  );
  for (const answer of ["y", "n", "Yes", "NO", "1", "2", "12"]) {
    assert.equal(countsAsCorrection({ payload: answer, ...idle }), false, answer);
  }
  // a slash command.
  for (const command of ["/compact", "/clear", "/model opus"]) {
    assert.equal(countsAsCorrection({ payload: command, ...idle }), false, command);
  }
}

{
  // The state machine, over the data `term.onData` actually delivers.
  const start = { typed: "", answered: true, atPrompt: true };

  // Typing a sentence one keystroke at a time is **one** correction, on the
  // Return — not one per key.
  let state = start;
  let counted = 0;
  for (const ch of "no, use the other path\r") {
    const seen = observeBuilderTyping(state, ch);
    state = seen.state;
    if (seen.correction) counted += 1;
  }
  assert.equal(counted, 1);
  assert.equal(state.typed, "", "the buffer resets on the submission");

  // A bare Return after nothing counts nothing.
  assert.equal(observeBuilderTyping(start, "\r").correction, false);
  // Two submissions in one chunk are two corrections.
  const two = observeBuilderTyping(start, "first line\rsecond line\r");
  assert.equal(two.correction, true);
  // What is typed but not submitted is carried, not counted.
  const partial = observeBuilderTyping(start, "half a sen");
  assert.equal(partial.correction, false);
  assert.equal(partial.state.typed, "half a sen");
  assert.equal(observeBuilderTyping(partial.state, "tence\r").correction, true);
  // A paste whose payload is a slash command is still not a correction.
  assert.equal(
    observeBuilderTyping(start, "\u001b[200~/compact\u001b[201~\r").correction,
    false,
  );
  // A very long paste cannot grow the buffer without bound.
  const long = observeBuilderTyping(start, "x".repeat(20000));
  assert.ok(long.state.typed.length <= 4096);

  // GH #104 walk (B3): the words of the submission that counted travel with
  // it — escape sequences and backspaces applied — and nothing else does.
  const said = observeBuilderTyping(start, "rename it to calcTrip\u007fple\r");
  assert.deepEqual(said.texts, ["rename it to calcTriple"]);
  assert.deepEqual(observeBuilderTyping(start, "/compact\r").texts, []);
  assert.deepEqual(partial.texts, [], "nothing submitted, no words");
  // Several corrections in one chunk: every one is kept, in order.
  assert.deepEqual(two.texts, ["first line", "second line"]);

  // A bracketed paste is one submission, its lines kept together and its
  // markers gone — not one correction per pasted line.
  const pasted = observeBuilderTyping(
    start,
    "\u001b[200~Our convention:\r\nevery function gets a calc prefix\ruse calcTriple\u001b[201~\r",
  );
  assert.deepEqual(pasted.texts, [
    "Our convention:\nevery function gets a calc prefix\nuse calcTriple",
  ]);
  assert.equal(pasted.state.inPaste, false);
  // A paste split across chunks is still one submission.
  const opened = observeBuilderTyping(start, "\u001b[200~line one\r");
  assert.deepEqual(opened.texts, [], "a line break inside the paste submits nothing");
  assert.equal(opened.state.inPaste, true);
  const closed = observeBuilderTyping(opened.state, "line two\u001b[201~\r");
  assert.deepEqual(closed.texts, ["line one\nline two"]);
}

{
  // GH #104 walk (C2): the block's source line, out of the answer's SOURCE.
  assert.equal(
    proposalSourceLine({
      source: "the human's correction: \"every new function in math.js is named with a calc prefix\"",
    }),
    "From your correction: “every new function in math.js is named with a calc prefix”",
  );
  assert.equal(proposalSourceLine({ source: "The human's correction 2: 'use calc'" }), "From your correction: “use calc”");
  assert.equal(proposalSourceLine({ source: "review round 2" }), "From review round 2");
  assert.equal(proposalSourceLine({ source: "Review round 3 (a follow-up)" }), "From review round 3");
  assert.equal(proposalSourceLine({ source: "the Verify failure" }), "From the failed checks");
  assert.equal(proposalSourceLine({ source: "the card's brief" }), "From the card's brief");
  // No SOURCE: the proposal stands, and the block says nothing.
  assert.equal(proposalSourceLine({ source: null }), null);
  assert.equal(proposalSourceLine({}), null);
  assert.equal(proposalSourceLine({ source: "  " }), null);
}

// ── The source contract: Ply's own injections never count ────────────

{
  // `builderStore.inject` / `writePaste` reach `ptyWrite` directly, and the
  // correction counter hangs off `term.onData`. If a future edit routed an
  // injection through the same handler, every verdict Ply sent would read as a
  // human correction and every reviewed card would meet friction.
  const session = readFileSync(
    new URL("../components/BuilderSession.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    session,
    /term\.onData\(\(data\) => \{/,
    "the human's keystrokes still arrive through term.onData",
  );
  assert.match(
    session,
    /observeBuilderTyping\(typing, data\)/,
    "and the correction rule is the thing that judges them",
  );
  assert.match(
    session,
    /for \(const text of seen\.texts\)[\s\S]*?builderNoteCorrection\(workspaceId, cardId, text\)/,
    "GH #104 walk (B3): the words it counted go to the card with the count",
  );
  assert.match(
    session,
    /atPrompt: turnIdle, answered: typing\.answered \|\| turnIdle/,
    "with the screen's own answer to 'is it at its prompt right now?'",
  );
  const store = readFileSync(new URL("../store/builderStore.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    store,
    /countsAsCorrection|observeBuilderTyping/,
    "Plyloft's own injection path must never count a correction",
  );
}

{
  // GH #104 review 1 (MINOR): the pass is not the only thing that changes the
  // proposal. A dismiss, a publish and the staleness drop all make the other two
  // surfaces wrong, so all three announce it.
  const commands = readFileSync(
    new URL("../../src-tauri/src/commands.rs", import.meta.url),
    "utf8",
  );
  assert.match(commands, /fn announce_proposal_change\(/);
  assert.equal(
    (commands.match(/announce_proposal_change\(&app, &workspace_id\)/g) ?? []).length,
    4,
    "the staleness drop (in state and in approve), the dismiss and the publish",
  );
  const proposals = readFileSync(
    new URL("../../src-tauri/src/proposals.rs", import.meta.url),
    "utf8",
  );
  assert.match(proposals, /PROPOSAL_CHANGED_EVENT/, "and the pass emits its own");
}

{
  // GH #104 review 2 (R6): the subscription is at app level, like the Inbox's,
  // because the Ship step and the Inbox row need it whether or not anybody has
  // visited the Library. A per-mode listener is exactly why the Ship line was
  // blank until the Library had been opened once.
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /startProposalSubscriptions\(\);/);
  assert.match(
    app,
    /startInboxSubscriptions\(\);\n(?:.*\n)*?\s*startProposalSubscriptions\(\);/,
    "beside the Inbox's, in the same startup block",
  );
  const store = readFileSync(
    new URL("../store/proposalStore.ts", import.meta.url),
    "utf8",
  );
  assert.match(store, /export function startProposalSubscriptions\(\): void \{/);
  assert.match(store, /onImprovementProposalChanged\(/, "the store owns the listener");
  const host = readFileSync(
    new URL("../components/library/LibraryModeHost.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    host,
    /onImprovementProposalChanged/,
    "and the mode host no longer does",
  );
}


// ── GH #271: the list names its target, and asks only for what it offers ──

{
  const WORDS = {
    repository: "In this repository",
    team: "In the team library",
    ply: "Comes with Plyloft",
    "this-mac": "On this Mac",
  } as const;
  const ply = skillProposal({
    target: { kind: "elsewhere", name: "verify-before-done", scope: "ply" },
    label: "verify-before-done",
    scope: "ply",
    diff: null,
  });
  assert.deepEqual(proposalTarget(ply, WORDS), {
    name: "verify-before-done",
    scope: "Comes with Plyloft",
    key: "ply:verify-before-done",
  });
  assert.equal(proposalIsFor(ply, { page: "skills-list", scope: "repository" }), false);
  assert.equal(proposalIsFor(ply, { page: "skills-list", scope: "ply" }), true);

  // Only a personal skill can be brought into the repository (its Promote);
  // the others say where the change belongs and ask for nothing.
  const personal = skillProposal({
    target: { kind: "elsewhere", name: "deploy", scope: "this-mac" },
    scope: "this-mac",
    diff: null,
  });
  assert.match(proposalNoDiff(personal), /Promote it into this repository/);
  for (const scope of ["ply", "team"] as const) {
    const words = proposalNoDiff(skillProposal({ scope, diff: null }));
    assert.doesNotMatch(words, /Bring a copy|Promote/, `${scope}: nothing to offer, nothing asked`);
  }
}

console.log("proposals.test.ts ok");
