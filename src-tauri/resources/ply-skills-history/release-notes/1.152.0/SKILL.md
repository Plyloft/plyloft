---
name: release-notes
description: Writes the release note and the status line the same way every time. Use when a change is ready to record, and when a release collects several of them.
---

# Release and status notes

A status entry is read months later by someone deciding whether to touch the
same code. It answers three questions in this order, and nothing else.

## Why

The problem, and the decision behind the shape it took. Point at the specific
issue, the spec section or the decision record — by identifier, so the reader can
open it — rather than repeating their argument. Say what was tried and rejected
when the rejected option is the one a reader would reach for first.

## What

What is true now, in the product's own words. One bullet per fact a reader could
rely on, each one about behaviour: the strings a person sees, the state that is
persisted, the case that used to be wrong and now is not. Name the deliberate
limits in the same list — what this does not do, and what remains a separate
piece of work — because a limit discovered later reads as a bug.

Write it as what the product does, not as what you did. No adjectives about the
work; no counts of files changed.

## Verification

The checks that were run, by name, with their real results. Then, separately, the
walks that still need a human, a signed build or a second machine, listed as
pending with who performs them. A check nobody ran is never written here in any
form, and a known failure is named with its command and its output.

## A release that collects several

Group by what a person would notice, newest first, one line each, and keep every
entry's own identifier so the detail is still reachable. Describe the fix by the
symptom it removes — a reader recognises the symptom, not the cause. Keep the
version numbers the project keeps in step in step, and say nothing about signing,
distribution or timing that has not happened yet.
