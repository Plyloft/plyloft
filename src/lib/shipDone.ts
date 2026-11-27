/**
 * QoL 1.168 S1-4: what the success toast of a release says — built from the
 * result, so only Plyloft's own repository says Plyloft will quit and
 * relaunch. Every other project says what actually happened: committed and
 * tagged here, pushed, its own install step started.
 *
 * Pure, so node runs it (`shipDone.test.ts`).
 */

import type { ReleasePrReleasedEvent, ShipResult } from "../ipc";
import { shippedWords } from "./shipVersion.ts";
import { installHeldSentence } from "./checksConsent.ts";

/** P39 (1.174.0 TX5, T29): a ship on this Mac when the project runs nothing
 *  after shipping — where to set one, by the row's own name: Settings ›
 *  Shipping › After a release, run (DS2; owner, 2026-10-31: the row's
 *  label). Replaces "(No go-live step configured for this project.)". */
export const NOTHING_RUNS_AFTER_SHIPPING =
  "Nothing runs after shipping in this project; Settings › Cards › Shipping › “After a release, run” sets one.";

export interface ShipDoneWords {
  title: string;
  body: string;
}

export function shipDoneWords(
  result: Pick<ShipResult, "commitSha" | "shippedVersion" | "releaseKind" | "installScript" | "relaunches" | "releasePr" | "tag">,
  cardCount = 1,
  /** 1.175.0 B2: the install step waits for this Mac's OK (`installHeldFor`):
   *  it hasn't run, and nothing relaunches. */
  installHeld: { who: string; firstTime?: boolean } | null = null,
): ShipDoneWords {
  const held = installHeld ? ` ${installHeldSentence(installHeld.who, installHeld.firstTime)}` : null;
  // 1.173.0 (B4): the release's own tag (`site-v1.0.1` for an area's).
  const v = result.tag?.trim() || shippedWords(result.shippedVersion);
  const cards = cardCount === 1 ? "" : ` ${cardCount} cards`;
  // G8 (1.170.0): a release through a pull request on GitHub.
  const pr = result.releasePr;
  if (pr) {
    const number = pr.number !== null ? ` #${pr.number}` : "";
    if (pr.released) {
      const page = result.releaseKind === "github" ? " and its release page on GitHub is published" : "";
      const next =
        held ??
        (result.relaunches
          ? ` Plyloft is building it, then quits and relaunches${v ? ` as ${v}` : ""}.`
          : result.installScript
            ? ` Its install step (${result.installScript}) is running in the background.`
            : "");
      return {
        title: v ? `Released${cards} as ${v}` : `Released${cards}`,
        body: `Merged through its pull request${number}, tagged on the merge${page}.${next} Commit ${result.commitSha.slice(0, 8)}.`,
      };
    }
    return {
      title: pr.number !== null ? `Release pull request${number} opened` : "Release made, not on GitHub yet",
      body:
        pr.waiting ??
        `${v ? `${v} goes` : "It goes"} in when its checks on GitHub pass: Plyloft merges it, then tags it${
          result.releaseKind === "github" ? " and publishes the release" : ""
        }. The card${cardCount === 1 ? " is" : "s are"} marked shipped then.`,
    };
  }
  const title = v ? `Shipped${cards} as ${v}` : `Shipped${cards}`;
  const where =
    result.releaseKind === "github"
      ? // 1.169.1 (R13): it pushes what Tag and push does; the release
        // page is the project's own workflow's (1.170.0, G8, makes it).
        "Committed, tagged and pushed. The release page on GitHub is created by your own workflow, if you have one."
      : result.releaseKind === "push_only"
        ? "Committed, tagged and pushed."
        : "Committed and tagged on this Mac.";
  const next =
    held ??
    (result.relaunches
      ? ` Plyloft is building it, then quits and relaunches${v ? ` as ${v}` : ""}.`
      : result.installScript
        ? ` Its install step (${result.installScript}) is running in the background.`
        : "");
  return { title, body: `${where}${next} Commit ${result.commitSha.slice(0, 8)}.` };
}

/** G8 fixes (1.170.0, m2): what the window says when the poller finished a
 *  release through a pull request on its own (merged, tagged, the cards
 *  marked) — and, when the project has one, that its install step waits for
 *  the person's press (the poller never runs it). */
export function releasedByPollerWords(
  event: Pick<ReleasePrReleasedEvent, "cardCount" | "result" | "installScript" | "relaunches">,
  /** 1.175.0 B2: its install step waits for this Mac's OK — Review, not
   *  "Run the install step". */
  installHeld: { who: string; firstTime?: boolean } | null = null,
): ShipDoneWords {
  const done = shipDoneWords(event.result, event.cardCount);
  const next = !event.installScript
    ? ""
    : installHeld
      ? ` ${installHeldSentence(installHeld.who, installHeld.firstTime)}`
      : event.relaunches
      ? " Run the install step builds it; Plyloft quits and relaunches then."
      : ` Its install step (${event.installScript}) hasn't run: Run the install step starts it.`;
  // 1.174.0 (DR4, release.html state 8): "site-v3.0.2 is released".
  const tag = event.result.tag?.trim() || shippedWords(event.result.shippedVersion);
  return { title: tag ? `${tag} is released` : done.title, body: `${done.body}${next}` };
}

/** 1.171.0 A3 (DL-30): the toast of a card's land that started its
 *  project's go-live step (`merged_live`). Only Plyloft's own install
 *  relaunches (`relaunches`); any other project's install step just runs.
 *  `landed`: `localShipLine`'s sentence, said where the project is on
 *  GitHub. */
export function goLiveWords(
  result: { fellBack: boolean; relaunches?: boolean },
  onGitHub: boolean,
  landed: string,
): string {
  const next = result.relaunches
    ? "rebuilding your app; it'll relaunch shortly."
    : "its install step is running in the background.";
  if (result.fellBack) return `No git remote — merged locally; ${next}`;
  if (onGitHub) return `${landed} ${next.charAt(0).toUpperCase()}${next.slice(1)}`;
  return `Merged — ${next}`;
}
