/**
 * GH #82 (card 4 of 4): read-only collaborators, and shared Knowledge and
 * project skills on the shared-config channel. The words and decisions the
 * panels and toasts use, kept pure so they are tested without a window.
 */

/**
 * What the Knowledge editor sends to save a Shared · Project note. A blank
 * draft carries `id: ""`; that is a new note (`null`), never an edit.
 */
export function projectNoteInput(draft: {
  id?: string | null;
  title: string;
  body: string;
  tags: string[];
}): { id: string | null; title: string; body: string; tags: string[] } {
  return {
    id: draft.id ? draft.id : null,
    title: draft.title.trim(),
    body: draft.body,
    tags: draft.tags.map((t) => t.trim()).filter(Boolean),
  };
}

/**
 * What travels on the shared-config channel (`shared_library_sync::ItemKind`).
 * GH #101 added `instructions`: the two root instruction files.
 */
export type ItemKind = "knowledge" | "skill" | "instructions";

export interface FieldProvenanceLike {
  author: string;
  /** Seconds. */
  changedAt: number;
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "16 Sep 2026", in UTC so every Mac says the same date. */
export function formatDay(secs: number): string {
  const d = new Date(secs * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The line under a shared field a read-only collaborator can't change:
 * "Set in the project by <author> on <date>; ask for write access to change it."
 * `null` when the fields are editable on this Mac.
 */
export function readOnlyLine(
  view: {
    readOnly?: boolean;
    provenance?: Record<string, FieldProvenanceLike>;
    cache?: { author: string | null; refreshedAt?: number };
  },
  field: string,
): string | null {
  if (!view.readOnly) return null;
  const set = view.provenance?.[field];
  const author = set?.author ?? view.cache?.author ?? null;
  const when =
    set?.changedAt != null
      ? ` on ${formatDay(set.changedAt)}`
      : "";
  const by = author ? ` by ${author}` : "";
  return `Set in the project${by}${when}; ask for write access to change it.`;
}

/** Whether Settings › Project may offer to edit the shared definition. */
export function definitionEditable(view: {
  readOnly?: boolean;
  effective: unknown | null;
}): boolean {
  return !view.readOnly && view.effective != null;
}

export interface LibraryStateLike {
  shared: boolean;
  branch: string | null;
  readOnly: boolean;
  repository: string | null;
  pending: {
    /** GH #101: `instructions` joined the channel — the two root files travel
     *  on it, so the Instructions page's row reads its state from here. */
    kind: ItemKind;
    name: string;
    title: string;
    removed: boolean;
    lastError: string | null;
    /** F3/F9: the last attempt could not reach origin, so `lastError` is a
     *  wait. Absent or null: not known (an older build, an older entry). */
    offline?: boolean | null;
    pullRequest: { number: number; url: string } | null;
  }[];
  branchSkills: string[];
  /** GH #96: the same skills with their description and their directory in
   *  the mirror — the Library's rows show the description's first sentence,
   *  and a skill that lives only on the branch has one nowhere else. */
  branchSkillRows?: {
    name: string;
    codexName: string | null;
    description: string;
    dir: string;
    /** GH #105: which CLIs the branch's copies reach, and whether the two say
     *  the same thing. Absent from a state written by an older build. */
    claude?: boolean;
    codex?: boolean;
    differs?: boolean;
    codexDir?: string | null;
    /** Group B §2 review 1: the skill's id on the branch in this build — sent
     *  back by `Remove` and `Align` as the version on screen. */
    id?: string | null;
  }[];
  /** What the branch carries that Ply doesn't load, and why. */
  skipped?: string[];
  /** Branch skills Claude sessions in the checkout get through Ply: no
   *  Claude copy in the checkout, or a different one. */
  suppliedToCheckout?: string[];
  /** Walk F4: branch skills whose checkout copies are exactly the branch's
   *  (`LibraryState.current_in_checkout`), so `Update on <branch>` has nothing
   *  to carry. Absent from a state written by an older build. */
  currentInCheckout?: string[];
  /** Group B §2 walks: skills whose checkout copy for one CLI is behind the
   *  branch because an Update let it follow the edited one
   *  (`LibraryState.checkout_behind`). Absent from an older build. */
  checkoutBehind?: { name: string; copy: "claude" | "codex" }[];
  /** GH #156: whether Codex sessions on this Mac get the branch's Codex copies
   *  (the `ply-project` marketplace in the `CODEX_HOME` overlay), and why not
   *  when that is a fault. Absent from a state written by an older build. */
  branchCodex?: BranchCodexDelivery;
}

/**
 * GH #156 (`branch_codex_skills::Delivery`): the Codex half of what Claude gets
 * through the `project` plugin. `refused` is set only for a fault worth saying —
 * a colliding marketplace, a config Ply cannot parse — and is `null` both when
 * it reaches and on a Mac with no Codex home at all.
 */
export interface BranchCodexDelivery {
  reaches: boolean;
  refused: string | null;
}

/** The refusals (a symlink on the branch) that concern `kind`. */
export function skippedLines(
  state: LibraryStateLike | null,
  kind: "knowledge" | "skill",
): string[] {
  // GH #105: a skill is one item in two roots, and a symlink in either of them
  // is refused — the refusal names the root it was in.
  const prefixes =
    kind === "skill"
      ? [".claude/skills/", ".agents/skills/"]
      : [".atelier/library/knowledge/"];
  return (state?.skipped ?? [])
    .filter((line) => prefixes.some((prefix) => line.startsWith(prefix)))
    .map(
      (line) =>
        `Not loaded from ${state?.branch ?? "the integration branch"}: ${line} — Plyloft doesn’t copy symlinks.`,
    );
}

/**
 * What the Shared · Project scope says about writing. A read-only
 * collaborator still sees the scope — it explains the write access it needs.
 */
export function sharedProjectNote(state: LibraryStateLike | null): {
  canWrite: boolean;
  line: string | null;
} {
  if (!state || !state.shared) return { canWrite: true, line: null };
  if (state.readOnly) {
    return {
      canWrite: false,
      line: `Shared · Project needs write access to ${state.repository ?? "this repository"}. Ask for it, or keep this as a Personal note.`,
    };
  }
  return {
    canWrite: true,
    line: `Saved notes are committed to ${state.branch ?? "the integration branch"} for everyone who opens the project; the files in your project folder are untouched.`,
  };
}

/** The chip next to a queued note or skill. */
export function pendingChip(
  state: LibraryStateLike | null,
  kind: "knowledge" | "skill",
  name: string,
): string | null {
  const item = state?.pending.find((p) => p.kind === kind && p.name === name);
  if (!item) return null;
  return pendingLabel(item);
}

function pendingLabel(item: LibraryStateLike["pending"][number]): string {
  if (item.pullRequest) {
    return item.removed
      ? `Removal waiting for PR #${item.pullRequest.number} to merge`
      : `Waiting for PR #${item.pullRequest.number} to merge`;
  }
  return item.removed ? "Removal pending sync" : "Pending sync";
}

/**
 * Queued removals whose item is no longer listed (the mirror already drops
 * it): shown on their own, so a deletion made offline stays visible until it
 * reaches the branch.
 */
export function pendingRemovals(
  state: LibraryStateLike | null,
  kind: "knowledge" | "skill",
  listed: string[],
): { name: string; title: string; label: string; lastError: string | null }[] {
  if (!state?.shared) return [];
  return state.pending
    .filter((p) => p.kind === kind && p.removed && !listed.includes(p.name))
    .map((p) => ({ name: p.name, title: p.title, label: pendingLabel(p), lastError: p.lastError }));
}

/** The toast after deleting a Shared · Project note. */
export function deletionToast(
  state: LibraryStateLike | null,
  title: string,
): { kind: "info"; title: string; body: string } {
  if (state?.shared) {
    return {
      kind: "info",
      title: "Deleting shared note",
      body: `“${title}” is gone on this Mac and being removed from ${state.branch ?? "the integration branch"}; teammates keep it until that lands.`,
    };
  }
  return { kind: "info", title: "Shared note deleted", body: title };
}

export interface LibraryReportLike {
  branch: string;
  updates: {
    kind: ItemKind;
    name: string;
    title: string;
    action: "added" | "changed" | "removed" | string;
    author: string | null;
    /** GH #144: when the change landed on the branch (seconds). Absent from a
     *  report written before it, and whenever git could not say. */
    changedAt?: number | null;
  }[];
  published: {
    kind: ItemKind;
    name: string;
    title: string;
    /** GH #105: how many items the one commit carried (0 and 1 both mean one). */
    count?: number;
    removed: boolean;
    over: { author: string | null; changedAt: number | null } | null;
  }[];
  /** GH #160: what waits in a pull request this drain opened, per item — with
   *  the kind, so the instructions get their own toast, and the backend's own
   *  reason for its body (`shared_library_sync::WaitingPullRequest`). */
  pullRequests: {
    kind: ItemKind;
    title: string;
    pullRequest: { number: number; url: string };
    /** Only a sentence when `neverOverride` is true; otherwise git's stderr from
     *  the push the branch refused, which no toast may carry (review 1). */
    reason: string;
    neverOverride?: boolean;
  }[];
  closed: string[];
  pending: string[];
  /** GH #101: the kinds still queued, so a refusal reaches the Library page the
   *  member met it on (`errorBlockStore.observeLibraryRefusal`). */
  pendingKinds?: ItemKind[];
  error: string | null;
  offline: boolean;
  refused: string | null;
  /**
   * GH #101 review 2: an instruction file moved on the branch, so Ply would not
   * commit over it and no pull request could carry the change either.
   *
   * Sorted apart from `refused` in Rust and sorted apart here: nobody's write
   * access is in question, the noun is not "a shared note or skill", and there is
   * no retry to promise — the recorded bases cannot come to match by waiting.
   */
  blocked?: string | null;
  /** Promoted personal notes now on the branch (removed from personal). */
  promoted?: { workspaceId: string | null; id: string; updatedAt: string }[];
  /** GH #105 review 1: copies this drain would not make, each with its reason —
   *  a destination somebody had filled meanwhile, a source that moved. */
  notCopied?: string[];
}

interface Toast {
  kind: "info" | "warn";
  title: string;
  body?: string;
  /**
   * GH #160: the pull request this toast is about. The caller turns it into the
   * toast's one action (`Open pull request`, through
   * `workspaceDefinitionOpenPullRequest`), the way a pure row model hands its
   * action id to the page — `libraryToasts` stays a function of the report.
   */
  pullRequest?: { number: number; url: string };
}

function what(kind: ItemKind, title: string, count = 1): string {
  // GH #105: one commit may carry several skills, and its title is already a
  // count (`34 skills for Claude and Codex`) — naming it "the skill" would say
  // the opposite of what happened.
  if (kind === "skill") return count > 1 ? `${count} skills` : `the skill ${title}`;
  // GH #101: an **update** to an instruction file names the file, because the
  // branch diff's `title` for one falls back to its name. A publish names the
  // change instead, and says so at its own call site below.
  if (kind === "instructions") return title;
  return `the note “${title}”`;
}

/**
 * How long ago an upstream change landed, in BOARDS.md §3's words (`2 hours
 * ago`), from a number of seconds.
 *
 * Restored with GH #144 — it was written for the removed-upstream row in #96 and
 * deleted in that card's review 1 because `LibraryUpdate` carried no time for it
 * to say. It now does (`changedAt`).
 *
 * **Not `librarySkills.changedAgo`**, and deliberately not merged with it. That
 * one is Board 3's fact line, where a skill's last change is routinely months
 * old, so it abbreviates the near units (`45 min ago`, `2 h ago`) to leave room
 * and climbs to months and years. This one says the near units in full, because
 * §3 puts the age inside a sentence — `Removed on staging by MatteoB-adv 2 hours
 * ago.`, where `2 h ago` would read as an abbreviation in prose — and it stops at
 * weeks, because an upstream change Ply learnt of on the channel is a change
 * since the last refresh. Folding the two together would change words already
 * shipped on a skill's page, which is not this card.
 *
 * A negative age (a commit dated in the future, this Mac's clock behind the
 * branch's) is `just now` rather than a minus sign.
 */
export function agoWords(seconds: number): string {
  const scale: [number, string][] = [
    [604_800, "week"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, label] of scale) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${label}${count === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/**
 * What an upstream change means on this Mac, said per kind and action.
 *
 * GH #144: `ago` is the change's age in the board's words, or `null` when the
 * report carried no time. It is said once, in the clause that already says where
 * the change came from — `From staging, 2 hours ago.` — so every kind and action
 * gains it without the sentence being written out four more times.
 */
function updateBody(
  kind: ItemKind,
  action: string,
  branch: string,
  ago: string | null,
): string {
  const from = ago ? `From ${branch}, ${ago}.` : `From ${branch}.`;
  if (kind === "instructions") {
    // GH #101 review 1 (MAJOR): a Sync drains the queue and rebuilds Ply's own
    // mirror; it does not put the branch's AGENTS.md into the working tree, and a
    // skill's `--plugin-dir` has no equivalent for one. Only a pull does.
    // QoL 13.2 (D4): no pull in Plyloft; the Builder brings it here.
    return action === "removed"
      ? `${from} Once your project folder has it, the agents here stop reading it too — Ask the Builder to bring it here.`
      : `${from} Once your project folder has it, the agents here read it too — Ask the Builder to bring it here.`;
  }
  if (action === "removed") {
    return kind === "skill"
      ? `${from} New Claude tiles no longer load it from the branch.`
      : `${from} It is no longer in Knowledge › Shared · Project.`;
  }
  return kind === "skill"
    ? `${from} New Claude tiles load it.`
    : `${from} It is in Knowledge › Shared · Project.`;
}

/**
 * A refresh's toasts for the shared library: "other-mac added the note
 * “Auth flow”", what this Mac published, a pull request, a refusal.
 */
/**
 * Skills group B §2: the marker `shared_library_sync` puts in a skill publish
 * that was **not** committed because somebody else changed the skill on the
 * branch since the change began — the skill's twin of the instructions'
 * `NEVER_OVERRIDE_MARKER`. A contract across the two languages
 * (`libraryShell.test.ts`).
 */
export const SKILL_NEVER_OVERRIDE_MARKER = "Plyloft doesn't commit over a skill";
/** F3/F9 (team walk): `shared_config::BRANCH_MISSING_MARKER` — origin answered
 *  and the integration branch isn't there. Something to fix, never "offline". */
export const BRANCH_MISSING_MARKER = "isn't on GitHub any more";
/** T5: `platform::GIT_AUTH_WORDS` begins with it — git needed a sign-in it
 *  may not ask for, so the change waits on Setup › GitHub, not the network. */
export const GIT_SIGN_IN_MARKER = "Git couldn't sign in to GitHub";
/** `shared_config::REFUSED_MARKER`: the remote refused the push. */
export const REFUSED_MARKER = "refused the push";

export function libraryToasts(
  report: { moment: string; library?: LibraryReportLike | null },
  /** GH #144: the clock the ages are read against, so this stays a pure
   *  function of the report. */
  nowMs: number = Date.now(),
): Toast[] {
  const lib = report.library;
  if (!lib) return [];
  const toasts: Toast[] = [];
  const updates = lib.updates;
  const nowSecs = Math.floor(nowMs / 1000);
  /** A change's age in words, or `null` when the report carried no time. */
  const ageOf = (changedAt: number | null | undefined) =>
    changedAt != null ? agoWords(nowSecs - changedAt) : null;
  if (updates.length > 3) {
    const authors = [...new Set(updates.map((u) => u.author).filter(Boolean))];
    toasts.push({
      kind: "info",
      title: `${authors.join(", ") || "Someone"} changed ${updates.length} shared notes and skills`,
      body: `From ${lib.branch}.`,
    });
  } else {
    for (const u of updates) {
      toasts.push({
        kind: "info",
        title: `${u.author || "Someone"} ${u.action} ${what(u.kind, u.title)}`,
        body: updateBody(u.kind, u.action, lib.branch, ageOf(u.changedAt)),
      });
    }
  }
  for (const p of lib.published) {
    const over = p.over
      ? ` Replaced ${p.over.author ? `${p.over.author}’s` : "another"} version.`
      : "";
    // GH #101: an instructions publish carries the change's subject as its
    // title (`both CLIs read AGENTS.md`), not a name, so the toast says what it
    // published and the body says the rest.
    const subject =
      p.kind === "instructions" ? "the instructions" : what(p.kind, p.title, p.count ?? 1);
    toasts.push({
      kind: p.over ? "warn" : "info",
      title: `${p.removed ? "Removed" : "Published"} ${subject} ${p.removed ? "from" : "to"} ${lib.branch}`,
      body: `${over ? over.trim() + " " : ""}Your project folder is untouched.`,
    });
  }
  // GH #105 review 1: a copy the branch would not take is not a failure of the
  // commit that carried the rest — and it is not silence either. **One** toast for
  // all of them (review 2: a bulk copy of 34 raised 34), counting them in the
  // title and listing the reasons in the body, as `skippedLines` does for the
  // symlinks the branch carries.
  const notCopied = lib.notCopied ?? [];
  if (notCopied.length > 0) {
    toasts.push({
      kind: "warn",
      title:
        notCopied.length === 1
          ? "One skill was left as it is"
          : `${notCopied.length} skills were left as they are`,
      body: notCopied.join(" "),
    });
  }
  for (const waiting of lib.pullRequests) {
    const pr = waiting.pullRequest;
    // GH #160: a pull-request outcome for the instructions was announced by
    // nothing the member would recognise — the direct commit says `Publishing the
    // instructions` / `Published the instructions to staging`, and this said
    // `Waiting for PR #375 to merge` about a push that, in the never-override
    // case, was never made. It gets the pair's other half: the instructions by
    // name, the backend's own reason, and the one action the row offers.
    if (waiting.kind === "instructions") {
      // `reason` is a sentence for exactly one outcome — the file moved on the
      // branch, so Ply never asked it. For a refused push it is git's stderr
      // (`remote: error: GH006 …` from a protected branch, which is the common
      // team setup), and that is for the pull request's body, not for a toast
      // (review 1, MAJOR).
      const why = waiting.neverOverride
        ? waiting.reason
        : `${lib.branch} refused a direct push, so the instructions wait in a pull request.`;
      toasts.push({
        kind: "warn",
        title: `The instructions wait in pull request #${pr.number}`,
        body: `${why} They reach everyone once that is merged; your project folder is untouched.`,
        pullRequest: pr,
      });
      continue;
    }
    // Skills group B §2: a skill somebody changed upstream is never committed
    // over, and the toast says so in the backend's own sentence — "refused a
    // direct push" would be about a push that never happened.
    if (waiting.kind === "skill" && waiting.neverOverride) {
      toasts.push({
        kind: "warn",
        title: `“${waiting.title}” waits in pull request #${pr.number}`,
        body: `${waiting.reason} It reaches everyone once that is merged; your project folder is untouched.`,
        pullRequest: pr,
      });
      continue;
    }
    // A note's toast, and a skill's whose push was refused, are exactly as they
    // were.
    toasts.push({
      kind: "warn",
      title: `Waiting for PR #${pr.number} to merge`,
      body: `${lib.branch} refused a direct push, so “${waiting.title}” waits in a pull request.`,
    });
  }
  for (const title of lib.closed) {
    toasts.push({
      kind: "warn",
      title: "Pull request closed without merging",
      body: `“${title}” was dropped; the repository’s version is back.`,
    });
  }
  // GH #102: a push the branch refused with no pull request possible is the
  // read-only refusal, and it needs doing — so it moves to the error shape
  // (BOARDS.md §5) instead of a toast that says it once and goes.
  // `observeLibraryRefusal` puts the block on the Library page and
  // `announceError` raises the one toast that leads there; the
  // source-contract half of `src/lib/uxError.test.ts` fails if one grows back
  // here. `lib.error` still carries it, and stays a toast: it is retried on
  // the next Sync by itself and asks for nothing.
  if (lib.refused) {
    return toasts;
  }
  // GH #101 review 2 (MAJOR): a blocked instructions publish used to fall through
  // to the sentence below — the wrong noun ("note or skill") and the retry promise
  // the row had already dropped. Unlike `refused` it has no `announceError` toast
  // leading anywhere, so this is the one the member sees, and the backend's
  // sentence is the whole of it: waiting changes nothing, because the blob the
  // edit started from is not coming back.
  if (lib.blocked && report.moment === "publish") {
    toasts.push({
      kind: "warn",
      // Group B §2: a skill takes the same dead end, with its own noun.
      title: lib.blocked.includes(SKILL_NEVER_OVERRIDE_MARKER)
        ? "The skill wasn’t published"
        : "The instructions weren’t published",
      body: lib.blocked,
    });
    return toasts;
  }
  if (lib.error?.includes(BRANCH_MISSING_MARKER) && !lib.offline && report.moment === "publish") {
    toasts.push({
      kind: "warn",
      title: `Not published — ${lib.branch} isn't on GitHub`,
      body: `${lib.error} It stays here until then.`,
    });
    return toasts;
  }
  if (lib.error && !lib.offline && report.moment === "publish") {
    toasts.push({
      kind: "warn",
      title: "Shared note or skill not published yet",
      body: `${lib.error} It stays pending and is retried on the next Sync.`,
    });
  }
  return toasts;
}

/** A project skill row's shared-channel action. */
export function skillShareAction(
  state: LibraryStateLike | null,
  name: string,
  inCheckout: boolean,
): { publish: boolean; remove: boolean; onBranch: boolean; disabledReason: string | null } {
  if (!state || !state.shared) {
    return { publish: false, remove: false, onBranch: false, disabledReason: null };
  }
  const onBranch = state.branchSkills.includes(name);
  const disabledReason = state.readOnly
    ? `Needs write access to ${state.repository ?? "this repository"}.`
    : null;
  return { publish: inCheckout, remove: onBranch, onBranch, disabledReason };
}

/**
 * The personal Knowledge slices a refresh's settled promotions emptied — to
 * reload whether or not the Knowledge panel is open, so a reopened panel
 * never shows a note that is gone.
 */
export function promotionInvalidations(report: {
  library?: LibraryReportLike | null;
}): { scope: "global" | "workspace"; workspaceId: string | null }[] {
  const out: { scope: "global" | "workspace"; workspaceId: string | null }[] = [];
  for (const source of report.library?.promoted ?? []) {
    const slice = source.workspaceId
      ? { scope: "workspace" as const, workspaceId: source.workspaceId }
      : { scope: "global" as const, workspaceId: null };
    if (!out.some((o) => o.scope === slice.scope && o.workspaceId === slice.workspaceId)) {
      out.push(slice);
    }
  }
  return out;
}

/**
 * Claude gets skill `name` from the integration branch through Ply's
 * `project` plugin — the checkout has no `.claude/skills` copy (it may carry
 * only the Codex one), or a different one (a teammate updated it). The
 * badge's tooltip then, else `null`. Publishing still needs the checkout's
 * Claude copy.
 */
export function claudeFromBranch(
  state: LibraryStateLike | null,
  name: string,
  claudeInCheckout: boolean,
): string | null {
  if (!state?.shared || !(state.suppliedToCheckout ?? []).includes(name)) return null;
  const branch = state.branch ?? "the integration branch";
  return claudeInCheckout
    ? `${branch}'s version differs from your project folder's copy: Claude also gets it through Plyloft, as project:${name}`
    : `Claude loads this skill from ${branch} through Plyloft, as project:${name}`;
}
