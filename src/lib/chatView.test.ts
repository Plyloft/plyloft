// 1.174.0 E10 (T14): the card chat's token line. Run with Node 22+:
//   node --experimental-strip-types src/lib/chatView.test.ts
import assert from "node:assert/strict";
import { TELL_BUILDER_LABEL, TELL_BUILDER_TITLE, chatBuilderLine, chatTokenLine, lastPersonMessage, tellBuilderPress, tellBuilderTitle } from "./chatView.ts";
import { laneTokenLine } from "./planExchangeView.ts";

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };

// No line at zero: nothing used yet, nothing said.
assert.equal(chatTokenLine(null), null);
assert.equal(chatTokenLine(undefined), null);
assert.equal(chatTokenLine(ZERO), null);
// A real count stays as it was, never a cost.
assert.equal(
  chatTokenLine({ ...ZERO, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000 }),
  "Tokens in this conversation: 1,200 in · 340 out · 5,000 read from the cache.",
);
// A plan side keeps its zero words (only the card chat's row went).
assert.equal(laneTokenLine({ role: "proposer", vendor: "claude" }, ZERO), "Claude (proposer): No tokens used yet.");

// 1.175.0 F10 (UX-11): the line for the three cases, and Send to the
// Builder — the field's text, else the person's last message, else off.
assert.equal(chatBuilderLine("builder"), "The Builder doesn't see this chat. To change the work, send it to the Builder.");
assert.equal(chatBuilderLine("unbuilt"), "The Builder doesn't see this chat. To change what it builds, edit What you want.");
assert.equal(chatBuilderLine("done"), "The Builder doesn't see this chat. This card is done: for more changes, use Follow up.");
assert.equal(TELL_BUILDER_LABEL, "Send to the Builder");
// F10 round 2 (review): only the person's own typing counts — a message
// sent from here (`typed`), never one read back from the CLI's transcript
// (the session's priming), a relay of the other AI's answer, or one that
// wasn't sent. An empty field never sends by itself: it puts it back.
const said = [
  { id: "u1", role: "user", text: "Make it bigger" },
  { id: "a1", role: "assistant", text: "Sure." },
  { id: "u2", role: "user", text: "Also make the confirmation green and add a small check icon." },
  { id: "u3", role: "user", text: "not sent", isError: true },
  { id: "p1", role: "user", text: "You are helping with the card “Contact form”…" },
  { id: "r1", role: "user", text: "Codex said: …", relayOf: "a1" },
  { id: "a2", role: "assistant", text: "I can't change files from here." },
];
const typed = ["u1", "u2", "u3", "r1"];
const last = lastPersonMessage(said, typed);
assert.equal(last, "Also make the confirmation green and add a small check icon.", "not the priming, not a relay, not one unsent");
assert.equal(lastPersonMessage(said, []), null, "nothing typed here: nothing offered");
assert.equal(lastPersonMessage(said, ["p1"]), "You are helping with the card “Contact form”…", "only by the window's own record");
assert.equal(lastPersonMessage([{ id: "r1", role: "user", text: "relayed", relayOf: "x" }], ["r1"]), null, "a relay is never the person's");
assert.equal(lastPersonMessage([], []), null);
assert.deepEqual(tellBuilderPress("  Make the button blue ", last), { send: "Make the button blue" });
assert.deepEqual(tellBuilderPress("  ", last), { fill: last });
assert.equal(tellBuilderPress("", null), null, "no text and no message: the press is off");
assert.equal(tellBuilderTitle("Make it blue", last), TELL_BUILDER_TITLE);
assert.equal(tellBuilderTitle("", null), TELL_BUILDER_TITLE);
assert.equal(
  tellBuilderTitle("", last),
  "Puts your last message, “Also make the confirmation green and add…”, back in the field: read it, then press Send to the Builder to send it to the Builder's session.",
);

console.log("chatView: ok");
