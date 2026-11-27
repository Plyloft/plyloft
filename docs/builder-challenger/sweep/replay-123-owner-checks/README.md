# A pending Tier 4 is the owner's: replay of the sweep, 2026-09-19 (GH #123)

On #111 (v1.137.0) the sweep raised "Complete the required Tier 4 acceptance
walkthrough" as a P1 twice (F1, F15), and every follow-up kept both open
because STATUS said `Tier 4 pending (mini)`. The Tier 4 is the owner's, on
the installed app, after release; the findings could never close. GH #123
adds one sentence next to the severity line of the sweep, follow-up and
synthesis prompts, and at the end of checklist class A
(`review_passes::OWNER_CHECKS` in the tests).

**Setup.** A written fixture, not #111's tree (its sweep answer was not kept):
a toy repository with this repository's `AGENTS.md` as its rules, a brief
with a Tier 4 line (`brief.txt`) and two versions of one change —
`diff-described.txt` (STATUS says `Tier 4 pending (mini):` and what to do and
see), `diff-missing.txt` (STATUS says only `Tier 4 pending (mini).`). The
prompts are production's sweep (`replay_harness::write_replay_prompts`); the
old prompt is the new one with the sentence taken out in both places. Codex
CLI 0.155.0, production argv (`--ask-for-approval never exec --ephemeral
--sandbox read-only --json --output-schema`).

| Change | Prompt | Verdict | Tier 4 finding |
|---|---|---|---|
| described | before #123 (`described-old-prompt.json`) | CHANGES_REQUESTED | **P1** "Complete the required Tier 4 walkthrough" |
| described | #123 (`described-new-prompt.json`) | INCOMPLETE | none; a gap line says the pending Tier 4 is not a finding |
| missing | #123 (`missing-new-prompt.json`) | CHANGES_REQUESTED | **P2** "Describe the required Tier 4 walkthrough" |

**Reading.** The old prompt reproduces #111's P1 on a change that describes
its Tier 4; the new prompt drops it and still asks for the description when it
is missing, at P2. The INCOMPLETE of the second run is the toy tree: the board
and Settings code the helpers would plug into is not there, which the answer
says under `verificationGaps`. One run per case: the test
`review_passes::tests::the_replay_drops_a_described_tier_4_and_keeps_a_missing_one`
holds these answers, not the reviewer's future behaviour.
