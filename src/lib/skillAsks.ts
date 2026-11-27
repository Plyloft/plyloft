/**
 * 1.175.0 B1 (review SEC-1, proof P1): the words for a skill whose **text**
 * asks to be allowed to do things — `allowed-tools` with a command or
 * writing tool, `hooks`, a command run when the skill loads. What it asks is
 * read by the backend (`skill_asks.rs`); here are the row's line, the
 * sheet's title, lede and list, the Share page's second line and the toast.
 *
 * Pure, so node runs it (`skillAsks.test.ts`). A sentence that names this
 * computer goes through `machineWords` where it is shown.
 */

import type { ScriptsReview, ScriptsReviewFile } from "../ipc";

/** Mirrors `skill_asks::ToolsAsk`. */
export interface ToolsAsk {
  line: number;
  tools: string[];
  /** A bare `Bash` is among them: any command. */
  any: boolean;
}

/** Mirrors `skill_asks::Asks`. */
export interface SkillAsks {
  /** The front matter couldn't be read, at this line. */
  unreadable: number | null;
  inline: { line: number; command: string }[];
  commands: ToolsAsk | null;
  writes: ToolsAsk | null;
  hooks: { line: number; moments: string[] } | null;
  /** Round 2 (G1.4): front-matter keys not known to be harmless. `known`:
   *  the CLI acts on it (`mcpServers`, `permissionMode`, `shell`…). */
  other?: { line: number; key: string; known: boolean }[];
  /** 1.175.0 Y1: the widest thing this text asks, by the one rule
   *  (`skill_asks::Asks::strongest`): commands without asking, then a command
   *  at load, then changing files, then "couldn't read". Absent: nothing. */
  strongest?: StrongestAsk | null;
}

/** `skill_asks::Strongest`: the one thing a row, the Share page's line and
 *  the sheet's title and lede have room to say. Never worked out here. */
export type StrongestAsk = "inline" | "commands" | "files" | "unreadable";

declare module "../ipc" {
  interface ScriptsReviewFile {
    /** What this text asks for, when it is a skill's text that asks. */
    asks?: SkillAsks | null;
    /** The same for the version sessions keep, when the text changed. */
    asksBefore?: SkillAsks | null;
    /** That version's text, for "Show both". */
    textBefore?: string | null;
  }
  interface SkillNeedsOk {
    /** The strongest thing its text asks for, when its `SKILL.md` is what
     *  is new or changed. Absent from an older backend. */
    asks?: StrongestAsk | null;
  }
  interface ProjectSkill {
    /** The strongest thing its `SKILL.md` asks for; absent: plain text. */
    asks?: StrongestAsk | null;
    /** Round 2 (G3): the id of the bytes `asks` was read from; the Share
     *  page hands it back with its press. */
    asksId?: string | null;
    /** Round 2 (G6): the Share page's refusal line, when a copy here holds
     *  a name Windows can't have. */
    shareRefusal?: string | null;
  }
  interface ScriptsReview {
    /** Round 2 (G3): the `SKILL.md` of the version sessions keep meanwhile;
     *  absent when no session gets the skill until the OK. */
    keptText?: string | null;
    /** Y1 round 2: the widest thing the review's texts ask together
     *  (`skill_scripts::widest_ask`, the backend's one rule) — what the
     *  sheet's title and lede say, in step with the row. */
    asks?: StrongestAsk | null;
  }
}

/** The widest thing a text asks, as the backend's one rule says it. */
export function strongestOf(asks: SkillAsks | null | undefined): StrongestAsk | null {
  return asks?.strongest ?? null;
}

/** "it lets agents run commands without asking you" — after "Needs your OK · ". */
export function asksClause(asks: StrongestAsk, now = false): string {
  const n = now ? "now " : "";
  switch (asks) {
    case "inline":
      return `it ${n}runs a command when it loads`;
    case "commands":
      return `it ${n}lets agents run commands without asking you`;
    case "files":
      return `it ${n}lets agents change files without asking you`;
    case "unreadable":
      return "Plyloft couldn't read what it asks for";
  }
}

/** The team row of a skill whose text waits for an OK. `null`: a script is
 *  what is new, so the row keeps its own words (`needsOkLine`). */
