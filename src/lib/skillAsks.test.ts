// 1.175.0 B1 (SEC-1): the words for a skill whose text asks, in every state
// `STRINGS-sharing.md` (B1) names, and the priority when it asks several things.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ASKS_FOOTER,
  ASKS_HEADING,
  ASKS_PUBLISH_FOOTER,
  askItems,
  askingText,
  askingTextHint,
  asksClause,
  asksInstallLede,
  asksLede,
  asksNeedsOkLine,
  asksPublishLede,
  asksSentence,
  asksTitle,
  changedLines,
  linesThatDiffer,
  linkedAsksLine,
  myLibraryNeedsOkLine,
  shareAsksLine,
  sheetIsAboutText,
  strongestOf,
  unreadableWords,
  waitingAsk,
  type SkillAsks,
} from "./skillAsks.ts";
import { approvedDay, linkedNeedsOkLine, needsOkLine } from "./librarySkills.ts";
import { publishedToast } from "./myLibrary.ts";

const none: SkillAsks = { unreadable: null, inline: [], commands: null, writes: null, hooks: null };
const all: SkillAsks = {
  unreadable: null,
  inline: [{ line: 18, command: "git describe --tags --abbrev=0" }],
  commands: { line: 4, tools: ["Bash(git log:*)", "Bash(gh release create:*)"], any: false },
  writes: { line: 4, tools: ["Write", "Edit"], any: false },
  hooks: null,
  strongest: "commands",
};
const OCT3 = Date.UTC(2026, 9, 3, 12);

