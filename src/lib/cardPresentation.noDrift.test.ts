// UX P1 point 2 (P-A), test 6: the no-drift snapshot for the move to
// `presentCard`. `cardPresentation.noDrift.json` was recorded BEFORE the
// move, from the code on main (the card page's override block, the Board's
// `deriveBoardCardState`, the List's row and stage), for every fixture of
// `cardPresentation.fixtures.ts`. After the move the same fixtures give the
// same words, columns and primaries — except the rows this spec changes on
// purpose, each listed below by name with its reason. P-A changes logic, not
// copy; any other difference is a drift and fails.
//
// G2 (1.173.0, owner decision 6): the second AI is the Reviewer on every
// surface, so the snapshot's words say Reviewer ("Reviewing" for the
// review in progress) where they said Challenger. Nothing else changed.
//
// Run with Node 22+:
//   node --experimental-strip-types src/lib/cardPresentation.noDrift.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PRESENTATION_FIXTURES } from "./cardPresentation.fixtures.ts";
import { presentCard, presentationStage } from "./cardPresentation.ts";
import { boardListRow } from "./boardList.ts";

type Surface = "page" | "board" | "list";
const BEFORE = JSON.parse(
  readFileSync(new URL("./cardPresentation.noDrift.json", import.meta.url), "utf8"),
) as Record<string, Record<Surface, Record<string, unknown>>>;

/** Why a row may change. */
const TRUST = "the trust word: rules 7 and 8 say 'Asks to trust the folder' everywhere; 'Needs you' is a column";
const PREPARING = "'Preparing the result' is retired: a result still being read says the Board's word";
const CONFLICT = "a ship stopped on a conflict says so on every surface (rule 18)";
const SHIP_FAILED = "a ship press that failed says so on every surface (rule 19)";
const CHANGES_SENT = "changes sent to the Builder: every surface, Working (rule 11)";
const FACTS = "the card page's facts are shared (cardFactsStore): the Board and the List read the result the page read";
const ORDER = "one order: the card page's overrides are every surface's (the page wins where they disagreed)";
const SKILL = "a skill card behind its library (Skills hub H3a, a page-only override on main) says so on every surface";
const COLUMN = "the column of the spec's table: a plan or a setup that runs is Working";
const DOT = "the dot is the card's own state's, as on its page, not the collapsed Board state's";
const LIST_DOT = "the List row's dot is its Board card's (a setup's dot was the Board's alone)";
const CONFLICT_PE = "P-E: a ship conflict says nothing was merged, and the way on (point 7, adopted 15)";
const REVIEW_AGAIN = "QoL 1.168 (C5): a failed review is run again first — Review again is the primary, Ship anyway the alternative";
const FINISH = "P-B: the press is called Finish and check (owner decision D1)";
const WAITING = "P-B: a Builder waiting on the person is rule 9, in Needs you (points 3 and 4)";
const QUESTION_FIRST = "P-B Mac walk 2: a question the Builder waits on outranks every rule after 8 (here 'Reviewer requests changes'); stopped and quiet do not";
const WAITING_DOT = "P-B: rule 9's dot is the Builder header's (its turn over done, a question or its silence amber)";
const TRUST_DOT = "Mac walk 5: one dot per presentation — a question nothing moves past is amber on the Board, the List, Now, the sidebar and the Inbox (it was purple, amber and grey)";
const SHIP_TRY_AGAIN = "P-D2 Mac walk: Try again says what must happen first";
const PLAIN = "P-D2: plain words on the default paths (D4: round N, the card's copy)";
const JARGON = "QoL 1.168 block 8 (A4): vendor is the AI";
const NOT_STARTED = "QoL 1.168 block 8 (owner D13): a card nobody started is Not started, out of Needs you";
const SHIP_AGAIN = "1.171.0 A3 (DL-02): a closed pull request ships again with Ship it, not Ship as a PR";
const STAGE = "1.171.0 B1 (CP-2, owner D6): an open pull request says its stage — never \"It shipped.\" while it waits — and is Working while its checks run";
const READY = "1.171.0 B3 (BI-8): \"Ready to merge\" — \"on GitHub\" read as \"go to GitHub\" beside Plyloft's own Merge";
const FIXING = "1.171.0 C1 (CF1): a fix round's Builder at work is Working, like a running build, in its AI's name with what it fixes and for how long";
const FIXED = "1.171.0 C1 (CF1): its turn over after the fixes, Now's press is Finish and check again (it was only inside the session), in Needs you";
const TITLE_ONLY = "1.171.0 C1 (CF5): a card with only its title is Ready to start with Start build; planning first is Start build ▾'s other way";
const FIVE_WORDS = " — 1.171.0 C2 (CF8): the five session words (Working · Asks you something · Your turn · Closed · Paused)";
const WAIT = "1.171.0 C2 (CF3, owner D10): after Finish and check the card says the wait — Checking the work — with what happens and that the person can leave, not the session's Working";
const F9_WORDS = "1.175.0 F9 (UX-8, words.html §1): the self-check's word says what the Builder does (Re-reading its work), Now's title who, the sentence what comes next";
const LEAVE = "1.171.0 C2 (CF16): every wait after Finish and check says the person can leave";
const NO_ROUNDS = " — 1.171.0 C2 (CF10, CF11): no round numbers in headlines; what the Builder has, by the AI's name";
const STOPPED = "1.171.0 C2: Plyloft quit during Finish and check's self-check — the card says what happened and offers Finish and check again, never an endless wait";
const CHECKS_OK = "1.175.0 B2 (SEC-4): Finish and check saved the work and the repository's checks wait for this computer's OK (the card's checksHold) — the card says so and offers Allow and run, in Needs you, amber; before, the same card with no session read as a closed session";
const EDIT_ASKS = "D3: the card asks which version of the part to keep — Needs you until answered";
const SENT = "1.174.0 A2 (P7): sent is not landed — ready to merge says what Merge does and that the card can still change; closed says nothing reached main";
const AREA_NOW = "1.174.0 (C3, P9): a card with no area asks in Now before Start build (card-page.html §2), where it was a toast after the press";
const SHIPPED_WHERE = "1.171.0 B1 (DL-03, BI-20): \"Merged\" said two places; the headline says which (on GitHub, or only on this Mac)";

