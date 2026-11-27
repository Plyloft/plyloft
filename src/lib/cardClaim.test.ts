import assert from "node:assert/strict";
import {
  cardClaimState,
  cardInWorkspace,
  claimBeforeStart,
  claimChipLabel,
  claimMenuLabel,
  isOwnPullRequest,
  mergedPrLine,
  deviceStepBeforeStart,
  otherDeviceReading,
  otherDeviceSheet,
  otherDeviceWords,
  TAKE_OVER_FAILED,
  claimedAndStartedMessage,
  claimedByOthersWord,
  claimedByOthersHere,
  issueAuthorWords,
  linkedPullRequestState,
  linkedPullRequestWords,
  openPullRequestOf,
  secondClaimBody,
  secondClaimPullRequest,
  hasLocalRun,
  notStarted,
  startBuildClaimTitle,
  secondClaimMessage,
  startBuildWithClaim,
  archiveNameKeptNotice,
  archivedNotice,
  movedBackNotice,
  nameComesOffSentence,
  nameOffSentence,
  ownNameComesOff,
  startStoppedNotice,
  raceSheet,
  sharedClaimLine,
} from "./cardClaim.ts";

// ── Header / tile state: none, mine, someone else's ──────────────────

assert.deepEqual(cardClaimState(undefined, "me"), { kind: "none" });
assert.deepEqual(cardClaimState([], "me"), { kind: "none" });
assert.deepEqual(cardClaimState([""], null), { kind: "none" });
assert.equal(claimChipLabel(cardClaimState([], "me")), null, "Claim shows instead");

// U3: the ⋯'s claim.
{
  const open = { githubIssues: true, writable: true };
  const free = { ghIssueNumber: 7, columnId: "todo" };
  assert.equal(claimMenuLabel(free, "me", open), "Claim");
  assert.equal(claimMenuLabel({ ...free, ghAssignees: ["ana"] }, "me", open), "Claim it too…");
  assert.equal(claimMenuLabel({ ...free, ghAssignees: ["ME"] }, "me", open), null, "already mine");
  assert.equal(claimMenuLabel({ columnId: "todo" }, "me", open), null, "no issue");
  assert.equal(claimMenuLabel(free, "me", { githubIssues: false, writable: true }), null, "local board");
  assert.equal(claimMenuLabel(free, "me", { githubIssues: true, writable: false }), null, "read-only board");
  assert.equal(claimMenuLabel({ ...free, archived: true }, "me", open), null, "archived");
  assert.equal(claimMenuLabel({ ...free, columnId: "complete" }, "me", open), null, "done");
}

assert.deepEqual(cardClaimState(["Me"], "me"), { kind: "mine" });
// 1.175.0 (D1): mine still wins, and the teammates on it too are named.
assert.deepEqual(cardClaimState(["test-owner", "me"], "ME"), { kind: "mine", others: ["test-owner"] });
assert.equal(claimChipLabel(cardClaimState(["test-owner", "me"], "ME")), "Claimed by you and test-owner");
assert.equal(claimChipLabel(cardClaimState(["a", "me", "b"], "me")), "Claimed by you and a, b");
assert.equal(claimChipLabel({ kind: "mine" }), "Claimed by you");

const others = cardClaimState(["test-owner"], "macbook-user");
assert.deepEqual(others, { kind: "others", logins: ["test-owner"] });
assert.equal(claimChipLabel(others), "Claimed by test-owner");

// An unknown login never claims the card is mine.
assert.deepEqual(cardClaimState(["test-owner"], null), {
  kind: "others",
  logins: ["test-owner"],
});
assert.equal(
  claimChipLabel(cardClaimState(["a", "b"], "c")),
  "Claimed by a, b",
);

// ── The confirm text for a second claim ─────────────────────────────

assert.equal(
  secondClaimMessage(["test-owner"]),
  "Already claimed by test-owner. Claim it too?",
);
assert.equal(secondClaimMessage(["a", "b"]), "Already claimed by a, b. Claim it too?");

// ── Claims act on the card of the right workspace ───────────────────

const byWorkspace = {
  "ws-app": { cards: [{ id: "gh-issue-62", repo: "o/app" }] },
  "ws-site": { cards: [{ id: "gh-issue-62", repo: "o/site" }] },
};
assert.equal(cardInWorkspace(byWorkspace, "ws-site", "gh-issue-62")?.repo, "o/site");
assert.equal(cardInWorkspace(byWorkspace, "ws-app", "gh-issue-62")?.repo, "o/app");
assert.equal(cardInWorkspace(byWorkspace, "ws-other", "gh-issue-62"), null);
assert.equal(cardInWorkspace(byWorkspace, "ws-app", "gh-issue-63"), null);

console.log("cardClaim: ok");

// ── GH #117: Start build claims an unassigned issue in the same press ──

type Holder = import("./cardClaim.ts").IssueHolder;

function fakeClaimDeps(holder: Holder, raceTo?: Holder, confirm = false) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      readHolder: async () => holder,
      claim: async (confirmed: boolean) => {
        calls.push(`claim:${confirmed}`);
        if (raceTo && !confirmed) return { claimed: false, holder: raceTo };
        return { claimed: true, holder };
      },
      confirmSecondClaim: async (logins: string[]) => {
        calls.push(`ask:${logins.join(",")}`);
        return confirm;
      },
    },
  };
}

