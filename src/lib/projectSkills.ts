import type { CopyOutcome, CopyState, NotTheSameSkill, PromotedSkill } from "../ipc";

/**
 * v1.117.0 (team sharing rung 4): how the Project panel reads project skills
 * and the two moves between a repo and the team library.
 *
 * Here rather than in JSX for the reason `teamSkills.ts` is: these are rules
 * about the product, and rules get tests.
 *
 * The rule that shapes all of it: **no single directory serves both CLIs**.
 * Measured against Claude Code 2.1.267 and codex-cli 0.154.0 — Claude reads
 * `.claude/skills`, Codex reads `.agents/skills` and `.codex/skills`, and
 * neither reads the other's. So a copy always has two destinations, a row can
 * legitimately carry one badge, and "loaded" means both.
 */

/** The root Ply writes for Claude. Mirrors `project_skills::CLAUDE_ROOT`. */
export const CLAUDE_SKILL_ROOT = ".claude/skills";
/** The root Ply writes for Codex. Mirrors `project_skills::CODEX_ROOT`. */
export const CODEX_SKILL_ROOT = ".agents/skills";

/** Which direction a copy goes. */
export type CopyDirection = "promote" | "install";

/** What the button on a row says, and what pressing it means. */
export interface CopyAction {
  label: string;
  title: string;
  /** The destination holds something else: ask before overwriting it. */
  confirm: boolean;
  /** Nothing to do — render a chip instead of a button. */
  done: boolean;
}

/**
 * The button for one direction and one state.
 *
 * `partial` is deliberately **not** a confirm: some destination holds these
 * exact bytes and the rest hold nothing, so finishing the copy overwrites
 * nobody's work. That is the normal state of a half-finished move, and of a
 * skill that reached one vendor's root only.
 */
export function copyAction(
  direction: CopyDirection,
  state: CopyState,
  name: string,
): CopyAction {
  const verb = direction === "promote" ? "Promote" : "Install";
  const where =
    direction === "promote"
      ? "the team library"
      : `${CLAUDE_SKILL_ROOT} and ${CODEX_SKILL_ROOT}`;
  switch (state) {
    case "same":
      return {
        label: direction === "promote" ? "Shared" : "Installed",
        title:
          direction === "promote"
            ? `The team library already has this exact skill`
            : `This project already has this exact skill`,
        confirm: false,
        done: true,
      };
    case "partial":
      return {
        label: "Complete",
        title: `Copy ${name} into the half of ${where} that does not have it yet`,
        confirm: false,
        done: false,
      };
    case "differs":
      return {
        // Skills hub H3a (§14 Q16): an Install over a different copy is a
        // skill card that replaces it and records the link.
        label: direction === "promote" ? "Replace…" : "Link and update…",
        title: `${where} already has a different ${name}`,
        confirm: true,
        done: false,
      };
    case "absent":
      return {
        label: verb,
        title: `Copy ${name} into ${where}`,
        confirm: false,
        done: false,
      };
  }
}

/**
 * An Install or Promote rejection that is the different-bytes refusal —
 * `NotTheSameSkill`, a value — or `null` for anything else a rejection can be
 * (the plain string every other refusal is, an `Error` from the bridge).
 *
 * Pure and total: it reads fields, never words, so the Rust sentence can be
 * reworded without silently killing the Replace path.
 */
export function asNotTheSameSkill(cause: unknown): NotTheSameSkill | null {
  if (!cause || typeof cause !== "object") return null;
  const maybe = cause as Partial<NotTheSameSkill>;
  if (typeof maybe.notTheSameSkill !== "string" || typeof maybe.message !== "string") {
    return null;
  }
  return { notTheSameSkill: maybe.notTheSameSkill, message: maybe.message };
}

