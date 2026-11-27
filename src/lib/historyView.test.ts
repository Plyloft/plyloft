// QoL 11.1: History's tabs, filters and numbers. Run with
// `node --experimental-strip-types src/lib/historyView.test.ts`.
import assert from "node:assert/strict";
import type { ActivityRow } from "../ipc.ts";
import {
  agentRunWords,
  builderWords,
  checksWords,
  countWords,
  filterHistoryRows,
  historyNumbers,
  historyTabOf,
  rowOpens,
  shippedWords,
  tabCountWords,
  tabCut,
  textMatches,
} from "./historyView.ts";

function row(over: Partial<ActivityRow> & Pick<ActivityRow, "id" | "kind" | "state">): ActivityRow {
  return {
    title: over.id,
    detail: "",
    workspaceId: "a",
    workspaceName: "Alpha",
    cardId: null,
    runId: null,
    at: 1,
    count: 1,
    ...over,
  };
}

const rows: ActivityRow[] = [
  row({ id: "Login fix", kind: "ship", state: "shipped", cardId: "c1", count: 3, detail: "v1.2 · abc · no checks set up" }),
  row({ id: "Search box", kind: "ship", state: "shipped", cardId: "c2", workspaceId: "b", workspaceName: "Beta" }),
  row({ id: "Search box", kind: "verify", state: "passed", cardId: "c2", workspaceId: "b", workspaceName: "Beta", count: 2 }),
  row({ id: "Header", kind: "verify", state: "failed", cardId: "c3" }),
  row({ id: "Notes counter", kind: "verify", state: "no_checks", cardId: "c4" }),
  row({ id: "Login fix", kind: "build", state: "built", cardId: "c1", count: 4 }),
  row({ id: "Nightly", kind: "run", state: "failed", runId: "r1" }),
  row({ id: "Swarm", kind: "swarm", state: "max_iter" }),
  row({ id: "Pick an API", kind: "discussion", state: "completed" }),
  row({ id: "Worktree trash: 1 GB freed", kind: "cleanup", state: "done" }),
];

// Every kind has its tab; Builder rounds are runs.
assert.equal(historyTabOf("build"), "runs");
assert.equal(historyTabOf("swarm"), "runs");
assert.equal(historyTabOf("verify"), "checks");
assert.equal(historyTabOf("cleanup"), "cleanup");

// The numbers are the rows'.
const n = historyNumbers(rows);
assert.deepEqual(n.perTab, { runs: 3, ships: 2, checks: 3, discussions: 1, cleanup: 1 });
assert.deepEqual([n.agentRuns, n.agentFailed], [2, 2], "a failed run and a swarm that hit the step limit");
assert.equal(agentRunWords(n), "2, 2 failed");
assert.equal(agentRunWords({ agentRuns: 3, agentFailed: 0 }), "3");
assert.deepEqual([n.builderRounds, n.builderCards], [4, 1]);
assert.equal(builderWords(n), "1 card, 4 rounds");
assert.equal(n.shippedCards, 2);
assert.equal(n.ships, 4);
assert.equal(shippedWords(n), "4 times, 2 cards");
assert.equal(shippedWords({ ships: 1, shippedCards: 1 }), "1");
assert.deepEqual([n.checksPassedCards, n.checkedCards], [1, 2], "no checks set up is not a check run");
assert.equal(checksWords(n), "1 of 2 cards passed their latest checks");
assert.equal(n.noChecksCards, 1);
const tabOf = (checks: number) => ({ perTab: { checks } });
assert.equal(checksWords({ checksPassedCards: 0, checkedCards: 0, noChecksCards: 0, ...tabOf(0) }), "None run");
assert.equal(checksWords({ checksPassedCards: 1, checkedCards: 1, noChecksCards: 0, ...tabOf(1) }), "1 of 1 card passed their latest checks");
// 1.174.0 (TX1, T6; WALK 14): the tab's rows all had no checks set up — say
// so in the card's words, never "None run" beside a tab that lists them.
{
  const none = historyNumbers([
    row({ id: "A", kind: "verify", state: "no_checks", cardId: "a" }),
    row({ id: "B", kind: "verify", state: "no_checks", cardId: "b" }),
  ]);
  assert.equal(none.perTab.checks, 2);
  assert.equal(checksWords(none), "None set up on these cards");
  assert.equal(checksWords(historyNumbers([])), "None run");
}
// 1.174.0 (TX1, T5; WALK 14): Builder rounds' cards and the other AI runs
// add up to the Runs tab's number.
{
  const runsTab = rows.filter((r) => historyTabOf(r.kind) === "runs");
  assert.equal(n.builderCards + n.agentRuns, n.perTab.runs);
  assert.equal(n.perTab.runs, runsTab.length);
  const builderOnly = historyNumbers(
    Array.from({ length: 9 }, (_, i) => row({ id: `Card ${i}`, kind: "build", state: "built", cardId: `c${i}` })),
  );
  assert.equal(builderOnly.builderCards + builderOnly.agentRuns, builderOnly.perTab.runs);
  assert.equal(builderWords(builderOnly), "9 cards, 9 rounds");
  assert.equal(agentRunWords(builderOnly), "0");
  // A folded build row (count 3) is one card of three rounds: the Runs tab
  // counts the card once, as the Builder fact does.
  const folded = historyNumbers([
    row({ id: "Login fix", kind: "build", state: "built", cardId: "c1", count: 3 }),
    row({ id: "Search", kind: "build", state: "built", cardId: "c2" }),
    row({ id: "Nightly", kind: "run", state: "done", runId: "r1" }),
    row({ id: "Swarm", kind: "swarm", state: "done" }),
  ]);
  assert.equal(folded.perTab.runs, 4);
  assert.equal(builderWords(folded), "2 cards, 4 rounds");
  assert.equal(agentRunWords(folded), "2");
  assert.equal(folded.builderCards + folded.agentRuns, folded.perTab.runs);
}

