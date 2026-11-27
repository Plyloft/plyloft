import { useState } from "react";
import { ErrorBlock } from "../ux";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  asTrashRefusal,
  projectSkillPublish,
  projectSkillPublishReview,
  worktreeTrashUntracked,
  type TrashedThenSynced,
} from "../../ipc";
import { pushToast } from "../../store/toastStore";
import { useLibrary } from "../../store/libraryStore";
import { openLibraryPage } from "../../store/uiStore";
import { isScriptsWait } from "../../lib/skillCards";
import { localBranchStateKey, localBranchSyncToast } from "../../lib/worktreeBase";
import { pushLocalBranchToast } from "../../store/kanbanStore";
import { observeLocalBranch, useErrorBlocks } from "../../store/errorBlockStore";
import {
  localBranchRefusalError,
  narrowRefusalTo,
  placementOf,
  publishableItems,
  trashableItems,
  type LocalBranchRefusal,
  type StoppedOperation,
} from "../../lib/uxError";
import { showErrorPage } from "../../lib/announceError";
import { isWindows } from "../../lib/platform";
import type { Scope } from "../../lib/uxScope";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 7 (GH #102; BOARDS.md §5): `Local <branch> can't be
 * updated.` as a block that stays, with its two ways out.
 *
 * **Where it is drawn.** On the Library page when the paths are under
 * `.claude/skills/` or `.atelier/library/` — that is where the member met them
 * and where their publish lives — and on Settings › This workspace ›
 * Worktrees for anything else. `on` says which surface is asking, and the
 * block answers on one of them only, so the two placements can render it
 * unconditionally from one line each.
 *
 * **On a skill's own page** (`name`, with `scope` from the row) the block
 * speaks about that skill and nothing else: only its paths, only its publish,
 * and a press moves only its files. The refusal is about the **checkout**, so a
 * `This Mac` or `Team` page of the same name shows nothing (review 1) — those
 * copies are not the ones standing in the way.
 *
 * **On a card's Ship step** (`on="card-ship"`, GH #151) the block is the one
 * Ship or Land met: a whole operation's refusal lives on the surface of the
 * operation (PATTERNS.md §4). It is drawn there for the cards the store's
 * `shipStep` names, whatever the paths are, with the same two ways out; the
 * words say what stopped and that it can be run again.
 *
 * The refusal itself lives in `errorBlockStore`, keyed by workspace, so a
 * switch to Terminals and back — or closing Settings — leaves it exactly where
 * it was, and only a later Sync, a successful Trash, or a Ship / Land / Merge
 * whose fast-forward Rust reports reached origin's tip (`fastForwarded`,
 * GH #183) takes it down.
 */
export function LocalBranchBlock({
  workspaceId,
  on,
  cardId,
  name,
  scope,
}: {
  workspaceId: string;
  on: "library" | "worktrees" | "card-ship";
  /** `on="card-ship"`: the card whose Ship step this is. */
  cardId?: string;
  /** A skill's own page: draw only what concerns this skill. */
  name?: string;
  /** That row's scope. Only the repository's copy is the one in the way. */
  scope?: Scope;
}) {
  // A stored value or null — never a fresh object, which would re-render every
  // warmed workspace's host on every unrelated change.
  const whole = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.localBranch ?? null);
  const shipStep = useErrorBlocks((s) => s.byWorkspace[workspaceId]?.shipStep ?? null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  if (!whole) return null;
  // GH #151: the Ship step draws the refusal Ship or Land met on this card, and
  // nothing else — a Sync's refusal stays on its own page.
  let stopped: StoppedOperation | undefined;
  if (on === "card-ship") {
    if (!cardId || !shipStep || !shipStep.cardIds.includes(cardId)) return null;
    stopped = shipStep.stopped;
  } else if (whole.atMerge || placementOf(whole) !== on) return null;
  // UX P-A (Windows walk 2): files in the way of the card's merge are the
  // card's Ship step's alone — a Sync never met them.
  // A skill's page: the repository row only, and only its own paths.
  if (name && scope !== "repository") return null;
  const refusal = name ? narrowRefusalTo(whole, name) : whole;
  if (!refusal) return null;

  const error = localBranchRefusalError(refusal, stopped);

  async function publish(it: LocalBranchRefusal) {
    // The action is not drawn when there is nothing to publish; guarded so a
    // press can never end in a toast about a publish that never ran.
    const items = publishableItems(it);
    if (items.length === 0) return;
    setBusy("publish");
    // Owner, 2026-10-19 (R15): a skill whose publish brings a new or changed
    // script shows its files first, on its Library page; nothing is published
    // until its OK there, and this block's press is then pressed again.
    // Challenger: with more than one skill, the others are not published by
    // that sheet's OK, so the press says which ones are left (and which had
    // already gone, on a refusal that came after them).
    const sheetFor = (skill: string, published: string[] = []) => {
      openLibraryPage(workspaceId, "skills");
      useLibrary.getState().setFlow(workspaceId, { kind: "publish", key: `repository:${skill}` });
      const left = items.map((item) => item.name).filter((name) => name !== skill && !published.includes(name));
      if (left.length === 0 && published.length === 0) return;
      pushToast({
        kind: "info",
        title: `Look at ${skill}'s files first`,
        body: [
          published.length > 0 ? `Your version of ${listWords(published)} is on its way to ${it.branch}.` : "",
          left.length > 0
            ? `${listWords(left)} ${left.length === 1 ? "waits" : "wait"}: after OK, publish, press Publish your versions again.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    };
    try {
      for (const item of items) {
        const review = await projectSkillPublishReview(workspaceId, item.name).catch(() => null);
        if (review) {
          sheetFor(item.name);
          return;
        }
      }
      // The existing publish of that item, one per skill the refusal named.
      const outcomes: string[] = [];
      for (const item of items) {
        let done;
        try {
          done = await projectSkillPublish(workspaceId, item.name);
        } catch (cause) {
          if (!isScriptsWait(String((cause as Error)?.message ?? cause))) throw cause;
          sheetFor(
            item.name,
            items.slice(0, outcomes.length).map((done) => done.name),
          );
          return;
        }
        outcomes.push(done?.outcome ?? "queued");
      }
      // Owner, 2026-10-19: the push runs before each publish returns. A pull
      // request or a refusal has the drain's own toast; this one says
      // "published" only when every push went through.
      if (outcomes.includes("said")) return;
      // Owner-fixes Windows walk: `current` — the branch already held it, so
      // nothing was committed and nothing waits.
      const published = outcomes.every((o) => o === "published" || o === "current");
      const current = outcomes.every((o) => o === "current");
      pushToast({
        kind: "info",
        title: current
          ? `Your version is already on ${it.branch}`
          : published
            ? `Published your version to ${it.branch}`
            : `Publishing your version to ${it.branch}`,
        body:
          `Your copy ${published ? "is" : "becomes"} the one on ${it.branch}. The next Sync brings the ` +
          `branch here, and nothing in your project folder is changed.`,
      });
    } catch (cause) {
      pushErrorToast("Couldn't publish your version", cause);
    } finally {
      setBusy(null);
    }
  }

  async function trash(it: LocalBranchRefusal) {
    // Only what the Trash can take, and only this block's own: a skill's page
    // moves that skill's files (review 1) and a folder is never posted at all,
    // because the backend would refuse the whole call over it (review 2).
    const asked = trashableItems(it).flatMap((item) => item.paths);
    if (asked.length === 0) return;
    setBusy("trash");
    try {
      const done = await worktreeTrashUntracked(workspaceId, asked, on === "card-ship" ? cardId : undefined);
      // UX P-A (Windows walk 2): the merge's refusal is gone once its files
      // are; the fast-forward's outcome below may still raise its own.
      if (it.atMerge) useErrorBlocks.getState().setLocalBranch(workspaceId, null);
      // The fast-forward that ran straight after decides what is left on the
      // page: the refusal goes when it succeeds, and comes back — naming
      // whatever is in the way now — when it doesn't.
      const stillRefused = observeLocalBranch(workspaceId, {
        branch: done.branch,
        outcome: done.outcome,
      });
      // Review 2: "the block on this page names it" is only true if the block
      // is still on *this* page. A skill's page shows its own skill, so a
      // refusal that has moved on to other files has left this page.
      const nowWhole =
        useErrorBlocks.getState().byWorkspace[workspaceId]?.localBranch ?? null;
      const shownHere = !!nowWhole && (!name || narrowRefusalTo(nowWhole, name) !== null);
      sayWhatHappened(done, stillRefused, shownHere, workspaceId, stopped);
    } catch (cause) {
      // The way out didn't go through. The block keeps the refusal, says why,
      // and — when the move stopped part way — names what is in the Trash, so
      // `What was left untouched` is never a false sentence (review 1).
      const refused = asTrashRefusal(cause);
      useErrorBlocks
        .getState()
        .setTrashError(workspaceId, refused.reason, refused.stuckInTrash, asked);
    } finally {
      setBusy(null);
    }
  }

  const one = refusal.paths.length === 1;
  return (
    <>
      <ErrorBlock
        error={error}
        busy={busy}
        // BOARDS.md §5 draws this block's Details open, with git's own words.
        detailsOpen
        // GH #150: the card's Ship step is a work surface; the Library and
        // Worktrees are pages and keep the page density.
        density={on === "card-ship" ? "dense" : "page"}
        onAction={(id) => {
          if (id === "publish") void publish(refusal);
          else if (id === "trash") setAsking(true);
        }}
      />
      {/* Asks once, naming the files (BOARDS.md §5). Cancel leaves the block
          and the files exactly as they are. */}
      {asking && (
        <ConfirmDialog
          title={
            isWindows()
              ? one
                ? "Move the local copy to the Recycle Bin?"
                : "Move the local copies to the Recycle Bin?"
              : one
                ? "Move the local copy to the Trash?"
                : "Move the local copies to the Trash?"
          }
          body={
            `${refusal.paths.join("\n")}\n\n` +
            `${one ? "It goes" : "They go"} to the ${isWindows() ? "Recycle Bin" : "macOS Trash"}, where you can put ` +
            `${one ? "it" : "them"} back. ` +
            (refusal.atMerge
              ? `The card's ${one ? "copy" : "copies"} can then be merged.`
              : `Plyloft then brings ${refusal.branch} up to date with GitHub.`)
          }
          confirmLabel={isWindows() ? "Move to Recycle Bin" : "Move to Trash"}
          destructive
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void trash(refusal);
          }}
        />
      )}
    </>
  );
}

