// Unit tests for the adoption banner words and guards (src/lib/adoption.ts,
// GH #81).
//
// Run: node --experimental-strip-types src/lib/adoption.test.ts

import {
  adoptionBanner,
  InFlight,
  LatestOnly,
  migrationToastNeeded,
  recordStatus,
  statusFor,
  type StatusBook,
  createdIssuesToast,
  creatingIssuesToast,
  OncePerSession,
  SHARE_QUESTION,
  BOARD_OFFER_TITLE,
  JOIN_BOARD_TITLE,
  CARDS_OFFER_TITLE,
  keptLocalRow,
  showKanbanBacking,
  ELSEWHERE_KEEP,
  ELSEWHERE_USE,
  keptOwnSetupRow,
  SOLO_REPO_BOARD,
  type AdoptionStatus,
} from "./adoption.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, msg = ""): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

const status = (
  action: AdoptionStatus["action"],
  over: Partial<AdoptionStatus> = {},
): AdoptionStatus => ({
  githubRepo: "o/lyra",
  hasDefinition: false,
  boardRepo: "o/lyra",
  action,
  ...over,
});


it("X2: a setup found on another branch is offered, keeping the folder's own first", () => {
  const view = adoptionBanner(
    status({ kind: "setupElsewhere", here: "walk-ux-1171", branch: "walk-1170-rel", name: "d1170-rel" }),
    true,
  );
  eq(view?.kind, "elsewhere");
  eq(view?.title, "This project has a shared setup on GitHub");
  eq(
    view?.body,
    "It was made for walk-1170-rel. This folder uses its own setup until you choose. Using it starts cards from walk-1170-rel and renames this project to match.",
  );
  eq([view?.keep, view?.move], ["Keep this folder's setup", "Use the shared setup"]);
  eq([ELSEWHERE_KEEP, ELSEWHERE_USE], ["Keep this folder's setup", "Use the shared setup"]);
  eq(view?.uses, [{ label: "Use the shared setup" }]);
  // D6 (owner walk 2026-10-28): plain words — no "branch", and not the
  // folder's own line of work.
  eq(/\bbranch/.test(`${view?.title} ${view?.body} ${view?.keep} ${view?.move}`), false);
  eq(`${view?.title} ${view?.body}`.includes("walk-ux-1171"), false);
  // B1 (walk 2026-10-27): never the project name the setup carries.
  eq(`${view?.title} ${view?.body}`.includes("d1170-rel"), false);
  const local = adoptionBanner(
    status({ kind: "setupElsewhere", here: "a", branch: "b", name: "n" }, { githubRepo: null }),
    true,
  );
  eq(local?.title, "This project has a shared setup");
  // A folder on no line of work at all reads the same.
  const detached = adoptionBanner(status({ kind: "setupElsewhere", here: null, branch: "b", name: "n" }), true);
  eq(detached?.body, "It was made for b. This folder uses its own setup until you choose. Using it starts cards from b and renames this project to match.");
});

it("B1: several setups found are named, one button each", () => {
  const view = adoptionBanner(
    status({ kind: "setupElsewhere", here: "main", branch: "a", name: "n", others: ["b", "c"] }),
    true,
  );
  eq(view?.title, "This project has shared setups on GitHub");
  eq(
    view?.body,
    "They were made for a, b and c. This folder uses its own setup until you choose. Using one starts cards from the one you pick and renames this project to match.",
  );
  eq(view?.uses, [
    { branch: "a", label: "Use the one for a" },
    { branch: "b", label: "Use the one for b" },
    { branch: "c", label: "Use the one for c" },
  ]);
  eq(/\bbranch/.test(`${view?.title} ${view?.body}`), false);
});

it("B1: solo mode says why a GitHub Issues board stays local", () => {
  const view = adoptionBanner(status({ kind: "soloBoardLocal" }), true);
  eq(view?.kind, "held");
  eq(view?.title, "This repository's board is on GitHub Issues");
  eq(view?.body, "While you work alone it stays on this Mac.");
  eq(SOLO_REPO_BOARD, "This repository's board is on GitHub Issues; while you work alone it stays on this Mac.");
  eq(view?.team, "Work with a team");
});