// The filter: one workspace, typed words; the numbers follow it.
const beta = filterHistoryRows(rows, { workspaceId: "b", text: "" });
assert.deepEqual(beta.map((r) => r.kind), ["ship", "verify"]);
assert.equal(historyNumbers(beta).perTab.ships, 1);
assert.deepEqual(
  filterHistoryRows(rows, { workspaceId: null, text: "login" }).map((r) => r.kind),
  ["ship", "build"],
);
assert.deepEqual(filterHistoryRows(rows, { workspaceId: null, text: "beta search" }).length, 2, "every word, any field");
assert.equal(filterHistoryRows(rows, { workspaceId: "a", text: "beta" }).length, 0);
assert.equal(textMatches("  ", "x"), true);
assert.equal(textMatches("NO CHECKS", "v1 · no checks set up"), true);

// Folded rows say how many; a card's checks show their latest of several.
assert.equal(countWords(rows[2]), "last of 2 runs");
assert.equal(countWords(rows[3]), null);
assert.equal(countWords(rows[0]), "3 times");
assert.equal(countWords(rows[1]), null);
assert.equal(countWords(rows[5]), "4 rounds");
assert.equal(countWords(row({ id: "x", kind: "build", state: "running", count: 0 })), null);
assert.equal(countWords(row({ id: "x", kind: "build", state: "built", count: 1 })), "1 round");
// An older feed without `count` reads as one.
assert.equal(countWords({ kind: "ship", count: undefined }), null);

// A tab's number: every row it has before the cap; under a text filter the
// matches among those listed, "+" when the tab was cut.
assert.equal(tabCountWords(200, 200, 512, false), "512");
assert.equal(tabCountWords(3, 3, 3, false), "3");
assert.equal(tabCountWords(3, 3, undefined, false), "3", "an older backend sends no totals");
assert.equal(tabCountWords(7, 200, 512, true), "7+");
assert.equal(tabCountWords(2, 3, 3, true), "2");
assert.equal(tabCut(200, 512), true);
assert.equal(tabCut(3, 3), false);
assert.equal(tabCut(3, undefined), false);

// What a row opens.
assert.equal(rowOpens(rows[0]), "card");
assert.equal(rowOpens(rows[6]), "run");
assert.equal(rowOpens(rows[7]), null);

console.log("historyView: tabs, filters and numbers passed");
