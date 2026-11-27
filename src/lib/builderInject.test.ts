// Runs standalone: node --experimental-strip-types src/lib/builderInject.test.ts
import {
  composerSafe,
  pasteBodyBytes,
  pasteBytes,
  pasteText,
  submitsSeparately,
  writePasteThenSubmit,
  PASTE_START,
  PASTE_END,
  PASTE_SETTLE_CEILING_MS,
  PASTE_SETTLE_MAX_MS,
  PASTE_SETTLE_POLL_MS,
  pasteSettleMaxMs,
  PASTE_SETTLE_QUIET_MS,
  isTerminalReport,
  typedEnter,
  SUBMIT_CONFIRM_MS,
  SUBMIT_CONFIRM_MAX_MS,
  SUBMIT_RETRIES,
  isCursorReport,
  plainForKeys,
  OVERLAY_TOOK_PASTE,
  OVERLAY_ALREADY_OPEN,
  withoutCodexOverlay,
  codexScreenHelp,
  PASTE_STILL_UNSENT,
} from "./builderInject.ts";
import { codexComposerHoldsPaste, codexOverlayOpen } from "./attention.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed++;
    console.error("FAIL", name);
  }
}

const msg = "[Plyloft] line one\nline two";
const framed = pasteText(msg);
check("starts with bracketed-paste open", framed.startsWith(PASTE_START));
check("ends with close + CR", framed.endsWith(PASTE_END + "\r"));
check("body is verbatim, newlines kept", framed.includes(msg));
check("no CR inside the body", !framed.slice(PASTE_START.length, -(PASTE_END.length + 1)).includes("\r"));
const bytes = pasteBytes("é");
check("utf-8 encoded", bytes.length === PASTE_START.length + 2 + PASTE_END.length + 1);

// 2026-10-15: a leading `!` runs a shell command in Claude's (and Codex's)
// composer and a leading `/` opens the slash menu, so Plyloft's text never
// starts with either.
check("composerSafe: ! gets one leading space", composerSafe("!touch x") === " !touch x");
check("composerSafe: / gets one leading space", composerSafe("/clear") === " /clear");
check("composerSafe: !! gets one space only", composerSafe("!!x") === " !!x");
check("composerSafe: ordinary text unchanged", composerSafe("[Plyloft] hi") === "[Plyloft] hi");
check("composerSafe: empty unchanged", composerSafe("") === "");
check("composerSafe: looks past a leading space, trims nothing", composerSafe(" !x") === "  !x");
check("composerSafe: looks past a leading tab", composerSafe("\t/x") === " \t/x");
check("composerSafe: looks past a leading newline", composerSafe("\n!x") === " \n!x");
check("composerSafe: whitespace alone unchanged", composerSafe(" \n") === " \n");
check("composerSafe: ! later in the text unchanged", composerSafe("run !x\n!y") === "run !x\n!y");
check("pasteText guards the body", pasteText("!rm x") === `${PASTE_START} !rm x${PASTE_END}\r`);
check("pasteBytes guards the body", new TextDecoder().decode(pasteBytes("/model")) === `${PASTE_START} /model${PASTE_END}\r`);
check(
  "pasteBodyBytes guards the body",
  new TextDecoder().decode(pasteBodyBytes("!x")) === `${PASTE_START} !x${PASTE_END}`,
);


// Windows port: only Codex on Windows gets its Enter as a separate write.
check("codex on windows submits separately", submitsSeparately("codex", true));
check("claude on windows keeps the inline CR", !submitsSeparately("claude", true));
check("codex on the mac keeps the inline CR", !submitsSeparately("codex", false));
check("no session keeps the inline CR", !submitsSeparately(undefined, true));
const body = new TextDecoder().decode(pasteBodyBytes(msg));
check("the paste alone carries no Enter", body === `${PASTE_START}${msg}${PASTE_END}`);
check("the Mac's bytes are unchanged", pasteText(msg) === `${PASTE_START}${msg}${PASTE_END}\r`);