// ── The widest thing it asks for (1.175.0 Y1) ──
// One rule, in the backend (`skill_asks::Asks::strongest`): its answer comes
// with the text's asks, and nothing here works it out again — a text that
// asks for tools and runs a command at load is "commands" because the backend
// says so, whatever its other fields hold.
assert.equal(strongestOf(all), "commands");
assert.equal(strongestOf({ ...all, strongest: "inline" }), "inline");
assert.equal(strongestOf({ ...all, strongest: undefined }), null, "never derived from the other fields");
assert.equal(strongestOf(none), null);
assert.equal(strongestOf(null), null);
{
  const page = readFileSync(new URL("./skillAsks.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /function sheetKind/, "the sheet has no order of its own");
  assert.match(page, /return asks\?\.strongest \?\? null;/);
}

// The three surfaces say the same thing for each answer: the Library row,
// the Share page's line, the receiver's sheet (title and lede).
{
  // Round 2: the sheet reads the review's own answer (`asks`), worked out
  // by the backend over all its texts — here the first text alone would say
  // something narrower, and is not what is read.
  const review = (asks: SkillAsks["strongest"]) => ({
    files: [{ path: "SKILL.md", kind: "asks", change: "new", asks: { ...all, strongest: "files" } }] as never,
    asks,
    firstTime: true,
    approvedAt: null,
    author: "example-teammate",
  });
  const said = (strongest: NonNullable<SkillAsks["strongest"]>) => [
    asksClause(strongest),
    shareAsksLine(strongest).split(". ")[0],
    asksTitle(review(strongest)),
    asksLede(review(strongest), "the team library", approvedDay).split(". ")[1],
  ];
  assert.deepEqual(said("commands"), [
    "it lets agents run commands without asking you",
    "Its text lets agents run commands without asking",
    "asks to run commands",
    "It brings no script, but its text lets agents run commands on this Mac without asking you",
  ]);
  assert.deepEqual(said("inline"), [
    "it runs a command when it loads",
    "Its text runs a command when the skill loads",
    "runs a command when it loads",
    "It brings no script, but its text runs a command on this Mac when the skill loads",
  ]);
  assert.deepEqual(said("files"), [
    "it lets agents change files without asking you",
    "Its text lets agents change files without asking",
    "asks to change files",
    "It brings no script, but its text lets agents change files on this Mac without asking you",
  ]);
  assert.deepEqual(said("unreadable"), [
    "Plyloft couldn't read what it asks for",
    "Plyloft couldn't read what its text asks for",
    "has a text Plyloft couldn't read",
    "It brings no script, but Plyloft couldn't read what its text asks for",
  ]);
  // The row a review gives, and the sheet's title, read the same field.
  assert.equal(waitingAsk(review("commands")), "commands");
  assert.equal(waitingAsk(review("inline")), "inline");
  // Round 2 (the review's second minor): a review with no answer never
  // falls back to the narrowest wording. It says the most prudent one —
  // "couldn't read" — in the title, the lede and the row alike.
  const bare = review(undefined);
  assert.equal(asksTitle(bare), "has a text Plyloft couldn't read");
  assert.equal(asksLede(bare, "the team library", approvedDay).split(". ")[1], "It brings no script, but Plyloft couldn't read what its text asks for");
  assert.match(asksPublishLede(bare, "staging"), /and Plyloft couldn't read what its text asks for\.$/);
  assert.equal(waitingAsk(bare), "unreadable");
  assert.notEqual(asksTitle(bare), "asks to change files");
}

{
  const other = askItems({ ...none, other: [{ line: 3, key: "mcpServers", known: true }, { line: 5, key: "triggers", known: false }] });
  assert.deepEqual(other.map((i) => i.key), ["other"]);
  assert.equal(other[0].title, "Set up the session in ways Plyloft doesn't check");
  assert.equal(
    other[0].detail,
    "Written at the top of the text, from line 3. Plyloft doesn't know what these let the skill do, so read the text before you say OK.",
  );
  assert.deepEqual(other[0].now, ["mcpServers", "triggers"]);
}

// ── The row in the Library ──
const row = (over: Parameters<typeof needsOkLine>[0]) => needsOkLine(over);
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: false, asks: "commands" }),
  "Needs your OK · it lets agents run commands without asking you. New sessions don't get it until you say OK.",
);
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: false, asks: "files" }),
  "Needs your OK · it lets agents change files without asking you. New sessions don't get it until you say OK.",
);
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: false, asks: "inline" }),
  "Needs your OK · it runs a command when it loads. New sessions don't get it until you say OK.",
);
assert.equal(
  row({ firstTime: false, approvedAt: null, bringsScript: false, asks: "commands" }),
  "Needs your OK · it now lets agents run commands without asking you. New sessions keep the version from before.",
);
assert.equal(
  row({ firstTime: false, approvedAt: OCT3, bringsScript: false, asks: "commands" }),
  "Needs your OK · its text changed. New sessions keep the version you approved on 3 Oct.",
);
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: false, asks: "unreadable" }),
  "Needs your OK · Plyloft couldn't read what it asks for. New sessions don't get it until you say OK.",
);
// A script among what is new keeps the script's words, as before B1.
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: true, asks: "inline" }),
  "Needs your OK · it brings a script. New sessions don't get it until you say OK.",
);
assert.equal(asksNeedsOkLine({ firstTime: true, approvedAt: null, bringsScript: true, asks: "inline" }, approvedDay), null);
// An older backend (no `asks`): the file's words, unchanged.
assert.equal(
  row({ firstTime: true, approvedAt: null, bringsScript: false }),
  "Needs your OK · it brings a file that is not text. New sessions don't get it until you say OK.",
);
assert.equal(
  linkedNeedsOkLine({ bringsScript: false, asks: "commands" }),
  "Needs your OK · the team library's newer copy lets agents run commands without asking you. Update waits until you say OK.",
);
assert.equal(linkedNeedsOkLine({ bringsScript: true, asks: "commands" }), "Needs your OK · the team library's newer copy brings a script. Update waits until you say OK.");
assert.match(linkedAsksLine("inline"), /newer copy runs a command when it loads\./);