/**
 * One toast per press, whatever the fast-forward then did.
 *
 * Review 1: a member whose `SKILL.md` has just left the checkout has to be told
 * so on **every** outcome, not only on the one that succeeded — the block is
 * taken down by that outcome, so a silent branch here was a file that seemed to
 * vanish. The Trash sentence therefore leads every body, and the outcome's own
 * words follow it.
 */
function sayWhatHappened(
  done: TrashedThenSynced,
  stillRefused: boolean,
  /** The block is still drawn where the press came from. */
  shownHere: boolean,
  workspaceId: string,
  /** GH #151: pressed on a card's Ship step — the operation to run again. */
  stopped?: StoppedOperation,
) {
  const moved = done.trashed.length;
  const one = moved === 1;
  const inTrash = moved
    ? `${one ? "The local copy is" : "The local copies are"} in the Trash, where you can put ${one ? "it" : "them"} back.`
    : null;
  const lead = inTrash ? `${inTrash} ` : "";
  // GH #151: the way is clear, so the operation the block stopped can run.
  const again = stopped ? ` You can ${stopped} again now.` : "";

  if (done.outcome.kind === "fastForwarded") {
    pushToast({
      kind: "info",
      title: `${done.branch} on this Mac is up to date`,
      body:
        (inTrash
          ? `${inTrash} ${done.branch} now has ${one ? "the one" : "the ones"} from GitHub.`
          : `Whatever was in the way is gone; ${done.branch} is up to date with GitHub.`) + again,
    });
    return;
  }
  if (stillRefused) {
    pushToast({
      kind: "warn",
      title: `Local ${done.branch} still can't be updated`,
      body: shownHere
        ? `${lead}Something else is in the way now — the block on this page names it.`
        : `${lead}Other files are still in the way. They are named on the Skills page.`,
      // Review 2: this skill is clear, so its block has gone from this page.
      // The toast leads to the one that still has something to say.
      action: shownHere
        ? undefined
        : {
            label: "Show",
            onClick: () => showErrorPage({ page: "library-skills", workspaceId }),
          },
    });
    return;
  }
  const report = { branch: done.branch, outcome: done.outcome };
  const ordinary = localBranchSyncToast(report);
  // E3: the page keeps a lasting state the fast-forward left, as a Sync's does.
  useErrorBlocks.getState().setLocalState(workspaceId, localBranchStateKey(report) ? report : null);
  if (ordinary) {
    pushLocalBranchToast(workspaceId, { ...ordinary, body: `${lead}${ordinary.body}` });
    return;
  }
  // Up to date, ahead, offline, no remote, no local branch: there is no
  // ordinary toast for those, so the Trash — or the clear way — is the news.
  pushToast({
    kind: "info",
    title: moved ? "Moved to the Trash" : `Nothing is in the way of ${done.branch}`,
    body:
      (inTrash ??
        `Whatever was in the way is gone. ${done.branch} needs nothing from GitHub right now.`) +
      again,
  });
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
