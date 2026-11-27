// OB-15 (onboarding §9.2, §5 step 7, §8.2): the projects folder as Settings ›
// Account › Setup writes it. Pure, so node runs its test
// (`node --experimental-strip-types src/lib/projectsFolder.test.ts`); Setup's
// own folder step (OB-12) writes through the same two functions.

/** Where team workspaces were cloned, with nothing chosen, before 1.168.1
 *  (`team::legacy_clone_root`). Now they go to the projects folder, else its
 *  default `~/Projects` — unless team checkouts are already here
 *  (`team::effective_clone_root`). */
export const LEGACY_CLONE_ROOT = "~/code";

/**
 * A picked folder in tilde form (`~/Projects`), never expanded — the same
 * reason as `TeamSettings::clone_root`: the file moves between Macs and users.
 * Forward slashes on Windows too (`~/Projects`, which `team::expand_tilde`
 * reads), for a folder inside the home folder; a folder outside it is kept as
 * it was picked.
 */
export function tildeForm(picked: string, home: string | null): string {
  const path = picked.trim();
  if (!home) return path;
  const trim = (p: string) => p.replace(/[\\/]+$/, "");
  const h = trim(home);
  if (!h) return path;
  const windows = /^[A-Za-z]:[\\/]/.test(h) || h.includes("\\");
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const p = trim(path);
  if (same(p, h)) return "~";
  const head = p.slice(0, h.length);
  const sep = p.charAt(h.length);
  if (same(head, h) && (sep === "/" || sep === "\\")) {
    return `~/${p.slice(h.length + 1).replace(/\\/g, "/")}`;
  }
  return path;
}

/** What {@link cloneRootToKeep} reads of the team (`team_status`), or null
 *  when it could not be read. */
export interface TeamClonesView {
  teamRepo: string | null;
  workspaces: readonly { cloned: boolean; registered: boolean }[];
}

/**
 * What `team_status` says about the team's clones, or null when it can't be
 * trusted to say: a team named but its manifest unread — an `error`, or no
 * clone of the team repo to list the workspaces from — leaves `workspaces`
 * empty without meaning "none cloned" (Challenger P3-1).
 */
export function teamClonesFrom(
  status:
    | {
        teamRepo: string | null;
        hasClone: boolean;
        error: string | null;
        workspaces: readonly { cloned: boolean; registered: boolean }[];
        cloneRoot?: string | null;
      }
    | null
    | undefined,
): TeamClonesView | null {
  if (!status) return null;
  if (status.teamRepo && (status.error || !status.hasClone)) return null;
  return { teamRepo: status.teamRepo ?? null, workspaces: status.workspaces ?? [] };
}

/**
 * 1.168.1 (C3): where team workspaces resolve now, as `team_status` reports
 * it (an expanded path) — `team::effective_clone_root`, worked out from the
 * team's manifest on this machine. Trusted even when GitHub couldn't be
 * reached (an `error`, offline): the manifest is the local clone's. Not when
 * there is no clone of the team repo: then no manifest said which checkouts
 * to look for, and the root is only the default.
 */
export function reportedCloneRoot(
  status: { teamRepo: string | null; hasClone: boolean; cloneRoot?: string | null } | null | undefined,
): string | null {
  if (!status?.cloneRoot?.trim()) return null;
  if (status.teamRepo && !status.hasClone) return null;
  return status.cloneRoot.trim();
}

/**
 * The OB-1 review's safeguard (carried forward to OB-12, honoured here):
 * `team::clone_root` reads `team.cloneRoot`, then `projects.folder`, then the
 * legacy `~/code`. So with `team.cloneRoot` unset, writing a projects folder
 * moves where team workspaces are looked for — and the ones already cloned
 * would show as not cloned, and `Add` would clone a second copy.
 *
 * The clone root to write **first**, or null to write nothing: when
 * `team.cloneRoot` is unset and team workspaces are cloned or open where the
 * clone root points now (the current projects folder, else where the team
 * status says — `~/Projects`, or `~/code` while checkouts are there
 * ({@link reportedCloneRoot}) — else `~/code` as before 1.168.1), that
 * place is kept as the team's clone root. A team that could not be read, on
 * a Mac in team mode, keeps it too — pinning the place things already are
 * changes nothing, and guessing wrong the other way loses them.
 */
export function cloneRootToKeep(input: {
  cloneRoot: string | null | undefined;
  currentFolder: string | null | undefined;
  nextFolder: string;
  team: TeamClonesView | null;
  teamMode: boolean;
  /** {@link reportedCloneRoot} of the same team status. */
  reportedRoot?: string | null;
  /** The home folder, to keep the reported root in tilde form. */
  home?: string | null;
}): string | null {
  if (input.cloneRoot && input.cloneRoot.trim()) return null;
  const reported = input.reportedRoot?.trim();
  const now =
    input.currentFolder?.trim() || (reported ? tildeForm(reported, input.home ?? null) : LEGACY_CLONE_ROOT);
  if (now === input.nextFolder.trim()) return null;
  if (input.team === null) return input.teamMode ? now : null;
  if (!input.team.teamRepo) return null;
  return input.team.workspaces.some((w) => w.cloned || w.registered) ? now : null;
}