async function claimTests() {
  // Unassigned: claimed, then the start says so.
  {
    const f = fakeClaimDeps({ kind: "unclaimed" });
    assert.equal(await claimBeforeStart(f.deps, true), "claimed");
    assert.deepEqual(f.calls, ["claim:false"]);
  }
  // A move to In Progress (no auto-claim) leaves an unassigned issue alone.
  {
    const f = fakeClaimDeps({ kind: "unclaimed" });
    assert.equal(await claimBeforeStart(f.deps, false), "go");
    assert.deepEqual(f.calls, []);
  }
  // Mine: nothing to do.
  {
    const f = fakeClaimDeps({ kind: "mine" });
    assert.equal(await claimBeforeStart(f.deps, true), "go");
    assert.deepEqual(f.calls, []);
  }
  // Someone else's: asks once, naming them; declined → no claim, no start.
  {
    const f = fakeClaimDeps({ kind: "others", logins: ["octo"] });
    assert.equal(await claimBeforeStart(f.deps, true), "cancel");
    assert.deepEqual(f.calls, ["ask:octo"]);
  }
  // Claimed by someone between the read and the claim: asks, not claimed.
  {
    const f = fakeClaimDeps({ kind: "unclaimed" }, { kind: "others", logins: ["octo"] });
    assert.equal(await claimBeforeStart(f.deps, true), "cancel");
    assert.deepEqual(f.calls, ["claim:false", "ask:octo"]);
  }
  // The live read failing lets the backend gate decide.
  {
    const f = fakeClaimDeps({ kind: "unclaimed" });
    f.deps.readHolder = async () => {
      throw new Error("offline");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await claimBeforeStart(f.deps, true), "go");
    } finally {
      console.warn = warn;
    }
  }

  // startBuildWithClaim: one message per outcome.
  type Notice = import("./cardClaim.ts").StartNotice;
  const run = async (
    claim: () => Promise<"go" | "claimed" | "cancel">,
    start: () => Promise<void>,
  ) => {
    const notices: Notice[] = [];
    let started = false;
    let threw = false;
    try {
      started = await startBuildWithClaim({
        claimStep: claim,
        start,
        notify: (n) => notices.push(n),
        issueNumber: 115,
        title: "A card",
      });
    } catch {
      threw = true;
    }
    return { notices, started, threw };
  };

  // Unassigned: claimed then started, one info toast naming the issue.
  {
    let startedCalls = 0;
    const r = await run(
      async () => "claimed",
      async () => {
        startedCalls += 1;
      },
    );
    assert.equal(startedCalls, 1);
    assert.equal(r.started, true);
    assert.deepEqual(r.notices, [
      { kind: "info", title: "Claimed #115 and started the build", body: "A card" },
    ]);
  }
  // The backend refuses (someone else holds it): one error, rethrown.
  {
    const r = await run(
      async () => "go",
      async () => {
        throw "Already claimed by octo. Claim it too before starting.";
      },
    );
    assert.equal(r.threw, true);
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0].kind, "error");
    // GH #297: words in the line, the backend's text behind Details.
    assert.equal(r.notices[0].body, "Press Start build to try again.");
    assert.match(r.notices[0].details ?? "", /octo/);
  }
  // Plan with two AIs, P1 (2026-10-16 walk): the build waits for the
  // card's plan — the toast says so itself, not "try again" over Details.
  {
    const r = await run(
      async () => "go",
      async () => {
        throw new Error("Two AIs are still planning this card. Use their plan or discard it first.");
      },
    );
    assert.equal(r.threw, true);
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0].title, "Build not started");
    assert.equal(r.notices[0].body, "Two AIs are still planning this card. Use their plan or discard it first.");
    assert.equal(r.notices[0].details, undefined);
  }
  // 1.174.4: a branch nowhere: pressing again can't help, and the card says why.
  {
    const notices: Notice[] = [];
    await startBuildWithClaim({
      claimStep: async () => "go",
      start: async () => {
        throw "branch `staging` is neither on origin nor in this repository";
      },
      notify: (n) => notices.push(n),
      issueNumber: null,
      title: "A card",
    }).catch(() => {});
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "Start build didn't go through");
    assert.equal(notices[0].body, "What happened is on the card.");
    assert.equal(notices[0].details, "branch `staging` is neither on origin nor in this repository");
  }
  // WALKFIX-1 (C5): the branch cards go to is gone — the refusal's own
  // sentence is the line (it was "Press Start build to try again.").
  {
    const words =
      "staging isn't on GitHub any more. Cards went there, and the shared setup lived there. Choose where cards go now; Plyloft moves the shared setup to that branch. Until then no card can start.";
    for (const [claim, body] of [
      ["go", words],
      ["claimed", `The issue stays yours. ${words}`],
    ] as const) {
      const r = await run(
        async () => claim,
        async () => {
          throw words;
        },
      );
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[r.notices.length - 1].body, body);
      assert.notEqual(r.notices[r.notices.length - 1].body, "Press Start build to try again.");
    }
    const renamed = "staging is called develop on GitHub now. Cards went to staging, and the shared setup still names it. Move both to develop first, from the Board.";
    const r = await run(async () => "go", async () => { throw renamed; });
    assert.equal(r.notices[0].body, renamed);
  }
  // v1.154.1 (J2): Build with both in a repository not set up says so in
  // its own words, with Set up — the refusal is never only in the log.
  {
    const notices: Notice[] = [];
    let threw = false;
    try {
      await startBuildWithClaim({
        claimStep: async () => "go",
        start: async () => {
          throw "Sandbox isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Open Settings › This repository › Build and release and press Re-detect, then start the card again.";
        },
        notify: (n) => notices.push(n),
        issueNumber: null,
        title: "A card",
        press: "Build with both",
        notStarted: "Build with both didn't start",
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "Build with both didn't start");
    assert.equal(notices[0].body, "Set up this repository, then press Build with both.");
    assert.equal(notices[0].setUp, true);
  }
  // v1.154.1 (K1): refused before the claim — a repository not set up never
  // gets its issue claimed, and the refusal is the one message.
  {
    const notices: Notice[] = [];
    let claimed = 0;
    let started = 0;
    let threw = false;
    try {
      await startBuildWithClaim({
        beforeClaim: async () => {
          throw "Sandbox isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Open Settings › This repository › Build and release and press Re-detect, then start the card again.";
        },
        claimStep: async () => {
          claimed += 1;
          return "claimed";
        },
        start: async () => {
          started += 1;
        },
        notify: (n) => notices.push(n),
        issueNumber: 115,
        title: "A card",
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal(claimed, 0);
    assert.equal(started, 0);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "Build not started");
    assert.equal(notices[0].body, "Set up this repository, then press Start build.");
    assert.equal(notices[0].setUp, true);
  }
  // Claimed, then the start fails: one error that says the claim stays.
  {
    const r = await run(
      async () => "claimed",
      async () => {
        throw "workspace has no project_config";
      },
    );
    assert.equal(r.threw, true);
    assert.deepEqual(r.notices, [
      {
        kind: "error",
        title: "Claimed #115; build not started",
        body: "The issue stays yours; press Start build to try again.",
        details: "workspace has no project_config",
      },
    ]);
  }
  // n16: a repository not set up is set up once, and the whole start runs
  // once more — the `.env` question, the claim, the start.
  {
    const NOT_SET_UP =
      "Sandbox isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Open Settings › This repository › Build and release and press Re-detect, then start the card again.";
    const READ_ONLY =
      "Sandbox isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work from. Nothing was started. Its settings are shared and this account can't write to the repository: someone with write access has to press Re-detect in Settings › This repository › Build and release and publish; then start the card again.";
    const auto = async (o: {
      before?: (n: number) => void;
      claim?: (n: number) => "go" | "claimed";
      start?: (n: number) => void;
      setUp?: () => Promise<(() => void) | null>;
    }) => {
      const count = { before: 0, claim: 0, start: 0, setUp: 0, said: 0 };
      const notices: Notice[] = [];
      let threw = false;
      let started = false;
      try {
        started = await startBuildWithClaim({
          beforeClaim: async () => {
            count.before += 1;
            o.before?.(count.before);
          },
          claimStep: async () => {
            count.claim += 1;
            return o.claim?.(count.claim) ?? "go";
          },
          start: async () => {
            count.start += 1;
            o.start?.(count.start);
          },
          autoSetUp: async () => {
            count.setUp += 1;
            const announce = o.setUp ? await o.setUp() : () => {};
            return announce && (() => (count.said += 1));
          },
          notify: (n) => notices.push(n),
          issueNumber: 115,
          title: "A card",
        });
      } catch {
        threw = true;
      }
      return { count, notices, threw, started };
    };
    // Refused before the claim (K1): set up, then asked, claimed and started
    // once — no error.
    {
      const r = await auto({
        before: (n) => {
          if (n === 1) throw NOT_SET_UP;
        },
      });
      assert.deepEqual(r.count, { before: 2, claim: 1, start: 1, setUp: 1, said: 1 });
      assert.equal(r.started, true);
      assert.equal(r.threw, false);
      assert.deepEqual(r.notices, []);
    }
    // Refused by the start after the issue was claimed: the retry still says
    // it claimed the issue.
    {
      const r = await auto({
        claim: (n) => (n === 1 ? "claimed" : "go"),
        start: (n) => {
          if (n === 1) throw NOT_SET_UP;
        },
      });
      assert.deepEqual(r.count, { before: 2, claim: 2, start: 2, setUp: 1, said: 1 });
      assert.equal(r.started, true);
      assert.deepEqual(r.notices, [
        { kind: "info", title: "Claimed #115 and started the build", body: "A card" },
      ]);
    }
    // Shared settings this account can't write: never set up, the words as before.
    {
      const r = await auto({
        before: () => {
          throw READ_ONLY;
        },
      });
      assert.equal(r.count.setUp, 0);
      assert.equal(r.threw, true);
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].body, "Someone with write access has to set up this repository first.");
      assert.equal(r.notices[0].setUp, undefined);
    }
    // Nothing to propose, or the save failed: the refusal with Set up, no retry.
    for (const setUp of [async () => null, async () => Promise.reject("save failed")]) {
      const r = await auto({
        before: () => {
          throw NOT_SET_UP;
        },
        setUp,
      });
      assert.deepEqual(r.count, { before: 1, claim: 0, start: 0, setUp: 1, said: 0 });
      assert.equal(r.threw, true);
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].body, "Set up this repository, then press Start build.");
      assert.equal(r.notices[0].setUp, true);
    }
    // Refused again after a set-up: one message, never a second set-up.
    {
      const r = await auto({
        start: () => {
          throw NOT_SET_UP;
        },
      });
      assert.deepEqual(r.count, { before: 2, claim: 2, start: 2, setUp: 1, said: 0 });
      assert.equal(r.threw, true);
      assert.equal(r.notices.length, 1);
      assert.equal(r.notices[0].setUp, true);
    }
  }
  // F5 (v1.154.0 walk): a start the card's setup holds points to the card's
  // Retry / Allow and run / Start anyway, never to Start build.
  {
    const failed =
      "The card's setup failed, so the Builder was not started. Retry the setup, or start anyway, from the card. The setup command failed (exit code 1).";
    const r = await run(
      async () => "go",
      async () => {
        throw failed;
      },
    );
    assert.equal(r.threw, true);
    assert.equal(r.notices.length, 1);
    assert.equal(r.notices[0].title, "Setup failed");
    assert.ok(r.notices[0].body?.includes("Retry") && r.notices[0].body.includes("Start anyway"));
    assert.ok(!r.notices[0].body?.includes("Start build"), r.notices[0].body);
    const approval = await run(
      async () => "claimed",
      async () => {
        throw "The card's setup command needs your OK, so the Builder was not started. Allow and run it, or start anyway, from the card. The repository's setup command hasn't run on this Mac before: sleep 600. Allow it here?";
      },
    );
    assert.equal(approval.notices[0].title, "Claimed #115; build not started");
    assert.ok(approval.notices[0].body?.startsWith("The issue stays yours."));
    assert.ok(approval.notices[0].body?.includes("Allow and run"), approval.notices[0].body);
    assert.ok(!approval.notices[0].body?.includes("Start build"));
    const running = await run(
      async () => "go",
      async () => {
        throw new Error("The card is still being set up; the Builder starts when the setup is done.");
      },
    );
    assert.equal(running.notices[0].title, "The card is still being set up");
    assert.ok(!running.notices[0].body?.includes("Start build"));
  }
  // A workspace that was never set up: pressing Start build again would not
  // help, so the notice says to set it up and asks for `Set up`.
  {
    const refusal =
      "Atelier isn't set up for Plyloft's builds yet, so Plyloft doesn't know which branch to work " +
      "from. Nothing was started. Open Settings › This repository › Build and release and " +
      "press Re-detect, then start the card again.";
    const r = await run(
      async () => "go",
      async () => {
        throw refusal;
      },
    );
    assert.deepEqual(r.notices, [
      {
        kind: "error",
        title: "Build not started",
        body: "Set up this repository, then press Start build.",
        details: refusal,
        setUp: true,
      },
    ]);
    const claimed = await run(
      async () => "claimed",
      async () => {
        throw refusal;
      },
    );
    assert.equal(
      claimed.notices[0].body,
      "The issue stays yours; set up this repository, then press Start build.",
    );
    // Read-only shared settings: no `Set up`, and says who can.
    const readOnly = await run(
      async () => "go",
      async () => {
        throw "Atelier isn't set up for Plyloft's builds yet. Its settings are shared and this account can't write to the repository: someone with write access has to press Re-detect in Settings › This repository › Build and release and publish; then start the card again.";
      },
    );
    assert.equal(
      readOnly.notices[0].body,
      "Someone with write access has to set up this repository first.",
    );
    assert.equal(readOnly.notices[0].setUp, undefined);
  }
  // Declined second claim: no start, nothing to report.
  {
    let startedCalls = 0;
    const r = await run(
      async () => "cancel",
      async () => {
        startedCalls += 1;
      },
    );
    assert.equal(startedCalls, 0);
    assert.deepEqual(r.notices, []);
  }
  // A failed claim: one "Claim failed", no start.
  {
    let startedCalls = 0;
    const r = await run(
      async () => {
        throw new Error("gh: 403");
      },
      async () => {
        startedCalls += 1;
      },
    );
    assert.equal(startedCalls, 0);
    assert.deepEqual(r.notices, [
      {
        kind: "error",
        title: "The card wasn't claimed",
        body: "Nobody's name was put on it, and the build didn't start. Try again; Details has the reason.",
        details: "gh: 403",
      },
    ]);
  }
  // An already-mine start is silent on success.
  {
    const r = await run(async () => "go", async () => {});
    assert.deepEqual(r.notices, []);
  }
  assert.equal(claimedAndStartedMessage(null), "Claimed the issue and started the build");
}

