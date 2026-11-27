# The sweep: prompts as tested

The three texts here are the ones the replay of #81 ran on 2026-09-17
([ADR 0006](../../adr/0006-the-challenger-sweeps-first.md)). They are the
starting point for the card that builds the flow, not a frozen contract.

- `sweep-prompt.txt` — the first review. Placeholders: `{title}`, `{brief}`,
  `{rules}`, `{rev}`, `{base}`, `{scope}`, `{access}`, `{checklist}`, `{diff}`.
  `{scope}` and `{access}` are the sentences `review_passes::pass_prompt`
  already writes for a pass.
- `risk-checklist-core.txt` — classes A to I, the core that ships with Ply.
- `synthesis-prompt.txt` — the last pass when there is more than one.
  `{files}` is every changed path; `{findings}` is the `Findings` and
  `Non-blocking` sections of the earlier passes.

`replay-81/` holds the reviewer's real answers from that replay, control and
sweep, as parser fixtures and as the record of the comparison.

Built (first card of ADR 0006): the three texts live in
`src-tauri/src/review_passes.rs` (`SWEEP_TEMPLATE`, `SYNTHESIS_TEMPLATE`,
`RISK_CHECKLIST_CORE`); a test holds them equal to these files. The sweep
template has two slots these files do not: `{verify}` (the Verify result on the
reviewed revision, when there is one) and `{pre_existing}` (the sentence asking
the reviewer to mark findings in code the change did not write); the synthesis
template has the `{pre_existing}` slot too. `replay-81/`
is the parser's fixture set.

Built (second card of ADR 0006): the reviewer answers in JSON held to
`review_answer::REVIEW_SCHEMA` (`codex exec --output-schema`, `claude
--json-schema`); the markdown the card shows is rendered from it, and the
markdown parser is the fallback for an answer that is not JSON. The sweep and
synthesis templates have an `{answer}` slot (the tests fill it with the tested
markdown paragraph) and the sweep an `{earlier}` slot (the open findings, when
a sweep stands in for a follow-up). `schema/` in `replay-81/` holds the replay
that checked the schema does not make the review thinner, and why the answer
paragraph says the JSON is the complete review. The follow-up review prompt is
`FOLLOW_UP_TEMPLATE`; it has not been replayed on a past card.

Built (third card of ADR 0006): the checklist a prompt quotes is
`review_passes::risk_checklist` — the core, then the repository's own classes
from the shared definition's `reviewChecklist` as J, K…; the sweep's and the
follow-up's answer paragraphs ask for one entry per class up to the last
(`{classes}`). The Builder's self-check at Build done is `SELF_CHECK_TEMPLATE`
with the same checklist. Every finding of the schema carries `sweepSaw`, asked
only by the follow-up. `replay-93-follow-up/` holds the run that checked both
CLIs take the schema with it.

Not tested yet: whether the self-check lowers the sweep's findings (STATUS
records it on the next cards).

GH #123: the sweep, follow-up and synthesis texts carry, next to the severity
line, and class A carries at its end, one sentence: checks that need the
installed app or a person (the PPVP Tier 4 walkthrough, Max-auth tile checks,
two-Mac checks) are the owner's after release, a change is complete when it
describes them, and a missing or short description is at most a P2. The files
here carry it too. `replay-123-owner-checks/` is the replay that checked it.