it("X2: after Keep, Settings offers the shared setup again", () => {
  eq(keptOwnSetupRow(status({ kind: "none" })), null);
  eq(keptOwnSetupRow(status({ kind: "none" }, { keptOwnSetup: "walk-1170-rel" }))?.uses, [
    { label: "Use the shared setup for walk-1170-rel" },
  ]);
  const several = keptOwnSetupRow(
    status({ kind: "none" }, { keptOwnSetup: "a", keptOwnSetupOthers: ["b"] }),
  );
  eq(several?.uses.map((u) => u.branch), ["a", "b"]);
  eq(
    several?.hint,
    "This folder keeps its own setup. The shared setups on GitHub were made for a and b; using one starts cards from the one you pick and renames this project to match.",
  );
  eq(
    keptOwnSetupRow(status({ kind: "none" }, { keptOwnSetup: "walk-1170-rel" }))?.hint,
    "This folder keeps its own setup. The shared setup on GitHub was made for walk-1170-rel; using it starts cards from walk-1170-rel and renames this project to match.",
  );
});

it("the question is the banner for ask", () => {
  const view = adoptionBanner(status({ kind: "ask" }), true);
  eq(view?.kind, "question");
  eq(view?.title, SHARE_QUESTION);
  eq(view?.body.includes("o/lyra"), true);
  eq(view?.body.includes("licence"), false);
});

it("the question says the board stays local without a licence", () => {
  const view = adoptionBanner(status({ kind: "ask" }), false);
  eq(view?.body.includes("stays local on this Mac"), true);
});

it("a held board says why", () => {
  const view = adoptionBanner(
    status({ kind: "boardHeld", reason: "needs a licence" }, { hasDefinition: true }),
    false,
  );
  eq(view, { kind: "held", title: "The board stays local on this Mac", body: "needs a licence" });
});

it("OB-8: a board only the free beta unlocks is offered, in Plyloft's words", () => {
  const view = adoptionBanner(
    status({ kind: "offerBoard", localCards: 3, cardsOnly: false }, { hasDefinition: true, boardRepo: "o/issues" }),
    true,
  );
  eq(view?.kind, "offer");
  eq(view?.title, BOARD_OFFER_TITLE);
  eq(view?.title, "Move this board to GitHub Issues?");
  eq(view?.body.includes("3 local cards become issues in o/issues"), true);
  eq(view?.body.includes("teammates see them"), true);
  eq(view?.body.includes("Plyloft changes nothing until you choose"), true);
  eq(view?.move, "Move to GitHub Issues");
  eq(view?.keep, "Keep it on this Mac");
  const one = adoptionBanner(status({ kind: "offerBoard", localCards: 1, cardsOnly: false }), true);
  eq(one?.body.includes("local card becomes an issue in o/lyra"), true);
  // The board is still Local here while the offer stands: its setting stays.
  eq(
    showKanbanBacking(
      status({ kind: "offerBoard", localCards: 0, cardsOnly: false }, { hasDefinition: true }),
      true,
      false,
    ),
    true,
  );
});

it("T1 (team walk 2026-10-02): the repository already on GitHub Issues reads as joining", () => {
  const offer = status({ kind: "offerBoard", localCards: 0, cardsOnly: false }, { hasDefinition: true, boardRepo: "o/issues" });
  const view = adoptionBanner(offer, true, null, "githubIssues");
  eq(view?.kind, "offer");
  eq(view?.title, JOIN_BOARD_TITLE);
  eq(view?.title, "The team's board is on GitHub Issues");
  eq(view?.move, "Use it here");
  eq(view?.body.includes("works from the issues in o/issues"), true);
  eq(view?.body.includes("Move"), false);
  const withCards = adoptionBanner(
    status({ kind: "offerBoard", localCards: 2, cardsOnly: false }, { hasDefinition: true, boardRepo: "o/issues" }),
    true,
    null,
    "githubIssues",
  );
  eq(withCards?.body.includes("2 local cards become issues in o/issues when you use it"), true);
  // A definition that still says local, or none read: the set-up words.
  eq(adoptionBanner(offer, true, null, "local")?.title, BOARD_OFFER_TITLE);
  eq(adoptionBanner(offer, true)?.title, BOARD_OFFER_TITLE);
});

