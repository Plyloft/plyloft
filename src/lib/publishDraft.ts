/**
 * UX language card 2: publishing a Repository page's draft, from the press
 * to the read that says what the save did.
 *
 * The sequence lives here rather than inside the component so it can be run
 * with a save that settles when a test says so and a read that fails when a
 * test says so (card #94 review, F3). What is left in `RepositoryPage` is
 * handing it the workspace's functions; the order of the steps, what each
 * failure leaves behind, and what the session is told at every point are
 * this module's, and `publishDraft.test.ts` drives all of it.
 *
 * The rules it keeps:
 *
 * - one save at a time, and never from a page that is already holding
 *   still — a second press would make a second commit;
 * - nothing is sent while a read has failed: the first build field
 *   published carries values Ply read here, and a failed read may have left
 *   them behind;
 * - one call carries every changed field, so the channel makes one commit;
 * - a save that failed reports a failure, and only the save itself can:
 *   reading back what it did comes after, and cannot turn a publish that
 *   landed into one that did not (F30);
 * - either way the page is told to hold still until a read succeeds, and
 *   the read is asked for straight away.
 */

import type { DraftEvent, DraftSession } from "./draftSession.ts";
import {
  changedFields,
  listWords,
  normalise,
  rowLabel,
  savePayload,
  type Draft,
  type FieldKey,
  type Values,
} from "./repositoryPage.ts";
import { quotedLabel } from "./definitionRefresh.ts";
import type { UxError, UxErrorAction } from "./uxError.ts";
import { looksPlain, plainCause } from "./plainError.ts";
import { rawError } from "./cardPage.ts";
import type { WorkspaceDefinition } from "../ipc";

/** What a page's error block says: PATTERNS.md §4's three parts.
 *
 *  Card 7 (GH #102) draws every one of these with the one `ErrorBlock`, which
 *  takes a {@link UxError}. A card-2 problem is those three parts and nothing
 *  else — the ways out belong to the page that knows what a press does — so
 *  {@link pageError} is the one place a problem becomes a `UxError`, and every
 *  sentence in this file is the only copy of itself. */
export interface PublishProblem {
  title: string;
  happened: string;
  untouched: string;
  todo: string;
  /** QoL 1.168 block 8 (A5): the tool's own words, behind Details. */
  details?: string | null;
}

/** A reason as the block says it: a plain sentence stands; raw text is put
 *  in plain words, and kept for Details. */
function reasonParts(reason: unknown): { happened: string; details: string | null } {
  const raw = rawError(reason).trim();
  return looksPlain(raw) ? { happened: raw, details: null } : { happened: plainCause(reason), details: raw || null };
}

/** The card-2 problem, with the ways out the page can offer for it. Up to two
 *  (BOARDS.md §5); the first is the primary button. No `Details`: what these
 *  failures know is already the whole of `What happened`. */
export function pageError(problem: PublishProblem, ...actions: UxErrorAction[]): UxError {
  return { ...problem, actions: actions.slice(0, 2), details: problem.details ?? null };
}

/** As much of the save's answer as the sequence reads. */
export interface SaveAnswer {
  queue: { fields: Record<string, unknown> };
  cache: { branch: string | null };
}

export interface PublishInput {
  /** The page as it is when the button is pressed. */
  session: () => DraftSession;
  dispatch: (event: DraftEvent) => boolean;
  definition: WorkspaceDefinition | null;
  values: Values | null;
  branch: string;
  /** The repository already shares build settings of its own. */
  sharedProject: boolean;
  /** Try it: this Mac's start command, carried by a first share. */
  tryCommand?: string | null;
  /** A read that failed, and has not been put right. */
  readError: string | null;
  order: readonly FieldKey[];
  /** One call with the definition it opened on and the payload. */
  save: (base: Record<string, unknown>, payload: Record<string, unknown>) => Promise<SaveAnswer>;
  /** The read that says what the save did. Never rejects. */
  reload: () => Promise<void>;
  /** The workspace record follows a published name or accent. */
  refreshWorkspaces: () => Promise<void>;
  /** Kept on the page until the next write goes through. */
  onProblem: (problem: PublishProblem | null) => void;
  /** Said once, when the save is done and read back. */
  onPublished: (result: { queued: boolean; branch: string; count: number }) => void;
  /** Windows walk (C5): the branch this Publish moves the shared setup to,
   *  when the one it lived on is gone (`publishTargetOfDraft`). */
  target?: string | null;
  onFailed: (error: unknown) => void;
}

export function nothingToPublishTo(): PublishProblem {
  return {
    title: "There is nothing to publish to.",
    happened: "This repository no longer shares a definition on this Mac.",
    untouched: "Nothing was changed — your changes are still here.",
    todo: "Close Settings and open it again; the page then edits this Mac's own settings.",
  };
}

export function heldByAFailedRead(error: string): PublishProblem {
  return {
    title: "Publishing waits until Plyloft can read these settings again.",
    ...reasonParts(error),
    untouched:
      "Nothing was sent. Your changes are still here, and the rows show the last good read.",
    todo: "Press Read again above. Once that goes through, Publish sends them.",
  };
}

/** A save applies its fields on this Mac before it queues them, so a
 *  failure part-way can leave this Mac changed. The page says what it
 *  knows rather than promising a rollback (F30). */
export function publishProblem(branch: string, e: unknown): PublishProblem {
  return {
    title: `Your changes couldn't be published to ${branch}.`,
    ...reasonParts(e),
    untouched: `Nothing reached ${branch}. Plyloft applies a change on this Mac before it sends it, so some of it may already be in the rows below — they show what this Mac has now.`,
    todo: "Fix what the reason names and press Publish again. Discard clears what is still marked here; it does not take back anything this Mac already has.",
  };
}