await claimTests();

// ── T2 (team walk 2026-10-02): someone else's claim, seen on the Board ──

{
  const held = cardClaimState(["test-owner"], "test-user");
  assert.equal(hasLocalRun({}), false);
  assert.equal(hasLocalRun({ worktreePath: "/w" }), true);
  assert.equal(hasLocalRun({ builder: { startedAt: 1 } }), true);
  assert.equal(hasLocalRun({ runHistory: [{}] }), true);
  const free = { localRun: false, notStarted: true, loginKnown: true };
  assert.equal(claimedByOthersWord(held, free), "Claimed by test-owner");
  // This Mac ran it: its own state says more.
  assert.equal(claimedByOthersWord(held, { ...free, localRun: true }), null);
  assert.equal(claimedByOthersWord({ kind: "mine" }, free), null);
  assert.equal(claimedByOthersWord({ kind: "none" }, free), null);
  // Challenger (round 2): only a card nobody has started — Done, Merged,
  // Blocked, planning keep their own words.
  for (const state of ["draft", "ready"]) assert.equal(notStarted(state), true, state);
  for (const state of ["closed", "shipped", "intake-live", "running", "session-closed", "failed"]) {
    assert.equal(notStarted(state), false, state);
  }
  assert.equal(claimedByOthersWord(held, { ...free, notStarted: false }), null);
  // The login unknown: nothing is said about "someone else".
  const unknown = cardClaimState(["test-owner"], null);
  assert.equal(claimedByOthersWord(unknown, { ...free, loginKnown: false }), null);
  assert.equal(startBuildClaimTitle(unknown, false), null);
  assert.equal(
    startBuildClaimTitle(held, true),
    "Claimed by test-owner. Start build asks before you claim it too.",
  );
  assert.equal(startBuildClaimTitle({ kind: "mine" }, true), null);
}


