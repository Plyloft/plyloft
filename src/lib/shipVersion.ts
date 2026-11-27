/** A ship's version as the app says it; null when the land recorded none
 *  (a Land with no version files records "unknown" — Skills hub H3a walk:
 *  "Shipped in vunknown"). The card page, the Board tile, the ship history
 *  and the release toasts all say a version through this one rule. */
export function shippedWords(version: string | null | undefined): string | null {
  const v = (version ?? "").trim();
  if (!v || v === "unknown") return null;
  return v.startsWith("v") ? v : `v${v}`;
}

/** 1.173.0 (B4): one ship entry as the app says it — its release's own tag
 *  (`site-v3.0.2` for an area's), else its version as before. */
export function shipEntryWords(entry: { shippedVersion: string; tag?: string | null }): string | null {
  return entry.tag?.trim() || shippedWords(entry.shippedVersion);
}

/** 1.173.0 (B4): a release tag as the backend makes it (`areas::tag_for`):
 *  `v1.2.3` without areas and for the first area, `site-v1.2.3` for another. */
export function releaseTag(prefix: string | null | undefined, version: string): string {
  return `${prefix ?? ""}v${version.trim().replace(/^v/, "")}`;
}

/** 1.173.0 (B4): the line under a release's Version field — of the area
 *  when the repository has areas (`audit.area.name`), else `subject` ("This
 *  repository", "This project") exactly as before areas. */
export function auditVersionLine(
  audit: {
    versionSource?: string | null;
    versionOnGithub?: boolean;
    currentVersion: string;
    targetBranch?: string | null;
    area?: { name: string | null; tagPrefix: string } | null;
  },
  subject: string,
): string {
  const who = audit.area?.name ?? subject;
  const at = releaseTag(audit.area?.tagPrefix, audit.currentVersion);
  if (audit.versionSource === null) return `${who} has no version yet; the first one is suggested.`;
  if (audit.versionOnGithub) return `On GitHub, ${audit.targetBranch ?? "main"} is at ${at}; the next one is suggested.`;
  return `${who} is at ${at}; the next one is suggested.`;
}

interface ShipEntryLike {
  commitSha: string;
  shippedVersion: string;
  shippedAt: number;
  releaseKind: string;
  tag?: string | null;
}

/**
 * 1.174.0 (DR2 round 1): the card's own ship — the entry at its commit, or
 * at its pull request's merge commit — not a later release that carried it
 * (Release Site… adds an entry with its tag to the cards already on main,
 * D1(b)). The newest such; else the last entry, as before.
 */
export function ownShipEntry<E extends ShipEntryLike>(card: {
  commitSha?: string | null;
  prUrl?: string | null;
  pr?: { mergeCommit?: string | null } | null;
  shipHistory?: readonly E[] | null;
}): E | null {
  const history = card.shipHistory ?? [];
  const merge = card.prUrl ? card.pr?.mergeCommit?.trim() || null : null;
  for (let i = history.length - 1; i >= 0; i--) {
    const sha = history[i].commitSha;
    if (sha && (sha === card.commitSha || sha === merge)) return history[i];
  }
  return history[history.length - 1] ?? null;
}

/** 1.174.0 (DR2 round 1): the newest release the card is in ("In
 *  site-v3.0.2"): the latest entry with a tag, or null. */
export function latestTaggedEntry<E extends ShipEntryLike>(card: { shipHistory?: readonly E[] | null }): E | null {
  const history = card.shipHistory ?? [];
  let best: E | null = null;
  for (const e of history) if (e.tag?.trim() && (!best || e.shippedAt >= best.shippedAt)) best = e;
  return best;
}