/** A second read that failed too: what is on the page is the last good one. */
export function readAgainProblem(reason: string): PublishProblem {
  return {
    title: "Plyloft couldn't read this repository's settings again.",
    ...reasonParts(reason),
    untouched:
      "Nothing was changed. What is below is the last good read, and anything you have changed here is still here.",
    todo: "Read them again. Publishing waits until that goes through, because what Plyloft has may be out of date.",
  };
}

/** QoL 1.168 block 8 (A5): the first read failed, so there is no last good
 *  read on the page. */
export function firstReadProblem(reason: string): PublishProblem {
  return {
    title: "Plyloft couldn't read this repository's settings.",
    ...reasonParts(reason),
    untouched: "Nothing was changed.",
    todo: "Read them again. Plyloft reads the repository and this Mac's own settings.",
  };
}

/** A local save that failed part-way: it writes field by field, so it says
 *  which fields it reached before it stopped. */
export function localSaveProblem(
  keys: readonly FieldKey[],
  written: readonly FieldKey[],
  reason: string,
): PublishProblem {
  const left = keys.filter((key) => !written.includes(key));
  // 1.174.0 (DS2): a row's name in a sentence is quoted ("Cards go to").
  const named = (key: FieldKey) => quotedLabel(rowLabel(key));
  const what = left.length === 1 ? named(left[0]) : `${left.length} settings`;
  return {
    title: `${what} couldn't be saved on this Mac.`,
    ...reasonParts(reason),
    untouched: written.length
      ? `${listWords(written.map(named))} ${
          written.length === 1 ? "was" : "were"
        } saved before it failed; ${listWords(left.map(named))} ${
          left.length === 1 ? "was" : "were"
        } not. Nothing in the repository was touched.`
      : "Nothing was changed — the rows show what is on this Mac now.",
    todo: "Try the change again. If it keeps failing, the reason above says what to fix.",
  };
}

/** `Re-detect` on Build & release, when Ply could not read the checkout. */
export function reDetectProblem(reason: string): PublishProblem {
  return {
    title: "Plyloft couldn't read this repository again.",
    happened: reason,
    untouched: "Nothing was changed — the rows below are as they were.",
    todo: "Check that the repository is still where Plyloft expects it, then press Re-detect again.",
  };
}

/** `Reset this Mac` on General: the settings file goes field by field too. */
export function resetProblem(reason: string): PublishProblem {
  return {
    title: "These settings couldn't be reset.",
    happened: reason,
    untouched:
      "Nothing in the repository was touched. Plyloft removes this Mac's settings file by file, so part of them may already be gone — the page below shows what it has now.",
    todo: "The reason above says what stopped it; press Reset again to finish. A repository that shares its settings is reset by changing them here and publishing, not by this.",
  };
}

/** C3: `definition` with each sent field set to what it was changed from
 *  (`bases`), so the save's `base` says, per field, what this Mac saw when
 *  it edited. A field with no recorded base keeps the definition's value. */
export function withBases(
  definition: Record<string, unknown>,
  order: readonly FieldKey[],
  values: Values | null,
  sent: Draft,
  bases: Draft,
): Record<string, unknown> {
  const out = { ...definition };
  for (const key of changedFields(order, values, sent)) {
    if (key in bases) out[key] = normalise(key, bases[key]);
  }
  return out;
}

/** Runs the whole sequence. `true` only when the save landed. */
export async function publishDraft(input: PublishInput): Promise<boolean> {
  // A second press before the session has repainted would send a second
  // save and make a second commit.
  if (input.session().phase !== "idle") return false;
  if (!input.definition) {
    input.onProblem(nothingToPublishTo());
    return false;
  }
  if (input.readError) {
    input.onProblem(heldByAFailedRead(input.readError));
    return false;
  }

  // The draft as it really is; from here until a read lands the page holds
  // still, so what is sent and what is cleared are the same thing.
  input.dispatch({ kind: "publishBegan" });
  const sent = input.session().sent ?? {};
  const count = Object.keys(sent).length;

  let answer: SaveAnswer;
  try {
    // C3 (SC-3): each drafted field's base is the value it was changed
    // from, not the one in use at the Publish — a value a teammate published
    // meanwhile is then asked about (the conflict question), never written
    // over without a word.
    answer = await input.save(
      withBases(input.definition as unknown as Record<string, unknown>, input.order, input.values, sent, input.session().bases),
      savePayload(input.definition, input.order, input.values, sent, {
        fillProject: !input.sharedProject,
        branch: input.branch,
        tryCommand: input.tryCommand ?? null,
      }),
    );
  } catch (e) {
    input.dispatch({ kind: "publishFailed" });
    input.onProblem(publishProblem(input.branch, e));
    input.onFailed(e);
    // What this Mac has now is what the rows must show.
    await input.reload();
    return false;
  }

  // Past here the save is done. Nothing that follows may report it as a
  // failure: what is left is reading back what it did (F30).
  input.dispatch({ kind: "publishSaved" });
  input.onProblem(null);
  await input.reload();
  await input.refreshWorkspaces();
  input.onPublished({
    queued: Object.keys(answer.queue.fields).length > 0,
    // Windows walk (C5): where it really goes when the setup's branch is
    // gone ("Cards go to" moved); else the branch the cache reads.
    branch: input.target ?? answer.cache.branch ?? input.branch,
    count,
  });
  return true;
}
