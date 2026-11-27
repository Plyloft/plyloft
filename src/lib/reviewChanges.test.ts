// G4 (launch D8): a card's requested changes go to its follow-up swarm only
// when it ran a swarm; a Builder card's go into its Builder session.
import assert from "node:assert/strict";
import type { KanbanCard } from "../ipc.ts";
import { CHANGES_NEXT, changesRoute, changesSentStands, laterRequestsOf, latestSnapshotN, notRightWords, sendChangesToBuilder, type ChangesDeps } from "./reviewChanges.ts";

const builder = { vendor: "claude" } as unknown as KanbanCard["builder"];
assert.equal(changesRoute({ linkedSwarmId: "s1", builder: null }), "swarm", "a swarm card keeps its follow-up");
assert.equal(changesRoute({ linkedSwarmId: "s1", builder }), "swarm");
assert.equal(changesRoute({ linkedSwarmId: null, builder }), "builder", "a Builder card: never a new swarm");
assert.equal(changesRoute({ linkedSwarmId: null, builder: null }), "none");
const snaps = (...ns: number[]) => ({ vendor: "claude", snapshots: ns.map((n) => ({ n, sha: "s", at: n })) }) as unknown as KanbanCard["builder"];
assert.equal(latestSnapshotN({ builder: snaps(1, 3, 2) }), 3);
assert.equal(latestSnapshotN({ builder: null }), 0);
assert.equal(changesSentStands({ builder: snaps(1, 2), archived: false }, 2), true, "no newer snapshot: held");
assert.equal(changesSentStands({ builder: snaps(1, 2, 3), archived: false }, 2), false, "Build done made one: over");
assert.equal(changesSentStands({ builder: snaps(1), archived: false }, undefined), false, "nothing sent");
assert.equal(changesSentStands({ builder: snaps(1), archived: true }, 1), false);
assert.match(CHANGES_NEXT, /say so in one line and stop; the person presses Finish and check/);
assert.match(notRightWords("builder").button, /the Builder/);
assert.match(notRightWords("builder").placeholder, /the Builder picks it up in its session/);
assert.match(notRightWords("builder").title, /the Builder/);
assert.equal(notRightWords("swarm").button, "Not right — tell them what's wrong");
assert.match(notRightWords("swarm").placeholder, /the agents/);
assert.match(notRightWords("swarm").title, /the agents/);

function deps(over: Partial<ChangesDeps> = {}) {
  const log: string[] = [];
  const sent: string[] = [];
  const d: ChangesDeps = {
    gather: async () => "# Review feedback\n\n## Change requested\n\nThe button is the wrong colour.",
    sessionOpen: () => true,
    sessionRecorded: () => true,
    resume: async () => {
      log.push("resume");
    },
    reveal: () => log.push("reveal"),
    waitForSession: async () => true,
    deliver: (text) => {
      sent.push(text);
      return Promise.resolve();
    },
    notify: (kind, title) => log.push(`${kind}:${title}`),
    ...over,
  };
  return { d, log, sent };
}

async function main() {
  {
    // An open session: pasted now, with what to do next.
    const { d, log, sent } = deps();
    assert.equal(await sendChangesToBuilder(d), "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /wrong colour/);
    assert.ok(sent[0].endsWith(CHANGES_NEXT));
    assert.deepEqual(log, ["reveal", "info:Sent to the Builder"]);
  }
  {
    // A closed session is resumed first, then the changes go in.
    let open = false;
    const { d, log, sent } = deps({
      sessionOpen: () => open,
      sessionRecorded: () => false,
      resume: async () => {
        log.push("resume");
        open = true;
      },
    });
    assert.equal(await sendChangesToBuilder(d), "sent");
    assert.equal(log[0], "resume");
    assert.equal(sent.length, 1);
  }
  {
    // A resume that fails sends nothing and says so.
    const { d, log, sent } = deps({
      sessionOpen: () => false,
      sessionRecorded: () => false,
      resume: async () => {
        throw new Error("no worktree");
      },
    });
    assert.equal(await sendChangesToBuilder(d), "failed");
    assert.equal(sent.length, 0);
    assert.deepEqual(log, ["error:Nothing was sent to the Builder"]);
  }
  {
    // Held for the prompt: said, and still "sent" once written.
    const { d, log } = deps({
      deliver: (_t, onQueued) => {
        onQueued();
        return Promise.resolve();
      },
    });
    assert.equal(await sendChangesToBuilder(d), "sent");
    assert.ok(log.includes("info:Queued for the Builder"));
  }
  {
    // No session attached at the write: nothing sent.
    const { d } = deps({ deliver: () => null });
    assert.equal(await sendChangesToBuilder(d), "failed");
  }
  console.log("reviewChanges: all assertions passed");
}

void main();

// 1.172.0 (A1): what the person asked is kept on the card: Not right as its
// words, Request changes with the file named; empty words are dropped.
assert.deepEqual(
  laterRequestsOf([
    { path: "", feedback: "  also add a comment  " },
    { path: "src/a.ts", feedback: "name it after what it holds" },
    { path: "src/b.ts", feedback: "   " },
  ]),
  [
    { text: "also add a comment", source: "notRight" },
    { text: "src/a.ts: name it after what it holds", source: "changes" },
  ],
);