// ── C3: the second-claim question names an open pull request ──────────

assert.equal(
  secondClaimBody(23),
  "Pull request #23 is already open for it. Claiming it too means two people may build the same thing.",
);
assert.equal(secondClaimBody(null), "Claiming it too means two people may build the same thing.");
assert.equal(openPullRequestOf({ pr: { number: 23, state: "open" } }), 23);
assert.equal(openPullRequestOf({ pr: { number: 23, state: "merged" } }), null);
assert.equal(openPullRequestOf({}), null);

// 1.175.0 D4 (TM-8): the teammate's open pull request, which the Board
// already knows, is named with who opened it.
assert.equal(
  secondClaimBody({ number: 178, author: "example-teammate" }),
  "Pull request #178 by example-teammate is already open for it. Claiming it too means two people may build the same thing.",
);
assert.equal(
  secondClaimBody({ number: 178, author: "Me" }, "me"),
  "Pull request #178 by you is already open for it. Claiming it too means two people may build the same thing.",
);
assert.equal(
  secondClaimBody({ number: 178, author: null }),
  "Pull request #178 is already open for it. Claiming it too means two people may build the same thing.",
);
const teammates = { number: 178, author: "example-teammate" };
assert.deepEqual(secondClaimPullRequest({}, teammates), teammates);
assert.equal(secondClaimPullRequest({}, null), null);
// This computer's own open pull request is said first, as before.
assert.equal(secondClaimPullRequest({ pr: { number: 23, state: "open" } }, teammates), 23);
// The linked one is the card's own (only its URL is known, or it isn't open here): no "by".
assert.equal(secondClaimPullRequest({ prUrl: "https://github.com/o/r/pull/178" }, teammates), 178);
assert.deepEqual(secondClaimPullRequest({ pr: { number: 23, state: "merged" } }, teammates), teammates);

