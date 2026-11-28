/**
 * Help › New in this version (owner, 2026-10-21): each release's main
 * improvements in a few points, the installed version always shown, the
 * versions the member hasn't looked at below it, and a link to the full
 * changelog on the site. Written at each release from the same text as the
 * release's STATUS entry, in the site changelog's plain words; the owner
 * approves it in the release PR, and the site's changelog entry (drafted by
 * `release.sh` after the tag) is written to agree. `releaseHighlights.test.ts`
 * fails a build whose minor version (x.y.0) has no entry here; a patch
 * release shows its minor's, or its own entry when it has one.
 *
 * Pure data and helpers — no React, no store — so node runs its test.
 */
import type { TutorialProgress } from "./settingsShape.ts";
import type { TourNav } from "./tutorial/manifest.ts";
import { compareVersions, parseVersion } from "./tutorial/whatsNew.ts";

/** A place a point can open: a mode, a Library page, All skills or a
 *  Settings page, in the workspace on screen — never the tour's own card or
 *  workspace. */
export type HighlightNav = Extract<TourNav, { mode: unknown } | { libraryPage: unknown } | { allSkills: true } | { settings: unknown }>;

/** What a point offers besides its words: the place it is about, or the
 *  Getting started tour. */
export type HighlightAction = { nav: HighlightNav; label?: string } | { tour: true };

export interface Highlight {
  text: string;
  action?: HighlightAction;
}

export interface ReleaseHighlights {
  version: string;
  /** ISO date of the release. */
  date: string;
  /** The release's one-line title, as on the site's changelog. */
  title: string;
  /** The most useful first: three to five for a minor release, one to five
   *  for a patch release's own entry. */
  points: readonly Highlight[];
}

/** The site's full changelog (Help › New in this version › Full changelog). */
export const CHANGELOG_URL = "https://www.plyloft.com/changelog";

/** The versions since the last look shown at most (the rest: Full
 *  changelog), newest first. */
export const EARLIER_MAX = 3;

/** The first release with highlights: older ones are on the site only. */
export const FIRST_HIGHLIGHTS = "1.167.0";