/** [fixture, surface, field, before, after, reason] — every deliberate change. */
const CHANGES: ReadonlyArray<[string, Surface, string, unknown, unknown, string]> = [
  ["its area is not chosen yet", "page", "headline", "Ready to start", "Which area is this card for?", AREA_NOW],
  ["its area is not chosen yet", "page", "sentence", "The brief is written and nothing has started.", "It was made on All areas. Its area decides where its changes go and which release takes it.", AREA_NOW],
  ["Reviewing", "page", "sentence", "The other vendor is reading the latest build, read-only.", "Codex is reviewing Claude's work without changing it. You can leave this; Plyloft tells you when it's done.", JARGON + "; " + LEAVE],
  ["its pull request is open", "page", "headline", "Pull request open", "On GitHub · waiting for checks", STAGE],
  ["its pull request is open", "page", "sentence", "It shipped.", "Its pull request #5 is open; checks on GitHub are running.", STAGE],
  ["its pull request is open", "board", "headline", "Pull request open", "On GitHub · waiting for checks", STAGE],
  ["its pull request is open", "board", "column", "waiting", "working", STAGE],
  ["its pull request is open", "board", "dot", "done", "running", STAGE],
  ["its pull request is open", "list", "status", "Pull request open", "On GitHub · waiting for checks", STAGE],
  ["its pull request is open", "list", "dot", "done", "running", STAGE],
  ["its pull request is ready to merge", "page", "sentence", "It shipped.", "Merge puts it in your main branch. You can still change it: the pull request takes a new build with Send the fixes to GitHub.", STAGE + "; " + SENT],
  ["its pull request has no checks", "page", "sentence", "It shipped.", "Merge puts it in your main branch. You can still change it: the pull request takes a new build with Send the fixes to GitHub.", STAGE + "; " + SENT],
  ["its pull request waits for a review", "page", "sentence", "It shipped.", "Its pull request #5 is open; checks on GitHub passed, and it's waiting for a review on GitHub.", STAGE],
  ["its pull request is ready to merge", "page", "headline", "Ready to merge on GitHub", "Ready to merge", READY],
  ["its pull request is ready to merge", "board", "headline", "Ready to merge on GitHub", "Ready to merge", READY],
  ["its pull request is ready to merge", "list", "status", "Ready to merge on GitHub", "Ready to merge", READY],
  ["its pull request has no checks", "page", "headline", "Ready to merge on GitHub", "Ready to merge", READY],
  ["its pull request has no checks", "board", "headline", "Ready to merge on GitHub", "Ready to merge", READY],
  ["its pull request has no checks", "list", "status", "Ready to merge on GitHub", "Ready to merge", READY],
  ["merged as a pull request", "page", "headline", "Merged", "Shipped · on GitHub", SHIPPED_WHERE],
  ["merged as a pull request", "board", "headline", "Merged", "Shipped · on GitHub", SHIPPED_WHERE],
  ["merged as a pull request", "list", "status", "Merged", "Shipped · on GitHub", SHIPPED_WHERE],
  ["its pull request was closed", "page", "sentence", "Pull request #5 was closed without merging. Ship as a PR opens a new pull request.", "Pull request #5 was closed without merging. Nothing reached your main branch. Ship it again opens a new pull request; Archive puts the card away.", SHIP_AGAIN + "; " + SENT],
  ["a runner is chosen", "board", "column", "needs-you", "not-started", NOT_STARTED],
  ["draft", "board", "column", "needs-you", "not-started", NOT_STARTED],
  ["ready to start", "board", "column", "needs-you", "not-started", NOT_STARTED],
  ["reviews a member's pull request", "page", "headline", "Review is out of date", "Not reviewed yet", ORDER + " (the page drew it as its Status; Now is the review panel)"],
  ["someone else holds its issue", "list", "status", "Ready to start", "Claimed by ana", ORDER],
  ["a two-AI plan runs", "board", "column", "needs-you", "working", COLUMN],
  ["its setup runs", "board", "column", "needs-you", "working", COLUMN],
  ["its intake asks to trust the folder", "page", "headline", "Needs you", "Asks to trust the folder", TRUST],
  ["its Builder asks to trust the folder", "page", "headline", "Needs you", "Asks to trust the folder", TRUST],
  ["built by both, both working", "board", "headline", "Working", "Building with both", ORDER],
  ["built by both, both working", "list", "status", "Working", "Building with both", ORDER],
  ["changes sent to the Builder", "board", "headline", "Result ready", "Changes sent to the Builder", CHANGES_SENT],
  ["changes sent to the Builder", "board", "column", "needs-you", "working", CHANGES_SENT],
  ["changes sent to the Builder", "list", "status", "Result ready", "Changes sent to the Builder", CHANGES_SENT],
  ["a request for changes the Builder never received", "board", "headline", "The last commit was not reviewed", "1 finding still open · the last review didn't finish", ORDER + NO_ROUNDS],
  ["a request for changes the Builder never received", "list", "status", "The last commit was not reviewed", "1 finding still open · the last review didn't finish", ORDER + NO_ROUNDS],
  ["a request for changes the Builder never received", "list", "stage", "in-review", "ready-to-ship", FACTS],
  ["changes requested, verdict not delivered", "board", "headline", "Reviewer requests changes", "Claude doesn't have the findings yet", ORDER + NO_ROUNDS],
  ["changes requested, verdict not delivered", "list", "status", "Reviewer requests changes", "Claude doesn't have the findings yet", ORDER + NO_ROUNDS],
  ["a local ship stopped on a conflict", "page", "headline", "Preparing the result", "Ship stopped on a conflict", CONFLICT],
  ["a local ship stopped on a conflict", "board", "headline", "Result ready", "Ship stopped on a conflict", CONFLICT],
  ["a local ship stopped on a conflict", "list", "status", "Result ready", "Ship stopped on a conflict", CONFLICT],
  ["a skill card behind its team library", "board", "headline", "Ready to ship", "The team changed this skill again", SKILL],
  ["a skill card behind its team library", "list", "status", "Ready to ship", "The team changed this skill again", SKILL],
  ["a skill card behind its team library", "list", "stage", "ready-to-ship", "in-review", SKILL],
  ["a ship press failed", "board", "headline", "Ready to ship", "Ship didn't go through", SHIP_FAILED],
  ["a ship press failed", "list", "status", "Ready to ship", "Ship didn't go through", SHIP_FAILED],
  ["Reviewing", "board", "headline", "Running checks", "Reviewing", ORDER],
  ["Reviewing", "list", "status", "Running checks", "Reviewing", ORDER],
  ["the review is out of date", "board", "headline", "Ready to ship", "Review is out of date", FACTS],
  ["the review is out of date", "list", "status", "Ready to ship", "Review is out of date", FACTS],
  ["the review is out of date", "list", "stage", "ready-to-ship", "in-review", FACTS],
  ["nothing changed", "board", "headline", "Ready to ship", "Nothing changed", FACTS],
  ["nothing changed", "list", "status", "Ready to ship", "Nothing changed", FACTS],
  ["nothing changed", "list", "stage", "ready-to-ship", "in-review", FACTS],
  ["ready to ship (result not read yet)", "page", "headline", "Preparing the result", "Ready to ship", PREPARING],
  ["ready to ship (result not read yet)", "page", "sentence", "Plyloft is reading the result from the card's copy of the repo.", "Plyloft is reading the result from the card's copy.", PREPARING],
  ["the result is loading", "page", "headline", "Preparing the result", "Ready to ship", PREPARING],
  ["the result is loading", "page", "sentence", "Plyloft is reading the result from the card's copy of the repo.", "Plyloft is reading the result from the card's copy.", PREPARING],
  ["result ready, not verified", "page", "headline", "Preparing the result", "Result ready", PREPARING],
  ["result ready, not verified", "page", "sentence", "Plyloft is reading the result from the card's copy of the repo.", "Plyloft is reading the result from the card's copy.", PREPARING],
  ["shipping", "board", "headline", "Ready to ship", "Shipping", FACTS],
  ["shipping", "board", "column", "needs-you", "working", FACTS],
  ["shipping", "list", "status", "Ready to ship", "Shipping", FACTS],
  // (Challenger) The dots that moved, each with its word: the Board's and the
  // List's dot is the card's own state now (the page's), not the collapsed
  // "Result ready"'s green, and the List's dot is the Board card's.
  ["reviews a member's pull request", "board", "dot", "done", "empty", DOT + " (a review not run yet is not a green result)"],
  ["reviews a member's pull request", "list", "dot", "done", "empty", DOT + " (a review not run yet is not a green result)"],
  ["its setup failed", "list", "dot", "empty", "aborted", LIST_DOT],
  ["its setup runs", "list", "dot", "empty", "running", LIST_DOT],
  ["a local ship stopped on a conflict", "board", "dot", "done", "aborted", CONFLICT],
  ["a local ship stopped on a conflict", "list", "dot", "done", "aborted", CONFLICT],
  ["a ship press failed", "board", "dot", "done", "aborted", SHIP_FAILED],
  ["a ship press failed", "list", "dot", "done", "aborted", SHIP_FAILED],
  ["the review is out of date", "board", "dot", "done", "empty", FACTS + "; " + DOT],
  ["the review is out of date", "list", "dot", "done", "empty", FACTS + "; " + DOT],
  ["nothing changed", "board", "dot", "done", "aborted", FACTS + "; " + DOT],
  ["nothing changed", "list", "dot", "done", "aborted", FACTS + "; " + DOT],
  ["shipping", "board", "dot", "done", "running", FACTS + "; " + DOT],
  ["shipping", "list", "dot", "done", "running", FACTS + "; " + DOT],
  // P-B (UX P1 points 3 and 4). The press is Finish and check (D1)...
  ["changes sent to the Builder", "page", "sentence", "The Builder has them in its session. When it has addressed them, press Build done there; Ship waits until then.", "The Builder has them in its session. When it has addressed them, press Finish and check there; Ship waits until then.", FINISH],
  ["changes requested, verdict not delivered", "page", "sentence", "The Builder has not received them. Build done in the session snapshots the fixes and starts the next review.", "The Builder has not received them. Finish and check in the session saves the fixes and starts the next review.", FINISH],
  ["Reviewer requests changes (delivered)", "page", "sentence", "Build done in the session snapshots the fixes and starts the next review.", "Finish and check in the session saves the fixes and starts the next review.", FINISH],
  // ...and a Builder waiting on the person is rule 9, in Needs you. Its
  // "before" is P-A's, which read no session state but the trust question.
  ["its Builder stopped", "page", "headline", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder stopped", "page", "sentence", "It is running now.", "Claude says it's done. Check it, or tell it what's missing. When it's finished, Finish and check tests it and has it reviewed.", WAITING + FIVE_WORDS],
  ["its Builder stopped", "page", "action", "inspect-run", "finish-and-check", WAITING + " (its one primary is the press itself)"],
  ["its Builder stopped", "board", "headline", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder stopped", "board", "column", "working", "needs-you", WAITING],
  ["its Builder stopped", "board", "dot", "running", "done", WAITING_DOT],
  ["its Builder stopped", "list", "status", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder stopped", "list", "dot", "running", "done", WAITING_DOT],
  ["its Builder asks a question", "page", "headline", "Working", "Asks you something", WAITING + FIVE_WORDS],
  ["its Builder asks a question", "page", "sentence", "It is running now.", "Claude asked you something. Answer it in the session.", WAITING],
  ["its Builder asks a question", "board", "headline", "Working", "Asks you something", WAITING + FIVE_WORDS],
  ["its Builder asks a question", "board", "column", "working", "needs-you", WAITING],
  ["its Builder asks a question", "board", "dot", "running", "aborted", WAITING_DOT],
  ["its Builder asks a question", "list", "status", "Working", "Asks you something", WAITING + FIVE_WORDS],
  ["its Builder asks a question", "list", "dot", "running", "aborted", WAITING_DOT],
  ["its Builder went quiet", "page", "headline", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder went quiet", "page", "sentence", "It is running now.", "Codex hasn't printed anything for a while. Look at the session: it may be asking something.", WAITING],
  ["its Builder went quiet", "board", "headline", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder went quiet", "board", "column", "working", "needs-you", WAITING],
  ["its Builder went quiet", "board", "dot", "running", "aborted", WAITING_DOT],
  ["its Builder went quiet", "list", "status", "Working", "Your turn", WAITING + FIVE_WORDS],
  ["its Builder went quiet", "list", "dot", "running", "aborted", WAITING_DOT],
  // ...and (Mac walk 2) its question outranks "Challenger requests changes":
  // the most urgent thing on the card, on every surface.
  ["changes requested, its Builder asks a question", "page", "headline", "Reviewer requests changes", "Asks you something", QUESTION_FIRST + FIVE_WORDS],
  ["changes requested, its Builder asks a question", "page", "sentence", "Build done in the session snapshots the fixes and starts the next review.", "Claude asked you something. Answer it in the session.", QUESTION_FIRST],
  ["changes requested, its Builder asks a question", "board", "headline", "Reviewer requests changes", "Asks you something", QUESTION_FIRST + FIVE_WORDS],
  ["changes requested, its Builder asks a question", "list", "status", "Reviewer requests changes", "Asks you something", QUESTION_FIRST + FIVE_WORDS],
  ["built by both, a build waits", "board", "column", "working", "needs-you", WAITING + " (a build that waits; each build keeps its own words)"],
  ["its intake asks to trust the folder", "board", "dot", "running", "aborted", TRUST_DOT],
  ["its intake asks to trust the folder", "list", "dot", "running", "aborted", TRUST_DOT],
  ["its Builder asks to trust the folder", "board", "dot", "running", "aborted", TRUST_DOT],
  ["its Builder asks to trust the folder", "list", "dot", "running", "aborted", TRUST_DOT],
  // P-E (UX P1 point 7): rule 18 says nothing was merged and, on a card with
  // no Builder (this fixture), how to resolve it by hand (adopted 15).
  // P-D2 (UX P1 point 6, owner decision D4): plain words on the default
  // paths — "round N" for a numbered snapshot, "the card's copy" for its
  // worktree.
  ["a request for changes the Builder never received", "page", "headline", "Review of snapshot 2 failed — snapshot 1's review asked for changes: F1 still open", "1 finding still open · the last review didn't finish", PLAIN + NO_ROUNDS],
  ["changes requested, verdict not delivered", "page", "headline", "Snapshot 1's requested changes have not reached the Builder", "Claude doesn't have the findings yet", PLAIN + NO_ROUNDS],
  ["its Builder session closed", "page", "sentence", "Nothing is running this build, and its worktree is intact.", "Nothing is running this build, and its copy is safe.", PLAIN],
  ["a ship press failed", "page", "sentence", "The last ship stopped before it finished, and the card's work is kept.", "The last ship stopped before it finished, and the card's work is kept. Fix what stopped it, then try again.", SHIP_TRY_AGAIN],
  ["a local ship stopped on a conflict", "page", "sentence", "The last ship stopped on a conflict.", "The last ship stopped on a conflict. Nothing was merged. Resolve it in the card's copy, then ship again.", CONFLICT_PE],
  ["review failed on a ready card", "page", "action", "ship", "review-again", REVIEW_AGAIN],
  // 1.171.0 C1 (CF1, CF5): the fix round's Builder at work or done, and a card with only its title.
  ["changes requested, its Builder fixes them", "page", "headline", "Reviewer requests changes", "Claude is fixing 3 findings · 2m", FIXING],
  ["changes requested, its Builder fixes them", "page", "sentence", "Finish and check in the session saves the fixes and starts the next review.", "Claude is working on them in its session. When it's done, Finish and check again tests the fixes and has them reviewed.", FIXING],
  ["changes requested, its Builder fixes them", "board", "headline", "Reviewer requests changes", "Claude is fixing 3 findings · 2m", FIXING],
  ["changes requested, its Builder fixes them", "board", "column", "needs-you", "working", FIXING],
  ["changes requested, its Builder fixes them", "board", "dot", "aborted", "running", FIXING],
  ["changes requested, its Builder fixes them", "list", "status", "Reviewer requests changes", "Claude is fixing 3 findings · 2m", FIXING],
  ["changes requested, its Builder fixes them", "list", "dot", "aborted", "running", FIXING],
  ["changes requested, its Builder finished the fixes", "page", "headline", "Reviewer requests changes", "Claude finished the fixes", FIXED],
  ["changes requested, its Builder finished the fixes", "page", "sentence", "Finish and check in the session saves the fixes and starts the next review.", "Claude's turn is over. If it fixed them, Finish and check again tests the fixes and has them reviewed; if it disagrees with a finding and you side with it, press Agree with Claude, keep it as it is.", FIXED],
  ["changes requested, its Builder finished the fixes", "page", "action", "inspect-run", "finish-and-check", FIXED],
  ["changes requested, its Builder finished the fixes", "board", "headline", "Reviewer requests changes", "Claude finished the fixes", FIXED],
  ["changes requested, its Builder finished the fixes", "board", "dot", "aborted", "done", FIXED + " (rule 9's stopped dot)"],
  ["changes requested, its Builder finished the fixes", "list", "status", "Reviewer requests changes", "Claude finished the fixes", FIXED],
  ["changes requested, its Builder finished the fixes", "list", "dot", "aborted", "done", FIXED + " (rule 9's stopped dot)"],
  ["changes sent, its Builder works on them", "page", "headline", "Changes sent to the Builder", "Codex is working on your changes", FIXING],
  ["changes sent, its Builder works on them", "page", "sentence", "The Builder has them in its session. When it has addressed them, press Finish and check there; Ship waits until then.", "Codex is working on them in its session. When it's done, Finish and check again tests the fixes and has them reviewed.", FIXING],
  ["changes sent, its Builder works on them", "board", "headline", "Changes sent to the Builder", "Codex is working on your changes", FIXING],
  ["changes sent, its Builder works on them", "board", "dot", "done", "running", FIXING],
  ["changes sent, its Builder works on them", "list", "status", "Changes sent to the Builder", "Codex is working on your changes", FIXING],
  ["changes sent, its Builder works on them", "list", "dot", "done", "running", FIXING],
  ["Finish and check pressed, its Builder re-reads its work", "page", "headline", "Working", "Re-reading its work", WAIT + "; " + F9_WORDS],
  ["Finish and check pressed, its Builder re-reads its work", "page", "sentence", "It is running now.", "Then your checks run and the Reviewer reviews it. You can leave this; Plyloft tells you when it's done.", WAIT + "; " + F9_WORDS],
  ["Finish and check pressed, its Builder re-reads its work", "page", "action", "inspect-run", "finish-and-check", WAIT + " (the press itself, busy)"],
  ["Finish and check pressed, its Builder re-reads its work", "board", "headline", "Working", "Re-reading its work", WAIT + "; " + F9_WORDS],
  ["Finish and check pressed, its Builder re-reads its work", "list", "status", "Working", "Re-reading its work", WAIT + "; " + F9_WORDS],
  ["running checks", "page", "sentence", "Plyloft is running the checks.", "Plyloft is running the checks. You can leave this; Plyloft tells you when it's done.", LEAVE],
  ["Plyloft quit during the self-check", "page", "headline", "Session ended", "Finish and check stopped", STOPPED],
  ["Plyloft quit during the self-check", "page", "sentence", "Nothing is running this build, and its copy is safe.", "Plyloft closed while Claude was re-reading its work, so nothing was saved or checked yet. Finish and check again saves the work as it is, runs your checks and has it reviewed; Resume opens the session first if you want Claude to re-read it.", STOPPED],
  ["Plyloft quit during the self-check", "page", "action", "resume-session", "finish-and-check", STOPPED],
  ["Plyloft quit during the self-check", "board", "headline", "Session ended", "Finish and check stopped", STOPPED],
  ["Plyloft quit during the self-check", "board", "dot", "empty", "aborted", STOPPED + " (something stopped part-way: amber)"],
  ["Plyloft quit during the self-check", "list", "status", "Session ended", "Finish and check stopped", STOPPED],
  ["Plyloft quit during the self-check", "list", "dot", "empty", "aborted", STOPPED + " (something stopped part-way: amber)"],
  ["the checks wait for this Mac's OK", "page", "headline", "Session closed", "The checks need your OK", CHECKS_OK],
  ["the checks wait for this Mac's OK", "page", "sentence", "Nothing is running this build, and its copy is safe.", "The Builder's work is saved, and nothing has run.", CHECKS_OK],
  ["the checks wait for this Mac's OK", "page", "action", "resume-session", "allow-checks", CHECKS_OK],
  ["the checks wait for this Mac's OK", "board", "headline", "Session closed", "The checks need your OK", CHECKS_OK],
  ["the checks wait for this Mac's OK", "board", "dot", "empty", "aborted", CHECKS_OK + " (something waits on the person: amber)"],
  ["the checks wait for this Mac's OK", "list", "status", "Session closed", "The checks need your OK", CHECKS_OK],
  ["the checks wait for this Mac's OK", "list", "dot", "empty", "aborted", CHECKS_OK + " (something waits on the person: amber)"],
  // 1.175.0 (D3): a card whose title or brief changed on GitHub and here
  // asks which version to keep — a Needs you card on the Board (and in the
  // Inbox and the sidebar's number, `oneCount.test.ts`) until it is
  // answered; its page keeps its state's headline, the notice above the
  // part asks. Recorded with what the same card said before the question.
  ["ready, its brief changed on GitHub and here", "board", "column", "not-started", "needs-you", EDIT_ASKS],
  ["a teammate's, its title changed on GitHub and here", "board", "column", "waiting", "needs-you", EDIT_ASKS],
  ["draft", "page", "headline", "Draft", "Ready to start", TITLE_ONLY],
  ["draft", "page", "sentence", "Nothing is written about what this card should do yet.", "Claude gets only the title for now: say what you want below, or choose Plan it first to have Claude ask you questions.", TITLE_ONLY],
  ["draft", "page", "action", "plan", "start-build", TITLE_ONLY],
  ["draft", "board", "headline", "Draft", "Ready to start", TITLE_ONLY],
  ["draft", "list", "status", "Draft", "Ready to start", TITLE_ONLY],
];

const allowed = new Map(CHANGES.map(([f, s, k, from, to, why]) => [`${f}|${s}|${k}`, { from, to, why }]));

// Every fixture was recorded, and every recorded fixture still exists.
assert.deepEqual(
  PRESENTATION_FIXTURES.map((f) => f.name).sort(),
  Object.keys(BEFORE).sort(),
  "the snapshot and the fixtures name the same cards",
);

const used = new Set<string>();
for (const f of PRESENTATION_FIXTURES) {
  const page = presentCard(f.card, f.live);
  // C3 (Challenger 3): the area is the card page's own fact (`areaAsk`);
  // the Board and the List never read it, so their rows are drawn without.
  const p = f.live.areaAsk ? presentCard(f.card, { ...f.live, areaAsk: null }) : page;
  const after: Record<Surface, Record<string, unknown>> = {
    page: { headline: page.presentation.label, sentence: page.sentence, action: page.action.id },
    // (Challenger) The dots and the Board card's fact were recorded but not
    // compared: a dot that moved was a visible change no test named.
    board: { headline: p.blocked ?? p.headline, column: p.column, dot: p.dot.state, fact: p.fact },
    list: {
      status: boardListRow(f.card, p).status,
      stage: presentationStage(f.card, p),
      dot: boardListRow(f.card, p).run.state,
    },
  };
  for (const surface of ["page", "board", "list"] as const) {
    for (const [field, value] of Object.entries(after[surface])) {
      const was = BEFORE[f.name][surface][field];
      const key = `${f.name}|${surface}|${field}`;
      const change = allowed.get(key);
      if (change) {
        used.add(key);
        assert.equal(was, change.from, `${key}: the snapshot's word is the one the change names`);
        assert.equal(value, change.to, `${key}: ${change.why}`);
      } else {
        assert.equal(value, was, `drift: ${key} was ${JSON.stringify(was)}, now ${JSON.stringify(value)}`);
      }
    }
  }
}
// C3: the Board and the List say Ready to start for a card whose area the page asks.
{
  const f = PRESENTATION_FIXTURES.find((x) => x.name === "its area is not chosen yet")!;
  const bare = presentCard(f.card, { ...f.live, areaAsk: null });
  assert.equal(bare.headline, "Ready to start");
  assert.equal(boardListRow(f.card, bare).status, "Ready to start");
  assert.equal(BEFORE[f.name].board.headline, "Ready to start");
  assert.equal(BEFORE[f.name].list.status, "Ready to start");
}

// No listed change is stale: each one happens.
assert.deepEqual([...allowed.keys()].filter((k) => !used.has(k)), [], "every listed change still happens");

// The page never says "Preparing the result" again, for any fixture.
for (const f of PRESENTATION_FIXTURES) {
  assert.notEqual(presentCard(f.card, f.live).headline, "Preparing the result", f.name);
}

console.log(`cardPresentation.noDrift: ${PRESENTATION_FIXTURES.length} fixtures, ${CHANGES.length} deliberate changes`);