// ── N14 item 5: a teammate's claim, not run here, asks nothing of me ──

const teamCard = { ghIssueNumber: 21, ghAssignees: ["test-user"] };
assert.equal(claimedByOthersHere(teamCard, "test-owner"), true);
assert.equal(claimedByOthersHere(teamCard, "TEST-USER"), false, "my own claim");
assert.equal(claimedByOthersHere(teamCard, null), false, "the login unknown: no guess");
assert.equal(claimedByOthersHere({ ...teamCard, ghAssignees: [] }, "me"), false, "nobody holds it");
assert.equal(claimedByOthersHere({ ...teamCard, ghIssueNumber: null }, "me"), false, "a local card");
assert.equal(
  claimedByOthersHere({ ...teamCard, ghAssignees: ["test-user", "me"] }, "me"),
  false,
  "claimed by me too",
);
assert.equal(claimedByOthersHere({ ...teamCard, worktreePath: "/w" }, "me"), false, "run here");
assert.equal(claimedByOthersHere({ ...teamCard, runHistory: [{}] }, "me"), false, "run here");

// ── N14 item 6: who described the card ─────────────────────────────────

assert.equal(
  issueAuthorWords("test-user", "test-owner"),
  "test-user described the card",
);
assert.equal(issueAuthorWords("Test-OWNER", "test-owner"), null, "my own issue");
assert.equal(issueAuthorWords("test-user", null), null, "the login unknown");
assert.equal(issueAuthorWords(null, "me"), null);
assert.equal(issueAuthorWords("  ", "me"), null);

// ── N14 item 4: a teammate's pull request on the card ──────────────────

assert.equal(
  linkedPullRequestWords({ number: 23, author: "test-user" }, "test-owner"),
  "Pull request #23 by test-user",
);
assert.equal(linkedPullRequestWords({ number: 23, author: "Me" }, "me"), "Pull request #23 by you");
assert.equal(linkedPullRequestWords({ number: 23, author: null }, "me"), "Pull request #23");
assert.deepEqual(linkedPullRequestState({ state: "open" }), { word: "Open", state: "running" });
assert.deepEqual(linkedPullRequestState({ state: "open", draft: true }), { word: "Draft", state: "running" });
assert.deepEqual(linkedPullRequestState({ state: "merged" }), { word: "Merged", state: "done" });
assert.deepEqual(linkedPullRequestState({ state: "closed" }), { word: "Closed", state: "empty" });

// A merged pull request on a card this computer never ran.
assert.equal(
  mergedPrLine([{ number: 5, state: "closed", author: "a" }, { number: 23, state: "merged", author: "ana" }], "me"),
  "Pull request #23 by ana was merged for this card.",
);
assert.equal(mergedPrLine([{ number: 23, state: "merged", author: "Me" }], "me"), "Pull request #23 by you was merged for this card.");
assert.equal(mergedPrLine([{ number: 23, state: "merged", author: null }], "me"), "Pull request #23 was merged for this card.");
assert.equal(mergedPrLine([{ number: 23, state: "open", author: "ana" }], "me"), null);
assert.equal(mergedPrLine([], "me"), null);
assert.equal(
  mergedPrLine([{ number: 12, state: "merged", author: "ana" }, { number: 30, state: "merged", author: "bo" }, { number: 21, state: "merged", author: "cy" }], "me"),
  "Pull request #30 by bo was merged for this card.",
);

