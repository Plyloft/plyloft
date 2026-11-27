// 1.173.0 (B3): a card's area — the line on the card, the question Start and
// Ship ask first, and the sheet about files outside the area (scene 4).
import assert from "node:assert/strict";
import type { CardAreaState, OutsideFiles, ResolvedArea } from "../ipc.ts";
import {
  AREA_LABEL,
  AREA_NOT_CHOSEN,
  AREA_ASK_WHY,
  WHICH_AREA_CARD,
  areaAskWhy,
  areaFilesHint,
  nowAreaAsk,
  newCardAreaStart,
  startInAreaLabel,
  areaChoosable,
  areaGoneLabel,
  BACK_LABEL,
  CHOOSE_AREA_LABEL,
  LEAVE_OUT_LABEL,
  OUTSIDE_SHIP_ANYWAY_LABEL,
  WHICH_AREA,
  areaAsk,
  areaChoiceLabel,
  areaChoiceStart,
  areaChoices,
  areaLineShown,
  chooseAreaToast,
  currentAreaFor,
  leftOutToast,
  provideCurrentArea,
  outsideFileRow,
  outsideFilesQuestion,
} from "./cardArea.ts";

const resolved = (id: string, name: string, branch: string, root = false): ResolvedArea => ({
  id,
  name,
  path: root ? "" : `${id}/`,
  root,
  first: root,
  targetBranch: branch,
  branch,
  versionFiles: null,
  tagPrefix: root ? "" : `${id}-`,
  label: `area:${id}`,
  lookAt: null,
});
const app = resolved("app", "App", "staging", true);
const site = resolved("site", "Site", "main");
const state = (patch: Partial<CardAreaState>): CardAreaState => ({
  kind: "area",
  areas: [app, site],
  area: null,
  sentence: null,
  suggested: null,
  editable: false,
  fits: ["app", "site"],
  ...patch,
});

// No current area read (the area store not loaded): All areas, so a new
// card asks before it starts. The store hands its reading in.
assert.equal(currentAreaFor("ws"), null);
provideCurrentArea((ws) => (ws === "ws" ? "site" : null));
assert.equal(currentAreaFor("ws"), "site");
assert.equal(currentAreaFor("other"), null);
provideCurrentArea(() => null);

// The line: shown only when there is something to say (two areas or more).
assert.equal(areaLineShown(null), false);
assert.equal(areaLineShown(state({ kind: "none" })), false);
assert.equal(areaLineShown(state({ kind: "area", area: site })), true);
assert.equal(areaLineShown(state({ kind: "needsArea" })), true);
assert.equal(areaLineShown(state({ kind: "held" })), true);
assert.equal(AREA_LABEL, "Area");

// Each choice says where its cards go.
assert.equal(areaChoiceLabel(site), "Site · cards go to main");
// C10 walk: a project not set up yet has no branch of its own to name.
assert.equal(areaChoiceLabel({ name: "Site", branch: "" }), "Site · cards go to the project's branch");
assert.deepEqual(areaChoices(state({})), [
  { value: "app", label: "App · cards go to staging" },
  { value: "site", label: "Site · cards go to main" },
]);

// It starts on the card's area, else the one its files point to, else the first.
assert.equal(areaChoiceStart(state({ area: site })), "site");
assert.equal(areaChoiceStart(state({ kind: "needsArea", suggested: "site" })), "site");
assert.equal(areaChoiceStart(state({ kind: "needsArea" })), "app");
assert.equal(areaChoiceStart(state({ kind: "needsArea", areas: [] })), "");
// Challenger 3: a started card chooses only an area of the branch it was cut from.
assert.deepEqual(areaChoices(state({ fits: ["site"] })), [
  { value: "app", label: "App · cards go to staging", disabled: true },
  { value: "site", label: "Site · cards go to main" },
]);
assert.equal(areaChoiceStart(state({ kind: "needsArea", fits: ["site"] })), "site");
assert.equal(areaChoiceStart(state({ kind: "needsArea", suggested: "app", fits: ["site"] })), "site");
assert.equal(areaChoiceStart(state({ kind: "needsArea", fits: [] })), "");