export function asksNeedsOkLine(needsOk: {
  firstTime: boolean;
  approvedAt: number | null;
  bringsScript?: boolean;
  asks?: StrongestAsk | null;
}, approvedDay: (ms: number) => string): string | null {
  if (!needsOk.asks || needsOk.bringsScript === true) return null;
  if (needsOk.firstTime) {
    return `Needs your OK · ${asksClause(needsOk.asks)}. New sessions don't get it until you say OK.`;
  }
  if (needsOk.approvedAt == null) {
    return `Needs your OK · ${asksClause(needsOk.asks, true)}. New sessions keep the version from before.`;
  }
  return `Needs your OK · its text changed. New sessions keep the version you approved on ${approvedDay(needsOk.approvedAt)}.`;
}

/** Round 2 (G3): above the text on a held skill's page — which version it
 *  is. `approvedAt` null: the plain text from before it asked. */
export function keptVersionLine(approvedAt: number | null | undefined): string {
  return approvedAt != null
    ? "What you see below is the version you approved, the one your sessions use."
    : "What you see below is the version from before, the one your sessions use.";
}

/** The repository row linked to a team skill whose newer text waits. */
export function linkedAsksLine(asks: StrongestAsk): string {
  const what =
    asks === "inline"
      ? "runs a command when it loads"
      : asks === "files"
        ? "lets agents change files without asking you"
        : asks === "commands"
          ? "lets agents run commands without asking you"
          : "asks for something Plyloft couldn't read";
  return `Needs your OK · the team library's newer copy ${what}. Update waits until you say OK.`;
}

/** My library's status line. `null`: a script (or a file that is not text)
 *  is what waits; `undefined`: what waits isn't read yet, so only that it does. */
export function myLibraryNeedsOkLine(asks: StrongestAsk | null | undefined): string {
  if (asks === undefined) return "Needs your OK. New sessions on this Mac get it once you say OK.";
  const what = asks ? asksClause(asks) : "it brings a script";
  return `Needs your OK · ${what}. New sessions on this Mac get it once you say OK.`;
}

/** What a sheet's review says waits, for a row that has only the review:
 *  the text's strongest ask, or `null` when a script or a file is what waits. */
export function waitingAsk(review: Pick<ScriptsReview, "files" | "asks"> | null | undefined): StrongestAsk | null {
  if (!review || !sheetIsAboutText(review)) return null;
  return review.asks ?? SHEET_FALLBACK;
}