// U28: the card's own pull request, by status or by URL alone.
assert.equal(isOwnPullRequest({ pr: { number: 9 } }, 9), true);
assert.equal(isOwnPullRequest({ prUrl: "https://github.com/o/r/pull/9/" }, 9), true);
assert.equal(isOwnPullRequest({ prUrl: "https://github.com/o/r/pull/9" }, 10), false);
assert.equal(isOwnPullRequest({}, 9), false);

// U32: the folder gone is refused before the claim, in its own words.
{
  const PROJECT_FOLDER_GONE =
    "This project's folder isn't where Plyloft left it, so nothing was claimed. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.";
  const notices: { title: string; body?: string }[] = [];
  let claimed = false;
  await assert.rejects(
    startBuildWithClaim({
      beforeClaim: async () => {
        throw PROJECT_FOLDER_GONE;
      },
      claimStep: async () => {
        claimed = true;
        return "claimed";
      },
      start: async () => {},
      notify: (n) => notices.push(n),
      issueNumber: 161,
      title: "T",
    }),
  );
  assert.equal(claimed, false, "nothing claimed");
  assert.deepEqual(notices, [{ kind: "error", title: "Build not started", body: PROJECT_FOLDER_GONE }]);
}

// On a local board there is no claim, and the same refusal doesn't name one.
{
  const LOCAL_FOLDER_GONE =
    "This project's folder isn't where Plyloft left it. Put the folder back; a team's project can be cloned again from Settings › Team › Members and library.";
  const notices: { title: string; body?: string }[] = [];
  await assert.rejects(
    startBuildWithClaim({
      beforeClaim: async () => {
        throw LOCAL_FOLDER_GONE;
      },
      claimStep: async () => "go",
      start: async () => {},
      notify: (n) => notices.push(n),
      issueNumber: null,
      title: "T",
    }),
  );
  assert.deepEqual(notices, [{ kind: "error", title: "Build not started", body: LOCAL_FOLDER_GONE }]);
}

// ── 1.173.0 (C2): a card another of this person's computers took ─────

{
  const now = Date.parse("2026-10-30T10:00:00Z");
  const mark = { device: "a1b2c3d4e5f60708", name: "MacBook Pro", login: "Matteo", at: "2026-10-30T08:00:00Z" };
  const card = { ghClaim: mark, ghAssignees: ["matteo"], columnId: "in_progress" };
  const elsewhere = otherDeviceReading(card, "matteo");
  assert.deepEqual(elsewhere, { kind: "elsewhere", name: "MacBook Pro", at: Date.parse(mark.at) });
  assert.equal(otherDeviceWords(elsewhere!, now), "On your MacBook Pro · 2 h ago");
  // Challenger 2: a local run alone is not a take-over ("Start here too").
  assert.equal(otherDeviceReading({ ...card, worktreePath: "/wt" } as typeof card, "matteo")?.kind, "elsewhere");
  // This computer's marker was replaced: taken over.
  const taken = otherDeviceReading({ ...card, ghClaimLostTo: "MacBook Pro" }, "matteo");
  assert.deepEqual(taken, { kind: "takenOver", name: "MacBook Pro" });
  assert.equal(otherDeviceWords(taken!, now), "Taken over by MacBook Pro");
  // Nothing shows: this computer's, no marker, Done, unknown login, another login.
  assert.equal(otherDeviceReading({ ...card, ghClaimHere: true }, "matteo"), null);
  assert.equal(otherDeviceReading({ ...card, ghClaim: null }, "matteo"), null);
  assert.equal(otherDeviceReading({ ...card, columnId: "complete" }, "matteo"), null);
  assert.equal(otherDeviceReading(card, null), null);
  assert.equal(otherDeviceReading(card, "teammate"), null, "another login: the assignee decides");
  // A marker without a login: the assignees say whose it is.
  const noLogin = { ...card, ghClaim: { ...mark, login: null } };
  assert.equal(otherDeviceReading(noLogin, "matteo")?.kind, "elsewhere");
  assert.equal(otherDeviceReading({ ...noLogin, ghAssignees: ["teammate"] }, "matteo"), null);
  // No name: the words still read.
  const unnamed = otherDeviceReading({ ...card, ghClaim: { ...mark, name: "", at: "" } }, "matteo")!;
  assert.equal(otherDeviceWords(unnamed, now), "On your other Mac");

  // Challenger 5: the template is translated, the name never is.
  const toPc = (t: string) => t.replace(/\b([Yy])our Mac\b/g, "$1our PC").replace(/\bother Mac\b/g, "other PC");
  const studio = { kind: "elsewhere" as const, name: "Mac Studio", at: null };
  assert.equal(otherDeviceWords(studio, now, toPc), "On your Mac Studio");
  assert.equal(otherDeviceWords({ ...studio, name: "" }, now, toPc), "On your other PC");
  // A name that still names its owner takes no "your".
  const owned = { kind: "elsewhere" as const, name: "Matteo's iMac", at: null };
  assert.equal(otherDeviceWords(owned, now), "On Matteo's iMac");
  assert.equal(otherDeviceSheet(owned, "T", now).title, "This card is being built on Matteo's iMac");
  assert.equal(otherDeviceSheet(owned, "T", now).hint, "Take it over if you've left Matteo's iMac: its copy stays there until you delete it.");
  assert.equal(otherDeviceSheet(studio, "T", now, toPc).title, "This card is being built on your Mac Studio");

  const sheet = otherDeviceSheet(elsewhere!, "Search terms: sort by impressions", now);
  assert.equal(sheet.title, "This card is being built on your MacBook Pro");
  assert.equal(
    sheet.body,
    "“Search terms: sort by impressions” was taken there 2 h ago. Working on it here too makes a second copy: the two won't see each other's changes.",
  );
  assert.equal(sheet.hint, "Take it over if you've left the MacBook Pro: its copy stays there until you delete it.");
  assert.deepEqual([sheet.cancelLabel, sheet.altLabel, sheet.confirmLabel], ["Cancel", "Start here too", "Take it over here"]);
  assert.equal(sheet.strongCancel, true);
  assert.equal(sheet.asIs, true);
}

