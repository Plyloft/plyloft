// GH #102 (UX language card 7). Run with Node 22+:
//   node --experimental-strip-types src/lib/uxError.test.ts
//
// Two halves.
//
// **The words.** The three errors the card migrates, built from what the
// backend reported — the refusal of GH #88, a publish the branch refused with
// no pull request possible, and a failed Verify run — plus the one toast that
// may be raised about them. The strings are BOARDS.md §5's, so a drift in the
// sentence is a red test and not a screenshot nobody compares.
//
// **The source contract.** `ux-check` polices classes, not the toast rule
// (PATTERNS.md §9), so the rule that `announceError` is the *only* way to raise
// a toast about one of these is held here: the old call sites are asserted gone
// and no new one may push a toast that carries what needs doing.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asLocalBranchRefused,
  centreRenderError,
  blockFromLocalBranch,
  errorForMachine,
  folderItems,
  localBranchRefusalError,
  narrowRefusalTo,
  placementOf,
  publishRefusedError,
  publishableItems,
  refusalTitlesFor,
  skillsReadError,
  toastLine,
  trashableItems,
  verifyFailedError,
  type LocalBranchRefusal,
  recordUnreadableError,
} from "./uxError.ts";

let passed = 0;
const it = (what: string, run: () => void) => {
  run();
  passed += 1;
  void what;
};

const SKILL = ".claude/skills/deploy/SKILL.md";

function refusal(over: Partial<LocalBranchRefusal> = {}): LocalBranchRefusal {
  return {
    branch: "staging",
    paths: [SKILL],
    items: [{ kind: "skill", name: "deploy", paths: [SKILL], directory: false }],
    output:
      "$ git read-tree -m -u --dry-run 759ae1a 3ec1ef1\n" +
      `error: Untracked working tree file '${SKILL}' would be overwritten by merge.`,
    trashError: null,
    stuckInTrash: [],
    ...over,
  };
}

// ── 1. `Local <branch> can't be updated.` — BOARDS.md §5, verbatim ───────

it("the refusal is the board's sentences, with both ways out", () => {
  const e = localBranchRefusalError(refusal());
  assert.equal(e.title, "Local staging can't be updated.");
  assert.equal(
    e.happened,
    ".claude/skills/deploy/SKILL.md here differs from the one on staging.",
  );
  assert.equal(
    e.untouched,
    "Nothing was changed — not your copy, not the one on staging.",
  );
  assert.equal(
    e.todo,
    "Publish your version, or move the local copy to the Trash and take the one on staging.",
  );
  assert.deepEqual(e.actions, [
    { id: "publish", label: "Publish your version", primary: true },
    { id: "trash", label: "Move the local copy to Trash", danger: true },
  ]);
  assert.ok(e.details?.includes("would be overwritten by merge"), "git's own words");
  // At most two actions, one per way out (BOARDS.md §5).
  assert.ok(e.actions.length <= 2);
  assert.equal(e.actions.filter((a) => a.primary).length, 1, "one primary");
});

it("two differing files read as two, and so does the way out", () => {
  const other = ".claude/skills/audit/SKILL.md";
  const e = localBranchRefusalError(
    refusal({
      paths: [SKILL, other],
      items: [
        { kind: "skill", name: "deploy", paths: [SKILL] },
        { kind: "skill", name: "audit", paths: [other] },
      ],
    }),
  );
  assert.equal(
    e.happened,
    `${SKILL} and ${other} here differ from the ones on staging.`,
  );
  assert.equal(
    e.todo,
    "Publish your versions, or move the local copies to the Trash and take the ones on staging.",
  );
  assert.equal(e.actions[0].label, "Publish your versions");
  assert.equal(e.actions[1].label, "Move the local copies to Trash");
});

it("a long list stays a sentence", () => {
  const paths = ["a.md", "b.md", "c.md", "d.md", "e.md"];
  const e = localBranchRefusalError(refusal({ paths, items: [] }));
  assert.equal(e.happened, "a.md, b.md, c.md and 2 more here differ from the ones on staging.");
});

it("nothing publishable, so only the Trash is offered", () => {
  const e = localBranchRefusalError(
    refusal({
      paths: ["tool.sh"],
      items: [{ kind: "file", name: "tool.sh", paths: ["tool.sh"] }],
    }),
  );
  assert.equal(e.todo, "Move the local copy to the Trash and take the one on staging.");
  assert.deepEqual(e.actions, [
    { id: "trash", label: "Move the local copy to Trash", danger: true },
  ]);
});

it("a Trash that moved nothing says so, and nothing else changes", () => {
  const e = localBranchRefusalError(
    refusal({ trashError: "couldn't move .claude/skills/deploy/SKILL.md to the Trash: denied." }),
  );
  assert.ok(e.happened.startsWith("Plyloft couldn't move anything to the Trash: "), e.happened);
  assert.ok(e.happened.endsWith("here differs from the one on staging."), e.happened);
  assert.equal(
    e.untouched,
    "Nothing was changed — not your copy, not the one on staging.",
    "the refusal's untouched sentence is still true",
  );
  // The way out is still offered: the trash failed, it was not forbidden.
  assert.deepEqual(
    e.actions.map((a) => a.id),
    ["publish", "trash"],
  );
});