it("OB-8 review 2: only local cards waiting is its own question", () => {
  const view = adoptionBanner(
    status({ kind: "offerBoard", localCards: 2, cardsOnly: true }, { hasDefinition: true }),
    true,
  );
  eq(view?.title, CARDS_OFFER_TITLE);
  eq(view?.title, "Move this Mac's local cards to GitHub Issues?");
  eq(view?.body.includes("The board is GitHub Issues already"), true);
  eq(view?.move, "Move them to GitHub Issues");
  eq(view?.keep, "Keep them on this Mac");
});

it("OB-8 review 2: kept on this Mac is said on Board, never on the board banner", () => {
  const kept = status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: false }, { hasDefinition: true });
  eq(adoptionBanner(kept, true), null);
  eq(showKanbanBacking(kept, true, false), true, "the backing setting stays");
  const row = keptLocalRow(kept);
  eq(row?.label, "Kept on this Mac");
  eq(row?.move, "Move to GitHub Issues");
  eq(row?.hint.includes("o/lyra"), true);
  const cards = status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: true }, { hasDefinition: true });
  eq(keptLocalRow(cards)?.move, "Move them to GitHub Issues");
  eq(showKanbanBacking(cards, true, true), false, "the board is the repository's");
  eq(keptLocalRow(status({ kind: "none" })), null);
});

it("R14: a repository whose board is Local: no banner; Board names it and asks first", () => {
  const local = { ...status({ kind: "none" }, { hasDefinition: true }), repoBoard: "local" as const };
  eq(adoptionBanner(local, true), null);
  eq(adoptionBanner(local, false), null);
  const row = keptLocalRow(local, true);
  eq(row?.label, "Local board");
  eq(row?.hint.startsWith("This repository's board is Local."), true);
  eq(row?.hint.includes("The team's board"), false);
  eq(row?.move, "Move to GitHub Issues");
  eq(row?.cardsOnly, false);
  eq(
    row?.confirm?.body,
    "Moving the board to GitHub Issues changes it for everyone who opens this repository.",
  );
  // A "Keep it on this Mac" given before: the same row, in the same words.
  const kept = {
    ...status({ kind: "boardKeptLocal", localCards: 2, cardsOnly: false }, { hasDefinition: true }),
    repoBoard: "local" as const,
  };
  eq(keptLocalRow(kept, true)?.hint, row?.hint);
  // A Mac that may not run GitHub Issues gets no move.
  eq(keptLocalRow(local, false), null);
  // The repository's board is GitHub Issues: the kept row keeps its words.
  const team = { ...kept, repoBoard: "githubIssues" as const };
  eq(keptLocalRow(team, true)?.label, "Kept on this Mac");
  eq(keptLocalRow(team, true)?.confirm, undefined);
});

it("no banner otherwise", () => {
  eq(adoptionBanner(null, true), null);
  eq(adoptionBanner(status({ kind: "none" }), true), null);
  eq(adoptionBanner(status({ kind: "convertLegacy" }), true), null);
});

it("the progress and result toasts count issues", () => {
  eq(creatingIssuesToast(5).title, "Creating 5 issues…");
  eq(creatingIssuesToast(1).title, "Creating 1 issue…");
  eq(createdIssuesToast("o/lyra", { pushed: 5, failed: 0 }).title, "Created 5 issues on o/lyra");
  const partial = createdIssuesToast(null, { pushed: 1, failed: 1 });
  eq(partial.kind, "warn");
  eq(partial.title, "Created 1 issue; 1 failed");
});