/** The sentence the Replace confirm asks. */
export function replaceConfirmBody(
  direction: CopyDirection,
  name: string,
  /** Walk follow-ups 2026-10-19 (Challenger): the row's note when the copy
   *  Replace shares isn't this checkout's (`SkillRow.promoteShares`) — said
   *  here too, so "your version" never promises the local edits. */
  shares?: string | null,
): string {
  if (direction === "promote" && shares) {
    return (
      `The team library already has a skill called ${name}, and it is not the same ` +
      `file. ${shares.replace(/`/g, "")} Replacing it pushes that copy to everyone on the team.`
    );
  }
  return direction === "promote"
    ? `The team library already has a skill called ${name}, and it is not the same ` +
        `file. Replacing it pushes your version to everyone on the team.`
    : `This project already has a skill called ${name}, and it is not the same file. ` +
        `Replacing it overwrites what is there; nothing is committed, so you can ` +
        `still review or discard it in Git.`;
}

/** Skills hub H3a (R2 edge): the question before an Install over a
 *  different, unlinked copy of the same name. */
export function linkAndUpdateConfirmBody(name: string): string {
  return (
    `This project already has a skill called ${name}, and it is not the same file. ` +
    `Link and update makes a card that replaces it with the team library's and ` +
    `links it. Nothing changes until the card ships, and the card shows the changes first.`
  );
}

/**
 * The line for skill roots git ignores, or null. Mirrors
 * `project_skills::gitignored_sentence` word for word, so the panel, the
 * toast and the doctor say the same thing.
 *
 * The walk that found this: `.claude/` ignored wholesale, Install wrote both
 * copies, the toast said "ship them with a card" — and a card could only ever
 * carry the Codex one.
 */
export function gitignoredLine(roots: string[]): string | null {
  if (roots.length === 0) return null;
  const one = roots.length === 1;
  const verb = one ? "is" : "are";
  const pronoun = one ? "it" : "them";
  const fix = roots
    .map((root) => {
      const slash = root.indexOf("/");
      return slash >= 0
        ? `${root.slice(0, slash)}/* then !${root}/`
        : `!${root}/`;
    })
    .join("; ");
  return (
    `${roots.join(" and ")} ${verb} gitignored in this repo — a card will not ` +
    `carry ${pronoun}, so card copies and teammates never get ` +
    `${one ? "that" : "those"} copy. Let Git see ${pronoun}: change .gitignore ` +
    `(for example ${fix}).`
  );
}

/**
 * GH #227: the line for roots git gave no answer for, or null — each with the
 * reason the backend gave (behind a link, inside a submodule, git took too
 * long, Ply stopped asking). Never a promise that a card carries them.
 */
export function unknownRootsLine(roots: { path: string; reason: string }[]): string | null {
  if (roots.length === 0) return null;
  const one = roots.length === 1;
  const reasons = [...new Set(roots.map((root) => root.reason))];
  const why =
    reasons.length === 1
      ? reasons[0]
      : roots.map((root) => `${root.path}: ${root.reason}`).join("; ");
  return (
    `Plyloft couldn't ask git whether ${roots.map((root) => root.path).join(" and ")} ` +
    `${one ? "is" : "are"} ignored (${why}) — check git status before you ship ` +
    `${one ? "that copy" : "those copies"} with a card.`
  );
}

/**
 * The Promote toast's body: where the library has it, and — N14 item 2 — that
 * the local changes weren't included when this checkout's copy differed from
 * the branch's (Promote shares the branch's committed copy).
 */
export function promoteToastBody(done: Pick<PromotedSkill, "pushed" | "plugin" | "leftOut">): string {
  const head = done.pushed
    ? `Both CLIs load it from the team library now, in the ${done.plugin} plugin.`
    : "The team's library on this Mac has it, but it isn't connected to GitHub, so nothing reached a teammate.";
  return done.leftOut ? `${head} ${done.leftOut}` : head;
}

/** The Install toast's body: where it went, and whether a card can ship it. */
export function installToastBody(
  outcome: Pick<CopyOutcome, "written" | "ignored"> & Partial<Pick<CopyOutcome, "unknown">>,
): string {
  const notes = [gitignoredLine(outcome.ignored), unknownRootsLine(outcome.unknown ?? [])]
    .filter((line): line is string => line !== null)
    .join(" ");
  if (outcome.written.length === 0) {
    const head = "Both native directories already held this exact skill.";
    return notes ? `${head} ${notes}` : head;
  }
  // QoL 13.1: only a folder that isn't a git repository is written straight
  // into, so there is no card to ship them with — they reach this folder's
  // own sessions.
  const head = `Written to ${outcome.written.join(" and ")}`;
  return notes
    ? `${head}. ${notes}`
    : `${head}. This folder isn't a git repository, so they reach the sessions here and nothing else.`;
}
