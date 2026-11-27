# Getting started with Plyloft

Plyloft runs your software projects with AI coding agents. You write what you
want on a card, an agent works on it in a separate copy of your code, and you
review the result before it becomes part of your project.

This guide takes you from nothing to your first finished card, on a Mac or a
Windows PC. It describes Plyloft with its guided setup (the release after
1.152). Setup takes a few minutes, plus the time to download what it installs.

---

## 1. What you need

**A computer**

- **Mac:** a Mac with Apple Silicon (M1 or later) and macOS 11 (Big Sur) or
  later. Macs with an Intel processor can't run Plyloft.
- **Windows:** Windows 11, 64-bit (x64).

**One AI subscription** — one is enough:

- **Claude** (from Anthropic), Pro or Max plan, for Claude Code; or
- **ChatGPT** (from OpenAI), Plus, Pro or Business plan, for Codex.

Plyloft uses your own subscription through the official command-line tools. It
never asks for an API key. Each tool signs in with its own account: your
password goes into the tool's own page in your browser, never into Plyloft.
Plyloft reads the sign-in's output only to show its code and see when you're
done, and never saves it. If you have both subscriptions,
Plyloft can use one to build and the other to check the work (see section 6).

**A GitHub account**, to send your work to GitHub as pull requests (step 3)
and, if you work with a team, to sign in to Plyloft. It is free, and you can
create one during setup. The Plyloft sign-in only says who you are: Plyloft
asks GitHub for no access to your repositories. Your projects can still stay
on your computer only.

**Optional**

- **Administrator rights** on Windows make installing Git for Windows
  smoother. Without them, see the troubleshooting section.

You don't need to install anything else first. Plyloft finds what is missing and
installs it for you, after asking.

---

## 2. Installing Plyloft

### On a Mac

1. Download the latest Plyloft `.dmg` (`Plyloft_…_aarch64.dmg`) from the
   Plyloft download page,
   <https://github.com/MatteoB-adv/ply-releases/releases/latest>.
2. Open it and drag **Plyloft** into **Applications** (it is `Plyloft.app`).
3. Open Plyloft from Applications. It is signed and notarized by Apple, so it
   opens without a warning.

Plyloft keeps itself up to date: when a new version is ready, a line at the
bottom of the sidebar says so, with **Install**. Before it installs, Plyloft
says what restarting stops (the open sessions and terminals, and any work
still in progress). **Install when my work is done** waits instead: it
installs once nothing is working and you haven't used Plyloft for two
minutes, with its window in front — a command still running in a terminal
(a dev server, a build), an unsent message in a session, an unsaved file or
an open sheet keeps it waiting — or, on the Mac, when you quit. Open
sessions and terminals still close when it restarts; Claude and Codex keep
their conversations.
To look for a new version yourself, choose **Check for updates…** in the
Plyloft menu (on Windows, in **Help** in the sidebar), or in Settings › Setup and account › Profile ›
Updates. After an update, a short note says **Updated to …** and opens
**New in this version**.

### On Windows

1. Download the latest Plyloft installer (`Plyloft_…_x64-setup.exe`) from the same
   download page, <https://github.com/MatteoB-adv/ply-releases/releases/latest>.
2. Run it. Windows may show **"Windows protected your PC"** (SmartScreen),
   because the installer isn't signed with a Microsoft certificate yet.
   Choose **More info**, then **Run anyway**.
3. Plyloft installs for your user (in `%LOCALAPPDATA%\Plyloft`, no
   administrator needed), starts when the installer finishes, and is in the
   Start menu.

Closing Plyloft's window asks first: **Keep running in the notification area**
(near the clock), so your agents keep working, or **Quit Plyloft**. When
Windows shows no notification-area icon for Plyloft, the choice reads **Keep
running, minimized** and the window goes to the taskbar instead. Tick
**Don't ask again** to keep that answer; change it any time in Settings › Look and feel ›
Appearance › **When I close the window**. To quit from the notification area,
right-click its icon and choose **Quit Plyloft**, or press **Ctrl+Shift+Q**.
Updates install themselves the same way as on the Mac.

---

## 3. The first-run setup, step by step

The first time Plyloft opens, it shows **Set up Plyloft**: a full-window guide with
numbered steps on the left (step by step) and a progress bar at the top. If
you already used Plyloft before this version, it opens once as **Plyloft can
now set itself up**, over your open projects.

- **Back** and **Continue** move between steps. On some steps the main button
  is the step's own action (for example **Save to Git** or **Connect
  GitHub**). Every step you can do later has **Skip for now**.
- **Continue** goes to the next step that still needs something. A step
  Plyloft finds already done on your Mac (for example Git and your name, or
  your AI) is passed over; it stays in the list, marked **Done**, and you can
  click it to look. **Ready** says which ones Plyloft found.
- **Close setup** (top right) closes it; it doesn't open by itself again.
- You can quit Plyloft at any point. Next time, setup opens where you left off.
- Before Plyloft installs anything, changes your Git settings, or creates
  something on GitHub, it shows what it will do and waits for you to confirm.
  Under **Details** you can see the exact commands.
- When Plyloft installs a tool or signs you in, a small terminal appears inside
  the step so you can watch. You don't have to type anything in it unless a
  question appears there.

If you close setup with something important still missing, a line at the
bottom of the sidebar says **Setup isn't finished · Finish**. Click **Finish**
to go back.

### Step 1 — Welcome

Plyloft asks how much you've used Git and a terminal:

- **I'm new to this** (already chosen; press **Continue**) — one step per
  screen; Plyloft explains each step and asks before it changes anything.
- **I use them regularly** — one checklist screen, **Just the essentials**,
  with every step and what Plyloft found; rows marked done need nothing from
  you.

Both do the same things; you can switch at any time with **Switch to just
the essentials** / **Switch to step by step** at the top right of setup.

### Step 2 — Your Plyloft account

**Only for teams.** Skip this if you work alone: press **Continue** and the
step says *Skipped*. Everything for one person works without a Plyloft
account, and you can sign in later in **Settings › Setup and account ›
Plan**.

To sign in now, press **Sign in with GitHub**. Plyloft shows a one-time code:
press **Open github.com/login/device** (or **Copy code** and open the page
yourself), enter the code there and allow Plyloft. The step then says who
you're signed in as and your plan (for example *Signed in as sam-rivera ·
Free*). This sign-in is separate from the GitHub connection in step 3.
**No GitHub account? Create one** opens GitHub's sign-up page; come back and
sign in.

Team features run on one computer at a time. If you have a Team plan or a
seat on one, the computer where you press **Use Team on this computer** is
the one that has them; pressing it on another computer moves them there.
Signing in on another computer doesn't move anything, and nobody is signed
out. On the Free plan there is nothing to move: two computers both work, with
no notice. If Plyloft can't check a Team plan for a long time (no internet),
it says so and offers **Check now**.

### Step 3 — GitHub for your projects

The step's title says what it is: **Connect GitHub for your projects**. It
is not your Plyloft account. It lets this Mac send your work to GitHub: **Ship it** puts each finished card there as a pull
request, and it is how teams share work. You can skip it (**Skip for now**):
then Ship it keeps your changes on this Mac, and you can connect GitHub any
time in **Settings › Setup and account › Setup**.

Three rows say what is there — **GitHub command** (how Plyloft talks to
GitHub), the account it's signed in as, and **Git uses your GitHub sign-in**
— and one button does what is missing: **Connect GitHub**. It opens one sheet,
*Connect GitHub on this Mac?*, that names only the parts still to do, with the
exact commands under **Details**; nothing runs before you confirm. Then the
parts run in order and the rows follow them (Installing · Next · Signing in ·
Ready). For the sign-in, GitHub gives a new code, shown in its own block:
press **Open github.com/login/device**, enter the code there and approve. If
the code expires, the step says so and offers **Get a new code**; if you stop
the sign-in, it asks again.

- **No Git yet?** (a Mac without Apple's Command Line Tools, a PC without Git
  for Windows) The last row says "Once Git is installed, in step 5." Your yes
  is kept, and step 5 does it after it installs Git, then says "Git now uses
  your GitHub sign-in."
- **Several GitHub accounts** (for example personal and work)? Choose **Add
  another account** and sign in again. With more than one account, Plyloft
  asks which one each project uses (**GitHub account**) when you add it.
- **Skip for now** keeps you local-only. If you're joining a team, Plyloft
  asks first: the Team step waits until GitHub is connected.

