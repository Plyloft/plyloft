---
name: answer-the-reviewer
description: How the Builder replies when the Reviewer pushes back. Use on a changes-requested verdict, and on every later review round. The same skill as ply:answer-the-challenger, its name before 1.173.0.
---

# Answer the Reviewer

A review that asks for changes has named defects. Your reply is a fix and a
sentence about what changed — never an argument that the defect is not one.

## Take the findings one at a time

Each finding has a severity. The blocking ones are fixed before the next round;
a non-blocking one is either fixed or answered with the reason it stays, and it
never changes the verdict on its own.

For each finding, in order:

1. **Say it back.** Restate the defect in your own words. If you cannot, you
   have not found it yet — read the code the finding points at before touching
   anything.
2. **Fix the defect, not the sentence.** A finding about a lost update is about
   the lost update, everywhere it can happen, not about the one line quoted.
   Check whether the same mistake is in the neighbouring paths.
3. **Add the check that would have caught it.** A defect that reached review is
   a missing test as much as a wrong line.
4. **Write what changed.** One line per finding: the defect, the fix, and where.
   "Fixed" is not a reply; neither is a diff with no sentence over it.

## Disagreeing, when you must

Sometimes a finding rests on a reading of the code that is wrong. Say which
reading, quote the code that decides it, and leave the finding open for the
reviewer rather than closing it yourself. Sometimes it is right but out of this
card's scope: say that, say which card it belongs to, and do not widen this one.

## Before the next round

Run the project's verification again, because fixes break things too. Then say,
in the reply, which findings you closed, which you left open and why, and what
the fixes could plausibly have broken — the next review reads your fixes, not
the whole change, and it should know where to look.

Never report a round as approved, and never summarise a verdict you were not
given.