// Start and Ship ask first on a card with no (or an unlisted) area, and stop on held areas.
assert.deepEqual(areaAsk(null), { kind: "go" }, "a failed reading: the backend says it");
assert.deepEqual(areaAsk(state({ kind: "area", area: site })), { kind: "go" });
assert.deepEqual(areaAsk(state({ kind: "none" })), { kind: "go" });
assert.deepEqual(areaAsk(state({ kind: "needsArea", sentence: WHICH_AREA })), { kind: "choose", sentence: WHICH_AREA });
const unknown = "This card's area, docs, isn't in the repository's areas any more. Choose an area.";
assert.deepEqual(areaAsk(state({ kind: "unknown", sentence: unknown })), { kind: "choose", sentence: unknown });
const held = "This repository's areas can't be used: Two areas share the folder site/. Fix them in Settings › Project › Areas.";
assert.deepEqual(areaAsk(state({ kind: "held", sentence: held })), { kind: "held", sentence: held });
assert.deepEqual(chooseAreaToast(WHICH_AREA, "start"), {
  title: "Which area is this?",
  body: "Choose its area on the card, then start it again.",
});
assert.equal(chooseAreaToast(WHICH_AREA, "ship").body, "Choose its area on the card, then ship it again.");
// C1 (Challenger 4): the question is the title; why leads the body.
assert.deepEqual(
  chooseAreaToast("Its issue is labeled area:docs, which isn't one of this repository's areas. Which area is this?", "start"),
  {
    title: "Which area is this?",
    body: "Its issue is labeled area:docs, which isn't one of this repository's areas. Choose its area on the card, then start it again.",
  },
);
assert.equal(
  chooseAreaToast("Its issue is labeled area:app and area:site. Which area is this?", "start").body,
  "Its issue is labeled area:app and area:site. Choose its area on the card, then start it again.",
);
assert.deepEqual(chooseAreaToast("This card's area, docs, isn't in the repository's areas any more. Choose an area.", "ship"), {
  title: "Which area is this?",
  body: "This card's area, docs, isn't in the repository's areas any more. Choose its area on the card, then ship it again.",
});
assert.equal(CHOOSE_AREA_LABEL, "Use this area");

// Scene 4: the sheet before Ship.
const out: OutsideFiles = {
  area: site,
  files: [
    { path: "AGENTS.md", area: "app", belongs: "whole repository" },
    { path: "frontend/src/pages/Legal.tsx", area: "app", belongs: "App" },
    { path: "site/main.py", from: "app/main.py", area: "app", belongs: "App" },
  ],
  hint: "If they ship with this card, they reach main before the rest of App's work on staging.",
};
assert.equal(outsideFilesQuestion(null), null);
assert.equal(outsideFilesQuestion({ ...out, files: [] }), null, "nothing outside: no sheet");
const q = outsideFilesQuestion(out)!;
assert.equal(q.title, "This card also changes files outside Site");
assert.equal(q.body, "Site cards go to main. These files belong somewhere else:");
assert.deepEqual(q.fileRows, [
  { path: "AGENTS.md", tag: "whole repository" },
  { path: "frontend/src/pages/Legal.tsx", tag: "App" },
  { path: "app/main.py → site/main.py", tag: "App" },
]);
assert.equal(q.note, out.hint);
// Back · Leave those out (the accepting button, which takes the focus) · Ship anyway.
assert.deepEqual([q.cancelLabel, q.confirmLabel, q.altLabel, q.altAfter], [BACK_LABEL, LEAVE_OUT_LABEL, OUTSIDE_SHIP_ANYWAY_LABEL, true]);
assert.deepEqual([BACK_LABEL, LEAVE_OUT_LABEL, OUTSIDE_SHIP_ANYWAY_LABEL], ["Back", "Leave those out", "Ship anyway"]);
assert.equal(outsideFileRow({ path: "a", belongs: "Site" }), "a · Site");

// After Leave those out: the checks run again before Ship.
assert.deepEqual(leftOutToast(2, "Site", true), {
  title: "2 files left out",
  body: "They are back as they were. The checks run again; ship once they pass.",
});
assert.equal(leftOutToast(1, "Site", true).title, "1 file left out");
assert.equal(leftOutToast(0, "Site", false).title, "Nothing to leave out");
// Challenger 5: only edits not saved in the card were put back — nothing to check again.
assert.deepEqual(leftOutToast(1, "Site", false), {
  title: "1 file put back",
  body: "Those were edits not saved in the card yet; nothing it saved changed. Ship again when you're ready.",
});