/** "It lets agents run commands without asking you" — the toast's sentence. */
export function asksSentence(asks: StrongestAsk): string {
  const clause = asksClause(asks);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/** The Share page's second status line (Share with Team…, Promote to Team). */
export function shareAsksLine(asks: StrongestAsk): string {
  const what =
    asks === "inline"
      ? "Its text runs a command when the skill loads."
      : asks === "files"
        ? "Its text lets agents change files without asking."
        : asks === "commands"
          ? "Its text lets agents run commands without asking."
          : "Plyloft couldn't read what its text asks for.";
  return `${what} Every other computer asks its person for an OK before its sessions get it; on this Mac, sharing it is your OK.`;
}

// ── The sheet ───────────────────────────────────────────────────────────

/** The skill's text on the sheet, when it asks (`kind: "asks"`). */
export function askingText(review: Pick<ScriptsReview, "files">): ScriptsReviewFile | null {
  return review.files.find((f) => f.kind === "asks" && f.asks) ?? null;
}

/** Round 3: every text of the skill that asks (a nested `SKILL.md`, the
 *  other CLI's copy when the two differ), in the sheet's order — the list
 *  under "What it asks to be allowed to do" shows each one's, as the title
 *  says the widest of them all. */
export function askingTexts(review: Pick<ScriptsReview, "files">): ScriptsReviewFile[] {
  return review.files.filter((f) => f.kind === "asks" && f.asks);
}

/** The sheet speaks of the text — not of a script — when the text asks and
 *  no script or extra file is among what is new or changed. */
export function sheetIsAboutText(review: Pick<ScriptsReview, "files">): boolean {
  const text = askingText(review);
  if (!text) return false;
  return !review.files.some((f) => (f.kind === "script" || f.kind === "extra") && f.change !== "unchanged");
}

/** Y1 round 2: what the sheet says about a text that asks when the review
 *  carries no answer (an older backend): the most prudent of its wordings,
 *  never the narrowest. A review of a text that asks always has one. */
const SHEET_FALLBACK: StrongestAsk = "unreadable";

/** The one thing the sheet's title and lede say: the review's own answer
 *  (`ScriptsReview.asks`), over all its texts — not the first asking file's. */
function sheetAsk(review: Pick<ScriptsReview, "asks">): StrongestAsk {
  return review.asks ?? SHEET_FALLBACK;
}

/** After the skill's name: "asks to run commands". */
export function asksTitle(review: Pick<ScriptsReview, "asks" | "firstTime" | "approvedAt">): string {
  if (!review.firstTime && review.approvedAt != null) return "has a changed text";
  switch (sheetAsk(review)) {
    case "commands":
      return "asks to run commands";
    case "inline":
      return "runs a command when it loads";
    case "files":
      return "asks to change files";
    case "unreadable":
      return "has a text Plyloft couldn't read";
  }
}

function lets(s: StrongestAsk, whose: "this Mac" | "theirs"): string {
  if (whose === "theirs") {
    return s === "inline"
      ? "its text runs a command when the skill loads"
      : s === "files"
        ? "its text lets their agents change files without asking them"
        : s === "unreadable"
          ? "Plyloft couldn't read what its text asks for"
          : "its text lets their agents run commands without asking them";
  }
  return s === "inline"
    ? "its text runs a command on this Mac when the skill loads"
    : s === "files"
      ? "its text lets agents change files on this Mac without asking you"
      : s === "unreadable"
        ? "Plyloft couldn't read what its text asks for"
        : "its text lets agents run commands on this Mac without asking you";
}

/** The sheet's lede for a library skill whose text asks. */
export function asksLede(
  review: Pick<ScriptsReview, "asks" | "firstTime" | "approvedAt" | "author">,
  place: string,
  approvedDay: (ms: number) => string,
): string {
  const who = review.author ?? "Someone";
  const asks = sheetAsk(review);
  if (review.firstTime) {
    return `${who} added it to ${place}. It brings no script, but ${lets(asks, "this Mac")}. New sessions don't get it until you say OK.`;
  }
  if (review.approvedAt != null) {
    return `${who} changed SKILL.md in ${place}. New sessions keep the version you approved on ${approvedDay(review.approvedAt)} until you say OK.`;
  }
  const now = lets(asks, "this Mac").replace(/^its text /, "Its text now ");
  return `${who} changed SKILL.md in ${place}. ${now}. New sessions keep the version from before until you say OK.`;
}

/** Publish to {branch} of a project skill whose text asks. */
export function asksPublishLede(review: Pick<ScriptsReview, "asks">, branch: string): string {
  return `Publishing puts it on ${branch} at once, with no card to review it. Everyone who works on this repository gets it, and ${lets(sheetAsk(review), "theirs")}.`;
}

/** Install or Update through a card. */
export function asksInstallLede(review: Pick<ScriptsReview, "asks">, verb: "install" | "update"): string {
  const put = verb === "install" ? "Installing puts it in this repository through a card." : "This update puts its changed text in this repository through a card.";
  return `${put} Everyone who works on this repository gets it once the card ships, and ${lets(sheetAsk(review), "theirs")}.`;
}

export const ASKS_HEADING = "What it asks to be allowed to do";
export const ASKS_FOOTER =
  // "A plugin with hooks…" in the approved text; the app's word for what
  // carries a hooks file is still the skill it reaches the person as.
  "A skill that is only text and asks for none of this never asks. A skill delivered with a hooks file or an MCP server is refused, whatever you answer here. Your OK is for this Mac only; if SKILL.md changes, Plyloft asks again.";
export const ASKS_PUBLISH_FOOTER = "Your OK is for this publish only: a later one whose SKILL.md changed asks again.";

export function unreadableWords(line: number): string {
  return `Plyloft couldn't read the top of SKILL.md (line ${line}), so it can't tell what this skill asks for. Read the text before you say OK.`;
}

/** Round 2 (G1.4): front-matter keys Plyloft doesn't know to be harmless. */
export const OTHER_KEYS_TITLE = "Set up the session in ways Plyloft doesn't check";
export function otherKeysDetail(line: number): string {
  return `Written at the top of the text, from line ${line}. Plyloft doesn't know what these let the skill do, so read the text before you say OK.`;
}

export type AskChip = "new" | "changed" | "unchanged" | "no longer asked";

export interface AskItem {
  key: "inline" | "commands" | "writes" | "hooks" | "other";
  title: string;
  detail: string;
  /** What the box lists now, a line each (empty: no longer asked). */
  now: string[];
  /** What it listed in the version approved, when that differs. */
  before: string[] | null;
  /** Against the version sessions keep; null on a first version. */
  chip: AskChip | null;
}

const ANY_COMMAND = "Any command (Bash)";

function boxOf(key: AskItem["key"], asks: SkillAsks | null | undefined): string[] {
  if (!asks) return [];
  switch (key) {
    case "inline":
      return asks.inline.map((i) => i.command || "(a block)");
    case "commands":
      return asks.commands ? (asks.commands.any ? [ANY_COMMAND] : asks.commands.tools) : [];
    case "writes":
      return asks.writes?.tools ?? [];
    case "hooks":
      return asks.hooks ? (asks.hooks.moments.length ? asks.hooks.moments : ["hooks"]) : [];
    case "other":
      return (asks.other ?? []).map((k) => k.key);
  }
}

function lineOf(key: AskItem["key"], asks: SkillAsks | null | undefined): number | null {
  if (!asks) return null;
  switch (key) {
    case "inline":
      return asks.inline[0]?.line ?? null;
    case "commands":
      return asks.commands?.line ?? null;
    case "writes":
      return asks.writes?.line ?? null;
    case "hooks":
      return asks.hooks?.line ?? null;
    case "other":
      return asks.other?.[0]?.line ?? null;
  }
}

/** The list under "What it asks to be allowed to do", strongest first; with
 *  `before`, each item says how it stands against the version approved. */
export function askItems(now: SkillAsks, before: SkillAsks | null = null, publish = false): AskItem[] {
  const you = publish ? "" : " you";
  const order: AskItem["key"][] = ["inline", "commands", "writes", "hooks", "other"];
  const out: AskItem[] = [];
  for (const key of order) {
    const [is, was] = [boxOf(key, now), boxOf(key, before)];
    if (is.length === 0 && was.length === 0) continue;
    const line = lineOf(key, is.length ? now : before) ?? 1;
    const same = is.length === was.length && is.every((v, i) => v === was[i]);
    const chip: AskChip | null = !before ? null : is.length === 0 ? "no longer asked" : was.length === 0 ? "new" : same ? "unchanged" : "changed";
    const title =
      key === "inline"
        ? "Run a command as soon as the skill loads"
        : key === "commands"
          ? `Run these commands without asking${you}`
          : key === "writes"
            ? `Change files without asking${you}`
            : key === "hooks"
              ? "Run a command at set moments of a session"
              : OTHER_KEYS_TITLE;
    const detail =
      key === "inline"
        ? `Written in the text, line ${line}. It runs before the agent reads the rest, and it doesn't show as a command in the session.`
        : key === "commands"
          ? `From \`allowed-tools\`, line ${line}. An agent using this skill runs them with no permission question, whatever you chose for the Builder, and outside the card's copy too.`
          : key === "writes"
            ? `From \`allowed-tools\`, line ${line}.`
            : key === "hooks"
              ? `From \`hooks\`, line ${line}: ${(now.hooks ?? before?.hooks)?.moments.join(", ") || "a session's moments"}.`
              : otherKeysDetail(line);
    out.push({ key, title, detail, now: is, before: chip === "changed" ? was : null, chip });
  }
  return out;
}

/** How many lines of the text differ from the version approved. */
export function linesThatDiffer(before: string, now: string): number {
  const [a, b] = [before.split(/\r?\n/), now.split(/\r?\n/)];
  // Lines of each not in the other, counted with their repeats.
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const line of lines) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const [ca, cb] = [count(a), count(b)];
  let removed = 0;
  let added = 0;
  for (const [line, n] of ca) removed += Math.max(0, n - (cb.get(line) ?? 0));
  for (const [line, n] of cb) added += Math.max(0, n - (ca.get(line) ?? 0));
  return Math.max(removed, added);
}

/** The lines of `now` (1-based) that the version approved doesn't hold. */
export function changedLines(before: string, now: string): Set<number> {
  const left = new Map<string, number>();
  for (const line of before.split(/\r?\n/)) left.set(line, (left.get(line) ?? 0) + 1);
  const out = new Set<number>();
  now.split(/\r?\n/).forEach((line, i) => {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else out.add(i + 1);
  });
  return out;
}

/** The SKILL.md row's hint: its size, how it stands, and what the OK covers. */
export function askingTextHint(file: Pick<ScriptsReviewFile, "change" | "text" | "textBefore">, size: string): string {
  if (file.change === "changed" && file.text != null && file.textBefore != null) {
    const n = linesThatDiffer(file.textBefore, file.text);
    return `${size} · changed · ${n} ${n === 1 ? "line differs" : "lines differ"} from the version you approved`;
  }
  return `${size} · ${file.change} · your OK is for this exact text`;
}
