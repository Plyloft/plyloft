---
name: card-brief
description: Turns a rough idea into a brief an agent can work from. Use when opening a card, or when a card's own text is too thin to build from.
---

# Write a good card brief

A brief is the contract for one card. It is finished when someone who has not
had the conversation can build the card from it, and when the person who asked
for it can tell, from the text alone, whether the work is done.

## The three parts

**Expected.** What is true when the card is done, as sentences about behaviour,
not a list of files to edit. One bullet per claim, each one checkable. Name the
strings a person will read, verbatim, because a paraphrase is a different
product. Name what stays out: the neighbouring thing this card deliberately
does not do, and why it is a separate card.

**Tests.** The evidence each claim needs. Write them as the questions the tests
answer — "an old file loads with the field absent", "the launch carries the flag
only when at least one is on" — so a missing test is visible as a claim with no
question under it. A claim about persisted state names its backward-compatible
case. A claim about a process names what happens when it dies.

**What cannot be checked here.** The walks that need a human, a signed build, a
second machine or a real account. List them, say who does them, and never write
them as done. Give this section the heading the project already uses for it —
in this repository it is `Tier 4`, which is the word the review reads to tell a
pending walk from a missing one, so a brief that calls it something else turns a
correct "pending" into a finding.

## While you write it

Read the spec and the decision record the card points at before the code; the
brief quotes them rather than restating them from memory. Where the spec and a
drawing disagree, say which one the card follows.

Prefer the smallest brief that still decides the hard question. A card that has
to change a shared file says which one and how little. A card that touches a
path everything else depends on says so in its first line, because that is what
makes it risky rather than large.

Stop when every bullet under Expected has a question under Tests and a reader
could disagree with you about the result.