// The app's own words.
for (const words of [q.title, q.body, q.note, ...q.fileRows.map((r) => r.tag), leftOutToast(1, "Site", false).body, WHICH_AREA, unknown, held, leftOutToast(2, "Site", true).body]) {
  assert.doesNotMatch(words, /\b(PR|worktree|diff|origin|HEAD|snapshot|CLI|into main)\b/, words);
}

// 1.174.0 (C2, BCI-11): the facts line says the area in words; it is
// chosen under Change… — a Not started card's area, or a card with none.
{
  assert.equal(AREA_NOT_CHOSEN, "Not chosen yet");
  assert.equal(areaGoneLabel("docs"), "docs · not in the areas any more");
  const st = (patch: Partial<CardAreaState>) =>
    ({ kind: "area", areas: [], area: null, sentence: null, suggested: null, editable: false, ...patch }) as CardAreaState;
  const area = resolved("site", "Site", "main");
  assert.equal(areaChoosable(st({ area, editable: true })), true);
  assert.equal(areaChoosable(st({ area, editable: false })), false, "a started card's area is said, not chosen");
  assert.equal(areaChoosable(st({ kind: "needsArea" })), true);
  assert.equal(areaChoosable(st({ kind: "unknown" })), true);
  assert.equal(areaChoosable(st({ kind: "held" })), false);
  assert.equal(areaChoosable(st({ kind: "none" })), false);
  assert.equal(areaChoosable(null), false);
}

// 1.174.0 (C3, P9): Now asks, with the area the select is on.
{
  assert.equal(WHICH_AREA_CARD, "Which area is this card for?");
  assert.equal(AREA_ASK_WHY, "It was made on All areas. Its area decides where its changes go and which release takes it.");
  assert.equal(startInAreaLabel("Site"), "Start in Site");
  const app = resolved("app", "App", "staging", true);
  const site = resolved("site", "Site", "main");
  assert.equal(areaFilesHint(site), "Its files are in site/");
  assert.equal(areaFilesHint(app), null, "the whole repository has no folder to name");
  const st = (patch: Partial<CardAreaState>) =>
    ({ kind: "needsArea", areas: [app, site], area: null, sentence: "Which area is this?", suggested: "site", editable: true, ...patch }) as CardAreaState;
  assert.deepEqual(nowAreaAsk(st({}), ""), { kind: "choose", area: "Site", why: null });
  assert.deepEqual(nowAreaAsk(st({}), "app"), { kind: "choose", area: "App", why: null });
  assert.equal(
    nowAreaAsk(st({ kind: "unknown", sentence: "This card's area, docs, isn't in the repository's areas any more. Choose an area." }), "")?.kind === "choose" &&
      areaAskWhy("This card's area, docs, isn't in the repository's areas any more. Choose an area."),
    "This card's area, docs, isn't in the repository's areas any more.",
  );
  assert.deepEqual(nowAreaAsk(st({ kind: "held", sentence: "Broken." }), ""), { kind: "held", sentence: "Broken." });
  assert.equal(nowAreaAsk(st({ kind: "area", area: site }), ""), null);
  assert.equal(nowAreaAsk(st({ kind: "none" }), ""), null);
  assert.equal(nowAreaAsk(null, ""), null);
}

// 1.174.0 (C3, §2f): New card on All areas starts on an area.
{
  const areas = [{ id: "app" }, { id: "site" }];
  assert.deepEqual(newCardAreaStart(areas, "site", "app"), { id: "site", hint: "this Mac's default" });
  assert.deepEqual(newCardAreaStart(areas, null, "app"), { id: "app", hint: "last used" });
  assert.deepEqual(newCardAreaStart(areas, "gone", "gone"), { id: "app", hint: null });
  assert.equal(newCardAreaStart([{ id: "app" }], "app", null), null, "one area: nothing to ask");
}

console.log("cardArea: ok");