/** A simulated session: output at these ms offsets after the paste. */
async function simulate(
  outputSpans: Array<[number, number]>,
  lastOutputThrows = false,
  text: string = msg,
) {
  let clock = 0;
  const writes: Array<{ at: number; text: string }> = [];
  const result = await writePasteThenSubmit(text, {
    write: async (bytes) => {
      writes.push({ at: clock, text: new TextDecoder().decode(bytes) });
    },
    lastOutputAt: async () => {
      if (lastOutputThrows) throw new Error("backend gone");
      let last: number | null = null;
      for (const [from, to] of outputSpans) {
        if (from <= clock) last = Math.min(to, clock);
      }
      return last;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { result, writes };
}

// The output codex-cli 0.157.0 printed after Ply's 2.9 KB self-check paste
// under ConPTY, in ms after the write: the keys read one by one (a redraw
// every ~1 ms), ~80 ms of nothing, then the `[Pasted Content 2882 chars]`
// placeholder. An Enter at 50 ms stayed in the paste; one after 400 ms of
// quiet submitted it.
const measured: Array<[number, number]> = [
  [18, 1575],
  [1658, 1675],
];
{
  const { result, writes } = await simulate(measured);
  check("settles on the measured output", result === "settled");
  check("two writes: the paste, then the Enter", writes.length === 2 && writes[1].text === "\r");
  check("the paste goes first, without its Enter", writes[0].at === 0 && !writes[0].text.endsWith("\r"));
  check(
    "the Enter waits for the placeholder and the quiet after it",
    writes[1].at >= 1675 + PASTE_SETTLE_QUIET_MS &&
      writes[1].at <= 1675 + PASTE_SETTLE_QUIET_MS + PASTE_SETTLE_POLL_MS,
  );
}
{
  // Never mid-burst: the ~80 ms gap before the placeholder is not quiet.
  const { writes } = await simulate(measured);
  check("no Enter inside the burst", writes[1].at > 1675);
  // Codex ignores an Enter that far from the burst's end only once it has
  // drawn its placeholder; the quiet must outlast the gap before it.
  check("the quiet outlasts the measured gap", PASTE_SETTLE_QUIET_MS >= 2 * (1658 - 1575));
}
{
  const { result, writes } = await simulate([[0, 10 ** 9]]);
  check("a session that keeps printing is submitted at the cap", result === "capped");
  check("capped at the maximum", writes[1].at === PASTE_SETTLE_MAX_MS && writes[1].text === "\r");
}
{
  const { result, writes } = await simulate([], true);
  check("an unknown last output still submits", result === "settled" && writes[1].text === "\r");
  check("...after the quiet from the paste itself", writes[1].at >= PASTE_SETTLE_QUIET_MS);
}

// The cap scales with the paste: ConPTY replays it as keys at ~0.5–1 ms
// each, so a fixed 30 s sent a long paste's Enter in the middle of its burst.
check("a short paste keeps the 30 s cap", pasteSettleMaxMs(msg) === PASTE_SETTLE_MAX_MS);
check("15 000 characters keep the 30 s cap", pasteSettleMaxMs("x".repeat(15_000)) === 30_000);
check("60 000 characters get 2 ms each", pasteSettleMaxMs("x".repeat(60_000)) === 120_000);
check(
  "the cap outlasts the slowest measured replay",
  pasteSettleMaxMs("x".repeat(100_000)) >= 100_000 * 1,
);
check(
  "never past the ceiling",
  pasteSettleMaxMs("x".repeat(10_000_000)) === PASTE_SETTLE_CEILING_MS,
);
{
  // 60 000 characters replayed at 1 ms each: the burst is still printing at
  // 30 s, and the Enter waits for it to end.
  const long = "x".repeat(60_000);
  const { result, writes } = await simulate([[18, 60_018]], false, long);
  check("a long paste is not capped mid-burst", result === "settled");
  check("its Enter comes after the burst", writes[1].at >= 60_018 + PASTE_SETTLE_QUIET_MS);
}
{
  const long = "x".repeat(60_000);
  const { result, writes } = await simulate([[0, 10 ** 9]], false, long);
  check("a long paste that never goes quiet is capped at its own cap", result === "capped");
  check("...at 2 ms a character", writes[1].at === 120_000);
}

// ── 1.170.0 F1: the Enter is confirmed ─────────────────────────────────
//
// Windows walk 2026-10-26, first card: the self-check sat in Codex's
// composer as `› [Pasted Content 3210 chars]` for 3 minutes. Codex had just
// ended its turn and did not read the keys at once; the old rule counted
// the quiet from the paste itself, so the Enter went 500 ms after the
// write — behind keys Codex had not read yet, inside the burst.

/** A session that reads the paste late: output only from `readAt` on. */
async function simulateF1(opts: {
  spans: Array<[number, number]>;
  /** The composer on screen, by the number of Enters written so far and the
   *  time: true while it holds the paste. */
  holds?: (enters: number, at: number) => boolean | null;
  text?: string;
}) {
  let clock = 0;
  const writes: Array<{ at: number; text: string }> = [];
  const resent: number[] = [];
  const enters = () => writes.filter((w) => w.text === "\r").length;
  const result = await writePasteThenSubmit(opts.text ?? msg, {
    write: async (bytes) => {
      writes.push({ at: clock, text: new TextDecoder().decode(bytes) });
    },
    // The session printed before the paste (its last turn), at -5 s.
    lastOutputAt: async () => {
      let last: number | null = -5_000;
      for (const [from, to] of opts.spans) {
        if (from <= clock) last = Math.min(to, clock);
      }
      return last;
    },
    composerHoldsPaste: opts.holds ? () => opts.holds!(enters(), clock) : undefined,
    resubmitted: (n) => resent.push(n),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { result, writes, resent, enters: enters() };
}
{
  // Codex reads the keys 1.2 s late (busy), redraws until 2.8 s, then the
  // placeholder. The Enter waits for that output and its quiet.
  const { writes } = await simulateF1({ spans: [[1_200, 2_800]] });
  check("F1: no Enter before Codex read the paste", writes[1].at >= 2_800 + PASTE_SETTLE_QUIET_MS);
  check("F1: one Enter", writes.filter((w) => w.text === "\r").length === 1);
}
{
  // Taken at once: the composer is empty after the first Enter.
  const r = await simulateF1({ spans: [[18, 1_675]], holds: (n) => n < 1 });
  check("F1: taken — no second Enter", r.enters === 1 && r.resent.length === 0);
}
{
  // The first Enter was lost: the composer still holds the paste at the
  // confirmation; one more Enter, then it is taken.
  const r = await simulateF1({ spans: [[18, 1_675]], holds: (n) => n < 2 });
  check("F1: lost — the Enter goes again once", r.enters === 2 && r.resent.join() === "1");
  const [first, second] = r.writes.filter((w) => w.text === "\r");
  check("F1: ...after the confirmation wait", second.at - first.at >= SUBMIT_CONFIRM_MS);
  check("F1: only Enters after the paste", r.writes.slice(1).every((w) => w.text === "\r"));
}
{
  // Never taken: at most SUBMIT_RETRIES more Enters, nothing else — and
  // (E2) the write rejects: the message is still in the composer, unsent.
  let error: unknown = null;
  let enters = 0;
  let clock = 0;
  await writePasteThenSubmit(msg, {
    write: async (bytes) => {
      if (new TextDecoder().decode(bytes) === "\r") enters += 1;
    },
    lastOutputAt: async () => (clock < 1_675 ? clock : 1_675),
    composerHoldsPaste: () => true,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  }).catch((e) => {
    error = e;
  });
  check("F1: capped retries", enters === 1 + SUBMIT_RETRIES);
  check("E2: still held after every Enter — rejects", error instanceof Error && error.message === PASTE_STILL_UNSENT);
}
{
  // No live screen: never sent again on a guess.
  const r = await simulateF1({ spans: [[18, 1_675]], holds: () => null });
  check("F1: unknown screen — one Enter", r.enters === 1);
}
{
  // A turn printing after the Enter is never quiet, and the screen still
  // shows the paste: no second Enter, and the confirmation ends by its own
  // limit.
  const r = await simulateF1({ spans: [[18, 1_675], [2_200, 10 ** 9]], holds: () => true });
  check("F1: a noisy held screen gets no second Enter", r.enters === 1);
  check("F1: the confirmation ends", r.writes.length === 2);
  check("F1: ...within its limit", SUBMIT_CONFIRM_MAX_MS <= 10_000);
}
{
  // Challenger MAJOR 1: the Enter was taken and the turn runs (output never
  // quiet; the screen shows it working, so not held). The confirmation ends
  // at SUBMIT_CONFIRM_MS, not at SUBMIT_CONFIRM_MAX_MS: the person's typing
  // held meanwhile goes then.
  let clock = 0;
  let enterAt = -1;
  let doneAt = -1;
  let looks = 0;
  const writes: string[] = [];
  await writePasteThenSubmit(msg, {
    write: async (bytes) => {
      const t = new TextDecoder().decode(bytes);
      writes.push(t);
      if (t === "\r") enterAt = clock;
    },
    lastOutputAt: async () => clock - 10,
    composerHoldsPaste: () => {
      looks += 1;
      return false;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  doneAt = clock;
  check("F1: a running turn — one Enter", writes.filter((w) => w === "\r").length === 1);
  check("F1: ...resolves at the confirmation wait", doneAt - enterAt >= SUBMIT_CONFIRM_MS && doneAt - enterAt < SUBMIT_CONFIRM_MS + 2 * PASTE_SETTLE_POLL_MS);
  check("F1: ...on the first look after it", looks === 2);
}

// The screens behind the confirmation (codex-cli 0.157.0 under ConPTY,
// Windows 11 VM; rows as `translateToString(true)` reads them).
const MESSAGE = "You are the Builder for the Plyloft card \"Add a triple function\". You are working in this copy.";
const FOOTER = "  GPT-6-Astra default · C:\\Users\\MATTEO~1\\AppData\\Local\\Temp\\ply-tui-91e48f69";
const unsent = [
  "› You are the Builder for the Plyloft card \"Add a triple function\". You are working in thi…",
  "  commit.",
  "",
  "• Done: added triple(n) and its test; npm.cmd test passed all 3 tests.",
  "",
  "  Worked for 37s • 20:35",
  "",
  "› [Pasted Content 3210 chars]",
  "",
  FOOTER,
  "",
].join("\n");
check("F1 screen: the walk's stuck paste is held", codexComposerHoldsPaste(unsent, MESSAGE));
// Challenger MINOR 3: the placeholder as other Codex versions draw it, on
// the walk's captured screen.
for (const placeholder of ["[Pasted Content 3,210 chars]", "[Pasted text #1 +40 lines]", "[Pasted Content 3210 characters]"]) {
  const other = unsent.replace("[Pasted Content 3210 chars]", placeholder);
  check(`F1 screen: ${placeholder} is held`, codexComposerHoldsPaste(other, MESSAGE));
}
check(
  "F1 screen: a draft saying [Pasted] with no number is not",
  !codexComposerHoldsPaste(unsent.replace("[Pasted Content 3210 chars]", "see [Pasted] above"), MESSAGE),
);
const taken = [
  "› [Pasted Content 3210 chars]",
  "",
  "• Working (2s • esc to interrupt)",
  "",
  "› Ask Codex to do anything",
  "",
  FOOTER,
].join("\n");
check("F1 screen: submitted and working — not held", !codexComposerHoldsPaste(taken, MESSAGE));
const answered = [
  "› [Pasted Content 3210 chars]",
  "",
  "• Self-check complete: 9 classes (ply-t3st01)",
  "",
  "  Worked for 1m 2s · 11:00",
  "",
  "› Ask Codex to do anything",
  "",
  FOOTER,
  "  ? for shortcuts",
].join("\n");
check("F1 screen: a past prompt above an empty composer — not held", !codexComposerHoldsPaste(answered, MESSAGE));
const asking = [
  "  Would you like to run the following command?",
  "",
  "  $ npm.cmd test",
  "",
  "› 1. Yes, proceed (y)",
  "  2. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");
check("F1 screen: a question in view — never held", !codexComposerHoldsPaste(asking, MESSAGE));
const short = ["• Done.", "", "› [Plyloft] Write the file .plyloft/pr-draft.md", "", FOOTER].join("\n");
check("F1 screen: a short paste drawn as text is held", codexComposerHoldsPaste(short, "[Plyloft] Write the file .plyloft/pr-draft.md now"));
check("F1 screen: someone else's draft is not", !codexComposerHoldsPaste(short, MESSAGE));

// 1.170 walk fix (Windows re-walk 2026-10-27, step 2, shots/a1-session.png):
// the first Finish and check of a Builder that had been stopped. Codex drew
// the 3 000-character self-check as text, not as `[Pasted …]`; its composer
// is scrolled to the cursor, so the chevron row holds a blank line from the
// middle of the message, and the Enter it took inside the paste is the
// empty row under the last line. The composer is 16 rows tall: the old
// check saw no chevron in its 12 rows.
const SELF_CHECK = [
  "[Plyloft] Finish and check — self-check first. Before Verify and the Reviewer see this change, go over your own change on this branch (committed and uncommitted) against the risk checklist below: the same classes, in the same order, that the Reviewer's review will walk.",
  "",
  "Risk checklist:",
  "A. Requirements — everything under Expected and Tests in the brief is actually done.",
  "I. User-facing text and states — wrong or misleading copy, a state with no way out.",
  "",
  "For each class, look for a defect of that kind in what you wrote and open the surrounding code when the diff alone does not tell you. Fix what you find and run the tests again. You need not commit: Plyloft's snapshot commits the worktree as it is. Do not start other work.",
  "",
  "Tests (class H): this project has tests, or the brief asks for them — fix a test that would pass with the feature broken, and add the missing cases for the risky paths to the project's existing tests, in the places and style they already use.",
  "",
  "Then answer with one line per class, A to I: `A. Requirements — checked, nothing` or what you found and fixed. End your answer with this line, the number filled in:",
  "Self-check complete: <number of classes> classes (ply-76hd92)",
  "Then stop and wait: Plyloft takes the snapshot, runs Verify and starts the Reviewer by itself once it sees that line and you are back at your prompt.",
].join("\n");
const WALK_FOOTER = "  GPT-6.1-Sol default · C:\\ply-test\\sandboxes\\n170\\.plyloft-worktrees\\card-mvq3b9mr-0";
const composerRows = [
  "  For each class, look for a defect of that kind in what you wrote and open the surrounding",
  "  code when the diff alone does not tell you. Fix what you find and run the tests again.",
  "  You need not commit: Plyloft's snapshot commits the worktree as it is. Do not start other",
  "  work.",
  "",
  "  Tests (class H): this project has tests, or the brief asks for them — fix a test that",
  "  would pass with the feature broken, and add the missing cases for the risky paths to the",
  "  project's existing tests, in the places and style they already use.",
  "",
  "  Then answer with one line per class, A to I: `A. Requirements — checked, nothing` or what",
  "  you found and fixed. End your answer with this line, the number filled in:",
  "  Self-check complete: <number of classes> classes (ply-76hd92)",
  "  Then stop and wait: Plyloft takes the snapshot, runs Verify and starts the Reviewer by",
  "  itself once it sees that line and you are back at your prompt.",
  "",
];
const above = [
  "  Task:",
  "  Win: Add a triple function",
  "",
  "  Add a function triple(n) in src (returns n*3) plus a test. Run npm test. Do not commit.",
  "",
  "",
  "■ Conversation interrupted - use /feedback if something went wrong",
  "",
  "",
];
const stuckAsText = [...above, "›", ...composerRows, "", WALK_FOOTER, ""].join("\n");
check("walk 2026-10-27: the self-check drawn as text, composer scrolled — held", codexComposerHoldsPaste(stuckAsText, SELF_CHECK));
check(
  "walk 2026-10-27: ...with a mark at the chevron row's end — held",
  codexComposerHoldsPaste(stuckAsText.replace("\n›\n", "\n›                                                        ↑\n"), SELF_CHECK),
);
check(
  "walk 2026-10-27: ...the Enter not even a newline yet — held",
  codexComposerHoldsPaste([...above, "›", ...composerRows.slice(0, -1), "", WALK_FOOTER].join("\n"), SELF_CHECK),
);
check(
  "walk 2026-10-27: the same screen with a running turn above — not held",
  !codexComposerHoldsPaste(
    [...above, "• Working (3s • esc to interrupt)", "", "›", ...composerRows, "", WALK_FOOTER].join("\n"),
    SELF_CHECK,
  ),
);
check(
  "walk 2026-10-27: a paste still being read (its end not drawn yet) — not held",
  !codexComposerHoldsPaste([...above, "›", ...composerRows.slice(0, 8), "", WALK_FOOTER].join("\n"), SELF_CHECK),
);
const submittedAsText = [
  ...composerRows.slice(9, 14),
  "",
  "• Explored",
  "  └ Read index.js",
  "",
  "› Ask Codex to do anything",
  "",
  WALK_FOOTER,
].join("\n");
check("walk 2026-10-27: submitted, its echo above an empty composer — not held", !codexComposerHoldsPaste(submittedAsText, SELF_CHECK));
check(
  "walk 2026-10-27: the person's own draft under the paste's last words — not held",
  !codexComposerHoldsPaste([...above, "›", ...composerRows, "  please also check the README", "", WALK_FOOTER].join("\n"), SELF_CHECK),
);
check(
  "walk 2026-10-27: a question in the footer — never held",
  !codexComposerHoldsPaste([...above, "›", ...composerRows, "  Press enter to confirm or esc to cancel"].join("\n"), SELF_CHECK),
);

// v1.154.1 (J5): the terminal's own reports are not the person typing.
for (const report of [
  "\x1b[I",
  "\x1b[O",
  "\x1b[12;40R",
  "\x1b[?1;2c",
  "\x1b[>0;276;0c",
  "\x1b[<0;10;5M\x1b[<0;10;5m",
  "\x1b[M !!",
  "\x1b]11;rgb:ffff/ffff/ffff\x07",
  "\x1b]10;rgb:0000/0000/0000\x1b\\",
  "\x1bP1$r0m\x1b\\",
  "\x1b[I\x1b[12;40R",
]) {
  check(`report ${JSON.stringify(report)}`, isTerminalReport(report));
}
for (const typed of ["a", "\r", "\x1b[A", "\x1b", "fix it\r", "\x1b[Ia", "\x03", ""]) {
  check(`typed ${JSON.stringify(typed)}`, !isTerminalReport(typed));
}

// CL-7 round 3: which keystrokes submit a turn.
{
  const cases: [string, boolean][] = [
    ["\r", true],
    ["fix it\r", true],
    ["abc", false],
    [`${PASTE_START}line one\rline two\n${PASTE_END}`, false],
    [`${PASTE_START}text${PASTE_END}\r`, true],
    [`${PASTE_START}unterminated\r`, false],
    ["\x1b\r", false],
    ["\x1b\n", false],
  ];
  for (const [data, want] of cases) {
    check(`typedEnter(${JSON.stringify(data)}) is ${want}`, typedEnter(data) === want);
  }
}

// 1.172.0 E2 (Windows walk 2026-10-28): the review's end went into Codex's
// transcript search (F3), the Enter with it, and the card said "Sent".
const FIND_SCREEN = [
  "› Ask Codex to do anything",
  "",
  "  GPT-6.1-Sol default · C:\\ply-test\\sandboxes\\n170",
  "Find: and settles case handling.",
  "No matches · full transcript · esc cancel",
].join("\n");
const COMPOSER_SCREEN = FIND_SCREEN.split("\n").slice(0, 3).join("\n");
const WORKING_SCREEN = ["• Working (3s • esc to interrupt)", "", COMPOSER_SCREEN].join("\n");
check("E2: the walk's screen reads as the search", codexOverlayOpen(FIND_SCREEN));

/** A Windows Codex paste whose screen is `screen(enters, at)`. */
async function simulateE2(screen: (enters: number, at: number) => string | null) {
  let clock = 0;
  const writes: string[] = [];
  const enters = () => writes.filter((w) => w === "\r").length;
  let error: unknown = null;
  let result: string | null = null;
  try {
    result = await writePasteThenSubmit(msg, {
      write: async (bytes) => {
        writes.push(new TextDecoder().decode(bytes));
      },
      lastOutputAt: async () => (clock < 1_675 ? clock : 1_675),
      composerHoldsPaste: () => {
        const text = screen(enters(), clock);
        return text === null ? null : codexComposerHoldsPaste(text, msg);
      },
      overlayOpen: () => {
        const text = screen(enters(), clock);
        return text === null ? null : codexOverlayOpen(text);
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
  } catch (e) {
    error = e;
  }
  return { result, error, writes, enters: enters(), at: clock };
}
{
  // The search is already open: nothing is typed at all.
  const r = await simulateE2(() => FIND_SCREEN);
  check("E2: search open before the paste — rejects", r.error instanceof Error && r.error.message === OVERLAY_ALREADY_OPEN);
  check("E2: ...with nothing written", r.writes.length === 0);
}
{
  // The search opened during the paste: no Enter goes into it, and the
  // write rejects (sendOnce records "failed", never "sent").
  const r = await simulateE2((_n, at) => (at === 0 ? COMPOSER_SCREEN : FIND_SCREEN));
  check("E2: search open before the Enter — rejects", r.error instanceof Error && r.error.message === OVERLAY_TOOK_PASTE);
  check("E2: ...with no Enter written", r.enters === 0 && r.writes.length === 1);
}
{
  // The search shows up after the Enter: rejects, no Enter sent again.
  const r = await simulateE2((n) => (n === 0 ? COMPOSER_SCREEN : FIND_SCREEN));
  check("E2: search open after the Enter — rejects", r.error instanceof Error && r.error.message === OVERLAY_TOOK_PASTE);
  check("E2: ...and no second Enter", r.enters === 1);
}
{
  // The normal case: the composer empties into a turn. Resolves.
  const r = await simulateE2((n) => (n === 0 ? COMPOSER_SCREEN.replace("Ask Codex to do anything", "[Pasted Content 1500 chars]") : WORKING_SCREEN));
  check("E2: taken into a turn — resolves", r.error === null && r.result === "settled" && r.enters === 1);
}
{
  // Taken, and the turn already over: an empty composer. Resolves.
  const r = await simulateE2(() => COMPOSER_SCREEN);
  check("E2: an empty composer after the Enter — resolves", r.error === null && r.enters === 1);
}
{
  // No live screen: as before, one Enter and nothing else, resolved at once.
  const r = await simulateE2(() => null);
  check("E2: unknown screen — resolves", r.error === null && r.enters === 1);
  check("E2: ...without waiting for a confirmation", r.writes.length === 2);
}

// E2 (Challenger 2): the same message, left unsent in the composer by the
// last try, is not pasted again on top of itself — only the Enter.
{
  let clock = 0;
  const writes: string[] = [];
  let held = true;
  const r = await writePasteThenSubmit(msg, {
    write: async (bytes) => {
      const t = new TextDecoder().decode(bytes);
      writes.push(t);
      if (t === "\r") held = false;
    },
    lastOutputAt: async () => clock - 2_000,
    alreadyPasted: () => true,
    composerHoldsPaste: () => held,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  check("E2: held from the last try — only the Enter", writes.join("|") === "\r" && r === "settled");
}
{
  // Pasted before, but the person cleared the box: it is pasted again.
  let clock = 0;
  const writes: string[] = [];
  await writePasteThenSubmit(msg, {
    write: async (bytes) => {
      writes.push(new TextDecoder().decode(bytes));
    },
    lastOutputAt: async () => (clock < 1_675 ? clock : 1_675),
    alreadyPasted: () => true,
    composerHoldsPaste: () => false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  check("E2: cleared since — pasted again", writes.length === 2 && writes[0].startsWith(PASTE_START) && writes[1] === "\r");
}
{
  // Held, but not Plyloft's last unsent paste (someone's own [Pasted …]):
  // Plyloft's message is pasted, never their draft submitted in its place.
  let clock = 0;
  const writes: string[] = [];
  await writePasteThenSubmit(msg, {
    write: async (bytes) => {
      writes.push(new TextDecoder().decode(bytes));
    },
    lastOutputAt: async () => (clock < 1_675 ? clock : 1_675),
    alreadyPasted: () => false,
    composerHoldsPaste: () => false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  check("E2: not ours — pasted", writes[0].startsWith(PASTE_START));
}

// Round 2 (Challenger 1): the Codex prompt scan reads no prompt while the
// search is open, so closing it flips the flags back and what waited goes.
check("E2: search open — no prompt", withoutCodexOverlay(codexOverlayOpen(FIND_SCREEN), true) === false);
check("E2: composer — the scan's own word", withoutCodexOverlay(codexOverlayOpen(COMPOSER_SCREEN), true) === true);
check("E2: never turns a no into a yes", withoutCodexOverlay(false, false) === false);
// Round 2 (Challenger 2): a search that took part of it is the person's to
// clear, then send — Plyloft never says it sends it by itself.
check("E2: took part — no promise of a resend", !/Plyloft sends it again/.test(codexScreenHelp(OVERLAY_TOOK_PASTE, true) ?? ""));
check("E2: nothing typed — sent again once closed", /Plyloft sends it again/.test(codexScreenHelp(OVERLAY_ALREADY_OPEN, true) ?? ""));
check("E2: other errors have no help", codexScreenHelp("pty closed", true) === null);

// E2: the Windows Codex paste is typed as keys — typographic characters
// become plain ones, blank-line runs shrink, control characters go.
{
  const review = "P3 — note\u00a0here\n\n\n\nFix: [\u2018b\u2019] \u2192 [\u201cA\u201d] \u2190 ok \u00b7 a \u2013 b\u2026\r\nend\x1bOR\x07";
  const want = "P3 - note here\n\nFix: ['b'] -> [\"A\"] <- ok - a - b...\nendOR";
  check("E2: plainForKeys", plainForKeys(review) === want);
  check(
    "E2: pasteBodyBytes carries the plain text",
    new TextDecoder().decode(pasteBodyBytes(review)) === `${PASTE_START}${want}${PASTE_END}`,
  );
  check("E2: plainForKeys keeps ordinary text and one blank line", plainForKeys("a\n\nb\tc é ü 中") === "a\n\nb\tc é ü 中");
  check("E2: blank lines with spaces count as blank", plainForKeys("a\n  \n\t\n\nb") === "a\n\nb");
  check("E2: the guard reads the plain text", new TextDecoder().decode(pasteBodyBytes("\u2192!x")).startsWith(`${PASTE_START}->!x`));
  check("E2: the Mac's paste is untouched", pasteText("a \u2192 b\n\n\nc") === `${PASTE_START}a \u2192 b\n\n\nc${PASTE_END}\r`);
}
check("E2: a cursor report", isCursorReport("\x1b[38;1R"));
check("E2: two cursor reports", isCursorReport("\x1b[38;1R\x1b[1;5R"));
check("E2: a focus report is not a cursor report", !isCursorReport("\x1b[I"));
check("E2: typing is not a cursor report", !isCursorReport("R") && !isCursorReport("\x1b[38;1Rx"));

if (failed > 0) {
  console.error(`builderInject.test.ts — ${failed} failed`);
  process.exit(1);
}
console.log("builderInject.test.ts — all passed");