{
  const elsewhere = { kind: "elsewhere" as const, name: "MacBook Pro", at: null };
  const run = async (reading: typeof elsewhere | null, markedHere: boolean, choice: "cancel" | "here-too" | "take-over", fail = false) => {
    const writes: boolean[] = [];
    const failures: unknown[] = [];
    let asked = 0;
    const out = await deviceStepBeforeStart({
      reading,
      markedHere,
      ask: async () => {
        asked++;
        return choice;
      },
      write: async (takeOver) => {
        writes.push(takeOver);
        if (fail) throw new Error("offline");
      },
      takeOverFailed: (e) => failures.push(e),
    });
    return { out, writes, asked, failed: failures.length };
  };
  assert.deepEqual(await run(elsewhere, false, "cancel"), { out: "cancel", writes: [], asked: 1, failed: 0 });
  assert.deepEqual(await run(elsewhere, false, "here-too"), { out: "go", writes: [], asked: 1, failed: 0 }, "Start here too keeps the marker");
  assert.deepEqual(await run(elsewhere, false, "take-over"), { out: "go", writes: [true], asked: 1, failed: 0 });
  assert.deepEqual(await run(null, false, "cancel"), { out: "go", writes: [false], asked: 0, failed: 0 }, "free: this computer's goes on");
  assert.deepEqual(await run(null, true, "cancel"), { out: "go", writes: [], asked: 0, failed: 0 }, "already marked here");
  assert.deepEqual(await run(null, false, "cancel", true), { out: "go", writes: [false], asked: 0, failed: 0 }, "a failed marker never stops the start");
  assert.deepEqual(await run(elsewhere, false, "take-over", true), { out: "cancel", writes: [true], asked: 1, failed: 1 }, "a failed take-over is said and nothing starts");
  assert.ok(!/offline|error/i.test(TAKE_OVER_FAILED.body), "plain words");
}

console.log("cardClaim start: ok");

// ── 1.175.0 (D2): leaving a card takes the member's own name off its issue ──
{
  const mine = { ghIssueNumber: 161, ghAssignees: ["Matteo", "giulia"] };
  // Only on a GitHub Issues board, only the member's own name.
  assert.equal(ownNameComesOff(mine, "matteo", true), 161);
  assert.equal(ownNameComesOff(mine, "matteo", false), null, "a local board");
  assert.equal(ownNameComesOff({ ...mine, ghAssignees: ["giulia"] }, "matteo", true), null, "a teammate's name");
  assert.equal(ownNameComesOff({ ...mine, ghAssignees: [] }, "matteo", true), null, "nobody's");
  assert.equal(ownNameComesOff(mine, null, true), null, "the login isn't known: no guess");
  assert.equal(ownNameComesOff({ ...mine, ghIssueNumber: null }, "matteo", true), null, "no issue");
  // Shipped work stays its author's: any pull request, or shipped here.
  assert.equal(ownNameComesOff({ ...mine, prUrl: "https://github.com/o/r/pull/9" }, "matteo", true), null);
  assert.equal(ownNameComesOff({ ...mine, pr: { number: 9, state: "open" } }, "matteo", true), null);
  assert.equal(ownNameComesOff({ ...mine, shipStatus: "shipped" }, "matteo", true), null);
  assert.equal(ownNameComesOff({ ...mine, reviewStatus: "merged" }, "matteo", true), null);
  assert.equal(ownNameComesOff({ ...mine, prReview: { number: 4 } }, "matteo", true), null, "a pull request review card");

  // Round 2: an Archive leaves the name on a card that is Done; a Move
  // back puts the card in Ready to start first, so its column doesn't count.
  assert.equal(ownNameComesOff({ ...mine, columnId: "complete" }, "matteo", true, "archive"), null);
  assert.equal(ownNameComesOff({ ...mine, columnId: "complete" }, "matteo", true, "move-back"), 161);
  assert.equal(ownNameComesOff({ ...mine, columnId: "in_progress" }, "matteo", true, "archive"), 161);
  assert.equal(ownNameComesOff({ ...mine, columnId: "todo" }, "matteo", true, "archive"), 161);

  assert.equal(nameComesOffSentence(161), "Your name comes off issue #161, so your team sees it as free.");
  const off = { kind: "off" as const, number: 161 };
  const refused = { kind: "refused" as const, number: 161, details: "HTTP 502: Bad Gateway" };
  const REFUSED =
    "GitHub didn't take your name off issue #161, so your team still sees it as yours. Plyloft tries again at the next Sync.";
  assert.equal(nameOffSentence(off), "Your name is off issue #161.");
  assert.equal(nameOffSentence(refused), REFUSED);

  // Move back: the card is back either way; the raw answer only in Details.
  assert.deepEqual(movedBackNotice(null), {
    kind: "info",
    title: "Back to Ready to start",
    body: "Start build picks it up again with the work so far.",
  });
  assert.deepEqual(movedBackNotice(off), {
    kind: "info",
    title: "Back to Ready to start",
    body: "Start build picks it up again with the work so far. Your name is off issue #161.",
  });
  assert.deepEqual(movedBackNotice(refused), {
    kind: "warn",
    title: "Back to Ready to start",
    body: `Start build picks it up again with the work so far. ${REFUSED}`,
    details: "HTTP 502: Bad Gateway",
  });
  // Stop during the start: no toast unless the member's name was on the issue.
  assert.equal(startStoppedNotice(null), null);
  assert.deepEqual(startStoppedNotice(off), {
    kind: "info",
    title: "Back to Ready to start",
    body: "Nothing was built. Your name is off issue #161.",
  });
  assert.equal(startStoppedNotice(refused)?.body, `Nothing was built. ${REFUSED}`);
  assert.equal(startStoppedNotice(refused)?.kind, "warn");
  // Archive: after the Undo window, only a refusal is said again.
  assert.equal(archiveNameKeptNotice("Fix login redirect", null), null);
  assert.equal(archiveNameKeptNotice("Fix login redirect", off), null, "the toast with Undo said it");
  assert.deepEqual(archiveNameKeptNotice("Fix login redirect", refused), {
    kind: "warn",
    title: "Card archived",
    body: `Fix login redirect. ${REFUSED}`,
    details: "HTTP 502: Bad Gateway",
  });
  // The delete sheet's Archive has no Undo: one toast, after the fact.
  assert.deepEqual(archivedNotice("Fix login redirect", null), { kind: "info", title: "Card archived", body: "Fix login redirect" });
  assert.equal(archivedNotice("Fix login redirect", off).body, "Fix login redirect. Your name is off issue #161.");
  for (const words of [nameComesOffSentence(161), nameOffSentence(off), REFUSED]) {
    assert.ok(!/\bPR\b|origin|worktree|assignee/i.test(words), words);
  }
  console.log("cardClaim leave (D2): ok");
}

