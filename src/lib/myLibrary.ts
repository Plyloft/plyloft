/**
 * Skills hub H10 (`docs/plans/SKILLS_HUB.md` R6; mockup `my-library.html`):
 * the words of My library — the member's own private GitHub repository of
 * skills, delivered to their sessions as the plugin `mine`. Pure: the
 * backend (`my_library.rs`) decides; this file says it.
 *
 * The three markers below are the backend's refusal leads; `my_library_tests`
 * reads this file, so a lead changed on one side alone fails there.
 */
import { asksSentence } from "./skillAsks.ts";
import type { MyLibraryCompare, MyLibraryView } from "../ipc.ts";
import type { MyLibraryPublished } from "./myLibraryPublished.ts";
import { machineWords } from "./platform.ts";

export const GRANT_MARKER = "GitHub needs one more permission to create a private repository";
export const ALREADY_A_LIBRARY_MARKER = "is already a My library";
export const OFFLINE_WORDS = "Couldn't reach GitHub — try again when you're online.";

/** §14 Q28: the create sheet's one line about linked copies. */
export const SHARED_REPOS_NOTICE = "Copies you link into shared repositories name this repository.";

function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e ?? "");
}

/** The refusal is the missing `repo` permission: offer *Grant it*. */
export function isGrantRefusal(e: unknown): boolean {
  return textOf(e).includes(GRANT_MARKER);
}