it("kanban backing disappears for a GitHub repo with a definition", () => {
  const shared = status({ kind: "none" }, { hasDefinition: true });
  eq(showKanbanBacking(shared, true, true), false);
  eq(showKanbanBacking(shared, true, false), false);
  // No remote: it stays.
  eq(showKanbanBacking({ ...shared, githubRepo: null }, true, false), true);
  // No definition yet: it stays.
  eq(showKanbanBacking(status({ kind: "ask" }), true, false), true);
  // Lapsed licence on a GitHub board: the escape stays.
  eq(showKanbanBacking(shared, false, true), true);
  eq(showKanbanBacking(null, true, true), true);
});

it("automatic steps run once per workspace per session", () => {
  const once = new OncePerSession();
  eq(once.claim("ws1:switch"), true);
  eq(once.claim("ws1:switch"), false);
  eq(once.claim("ws2:switch"), true);
});

it("a status is only used for the workspace it was read for", () => {
  const a = status({ kind: "switchBoard", localCards: 3 });
  const book = recordStatus({}, "A", a);
  eq(statusFor(book, "A"), a);
  eq(statusFor(book, "B"), null);
  eq(statusFor({}, "A"), null);
  eq(statusFor(book, null), null);
});

it("only each workspace's newest status request's answer is kept", () => {
  const latest = new LatestOnly();
  const first = latest.begin("A");
  const second = latest.begin("A");
  eq(latest.isLatest("A", first), false);
  eq(latest.isLatest("A", second), true);
});

it("an operation finishing in A after B's request doesn't hide B's status", () => {
  const latest = new LatestOnly();
  let book: StatusBook = {};
  // The board shows B and asks for its status…
  const forB = latest.begin("B");
  // …while Share, started in A, finishes and reloads A's status.
  const forA = latest.begin("A");
  const aStatus = status({ kind: "none" }, { hasDefinition: true });
  const bStatus = status({ kind: "ask" }, { githubRepo: "o/climbr" });
  if (latest.isLatest("A", forA)) book = recordStatus(book, "A", aStatus);
  if (latest.isLatest("B", forB)) book = recordStatus(book, "B", bStatus);
  eq(statusFor(book, "B"), bStatus);
  eq(adoptionBanner(statusFor(book, "B"), true)?.kind, "question");
  eq(statusFor(book, "A"), aStatus);
});

it("migrateCards shows no banner, and an empty migration no toast", () => {
  eq(adoptionBanner(status({ kind: "migrateCards", localCards: 2 }), true), null);
  eq(migrationToastNeeded({ pushed: 0, failed: 0 }), false);
  eq(migrationToastNeeded({ pushed: 0, failed: 1 }), true);
});

it("a failed switch offers a retry and keeps the backing control", () => {
  const pending = status({ kind: "switchBoard", localCards: 2 }, { hasDefinition: true });
  eq(adoptionBanner(pending, true), null);
  eq(adoptionBanner(pending, true, "label create failed"), {
    kind: "retry",
    title: "Couldn't switch the board to GitHub Issues",
    body: "label create failed",
  });
  eq(showKanbanBacking(pending, true, false), true);
});

it("an in-flight step runs once at a time and again after it finished", () => {
  const steps = new InFlight();
  eq(steps.start("ws1:migrate"), true);
  eq(steps.start("ws1:migrate"), false);
  eq(steps.has("ws1:migrate"), true);
  eq(steps.start("ws2:migrate"), true);
  steps.finish("ws1:migrate");
  eq(steps.has("ws1:migrate"), false);
  eq(steps.start("ws1:migrate"), true, "a later cycle migrates again");
});

if (failed > 0) {
  console.error(`adoption.test.ts: ${failed} failed, ${passed} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`adoption.test.ts: ${passed} passed`);
