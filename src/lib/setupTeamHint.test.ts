// Run: node --experimental-strip-types src/lib/setupTeamHint.test.ts
import assert from "node:assert/strict";
import { TEAM_WAIT_MS, teamAnswerPending } from "./setupTeamHint.ts";

const base = { hint: null, deduced: null, pastGithub: true, modeAsked: false, githubObserved: true as boolean | null };
assert.equal(teamAnswerPending(base), true);
assert.equal(teamAnswerPending({ ...base, hint: { read: true } }), false, "the answer is there");
assert.equal(teamAnswerPending({ ...base, deduced: { mode: "solo" } }), false, "the mode is decided");
assert.equal(teamAnswerPending({ ...base, githubObserved: false }), false, "nobody signed in to GitHub");
assert.equal(teamAnswerPending({ ...base, githubObserved: null }), false, "GitHub not read yet, no command");
assert.equal(teamAnswerPending({ ...base, githubObserved: null, ghFound: true }), true, "command there, status not read yet");
assert.equal(teamAnswerPending({ ...base, githubObserved: false, ghFound: true }), false, "read: nobody signed in");
assert.equal(teamAnswerPending({ ...base, pastGithub: false }), false, "the read hasn't started");
assert.equal(teamAnswerPending({ ...base, modeAsked: true }), false, "asked for by hand");
assert.equal(TEAM_WAIT_MS, 6000);
console.log("setupTeamHint: ok");