// ── My library ──
assert.equal(
  myLibraryNeedsOkLine("commands"),
  "Needs your OK · it lets agents run commands without asking you. New sessions on this Mac get it once you say OK.",
);
assert.equal(myLibraryNeedsOkLine(null), "Needs your OK · it brings a script. New sessions on this Mac get it once you say OK.");
assert.equal(myLibraryNeedsOkLine(undefined), "Needs your OK. New sessions on this Mac get it once you say OK.");
assert.equal(asksSentence("commands"), "It lets agents run commands without asking you");
assert.equal(
  publishedToast({ kind: "published", skill: "release-notes", commit: "c", needsOk: true, asks: "commands" }),
  "release-notes is in My library. It lets agents run commands without asking you, so new sessions on this Mac get it as mine:release-notes once you say OK — Review it on its page.",
);
assert.equal(
  publishedToast({ kind: "published", skill: "pdf-export", commit: "c", needsOk: true }),
  "pdf-export is in My library. It brings a script, so new sessions on this Mac get it as mine:pdf-export once you say OK — Review it on its page.",
);

// ── The Share page ──
assert.equal(
  shareAsksLine("commands"),
  "Its text lets agents run commands without asking. Every other computer asks its person for an OK before its sessions get it; on this Mac, sharing it is your OK.",
);
assert.match(shareAsksLine("files"), /^Its text lets agents change files without asking\. /);
assert.match(shareAsksLine("inline"), /^Its text runs a command when the skill loads\. /);

// ── The sheet ──
const text = (over: object = {}) => ({
  path: "SKILL.md",
  kind: "asks" as const,
  executable: false,
  size: 2150,
  change: "new" as const,
  text: "---\n---\n",
  tooLarge: false,
  copies: [],
  asks: all,
  ...over,
});
const first = { files: [text()], asks: "commands" as const, firstTime: true, approvedAt: null, author: "example-teammate" };
assert.equal(askingText(first)?.path, "SKILL.md");
assert.equal(sheetIsAboutText(first), true);
assert.equal(asksTitle(first), "asks to run commands");
assert.equal(asksTitle({ ...first, asks: "files" }), "asks to change files");
assert.equal(asksTitle({ ...first, asks: "inline" }), "runs a command when it loads");
assert.equal(asksTitle({ ...first, firstTime: false, approvedAt: OCT3 }), "has a changed text");
assert.equal(
  asksLede(first, "the team library", approvedDay),
  "example-teammate added it to the team library. It brings no script, but its text lets agents run commands on this Mac without asking you. New sessions don't get it until you say OK.",
);
assert.equal(
  asksLede({ ...first, firstTime: false, approvedAt: OCT3 }, "the team library", approvedDay),
  "example-teammate changed SKILL.md in the team library. New sessions keep the version you approved on 3 Oct until you say OK.",
);
assert.equal(
  asksLede({ ...first, firstTime: false, author: null }, "My library", approvedDay),
  "Someone changed SKILL.md in My library. Its text now lets agents run commands on this Mac without asking you. New sessions keep the version from before until you say OK.",
);
assert.equal(
  asksPublishLede({ asks: "commands" }, "staging"),
  "Publishing puts it on staging at once, with no card to review it. Everyone who works on this repository gets it, and its text lets their agents run commands without asking them.",
);
assert.match(asksInstallLede(first, "install"), /^Installing puts it in this repository through a card\./);
assert.equal(ASKS_HEADING, "What it asks to be allowed to do");
assert.equal(
  ASKS_FOOTER,
  "A skill that is only text and asks for none of this never asks. A skill delivered with a hooks file or an MCP server is refused, whatever you answer here. Your OK is for this Mac only; if SKILL.md changes, Plyloft asks again.",
);
assert.equal(ASKS_PUBLISH_FOOTER, "Your OK is for this publish only: a later one whose SKILL.md changed asks again.");
assert.equal(
  unreadableWords(3),
  "Plyloft couldn't read the top of SKILL.md (line 3), so it can't tell what this skill asks for. Read the text before you say OK.",
);
// A script among what is new: the sheet keeps the script's words, and still lists what the text asks.
const withScript = { files: [text(), { ...text(), path: "scripts/export.sh", kind: "script" as const, asks: null }], asks: "commands" as const };
assert.equal(sheetIsAboutText(withScript), false);
assert.equal(askingText(withScript)?.path, "SKILL.md");
assert.equal(waitingAsk(withScript), null);
// Y1: the row a review gives says the widest thing, as the sheet's title does.
assert.equal(waitingAsk(first), "commands");
assert.equal(waitingAsk(null), null);