// ── 1.175.0 (D1): whoever comes second stops, and is asked ───────────────
{
  const raced = { first: "example-teammate", nameOff: true };
  // The claim step: a teammate won by a moment — the D1 sheet, not the
  // second-claim one. Leaving it claims nothing more and starts nothing.
  const step = async (answer: boolean, withSheet = true) => {
    const calls: string[] = [];
    const out = await claimBeforeStart(
      {
        readHolder: async () => ({ kind: "unclaimed" }),
        claim: async (confirmed) => {
          calls.push(`claim:${confirmed}`);
          return confirmed
            ? { claimed: true, holder: { kind: "others", logins: ["example-teammate"] } }
            : { claimed: false, holder: { kind: "others", logins: ["example-teammate"] }, raced };
        },
        confirmSecondClaim: async (logins) => {
          calls.push(`ask:${logins.join(",")}`);
          return answer;
        },
        ...(withSheet
          ? {
              confirmAfterRace: async (r: { first: string }) => {
                calls.push(`race:${r.first}`);
                return answer;
              },
            }
          : {}),
      },
      true,
    );
    return { out, calls };
  };
  assert.deepEqual(await step(false), { out: "cancel", calls: ["claim:false", "race:example-teammate"] });
  // "Claim it too": the name goes back on and the build starts, with the
  // toast a claim always has ("Claimed #161 and started the build").
  assert.deepEqual(await step(true), { out: "claimed", calls: ["claim:false", "race:example-teammate", "claim:true"] });
  // A caller without the sheet asks the second-claim question, as before.
  assert.deepEqual(await step(false, false), { out: "cancel", calls: ["claim:false", "ask:example-teammate"] });

  // The sheet, in the mockup's words (two-people.html#d1, 1.1).
  assert.deepEqual(raceSheet(raced, "Fix login redirect", 161), {
    title: "example-teammate started this a moment ago",
    body: "You both pressed Start build on “Fix login redirect” (#161) at almost the same time. Nothing was started here, and your name is off the issue again.",
    hint: "Claiming it too means two people may build the same thing.",
    cancelLabel: "Leave it to example-teammate",
    confirmLabel: "Claim it too",
    strongCancel: true,
    cautious: true,
    asIs: true,
  });
  // 1.5: GitHub didn't take the name off — said, with a third button.
  const kept = raceSheet({ first: "example-teammate", nameOff: false }, "Fix login redirect", 161);
  assert.equal(
    kept.body,
    "You both pressed Start build on “Fix login redirect” (#161) at almost the same time. Nothing was started here. GitHub didn't take your name off the issue, so it lists you both: take it off on GitHub, or claim it too.",
  );
  assert.deepEqual([kept.cancelLabel, kept.altLabel, kept.confirmLabel], ["Leave it to example-teammate", "Open on GitHub", "Claim it too"]);
  assert.equal(kept.title, "example-teammate started this a moment ago");
  assert.ok(kept.strongCancel && kept.cautious, "the focus is on leaving it");

  // Both chose to work on it: the Board card's quiet line, once it runs here.
  const both = cardClaimState(["matteo", "example-teammate"], "matteo");
  assert.equal(sharedClaimLine(both, true), "Claimed by you and example-teammate");
  assert.equal(sharedClaimLine(both, false), null, "not started here: the state's place says it");
  assert.equal(sharedClaimLine(cardClaimState(["matteo"], "matteo"), true), null);
  assert.equal(sharedClaimLine(cardClaimState(["example-teammate"], "matteo"), true), null);
  console.log("cardClaim second claim (D1): ok");
}