/** Newest first. Every release from 1.167.0 on has one. */
export const RELEASE_HIGHLIGHTS: readonly ReleaseHighlights[] = [
  {
    version: "1.179.0",
    date: "2026-11-28",
    title: "Two pairs in Compare, and a second Claude subscription",
    points: [
      {
        text: "Compare two pairs at once: one in the project folder and one in a copy. Each pair has its own bar, named after its project or copy, and the shortcut passes in the pair you are working in. New › Compare in a new copy… opens the second.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
      {
        text: "Include my question: when you pass an answer, Plyloft can put what you asked in that turn before it, so the other session has the context. You can turn it off for one pass.",
      },
      {
        text: "Add a second Claude subscription and choose which one new sessions use. A running session keeps its account, Resume uses the account the conversation started on, and at a usage limit a card offers to start fresh on your other account. Nothing switches by itself.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "Compare is safer and fixed: the plan you pass after Esc is Claude's latest, a held answer no longer goes out stale, and the app says when it cannot read a plan. Security updates to the app's building blocks close 12 of the 13 open alerts; the last is in a library only Linux builds use.",
      },
    ],
  },
  {
    version: "1.178.0",
    date: "2026-11-26",
    title: "Free for one person, and open source",
    points: [
      {
        text: "Everything for one person is free now. Run cards in parallel, with no limit of one card at a time. The Pro plan is gone.",
      },
      {
        text: "You don't need a Plyloft account to work alone. Sign in only to start or join a team.",
        action: { nav: { settings: "plan" }, label: "Open Plan" },
      },
      {
        text: "Team on several computers: you stay signed in on all of them, Team is active on one, and Use Team on this computer moves it here.",
      },
      {
        text: "Plyloft is open source, under the MIT licence.",
      },
    ],
  },
  {
    version: "1.177.1",
    date: "2026-11-26",
    title: "Compare: the answer comes back, and nothing goes into a screen it doesn't know",
    points: [
      {
        text: "After you pass an answer, the other session's reply to it is offered back to the first one, even if either of them answered something else in the meantime. Swap still lets you choose the other way.",
      },
      {
        text: "Compare writes into a session only when it can see that session's own empty box, ready for text. A menu or screen it doesn't recognise is never typed into: the line says it can't tell.",
      },
      {
        text: "After a Claude turn that ended in an error, or one you stopped with Esc, the line no longer stays on \"Claude is working\" until Claude's next turn.",
      },
      {
        text: "Why a button is off no longer spills out of the window when you point at it.",
      },
    ],
  },
  {
    version: "1.177.0",
    date: "2026-11-25",
    title: "Compare: pass an answer from Claude to Codex and back",
    points: [
      {
        text: "Terminals has Compare. With a Claude Code session and a Codex session open, one line under them says which one answered last and passes that answer to the other when you press.",
      },
      {
        text: "Before it goes you choose what to ask the other one (review this plan, carry it out, check this work) and add a note of your own. Send it, or only put it in the other session's box.",
      },
      {
        text: "A plan Claude wrote in plan mode can be passed to Codex while Claude still waits for your approval.",
      },
      {
        text: "Plyloft never answers a question for you: while the other session is working, asks you something or holds text you typed, the line says why it waits.",
      },
      {
        text: "Nothing is kept: the answers you passed and their list are gone when you quit Plyloft.",
      },
    ],
  },
  {
    version: "1.176.4",
    date: "2026-11-24",
    title: "A Setup that says what is left, and an update that says why it waits",
    points: [
      {
        text: "Setup's last screen no longer says Plyloft is ready while an AI tool, Git or a project is missing: it says what won't work yet. The tour is offered once you have a project and an AI tool.",
      },
      {
        text: "The Your AI step says what each Install downloads and from where, why Continue is off, and that your Claude or ChatGPT subscription is paid to Anthropic or OpenAI, not to Plyloft.",
      },
      {
        text: "Setup waits a few seconds for GitHub's answer about your teams, so the Your team step is no longer skipped by a quick Continue.",
      },
      {
        text: "An update set to install when your work is done now says which sessions it waits for, with a button that opens the one asking you something.",
      },
      {
        text: "A skill whose upload to My library ran out of time is kept, and goes to GitHub the next time you add a skill.",
      },
    ],
  },
  {
    version: "1.176.3",
    date: "2026-11-23",
    title: "A clearer first ten minutes, and errors you can act on",
    points: [
      {
        text: "Setup says more where people used to stop: which folder to choose, why the team step is there, and what Start build uses and leaves untouched.",
      },
      {
        text: "Some errors now carry the button that helps: Read it again in the Release sheet and the Inbox, Try again in the file tree, Open the card and Open Program folders.",
      },
      {
        text: "A model name Plyloft doesn't know asks before it is saved, so a typing mistake no longer stops a session from starting.",
      },
      {
        text: "Reset all settings also clears what Plyloft set for you, such as Program folders after a Repair, and the Undo of a page reset puts everything back as it was.",
      },
      {
        text: "On Windows, Ship works right after Git is installed, without restarting Plyloft. A second Ship no longer repeats the Reviewer's comment on the pull request.",
      },
    ],
  },
  {
    version: "1.176.2",
    date: "2026-11-23",
    title: "Safer updates and quits, and errors that say what happened",
    points: [
      {
        text: "Plyloft no longer restarts for an update, or quits without asking, while a Builder is working on a card you aren't looking at. If you quit, the sheet names that Builder.",
      },
      {
        text: "Ship, Release, Merge and Send the fixes to GitHub run once, even if you press the button twice. A press that comes late says that it is still running.",
      },
      {
        text: "A setting Plyloft fixed for you, such as Program folders after a Repair, is no longer undone by your next save in Settings.",
      },
      {
        text: "On Windows, Git or another tool you installed while Plyloft was open is found when you press Look again, and Windows' own messages show their accents.",
        action: { nav: { settings: "diagnostics" }, label: "Open Diagnostics" },
      },
      {
        text: "Error messages say what happened and what to do next. A board that couldn't be read says so instead of looking empty.",
      },
    ],
  },
  {
    version: "1.176.1",
    date: "2026-11-22",
    title: "Program folders say what they find, and Repair points to them",
    points: [
      {
        text: "Program folders in Settings now says which commands it finds. A program typed where a folder belongs, or a folder written with ~, is caught before it is saved, and Plyloft offers the correction instead of letting every tile stop.",
        action: { nav: { settings: "editor-terminals" }, label: "Open Editor and terminals" },
      },
      {
        text: "When Claude Code or Codex works but sits outside your Program folders, Repair empties the setting when your shell already finds the tool, or adds its folder, instead of installing it again, and never says it is repaired while something still breaks.",
      },
      {
        text: "One row in the sidebar says what needs you, with one button to the fix. Diagnostics has Copy report for when you ask for help: no name, no home folder.",
        action: { nav: { settings: "diagnostics" }, label: "Open Diagnostics" },
      },
      {
        text: "The tile shell and the project's start commands are checked when you save them, and a setting that can't work shows in Diagnostics.",
      },
      {
        text: "Codex tiles no longer open on Codex's own update question, and Plyloft tells you once when a tool changed version outside it.",
      },
    ],
  },
  {
    version: "1.176.0",
    date: "2026-11-21",
    title: "Repair for Claude Code and Codex",
    points: [
      {
        text: "If Claude Code or Codex stops starting, Repair looks at it, tells you in plain words what is wrong and what it will do, then fixes it. Your sign-in, projects and settings are never touched.",
        action: { nav: { settings: "diagnostics" }, label: "Open Diagnostics" },
      },
      {
        text: "An install or update now says what really happened. If it didn't work, you're told why and which version still runs, instead of a false \"updated\".",
        action: { nav: { settings: "setup" }, label: "Open Setup" },
      },
      {
        text: "A tile whose tool doesn't start says so right away and offers Repair there. Open tiles are closed first and can be reopened afterwards: each one that had a conversation continues it, and the others open fresh.",
      },
      {
        text: "Codex now updates itself only when you aren't using it, and Plyloft tells you once if that fails. Plyloft also names a tool that is installed twice.",
      },
    ],
  },
  {
    version: "1.175.0",
    date: "2026-11-10",
    title: "Safer sharing, working as two, and a shorter Setup",
    points: [
      {
        text: "You can stop sharing a project's setup in one step, and a setup someone removed stays removed instead of coming back.",
        action: { nav: { settings: "general" }, label: "Open General" },
      },
      {
        text: "On a board shared on GitHub Issues, when two people press Start build at once the second one stops before anything starts, and leaving a card takes your name off its issue.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "Setup is shorter: GitHub for your projects comes right after your Plyloft account, with one OK for everything it needs, and Plyloft works out whether you're on your own or with a team.",
        action: { nav: { settings: "setup" }, label: "Open Setup" },
      },
      {
        text: "A project that isn't on GitHub yet can get its own private repository with Put it on GitHub…, so its cards ship as pull requests.",
        action: { nav: { settings: "shipping" }, label: "Open Shipping" },
      },
      {
        text: "After the Builder fixes what the Reviewer asked for, Plyloft checks the fixes by itself. You can turn this off in AI and models.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
    ],
  },
  {
    version: "1.174.5",
    date: "2026-11-06",
    title: "Text you typed stays out of Plyloft's messages, and a safer pause on Free",
    points: [
      {
        text: "If you've typed something in the Builder's prompt, Plyloft's messages wait until you send or clear it, instead of going in with your text.",
      },
      {
        text: "On Free, a card that can't start no longer pauses the one that's running.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
    ],
  },
  {
    version: "1.174.4",
    date: "2026-11-05",
    title: "A missing branch said on the card, and a cut-off Claude turn in Now",
    points: [
      {
        text: "If a card's branch is neither on GitHub nor on this computer, the card says so and takes you to where you can change it.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "After Resume, Now also tells you when Claude's last turn was interrupted, instead of saying it's done.",
      },
      {
        text: "Check for updates tries again by itself when GitHub doesn't answer.",
      },
    ],
  },
  {
    version: "1.174.3",
    date: "2026-11-05",
    title: "A clearer Members page, and a Now that says what's really happening",
    points: [
      {
        text: "After Resume, Now says the AI hasn't started anything until you send something, and says when its last turn was interrupted instead of calling it done.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "Members keeps each person's status while it reads GitHub. Review access with nothing to do no longer offers to add them, and a Remove GitHub stopped half way tells you how to finish it.",
      },
      {
        text: "Choosing With a team in Setup shows the Your team step straight away.",
      },
    ],
  },
  {
    version: "1.174.2",
    date: "2026-11-04",
    title: "Sharing skills and running a team, with fewer surprises",
    points: [
      {
        text: "Share with Team… now tells you before you press: a skill holding .env, keys or a .git folder is refused on the page, and the row says whether a share adds, replaces or completes the team's copy.",
        action: { nav: { libraryPage: "skills" }, label: "Open Skills" },
      },
      {
        text: "The Members page keeps the latest result in view, says when a seat is taken or freed, and a GitHub name that doesn't exist says so.",
      },
      {
        text: "A Codex card that asks before every change opens its pull request straight away, and Claude on Edits its copy writes the description itself.",
      },
      {
        text: "A project whose folder has gone says so when you move a card, and the note on the Board has its full width.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
    ],
  },
  {
    version: "1.174.1",
    date: "2026-11-03",
    title: "Working as a team, and what Share with Team sends",
    points: [
      {
        text: "Share with Team… now names the repository and lists the files it sends. A skill holding .env, keys or its own .git folder is refused before anything is written.",
        action: { nav: { libraryPage: "skills" }, label: "Open Skills" },
      },
      {
        text: "On a project's pages, a teammate's change to the shared setup reaches you in about a minute. Moving the Board no longer waits ten minutes on a page left open.",
      },
      {
        text: "The Board says more of what a team needs: who holds a card, which teammate's pull request closes it, and when the project's folder is missing.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
    ],
  },
  {
    version: "1.174.0",
    date: "2026-10-31",
    title: "One Release sheet, Settings by task, and the Reviewer",
    points: [
      {
        text: "Release… (in the Board's ⋯, or Release N cards… on the Board's header) takes everything on main since your last release — cards shipped with Ship it included — in one sheet that follows it to the tag.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "The Challenger is now called the Reviewer, everywhere: on the card, in its sessions, in the guide and in its comment on GitHub. It works as before. Ship batch is now Release N cards…, on the Board's header and in the sidebar when two or more cards are ready on Pro.", // ux-allow: names the old name to announce the rename (D10)
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "Settings are grouped by what you want to do: Look and feel, Cards, Project, Team, and Setup and account. Search still finds a moved row by its old name.",
        action: { nav: { settings: "appearance" }, label: "Open Settings" },
      },
      {
        text: "Terminals: Same folder shows only once a file there changed after both sessions opened, and Start a new one in a copy gives the next session a copy of its own. On Windows, Plyloft's shortcuts work inside a terminal too: Ctrl+Shift+K searches, Ctrl+Alt+T opens a new tile, Ctrl+Shift+/ (Ctrl+Shift+7 on an Italian one) shows the shortcuts.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
      {
        text: "Settings › Project › Areas works before you share this project's setup: your areas are kept on this Mac until you share it, one row per area with Edit….",
        action: { nav: { settings: "areas" }, label: "Open Areas" },
      },
    ],
  },
  {
    version: "1.173.0",
    date: "2026-10-30",
    title: "Next improvement, areas, and where your project goes live",
    points: [
      {
        text: "Next improvement above the Board proposes up to five small changes for the area you are on, with what it saw and how to check each; make one a card, change it, or say not to propose it.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "A repository with a site and an app can have areas: each card belongs to one, and each area has its own branch, releases and Next improvement.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "How this goes live, in the Board's menu and in Settings › Shipping, says where cards go, which addresses update when they merge and whether each service is up right now, read from Railway and GitHub's checks.",
        action: { nav: { settings: "shipping" }, label: "Open Shipping" },
      },
      {
        text: "The Challenger is now called the Reviewer, everywhere; it works as before. The Inbox is the one place for what needs you: each card shows as it does on the Board, with its one press, and Clear the news clears only the news.", // ux-allow: names the old name to announce the rename (D10)
        action: { nav: { mode: "inbox" }, label: "Open the Inbox" },
      },
      {
        text: "Start a terminal in a new copy of the code without making a card; when two terminals share a folder, Plyloft offers a copy. Make it a card, open a pull request or throw it away when you're done.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
    ],
  },
  {
    version: "1.172.2",
    date: "2026-10-28",
    title: "Dropping files on terminals and cards",
    points: [
      {
        text: "Drag a file over a Claude, Codex or shell session and it says what the drop will do; after you let go, Adding… shows until the file's path is typed.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
      {
        text: "Drop a file anywhere on a card and it joins the card's Files, which open so you see it arrive.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "A file that couldn't be used is said in plain words — still being saved, too big, or not readable — once per drop, and big files cross much faster.",
      },
    ],
  },
  {
    version: "1.172.1",
    date: "2026-10-28",
    title: "Your project folder, your GitHub issues and the sessions you left, said plainly",
    points: [
      {
        text: "Your project folder says what it is — its branch, its date and how far it is behind GitHub — and asks once: Bring it up to date, or I don't work here. When changes are in the way, a sheet shows them and Claude can save them.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "A Board whose cards are GitHub issues says so under its title, with when it last read them; Get new issues reads them again.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "After a relaunch, Terminals names the session that was open when Plyloft quit, and the offer steps aside as soon as you open one.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
    ],
  },
  {
    version: "1.172.0",
    date: "2026-10-28",
    title: "The card page, in the order you use it",
    points: [
      {
        text: "A card you haven't built yet starts with what you want: Start build, one Plan it first menu, then the brief and who builds it.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "One Review holds the checks, the Reviewer, other cards that change the same files, and Ship it. On a wide window it sits beside the Builder's session.",
      },
      {
        text: "What you ask after the first result is kept on the card as Asked later, and the Reviewer checks the work against it too.",
      },
      {
        text: "A card's ⋯ menu is grouped and never repeats what Now offers, and one Details holds the files, the history of runs and the technical lines.",
      },
      {
        text: "After a session closes you can choose again how the Builder asks you before Start fresh.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
    ],
  },
  {
    version: "1.171.0",
    date: "2026-10-27",
    title: "A card that says where your change is and what to press",
    points: [
      {
        text: "Every card shows where its change is, from this computer to GitHub, and never says Shipped while its pull request still waits. The Board says what to press on each card that needs you.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "One Ship ▾ everywhere, with names that say what happens: merge when checks pass, open the pull request only, or keep it on this computer.",
      },
      {
        text: "Waits are explained: after Finish and check the card says what is happening and for how long, and you can leave it. While the Builder fixes the Reviewer's findings, the card says so.",
      },
      {
        text: "Choose how the Builder asks you before it changes files, on the card before Start build or in Settings. Asks before every change stays the default.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "Adding a folder with work that isn't saved yet offers to save it first, so your cards start with it.",
      },
    ],
  },
  {
    version: "1.170.0",
    date: "2026-10-27",
    title: "Ship it puts your card on GitHub",
    points: [
      {
        text: "Ship it now opens a pull request on GitHub and merges it when the checks pass, on the Free plan too. The Builder writes its title and description, which you can edit. To keep a change on this computer only, pick it from the Ship ▾ menu.",
        action: { nav: { settings: "shipping" }, label: "Open Shipping" },
      },
      {
        text: "After the merge, the card's branch is deleted on GitHub and your main branch on this computer is brought up to date.",
      },
      {
        text: "A card that falls behind main says so: Bring in main's changes adds them to the card's copy without rewriting its work, and a conflict is said before you ship.",
      },
      {
        text: "Turn on Fix failing checks by itself and the Builder fixes a pull request whose checks failed, up to three tries, each reviewed before it's pushed.",
      },
      {
        text: "Releases on GitHub go through a pull request: Plyloft merges it when its checks pass, then tags the merge commit.",
      },
    ],
  },
  {
    version: "1.169.1",
    date: "2026-10-26",
    title: "Pull requests that ask for you, releases that never break your folder",
    points: [
      {
        text: "A pull request whose checks passed on GitHub now asks for you: the card moves to Needs you, and the Inbox says \"Ready to merge on GitHub\" with its own Merge.",
        action: { nav: { mode: "inbox" }, label: "Open the Inbox" },
      },
      {
        text: "Ship it, on GitHub, never carries other cards' work without asking: it stops and lists the changes that aren't on GitHub yet, and you choose to include them or cancel.",
      },
      {
        text: "Codex commits in the card's own copy without stopping to ask, and still can't touch your main branch.",
      },
      {
        text: "A release never leaves your project folder half-done: if anything stops it, the folder is put back as it was. A protected main branch is said before anything changes, and a release stuck on one can be undone.",
      },
      {
        text: "Clearer GitHub errors: a refused sign-in, an SSH key, a protected branch, a secret or a file over 100 MB each say what happened and what to do, and Ship it says whether your change is on GitHub or only on this computer.",
      },
    ],
  },
  {
    version: "1.169.0",
    date: "2026-10-23",
    title: "Effort for both AIs, Retry on another model, terminals that behave",
    points: [
      {
        text: "Choose how hard Claude and Codex think: each model shows the efforts it takes, the menus list the newest models, and the list updates itself.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "Retry on…: run a finished or failed Builder or Reviewer round once more on another model; the card keeps its own model, and History shows both attempts.",
      },
      {
        text: "A team can suggest models and effort for its repository; your own choices still come first.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "Terminals: ⚠️ ❤️ and other emoji take their full width, a tile no longer reads Working while you type or resize, quitting ends every process a tile started, and on Windows Claude follows light and dark without a restart.",
      },
      {
        text: "Smaller: Help is a row in the sidebar, the shortcut sheet opens with your keyboard's \"/\" (⌘⇧7 on an Italian one), removing a repository skill can be undone for 10 s, and Switch to Team asks you to tick your agreement.",
      },
    ],
  },
  {
    version: "1.168.1",
    date: "2026-10-22",
    title: "Your model everywhere, tiles that follow light and dark, a History you can trust",
    points: [
      {
        text: "The model you choose now reaches planning, Plan with two AIs, a card's Chat and agent runs, and each card can choose its own Builder and Reviewer model — the card shows the one in use, or the tool's default.",
        action: { nav: { settings: "claude-codex" }, label: "Open AI and models" },
      },
      {
        text: "History says what happened: a finished build reads Built, Open session fits, search results keep their spaces, and a deleted card's runs and checks stay, marked as from a deleted card.",
        action: { nav: { mode: "activity" }, label: "Open History" },
      },
      {
        text: "Claude and Codex tiles follow a switch between light and dark (on Windows, an open Claude session offers Restart to change), Codex stays readable, and wide emoji like 👋 take their full width.",
        action: { nav: { settings: "appearance" }, label: "Open Appearance" },
      },
      {
        text: "Planning and Try it: Claude and Codex name the real Finish planning button, you stay on the card after it, and Try it shows its setup command and saves it only when you press Set it up and try.",
      },
      {
        text: "Smaller fixes: messages say so when a project has no checks set up, Setup's step names wrap, team workspaces go to the projects folder chosen in Setup, and on Windows the Updated to notice no longer comes back.",
      },
    ],
  },
  {
    version: "1.168.0",
    date: "2026-10-22",
    title: "Nothing lost, sessions that continue, and a Board that says what needs you",
    points: [
      {
        text: "Nothing gets lost: quitting or closing a tab asks first when a file isn't saved or work would stop halfway, Done no longer archives a card, and every archived card can be restored.",
      },
      {
        text: "Sessions that continue: an ended Claude or Codex tile offers Continue, the sessions open when you quit come back, each tile takes its conversation's name, and New › Resume… picks up any conversation from the last 28 days.",
        action: { nav: { mode: "terminals" }, label: "Open Terminals" },
      },
      {
        text: "A clearer Board: five columns — Needs you, Not started, Working, On hold, Done — a tile needs you only when it asks, the card's next step is at the top, and you can move around the Board with the keyboard.",
        action: { nav: { mode: "board" }, label: "Open the Board" },
      },
      {
        text: "History in tabs — Runs, Ships, Checks, Sessions, Discussions — with a workspace and a text filter, no dollar figures, and search results that open what they found.",
        action: { nav: { mode: "activity" }, label: "Open History" },
      },
      {
        text: "Easier every day: text size and zoom for terminals and the editor, hidden files and file actions in Code, Check for updates, and Install when my work is done.",
        action: { nav: { settings: "editor-terminals" }, label: "Open text size" },
      },
    ],
  },
  {
    version: "1.167.0",
    date: "2026-10-21",
    title: "A guided tour, every skill in one place, and Try it",
    points: [
      {
        text: "Getting started: Plyloft shows you each part of the app while you build your first card, in your own project. It points at the real buttons and waits for you. There's also a 1-minute tour.",
        action: { tour: true },
      },
      {
        text: "Try it: run a card's result from the card and see it in Plyloft's preview before you ship it.",
      },
      {
        text: "All skills: every skill on this computer in one place, where each copy is used and whether it's up to date. Copies remember where they came from and update through a card.",
        action: { nav: { allSkills: true }, label: "Open All skills" },
      },
      {
        text: "My library (Pro): your own skills in a private repository on your GitHub account, on every computer where you use Plyloft.",
      },
      {
        text: "One state everywhere and plainer words: the Board, the card page and the Inbox say the same thing about a card, and a Builder that is waiting for you says so.",
      },
    ],
  },
];

/** The entry for `version`, or the newest one before it (a patch release
 *  with no entry of its own shows its minor's). */
export function highlightsFor(
  version: string,
  list: readonly ReleaseHighlights[] = RELEASE_HIGHLIGHTS,
): ReleaseHighlights | null {
  if (parseVersion(version) == null) return null;
  return list.find((r) => compareVersions(r.version, version) <= 0) ?? null;
}

/** The last version the member looked at New in this version for. */
function seenOf(record: TutorialProgress | null | undefined): string | null {
  return parseVersion(record?.seenVersion) != null ? record!.seenVersion! : null;
}

/**
 * What the sheet shows: the installed version's highlights first, then the
 * versions between the one last looked at and it, newest first. A new
 * install is stamped with its own version (`helpStore.ts`), so it has no
 * older ones.
 */
export function highlightsToShow(
  record: TutorialProgress | null | undefined,
  version: string,
  list: readonly ReleaseHighlights[] = RELEASE_HIGHLIGHTS,
): { current: ReleaseHighlights | null; earlier: ReleaseHighlights[] } {
  const current = highlightsFor(version, list);
  if (!current) return { current: null, earlier: [] };
  const seen = seenOf(record);
  const earlier = list
    .filter((r) => compareVersions(r.version, current.version) < 0 && (seen == null || compareVersions(r.version, seen) > 0))
    .slice(0, EARLIER_MAX);
  return { current, earlier };
}

/** The dot on Help: this version's highlights not looked at yet. */
export function highlightsUnseen(record: TutorialProgress | null | undefined, version: string): boolean {
  const current = highlightsFor(version);
  if (!current) return false;
  const seen = seenOf(record);
  return seen == null || compareVersions(current.version, seen) > 0;
}
