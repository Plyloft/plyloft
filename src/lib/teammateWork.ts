import type { UxError } from "./uxError.ts";

// 1.175.0 (D1; review TM-1): Ship it on a card whose teammate got there
// first. Two people on one issue build the same branch name; the second
// Ship used to end in git's own words ("couldn't push the branch to the
// remote: … (fetch first)") behind a generic box whose "Try again" would
// only be refused again. Ship now stops before it sends anything
// (`second_claim.rs::ship_refusal`) and names the teammate's pull request,
// and a push the branch refuses names who pushed there
// (`name_who_pushed`). Its sentences are read here into the card's error
// box (mockup `two-people.html#d1`, 1.4): no "Try again", the full button
// opens the teammate's page. "this Mac" becomes "this PC" where the box is
// drawn (`errorForMachine`).

/** What Ship found of a teammate's on GitHub. */
export type TeammateWork =
  | { kind: "open"; number: number; login: string; sameBranch: boolean; url: string }
  | { kind: "merged"; number: number; login: string; issue: number; url: string }
  | { kind: "pushed"; login: string; url: string; raw: string };

const SENT = "Nothing was sent to GitHub\\.";
const OPEN = new RegExp(
  `Pull request #(\\d+) by (\\S+) is already open for this card(, from a branch with the same name as yours)?\\. ${SENT} (https://\\S+)`,
);
const MERGED = new RegExp(
  `Pull request #(\\d+) by (\\S+) was merged for this card, and issue #(\\d+) is closed\\. ${SENT} (https://\\S+)`,
);
const PUSHED = new RegExp(
  `(\\S+) already pushed work for this card to GitHub, on a branch with the same name as yours\\. ${SENT} (https://\\S+)\\n?([\\s\\S]*)$`,
);

/** The teammate's work a Ship refusal names (`second_claim.rs`), or null
 *  for any other failure. `raw` is the failure's own text. */
export function teammateWork(raw: string): TeammateWork | null {
  const text = raw.trim();
  const open = OPEN.exec(text);
  if (open) {
    return { kind: "open", number: Number(open[1]), login: open[2], sameBranch: Boolean(open[3]), url: open[4] };
  }
  const merged = MERGED.exec(text);
  if (merged) {
    return { kind: "merged", number: Number(merged[1]), login: merged[2], issue: Number(merged[3]), url: merged[4] };
  }
  const pushed = PUSHED.exec(text);
  return pushed ? { kind: "pushed", login: pushed[1], url: pushed[2], raw: pushed[3].trim() } : null;
}

/** The id the card page opens a web page for (`plainError.OPEN_ON_GITHUB_ACTION`). */
const OPEN_PAGE = "open-github";

/** The card's box for it, under `title` (the press that didn't go
 *  through). Nothing was sent, so nothing is retried: the full button opens
 *  the teammate's pull request (or the branch), beside Dismiss. */
export function teammateWorkError(title: string, work: TeammateWork): UxError {
  const untouched = "Nothing was sent to GitHub. Your work is safe in this card's copy on this Mac.";
  if (work.kind === "pushed") {
    return {
      title,
      happened: `${work.login} already pushed work for this card to GitHub, on a branch with the same name as yours.`,
      untouched,
      todo: `Agree with ${work.login} which work ships. Plyloft never overwrites a teammate's branch.`,
      actions: [
        { id: OPEN_PAGE, label: "Open on GitHub", primary: true, url: work.url },
        { id: "dismiss", label: "Dismiss" },
      ],
      details: work.raw || null,
    };
  }
  const pr = `Pull request #${work.number} by ${work.login}`;
  return {
    title,
    happened:
      work.kind === "merged"
        ? `${pr} was merged for this card, and issue #${work.issue} is closed.`
        : `${pr} is already open for this card${work.sameBranch ? ", from a branch with the same name as yours" : ""}.`,
    untouched,
    todo:
      work.kind === "merged"
        ? "If your work is still needed, make a new card for it; this card's copy keeps your commits."
        : `Look at pull request #${work.number} and agree with ${work.login} which work ships. Plyloft never overwrites a teammate's branch.`,
    actions: [
      { id: OPEN_PAGE, label: `Open pull request #${work.number}`, primary: true, url: work.url },
      { id: "dismiss", label: "Dismiss" },
    ],
    details: null,
  };
}