**On your own or with a team.** Setup doesn't ask: it works it out. A Team
plan (yours, or a seat on one), a project whose board is on GitHub Issues, a
team joined on this computer, or — once GitHub is connected — a Plyloft team
or a repository invitation waiting for your GitHub account adds **Your team**
(step 6). Otherwise you're set up on your own, and a link under the step
list says "Joining a team? **Add the team step**": it asks the question, and
says why you see it ("Plyloft found no team for octocat, so it set you up on
your own."). You can change it later in **Settings › Setup and account ›
Setup › Work with a team** (section 7).

If you press **Continue** or **Skip for now** on **Your AI** before GitHub has answered about your
teams, Setup waits with "Looking for your teams…" for up to six seconds, so
**Your team** isn't missed, and then goes on either way.

### Step 4 — Your AI

Plyloft looks for Claude Code and Codex.

- **Already installed?** Plyloft checks it and whether you're signed in. If a
  newer version exists (or your Claude Code is too old for Plyloft), the row
  offers **Update**; a Codex that won't start offers **Reinstall**. Claude Code
  and the GitHub CLI are updated only when you press **Update**. Codex also
  updates itself in the background, at most once a day, but only when no
  Codex is open or starting and a few minutes have passed since the last one
  (opening a tile never starts it). If a Codex tile opens while it runs, the
  tile says so and starts as soon as the update is done. When it fails,
  Codex keeps working on its old version, and Plyloft tells you once.
- **An install or update that didn't work?** Plyloft says what happened in
  plain words (the folder it wasn't allowed to change, a full disk, no
  network, a file in use) and what is still true: the tool stays on the
  version it had. It never says "updated" unless the version really changed.
  Press **Repair** beside the message to fix it (see the troubleshooting
  entry *Claude Code or Codex doesn't start*, below).
- **Not installed?** Press **Install**. Plyloft downloads the official installer
  from Anthropic or OpenAI and runs it for your user. On Windows, Claude Code
  needs Git for Windows: if it's missing, Plyloft offers **Install both** and
  installs Git for Windows first (Windows may ask for an administrator's
  permission). Codex installs with OpenAI's own installer, for your user
  only, with no administrator and no Node.js.
  Before you press, a line under the rows says what each **Install**
  downloads and from where, and a sentence reminds you that the Claude or
  ChatGPT subscription is paid to Anthropic or OpenAI and isn't included in
  Plyloft. If you chose one under **Which do you have?**, its **Install** is
  the filled button. While **Continue** is off, a line says what is missing,
  and **Skip for now** says what won't work until an AI tool is ready.
- **Not signed in?** Press **Sign in**. Your browser opens on the provider's
  page. Sign in there and come back; Plyloft notices by itself when you're done.
  For Codex, if the browser page can't reach Plyloft (some company networks),
  choose **Sign in with a code instead**.
- **No subscription yet?** Under **Which do you have?** (shown while neither
  tool is installed), choose **Neither yet**. **Get Claude** opens
  claude.ai/upgrade and **Get ChatGPT** opens chatgpt.com/pricing in your
  browser. Subscribe there, then come back.

**About Claude plans.** Plyloft works with Pro and Max. Pro reaches its usage
limit sooner, so a long build can pause until your limit resets. You can
start with Pro and upgrade later. If you use Claude Code with an API key
instead of a plan, Plyloft accepts it: the row says **Ready, with an API key**.

**One AI or two.** With one AI, it both builds your cards and reviews them,
in separate sessions. When you ask two views on a plan (a discussion), they
come from two separate sessions of the same AI with different roles, and the
result says so. With both Claude and Codex, you choose which one
builds in **Who builds your cards**; the other reviews, which gives you a
more independent second opinion. You can change it on any card. It's
optional.

**Notifications.** At the bottom of the step, Plyloft offers to tell you
when a card is ready or needs a fix, and when Claude or Codex waits for you,
while you're in another app. On a Mac, **Allow notifications** makes macOS
ask you once. On Windows nothing needs allowing: the row says notifications
are on and **Send a test** shows one. It's optional; **Continue** goes on
whatever you choose, and Settings › Look and feel › **Notifications**
shows it again later (with **Open System Settings** if they
were turned off).

### Step 5 — Git and your name

Git keeps the history of your project. Plyloft uses it to give each card its own
copy of your code and to merge the finished work back.

- **Mac:** if Git is missing, press **Install** and confirm: Plyloft asks macOS
  to install Apple's Command Line Tools. A macOS window appears; click
  **Install** there too. It can take several minutes.
- **Windows:** press **Install Git for Windows**, which includes Git Bash.
  Plyloft needs Git Bash to run your project's checks.
  A line says that the installer runs through winget, Windows' package
  installer, and that Windows may ask for an administrator's permission.

If you skip this step, a line says what won't work: Plyloft can't give cards
their own copy of your code until Git works.

Then Plyloft asks for **your name and email**. They appear on every change you
save. Plyloft fills them in from Git's settings, from your GitHub account if
you're already signed in there, or from your computer's user name. If your
GitHub email is private, choose **Use my private GitHub address**
(`…@users.noreply.github.com`: "From your GitHub account. It keeps your real
address private."). Press **Save to Git** and confirm. If you said yes to
Git using your GitHub sign-in in step 3 before Git was installed, this step
does it now.

### Step 6 — Your team (team only)

A Plyloft team is a private GitHub repository that lists who is in it, which
projects you share, and a library of skills your agents can use.

The step says why you see it: GitHub lists you in a Plyloft team (it names
it), or an invitation waits. When GitHub lists teams, each is an option, **Join
<team>**, and the first is chosen; when only an invitation waits, **Join a
team** is chosen, with its invite-code field; otherwise nothing is chosen and
nothing is looked up until you choose **Join a team**. **Not now** is a choice
like the others: it keeps you on your own, saves the same as skipping the step,
and the team can be added any time in **Settings › Team › Members and
library**. It is also there when the step says **Connect GitHub first**. There
is no **Skip for now** here, and **Continue** is always available: with a team
chosen it opens the sheet for that team (never joining by itself; **Cancel**
keeps you on the step, and **Not now** is the way on), with an invite code typed
it asks with that code, and with nothing to ask it says what to choose. If
GitHub refused or the look failed, it says so once and the next **Continue**
goes on without joining.

- **GitHub first.** If you skipped GitHub in step 3, this step waits and
  says **Connect GitHub first**. You can go on with the other steps and come
  back.
- **Join a team.** If the team's owner has already added you and you can
  see the team's repository, Plyloft finds the team and shows **Join** with
  its name (**Look again** searches again). Otherwise, paste the invite code
  the owner sent you (it looks like `ply-join:owner/team`; a
  `https://github.com/owner/name` link works too) and press **Look it up** (or
  **Continue** at the foot of the step);
  Plyloft accepts the GitHub invitation for exactly that repository when you
  confirm. Either way, a sheet shows which repository and owner the team
  belongs to; check they're who you expect, then press **Join**. After
  joining, tick the team's projects you want on this computer and press
  **Get N projects** (they go in your projects folder; the first time, its
  row is there to change). A computer is in one team at a time: joining another
  asks whether to replace the first.
- **Create a team.** Give it a name (Plyloft suggests the repository's name;
  you can change it) and press **Create team**. Plyloft creates the private
  repository on your **active** GitHub account and makes you the owner (to
  use another account, make it the active one in step 3 first). Then, under
  **Invite people**, type each person's GitHub login, press **Review**, check
  what will be granted and press **Send invites**. Finally press **Copy
  invite** and send them the message: it says where to download Plyloft, to
  accept the GitHub invitation, and the code to paste.

The team runs on the owner's Team plan, with one seat per member: the owner
gives each person a seat. Everything you do on your own stays free; the Team
plan adds the shared GitHub Issues board with claims and the team library.
Each member signs in to Plyloft (step 2, or later in **Settings › Setup and
account › Plan**) to use their seat.

### Step 7 — Your first project

Choose one. For a folder, Plyloft says what to choose: the folder that holds
your project, the one with your files in it; it never changes that folder
while you build, because each card works in its own copy. The folder picker
opens on your Projects folder (or your home folder when there is none yet).

- **A folder on this Mac / this PC** — code you already have.
  - If it isn't a Git project yet, Plyloft offers to start Git in it and save
    everything as the first version. It adds a `.gitignore` that leaves out
    things like `node_modules`, build output and `.env` files. If it finds
    files that look like passwords or keys, or very large files, it lists
    them (large means over 50 MB) and leaves them out; you can untick one
    to keep it, after a warning.
  - If the folder is inside a bigger Git project, Plyloft offers to use the
    bigger project instead.
  - If the project isn't on GitHub yet and GitHub is connected, **Also keep a
    private copy on GitHub** (off unless you tick it) names the repository it
    would create, for example `octocat/lyra`, and the branch it sends. Ticked,
    **Add to Plyloft** asks "Add “lyra” and put it on GitHub?" first; the copy
    is made the same way as **Put it on GitHub…** (see How Ship it ships). If
    GitHub isn't connected, it says where to do it later.
  - If the folder has changes that aren't saved in Git yet, Plyloft asks
    first, because cards only see what's saved. **Leave my changes in the
    folder** is chosen at first: it adds the project as it is and writes
    nothing. Your changes stay in the folder, and a card started from that
    branch says its copy doesn't have them.
    **Save them as a commit on main first** (it names the folder's branch)
    saves them as one commit on that branch, in that folder only (nothing
    is uploaded), after a sheet that lists what is saved. It leaves out
    passwords, keys, very large files and new package or build folders
    such as `node_modules` (you can untick one), adding a line to
    `.gitignore` only for each new file or folder you leave out (under a
    `# Added by Plyloft` line; the sheet's Details lists them all); folders
    that are Git projects of their own are left as they are. If your
    project runs a check before saving and it refuses, nothing is saved
    and the sheet says why. While Git is in the middle of combining changes
    in the folder, only **Leave my changes in the folder** is offered.
  - The button says what will happen: **Add to Plyloft**, **Save and add**,
    **Start Git and add**, **Use “…” instead** (the bigger project), or **Open it** when the
    project is already in Plyloft.
- **From GitHub** — pick one of your repositories (or your team's). Plyloft
  downloads it into your projects folder (see below), showing progress. If a folder with
  that name is already there, choose **Put it somewhere else** or **Add that
  folder instead**. If the repository is empty on GitHub, press **Make the
  first commit**: Plyloft adds a README, saves it as the first version and
  sends it to GitHub. This way needs GitHub; if you skipped step 3 it says
  **Connect GitHub first**.
- **A new, empty project** — type a name and press **Create project**. Plyloft
  creates the folder, starts Git and saves a first version with a README. If
  GitHub is connected, you can tick **Also keep a private copy on GitHub**
  (off unless you tick it).

**Projects folder.** New projects and the ones you get from GitHub go in
the `Projects` folder in your home folder. **From GitHub** and **A new,
empty project** show it as a row — "New projects and the ones you get from
GitHub go here." — with **Change…** to pick another one; there is nothing to
press to accept it, and it is kept once the first project is made or
downloaded there. Folders you already have stay where they are. Avoid
folders synced by iCloud Drive or OneDrive: syncing can damage Git projects.
Change it later in **Settings › Setup and account › Setup › Projects
folder**.

**Another project later.** The same three ways are in **Add a project**: the
**+ Add a project…** row in the project switcher at the top of the sidebar,
**⌘K** / **Ctrl+K** › **Add a project…**, or the button Plyloft shows when it
has no project yet. Once the project is in, the sheet closes and its Board
opens. If something goes wrong, the sheet says what, in words.

### Step 8 — How Plyloft builds your project

Plyloft looks at your project and says, in plain words:

- which branch cards start from and are merged back into (usually `main`);
- which checks run before a card can ship — or that there are none yet (a
  new project starts with none);
- where the version number is kept, if anywhere;
- whether anything runs after shipping.

The step's title names your project (*How Plyloft builds “my-app”*). If it
sounds right, press **Looks right**. Otherwise press **Change** to pick the
branch cards start from or turn the checks on or off, then save. If your
project already shares its settings in the repository, the step just shows
them. You can fine-tune everything else later in **Settings › Cards ›
Building and checking**.

### Step 9 — Ready

Setup says **Plyloft is ready** and shows a summary. When something required
is still left (an AI tool, Git, your name and email, or a project), it says
**Setup isn't finished** instead, with one sentence on what won't work until it
is done. Anything not finished is listed under **Still to do**, each with
**Finish**. Press **Open** followed
by your project's name to go to its board (**Go to Plyloft** when there is no
project yet).

If you chose "I'm new to this", the tour is offered only when a project and an
AI tool are ready. Then **Start the tour** is the main button once
nothing required is missing, and **Not now, open** your project sits beside
it. Ready says what the tour is: the Getting started tour points at the real
buttons while you build your first card in your project, never presses
anything for you, and Help › Getting started picks it up again (see *The
Getting started tour* in the next section).

If you chose "I use them regularly", **Take a 1-minute tour** gives a quick
look at each part instead; nothing is pressed for you. The guided first card (next section) is in
**Settings › Setup and account › Setup › Guided first card**.

---

## 4. Your first card

A card is one task. Its life:

1. **New card** — give it a title and write what you want under **What you
   want**, in plain words, the way you'd ask a colleague. A card with only
   its title can start too: it says **Ready to start**, and Claude gets just
   the title. To work it out together first, choose **Plan it first ▾** beside
   **Start build**: **Plan it with Claude** asks you questions and writes the
   plan the Builder follows, and **Plan with two AIs** has one AI write it and
   the other question it.
2. **Start build** — the agent (the *Builder*) opens inside the card and
   works in its own copy of your project. You can watch, answer its
   questions, or do something else. The Inbox tells you when it needs you.
3. **Finish and check** — when the agent says it's finished, press
   **Finish and check**. The agent re-reads its own work first, then Plyloft
   saves it, runs your project's checks, and the *Reviewer* — a second AI
   that reviews the change; it can't edit — reviews it. (The **?** beside
   **Reviewer** on the card's facts line says the same.) Meanwhile the
   card says what is happening and for how long (**Claude is re-reading its
   work · 1m 20s**, then **Running checks**, **Reviewing**); you can leave
   it, and Plyloft tells you when it's done. If the work isn't finished, tell
   the agent what's missing instead. An AI session is always in one of five
   states, the same on the card, the Board, the Inbox and Terminals:
   **Working**, **Asks you something**, **Your turn** (it says it's done:
   check it, or tell it what's missing — the card moves to Needs you),
   **Closed**, and **Paused · your plan's limit resets at 15:00** when your
   Claude plan's limit is reached. If Plyloft was closed while the agent
   re-read its work, the card says **Finish and check stopped** and offers
   **Finish and check again** (it saves the work as it is) or **Resume**.
   **Finish and check ▾** has one other way: **Check without the
   Reviewer**, for that press only. Your checks still run, but the Builder
   doesn't re-read its work and the Reviewer doesn't review it. The card
   then counts as unreviewed: on a project on GitHub, **Ship it ▾** offers
   **Open the pull request anyway (I merge it)** or **Only on this Mac**,
   nothing merges by itself, and the pull request says the review was
   skipped.
4. **Review** — read the review and the changes, in the card's **Review**
   (**Read the review** opens it). If the Reviewer asked for
   changes, Plyloft sends its findings to the Builder, which works on them:
   the card says so (*Claude is fixing 3 findings · 2m*) and sits in
   **Working**. When it's done, Plyloft checks the fixes by itself (from
   1.175): Finish and check starts without a press (*Checking the fixes by
   itself*, with **Stop**), your checks run and the Reviewer reviews them.
   It does so only when the Builder finished cleanly, and twice in a row at
   most; **Don't check by itself** on the card keeps this round for you. When
   it can't — the Builder was interrupted, asks you something, changed
   nothing, there is text in its prompt, or the Reviewer asked for changes
   three times — the card says why and moves to **Needs you**, with **Finish
   and check again** on the card itself — or, if it disagrees with a finding and you side with it,
   **Agree with Claude, keep it as it is** beside it (while it works, that is
   in the card's ⋯). When the findings never reached the Builder, the same
   choice is **Ship without these changes**. Either way nothing is changed
   or shipped yet: the card moves to **Ready to ship** and its facts say
   **Overridden by you**. Changes you send yourself once there is a result —
   **Not right — tell the Builder what's wrong** in the Review, or **Send to
   the Builder** in the card's chat —
   go the same way: while the Builder works on them the card says *Claude is
   working on your changes*, then *Claude finished the fixes*, and **Finish
   and check again** checks and reviews them. Each one you send is kept on
   the card under **What you want**, as **Asked later**, and the Reviewer
   reviews the work against it too. An approving review reads **Approved** everywhere — with
   *(2 small notes)* when it left findings that don't block, each marked
   **Small note · nothing to do** — and *(1 small note from round 1)* when an
   earlier review left it and it's still on the card. (If the
   findings didn't reach the Builder — its session was closed, say — the card
   says *Claude doesn't have the findings yet* and offers **Send the findings
   to the Builder**. An approval needs nothing from you: Plyloft gives it to
   the Builder when it's free, and **Details › Technical** note it until then.)
   To see the change
   running before you ship it, press **Try it** (see *Seeing it running*).
5. **Ship it** — on a project on GitHub, Plyloft opens a pull request for
   the change and merges it when its checks pass; the card goes to Done when
   GitHub has merged it. Local-only projects merge on your computer. See
   *How Ship it ships*.

### The card's page

A card's page reads from top to bottom. What sits on it depends on how far
the card has got.

**Always there.** The crumbs above the title say where the card sits on the
Board (*Board › Needs you*). Beside the title are **Ask about this card** and
the card's **⋯**. Under the title comes the **Now** box: what is happening and
the one thing to press. The card's facts follow on one line, in words: who
builds it, how it asks you (**Permissions**), its checks (with **See the
checks** once there is something to see), the Reviewer's word (the **?**
beside it says what the Reviewer is), its **Area** where the repository has
two or more (**Not chosen yet** until it has one) and, only when the card
waits for another, **Blocked by** with the cards it waits for.
**Change…**, last on the line, opens the choices under it: who builds it, how
it asks you, each AI's model and **Retry on…**, the card's area while it
hasn't started, and **Blocked by**, where **Add a blocker** picks a card to
wait for and **×** stops waiting; **Done** puts them away.
Once the card is built, its **Review** comes right under the facts. Further
down are the card's **Activity** (its story, step by step), its brief folded
as **What you asked** with its first line (**Show** opens it, **Hide** puts it
away) and, at the bottom, one **Details**: the card's **Files**, its **History of runs**
(planning conversations, and an agent's runs) and **Technical** (its branch,
its copy, ports, rounds and models).

**A card not built yet.** Now says **Ready to start** and offers **Start
build**. **Start build ▾** has **Build with both** (Claude and Codex each
build it, and you pick one), and **Plan it first ▾** beside it has **Plan it
with Claude** (or Codex) and **Plan with two AIs**.
Right under Now comes the card's brief, and a new card opens on it:
- **What you want**, with **Files (2)** (or **Add files**) beside it for the
  files sent with the card. Drop a file anywhere on the card to add it
  (**Drop to add to this card** shows while you hold it there); **Details**
  opens on its **Files** so you see it arrive. A screenshot dragged straight
  from its thumbnail may not be saved yet: let it finish, then drag the
  saved file;
- one sentence that says who builds it, how it works and who reviews it
  ("Claude builds it in a copy of your project, with its own permission
  setting; Codex reviews it."; with two or more areas, also where it goes:
  "It goes to Site."), with **Change…**, the card's one way to its choices,
  which opens them right under it. A card that waits for others says so
  under it ("Blocked by “Pricing: copy”."). A card not built yet has no facts
  line: the sentence says it all; the facts line (Builder, Permissions,
  Checks, Reviewer, Area, with its own **Change…**) comes with the first
  build;
- **Asked later**, once you have asked for more after a first result;
- **The plan (what the Builder follows)**, once a planning conversation wrote
  it (**Edit** changes it);
- **More detail (optional)**, for links, constraints or what was tried (on
  a done card, only when something was written there).

**A card being built.** Now says what the Builder is doing (**Working**,
**Asks you something**, **Your turn**) and offers **Open the Builder**, which
shows the card's Claude or Codex session on the page; it keeps that name while
the session is shown, and the session's own **Hide** puts it away. When the
Builder is done, Now's press is **Finish and check**. The brief folds into
**What you asked**, after the Activity. After a check, the card's **Review** holds
what decides whether to ship it, in order: the checks, the Reviewer's
verdict and other cards that change the same files; then **See the changes**
(the files it changes, line by line; press it again to hide them), **Try it**
and **Not right — tell the Builder what's wrong**; then the same **Ship it ▾**
as Now. While the Reviewer asks for changes, Now has **See the changes** and
**Try it** itself. The Review opens by itself when a new verdict comes in;
once you hide it, it stays hidden until the next one. The Review and the
Builder's session can be open together, so you read the findings while you
talk to the Builder: on a wide window the Review moves under Now and the
session stays beside it (**Go to the Review**, after Now, takes you there by
keyboard); on a narrower one the Review comes first and the session below it.
Each **Hide** closes only its own. **See the changes** takes the session's
place. With **Build with both**, each build has its own **Open this Builder**.

**Ready to ship.** Now offers **Ship it ▾** and one quiet **Read the review**,
which opens the Review. If another card changes the same files, a line under
Now says which one, and that you ship one, then **Bring in main's changes** on
the other.

**A shipped card.** A card is done only once it is in main: its pull
request merged, or shipped on this Mac. Now says **Shipped** and offers **View the shipped
result**, which opens its pull request on GitHub, or the card's **What
shipped** when it shipped without one; **Follow up** sits beside it. The
Review's place is now **What shipped**, the card's one receipt: what shipped,
its checks, the Reviewer's word, its pull request and Ship history. Its
**What you want** can be read but not changed, and nothing can block it any
more: for more changes, **Follow up** shows the card it suggests (a title from
this one, and what should change now) and makes it, linked to this card, when
you press **Make the card**. An archived card's **View history** goes to its
Activity.

**Making a card.** A new card starts from the Board's **New card** (**⌘⇧N**,
**Ctrl+Shift+N** on Windows, from anywhere): type its title and press
**Enter** to add it, or **⌘↵** (**Ctrl+Enter**) to add it and open it. The new
card is marked for a moment where it lands. If it can't be made, your text
stays in the field. On an empty Board, New card marks the **What do you want
to build?** field and says what to do next; **Make the card** beside it, the
one filled button while the Board is empty, makes the card, and nothing
starts until you press **Start build**.

**The card's ⋯.** What isn't the card's next step is in the **⋯** beside its
title, under four headings: **Build** (challenge its plan once it's built,
if it has one, build it with both AIs on the tour's first card — elsewhere that is under
**Start build ▾**, and planning under **Plan it first ▾** — move it back to
Ready to start), **Ship** (release it, undo a merge Plyloft started),
**Session** (stop planning, close the Builder's session, open a terminal in
the card's copy) and **Card** (follow up, archive), with **Delete card…**
last, on its own. Each heading shows only when the card has something under
it, and nothing in the ⋯ repeats a press the **Now** box already shows. A
card built by an agent lists its runs under **Details › History of runs**,
with **Record this card's runs** to stop or start recording them and **Clear
history…**.

**When something goes wrong on a card.** One thing at a time: what went
wrong is the **Now** box itself, with its one way on (or **Dismiss**) and
its **Details**. If more than one thing needs a look, a line under Now says
so (*2 more things on this card need a look.*) and its **Show** opens them at
the top of the card's **Details**; when the first is dealt with, the next
one comes up in Now.
- **Ship stopped on a conflict** with your main branch: Now says in how many
  files, and **Fix with the Builder** starts the merge in the card's copy for
  the Builder to resolve; the files are under Now's **Details**.
- **Checks failed**: press **Fix with the Builder**. Plyloft sends the
  failing checks and the end of what they printed to the card's Builder
  session; when it's done, Plyloft checks the fix by itself (or, with
  **After a fix round** set to **Waits for me**, press **Finish and check**).
- **The review couldn't finish**: **Review again** runs the Reviewer once
  more. On a project on GitHub, **Open the pull request anyway (I merge it)**
  opens a pull request for it as it is and leaves the merge to you; on one
  that ships on your computer, **Ship anyway** ships it as it is. Either
  way the receipt says it wasn't reviewed. The other way is in Review
  again's menu: **Only on this Mac** (**this PC**) on a project on GitHub,
  **Open the pull request anyway (I merge it)** on one that ships on your
  computer.
- **A press didn't go through**: the card says why, with **Try again**.
- **Your project folder has changes that aren't in a commit**, so Ship
  stopped: **Show the files** opens them in Code. With Claude building the
  card, **Ask the Builder to commit them** asks it to commit only those
  files, as they are, on the branch your project folder is on; it asks you
  before running commands (unless you've allowed them), and it leaves new
  files you haven't added yet alone.
  With Codex, or a card built without asking, commit or undo them yourself.
  Then press **Ship it** again. When the card isn't open, a toast says
  *Your project folder has changes that aren't saved*; its **Show them**
  lists the changes, and **Ask Claude to save them** saves them for you.
- **An earlier change on this Mac isn't on GitHub yet** (another card
  shipped only on this Mac, and this card started from it or took it in):
  **Ship it** stops before pushing anything, names the card the change came
  from when it knows it, and lists the changes under **Show them**.
  **Not now** pushes nothing; **Ship both** opens the pull request with them
  in it. Such a card says so under
  its facts: "Started from main on this Mac, which has 1 change not on
  GitHub yet."

**After a card ships.** Its **See the changes** and **See the checks** show
what shipped: the files the card changed when it landed, the checks that ran
and the Reviewer's word. A card that shipped together with others in one
release says so instead of listing the release's files. A card shipped as a pull request that was merged on
GitHub shows its files once your project has pulled the merge.

**The guided first card.** Plyloft can create a small, safe
card — *Describe this project in the README* — with what you want already
written, and opens it. A box titled **Guide**, under the card's Now box (before the build, under its brief),
tells you what to press at each step; it never presses anything for you.
Press **End the guide** whenever you like; the card stays a normal card.
The tour's **No idea yet? Use a safe example** makes the same card; while the
tour runs on it, the tour does the explaining and the **Guide** box stays
hidden. It
needs your AI and a project first; until then the button says what is
missing. If you skipped step 8, Plyloft reads how your project builds and
says what it will use ("Plyloft will build “lyra” from main, with no checks
yet. **Change**"); the button saves that and makes the card. If it can't
read it, it says so, with **Set it up**.

On the guided card, Claude changes files in the card's own copy of your
project without stopping to ask; anything else (most commands, a file
outside that copy, Git's own folder) still asks you, and nothing reaches your
main branch until you ship it. Codex changes files in the card's own copy
without asking; anything outside that copy (another folder, the internet)
still asks you, and nothing reaches your main branch until you ship it. Its
**Permissions** shows **Edits its copy without asking**. If your
own Claude or Codex settings allow more (extra folders, commands you allowed
always), those still apply. Claude still asks once for each project whether
you trust its folder: answer it in the session. Rewrite the card's
task, or start any other card, and the card's **Permissions** decide (see
*How the Builder asks you*); choose **Asks before every change** (with
Codex) if you'd rather it asked on this card too, or **Uses Claude's own
setting** (with Claude) if you'd rather it followed Claude's own setting. You can also start it later from **Settings › Setup and account ›
Setup › Guided first card**; while the guide is running, that button reads
**Open the guided first card**.

### How Ship it ships

**The pull request's title and description** (from 1.175) are written by the
card's Builder while the Reviewer reviews its last build, when its session is
open and can write a file without asking. The card's **Review** says where
they are: *Claude wrote the pull request's title and description* with **Read
it** (it shows them; **Save** keeps your changes in the card's copy, and
nothing goes to GitHub until you press **Ship it**), *still writing*, *the
work changed after the pull request's text was written* (a fix round since:
**Ship it** asks for it again, up to 90 seconds), or *Plyloft writes the pull
request's title and description itself* when the Builder couldn't. **Ship it**
then uses them at once, or waits only what is left of the 90 seconds.

On a project whose repository is on GitHub, **Ship it** puts the card on
GitHub: Plyloft pushes the card's branch, opens a pull request and asks
GitHub to merge it when its checks pass. Before you press it, a card Ready
to ship says so in its **Now**: "Ship it puts it on GitHub as a pull request
and merges it with main once GitHub's checks pass." (kept on this Mac: "Ship
it adds it to main on this Mac; GitHub doesn't get it."). Once it is pressed,
a notice says where it went ("On GitHub: pull request #12 · it merges by
itself once GitHub's checks pass. You can keep working."), with **Open on
GitHub**. Where Plyloft merges it itself (below) the notice says "Plyloft
merges it once GitHub's checks pass, while it's open on this Mac", and where
GitHub refused to merge it by itself, "you merge it when it's ready, here or
on GitHub". Under the card's **Now** a line
says where the change is, for example *On this Mac → On GitHub, pull request
#12 · checks 2 of 5 · GitHub merges it when they pass → Next: Shipped · on
GitHub* (the checks counted as GitHub's pull request page lists them). While the checks run the card is in Working with **On GitHub ·
waiting for checks** or **On GitHub · merges when checks pass**; it never
says Shipped before the merge. A failed check or a review GitHub needs moves
it to Needs you. When GitHub merges it, the card goes to Done as **Shipped ·
on GitHub**, with "It's in main on GitHub. If your site deploys from main,
it's on its way live." Plyloft doesn't deploy anything itself: a site that
deploys when main changes on GitHub takes it from there. A card shipped only
on this Mac says **Shipped · only on this Mac**, with "main on this Mac has
it; GitHub doesn't." A card in a release that goes through a pull request has
the same line for the release: *On this Mac → On GitHub, release pull request
#7 · GitHub merges it when its checks pass → Next: Released v1.2.0* (or
"Plyloft merges it when its checks pass, while it's open on this Mac"), then
*Tagging v1.2.0* once it merged, until the card says Shipped.

**A project that is only on your computer.** A card Ready to ship on a
project with no copy anywhere says "This project is only on this Mac, so Ship
it merges the card here. Put it on GitHub to ship cards as pull requests."
with **Put it on GitHub…** (or **Connect GitHub first**); Settings › Cards ›
Shipping › How Ship it ships has the same press. Nothing happens until you
press **Put it on GitHub** in the sheet that opens: it names your GitHub
account, the repository's name (you can change it), that it is private, and
what is sent — the branch cards go to, with its commits; changes not saved in
Git stay on this Mac. Plyloft creates the private repository in your own
account (never an organisation's) and sends that branch, never overwriting
anything; while it sends, **Stop** ends it. A file over 100 MB stops it
before anything is created, because GitHub refuses such files; a name you
already use creates nothing. If sending stops or fails, the repository stays
on GitHub, empty, and **Send it again** tries again. When it's done, a notice
says "“lyra” is on GitHub" with **Open on GitHub**, and from then on Ship it
opens a pull request for each card. Cards you shipped on this Mac before went
to GitHub with that branch, so their history no longer says they aren't on
GitHub. A project whose copy is somewhere other than GitHub isn't offered
this.

Where the repository asks for no checks, GitHub would merge at once, so
Plyloft merges it itself once its checks passed (or, with none, after a
short wait): the card says **Plyloft merges it while it's open on this
Mac**. That merge happens only while Plyloft is open. If its moment came
while Plyloft was closed, the card waits in On hold (**On GitHub · merges
when Plyloft is open**) until Plyloft's next look at GitHub, soon after it
opens. Quitting never waits for it: when Plyloft asks before quitting (files
not saved, a session at work) or Windows asks how to close, the question also
says "1 pull request waits for Plyloft to merge it. It merges when Plyloft is
open again." It counts every project's cards, and a release pull request
Plyloft merges itself. If the GitHub command's sign-in expired, the card says
**Plyloft can't read GitHub: sign in again**, with **Sign in to GitHub**; once
you have signed in, Plyloft reads the pull request again as soon as you close
Settings.

While its pull request is open the card isn't done yet. Its **What you
want** can still change, and the line under it says so ("Pull request #12
is still open, so this card can still change."); a change reaches the pull
request with **Fix with the Builder** (in the card's ⋯, which sends **What
you want** as it reads now to the Builder; in Now when GitHub asks for a
fix), then **Send the fixes to GitHub**. When GitHub asked for the fix,
Plyloft checks it by itself once the Builder is done; **Send the fixes to
GitHub** is always your press. The first time checks fail on a pull request in a
project, the card offers **Turn on** under **Fix with the Builder**: it switches
on **Fix failing checks by itself** for this card and as the project's default
(Settings › Cards › Shipping; each card has its own switch under **Change…**),
with **Undo**; **Not now** keeps it off and the offer doesn't come back. A card that waits for it can't
start until then ("Starts when “…” merges.").
**Follow up** comes once it merged, and a card that waits for it says
**Waits for “…” to merge** until then. When it merges by itself, Now offers
**Don't merge by itself**, which turns that off: the pull request stays open
until you press **Merge**. A pull request closed on GitHub without merging
leaves the card in Needs you, its brief editable, with **Ship it again**
(it opens a new pull request) or Archive.

Merge when checks pass is available on every plan. You can start another card
while this one is still building or waiting for GitHub.

Before anything is pushed, Plyloft checks that the GitHub command (the
GitHub CLI) is installed and signed in with the account the project uses.
If it isn't, Ship it stops with **Install the GitHub command** or **Sign in
to GitHub**. It never lands the card on this Mac instead.

A card that ships without the Reviewer's approval never merges by itself:
**Open the pull request anyway (I merge it)**, a ship over the Reviewer's
requested changes, and **Ship now, fix these in a new card** open the pull
request and leave the merge to you, whatever **Ship it ▾** says. **Ship now, fix
these in a new card** is beside the Reviewer's findings, from its fourth
request for changes with nothing serious open: it ships the card and puts
the open findings in one new card, linked from the pull request. So does a skill card whose copy here changed
since it was made (it ships as a pull request so you can read why first).
When the press wanted it to merge by itself, the card says Merge when checks
pass waits, and Plyloft turns it on once the last commit is reviewed (the
Reviewer approves it, or you accept its findings). **Send the fixes to
GitHub** with a fix nobody reviewed turns Merge when checks pass off on
GitHub, and the card says so, until that fix is reviewed too.

The card's Builder session follows its pull request: Plyloft asks nothing
after the ship, and the session stays open while the pull request is open, so
a failed check, a review or a change to the pull request can go to it. When
the pull request is merged and the card is Done, Plyloft closes the session
and says so by the card's name ("“Add dark mode” is merged, so its Builder
session was closed.") with **Undo**, which keeps it open. After **Only on this
Mac** the session closes at once, with the same **Undo**.

If the pull request on GitHub gets commits Plyloft didn't push (GitHub's
**Update branch**, a bot, someone else), nothing merges it by itself and it
isn't shown as ready: the card says **Someone else changed it on GitHub: the
pull request has commits Plyloft didn't push.** Look at them with **Open on
GitHub**; to merge them anyway, press **Merge what's on GitHub now**. A card
whose pull request can be merged says **Ready to merge**, with its
**Merge** right there.

If the project's GitHub address isn't a repository Plyloft can read, Ship it
stops before pushing anything, with **Only on this Mac** as the other
way.

If GitHub doesn't allow merging by itself in the repository (the
repository's setting is off, or your account can't turn it on), the pull
request stays open and the card says so: press **Merge** when it's ready.

If GitHub refuses the push — a protected branch, the repository's rules, or
a branch on GitHub with commits the card doesn't have — the card says which,
with **Open on GitHub** (the repository's rules, or the branch) beside
**Dismiss**. Plyloft never forces a push. If the card's work reached GitHub
but its pull request didn't open (the connection dropped, say), the card
says so, with **Open the pull request**: it ships the same work again and
opens it.

**Ship it ▾** is the same three choices on every project, the one Ship it
makes now ticked:
- **On GitHub, merge when checks pass** opens the pull request and merges it
  once GitHub's checks pass (what Ship it does on a project on GitHub).
- **On GitHub, pull request only (I merge it)** opens the pull request and
  leaves the merge to you.
- **Only on this Mac** (**Only on this PC** on Windows) merges the card into
  your main branch on this Mac (*main on this Mac*), as Ship it did before.
  It's in main on this Mac only; GitHub (*main on GitHub*) doesn't have it,
  and a later card that ships to GitHub may stop to ask about it.

While the last round has no approved review, the two pull request choices
are one, **Open the pull request anyway (I merge it)**: nothing unreviewed
merges by itself. A project that can't take a pull request has only Ship
it, which merges on this Mac.

The first time you press **Ship it** on a project after this change,
Plyloft says once what changed (a project you add after the update doesn't
ask). To keep Ship it on this
Mac for a project, choose **Only on this Mac** in **Settings › Cards ›
Shipping › How Ship it ships** (kept on this Mac). A project with no GitHub
repository ships on this Mac as before.

### Following the pull request

**Merge** merges the way the repository allows on GitHub, shown beside it:
**Squash and merge**, **Create a merge commit** or **Add the commits one by
one**. Plyloft reads it from GitHub and asks for that one; if GitHub refuses
it, Plyloft reads it again and tries the next way the repository allows.

**Edit title and description** opens the pull request's title and
description as they are on GitHub; **Save on GitHub** saves them. Nothing is
changed on GitHub until you press it.

**What Plyloft takes out before posting.** The Builder writes the pull
request's title and description, and the Reviewer's notes go into a comment
on it at every Ship. Before either is posted, Plyloft replaces anything shaped
like a secret (a GitHub token, an API key, a private key, a `PASSWORD=…`
value) with `[removed by Plyloft]`, and shortens paths: your home folder
becomes `~`, and a file in the card's copy is named from the project
(`src/app.js`). When something was taken out, a line under the text says so
("Plyloft: 1 thing that looked like a secret was removed from … before
posting."). It is a light filter, not a guarantee: read what you publish.

**Bring in main's changes.** When main on GitHub has changes a card doesn't
have yet, the card says **Behind main** (or **Conflict ahead** when they
would conflict); hover it to read why. Being behind is usually nothing to
do, so the chip stays quiet; it stands out only when they conflict or
GitHub needs them in before it merges the pull request. **Bring in main's changes** merges them into the card's
copy; nothing is committed or pushed until you press **Finish and check**,
and on a card with an open pull request **Send the fixes to GitHub** then
sends it.
Nothing is ever rewritten, and nothing happens by itself. If they conflict,
nothing is merged and the card offers **Fix with the Builder**;
**Leave main's changes out** drops it.

**Fix failing checks by itself.** With this on (on the card, under **Change…** while its pull request is open, or
as the project's default in **Settings › Cards › Shipping**, off
unless you turn it on), when checks fail on GitHub the
card's open Builder session gets the failed logs, then Plyloft runs
**Finish and check** and, once the checks pass and the Reviewer approved
the fix, sends it with **Send the fixes to GitHub** — up to 3 tries per pull
request. It
works only while the Builder's session is open and waiting at its prompt,
never answers the Builder's questions, never merges, and leaves reviews and
conflicts to you. When it stops, the Inbox says why
(**Couldn't fix the checks by itself**, or **Stopped fixing checks after 3
tries**).
If the card's Builder may stop to ask (**Asks before every change** with
Codex, **Uses Claude's own setting** with Claude), an automatic fix waits for
your OK in its session whenever it asks; the card says
so and offers **Use Edits its copy without asking for this card**. That is
saved on the card for the Builder's next fresh start: the open session keeps
asking, and nothing changes by itself. With Claude, commands like `npm test`
may still ask.

**Checks a teammate changed.** In a project whose setup is shared, **Checks
before shipping** and **After a release, run** come from the repository. When
someone else changes them, they don't run on this Mac until you allow them:
the toast says "Runs on this Mac once you allow it: …", and the next **Finish
and check** saves the Builder's work and stops before the first step. The card
says **The checks need your OK** — who changed them and when, what this Mac
allowed and what the repository has now, the step that changed marked — with
one button, **Allow and run**. A step that starts a Claude session says so
("It starts a Claude session in this card's copy with nobody watching.").
**Fix failing checks by itself** waits for that OK too, without using a try,
and says so on the card, in the Inbox and on the Board. A new copy of the
project asks the first time ("This repository's checks haven't run on this
Mac before."). A change you make on this Mac, in Settings or with a page's
**Publish**, is allowed by making it, and the other computers ask their own
person. Updating to 1.175 asks nothing: what already ran counts as allowed.
Your OK is for those steps: what a script itself does is the repository's
code, and it can change without Plyloft asking again.

**After the merge.** Plyloft deletes the card's branch on GitHub (only the
card's own, only while it is still what merged; when another open pull
request uses it, it stays and the Done card says so) and brings this Mac's
main up to date with GitHub's when it can do so safely. When it can't — you
have changes that aren't in a commit, say — the Done card and the Inbox offer
**Bring this Mac up to date** (**this PC** on Windows).

### Releasing a version

Ship cards with Ship it as usual. When you want a version, **Board ⋯ ›
Release…** (while two or more cards are ready, the Board's header has
**Release N cards…** instead) takes everything on main since the area's last
release — cards and other changes — and any card that's ready but not on main
yet. The menu says what is new ("4 cards and 2 other changes on
main since site-v3.0.1"); with nothing new it is off and says so ("Nothing
new on main since site-v3.0.1, released yesterday."). **Release N cards…** at the
bottom of the sidebar, a card's **⋯ › Release…**, **⌘K Release Site…** (**Ctrl+K**
on Windows) and **How this goes live** open the same sheet.

The Release sheet says what's in it (the cards that reached main with Ship
it, then the other changes, folded), lists the cards ready but not on main yet
under **Also ready, not on main yet**, ticked, and asks the version (the next
patch first; minor and major a click away; **Another version…** to type one)
and how far it goes:

- **On this Mac only** — makes the new version on this Mac, from this Mac's
  main, and runs the install step if the project has one. Nothing goes to
  GitHub. If this Mac's main is behind GitHub's, Plyloft brings it up to date
  first; if both moved on, the choice is off and says why.
- **Put the version on GitHub** — a release pull request on GitHub, merged
  when its checks pass, then tagged.
- **Put the version on GitHub, with a release page** — the same, then a
  release page on GitHub with what's in it.

It starts from the area's default (**Settings › Cards › Shipping**). One line
says what will happen, and **Technical details** has the release branch, the
tag, where it is made from and **Release without checks**. An area's first release
can take the version its version file says now.

In a repository with areas, a release is of one area: only that area's
version files change, and its tags are its own — the first area keeps
`v1.2.3`, another is tagged like `site-v3.0.2`. On **All areas**, or from
⌘K, the sheet asks which area when two have something to release, and says
why one can't (for example, that it has no version file of its own, with
**Open Areas**). An area after the first needs a version file of its own:
until it has one, **Settings › Project › Areas** warns "Site has no version file of its own,
so a release would change the whole repository's version", and the release
says "Site has no version file of its own. Add one in Settings › Project ›
Areas." and releases nothing.

Once you press **Release site-v3.0.2**, the sheet follows it, one step at a
time: made on this Mac from main on GitHub, your checks, the release pull
request, GitHub's checks, the tag. **Close** lets it go on: the sidebar says
"Releasing site-v3.0.2 · checks running" with **Show it**, and a card in it
points to the same sheet. **Stop the release** takes it back while it is made
on this Mac (nothing reaches GitHub); once its pull request is on GitHub it
asks first, then turns its merging by itself off and leaves the pull request
open. If main on GitHub moved on, **Update the release** brings main's new
changes in, checks it again and sends it. When it is done the sheet says
"site-v3.0.2 is released", the cards it carried say "In site-v3.0.2", and the
Inbox's News has one row for the release. A release that can't go on by
itself (its pull request was closed without merging, say) goes to Needs you,
and its sheet says why, with **Dismiss**.

### How a change goes live

Ship opens a pull request; what happens after it merges is your host's
work, not Plyloft's. Where Plyloft can read it, it tells you beforehand. It
reads two things, and only reads them: **Railway**, when Railway is installed
on this Mac and the project's folder is linked to a Railway project
(`railway link`), and the repository's **GitHub checks** (the files in
`.github/workflows`). It never changes anything on Railway or GitHub.

On a card's Review, **When it merges** sits above Ship it:

- **www.example.com updates** — the addresses that change first, with the
  Railway service under them ("Railway service site-production · built from
  site/").
- **app.example.com restarts too** — a service that rebuilds although the
  card didn't touch its files, with the reason in plain words.
- **GitHub runs 3 checks first** — the checks that run on the pull request,
  by name, and the file they come from.

It says when it read Railway ("read from Railway 3 min ago") on a line under
its title, and ends with **How this goes live…**, which opens the whole
picture (below); Plyloft keeps a reading for ten minutes. It never stops a Ship: with nothing to read, the
section isn't there.

**Board ⋯ › How this goes live** shows the whole picture: for each area (or
for the project) where its cards go, what changes online then, what builds
from another branch (**Earlier, on staging**), the GitHub checks that run
first, and its **Releases**: the last tag and what is new on its branch
since ("site-v3.0.1, 12 days ago · 4 cards and 2 other changes since"), or a
release on its way ("site-v3.0.2 on its way · waiting for GitHub's checks",
with **Show it**) (a project's plain vX.Y.Z tags count, those from before
1.173 too). **Read again** asks
Railway now. With Railway read, **Right now** says whether each service is up
("www.example.com · Live", "The app service (on staging) · Last deploy
failed", "Deploying…") and when it was read; a reading taken while a deploy
was under way is read again when the page opens. In a project with Railway's
`railway.json` or `railway.toml` but without the `railway` program on this
Mac, the page says Plyloft can't read Railway here.
Each block's Releases row has **Release Site…** (**Release App…**, or
**Release…** without areas) only when there is something to release; it opens
the Release sheet on that area. With nothing new the row says so, with no
button; an area that can't be released says why.
When Plyloft sees nothing to read it says so in one line: "Plyloft doesn't
see where this project goes online. That's fine: Ship still opens the pull
request, and your host takes it from there." The line at the bottom says
what Railway answered: signed in with the project's name, signed out (run
`railway login` in a terminal, then **Read again**), or "the link Plyloft
sees is on a folder above this project, so it's another project's" when
the only Railway link Plyloft finds is on a folder above the repository. **Settings › Setup and account › Diagnostics** has the same
Railway row.

#### Make a service rebuild only for its own changes

Railway rebuilds a service on every change to its branch unless the service
has **watch paths**. So in a repository with a site and an app, a change to
the site restarts the app too, and the other way round. A service's root
directory doesn't stop that: it only says which folder the service is built
from.

To limit it, open the service on Railway, then **Settings › Build › Watch
Paths**, and list the folders whose changes should rebuild it, from the
repository's top: `/site/**` for the site, or `/app/**` and
`/requirements.txt` for an app. A line starting with `!` leaves files out
(`!/site/docs/**`). Plyloft reads the new watch paths on its next reading,
or straight away with **Read again**, and **When it merges** stops saying
"restarts too" for that service.

### Settings › Cards › Shipping

**Settings › Cards › Shipping** holds a card's whole path after the build,
in the order it happens: where cards go, how Ship it ships, what runs after
a release, the card branches, the releases, and how the change goes live.
Until 1.174 some of these rows were in Build and release and in Board and
cards' copies; a link that names one of them by its old name opens it here
and says so ("“Integration branch” is “Cards go to” now, here in Shipping.").
Each section says where it's kept: **on this Mac** (your own choices), or
**shared with the project** (**on this Mac until you share the project**
in a project that shares nothing).

**Where cards go** — **Cards go to**: the branch every card's change goes
to, and new cards start from (it was **Integration branch**). With two or
more areas each area has its own ("Each area has its own: App → staging ·
Site → main.") and **Change in Areas** opens them. If that branch is renamed
or deleted on GitHub, the Board says so and no card starts from it: renamed,
"staging is called develop on GitHub now" with **Move to develop**, one small
commit that moves the shared setup and the cards there; deleted, "staging
isn't on GitHub any more" with **Choose where cards go**, which opens this
row.

**Ship it** — on this Mac:

- **How Ship it ships**: as a pull request on GitHub, or **Only on this
  Mac** (see How Ship it ships). On GitHub, Ship it merges the pull request
  once GitHub's checks pass and the Reviewer approved; to merge it yourself,
  choose **On GitHub, pull request only (I merge it)** in **Ship ▾**. Where
  GitHub can't merge by itself, or the base branch requires no checks,
  Plyloft merges only while it's open. (Until 1.174 this was a line of its
  own, **Merge when checks pass**.)
- **Fix failing checks by itself**: the project's default for new cards'
  pull requests (see Fix failing checks by itself); each card can turn it on
  or off. On a project not on GitHub it is off, with "For projects on GitHub."
- On a project only on this Mac, How Ship it ships says so and has **Put it
  on GitHub…** (see How Ship it ships).

**After shipping** — **After a release, run** (it was **Install script**):
the command that builds and installs the new version. It runs after a
release, or after Ship it on this Mac — not when Ship it opens a pull
request. Choose **Nothing** and nothing runs. When someone else changed it
in the shared setup, the release still finishes but the install step waits:
the toast says so with **Review**, the Inbox keeps "v1.4.0's install step
needs your OK" with **Decide**, and the sheet *Run the install step on this
Mac?* offers **Not now** or **Allow and run** (see Checks a teammate
changed).

**Card branches** — on this Mac:

- **Delete card branches when their trash expires**: 7 days after a card's
  copy goes to the trash, its branch on this Mac goes too — never one with
  commits made after it shipped, and never one checked out. Archived cards'
  branches are asked about in the Inbox first.
- **Kept after shipping**, when the cleanup kept some: "2 branches with
  commits made after they shipped." **Show 2** lists them, each card's
  branch name behind ⋯. On GitHub, Plyloft deletes only a card's own branch,
  once its pull request merged; to have GitHub delete other merged branches
  too, turn on "Automatically delete head branches" in the repository's
  settings (**Open the repository's settings**).

**Releases** — where the Release sheet starts: **On this Mac only**, **Put
the version on GitHub** or **Put the version on GitHub, with a release
page**. With areas, each area has its own row ("Where Release… starts for
each area; each release can still choose."), with its latest tag and where
its cards go ("site-v3.0.1, 12 days ago · cards go to main"); without areas,
one **Default release** row (also with one area, which is the whole
repository's). Each release can still choose another. **Release without
checks** is never put on GitHub with a release page, and a default that
pushes drops to On this Mac only; a **Put the version on GitHub** you pick
yourself stays, and pushes the `-unverified` tag. In a
repository that shares its settings the default is shared and goes out with
**Publish to** your integration branch; in one that shares nothing it's
kept on this Mac and saved as you change it. The first choice, **Same as
Ship it**, is where nothing chosen starts, and it names the kind it gives
now: **Same as Ship it (Put the version on GitHub)** where Ship it goes to
GitHub, **Same as Ship it (On this Mac only)** where it ships only on this
Mac or the project can't take a pull request. Picking a kind saves it, even
the one Same as Ship it gives now. **Version files** — the files whose version is bumped
together on every release — opens its own list here, with its own **Read
the repository again** for the version files and what runs after a
release; with areas, an area can list its own in Areas.

**How this goes live** — one line with the addresses Plyloft read from
Railway ("www.example.com and app.example.com · read from Railway 3 min
ago"), and **Open** for the whole picture (see How a change goes live).

### Finding your way around

The sidebar has two parts. At the top, for the whole app: **Search**,
**Inbox**, **History** and **All skills**. Below, for the project you're in:
**Board**, **Code**, **Terminals** and **Library**. **Settings** is at the
bottom (**⌘,** on a Mac, **Ctrl+,** on Windows).

| Part | What it's for |
|---|---|
| **Board** | Your cards, from the idea to shipped. Start here when you want something built. |
| **Inbox** | What is waiting for you: cards that need you, scripts waiting for your OK, and things that were refused. |
| **Code** | Your project's files, to read or change one yourself. **⌘P** / **Ctrl+P** opens Go to file (**Ctrl+Shift+P** from a terminal). |
| **Terminals** | Sessions with Claude, Codex or a plain shell. Your cards' sessions are listed here too. |
| **Library** | Skills (instructions the AI follows for a kind of task) and Instructions for your agents. |
| **All skills** | Every skill in every project, in one place. |
| **History** | The cards you've shipped, and your Terminals sessions. |

**A card or a terminal?** Use a **card** when you want something built and
checked: the Builder works in its own copy, the Reviewer reviews it, and
nothing reaches your project until you ship it. Use a **session in
Terminals** when you just want to talk to Claude or Codex, ask a question or
try a command; it works directly in your project's folder.

**What needs you.** The number beside **Inbox** counts what is waiting for
you: a card ready to ship or needing a fix, a session that asks you
something (a decision, a permission, trusting a folder), and a Claude or
Codex session that finished its turn while you were elsewhere. It is the
same number as **Needs you** in the Inbox. For its cards it is also the
Board's: a project's **Needs you** column counts the same cards, and with an
area picked it adds "· 2 in other areas" for the rest. What has no card (a
pull request someone asked you to review, a refused team plugin, a run that
failed) is counted in the Inbox only, until you have seen it. In **Needs you** each card reads as its Board
card does, with its state and its one press (*Checks failed* → **See what
failed**, *Session closed* → **Resume**); a card whose run or checks failed
is there too, first. A row stays until what it asks is done; looking at it
doesn't take it away, except a session's finished turn, which leaves the
list once you have looked at it. A session that only waits for its usage limit to reset stays in gray and
isn't counted; a session nobody has typed into isn't listed. Below come
**Working**, **On hold** (a card in line for a free slot, or one whose
Builder was working when Plyloft closed: *Paused when Plyloft closed*, with
**Resume**; two or more paused are one row that opens the Board) and
**News** (a pull request merged, a run finished or stopped, a round of
Next improvement ideas), which isn't counted: **Clear the news** takes it
away and leaves what needs you; the ideas row stays, grayed, until you
answer its ideas. Every row's press is outlined, as on the Board: the
order says where to start, and a row's other answers are in its **⋯**.
**Merge** merges right there and says *Merging…* until GitHub answers (on
the Board, a card's **→ Merge** opens the card). With nothing there, the Inbox says
*Nothing needs you* and offers **Go to the Board**. Clicking one of
Plyloft's notifications opens the card or session it is about; back in
Plyloft a while later, a message offers **Open** instead.

**Notes above the Board.** When Plyloft has something to tell you about the
project — something that doesn't work, a shared setup to decide on, a
project folder behind GitHub, two products found in the repository — it
shows one note at a time above the columns, the most urgent first. The
others wait in one line under it, such as "2 more notes: your project folder
is behind GitHub · two products in this repository"; **Show** opens them all
and **Show fewer** puts them back. When you answer a note, the next one takes
its place. Next improvement comes last.

**The Board's columns.** Each card sits where its work is, and moves on by
itself: **Needs you** (it asks you to act: a result to read, a fix, a
question, ready to ship, or a pull request ready to merge on GitHub — its
**Merge** is on the card and in the Inbox), **Not started** (a draft or a
card ready to start — a new card begins here), **Working** (Claude, Codex
or your checks are on it, or its pull request's checks on GitHub run and
it merges when they pass), **On hold** (nothing is asked of you: it waits
for a free slot, a card it depends on, a teammate, a pull request waiting
for a review on GitHub, one Plyloft merges once it is open again, or a
Builder that was working when Plyloft closed — **Resume** carries it on) and
**Done** (**Shipped · on GitHub**, or **Shipped · only on this Mac**).
A card in Needs you also says its one press under its state, the same
words as the button on its page (**→ Finish and check**, **→ Ship it**);
clicking the card opens it there, and nothing runs from the Board. An
empty column stays narrow, so the others keep their room.
The same words mean the same thing everywhere: a state is never just
*Waiting* — it says what for (your answer, a review on GitHub, GitHub's
checks) — and **Open the Builder** (on a card and its Inbox row; on each of
two builds, **Open this Builder**) opens a card's Claude or Codex session that
is still running, as **Open session** does for a session in Terminals or
History (**Resume** brings back one that ended).

**Messages.** A short message at the bottom of the window says what just
happened: what happened on its first line, a sentence or two under it,
and the presses for the next thing as buttons. Its small icon, in its
color, says whether it is a warning or an error. When your project folder
is older than GitHub's branch your cards use — it is on another branch, or
has changes that aren't saved in Git — Plyloft says what it is once
("Your project folder is from 16 Sep", the branch it's on and how many
newer updates GitHub has), and the Board asks: **Bring it up to date**
moves only the folder's own branch forward, never switching it, and with
changes in the way opens them (each file, its changes, **Open**, **Ask
Claude to save them**, which opens Claude in the folder and asks it to
save them, and **Sync again**); **I don't work here** stops the ask for that project, and Code and
terminals opened in the folder keep a quiet "This is the version from …"
line. Settings › Project › Cards' copies keeps the state, with **Tell me
again**. Your cards always start from GitHub, so they aren't affected.
An ordinary message doesn't cover a warning or an error: the next one
waits (**1 more message** shows it, and puts this one behind it) until
you close it or its time is up — or, for one that stays until you close it,
about 12 seconds, after which it comes back right after the waiting one.
An **Undo** never waits: it shows at once, and whatever it covers comes
back after it. A message that stays until you close it is never lost to a
newer one. Their time stands still while Plyloft's window is hidden. The
Inbox's **⋯ › Recent messages** keeps the last ten, with their
**Details**, in case one went by.

**Sessions in Terminals.** A Claude or Codex session takes its
conversation's name: the first words you typed, then the AI's own title.
Rename it with the pencil and your name wins; Plyloft also types
`/rename <your name>` into Claude or Codex as soon as its input line is
empty, so `claude --resume` shows it too, and the name goes with the session
into a fresh conversation after `/clear` and through Continue (a conversation
you pick up with `/resume` that has a name of its own keeps that name). The
undo button beside the pencil, **Use the automatic name**, gives the session
its conversation's name back: its default name at once, then the
conversation's title. Claude itself keeps showing the last name in its own
prompt border. Its header says what it is doing in a card's words:
**Working · 4m 12s** while it works, **Your turn** when it is done, **Asks
you something** when it waits for an answer. A session that waits on you
says so on its tile,
its row in the sidebar ("Claude · asks you something", "asks to trust the
folder", "paused · your plan's limit resets at …") and in the Inbox, with an
amber dot (and
an amber border on its tile). A session that stopped unexpectedly (Claude or
Codex ending abnormally, or a process stopped from outside) has a red dot; a
shell whose last command failed keeps an amber one; one with no output for a
while has a hollow amber ring.
**New › Resume…** picks up an earlier Claude or Codex conversation of the
project in a new session, and **History › Sessions** lists the sessions of
the last 28 days with **Resume**. Both say when a conversation was last used;
History marks one that resumed an earlier conversation "resumed". Resume…
ends with a link to History › Sessions for every project. One that is already open in a session is
shown instead; one that looks open somewhere else on this Mac says so, with
**Open it anyway** in case it isn't.

**Dropping a file on a session.** Drag a file from Finder (File Explorer on
Windows) or from Code's file list onto a Claude, Codex or shell session: while
it is over the session, the session says what the drop will do (*Drop to give
Claude this file*, or *Drop to type this file's path* in a shell), and after
you let go a line at its bottom says *Adding* and the file's name until the
file's path is typed into it. Codex chat is a chat view with fewer
features: it takes no drops (attach a file to a card's chat or its Files
instead), isn't counted in Same folder warnings, Throw away doesn't wait for
it, and the Inbox doesn't reopen it. For all of that, use a Codex session.
From another Mac (Universal
Control), drag the saved file, one at a time: a screenshot's thumbnail, or
several files at once, don't arrive.

**Sessions by keyboard.** A session you open (**⌘T** / **Ctrl+T**, **⌘⇧T**
for Claude, **⌘⇧X** for Codex, or Search) opens on Terminals with the
keyboard in it, wherever you were; so does one you reach from its sidebar
row, the Inbox or Resume…. **⌘T** opens what **Settings › Editor and
terminals › What a new tile opens** chooses: a shell, Claude or Codex.
On Terminals, **⌘⇧]** and **⌘⇧[** move to the next and previous session
(**⌘⇧Page Down** and **⌘⇧Page Up** too, on a keyboard where brackets need
another key),
**⌘⇧Enter** expands the one you're in or shows the grid again, and **⌘⇧W**
closes it; **⌘⇧R** opens Resume…. On Windows they are **Ctrl+Shift+]**,
**Ctrl+Shift+[** (or **Ctrl+Shift+PageDown** / **PageUp**), **Ctrl+Shift+M** (expand), **Ctrl+Shift+W** and
**Ctrl+Shift+R**, and work from inside a terminal too. On Windows, Ctrl
and a letter belong to the program in the terminal (PowerShell, Claude,
Codex), so from inside a terminal Plyloft's keys add Shift: **Ctrl+Shift+K**
for Search, **Ctrl+Shift+P** for Go to file, **Ctrl+Shift+,** for Settings,
**Ctrl+Shift+C** and **Ctrl+Shift+V** to copy and paste; a new tile is
**Ctrl+Alt+T**. Outside a terminal **Ctrl+K**, **Ctrl+P** and **Ctrl+T** work
as well. **⌘/** (**Ctrl+/**),
or the key that types / on your keyboard (**⌘⇧7** on an Italian one), lists
every shortcut (**Ctrl+Shift+/** from a terminal). Closing a session that sits at its prompt (a shell
with nothing running, not even in the background; Claude or Codex at Ready
with nothing typed) closes it straight away; one that is working, waiting on
you or running something in the background asks first. **More for
Terminals › Close all** closes every session of the page after one
question, which says how many are working.

**Picking up where you left off.** A Claude or Codex session that ended
says so in plain words on its tile ("Ended", "Ended with Ctrl-C", "Ended ·
error code 1"; the tooltip says what the code means) and offers
**Continue**, which opens the same conversation again in that tile, and
**Start fresh**, which starts a new one under the session's default name (a
name you gave it stays). A shell offers **Restart**. If Claude Code or Codex
stops the moment it starts because the program is damaged, missing or not
allowed to run, the tile says so under its header and offers **Repair** for
that tool (Settings › Setup and account › Diagnostics has the same). A tile
that ended for another reason (you pressed Ctrl-C, a wrong option, a settings
file with a mistake, you aren't signed in) doesn't offer Repair: the tool is
fine. A session still coming
up says **Starting…** until it is ready (at most 20 seconds; then **Your
turn** at its prompt, or how long it has been working). After Plyloft quits and opens again,
Terminals says, in one line, which sessions were open when it quit ("Dark
mode was open when Plyloft quit.", or "3 sessions were open when Plyloft
quit: A, B and 1 more."; the tooltip lists them all) with **Reopen it** (or
**Reopen them**): one press opens each in its own session, picking its
conversation up. **Not now** puts the line away, and so does opening or
starting any session in that project; **History › Sessions** and Resume…
still have them, with **Resume**. Nothing reopens on its own. When you have closed every session, the page says so and points to
Resume….

**Work in a copy without a card.** To try something from a terminal
without touching your project folder or the other sessions, choose **New ›
In a new copy…** on Terminals (or **Start a new one in a copy** from a
session's **Same folder as** chip). Give it a name and pick **Claude**,
**Codex** or **Shell**. The sheet says where the copy starts: your main
branch as GitHub has it, and when this Mac last read it ("main on GitHub ·
read 2 min ago"); a project that isn't on GitHub starts from main on this
Mac, and so does one whose main on this Mac is ahead of GitHub's (the copy
has those steps); when GitHub can't be reached the copy starts from this Mac's main
and says so. **Open the copy** makes it and opens the session in it at once.
The session's header says **Copy ·** and the name, and **Setting up…**
while the project's setup command runs there; a setup that failed says why,
with **Retry** (or **Allow and run**, the first time this Mac runs that
command).

Once a copy exists, Terminals' header has **Copies**, which lists them: for
each one, what changed, what is open in it and where it started. A copy
ends in one of three ways:

- **Make it a card** saves the copy's work and gives the copy to a new
  card in **Not started**, named after the copy's last commit (or after
  the copy when it has none; rename it on the card). Its page says what
  the copy changed, and Activity says which copy it was made from. **What
  you want** starts empty, with the cursor in it: say what the Builder
  should do with the work, and **Start build** waits until you have. It
  then carries on in the copy, with the sessions open in it still running;
  then the Reviewer and your checks look at it. It leaves the Copies list.
  On a board of GitHub issues, claim the card first.
  Deleting that card treats the copy as the card's own copy: when
  everything in it exists elsewhere too, **Delete** moves the copy to the
  trash with the card. When it holds work that exists only on this Mac,
  the sheet offers **Keep the folder** (the card goes, and the copy is
  back in **Copies**) or **Delete everything** (the copy and its branch
  go too).
- **Open a pull request** saves the copy's changes, sends the copy to GitHub
  and opens a pull request for the branch it started from, the same pull
  request Ship opens, but nobody has reviewed it, and the sheet says so
  (with **Make it a card** instead). Once it merges, its branch on GitHub
  is deleted as a card's is.
- **Throw away** moves the copy to the Trash for 7 days, with **Undo** in
  the message. A copy whose saved changes exist nowhere else asks first.
  **Bring it back** in **Copies** restores it whole until the week is up.
  A copy with a session still open in it isn't thrown away: close the
  session first.

**Links in a session.** Web addresses a session prints
(`http://localhost:5173`, a pull request, a sign-in page) and the paths of
your project's files (`src/app.ts:12:5`) are links: **⌘-click** (on Windows
**Ctrl-click**) opens an address in your browser and a file in Code, at its
line. A plain click still selects text. Only files inside the project are
links.

**What to write on a card.** One result you could check in a few minutes,
written the way you'd ask a person: what you want to have when it's done,
how you'll know it works, and anything that must not change. For example:
*Add a contact form to the home page with name, email and message. Sending it
shows "Thanks". Don't change the header.* For a bigger idea, make several
cards, or talk it through first with the card's **Ask about this card** or
with **Plan it first ▾ › Plan with two AIs**.

**What Code shows.** Code shows your project's own files. A card's Builder
works in a separate copy, so its changes appear in Code after you ship the
card. Before that, read them in the card's **Review**, with **See the changes**. **⌘S** (**Ctrl+S**) saves
the file you're in, **⌘⌥S** (**Ctrl+Alt+S**) saves every file of the
project, and **⌘W** (**Ctrl+W**) closes the file — only in Code, and a file
with unsaved changes asks first: **Save and close**, **Don't save** or
**Cancel**. Quitting Plyloft asks too, but only when something would be
lost: files with unsaved changes (**Save all and quit**), or a Claude or
Codex session in the middle of a turn.

**Done and the archive.** A card reaches **Done** when it ships; dragging a
card onto Done doesn't move it ("Done fills when a card ships"). To put a
card away without shipping it, drag it onto **Archived** at the bottom of
the Board, or choose **Archive** in its **⋯** or its right-click menu. Archiving moves the card's
copy to the Trash folder inside your project's card copies, where it stays a
week; its brief, plan and branch stay with the card. **Restore**, on the
card in **Archived**, puts it back: an unshipped card gets its copy back
from the Trash while it is still there, changes not yet committed included,
and otherwise its next **Start build** checks its branch out again. A
shipped card goes back to Done.

**The Board by keyboard.** With a card focused (**Tab** to it), **↑** and
**↓** (or **J** and **K**) go to the card above or below, **←** and **→** to
the column beside, and **Enter** opens it. **⌥↑** and **⌥↓** (**Alt+↑**,
**Alt+↓** on Windows) move it up or down its column, with **Undo**, as
dragging it does. A card changes column as its work moves, so **⌥←** and
**⌥→** say why it stays instead of moving it. **Shift+F10** (or the menu key)
opens the card's menu, the same as a right-click: **Open**, **Move up**,
**Move down**, **Move to** another column (off, with the reason), **Archive**
and **Delete card…**. **⌘K** (**Ctrl+K**) finds a card from anywhere by its
title or its issue number (**#42**). **Review a pull request…** is in the
Board's **⋯** and in **⌘K**.

**Seeing it running.** Once the Builder has made a change, the card has a
**Try it** button, in its **Review** (on a card that isn't ready to ship
yet, in its Now box instead). Press it and
Plyloft starts your app in the card's own copy and shows it on the card:
*Starting your app…*, then *Running on localhost:41003* with the page itself,
and **Reload**, **Open in browser**, **Show the session** and **Stop**. No AI
is used for this. Your own files stay as they are.

- **The first time**, Plyloft asks how to start your app. It suggests the
  command it found in your project (for example `npm run dev`, from
  `package.json`); use it as it is or change it, then press **Save and try**.
  Plyloft remembers it for the repository. A command that comes from the
  repository runs only once you allow it on this computer (**Allow and
  run**). If the card's copy has no packages yet, Plyloft offers to install
  them first. A plain website (an `index.html` and no `package.json`) opens
  in your browser instead.
- **After you ship** a card on this computer, the Ship receipt and the
  *Shipped* message offer **Try it in** followed by your project's name. It
  starts your app in your project's own folder and opens **Code** with the
  preview showing it, and **Stop** and **Show the session** above it. A
  running Try it is also listed in **More for Code**, before **Show your
  running app**. If your project rebuilds itself after a ship, only the receipt
  offers it, and it says to wait for the rebuild. After a pull request is
  merged on GitHub, the receipt offers it once your project has pulled the
  merge. If your project has no packages yet, Plyloft asks before installing
  them there (with `npm ci` when there is a lockfile).

**If Try it can't start your app.** The card says *Couldn't start* and shows
the last lines your app printed under **Details**: tell the Builder on the
card what went wrong (you can paste those lines), or press **Change how it
starts**. **Details** also says which command ran and on which port. You can
always do it by hand: open **⋯** on the card and choose **Open a terminal in
the card's copy**, start the app there the way you usually do, then open
**More for Code › Show your running app**, choose **Web page** and type the
address the app prints. After you ship, start it in a shell in
**Terminals**; the preview finds it on the common ports.

**How the Builder asks you.** Before **Start build**, the sentence under
**What you want** says how the Builder works, and its **Change…** chooses it
(once built, the facts line shows **Permissions** and its **Change…**). Choose one
for this card; **Settings › Cards › AI and models › How the Builder asks you**
sets what a new card starts with. **Resume** keeps the choice the session
started with. While a session is open the choice isn't offered: it never
changes a running session. After the session closes (**Session closed**), or
after **Move back to Ready to start**, **Permissions** is back on the card,
set to the card's current choice: **Start fresh** (or **Start build**) starts
in the one you pick, and the card keeps it.

- **Edits its copy without asking**: Claude changes files in the card's copy
  of your project without asking; commands (npm test, git) may still ask.
  Codex changes files in the card's copy without asking; using the internet
  or files outside the copy still asks.
- **Asks before every change** with Codex, **Uses Claude's own setting** with
  Claude (the default): Codex asks before it changes a file or runs a command
  that changes anything. With Claude, Plyloft adds nothing: Claude follows its
  own permission setting on your computer, and unless you changed it, it asks
  before it changes a file or runs a command.
- **Never asks (risky)**: Claude never stops to ask, and it can change files
  anywhere on your computer, not only in the card's copy. Codex never stops
  to ask either, but it still changes files only in the card's copy: a
  command that needs more fails instead of asking.

**After a fix round.** When the Builder finishes fixes Plyloft sent it — the
Reviewer's findings, your checks that failed, what a pull request needs —
Plyloft runs **Finish and check** by itself, twice in a row at most. **Settings
› Cards › AI and models › After a fix round, check by itself** turns it on or
off for new cards (on by default); **Change…** on a card sets **After a fix
round** to **Checks by itself** or **Waits for me**. The first build and your
own changes always wait for you; it never ships and never answers the
Builder's questions.

In all three, your project itself changes only when you press **Ship it**.
If your own Claude or Codex settings allow more (commands you allowed
always), those still apply. On Windows, Codex keeps to the same limits with
its own Windows protection.

**When Claude or Codex asks you something.** While it builds, the AI may stop
and wait for you: to ask whether you trust the card's folder (once for each
project: a Yes in one card's copy covers the project), to ask before
running a command, or because your plan reached its usage limit. The card
then says so in its Now box, with **Open the Builder**. Answer in the session:
Plyloft never answers for you. After a usage limit, the session says when it
resets; type "continue" there then. Nothing is lost.

### A shared setting changed on two Macs

A repository's shared settings (the rows marked *shared with the project*)
reach everyone who opens it. When you change one on this Mac and, before this Mac saw it,
your other Mac or a teammate changed the same one, Plyloft doesn't replace
their value. It asks: "Your MacBook Pro changed “Version files” 10 min
ago. You changed it here too, before seeing that. Which should the
repository keep?" Only the difference is shown: for a list, what both have,
what only this Mac adds and what only the other one has (for areas, which
areas were added, removed or set differently); for the suggested models,
only the suggestions set differently; for one value, the two values. **Keep
the MacBook Pro's** drops your change and uses theirs (for the suggested
models, only the clashing suggestions: your others stay), and a message says
what was dropped; **Use this Mac's** saves yours, and the commit says whose
value it replaced. If they change it again before you answer, Plyloft shows
the new question instead. Until you choose, the page with that row says
"Waiting for your choice" with **Choose…**. Your
other settings are saved as usual meanwhile. If Plyloft is hidden or you are
in another project, the question waits in the **Inbox** ("A setting both
Macs changed: Version files"); closing it decides nothing. With one Mac and
no team, you never see it.

The same question comes from a Settings page's **Publish**. While you have
a change drafted there and someone else publishes the same row, the row
says it before you press: "Changed here, and example-teammate changed it in the
repository meanwhile: it is main there now. Publish asks which to keep." The
**Review** sheet says it too; **Publish** sends your other changes and asks
about that one.

**A card's title or brief, changed on GitHub.** On a board of GitHub issues,
editing a card writes only what you touched to its issue: a new title alone,
or the brief alone, with the rest of the issue as GitHub has it now. If
someone changed that same part on GitHub after this Mac last read it,
nothing is written and the card asks, above the part: "example-teammate changed
the brief on GitHub 4 min ago", the two versions whole, side by side, with
**Use GitHub's** (the default) and **Keep mine**. Until you choose, the card
keeps your version (**Start build** sends the brief you see), its Board card
says "Changed on GitHub · your edit waits", and the Inbox lists it under
Needs you with **Choose**. **Use GitHub's** writes nothing, and its message
offers **Copy what I wrote**; **Keep mine** writes your part. If GitHub's
version changes again before you choose, nothing is written and the card
shows the new one. A part you didn't touch follows GitHub without a
question.

### A project's shared setup

A project's shared setup is the file `.atelier/workspace.json` on its
integration branch: the rows marked *shared with the project* come from it,
for everyone who opens the repository. **Settings › Project › General ›
Shared setup** says where it is ("This project's setup is shared:
.atelier/workspace.json on main, in owner/repo.") and has **Stop sharing…**.
The sheet (the default is **Keep sharing**) says what happens: Plyloft
removes the file from that branch in one small commit (it stays in the
branch's history); each computer keeps the values it has now, as its own, and
from then on a change made on one doesn't reach the others; the Board and its
cards stay where they are. If the branch doesn't take a direct push, the
removal goes as a pull request, and the setup stays shared until it merges
(the row says "Still shared: stopping waits in pull request #12.", with
**Open pull request**). Pull
requests this Mac opened for shared settings and that are still open are
closed once the file is really gone. Stopping needs write access to the
repository and a connection.

On the other computers the Board says "The shared setup was removed from
main", who removed it and when, with **Keep it on this Mac** (nothing is
written to GitHub) and **Share it again…**; until one is chosen, the shared
Settings pages say their rows are this Mac's own for now. Someone who can
only read the repository is told once and keeps the values. A setup removed
from its branch, by Plyloft or by hand, is never put back by itself: only
**Share it again…** (it asks first) creates the file again.

If the branch the setup lives on is renamed or deleted on GitHub, see
*Cards go to* in Settings › Cards › Shipping. If you can't write to the
repository and have changes waiting, the bar says "Not published — you can't
write to owner/repo" and offers **Use the team's values…**, which drops your
changes from this Mac (it asks first; **Not now** is the default).

### Areas: one repository, several products

Some repositories hold more than one product: an app at the top and a
website in a folder of its own, each going live in its own way. **Areas**
keep them apart. Each area has its folder, the branch its cards go to, its
own versions and releases, and its label on a board of GitHub issues. In a
project whose setup is shared they are saved in the repository, so your
other Mac and your team see the same areas. In one whose setup isn't shared
(yet), they are kept on this Mac until you share it, and they work here just
the same: cards, Ship and releases use them. A repository with one product
never sees any of this.

**When Plyloft sees two products.** If the repository has no areas yet and
Plyloft finds a product at the top and another in a folder next to it (a
folder with its own `package.json`, `pyproject.toml` or similar **and** its
own `Dockerfile` or hosting file), the Board says so once: "This repository
seems to hold two products: the app (the root) and a site (site/)".
**Set up areas…** opens **Settings › Project › Areas** with those
two filled in for you to check and save. **Don't ask again** hides the notice for
good on this Mac; **Settings › Project › Areas** is still there. The notice shows only
in a project opened at the top of its repository whose areas you can change:
a shared setup you can write to, or a project whose setup isn't shared, where
it adds "They're kept on this Mac until you share this project's setup."
("They're kept on this Mac only." when you work alone or the repository isn't
on GitHub). In a repository of several packages (a monorepo), the top
itself isn't a product: its folders are. A folder with only a
`package.json` (a `frontend/` the app builds, a package of a larger project)
is part of the product around it, not a second one.

**The area picker.** With two areas or more, **Area: …** sits under the
project's name in the sidebar. Its menu lists **All areas** and each area
with where its cards go ("cards go to main"). Picking one shows that area's
cards on the Board (its title reads **Board · Site**), and new cards and new
terminals in a copy start in it: a copy starts from the area's branch.
Cards with no area are under **All areas** only. On **All areas**, **New
card** has an **Area** of its own, already chosen: this Mac's default, else
the last one you used here. The Inbox and **Release
N…** name each card's area beside the project. **Make Site this Mac's
default** opens the project on Site every time on this Mac; each Mac keeps
its own default. **Edit areas…** opens **Settings › Project › Areas**.

**On a board of GitHub issues.** Each card's issue carries its area's label
(*area:site* unless the area names another). Choosing or changing a card's
area changes the label; an issue someone labels *area:site* on GitHub
becomes a Site card. An issue with no area label comes in with no area: its
facts line reads **Area · Not chosen yet**, and its **Now** asks **Which
area is this card for?** before anything starts, with the areas (starting
on the one its changed files are in) and **Start in Site**, which chooses
the area and starts the build in one press (**Plan it first ▾** uses the
same choice). When the areas can't be used, Now says so with
**Open Settings › Project › Areas** and nothing starts. The same goes for
a card whose label someone removed on GitHub, or whose label is no area's
(the card says which). Start build pressed on the Board or in the Inbox
asks the same way, with a toast that opens the card. On an area, the line under the Board's title says so: *Cards come
from the GitHub issues of owner/repo labeled area:site*.

**When the areas can't be used.** If someone saves areas that break the
rules (two areas with the same folder, a name Plyloft keeps for itself),
the Board says why, with **Fix them**. If this Mac had good areas before,
it keeps using them. If it never had any, no card can start, ship or release
until the list is fixed, and the picker doesn't show.

**Settings › Project › Areas.** The list of areas, saved in the
repository's shared settings; a Mac without write access to it reads the
page without changing it. In a project whose setup isn't shared, the line
under the title says **Kept on this Mac until you share this project's
setup.** with **Share it…** (or **Kept on this Mac only.** when there is
nowhere to share), the bar says "1 change · stays on this Mac until you
share this project's setup", and **Save** keeps the list on this Mac. Each
area is one row ("site/ · cards go to main · releases tagged site-v1.2.3
(last) · www.lyrappc.com", or "no release tagged yet; its tags will start
with site-v" before its first release) with **Edit…**, which opens its own page: its **Name**,
its **Folder** (empty: the whole project except the other areas' folders),
where its **Cards go to** (a branch of the project; the project's own
branch means it has none of its own), its **Version files**, what its
**Release tags start with** (the first area's are plain v1.2.3, the others'
start with their name), **Where to look at it**, its web address, its
**Board label** (only on a board of GitHub issues), its **Default release**
with **Open Shipping**, where it is set, and **Remove**. **Suggest areas from
this project** adds an area for each product Plyloft finds that has none here
yet, with its folder's own package.json, pyproject.toml or Cargo.toml as its
version files and a package.json homepage as its address (not a GitHub,
GitLab or Bitbucket page); the areas already here stay as they are. Check it
before you publish. **Add an area** opens the new area's page to choose its
folder; **Remove** on an area's page takes it out. A new area never takes the id of one you removed, because
that area's cards keep it; its Name row says so. Plyloft checks the list as you type
and says what's wrong beside the field it's about; a list that breaks a rule
isn't published. **Publish to** your integration branch saves it for
everyone, and the line under the title says who changed it last. Moving an
area never changes how its releases are tagged.

**Sharing areas kept on this Mac.** When you share the project's setup, the
areas kept on this Mac go with it, in the same small commit of
`.atelier/workspace.json` (the Share question says "Also shares the areas
kept on this Mac: App, Site."). If the repository already has areas of its
own (another computer shared first), the Board asks once: **The repository
already has areas**, with both lists. **Use the repository's** (where the
focus is) writes nothing: this Mac follows the repository's areas, and yours
are set aside on this Mac, not deleted. **Publish mine** replaces theirs for
everyone, as a change you can see on GitHub.

### Next improvement

Above the Board, **Next improvement** proposes changes to your project one
round at a time. Your AI (Claude, or Codex if that's the one you have) reads
the code and, when the direction says where to look at it, the pages of your
site or app, and proposes only what it can show is worth doing — often one
idea, sometimes none — each with what it saw. A second opinion (the other
AI, or the same one in a separate pass when you have one) sets aside the
ideas that only add without a reason. Zero ideas is a good answer: the
section then reads *Next improvement · nothing this time* and says *That's a
good answer: nothing in Site is worth a card right now*, with **Prepare
proposals again** beside it. Once you've answered every idea of a round it
reads *answered*, with what became of them (*1 made a card, 1 not to propose
again*).

**Another round.** **Prepare new proposals** in the section's head (and
**Prepare proposals again** after a round with nothing) opens a small
*Next round* box: the approach for this round, ticked as your direction has
it, and who proposes (**Change…** swaps the two AIs). **Prepare proposals**
starts it. That choice is for this round only: the direction stays as it is,
nothing is saved or shared, so a project whose setup is shared gets no
commit for it. Afterwards the line under the title says the approach it
used (*Polish, this round*). Ideas you haven't answered yet stay: while the
round runs they wait below it, and you can still make them a card or say
not to propose them; then they stay in the new slate, marked *From the last
round*, after the round's own ideas, until you answer them. To change the
approach for every round, change the direction.

**When it shows.** Next improvement opens above the Board by itself once
you've shipped a card on this Mac, in every project, or once you've finished
or skipped the tour's first chapter. Before that, **Next improvement…** in
the Board's **⋯** opens it for that project.

**The first time** it is one line that says what it does and what it costs:
a round takes a few minutes and uses your own Claude or Codex plan, like a
card does. **Prepare proposals** starts a round; with no direction yet it
opens the direction first. **Direction…** opens the direction. **Hide**
hides the section and says where it went: **Show it** on that message, or
**Show Next improvement** in the Board's **⋯**, brings it back.

**The direction** (**Direction…** in the section) is four short answers and
two choices. The first time, Plyloft reads your README to help: *For whom*
starts empty, with the README's first sentence under it and **Use it**, and
*What you don't want* starts from a short default; change anything.

- **For whom**: who uses it, in a few words.
- **What "better" means here**: what they can do, or do faster, when it's
  better. Plyloft never guesses this one; it is how Next improvement tells a
  better idea from a busier one.
- **What you don't want**: it starts as "Pop-ups, countdowns, fake
  scarcity. Claims we can't prove."
- **Where to look at it**: your site's address (https://…). Plyloft
  fills one in from Settings › Project › Areas, Railway or package.json, and says where
  it came from; an address only your README gives (never an API's, such as
  `api.…` or `…/v1`) is offered with **Use it** instead, and so is any
  suggestion once a direction is saved. Left empty, the AI reads only the
  code and the web, and says so.
- **Approach**, one or more: *Polish* finishes what's there, *Simplify*
  takes things away (each idea must remove more than it adds), *Grow* adds
  one new thing tied to "better", *Fix* goes after what's broken or untrue.
  With none ticked, it polishes.
- **Proposes · second opinion**: *Claude · Codex* or *Codex · Claude*. With
  only one AI ready on this Mac it reads, for example, *Claude · then Claude
  again, in a separate session*; if the direction asks for the other one, it says which one
  proposes here meanwhile. Codex reads the code only; Claude also reads the
  pages at *Where to look at it*.

**Not to propose again (5)** opens the ideas you said not to propose, each
with its reason and **Remove**. **Save** keeps the direction; **Save and
prepare proposals** keeps it and starts a round; while a round is being
prepared there is only **Save**, and the next round follows the new
direction. Saving keeps what changed meanwhile on another Mac in the answers
you didn't touch. Once the project's setup is shared, the direction is kept
in the repository for each area, so your other Mac and your team propose in
the same direction. Beside **Save** the sheet says where it goes before you
press: *Saved in this project's shared setup: a small commit to main on
GitHub* (with the cards' branch), or *a small commit as a pull request to
main on GitHub* when GitHub says that branch takes changes through a pull
request, which Plyloft reads before your first save. If this Mac is
offline, Plyloft says so after saving. On a Mac that can't
publish to the repository the sheet shows the direction and why, without
Save.

Before the setup is shared (or when you work on your own), the direction
and the ideas you said not to propose are kept on this Mac only, in
Plyloft's own data: nothing goes into the repository and nothing is
committed. Beside **Save** the sheet says *Kept on this Mac until you share
this project's setup* with **Share it…**, which says what sharing does and
offers **Share the setup** (the same share as the notice above the Board);
where sharing isn't possible it says *Kept on this Mac only*. When the setup is shared, the direction this Mac kept goes into the
repository with the first publish; if the repository already has one for
that area, Plyloft keeps the repository's and says so once. A Mac that can't
publish to the repository yet keeps using the direction it kept until it
can, and says so.

**A direction written before the areas.** When you save (or publish) two
or more areas for the first time and you had already written a direction
for the whole project, Plyloft asks *Use the project's direction for App
and Site?*. **Use it for both** gives each area its own copy, the ideas
not to propose again included, which you can then change on its own.
**Start fresh** writes nothing: each area's Next improvement then says
*You wrote a direction before this project had areas.* with **Use it for
Site** and **Check the direction first…**, which opens it in the
direction sheet to change before you save it for that area.

**While a round runs** the section says what it is doing now ("Done · read
the code…", "Now · a second opinion on 5 ideas") and **Stop** ends it. The
Board stays usable. Nothing starts by itself: a round begins only when you
press **Prepare proposals**.

**The ideas.** Each idea is one row: its title, its size and risk, **Make it
a card** and **Details**. **Details** opens under the row what it saw, what
it removes, the change, why it is better, how to check it, its sources and
where in the code; it also says the AI read the page's text and the code (it
takes no screenshots). The list has a height of its own and scrolls inside,
so the Board stays in view under it. For each idea:

- **Make it a card** makes a card in **Not started**, with the brief and what
  the idea saw in its notes, in the area the idea is for.
- **Change it…** (under **Details**) asks how it should change; only that idea is rewritten,
  and it gets a second opinion again. The other ideas stay.
- **Don't propose this…** (under **Details**) asks why, in one line. It's kept with the
  direction (on this Mac, or in the repository once the setup is shared),
  and later rounds won't propose it or anything like it.

**Set aside by the second opinion (2)** under the ideas lists what the
second opinion set aside, with its reason. Plyloft's own check sets aside
too (an idea that says nothing it saw or how to check it, one like an idea
you said not to propose, or one that is already a card); then the list reads
**Set aside (3)** and each row says by whom. Each round reads the cards
already planned for the area (its open cards, and the cards made of earlier
ideas) and says so while it works, so it doesn't propose them again; an idea
like one of them is set aside as *already a card*, with the card's title,
which opens the card. When a direction field was
changed on two Macs, the section says **Waiting for your choice** with
**Choose…**, the same question as *A shared setting changed on two Macs*.
After a card made here ships, the section offers **Prepare new
proposals** (or **Not now**), with its pull request's number; it never
starts one by itself. The section's head says where and when (*Site · 12 min ago*);
which approaches the round took, what it read and who proposed are under each
idea's **Details**, in *How it looked*. A new round opens once; after you
leave the Board it opens folded to one line, and the arrow at the start of
its head opens it again. Folded or open is remembered for that round, in
each area, on this Mac. The **Inbox**
shows "Next improvement for Site: 3 ideas" with **Look at the ideas** under
News, never counted: *New ·* who proposed until you have seen it, then
grayed, *Seen · waiting for your answer*. Making one a card leaves the row
for the others, and it goes once every idea is a card or set aside; a new
round with ideas is a new row. In a repository with areas the
section is about the area you are on; on *All areas* it asks which one.

### The Getting started tour

Plyloft can show you each part of the app while you build your first card,
in your own project. It points at the real buttons and waits for you; it never
presses anything for you. Stop whenever you like and pick it up later.

**Starting it.** If you chose *I'm new to this* in setup, **Start the tour**
is the main button on setup's last screen once nothing required is missing
(**Resume the tour** when you started it before). Otherwise open **Help**
at the bottom of the sidebar and choose **Getting started**.

**Take a 1-minute tour**, in Help (and on setup's last screen if you chose
*I use them regularly*), is a quick look at each part without doing anything:
the Board, a card's page, Terminals, Code, the Library, the Inbox, All skills,
Release a version and Help, one after the other. Press **Next** to move on
(**Done** on the last), or **Close** to stop; when it ends you are back where
you started.

The tour is also in **Settings › Setup and account › Setup › Getting started**:
**Start the tour** (**Resume the tour** once you started it) and **Start
over**, **Take a 1-minute tour** and the **Tips when I open a section**
switch.

**Your first card, step by step.**

<!-- tour:base.how-it-works -->
1. **How Plyloft works.** You describe a result as a card. The Builder makes
   it in its own copy of your project; the Reviewer checks it; you ship it.
<!-- tour:base.open-board -->
2. **Open the Board**, where your cards live.
<!-- tour:base.new-card -->
3. **Write your idea as a card**: a short title for what you want to have
   when it's done. No idea yet? Choose **Use a safe example**, a small card
   that describes your project in its README.
<!-- tour:base.brief -->
4. **Say what you want** under **What you want**, right under the card's Now
   (see *What to write on a card* above).
<!-- tour:base.start-build -->
5. **Start the build.** This starts Claude (or Codex) with your own
   subscription. The tour's own card, on your idea, starts the way the safe
   example does: one sentence above **Start build** says so. On the tour's card,
   as on any card that has not been built, two more sentences under the
   builder's line say that it uses your own plans (Claude, ChatGPT, or both
   when the Builder and the Reviewer differ), that your project does not
   change until you ship, and that you can delete the card, and its copy once
   it has one, from its **⋯** menu. Claude changes
   files in the card's own copy without stopping to ask, and anything else
   still asks you; Codex changes files there without asking too, and
   anything outside the copy still asks. Leave how it works as it is: the
   line under **What you want** says "changing files there without asking".
   Later
   cards start with your choice in **Settings › Cards › AI and models**
   (**Asks before every change** with Codex, **Uses Claude's own setting**
   with Claude, unless you change it), and each card can
   change it before **Start build**.
<!-- tour:base.ai-asks -->
   *When Claude asks you something* (not one of the ten steps): if the
   card's session stops to ask (**Asks you something**: whether you trust
   the folder, a question before it goes on), or pauses at your plan's
   limit (**Paused · your plan's limit resets at 15:00**), the tour points at
   **Open the Builder** on the card. Answer there; Plyloft never answers for you.
<!-- tour:base.watch-terminals -->
6. **Watch it work (optional).** While it builds, the tour shows you
   **Terminals**, where the card's session is.
<!-- tour:base.what-code-is -->
7. **What Code is for**: your project's files. The card's changes show there
   after you ship.
<!-- tour:base.finish-check -->
8. **When it's finished, check it.** Press **Finish and check**: Claude
   re-reads its own work, then Plyloft saves it, runs your checks and the
   Reviewer reviews it. The card says what is happening and for how long
   (**Claude is re-reading its work · 1m 20s**); you can leave it, and Plyloft tells you
   when it's done.
<!-- tour:base.try-it -->
9. **See it running.** Press **Try it** in the card's **Review**: Plyloft
   starts your app in the card's copy and shows it on the card. The first time, it asks how your app
   starts and suggests a command; press **Save and try**. If it can't start
   your app, see *If Try it can't start your app*.
<!-- tour:base.ship -->
10. **Ship it.** On a project on GitHub a pull request opens and merges when
    the checks pass; otherwise the change goes into your project on this
    Mac. Above Ship it, **When it merges** says what changes online, when
    Plyloft can read where your project is hosted (see *How a change goes
    live*). After a ship on this Mac, **Try it in** followed by your
    project's name shows it running in your project, in Code's preview.
<!-- tour:base.permissions -->
    *How should Claude work on your next cards?* After the first ship the
    tour asks once. On the first card the Builder changed files in the
    card's copy without asking; new cards start with the default in
    Settings › Cards › AI and models › **How the Builder asks you**
    (with Claude, *Uses Claude's own setting*; with Codex, *Asks before
    every change*). **Use this** makes new cards start with *Edits its copy
    without asking*; **Keep this** leaves the default as it is. Closing the
    panel without answering keeps it too, and the question doesn't come
    back. Any card can change it before Start build.
<!-- tour:base.second-card -->
    *One more card, on your own:* after the first ship the tour offers a
    second card without pointers. Its list ticks itself as the card moves,
    and **Hint** gives a one-line hint when you want one.

**More, when you're ready.** Short chapters you can take in any order, listed
under your first card in the tour's panel. Choose one to see its steps; each
says how long it is (*3 steps*) and how far you got (*1 of 3*). **Skip
chapter** (in the panel's **⋯**) skips the rest of the one you're in. They
follow the project you're in, not your first card's.

*Inbox and History*
<!-- tour:inbox.open -->
- **Open the Inbox**: everything waiting for you. **Needs you** shows each card
  as the Board does, with its state and its one press; scripts waiting for
  your OK and things that were refused are there too. **News** sits below and **Clear the
  news** clears it on its own.
<!-- tour:inbox.every-project -->
- **One Inbox for every project**: each row names its project, and the number
  beside **Inbox** counts what needs you, the same number as **Needs you**
  here and, for its cards, on the Board. A pull request a teammate asked you
  to review says when it was opened and offers **Have it
  reviewed** (the Board's **Review a pull request** with it picked), or
  **Open the review card** once there is one; **Open on GitHub** and **Copy
  link** sit beside it.
<!-- tour:inbox.history -->
- **Open History**: what ran, shipped and was checked in every workspace over
  the last 28 days, in tabs: **Runs** (with the Builder's rounds), **Ships**,
  **Checks**, **Sessions** and **Discussions**, with a **Workspace** and a
  text filter. A card shows once per tab, and the numbers count what's
  listed. History doesn't show what a run cost: your Claude or ChatGPT plan
  pays for it. **Sessions** lists the Claude and Codex sessions you opened in
  Terminals, with **Resume** to pick one up again. **⌘⇧H** / **Ctrl+Shift+H**
  searches all of it, and the sessions by their title. A card you delete
  keeps its runs and checks here, marked **· card deleted**.

*Talk before you build*
<!-- tour:talk.chat -->
- **Talk about a card**: a card's **Ask about this card** talks about it with
  the card's Builder AI (or the one you chose in Setup) and takes a
  screenshot, a PDF or a Word file. It changes nothing, and the Builder
  doesn't see it: to change the work, press **Send to the Builder**, which
  sends what you wrote there to the Builder's session. With the field empty
  it puts your last message back in the field: read it, then press it again.
<!-- tour:talk.plan-two-ais -->
- **Plan with two AIs**: on a card not built yet, under **Plan it first ▾**
  beside Start build, one AI writes a plan and the other questions it. With one AI, both views come from it, in two
  separate sessions. It uses your own subscription.
<!-- tour:talk.which -->
- **Ask, plan or build?** Ask about this card to ask; **Plan it first ▾ ›
  Plan it with Claude** (or Codex) to work out the card; Plan with two AIs,
  in the same menu, for a big idea; **Start build** when you know what you
  want.
<!-- tour:talk.next-improvement -->
- **Next improvement**: above the Board, Plyloft asks your AI for the
  changes worth making to the project, often one, sometimes none, each with
  what it saw, and a second opinion sets aside the ones that only add. Each idea is one row with
  **Make it a card**; **Change it…** and **Don't propose this…** are under its
  **Details**. Nothing changes until a card is built and shipped. See *Next
  improvement* above.

*Terminals in depth*
<!-- tour:terminals.new -->
- **Open a session**: **New** opens Claude, Codex, a shell or Codex chat in
  your project's folder. The AI ones use your own subscription. **New ›
  Resume…** picks up an earlier Claude or Codex conversation of the project
  in a new session.
<!-- tour:terminals.layouts -->
- **Arrange your sessions**: **More for Terminals** (the **⋯** beside
  **New**) **› Layout** (Auto, Single tile, Split (1×2), Quad (2×2), Six
  (2×3)), or **New › Several sessions at once…** to open a set of them together.
- **Two AIs in one folder**: once a file changes in a folder where two AI
  sessions are open (files git ignores don't count), each says **Same folder as** the other. They can
  change the same files without seeing each other's edits. **Start a new
  one in a copy** opens the next session in its own copy; then close one of
  the two, and the warning goes. **Show** brings the other session forward.
  Shells don't count, and Codex chat terminals aren't counted. A copy needs
  a git project: in a folder without git, the chip only warns and offers
  **Show**.
- **Compare Claude and Codex**: with a Claude Code session and a Codex
  session open, **Compare** in Terminals' header adds one line under them.
  It says which of the two answered last, and **Pass to Codex →** (or **Pass
  to Claude →**; **⌘⇧Y**, **Ctrl+Shift+Y** on Windows) opens it: choose what
  to ask the other one (**Review this plan**, **Carry it out**, **Check this
  work**, **Answer this review** or **Just pass it**), add a note of your
  own if you want, then **Send** it, or **Put it in its box** and press
  Enter there yourself. **Include my question** adds what you asked in that
  turn before the answer; it is left out when the turn holds only text you
  passed, or when Plyloft can't tell which words are yours. A plan Claude wrote in plan mode can be passed while
  Claude still waits for your answer; to send something to Claude while it
  waits there, press Esc in its session first. Nothing goes by itself: every
  pass is your press. While the other session is working, asks you something or
  holds text you typed, the line says why it waits; Plyloft never answers a
  question for you. With more than one Claude or Codex session open, you
  choose which two. After a pass, the other session's answer to it is what
  the line offers back, even if either session answered something else in
  the meantime; **Swap** passes the other way instead. The number of passes
  on the right opens their list, to
  read one again or pass it again. Nothing of this is kept: the answers and
  the list are gone when you quit Plyloft. Codex chat sessions and shells
  aren't compared. After `/new` in a Codex session Plyloft can't tell which
  conversation it is in, and offers no answer of it back: close it and open
  a new Codex session to compare. You can compare two pairs at once: one in
  the project folder and one in a copy. Open the second with **New ›
  Compare in a new copy…**. Each pair has its own bar, named after its
  copy, and **⌘⇧Y** (**Ctrl+Shift+Y** on Windows) passes in the pair you're
  working in.
<!-- tour:terminals.new-copy -->
- **Work in a copy**: **New › In a new copy…** opens a session in its own
  copy of the project, started from your main branch on GitHub, so it
  doesn't touch your project folder or the other sessions. **Terminals ›
  Copies** lists them: **Make it a card** to have it checked and shipped,
  **Open a pull request**, or **Throw away**. See *Work in a copy without a
  card* below.
<!-- tour:terminals.command-blocks -->
- **Command blocks (optional)**: output one command at a time, an
  experimental setting in **Settings › Look and feel › Editor and
  terminals › Command blocks**.

*Code and the preview*
<!-- tour:code.files -->
- **Go to file**: press **⌘P** (**Ctrl+P** on Windows), or **Go to
  file…** in **More for Code**, and type part of its name.
- **Work with your files**: right-click a file or folder in Code's file
  list for **New file**, **New folder**, **Rename** (**F2**), **Move to
  Trash** with **Undo**, **Copy path** and **Reveal in Finder** (the Recycle
  Bin and File Explorer on Windows). Files whose names start with a dot,
  such as `.env`, show with **More for Code › Show hidden files**, also in
  **Settings › Look and feel › Editor and terminals**.
- **Drop a file on the editor**: one from your project opens as itself;
  one from anywhere else opens read-only, with **Copy into the project**.
<!-- tour:code.preview -->
- **See your app in Code**: **More for Code › Show your running app**; a
  running Try it is listed first.
<!-- tour:code.try-project -->
- **Try it in your project**: after a ship, **Try it in** followed by your
  project's name starts your app in the project's own folder and shows it in
  Code's preview. A plain website has nothing to start: open its
  `index.html` in your browser.

*Library: skills and instructions*
<!-- tour:library.skills -->
- **Skills**: know-how the AI follows for a kind of task, from this
  repository, this computer, Plyloft, and your team's library in a team.
  Your **My library** skills are listed too, under **In My library**, to
  read only: a row opens the skill in All skills, and **Manage in All
  skills** is where you add, change or remove them. Without a My library,
  the section says how to make one, with **Set it up in All skills**.
<!-- tour:library.install -->
- **Install, Update, Link**: each goes through a card you ship; Link
  connects a copy made before, so it can be kept up to date.
<!-- tour:library.instructions -->
- **Instructions**: what every session in the project reads first.

*All skills*
<!-- tour:all-skills.open -->
- **Open All skills**: every skill on this computer, and where each one is
  used.
<!-- tour:all-skills.copy-to -->
- **Add to other projects…** puts a copy of a skill into each project you
  pick, as a card, and the copy remembers where it came from.
<!-- tour:all-skills.plyloft -->
- **Plyloft's own skills**, under **Comes with Plyloft**: open one, then
  **Open in the Library**. Its page there shows its version, **Where it's
  on** (switch it off for a project or this computer) and **Personalize…**.
<!-- tour:all-skills.my-library -->
- **My library**: your own skills in a private GitHub repository, on
  every computer where you choose **Use it on this Mac** (**this PC**).

*Release a version*
<!-- tour:ship-batch.row -->
- **Release a version**: when two or more cards are ready, choose **Release
  N cards…** in the sidebar or Board header. Otherwise, choose **Release…**
  from the Board menu. The release includes changes on the area's target
  branch since its last release, plus the ready cards you select.
<!-- tour:ship-batch.what -->
- **What a release takes**: everything on main since the area's last
  release — cards shipped with Ship it and other changes — and the ready
  cards you tick, as one version with its own tag.

*Your team* (only when you work with a team)
<!-- tour:team.library -->
- **Your team's skill library**: every Claude and Codex session Plyloft
  starts gets its skills, and it is kept up to date on its own.
<!-- tour:team.workspaces -->
- **Team workspaces**: the projects your team shares, in **Settings › Team ›
  Members and library**. A row you don't have yet has **Clone and add**; one
  whose folder is already on this computer has **Register**; one already in
  Plyloft says **Open here**. The owner's **⋯** on a row has **Remove from
  the team workspaces…**: it leaves the team's list, while members' clones
  and their access on GitHub stay. A Board backed by GitHub issues says so
  under its title — *Cards come from the GitHub issues of owner/repo · read 2
  min ago* — and reads them again every few minutes while it is on screen;
  **Get new issues** reads them at once: a new issue becomes a card, and an
  edited or closed issue updates its card. Nothing is written to GitHub;
  **Sync with GitHub** in **⋯** also sends this computer's changes.
<!-- tour:team.invite -->
- **Invite someone**: the team's owner uses **Members › Add somebody**. Each
  member needs a seat; seats bought with **Add seats** show when you come
  back to Plyloft. After a new team workspace, **Give everyone access** checks
  every member at once and sends what each needs in one go.

*Settings and search*
<!-- tour:settings.search -->
- **Search everything**: **Search** (**⌘K**, **Ctrl+K** on Windows) finds
  commands, files, text in your files and past sessions.
<!-- tour:settings.open -->
- **Settings, and where Setup lives**: Settings is grouped by what you want to
  do; Setup is under **Setup and account**.
<!-- tour:settings.second-ai -->
- **Add a second AI** (only while one of Claude and Codex is set up): with
  both, one builds and the other reviews. The tour opens Setup's AI step.
  After your first card it also offers this once.
<!-- tour:settings.area-picker -->
- **Areas: one repository, several products** (only in a repository with
  two areas or more): **Area**, under the project's name, picks the product
  you work on; the Board, new cards and new copies follow it. See *Areas:
  one repository, several products* above.

**Stopping and coming back.** Pause it, and Getting started waits in the
sidebar. Quitting Plyloft pauses it too. **Skip this
step** moves on; skipped steps stay in the list with **Do it now**. **End the
tour** removes it; Help › Getting started brings it back, and **Start over**
starts from the beginning.

**New in this version.** **Help › New in this version** sums up what the
version you have brings, in a few points, with a link to the full changelog
on plyloft.com; if you skipped some versions, theirs are listed below. After
an update a dot appears on **Help** until you open it.

**Tips when you open a section.** The first time you open Terminals, Code,
the Library, the Inbox, History or All skills, Plyloft shows one tip about
it; **Got it** puts it away for good. Each tip shows once, and never while
the tour is under way. Turn them on or off in **Help › Tips when I open a
section** (on if you chose *I'm new to this*, off if you chose *I use them
regularly*).

**This guide online.** **Help › User guide** opens this guide on
plyloft.com/docs.

**Your progress stays on this computer.** Settings › Setup and account › Diagnostics ›
**Copy tutorial report** copies a short summary (which steps you did or
skipped, no project names or text) if you want to send it to us.

**When you're stuck.** **Help › Get help** asks what happened and shows the
short report it adds (app version, this computer, your AI's status and where
the tour is; no project names, code or text) under **What the report says**.
**Email support** opens a new email to support@plyloft.com in your mail app,
with the report in it, for you to send; **Copy the report** copies it for
anywhere else. Plyloft sends nothing by itself.

### Words you'll see

| Word | What it means in Plyloft |
|---|---|
| **Card** | One task, from the idea to shipped. It lives on the Board. |
| **Now** | The box under a card's title: what is happening on the card and the one thing to press. |
| **What you want** | What you write on a card: the result you want, how you'll know it works, and what must not change. |
| **Builder** | The AI that does the card's work. |
| **Reviewer** | A second AI that reviews the change; it can't edit. |
| **Second opinion** | In Next improvement only: a second pass, by the other AI or by the same one in a separate session, that sets aside ideas that only add. It isn't the Reviewer, which reads a card's work. |
| **Next improvement** | Above the Board: on your press, your AI proposes the changes it can show are worth doing, often one, sometimes none. Nothing changes until a card is built and shipped. |
| **Suggested skill change** | After a card met friction, the Reviewer can suggest one change to a skill or an instructions file. It waits in the Library until you approve it or dismiss it. |
| **The card's copy** | A separate copy of your project where the Builder works, so your own files stay as they are until you ship. |
| **Copy** | A separate folder of your project that Plyloft makes, for a card or from Terminals, so your own folder stays as it is. |
| **Checks** | Your project's own tests or build commands. Plyloft runs them when you press **Finish and check**. |
| **Review** and **findings** | What the Reviewer says about the work: fine to ship, or the changes it asks for (its findings). A card's **Review** shows it with the checks and the changes; once the card shipped, that place is **What shipped**. |
| **Try it** | Starts your app from the card's copy (or, after a ship, from your project) so you can see the change running. It uses no AI. |
| **Preview** | Your app running on this computer (*localhost*), shown on the card or in Code. |
| **Ship** | Put the card's change into your project. |
| **Shipping** | The Settings page for how a card's change leaves this computer and how a release goes out. |
| **Release** | A new version of the project, from everything that reached the branch its cards go to since the last release, plus the ready cards you tick. Ship puts one card's change there. |
| **Release N cards…** | Open the Release sheet with the ready cards of one project (or one area) ticked: one version with everything on main and those cards |
| **How this goes live** | Where a project's cards go and which addresses update when they merge, read from Railway and GitHub's checks. |
| **Area** | One product inside a repository that holds several (a site and an app). Each has its own cards, branch and releases. |
| **Main** | Your project's main line of work, where a card's change goes when you ship it. |
| **Branch** | A separate line of work in Git. Each card's copy has its own. |
| **Commit** | A saved step in your project's history. Plyloft makes them for you. |
| **Pull request** | On GitHub, a request to add a change, where it can be read before it's merged. |
| **Bring in main's changes** | Merge what main on GitHub has into a card's copy, on your press; the card says **Behind main** when there is something to bring in. |
| **Fix failing checks by itself** | When checks fail on a card's pull request, its Builder fixes them and Plyloft pushes the fix, up to 3 tries. Off unless you turn it on. |
| **Round** | One saved pass of the Builder's work: each **Finish and check** makes one, and the Reviewer reviews it. |
| **Effort** | How hard Claude or Codex thinks on a step. Each model lists the efforts it takes. |
| **Retry on…** | Runs a finished or failed Builder or Reviewer round once more on another model. The card keeps its own model. |
| **Session** | A conversation with Claude, Codex or a shell, shown in Terminals. A card's Builder and Reviewer each have one. |
| **Ask about this card** | A card's conversation with Claude or Codex about it. It changes nothing, and the Builder doesn't see it: **Send to the Builder** sends what you wrote there to the Builder's session (with the field empty, it first puts your last message back in the field). |
| **Plan with two AIs** | One AI writes a plan for a card and the other questions it, before anything is built. |
| **Usage limit** | How much your Claude or ChatGPT plan lets you use in a while. When it's reached, the session says when it resets. |
| **Trust the folder** | Claude and Codex ask once per folder whether you trust it before they work there: once for your project, and once for every new copy. Answer it in the session. |
| **Inbox** | Everything waiting for you, across your projects. |
| **Needs you**, **Not started**, **Working**, **On hold**, **Done** | The Board's columns: it asks you to act; nobody started it yet; an AI or your checks are on it; nothing is asked of you for now; its change is in, or it was closed. |
| **History** | What ran, shipped and was checked, and the sessions you opened, across your projects. |
| **Skill** | Instructions the AI follows for one kind of task. |
| **Library** | A project's skills and its **Instructions** (what every session in the project reads first). |
| **All skills** | Every skill on this computer, and where each one is used. |
| **My library** | Your own skills in a private GitHub repository, on every computer you choose. |
| **Getting started tour** | Plyloft's guide to the app, in your own project: steps grouped in chapters, in **Help › Getting started**. |
| **Plyloft account** | Your GitHub sign-in to Plyloft, used only to start or join a team. You don't need it to work alone. It is separate from the GitHub connection Plyloft uses for pull requests. |
| **Free, Team** | Plyloft's plans. Everything for one person is free: cards build in parallel, and every individual feature is on. Team is paid per member and adds the shared GitHub Issues board with claims and the team library. Team features run on one computer at a time; **Use Team on this computer** moves them. |

---

## 5. Solo or team

**Solo** (what Setup sets up when it finds no team for you): no team pages, no sharing
prompts, boards are local to your computer. Everything else works. If a
project's shared setup puts its board on GitHub Issues, the Board and
**Settings › Project › General** say so — *This repository's board is on GitHub Issues;
while you work alone it stays on this Mac* (*this PC* on Windows) — with the way to **Work with a
team**.

When a project you open has a shared setup on GitHub made for another line
of work, the Board says *This project has a shared setup on GitHub* and asks
before using it: **Keep this folder's setup** or **Use the shared setup**
(**Use the one for** *…* for each, when there are several). Using one starts
cards from the one you pick and renames the project to match.

**Team:** you also get the team's shared projects, a shared board backed by
GitHub Issues if your team uses one, and the team library (skills every
member's agents can use). A team is a private GitHub repository; who is in
it is decided by its owner and by GitHub's own access rules. Your team's
work stays in that repository; Plyloft's server only knows your plan and its
seats.

Switch at any time: **Settings › Setup and account › Setup › Work with a team**.

**Your plan and your Plyloft account.** **Settings › Setup and account ›
Plan** has two sections. **Your plan** says *Free* or *Team* (*Team · owner*
or *Team · member*) and has **Start a team** with **Open Team**, also when you
aren't signed in, as long as you have no Team plan or seat. **Plyloft account** has the sign-in:
**Sign in with GitHub** when you aren't signed in (the code shows on the page),
or your GitHub name with **Sign out**, and **Last checked** with **Check now**.
Signing out keeps everything for one person working; team features turn off
on this computer until you sign in again.

Team runs on one computer at a time. When a Team seat is given to you, the
page says **Your seat on** *owner/team* **is ready** with **Use Team on this
computer**. When Team is on another computer, it says **Team is on another
computer (**the computer's name**)**, with the same button; pressing it moves
Team here, and the other computer then shows that notice. Only on the
computer that has Team, **This device** has **Sign out other computers**,
which signs every other computer out of your Plyloft account until it signs
in again. On the Free plan none of this appears.

Creating a team while you're signed out asks you to **Sign in with GitHub**
in the same panel, then goes on. If you joined a team and aren't signed in to
Plyloft, the team's page says **Sign in to use your seat** (for the team's
owner: **Sign in to use your Team plan**), with **Sign in with GitHub**;
everything else you get from the team keeps working.

**Leaving a team.** In **Settings › Team**, **Leave this team** (under
**Danger zone**) has **Leave…** when you hold a seat; the sheet says what
you lose (a board on GitHub Issues becomes read-only for you, the team library stops updating, and the owner
can give your seat to someone else) and what stays (the team repository's
clone and every team workspace stay on this Mac; your access on GitHub, your
issues and pull requests stay until the owner removes you). Leaving frees
your seat on the team's plan and this Mac stops following the team; your
plan goes back to Free: everything for one person keeps working. It needs a connection: if Plyloft can't reach
your account, nothing changes and the sheet says why. If you hold a seat on
a team this Mac never joined, **Settings › Setup and account › Plan** says "You hold a seat on
owner/team." with **Give up the seat…**, so you can join another team or
start your own.

**Cards on a board of GitHub issues.** Every open issue is a card, and
**Start build** claims it first: your GitHub name goes on the issue as its
assignee ("Claimed #161 and started the build"), so the team sees who is on
it. A card someone else claimed says "Claimed by example-teammate. Start build
asks before you claim it too."; **Claim it too…** in its **⋯** asks the
same. If two of you press **Start build** within seconds, only one build
starts: the other sees "example-teammate started this a moment ago", their name
comes off the issue again, and the default is **Leave it to example-teammate**
(**Claim it too** starts it anyway, and the card then says "Claimed by you
and example-teammate"). **Ship it** checks the issue first: when a teammate's
pull request for it is already open, or merged with the issue closed,
nothing is sent to GitHub, your work stays in the card's copy, and the card
offers **Open pull request #178** to agree which work ships. Plyloft never
overwrites a teammate's branch.

Leaving a card frees its issue: **Move back to Ready to start**, **Stop**
while it starts, and **Archive** take your own name off the issue (never
anybody else's), as long as the card has no pull request and hasn't shipped;
the message says "Your name is off issue #161." If GitHub doesn't take it
off, the message says so and the next **Sync** tries again. A card brought
back from **Archived** comes back without your name: **Start build** or
**Claim** puts it back.

An issue is somebody else's text, and the Builder gets it that way: marked
as the issue's text, not as instructions. A part of the issue GitHub hides
from readers (an HTML comment) is shown under the brief — "Hidden on GitHub,
shown here · 1 part, line 3" — and marked as hidden for the Builder too. On
a public repository anyone can open an issue: a card whose issue was written
by someone who isn't a collaborator says "From outside the repository ·
login" on the Board, and before it starts its Now box adds "Read the brief
before you start". Start build doesn't ask anything more.

**The same account on two Macs.** On a board of GitHub issues, a card you
start on one Mac says so on the other: *On your MacBook Pro · 2 h ago*, on
the card and its page. **Start build** there asks first: *This card is being
built on your MacBook Pro*, with **Cancel** (the default), **Start here
too** (a second copy; the two don't see each other's changes) and **Take it
over here** (for when you've left the other Mac: the card is yours here, and
the other Mac shows *Taken over by Mac mini*; its copy stays there until you
delete it). The mark stays as long as the card's copy is on that Mac:
closing the Builder session, or moving the card back with its work kept,
leaves it. Done, Archive, deleting the card or its copy, and the merge of its
pull request free it. With one Mac, or with a
teammate's card, nothing of this shows: the issue's assignee decides, as
before. To tell the two apart, the issue keeps a hidden line with the
computer's name (without your name: *MacBook Pro*) and an id that is
different in every repository.

---

## 6. Local-only or GitHub; one AI or two

**Local-only** projects live only on your computer. Shipping a card merges it
into your project's main branch on your computer. Back up your computer as
usual. You can connect GitHub later and add an online copy: **Put it on
GitHub…** on a card ready to ship, or in Settings › Cards › Shipping, makes
it a private repository in your account.

**With GitHub** you get an online backup, pull requests (**Ship it** opens
one and merges it when the checks pass), and teams. Each project can use a different GitHub account if you
have several.

**One AI** builds and reviews in separate sessions. That already catches a
lot. **Two AIs** (Claude and Codex) let one build and the other review, which
is a more independent check. Choose who builds in **Settings › Cards › AI
and models › Who builds new cards**, or per card. That row shows the AI a new
card starts with: picking an AI on a card makes it the choice there too, and
choosing there again sets it for the next cards.

**A second Claude subscription.** You can add one in **Settings › Cards ›
AI and models › Claude accounts**; it signs in with Claude's own login.
New sessions start on the account you choose there. A session that is
already running keeps its account, and resuming a conversation uses the
account it was started on. With more than one account, a Claude terminal
and a card's Builder say which one they run on. When a card's Builder
reaches its usage limit, the card offers **Start fresh on** and the name of
another of your accounts: only when you press it, it starts a new Builder on
that account in the same copy, and new sessions still start on the account
you chose.

**Models.** Each role runs on the model and effort set for it in **Settings ›
Cards › AI and models › Models**: one row per AI, whose **Change…** opens its
Builder and Reviewer for **Every project**, and **Only in** the open project
for this Mac; with nothing set, the tool's default. A project that shares its
settings can also suggest models to the team, in **Settings › Project ›
General › Models suggested for the team**, which anyone who can push to the
repository can change; a suggestion is marked **Team**. Which one wins: a
card's own choice, then this project's, then the team's suggestion, then this
Mac's (this PC's on Windows). Terminals use each AI's own choice. The
lists offer the newest version of each model the tools know today (Codex's own
list, and Plyloft's for Claude), and you can still type any name; **Effort**
offers the levels the chosen model takes. Planning, a card's **Ask about this card**, agent runs
and Claude checks use the Builder's model; a review, and the critique in Plan
with two AIs, use the Reviewer's. On a card, **Change…** at the end of its facts line
shows the model each will run on: press it to choose a model and its effort
for that card only, or **Use the workspace's** to go back. It
applies from the next session or review; one already running keeps its model.
Once a Builder session has done some work and ended (or failed), or a review
has finished, **Retry on…** (under the same **Change…**) beside its model runs that round again once on
another model and effort: the Builder as a new session on the work already in
the card's copy, the Reviewer on the same snapshot, even after a verdict. The
card's own model stays as it is, and Activity lists both attempts with their
models. **Details › Technical** shows what the last session and review ran on.

---

## 7. Where to change things later

| What | Where |
|---|---|
| Run setup again, see what's missing | Settings › Setup and account › **Setup** › Open setup |
| Step by step or just the essentials | Settings › Setup and account › Setup › How setup explains things |
| The Getting started tour | **Help** › **Getting started**, at the bottom of the sidebar (also Settings › Setup and account › Setup › Getting started) |
| Work with a team (show team features) | Settings › Setup and account › Setup › **Work with a team** |
| Add another project (a folder, from GitHub, or new) | The project switcher › **Add a project…**, or ⌘K › Add a project… |
| Projects folder | Settings › Setup and account › Setup › Projects folder |
| GitHub accounts | Settings › Setup and account › Setup › GitHub accounts |
| Which GitHub account each project uses | Settings › Setup and account › Setup › Account for each project |
| Text size of terminals and the editor (**⌘=** / **⌘−** / **⌘0** in one, **Ctrl** on Windows) | Settings › Look and feel › **Editor and terminals** › Terminal text size, Editor text size |
| Where Plyloft looks for the claude, codex, git and gh commands | Settings › Look and feel › **Editor and terminals** › Program folders (left empty: what your login shell reports) |
| Screen reader support (VoiceOver, Narrator, NVDA) in the terminal you're typing in | Settings › Look and feel › **Appearance** › Accessibility |
| Which AI builds your cards, models | Settings › Cards › **AI and models** |
| One card's models | The card › **Change…** at the end of its facts line |
| Notifications, and whether they get through | Settings › Look and feel › **Notifications** |
| Your name on shared records | Settings › Setup and account › **Profile** |
| Your plan, your Plyloft account, the team plan, and which computer Team runs on | Settings › Setup and account › **Plan** |
| Tools, sign-ins and their status | Settings › Setup and account › **Diagnostics** |
| How a project is built and checked | Settings › Cards › **Building and checking** |
| Where a card goes, how it ships and how it is released | Settings › Cards › **Shipping** |
| How Plyloft starts your app (Try it) | Settings › Cards › Building and checking › **How to start your app** |
| Where a project's cards come from | Settings › Project › General › Where the cards live (also Board ⋯ › Where the cards live) |
| Team members, team projects, the team library | Settings › Team › Members and library (team only) |
| Stop sharing a project's setup, or share it again | Settings › Project › General › **Shared setup** |
| Leave the team (and give up your seat) | Settings › Team › Danger zone › **Leave this team** |

Open Settings with **⌘,** on a Mac or **Ctrl+,** on Windows. **⌘K** / **Ctrl+K**
searches commands, including "Open setup".

---

## 8. Troubleshooting

**A skill I wrote says "Only in your project folder".**
It works in your own sessions, but teammates don't have it yet. Press **Ship
it with a card** on its row in the Library: Plyloft makes a card carrying the
skill exactly as your folder has it (files git ignores are left out) and opens
it at Ship. If the project has a newer copy than your folder, Plyloft makes no
card and offers **Ask the Builder** to bring it here first.

**A Library row says "Your project folder is behind <branch>".**
Press **Ask the Builder**. Plyloft opens a session of your AI in the project
folder that asks it to bring the branch's latest changes in, only if that
needs no merge, and to ask you before anything else. It never throws away,
stashes or commits your own changes.

**A skill says "Needs your OK".**
A skill from the team library or My library whose text lets agents do
things without asking you — run commands, change files, or run a command
as soon as it loads — is asked about like a script, on every computer that
gets it. The row says the widest thing it asks ("Needs your OK · it lets
agents run commands without asking you. New sessions don't get it until you
say OK."), and so does the Inbox. Open it: the sheet lists "What it asks to
be allowed to do", each item with the line of `SKILL.md` it comes from.
Your OK is for that exact text: if `SKILL.md` changes, Plyloft asks again,
and meanwhile new sessions keep the version you approved. If Plyloft
couldn't read the top of `SKILL.md`, it says so and asks too. A skill that
is only text and asks for none of this never asks. When you share a skill
like this with your team, sharing it is your own OK on this Mac, and the
Share page says the others will be asked.

**A message says a board, or the project list, couldn't be read.**
Plyloft keeps the damaged file and never writes over it. For a board ("The
board of lyra couldn't be read"), it opens the last saved copy: anything
changed after that copy was saved isn't in it. Plyloft's own **Merge when
checks pass** is turned off on the cards that had it on (the message's
Details say on how many; turn it on again where you want it), and on a board of GitHub
issues Plyloft reads the issues from GitHub once before it sends anything
there. For the project list ("Your project list couldn't be read"), Plyloft
starts with no projects and keeps the old file; if a newer Plyloft saved it,
update Plyloft to open your projects. **Show in Finder** (**Show in File
Explorer** on Windows) opens the kept file; the message stays until you
close it.

**Settings › Team says "You and a teammate changed the same file."**
Choose, for each file, **Keep mine**, **Keep theirs** or **Keep both** (your
teammate's stays in the library and yours is saved in a dated folder on this
computer), then **Put them together**. Nothing reaches your team yet: press
**Publish** to send it, or **Undo** to put the team library on this computer
back as it was. Other team library changes wait until you choose one. If it
says the team library has changes Plyloft didn't make, **Move them aside**
copies them into a dated folder first.

**Setup says I'm offline, or a download failed.**
Check your connection and press **Try again**. On a company network, a proxy
or firewall may block the downloads; ask whoever manages it to allow
claude.ai, chatgpt.com, github.com and the Windows package installer, or use
**Do it yourself** to install the tool from its website, then press **Check
again**.

**Windows says an administrator is needed.**
Git for Windows installs for the whole PC. Ask your IT team to install it,
or install it yourself with an administrator account, then press **Check
again**. Claude Code, Codex and the GitHub CLI install for your user and
don't need an administrator.

**"Windows protected your PC" when installing Plyloft.**
Choose **More info → Run anyway**. The installer isn't signed with a
Microsoft certificate yet.

**The macOS "install developer tools" window didn't appear, or I closed it.**
Press **Install** again in setup. If your Mac is managed by your company and
asks for an administrator password you don't have, ask your IT team to
install the Command Line Tools.

**I signed in in the browser but Plyloft still says "Not signed in yet".**
Wait a few seconds; Plyloft checks every two seconds. If the terminal in the
step shows an error, press **Sign in** again. For Codex behind a company
network, use **Sign in with a code instead**.

**Plyloft says it couldn't tell whether you're signed in (Claude).**
If your Claude tiles start and answer, there's nothing to do. Open Setup's
**Your AI** step to check again.

**Plyloft offers "Update" for Claude Code, Codex or the GitHub CLI.**
A newer version exists, or yours is too old for Plyloft. Press **Update** when it
suits you (in Setup or Settings › Setup and account › Diagnostics). Claude Code and the
GitHub CLI never update by themselves; Codex updates itself in the background
at most once a day, when no Codex is open or starting. A Codex tile no
longer opens on Codex's own "Update available" question: Plyloft owns that
update, so Diagnostics shows **Update** and the automatic update runs.

**Plyloft says Claude Code or Codex is now a different version.**
You (or a package manager) updated the tool, or moved where it starts from,
outside Plyloft. Plyloft says so once, with the old and the new version. If a
review depends on it, Plyloft also says once, when it starts, that it is
checking the tool can still review safely: usually one short request on your
plan. Nothing to do.

**Claude Code or Codex doesn't start, or an update failed.**
Open Settings › Setup and account › Diagnostics and press **Repair** under
the tool's name (it is also offered beside a failed install or update in Setup,
on a tile whose tool didn't start, and in the sidebar). Plyloft looks first and
changes nothing: it shows what it found in plain words, and what it will do, in
order, before you press **Repair**. It reinstalls the tool with its official
installer, removes a broken file or shortcut it can name, and says if the same
tool is installed twice (for example with npm and with the official
installer), which copy a tile starts and which one a Terminal window starts.
The copy installed with npm is removed only if you tick the box for it. Your
sign-in, projects and settings are never touched. If the tool's folders belong
to another account, Plyloft asks for your Mac's password in its own terminal in
the sheet: type it there. What you type goes straight to macOS;
Plyloft doesn't show it, log it or keep it. If two such
steps are needed, you are asked twice and the sheet says so. Tiles open with
that tool are listed first and closed; at the end **Reopen the tiles Plyloft
closed** opens them again in the same projects. A tile that had a conversation
continues it; a Codex chat, and a tile that hadn't started one yet, opens
fresh. What Plyloft can't do for you (for instance on Windows, where it
doesn't change who owns a folder) it lists as commands to copy under **By
hand**. **Copy report** copies what happened, without your name or password.

**Program folders are set and nothing starts.**
Settings › Look and feel › Editor and terminals › **Program folders** replaces
what your login shell reports with a list of folders, separated by `:` on a Mac
and `;` on Windows. It holds folders, never a program: `~/.local/bin`, not
`~/.local/bin/claude`. Under the field Plyloft says which of claude, codex, git
and gh the list finds. A folder written with `~`, or with spaces around it, is
written out in full when you save; a program in place of a folder is offered as
**Use its folder**; and a list that leaves out the tools or the system folders
is saved only after you confirm. When your shell already reports the folders
you typed, **Empty it** comes first: left empty, Plyloft follows your shell,
also when it changes. A variable such as `$PATH`, or **Add them in front of the
folders your shell reports now**, writes a fixed copy of your shell's folders
that won't follow later changes. When Claude Code or Codex works but sits
outside your Program folders, **Repair** adds its folder, or empties the
setting when your shell already finds the tool, instead of installing it
again; it tells you what it changed and offers **Undo**. If the list itself
can't work and Repair can't fix it, Repair and Diagnostics say why and **Open
Program folders** takes you to it. In Setup, a tool that Repair's own check finds
outside your Program folders reads **Not in your Program folders** with **Open
Program folders**, never **Install**; a tool that isn't installed anywhere still
offers **Install**, even with the setting filled in. A list that is well written
but leaves things out offers **Empty it** or **Remove** the folders that don't
exist.

A message from Plyloft, such as **Program folders changed** with **Undo**, is
drawn above whatever is open, never on a sheet's text or buttons; an **Undo**
stays for six seconds.

**The sidebar says something needs you.**
One row in the sidebar names the problem that stops work (for
example "Program folders find no AI tool", "Claude Code doesn't start" or "Git
isn't installed") with one button: **Fix** goes to the place that fixes it,
**Repair** opens the Repair sheet, **Sign in** goes to the sign-in. "and N more"
opens Settings › Setup and account › Diagnostics, where every row is. Plyloft
shows a row only when it is sure.

**I need to send Plyloft's own report when I ask for help.**
Settings › Setup and account › Diagnostics › **Copy report** copies the page as
plain text: the version, each row and what to do about it, and what the Program
folders find. Your home folder is written as `~`, and it carries no user name,
Mac name, project name, password or token.

**A setting is checked when you save it.**
Program folders, the **Tile shell** (Settings › Look and feel › Editor and
terminals), the team clone folder, and the two commands typed for a project,
**How to start your app** and **Before the Builder starts, run**, are read when
you save them, never while you type. A value that can't work (a folder where a
program belongs, a program with options, a name Plyloft can't find) is not
saved as typed: Plyloft says why and offers the corrected value, or **Keep what
was there**. For a command the shell may complete, such as one that starts your
app, it only hints or warns. A value saved earlier that can't work is listed in
Diagnostics under **Settings that can't work as written**, with **Open the
setting**; Plyloft never rewrites it by itself.

**I have Claude Pro and a build stopped.**
Pro has a usage limit that resets over time. Wait for it to reset, or
upgrade to Max. Your card keeps its state; press the card's action again
when you're ready.

**I only have Codex (or only Claude). Is something missing?**
No. One AI builds and reviews. The review says it was *Reviewed by a
separate Codex session*. Adding
the other later gives a more independent review.

**GitHub says my organization needs single sign-on.**
Plyloft shows **Authorize**. It opens GitHub's page for your organization;
approve the GitHub CLI there and try again.

**Downloading a project from GitHub failed with "not found" or "access".**
The GitHub account you're using can't see that repository. If you have
several accounts, pick the other one. Otherwise ask the repository's owner
for access.

**I chose a folder and Plyloft says it's inside another Git project.**
Plyloft works with whole Git projects. Use the bigger project it suggests, or
pick a different folder.

**My project isn't on a branch ("detached").**
Plyloft asks which branch your cards should start from. It doesn't switch your
folder's branch for you.

**A card won't start: "isn't set up for Plyloft's builds yet".**
Step 8 was skipped. Open **Setup** (or Settings › Cards › Building and
checking) and confirm how Plyloft builds your project.

**The team invite didn't work.**
Joining needs two things: the team's owner added you in Plyloft, and GitHub gave
your account access to the team's repository. Check your email or
github.com/notifications for the GitHub invitation (it expires after 7 days;
Plyloft accepts it for you when you paste the code), then paste the code again.
If Plyloft says the repository "isn't a Plyloft team", the code points to the wrong
repository; ask the owner for a new one.

**Plyloft froze.**
Settings › Setup and account › Diagnostics › **Responsiveness** says whether the window
stopped answering since Plyloft started (or Plyloft couldn't run at all because
the computer was too busy), for how long and how much memory was free then, and
whether the last run ended cleanly. Plyloft writes each freeze to its log with
the memory at that moment; **Reveal log folder** on the same page opens it. When memory was low, the row says what to do: close other apps or a virtual
machine, and about how much memory Plyloft needs free.

**I want to start over.**
Settings › Setup and account › Setup › **Open setup** re-checks everything and changes
nothing until you press a button. To put Plyloft's preferences (theme, models,
notifications and so on) back to how Plyloft ships, use the danger zone at the
bottom of Diagnostics; your projects, cards and setup answers are kept.

**Where are my projects' files?**
In the folders you chose; Plyloft doesn't move them. Each card works in a
separate copy that Plyloft creates and removes by itself.
