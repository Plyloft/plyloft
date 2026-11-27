# Principles

A screen that breaks one of these is wrong, however good it looks.

1. **Say where it lives.** Everything a person can change has a scope — Ply,
   Team, Repository or This Mac — and the screen shows it before the person
   has to wonder. Changing something for everyone never looks like changing
   it for yourself.

2. **Words first, truth behind.** A row says what happens in plain words. The
   path, the SHA, the command and the raw output of a tool are one click away
   under **Details**, never the first thing read and never the only thing
   shown. An error says what happened, what was left untouched and what to do
   next; git's own sentence goes in Details.

3. **One way to do each thing.** One button style per meaning, one row
   layout, one place for actions, one way to publish. If a screen needs
   something the catalogue lacks, the catalogue grows; the screen does not
   improvise.

4. **One scale, calm by default** (ADR 0007). Every surface — pages, the
   board, the card, the Inbox, the shell — uses the same type, spacing,
   radius and colour tokens: UI text at 14 px, reading text at 15 px,
   nothing below 12 px, bold stops at 600, labels in sentence case. A surface
   chooses how much it shows through its row height (compact 32 px or
   comfortable 44 px), never through a second vocabulary. Terminals, the
   editor and diffs are dense islands inside calm pages.

5. **Show the outcome, not the mechanism.** "Shared with everyone who opens
   the repo", not "committed to `.atelier/workspace.json` on `staging`".
   "Claude on the other Mac loads it after its next refresh", not "mirror
   rebuilt".

6. **Nothing permanent for something occasional.** A one-off procedure (a
   migration, a health check, an adoption) is one status row that opens a
   flow of its own and then goes quiet. A panel is pinned only if it is about
   what is on screen now.

7. **Reversible by default, explicit when not.** Changes on This Mac save as
   they are made and can be undone. Changes that reach other people are
   gathered and published by one deliberate action that says whom they
   reach. Destructive actions live apart, at the bottom, in words that name
   what is lost.

Other companies' names are written as their owners write them: Claude,
Claude Code, Anthropic, Codex, ChatGPT, OpenAI, GitHub, Git. Lowercase only
for a command, and then in code style (`claude`, `codex`, `git`, `gh`); in
plain text, say "the claude command". Name them only to say what Plyloft
works with ("Codex (from OpenAI)", "Builder (Claude)": the role first, the
tool after). Never "official", "partner", "powered by" or "certified"; never a
mark as a verb ("Claude it") or inside a Plyloft feature's name. No ® or ™ in
running text: the one attribution line lives in Settings › Account › Profile
and, on macOS, in the About panel.

Voice stays as it was: plain, terse, sentence case, English only; mono for
paths, durations and counts; no emoji. The run-state colours mean the same
everywhere: running indigo, done green, failed or stopped amber, crashed red,
empty muted — always a dot and a word. Red is for destroying something and
for that one state (QoL 1.168, A6, owner-approved): a session that crashed (no
exit code, or Claude or Codex ending abnormally), so a dead terminal is not
read as a slow one (a hollow amber ring) or one waiting for you (filled amber
with the tile's border).