// The list: the command at load first, then commands, then files, then hooks.
const items = askItems(all);
assert.deepEqual(items.map((i) => i.key), ["inline", "commands", "writes"]);
assert.deepEqual(items.map((i) => i.title), [
  "Run a command as soon as the skill loads",
  "Run these commands without asking you",
  "Change files without asking you",
]);
assert.equal(
  items[0].detail,
  "Written in the text, line 18. It runs before the agent reads the rest, and it doesn't show as a command in the session.",
);
assert.equal(
  items[1].detail,
  "From `allowed-tools`, line 4. An agent using this skill runs them with no permission question, whatever you chose for the Builder, and outside the card's copy too.",
);
assert.equal(items[2].detail, "From `allowed-tools`, line 4.");
assert.deepEqual(items[0].now, ["git describe --tags --abbrev=0"]);
assert.deepEqual(items[1].now, ["Bash(git log:*)", "Bash(gh release create:*)"]);
assert.deepEqual(items.map((i) => i.chip), [null, null, null], "no chip on a first version");
// A bare Bash reads "Any command (Bash)"; hooks name their moments.
const anyBash = askItems({ ...none, commands: { line: 3, tools: ["Bash"], any: true }, hooks: { line: 5, moments: ["PreToolUse", "Stop"] } });
assert.deepEqual(anyBash[0].now, ["Any command (Bash)"]);
assert.equal(anyBash[1].title, "Run a command at set moments of a session");
assert.equal(anyBash[1].detail, "From `hooks`, line 5: PreToolUse, Stop.");
// Publish speaks of everyone's agents.
assert.equal(askItems(anyBash[0] ? { ...none, commands: { line: 3, tools: ["Bash"], any: true } } : none, null, true)[0].title, "Run these commands without asking");

// A changed text: how each ask stands against the version approved.
const before: SkillAsks = { ...none, commands: { line: 4, tools: ["Bash(npm run check:*)"], any: false }, writes: { line: 4, tools: ["Edit"], any: false }, inline: [{ line: 9, command: "id" }] };
const now: SkillAsks = { ...none, commands: { line: 4, tools: ["Bash(npm run check:*)", "Bash(curl:*)"], any: false }, writes: { line: 4, tools: ["Edit"], any: false }, hooks: { line: 6, moments: ["Stop"] } };
const changed = askItems(now, before);
assert.deepEqual(
  changed.map((i) => [i.key, i.chip]),
  [
    ["inline", "no longer asked"],
    ["commands", "changed"],
    ["writes", "unchanged"],
    ["hooks", "new"],
  ],
);
assert.deepEqual(changed[1].before, ["Bash(npm run check:*)"]);
assert.deepEqual(changed[1].now, ["Bash(npm run check:*)", "Bash(curl:*)"]);
assert.equal(changed[2].before, null, "the two versions only where they differ");
assert.deepEqual(changed[0].now, []);

// The text's own row.
assert.equal(askingTextHint({ change: "new", text: "a", textBefore: null }, "2.1 KB"), "2.1 KB · new · your OK is for this exact text");
const v1 = "a\nb\nc\nd\ne\nf\n";
const v2 = "a\nB\nc\nD\ne\nf\ng\n";
assert.equal(linesThatDiffer(v1, v2), 3);
assert.equal(linesThatDiffer(v1, v1), 0);
assert.equal(linesThatDiffer("a\r\nb\r\n", "a\nb\n"), 0, "line ends alone are not a difference to read");
assert.deepEqual([...changedLines(v1, v2)], [2, 4, 7]);
assert.equal(
  askingTextHint({ change: "changed", text: v2, textBefore: v1 }, "2.4 KB"),
  "2.4 KB · changed · 3 lines differ from the version you approved",
);
assert.equal(askingTextHint({ change: "changed", text: "a\nx\n", textBefore: "a\nb\n" }, "1 B"), "1 B · changed · 1 line differs from the version you approved");

console.log("skillAsks: ok");
