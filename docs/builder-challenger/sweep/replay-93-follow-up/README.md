# The follow-up with `sweepSaw` and repository classes: #93, 2026-09-18

The third card of [ADR 0006](../../../adr/0006-the-challenger-sweeps-first.md)
adds `sweepSaw` to both finding objects of `review_answer::REVIEW_SCHEMA`
(required: Codex `--output-schema` is strict) and quotes a repository's own
checklist classes after the core. This run checks that both reviewer CLIs take
the schema and walk the classes.

**Setup.** #93's round-1 fixes: base `9197ea4`, sweep revision `4248d2d`, fixes
`cbc7e0d`. The prompt is production's follow-up (`review_passes::pass_prompt`,
written by the ignored test `replay_harness::write_follow_up_replay_prompt`),
with the brief of GitHub issue #93, three of round 1's findings as the open
list (`open-findings.txt`, reconstructed from the fix commit; the card's
ledger predates it) and two repository classes, J and K (`checklist.json`,
the family both prompts missed in the replay of #81). The tree at `cbc7e0d`,
the production argv of each CLI plus the schema: Codex CLI 0.155.0
(`--ask-for-approval never exec --ephemeral --sandbox read-only --json
--output-schema`), Claude Code 2.1.276 (`-p … --restricted --output-format json
--json-schema`).

| CLI | Time | Verdict | Earlier findings | New | Checklist |
|---|---|---|---|---|---|
| Codex (`codex-answer.json`) | 105 s | CHANGES_REQUESTED | F1 open, F6 and F8 closed | 1 P2 | A to K |
| Claude (`claude-answer.json`) | 104 s | APPROVE | F1, F6, F8 closed | 4 P3 | A to K |

**Reading.** Both CLIs accept the schema: every finding carries `sweepSaw`,
the answers parse (`review_answer::read`), and both walked J and K by name.
Neither marked a finding `sweepSaw`: by both reviewers' own reading, the one
new P2 and the four P3s are in code the fixes wrote. The two disagree on F1 (serialized settings writes);
that is the review's substance, not the schema's.