// GH #102 review 1: a trash that stopped part way must not be reported as one
// that changed nothing — a copy has left the checkout, and the block says which.
it("a Trash that stopped part way never claims nothing was changed", () => {
  const other = ".claude/skills/audit/SKILL.md";
  const e = localBranchRefusalError(
    refusal({
      paths: [SKILL, other],
      items: [
        { kind: "skill", name: "deploy", paths: [SKILL] },
        { kind: "skill", name: "audit", paths: [other] },
      ],
      trashError: `couldn't move ${other} to the Trash: denied.`,
      stuckInTrash: [SKILL],
    }),
  );
  assert.ok(
    e.happened.startsWith(`Plyloft moved ${SKILL} to the Trash and then stopped: `),
    e.happened,
  );
  assert.doesNotMatch(e.happened, /couldn't move anything/);
  assert.ok(e.untouched.startsWith(`${SKILL} is in the Trash, where you can put it back.`), e.untouched);
  assert.doesNotMatch(e.untouched, /Nothing was changed/, "because something was");
  assert.match(e.untouched, /Nothing else was changed/);
});

// GH #102 review 1: a skill's page speaks about that skill and nothing else.
it("a skill's page narrows the refusal to that skill", () => {
  const other = ".claude/skills/audit/SKILL.md";
  const whole = refusal({
    paths: [SKILL, other, "tool.sh"],
    items: [
      { kind: "skill", name: "deploy", paths: [SKILL] },
      { kind: "skill", name: "audit", paths: [other] },
      { kind: "file", name: "tool.sh", paths: ["tool.sh"] },
    ],
    stuckInTrash: [other],
  });
  const mine = narrowRefusalTo(whole, "deploy");
  assert.ok(mine);
  assert.deepEqual(mine.paths, [SKILL], "only its own paths are pressed and named");
  assert.deepEqual(mine.items.map((i) => i.name), ["deploy"]);
  assert.deepEqual(mine.stuckInTrash, [], "another item's Trash copy is not its news");
  const e = localBranchRefusalError(mine);
  assert.equal(e.happened, `${SKILL} here differs from the one on staging.`);
  assert.equal(e.actions[1].label, "Move the local copy to Trash", "singular again");
  // A name the refusal does not carry has nothing to say.
  assert.equal(narrowRefusalTo(whole, "nowhere"), null);
});

// GH #102 review 2: the Trash has no way to take a folder, so it is never
// offered for one and `What to do` says what does clear it.
it("a folder in the way is not offered to the Trash", () => {
  const only = localBranchRefusalError(
    refusal({
      paths: ["notes"],
      items: [{ kind: "file", name: "notes", paths: ["notes"], directory: true }],
    }),
  );
  assert.deepEqual(only.actions, [], "nothing Plyloft can press");
  assert.equal(
    only.todo,
    "notes is a folder, so Plyloft will not move it to the Trash: move what you want " +
      "to keep out of it yourself, then Sync.",
  );

  // A folder beside a file: the file can still go, and both are said.
  const mixed = refusal({
    paths: [SKILL, "notes"],
    items: [
      { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
      { kind: "file", name: "notes", paths: ["notes"], directory: true },
    ],
  });
  const e = localBranchRefusalError(mixed);
  assert.deepEqual(
    e.actions.map((a) => a.id),
    ["publish", "trash"],
  );
  assert.equal(
    e.actions[1].label,
    "Move the local copy to Trash",
    "singular: only the file is movable",
  );
  assert.ok(
    e.todo.startsWith("Publish your version, or move the local copy to the Trash and take the one on staging."),
    e.todo,
  );
  assert.ok(e.todo.endsWith("then Sync."), e.todo);
  assert.deepEqual(trashableItems(mixed).map((i) => i.name), ["deploy"]);
  assert.deepEqual(folderItems(mixed).map((i) => i.name), ["notes"]);
  // An item from a backend that never sent the flag is not a folder.
  assert.deepEqual(trashableItems(refusal()).map((i) => i.name), ["deploy"]);
  assert.deepEqual(folderItems(refusal()), []);
});

// GH #102 review 2: a failure met over another skill's files is not this
// page's news.
it("a skill's page keeps only a trash failure about its own files", () => {
  const other = ".claude/skills/audit/SKILL.md";
  const whole = refusal({
    paths: [SKILL, other],
    items: [
      { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
      { kind: "skill", name: "audit", paths: [other], directory: false },
    ],
    trashError: "couldn't move it: denied.",
    trashAsked: [other],
  });
  assert.equal(narrowRefusalTo(whole, "audit")!.trashError, "couldn't move it: denied.");
  const mine = narrowRefusalTo(whole, "deploy")!;
  assert.equal(mine.trashError, null, "another skill's failure is not reported here");
  assert.deepEqual(mine.trashAsked, []);
  assert.equal(
    localBranchRefusalError(mine).happened,
    `${SKILL} here differs from the one on staging.`,
  );
  // A failure from before the press was recorded (no `trashAsked`) is kept:
  // dropping it would hide a real one.
  const legacy = narrowRefusalTo(
    refusal({ trashError: "denied.", trashAsked: undefined }),
    "deploy",
  )!;
  assert.equal(legacy.trashError, "denied.");
});

it("only a skill has a publish Plyloft can offer", () => {
  const items = publishableItems(
    refusal({
      paths: [SKILL, "n.md", "tool.sh"],
      items: [
        { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
        { kind: "note", name: "auth-flow", paths: ["n.md"], directory: false },
        { kind: "file", name: "tool.sh", paths: ["tool.sh"], directory: false },
      ],
    }),
  );
  assert.deepEqual(
    items.map((i) => i.name),
    ["deploy"],
  );
});

// ── 2. Which page the block sits on ──────────────────────────────────────

it("the Library for its own paths, Worktrees for anything else", () => {
  assert.equal(placementOf(refusal()), "library");
  assert.equal(
    placementOf(refusal({ paths: [".atelier/library/knowledge/auth-flow.md"] })),
    "library",
  );
  assert.equal(placementOf(refusal({ paths: ["tool.sh"] })), "worktrees");
  assert.equal(
    placementOf(refusal({ paths: ["tool.sh", SKILL] })),
    "library",
    "one Library path is enough: that is where the member met it",
  );
});

// ── 3. The block goes up, and comes down when the branch moves ───────────

it("the refusal puts the block up and is announced once", () => {
  const up = blockFromLocalBranch({
    branch: "staging",
    outcome: {
      kind: "untrackedDiffers",
      behind: 1,
      from: "759ae1a",
      to: "3ec1ef1",
      paths: [SKILL],
      items: [{ kind: "skill", name: "deploy", paths: [SKILL] }],
      output: "error: Untracked working tree file",
      repeated: false,
    },
  });
  assert.ok(up);
  assert.equal(up.announce, true);
  assert.equal(up.refusal.branch, "staging");
  assert.deepEqual(up.refusal.paths, [SKILL]);
  assert.equal(up.refusal.trashError, null);

  const again = blockFromLocalBranch({
    branch: "staging",
    outcome: {
      kind: "untrackedDiffers",
      behind: 1,
      from: "759ae1a",
      to: "3ec1ef1",
      paths: [SKILL],
      repeated: true,
    },
  });
  assert.ok(again, "the block goes up again: the way out must not disappear");
  assert.equal(again.announce, false, "but it is not toasted twice");
  // A backend from before #102: paths and nothing else.
  assert.deepEqual(again.refusal.items, [
    { kind: "file", name: SKILL, paths: [SKILL], directory: false },
  ]);
  assert.equal(again.refusal.output, "");
  assert.deepEqual(publishableItems(again.refusal), [], "and nothing is offered to publish");
});

it("the block clears when the fast-forward succeeds", () => {
  assert.equal(
    blockFromLocalBranch({
      branch: "staging",
      outcome: { kind: "fastForwarded", from: "759ae1a", to: "3ec1ef1", commits: 1 },
    }),
    null,
  );
  // And for every other outcome: the refusal is not what is true any more.
  for (const outcome of [
    { kind: "upToDate" },
    { kind: "dirty", behind: 1 },
    { kind: "diverged", ahead: 1, behind: 1 },
    { kind: "ahead", ahead: 2 },
    { kind: "checkedOutElsewhere", path: "/tmp/w", behind: 1 },
    { kind: "offline", reason: "no network" },
    { kind: "noRemote" },
    { kind: "noLocalBranch" },
    { kind: "failed", reason: "boom" },
  ] as const) {
    assert.equal(
      blockFromLocalBranch({ branch: "staging", outcome }),
      null,
      `${outcome.kind} takes the block down`,
    );
  }
});

// ── 4. The read-only publish refusal ─────────────────────────────────────

it("a refused publish with no pull request possible offers nothing", () => {
  const e = publishRefusedError({
    branch: "staging",
    titles: ["deploy"],
    output: "staging refused the push (403) and the GitHub CLI isn't available",
  });
  assert.equal(e.title, "deploy can't reach staging.");
  assert.equal(
    e.happened,
    "staging refused the push, and no pull request could be opened instead.",
  );
  assert.equal(
    e.untouched,
    "Nothing was changed — not your copy here, not what staging carries.",
  );
  assert.match(e.todo, /^Ask someone who can write to this repository for access\./);
  assert.match(e.todo, /published on the next Sync once it arrives\.$/);
  assert.deepEqual(e.actions, [], "read-only: there is no way out Plyloft can take");
  assert.ok(e.details?.includes("403"));
});

it("with nothing named, and with several", () => {
  assert.equal(
    publishRefusedError({ branch: "main", titles: [], output: "" }).title,
    "Your change can't reach main.",
  );
  const many = publishRefusedError({
    branch: "main",
    titles: ["deploy", "audit"],
    output: "x",
  });
  assert.equal(many.title, "deploy and audit can't reach main.");
  assert.match(many.todo, /versions stay on this Mac and are published/);
});

// ── 5. A failed Verify run ───────────────────────────────────────────────

it("the Verify summary is the shape, and Open full log is not an action", () => {
  const e = verifyFailedError({
    steps: ["cargo-test"],
    reason: "cargo test --workspace --lib failed",
    output: "cargo-test\nassertion failed: left == right",
  });
  assert.equal(e.title, "Your checks didn't pass.");
  assert.equal(e.happened, "cargo-test didn't pass.");
  assert.equal(e.untouched, "The card didn't move and nothing was shipped.");
  assert.equal(
    e.todo,
    "Read what the step reported under Details, fix what it names, then Run the checks again.",
  );
  assert.deepEqual(e.actions, [], "Open full log reads; it lives under Details");
  assert.ok(e.details?.includes("assertion failed"));

  const two = verifyFailedError({ steps: ["cargo-test", "ppvp-sh"], reason: null, output: null });
  assert.equal(two.happened, "cargo-test and ppvp-sh didn't pass.");
  assert.equal(two.details, null);
  // No step carried a name: the run's own words, not an invented sentence.
  assert.equal(
    verifyFailedError({ steps: [], reason: "the runner died", output: null }).happened,
    "the runner died",
  );
});

// ── 6. The one toast ─────────────────────────────────────────────────────

it("the toast says it happened and that nothing changed — nothing else", () => {
  assert.equal(
    toastLine(localBranchRefusalError(refusal())),
    "Local staging can't be updated — nothing was changed.",
  );
  assert.equal(
    toastLine(publishRefusedError({ branch: "main", titles: [], output: "" })),
    "Your change can't reach main — nothing was changed.",
  );
  assert.equal(
    toastLine(verifyFailedError({ steps: ["ppvp-sh"], reason: null, output: null })),
    "Your checks didn't pass — nothing was changed.",
  );
});

// ── 7. The source contract: one way to raise such a toast ────────────────

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const files = walk(src).map((path) => ({
  path: path.slice(src.length + 1).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));
// GH #150: the behavioural tests (`*.test.tsx`, src/test/) quote the app's
// words and props too; they are not the app's source either.
const code = files.filter((f) => !/\.test\.tsx?$/.test(f.path) && !f.path.startsWith("test/"));

/** The files whose text matches `re`, by path. */
const matching = (re: RegExp) =>
  code.filter((f) => re.test(f.text)).map((f) => f.path).sort();

it("announceError is raised from one place, and reaches the page", () => {
  assert.deepEqual(matching(/\bannounceError\(/), [
    "lib/announceError.ts",
    "store/errorBlockStore.ts",
  ]);
  const helper = code.find((f) => f.path === "lib/announceError.ts")!.text;
  // `Show`, and no second affordance: the page carries the rest.
  assert.match(helper, /label: "Show"/);
  assert.match(helper, /toastLine\(error\)/, "the toast's line is the shape's");
  assert.doesNotMatch(helper, /\bbody:/, "a toast about an error carries no body");
  // Only this file may turn an error into a toast (uxError.ts declares it).
  assert.deepEqual(matching(/\btoastLine\(/), [
    "lib/announceError.ts",
    "lib/uxError.ts",
  ]);
  // And `Show` leads to the page that holds the block.
  assert.match(helper, /openLibraryPage\(where\.workspaceId, "skills"\)/);
  assert.match(
    helper,
    /openSettingsSection\("worktrees", \{ workspaceId: where\.workspaceId \}\)/,
  );
});

it("every announce target carries the workspace its block is drawn for", () => {
  // GH #152: `Show` lands on the **active** workspace's block, so a target
  // without a workspace leads to a page that shows nothing until the member
  // switches by hand. Every arm of `ErrorWhere` names one — this is the
  // assertion that fails if a fourth arm is added without it.
  const helper = code.find((f) => f.path === "lib/announceError.ts")!.text;
  // The parse is deliberately flat, not brace-aware: it reads each arm as
  // `| { page: "…"; … }` up to the first `}`. That holds because every arm of
  // `ErrorWhere` is written on one line with no nested object — asserted here, so
  // an arm that grows one fails loudly instead of being silently skipped.
  const armLines = helper.split("\n").filter((line) => /^\s*\|\s*\{/.test(line));
  for (const line of armLines) {
    assert.match(
      line.trim(),
      /^\|\s*\{ page: "[a-z-]+";.*\};?$/,
      "each ErrorWhere arm must open, name its page and close on one line, " +
        `or this flat parse would skip it: ${line.trim()}`,
    );
  }
  const arms = [...helper.matchAll(/\|\s*\{ page: "([a-z-]+)"([^}]*)\}/g)].map(
    ([, page, rest]) => ({ page, rest }),
  );
  assert.equal(arms.length, armLines.length, "every arm line was parsed");
  assert.deepEqual(
    arms.map((a) => a.page).sort(),
    ["card-ship", "library-instructions", "library-skills", "settings-worktrees"],
    "the four places a block can be on (GH #151: a card's Ship step)",
  );
  for (const arm of arms) {
    assert.match(
      arm.rest,
      /workspaceId: string/,
      `${arm.page} must say which workspace's block Show leads to`,
    );
  }
  // And the one producer passes it on both targets it can raise.
  const blocks = code.find((f) => f.path === "store/errorBlockStore.ts")!.text;
  assert.match(blocks, /\{ page: "library-skills", workspaceId \}/);
  assert.match(blocks, /\{ page: "settings-worktrees", workspaceId \}/);
  assert.doesNotMatch(
    blocks,
    /page: "settings-worktrees" \}/,
    "the worktrees target is never raised without its workspace",
  );
});

it("the three migrated cases raise no toast of their own any more", () => {
  const base = code.find((f) => f.path === "lib/worktreeBase.ts")!.text;
  // GH #88's refusal: the case returns nothing at all.
  assert.match(base, /case "untrackedDiffers":\s*\n\s*return null;/);
  assert.doesNotMatch(base, /can't be updated/);
  assert.doesNotMatch(base, /delete the local cop/);

  const library = code.find((f) => f.path === "lib/sharedLibrary.ts")!.text;
  assert.doesNotMatch(
    library,
    /You don’t have write access/,
    "the read-only refusal's toast is a block now",
  );
  assert.match(library, /if \(lib\.refused\) \{\s*\n\s*return toasts;/);

  const verify = code.find((f) => f.path === "components/VerifyPanel.tsx")!.text;
  assert.doesNotMatch(verify, /<strong>Verify failed\.<\/strong>/);
  assert.doesNotMatch(verify, /verify-step-failure/, "the per-step reason box is gone");
  assert.match(verify, /<VerifyFailureBlock/);
  // The card's logs are opened from one place, and it is under a disclosure.
  assert.deepEqual(matching(/"Open full log"/), [
    "components/errors/VerifyStepLogs.tsx",
  ]);
  const failure = code.find((f) => f.path === "components/errors/VerifyFailureBlock.tsx")!.text;
  assert.match(failure, /detailsAction=\{/);
  const logs = code.find((f) => f.path === "components/errors/VerifyStepLogs.tsx")!.text;
  // Review 1: one button per failing step, because Details holds every failing
  // step's output — a single button opened a log that was not the one read.
  assert.match(logs, /steps\.map\(\(step, i\) => \(/);
  assert.match(logs, /onOpenLog\(step\.kind\)/);
  // Review 2: keyed by index and kind, and the label is the run's own step
  // label, not a mechanism spelled inline.
  assert.match(logs, /key=\{`\$\{i\}-\$\{step\.kind\}`\}/);
  assert.match(logs, /Open the log for \$\{step\.kind\}/);
  assert.doesNotMatch(logs, /Open the \$\{step\.kind\} log/);

  // Review 1: a stall and a timeout are not "Verify failed."
  // 1.175.0 B2: neither is a run held for this computer's OK (nothing ran).
  assert.match(
    verify,
    /showFailure =\s*\n?\s*\(status\?\.state\.kind === "failed" && !isChecksHold\(status\.state\)\) \|\| \(status == null && lastEntry\?\.status === "failed"\)/,
  );
  // Review 2: but they still show what the steps reported, and their logs, from
  // the same component — under a closed disclosure, with no "fix what it names".
  assert.match(verify, /status\?\.state\.kind === "timedOut" &&/);
  const stepOutputs = [...verify.matchAll(/<VerifyStepOutput /g)];
  assert.equal(stepOutputs.length, 2, "one for the timeout, one for the stall");
  assert.match(logs, /summary="What the steps reported"/);
  assert.doesNotMatch(logs, /fix what it names/);
  // And one opener builds every surface's log call.
  assert.equal([...verify.matchAll(/verifyRevealLog\(/g)].length, 1);
});

it("the block's sentences live in one place", () => {
  // Nobody writes the refusal's words but the shape.
  assert.deepEqual(matching(/Local \$\{branch\} can't be updated\./), ["lib/uxError.ts"]);
  assert.deepEqual(matching(/\$\{said\} — nothing was changed\./), ["lib/uxError.ts"]);
  // And nobody builds the three parts inside a component: a pure module owns
  // the words, so a drift in one is a red test. Card 7's are this file's; the
  // merge of card #94 (Settings › Repository) brought its own, and they are
  // `publishDraft.ts`'s. `pageError` there is the one place a card-2 problem
  // becomes a `UxError`, because what a way out does belongs to the page that
  // draws the block.
  // GH #103 adds a third: Diagnostics' failed probe, whose words are
  // `diagnostics.ts`'s for the same reason — it is the pure module that page's
  // rows already come from, and `diagnostics.test.ts` covers them.
  // GH #226 adds a fourth: Settings › Team's diverged team clone and what
  // "Reapply mine on top" left to do, whose words are
  // `teamLibraryRecovery.ts`'s (covered by `teamLibraryRecovery.test.ts`).
  // C6 (UX-6.8) adds a fifth: the card page's own presses and the intake,
  // whose words are `cardPage.ts`'s (covered by `cardPage.test.ts`).
  // GH #308 adds a sixth: Code's failed save and Reveal, whose words are
  // `codeErrors.ts`'s (covered by `codeErrors.test.ts`).
  // OB-5 adds a seventh: Setup's AI tools step (offline, an installer that
  // failed, no administrator, no winget), whose words are `aiTools.ts`'s
  // (covered by `aiTools.test.ts`).
  // OB-6 adds an eighth: Setup step 4's install that ended without Git,
  // whose words are `gitStep.ts`'s (covered by `gitStep.test.ts`).
  // OB-7a adds a ninth: Setup step 5's gh install or update that stopped,
  // whose words are `githubStep.ts`'s (covered by `githubStep.test.ts`).
  // OB-10 adds a tenth: Setup step 6's join problems and Create's refusal,
  // whose words are `teamStep.ts`'s (covered by `teamStep.test.ts`).
  // The interactive Claude reviews add an eleventh: Claude's review folder
  // not yet trusted, whose words are `claudeReviewTrust.ts`'s (covered by
  // `claudeReviewTrust.test.ts`).
  // QoL 1.168 block 8 (A5) adds a thirteenth: a raw error in plain words
  // and the pull request card's own, whose words are `plainError.ts`'s
  // (covered by `plainError.test.ts`).
  // QoL 1.168 G1 adds a twelfth: an update that couldn't check, download,
  // install or restart, whose words are `updateWords.ts`'s (covered by
  // `updateWords.test.ts`).
  assert.deepEqual(matching(/^\s+untouched:/m), [
    "lib/aiTools.ts",
    "lib/boardUnread.ts",
    "lib/cardPage.ts",
    "lib/claudeReviewTrust.ts",
    "lib/codeErrors.ts",
    "lib/diagnostics.ts",
    "lib/gitStep.ts",
    "lib/githubStep.ts",
    "lib/plainError.ts",
    "lib/publishDraft.ts",
    "lib/teamLibraryRecovery.ts",
    "lib/teamStep.ts",
    "lib/updateWords.ts",
    "lib/uxError.ts",
  ]);
  const card2 = code.find((f) => f.path === "lib/publishDraft.ts")!.text;
  assert.match(card2, /export function pageError\(/);
  assert.deepEqual(matching(/\bpageError\(/), [
    "components/RepositoryPage.tsx",
    // Areas round 1: the kept-here page's refused save.
    "components/settings/AreasPage.tsx",
    "lib/publishDraft.ts",
  ]);
});

it("the raw output is bounded, and open only where a board says so", () => {
  const block = code.find((f) => f.path === "components/ux/ErrorBlock.tsx")!.text;
  // Review 1: closed by default (PATTERNS.md §4); the caller opens it.
  assert.match(block, /useState\(detailsOpen \?\? false\)/);
  assert.match(block, /<Details\s*\n?\s*open=\{open\}/);
  assert.match(block, /className="ux-error-output"/);
  // Review 2: the scroll happens when the disclosure opens and when the output
  // changes — never from a ref callback, which cannot measure a closed pane and
  // would re-run on any later render.
  assert.match(block, /onToggle=\{\(isOpen\) => \{/);
  assert.match(block, /useEffect\(\(\) => \{\s*\n\s*if \(open\) toEnd\(\);/);
  assert.match(block, /const toEnd = useCallback\(/);
  assert.match(block, /ref=\{output\}/);
  assert.doesNotMatch(block, /ref=\{\(el\)/, "no ref-callback scroll");
  const page = code.find((f) => f.path === "components/ux/Page.tsx")!.text;
  assert.match(page, /onToggle\?: \(open: boolean\) => void;/);
  assert.match(page, /onToggle\(e\.currentTarget\.open\)/);
  const css = readFileSync(join(src, "components/ux/ux.css"), "utf8");
  // GH #103: `.ux-output` shares the rule — Diagnostics' probe output and the
  // shell-integration snippet are the same kind of pane, and one bound is
  // better than two that can drift.
  assert.match(css, /\.ux-error-output,\n\.ux-output \{[^}]*max-height:/);
  assert.match(css, /\.ux-error-output,\n\.ux-output \{[^}]*overflow: auto;/);
  // The refusal's block is the one a board draws open; the card's is not.
  assert.deepEqual(matching(/detailsOpen$/m), ["components/errors/LocalBranchBlock.tsx"]);
  assert.deepEqual(matching(/detailsToEnd$/m), ["components/errors/VerifyFailureBlock.tsx"]);
  // And the CSS the per-step box used is gone with it.
  const app = readFileSync(join(src, "App.css"), "utf8");
  for (const dead of ["verify-step-failure", "verify-step-reason", "verify-step-log"]) {
    assert.doesNotMatch(app, new RegExp(dead), `${dead} is dead CSS`);
  }
});

it("the dense block is drawn on the work surfaces, and only there (GH #150)", () => {
  const block = code.find((f) => f.path === "components/ux/ErrorBlock.tsx")!.text;
  // One modifier, page by default: a page never borrows the card's density.
  assert.match(block, /density\?: "page" \| "dense";/);
  assert.match(block, /density = "page",/);
  assert.match(block, /density === "dense" \? "ux-error ux-error--dense" : "ux-error"/);
  // Which files draw dense. The card's Verify failure always; the Ship step's
  // refusal only on the card, so the same component stays `page` on the
  // Library and Worktrees; the timed-out/stalled disclosure by its class.
  // GH #222: the unpublished release, on the card's Ship step. C6 (UX-6.8):
  // the card page's own errors — a failed press, the intake. GH #308: Code's
  // failed save and Reveal, on the editor (a work surface, 13 px); GH #261:
  // the card's unrenderable audit report. 2026-09-30: a tile that failed to
  // draw, inside the terminal grid (a work surface). Claude's review folder
  // trust step, on the card's Independent AI review, and where a card's
  // improvement proposal line would be when its pass stopped at it.
  assert.deepEqual(matching(/^\s+density="dense"$/m), [
    "components/CardDetailPanel.tsx",
    "components/CardShipStep.tsx",
    "components/EditorPanel.tsx",
    "components/IndependentReview.tsx",
    "components/OutcomeScreen.tsx",
    // QoL 1.168 block 8 (A5): the pull request card's presses and its read.
    "components/PrReviewPanel.tsx",
    "components/TileGrid.tsx",
    "components/errors/UnpublishedReleaseBlock.tsx",
    "components/errors/VerifyFailureBlock.tsx",
  ]);
  assert.deepEqual(matching(/density=\{on === "card-ship" \? "dense" : "page"\}/), [
    "components/errors/LocalBranchBlock.tsx",
  ]);
  assert.deepEqual(matching(/ux-error-details--dense/), ["components/errors/VerifyStepLogs.tsx"]);
  // The page callers pass no density at all.
  for (const page of [
    "components/RepositoryPage.tsx",
    "components/settings/DiagnosticsPage.tsx",
    "components/errors/PublishRefusedBlock.tsx",
  ]) {
    assert.doesNotMatch(code.find((f) => f.path === page)!.text, /density=/, page);
  }
  // The measures are tokens the card already uses; no literal, no new token.
  // The eyebrow reads at the caption step (12 px), not --text-xs (11 px):
  // the re-audit's small-type floor (bd32a1df).
  const css = readFileSync(join(src, "components/ux/ux.css"), "utf8");
  const dense = [...css.matchAll(/^([^{}]*--dense[^{}]*)\{([^}]*)\}/gm)];
  assert.ok(dense.length >= 6, `the modifier's rules (${dense.length})`);
  for (const [, selector, body] of dense) {
    for (const decl of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";").map((d) => d.trim())) {
      if (!decl) continue;
      const value = decl.slice(decl.indexOf(":") + 1).trim();
      // GH #270: Details dropped its box everywhere but here; the dense
      // block's disclosure keeps it — the panel ground and the hairline.
      if (/^(background: var\(--panel-bg\)|border: 1px solid var\(--border\))$/.test(decl)) continue;
      assert.match(
        value,
        /^(0|var\(--(text-md|text-xs|type-caption|inset-x|radius-menu|type-small-lh|page-space-(xs|sm|md))\)( var\(--(inset-x|page-space-(sm|md))\))?)$/,
        `${selector.trim()}: ${decl}`,
      );
    }
  }
  assert.match(css, /\.ux-error--dense \.ux-error-eyebrow\s*\{[^}]*font-size: var\(--type-caption\)/);
  // Bounded output is the page block's own, unchanged.
  assert.doesNotMatch(css, /--dense[^{]*\.ux-error-output/);
});

it("the layer's ErrorBlock takes a UxError and nothing to split", () => {
  const block = code.find((f) => f.path === "components/ux/ErrorBlock.tsx")!.text;
  assert.match(block, /error: UxError;/);
  assert.match(block, /error\.happened/);
  assert.match(block, /error\.untouched/);
  assert.match(block, /error\.todo/);
  assert.match(block, /What happened/);
  assert.match(block, /What was left untouched/);
  assert.match(block, /What to do/);
  assert.match(block, /error\.actions\.slice\(0, 2\)/, "up to two ways out");
  // Every id from useId: every warmed workspace keeps its host mounted.
  assert.match(block, /useId\(\)/);
  assert.doesNotMatch(block, /\.split\(/, "nothing is built from a string");
});

it("the block is drawn on both pages the card names, and nowhere else", () => {
  // GH #103 gave Worktrees a page of its own; the block came with it.
  // UX P-A Windows walk 1: the card page draws the Ship step's same block
  // (on="card-ship") under Now while the Shipping section is closed —
  // 1.175.0 F8: through `CardTroubles` (under Now while it leads, else in
  // the card's Details).
  assert.deepEqual(matching(/<LocalBranchBlock\b/), [
    "components/CardShipStep.tsx",
    "components/CardTroubles.tsx",
    "components/errors/LibraryErrorBlocks.tsx",
    "components/settings/WorktreesPage.tsx",
  ]);
  // GH #151: and on the card's Ship step, for the refusal Ship or Land met.
  const step = code.find((f) => f.path === "components/CardShipStep.tsx")!.text;
  assert.match(
    step,
    /<LocalBranchBlock workspaceId=\{card\.workspaceId\} on="card-ship" cardId=\{card\.id\} \/>/,
  );
  const settings = code.find((f) => f.path === "components/settings/WorktreesPage.tsx")!.text;
  assert.match(settings, /<LocalBranchBlock workspaceId=\{workspaceId\} on="worktrees" \/>/);
  // The Library places it from one line, in each of its two surfaces.
  assert.deepEqual(matching(/<LibraryErrorBlocks\b/), [
    "components/library/SkillDetail.tsx",
    "components/library/SkillsPage.tsx",
  ]);
});

it("the trash goes through the backend, which recomputes the refusal", () => {
  assert.deepEqual(matching(/worktreeTrashUntracked\(/), [
    "components/errors/LocalBranchBlock.tsx",
    "ipc.ts",
  ]);
  const block = code.find((f) => f.path === "components/errors/LocalBranchBlock.tsx")!.text;
  // It asks once, naming the files, and a cancel changes nothing.
  assert.match(block, /<ConfirmDialog/);
  assert.match(block, /refusal\.paths\.join\("\\n"\)/);
  assert.match(block, /onCancel=\{\(\) => setAsking\(false\)\}/);
  // And the outcome of the fast-forward that follows decides the block.
  assert.match(block, /observeLocalBranch\(workspaceId, \{\s*\n?\s*branch: done\.branch,/);
  assert.match(block, /setTrashError\(/, "a failure keeps the block and says so");
  // No press is silent: every outcome of the fast-forward is said, and — review
  // 1 — every one of them leads with what is in the Trash, because the block
  // that named the file is taken down by that same outcome.
  assert.match(block, /\$\{done\.branch\} on this Mac is up to date/);
  assert.match(block, /still can't be updated/);
  // E3: with the ordinary toast's press wired (`pushLocalBranchToast`).
  assert.match(block, /pushLocalBranchToast\(workspaceId, \{ \.\.\.ordinary, body: `\$\{lead\}\$\{ordinary\.body\}` \}\)/);
  const say = block.slice(block.indexOf("function sayWhatHappened"));
  const led = [...say.matchAll(/\$\{(lead|inTrash)\}/g)];
  assert.ok(led.length >= 4, `the Trash sentence leads every outcome's body (${led.length})`);
  assert.match(say, /title: moved \? "Moved to the Trash"/, "and the silent outcomes too");
  // Review 2: "the block on this page names it" only where it still is.
  assert.match(say, /shownHere\s*\n?\s*\? `\$\{lead\}Something else is in the way now/);
  assert.match(say, /named on the Skills page/);
  assert.match(say, /showErrorPage\(\{ page: "library-skills", workspaceId \}\)/);
  assert.match(block, /narrowRefusalTo\(nowWhole, name\) !== null/);
  // A skill's page presses only its own paths.
  assert.match(block, /narrowRefusalTo\(whole, name\)/);
  assert.match(block, /if \(name && scope !== "repository"\) return null;/);
  // Review 2: a folder is never posted — the backend refuses the whole call.
  assert.match(block, /trashableItems\(it\)\.flatMap\(\(item\) => item\.paths\)/);
  // UX P-A (Windows walk 2): on a card's Ship step it names the card, so the
  // backend may recompute the files in that card's merge's way too.
  assert.match(block, /worktreeTrashUntracked\(workspaceId, asked, on === "card-ship" \? cardId : undefined\)/);
  assert.match(block, /if \(asked\.length === 0\) return;/);
  // And a failure that stopped part way carries what is in the Trash.
  assert.match(block, /asTrashRefusal\(cause\)/);
  assert.match(block, /refused\.reason, refused\.stuckInTrash, asked/);
  // The way out reuses the existing publish.
  assert.match(block, /projectSkillPublish\(workspaceId, item\.name\)/);
});

it("the new UX files are in migrated.json", () => {
  const migrated = JSON.parse(
    readFileSync(join(src, "..", "docs/ux-language/migrated.json"), "utf8"),
  ) as { files: string[] };
  for (const path of [
    "src/components/errors/LibraryErrorBlocks.tsx",
    "src/components/errors/LocalBranchBlock.tsx",
    "src/components/errors/PublishRefusedBlock.tsx",
    "src/components/errors/VerifyFailureBlock.tsx",
  ]) {
    assert.ok(migrated.files.includes(path), `${path} is migrated`);
  }
});

it("the store is session-only and keyed by workspace", () => {
  const store = code.find((f) => f.path === "store/errorBlockStore.ts")!.text;
  assert.match(store, /byWorkspace: Record<string, WorkspaceErrorBlocks>/);
  assert.doesNotMatch(
    store,
    /localStorage|sessionStorage|zustand\/middleware|invoke\(/,
    "nothing here is written anywhere: there is no schema to migrate",
  );
  // Selectors return a stored value or null — never a fresh object. Review 1:
  // the old scan needed `((` on one line and was blind to a wrapped call, so
  // it is matched across lines and the count is asserted too.
  const sites: string[] = [];
  for (const f of code) {
    for (const at of f.text.matchAll(/useErrorBlocks\(/g)) {
      // `useErrorBlocks.getState()` has no `(` here, so only selectors match.
      const selector = f.text.slice(at.index, at.index + 240).split(");")[0];
      sites.push(`${f.path}: ${selector.replace(/\s+/g, " ")}`);
    }
  }
  const callers = code.filter((f) => /useErrorBlocks\(/.test(f.text)).length;
  assert.ok(callers >= 2, `every component that reads a block is scanned (${callers})`);
  // GH #151: `LocalBranchBlock` reads two slices (the refusal, and the Ship
  // step it was met on) — two selectors, each a stored value or null, rather
  // than one that would have to build an object from both.
  const perFile = (path: string) => sites.filter((site) => site.startsWith(`${path}: `)).length;
  assert.equal(perFile("components/errors/LocalBranchBlock.tsx"), 2);
  // GH #222 review 3: the unpublished release and the unreadable record, the
  // same way — two stored values, never one built object.
  assert.equal(perFile("components/errors/UnpublishedReleaseBlock.tsx"), 2);
  // 1.170 walk: the live facts read the refused ships and the releases on
  // their way — two sorted string keys.
  assert.equal(perFile("hooks/useCardLive.ts"), 2);
  // 1.174.0 (A4): LocalBranchState.tsx holds two readers of the same slice —
  // the component (Settings) and `useLocalBranchNotice` (the Board's slot) —
  // one selector each.
  assert.equal(perFile("components/errors/LocalBranchState.tsx"), 2);
  assert.equal(
    sites.length,
    callers + 4,
    "one selector per reading component, the three two-slice readers' second ones, and LocalBranchState's second reader",
  );
  for (const site of sites) {
    assert.doesNotMatch(
      site,
      /=> \{|\{ \.\.\./,
      `a selector builds a new object: ${site}`,
    );
    // UX P-A Windows walk 1: `lib/shipRefusal.ts` reads the blocks into a
    // primitive (a boolean, a sorted string key) — stable by value, no object.
    if (/=> (shipRefused(For|Key)|releasingKey)\(s\.byWorkspace\b/.test(site)) continue;
    assert.match(site, /\?\? null/, `a selector must fall back to null: ${site}`);
  }
});

// ── 8. GH #151: Ship and Land's refusal wears the shape ──────────────────

/** What `ship_card` / `card_ship` reject with, as serde writes
 *  `worktrees::ShipError::LocalBranchRefused` (see the Rust tests
 *  `ship_refuses_…` and `land_refuses_…`, which assert these field names). */
function wire(operation: "ship" | "land", over: Record<string, unknown> = {}) {
  return {
    operation,
    localBranch: {
      branch: "staging",
      outcome: {
        kind: "untrackedDiffers",
        behind: 1,
        from: "759ae1a",
        to: "3ec1ef1",
        paths: [SKILL, "notes"],
        items: [
          { kind: "skill", name: "deploy", paths: [SKILL], directory: false },
          { kind: "file", name: "notes", paths: ["notes"], directory: true },
        ],
        output: `error: Untracked working tree file '${SKILL}' would be overwritten by merge.`,
        repeated: false,
        ...over,
      },
    },
  };
}

it("Ship and Land's rejection is read as a value, field by field", () => {
  for (const operation of ["ship", "land"] as const) {
    const got = asLocalBranchRefused(wire(operation));
    assert.ok(got, operation);
    assert.equal(got.branch, "staging");
    assert.deepEqual(got.paths, [SKILL, "notes"]);
    assert.deepEqual(got.items.map((i) => [i.kind, i.name, i.directory]), [
      ["skill", "deploy", false],
      ["file", "notes", true],
    ]);
    assert.ok(got.output.includes("would be overwritten"));
    assert.equal(got.trashError, null);
  }
  // `repeated` is Sync's toast guard; a Ship press is always news, so it does
  // not decide whether this is the refusal.
  assert.ok(asLocalBranchRefused(wire("ship", { repeated: true })));
  // Review 1: `items` that is not a list falls back to the paths, one item each.
  for (const items of ["deploy", { kind: "skill" }, 7, null]) {
    const got = asLocalBranchRefused(wire("ship", { items }));
    assert.ok(got, String(items));
    assert.deepEqual(
      got.items.map((i) => [i.kind, i.name, i.paths]),
      [
        ["file", SKILL, [SKILL]],
        ["file", "notes", ["notes"]],
      ],
    );
  }
  // Everything else a rejection can be is not the refusal.
  for (const other of [
    "ship aborted: staging and origin/staging have diverged (1 ahead, 1 behind).",
    new Error("ship worker failed"),
    null,
    undefined,
    42,
    { reason: "a TrashRefusal", stuckInTrash: [] },
    { operation: "ship" },
    { operation: "publish", localBranch: wire("ship").localBranch },
    { operation: "land", localBranch: { branch: "staging", outcome: { kind: "diverged", ahead: 1, behind: 1 } } },
  ]) {
    assert.equal(asLocalBranchRefused(other), null, String(other));
  }
});

it("(UX P-A Windows walk 2) a merge's refusal is read as the merge's, and worded for the card's copy", () => {
  assert.equal(asLocalBranchRefused(wire("land"))?.atMerge, undefined);
  assert.equal(asLocalBranchRefused({ ...wire("land"), atMerge: "yes" })?.atMerge, undefined);
  const got = asLocalBranchRefused({ ...wire("land"), atMerge: true });
  assert.equal(got?.atMerge, true);
  const error = localBranchRefusalError({ ...got!, paths: [SKILL], items: [got!.items[0]] }, "ship");
  assert.equal(error.title, "Ship stopped: local staging can't be updated.");
  assert.match(error.happened, /would be overwritten by the card's copy, so git didn't merge the card\./);
  assert.doesNotMatch(error.happened, /differs from the one on staging/);
  assert.equal(error.untouched, "Nothing was merged or changed — not your copy, not staging.");
  assert.match(error.todo, /Publish your version, or move the local copy to the Trash and take the card's\. Then ship again\./);
  assert.deepEqual(error.actions.map((a) => a.label), ["Publish your version", "Move the local copy to Trash"]);
});

it("on the Ship step the block says what stopped, and to run it again", () => {
  const ship = localBranchRefusalError(refusal(), "ship");
  assert.equal(ship.title, "Ship stopped: local staging can't be updated.");
  assert.equal(ship.happened, localBranchRefusalError(refusal()).happened, "the condition's words");
  assert.equal(
    ship.untouched,
    "Nothing was merged or changed — not your copy, not the one on staging.",
  );
  assert.equal(
    ship.todo,
    "Publish your version, or move the local copy to the Trash and take the one on staging. Then ship again.",
  );
  // Both ways out, exactly as on Sync's page.
  assert.deepEqual(ship.actions, localBranchRefusalError(refusal()).actions);
  assert.equal(
    toastLine(ship),
    "Ship stopped: local staging can't be updated — nothing was changed.",
  );
  const merge = localBranchRefusalError(refusal(), "merge");
  assert.equal(merge.title, "Merge stopped: local staging can't be updated.");
  assert.ok(merge.todo.endsWith(" Then merge again."), merge.todo);
  // A folder names its own "then … again", and it is not said twice.
  const folder = localBranchRefusalError(
    refusal({
      paths: ["notes"],
      items: [{ kind: "file", name: "notes", paths: ["notes"], directory: true }],
    }),
    "ship",
  );
  assert.ok(folder.todo.endsWith("yourself, then ship again."), folder.todo);
  assert.equal(folder.todo.match(/again/g)?.length, 1, folder.todo);
  assert.deepEqual(folder.actions, [], "no Trash for a folder, on the Ship step either");
  // Sync's own words are unchanged.
  assert.equal(localBranchRefusalError(refusal()).title, "Local staging can't be updated.");
});

it("no raw UntrackedDiffers sentence reaches a toast (GH #151)", () => {
  const rust = join(src, "..", "src-tauri", "src");
  const shared = readFileSync(join(rust, "shared_config.rs"), "utf8");
  const release = shared.slice(shared.indexOf("pub fn sync_before_release("));
  // Ship: a value, never the old sentence.
  // GH #183: `Ok` carries whether the fast-forward reached origin's tip.
  assert.match(release, /-> Result<bool, crate::worktrees::ShipError>/);
  assert.match(
    release,
    /Sync::UntrackedDiffers \{ \.\. \} => \{\s*\n\s*return Err\(ShipError::local_branch_refused\(\s*\n\s*RefusedOperation::Ship,/,
  );
  assert.doesNotMatch(shared, /Publish or delete the local copies/);
  // Land: the same value, and never the `{outcome:?}` debug string.
  const commands = readFileSync(join(rust, "commands.rs"), "utf8");
  const gate = commands.slice(commands.indexOf("pub(crate) fn land_sync_gate("));
  const gateBody = gate.slice(0, gate.indexOf("\n}\n"));
  assert.match(
    gateBody,
    /outcome @ Sync::UntrackedDiffers \{ \.\. \} => \{\s*\n\s*Err\(crate::worktrees::ShipError::local_branch_refused\(\s*\n\s*crate::worktrees::RefusedOperation::Land,/,
  );
  assert.doesNotMatch(gateBody, /Sync::Dirty \{ \.\. \} \| Sync::UntrackedDiffers/);
  assert.match(commands, /land_sync_gate\(&fast_forward, &ws_cwd, &target_branch\)\?;/);
  // Every command that can meet it says so in its type.
  for (const command of [
    "pub async fn card_ship(",
    "pub async fn card_ship_with_follow_up(",
    "pub async fn card_review_merge(",
    "pub async fn ship_card(",
    "pub async fn ship_batch(",
    "pub async fn release_area(",
  ]) {
    const at = commands.indexOf(command);
    assert.ok(at >= 0, command);
    const head = commands.slice(at, commands.indexOf("{\n", at));
    assert.match(head, /crate::worktrees::ShipError>/, command);
  }

  // The window: every call site of those commands asks `observeShipAttempt`
  // first, and only a rejection that is not the refusal becomes `String(e)`.
  assert.deepEqual(
    matching(/\b(cardShip|cardShipWithFollowUp|cardReviewMerge|shipBatch|performShip|releaseTheArea)\(/)
      .filter((path) => path !== "ipc.ts" && path !== "store/shipStore.ts"),
    [
      "components/CardReviewPanel.tsx",
      "components/OutcomeScreen.tsx",
      // 1.174.0 (DR3): the one Release sheet (it replaced ReleaseFlow and
      // ShipBatchModal).
      "components/ReleaseSheet.tsx",
    ],
  );
  for (const path of [
    "components/CardReviewPanel.tsx",
    "components/OutcomeScreen.tsx",
    "components/ReleaseSheet.tsx",
  ]) {
    const text = code.find((f) => f.path === path)!.text;
    const catches = [...text.matchAll(/\} catch \(e(?:: unknown)?\) \{/g)];
    let guarded = 0;
    for (const at of catches) {
      // The catch block: up to the next `} catch` / `} finally`.
      const rest = text.slice(at.index + 1);
      const ends = [rest.indexOf("} catch"), rest.indexOf("} finally")].filter((i) => i >= 0);
      const body = rest.slice(0, ends.length ? Math.min(...ends) : 900);
      const asks = body.search(/observeShipAttempt\([^)]*\{ refused: e \}\)/);
      const says = body.search(/String\(e\)/);
      if (asks < 0) continue;
      guarded += 1;
      assert.ok(says < 0 || asks < says, `${path}: the refusal is asked about before String(e)`);
    }
    assert.ok(guarded >= 1, `${path} routes its Ship/Land rejection through observeShipAttempt`);
  }
  // The only reader of the value is the pure decoder, and it reads fields.
  assert.deepEqual(matching(/\basLocalBranchRefused\(/), [
    "lib/uxError.ts",
    "store/errorBlockStore.ts",
  ]);
  // `Show` opens the card on its Ship step.
  const helper = code.find((f) => f.path === "lib/announceError.ts")!.text;
  assert.match(helper, /case "card-ship":\s*\n\s*openCardStep\(where\.workspaceId, where\.cardId, "ship"\);/);
  const blocks = code.find((f) => f.path === "store/errorBlockStore.ts")!.text;
  assert.match(blocks, /\{ page: "card-ship", workspaceId, cardId: cardIds\[0\] \}/);
});

it("the block names the machine as the platform does; Details stay raw", () => {
  const error = {
    title: "This Mac has no team key naming a team repo.",
    happened: "The team repo is not cloned on this Mac yet.",
    untouched: "Nothing on this Mac changed.",
    todo: "Open Settings → Team and refresh.",
    actions: [{ id: "keep", label: "Keep on this Mac" }],
    details: "No Reviewer was available on this Mac.",
  };
  assert.deepEqual(errorForMachine(error, "mac"), error, "the Mac's words as written");
  const pc = errorForMachine(error, "windows");
  assert.equal(pc.title, "This PC has no team key naming a team repo.");
  assert.equal(pc.happened, "The team repo is not cloned on this PC yet.");
  assert.equal(pc.untouched, "Nothing on this PC changed.");
  assert.equal(pc.actions[0].label, "Keep on this PC");
  assert.equal(pc.details, "No Reviewer was available on this Mac.", "raw output as it came");
  assert.equal(errorForMachine({ ...error, details: null }, "windows").details, null);
});

// The Skills page's first read failed: the page has nothing to list, so its
// block says so and offers the read again, with the tool's words in Details.
it("a Skills page whose read failed offers Try again", () => {
  const block = skillsReadError("git: not a repository");
  assert.match(block.title, /couldn't read this repository's skills/);
  assert.match(block.untouched, /^Nothing was changed/);
  assert.deepEqual(block.actions, [{ id: "try-again", label: "Try again", primary: true }]);
  assert.equal(block.details, "git: not a repository");
});

// A skill's page claims its publish, its removal, its Make available to both
// and its Align — and not a bulk change, nor another skill whose name it starts.
it("a refusal's titles narrow to one skill's changes", () => {
  const titles = [
    "deploy",
    "deploy for Claude and Codex",
    "deploy aligned for Claude and Codex",
    "deploy-prod",
    "3 skills for Claude and Codex",
  ];
  assert.deepEqual(refusalTitlesFor(titles, "deploy"), titles.slice(0, 3));
  assert.deepEqual(refusalTitlesFor(titles, "3"), []);
  assert.deepEqual(refusalTitlesFor(titles, "lint"), []);
});


it("a view that failed to draw says only what is true about what went with it", () => {
  // Board, the card, Inbox, Activity, Library: nothing else is lost.
  const view = centreRenderError("The Board", "x", null);
  assert.match(view.untouched, /running sessions are as they were/);
  // Terminals and a tile close their terminals; Code loses its editor.
  for (const reach of ["terminals", "tile", "code"] as const) {
    const e = centreRenderError(reach === "tile" ? "claude 1" : "Terminals", "x", null, reach);
    assert.doesNotMatch(e.untouched, /running sessions are as they were/);
    assert.equal(e.actions[0].label, "Try again");
  }
  assert.match(centreRenderError("Terminals", "x", null, "terminals").untouched, /terminals were closed; a Claude or Codex conversation can be resumed/);
  assert.match(centreRenderError("Terminals", "x", null, "terminals").todo, /start fresh terminals/);
  assert.match(centreRenderError("Code", "x", null, "code").todo, /reopen the editor with your files/);
  const tile = centreRenderError("claude 1", "x", null, "tile");
  assert.equal(tile.title, "claude 1 could not be shown.");
  assert.deepEqual(tile.actions.map((a) => a.id), ["retry", "close"]);
});

// 1.171.0 A3 (LG-13): no "Land" — there is no Land press.
it("an unreadable release record pauses shipping, said without Land", () => {
  const e = recordUnreadableError("bad json");
  assert.equal(e.toast, "Shipping is paused in this project: Plyloft's release record can't be read.");
  assert.doesNotMatch(`${e.happened} ${e.toast}`, /\bLand\b/);
});

console.log(`uxError.test.ts: ${passed} groups passed`);