/** The name is a My library already: offer *Use it on this Mac*. */
export function isAlreadyALibrary(e: unknown): boolean {
  return textOf(e).includes(ALREADY_A_LIBRARY_MARKER);
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** The sheet's opening sentence (R6). */
export function createLede(login: string | null, name: string): string {
  const repo = `${login ?? "<your account>"}/${name || "plyloft-skills"}`;
  return machineWords(
    `My library keeps your own skills in a private repository on your GitHub account, so they reach your sessions on every Mac you sign in to. Plyloft creates ${repo} (private).`,
  );
}

/** `mine:a`, `mine:a and mine:b`, `mine:a, mine:b and mine:c`. */
function namesAs(plugin: string, names: readonly string[]): string {
  const as = names.map((n) => `${plugin}:${n}`);
  if (as.length <= 1) return as.join("");
  return `${as.slice(0, -1).join(", ")} and ${as[as.length - 1]}`;
}

/** The sheet's *What reaches where* (mockup 6a). */
export function whatReachesWhere(seed: readonly string[], plugin = "mine"): string {
  const reach =
    seed.length === 0
      ? `Your sessions on this Mac get every skill you add to it from the next session, as ${plugin}:<name>, for Claude and Codex.`
      : `Your sessions on this Mac get ${seed.join(seed.length === 2 ? " and " : ", ")} from the next session, as ${namesAs(plugin, seed)}, for Claude and Codex.`;
  return machineWords(`${reach} On another computer, choose “Use it on this Mac”. Nobody else can read it.`);
}

/** The line under My library's heading: when it was last updated, and why
 *  not when it couldn't be. `null` when this computer uses none. */
export function statusLine(view: MyLibraryView, now: number): string | null {
  if (!view.repo) return null;
  if (!view.hasClone) return machineWords("Not on this Mac yet.");
  const when = view.lastPullAt != null ? ago(now - view.lastPullAt) : null;
  const last = when ? `Last updated ${when}` : "Not updated yet";
  if (view.goneAt != null || view.lastError === "gone") return `${last} · not reachable`;
  switch (view.lastError) {
    case "offline":
      return `${last} · offline`;
    case "held":
      return machineWords(`${last} · this Mac has a change GitHub doesn't`);
    case "signIn":
      return machineWords(`${last} · ${view.account ?? "its GitHub account"} isn't signed in on this Mac`);
    case "failed":
      return `${last} · couldn't update`;
  }
  return when ? `Updated ${when}` : "Not updated yet";
}

/** R6 edge (mockup 6b): GitHub answers *not found* for the repository; the
 *  last copy keeps serving. GitHub says 404 both for a deleted private
 *  repository and for one this account can't read, so the words name
 *  neither (R16: "isn't reachable with your GitHub account any more"). */
export function goneNotice(view: MyLibraryView, now: number): string | null {
  if (!view.repo || (view.goneAt == null && view.lastError !== "gone")) return null;
  const copy = view.lastPullAt != null ? `the copy from ${ago(now - view.lastPullAt)}` : "the last copy";
  const who = view.account ? `the GitHub account ${view.account}` : "your GitHub account";
  return `Your My library ${view.repo} isn't reachable with ${who} any more. Your sessions still get ${copy}.`;
}

/** R6 edge: the chosen account isn't signed in here (a sign-in problem,
 *  never "gone"; H4 step 13's words). */
export function signInNotice(view: MyLibraryView): string | null {
  if (!view.repo || view.lastError !== "signIn") return null;
  return machineWords(
    `My library uses the GitHub account ${view.account ?? "that owns it"}, which isn't signed in on this Mac. Sign it in in Setup's GitHub step; your sessions keep the last copy meanwhile.`,
  );
}

/** *Grant it* runs gh's own permission refresh, which acts on gh's active
 *  account only: for another account, say how instead of refreshing the
 *  wrong one. `null` when Grant it can run. */
export function grantElsewhere(view: MyLibraryView, account: string | null): string | null {
  const chosen = view.accounts.find((a) => a.login === account);
  if (!account || !chosen || chosen.active) return null;
  const active = view.accounts.find((a) => a.active)?.login;
  return `GitHub's permission refresh works on gh's active account, and ${account} isn't it. In Terminal: gh auth switch -h github.com -u ${account}, then gh auth refresh -h github.com -s repo${active ? `, then gh auth switch -h github.com -u ${active}` : ""}. Then try again.`;
}

/** The section's count line beside the heading. */
export function sectionCount(skills: number): string {
  return machineWords(`${skills} ${skills === 1 ? "skill" : "skills"} · your sessions on every Mac`);
}

/** What *Add to My library* says when it went through, or found nothing to do. */
export function publishedToast(out: MyLibraryPublished, plugin = "mine"): string | null {
  switch (out.kind) {
    case "published":
      // H6a: a skill that brings a script reaches sessions only after this
      // computer's OK, as its row says.
      // 1.175.0 B1: its text asks, and no script does — said as the row says it.
      return out.needsOk
        ? machineWords(
            `${out.skill} is in My library. ${out.asks ? asksSentence(out.asks) : "It brings a script"}, so new sessions on this Mac get it as ${plugin}:${out.skill} once you say OK — Review it on its page.`,
          )
        : `${out.skill} is in My library. New sessions get it as ${plugin}:${out.skill}.`;
    case "alreadyThere":
      return `My library already has this version of ${out.skill}.`;
    case "keptOther":
      return machineWords(`My library keeps the other computer's ${out.skill}. Nothing from this Mac was published.`);
    // 1.176.4: kept on this computer, said as kept; its OK as a publish's.
    case "kept":
      return out.needsOk
        ? `${out.words} ${machineWords(`${out.asks ? asksSentence(out.asks) : "It brings a script"}, so new sessions on this Mac get it as ${plugin}:${out.skill} once you say OK — Review it on its page.`)}`
        : out.words;
    case "compare":
      return null;
  }
}

/** The compare's heading and lede (§14 Q4: no pull request against yourself). */
export function compareWords(compare: MyLibraryCompare, now: number): { title: string; lede: string } {
  const who = compare.otherAuthor ? `${compare.otherAuthor}, from another computer,` : "Another computer";
  const when = compare.otherAt != null ? ` ${ago(now - compare.otherAt)}` : "";
  return {
    title: machineWords(`${compare.skill} changed on another computer and on this Mac`),
    lede: machineWords(
      compare.twoWay
        ? `${who} put a version of ${compare.skill} in My library${when}, and this Mac never published one before. Choose which one My library keeps; nothing is lost.`
        : `${who} published ${compare.skill}${when} after this Mac last did. Choose which one My library keeps; nothing is lost.`,
    ),
  };
}

/** The compare's three columns. */
export const COMPARE_LABELS = {
  base: "Before (the version both started from)",
  other: "The other computer's (in My library now)",
  here: machineWords("This Mac's"),
};

export const KEEP_THIS_LABEL = machineWords("Keep this Mac's");
export const KEEP_OTHER_LABEL = "Keep the other's";

// ── 1.174.0 (X3, SL-16; mockup next-1174/my-library.html): My library in a
// project's Library › Skills — read-only, with "Manage in All skills". The
// first empty-state sentence is All skills' own (`MyLibraryPanel`), so the
// two pages say the same thing.

/** The sentence over *Create My library*, in All skills and in a Library. */
export function emptyLede(): string {
  return machineWords(
    "Keep your own skills in a private repository on your GitHub account. They reach your sessions on every Mac you use, as mine:<name>.",
  );
}

/** GitHub already has this person's My library (`found`). */
export function foundLine(found: string): string {
  return machineWords(`Your My library ${found} is on GitHub — use it on this Mac.`);
}

export const LIBRARY_SECTION_TITLE = "In My library";
export const MANAGE_LABEL = "Manage in All skills";
export const SET_UP_LABEL = "Set it up in All skills";
export const EMPTY_HINT = "Create one, or use one you already have, in All skills.";
export const ALSO_IN_REPOSITORY = "also in this repository";
export const ALSO_IN_MY_LIBRARY = "also in My library";

/** The empty section's words beside its title, in place of a count. */
export function notSetUpWords(): string {
  return machineWords("not set up on this Mac");
}

/** The line under the section's heading, when this computer uses one. */
export function librarySectionNote(repo: string, plugin = "mine"): string {
  return `Yours alone, from your private repository ${repo}. Sessions get them as ${plugin}:<name>. Add, change or remove them in All skills.`;
}

/** Green dot only for "Updated…"; every other status line is grey. */
export function statusIsCurrent(line: string | null): boolean {
  return line != null && line.startsWith("Updated ");
}
