// 1.174.0 (DR3): what the Release sheet reads, for its tests — an area's
// scope (`release_scope`), the audit, and the calls around them.
import type { ReleaseScope, ShipAuditReport } from "../ipc";
import type { Fixture } from "./tauri";

export const REL_NOW = Date.now();
const DAY = 86_400_000;

export function relScope(over: Partial<ReleaseScope> = {}): ReleaseScope {
  return {
    workspaceId: "ws-1",
    area: null,
    name: null,
    tagPrefix: "",
    targetBranch: "main",
    throughGithub: true,
    head: "7c1e9a2aa",
    fetchProblem: null,
    countProblem: null,
    partial: false,
    folder: "",
    sinceTag: "v3.0.1",
    sinceAt: REL_NOW - 12 * DAY,
    cards: [
      { cardId: "m1", title: "Privacy: list Google Cloud KMS", prNumber: 382, at: REL_NOW - 3 * DAY, commits: ["a1"] },
      { cardId: "m2", title: "Pricing page: add the viewport line", prNumber: 385, at: REL_NOW - 2 * DAY, commits: ["a2"] },
    ],
    cardsTotal: 2,
    otherChanges: [
      { sha: "o1", title: "Fix a typo in the footer", prNumber: null, author: "test-owner", at: REL_NOW - 4 * DAY },
    ],
    otherTotal: 1,
    readyCardIds: [],
    localAhead: 0,
    localBehind: 0,
    diverged: false,
    currentVersion: "3.0.1",
    versionSource: "package.json",
    fileVersion: "3.0.1",
    tagVersion: "3.0.1",
    versionOnGithub: true,
    versions: [
      { kind: "patch", version: "3.0.2", tag: "v3.0.2", taken: false },
      { kind: "minor", version: "3.1.0", tag: "v3.1.0", taken: false },
      { kind: "major", version: "4.0.0", tag: "v4.0.0", taken: false },
    ],
    refusal: null,
    inFlight: null,
    busy: false,
    ...over,
  };
}

export function relAudit(over: Partial<ShipAuditReport> = {}): ShipAuditReport {
  return {
    activeSwarms: [],
    activeIntakes: [],
    activeRunCount: 0,
    branch: "main",
    branchOk: true,
    targetBranch: "main",
    currentVersion: "3.0.1",
    suggestedNextVersion: "3.0.2",
    shipInFlight: false,
    pendingRelease: null,
    pendingRecordUnreadable: null,
    pendingElsewhere: null,
    releasesThroughPr: true,
    ...over,
  };
}

/** The sheet's reads, answered. */
export function releaseFixtures(scope: ReleaseScope = relScope(), audit: ShipAuditReport = relAudit()): Record<string, Fixture> {
  return {
    release_scope: scope,
    release_scopes: [scope],
    ship_audit: audit,
    project_config_get: null,
    deploy_map_get: {
      repo: null,
      railway: { state: "noCli", project: null, services: [], message: null, readAt: null },
      workflows: [],
    },
    workspace_ship_offers_pr: true,
    ship_pending_cards: [],
    ship_pending_count: 0,
    ship_unverified_count: 0,
    ship_pending_release: { release: null, unreadable: null },
  };
}
