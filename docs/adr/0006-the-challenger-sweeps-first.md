# ADR 0006 — The Challenger sweeps first, then follows up

**Status:** accepted, 2026-09-17. Interview with the owner the same day, then a
replay experiment before any code.

## Context

A card on the mini took 13 to 16 Build done → Challenger rounds before an
approve (#81: 15, #82: 14, #99: 10). Each round returned one to four findings
in one to five minutes. Reading the records of #81, of the 24 findings that
arrived after round 1, half were in code that round 1 had already read: the
review stopped early, it did not run out of defects.

The causes are in how the review is asked for. The prompt carries the card's
title, not its brief, so requirements cannot be checked. It asks for "concise
markdown" and for changes requested "only for a concrete defect you found",
which a model satisfies with the first few defects. Rounds keep no memory, so
every round is a first review of the whole change. Nothing tells the reviewer
what classes of risk to walk. Several passes never look between each other.

Alternatives considered: a stronger model or higher effort on the same prompt
(the reviewer already runs the strongest model the owner has; the prompt is
the limit); two reviewers in parallel (doubles the cost and still stops
early); capping rounds (hides defects instead of finding them sooner).

## Decision

The first review of a card is a **sweep**. The Challenger receives the brief,
the repository's agent instructions and the Verify result with the change, and
walks a **risk checklist** class by class, answering each with findings or
"checked, nothing", and reporting everything it finds. It may take up to 15
minutes. When the change is read in several passes, a **synthesis pass** looks
only for defects that sit between files of different passes.

Every later review is a **follow-up review**: it receives the earlier findings
and the diff of the fixes, confirms each finding closed or still open, and
looks for what the fixes broke. It does not start over.

Findings carry a severity. **P1** and **P2** block. A **P3** is listed as
non-blocking and never changes the verdict.

Before the Challenger, the Builder does a **self-check** against the same
checklist at Build done. It is one step of Build done, not a second button,
and it can be skipped.

From the fourth changes-requested verdict on one card, the Ship step offers
**Ship with follow-up**: the card ships and its open findings become a new
card. It is offered, never automatic, and never for an open P1.

The checklist has a core that ships with Ply (requirements, concurrency and
ordering, state and persistence, failure paths, processes and resources,
boundaries and contracts, data safety, tests, user-facing text and states). A
repository adds its own classes in its shared definition.

## Evidence

Replay of #81 at its round-1 revision, same reviewer command as production,
2026-09-17. Today's prompt: 5 findings in 154 s; of the 12 later findings that
were already in that code it caught 1, and touched 2 more. The sweep with the
checklist and a synthesis pass: 21 findings and 3 non-blocking in 652 s; it
caught 8 of those 12, both later P1s among them (edits lost during migration,
historically round 5; Share retargeting the issue repository, historically
round 11 and here found only by the synthesis pass). Both missed the same
family of four, around branch discovery and unreadable definitions. The sweep
also raised 7 findings no historical round had raised; two were checked
against main and are true.

## Consequences

- The first review costs about four times as long and returns a long list.
  The Builder fixes a list, not a trickle; the expected number of rounds is
  three to five, not zero.
- The sweep reports defects in code the card only touches (the unbounded `gh`
  runner, for one). The prompt must say which findings belong to this change
  and which are **pre-existing**; pre-existing ones never block and may become
  cards.
- Follow-up reviews need the earlier findings stored per card in a form the
  next prompt can quote.
- A family missed by both prompts means the checklist is a floor. When a late
  finding shows a missing class, the class is added: that is what the
  repository's additions are for.
- Success is measured on the next three real cards: rounds to approve, and how
  many findings after the sweep sat in code the sweep had read.
