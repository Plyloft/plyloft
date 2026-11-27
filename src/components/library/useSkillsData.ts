import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  knowledgeProjectState,
  onFileChange,
  onSharedLibraryEdited,
  onWorkspaceDefinitionRefreshed,
  personalSkillsView,
  plySkillsView,
  skillsHubLinks,
  type KanbanCard,
  type SkillLinkRow,
  type SkillLinkOffer,
  type SkillTwinRow,
  projectSkillsView,
  type PersonalSkills,
  type PlySkill,
  type PlyPlace,
  type ProjectSkillsView,
} from "../../ipc";
import type { LibraryStateLike } from "../../lib/sharedLibrary";
import { LatestRequest } from "../../lib/latestRequest";
import {
  absoluteSkillDir,
  crossScopeDuplicates,
  prunedSilencedIn,
  pruneSilencedDuplicates,
  silencedPairKeys,
  identicalPairKeys,
  shareComparisons,
  shareTarget,
  shareTargetKey,
  skillSections,
  type SkillsInput,
} from "../../lib/librarySkills";
import { plySkillOn } from "../../lib/plySkills";
import { liveSwitch } from "../../lib/plySkillSwitch";
import type { Scope } from "../../lib/uxScope";
import { useLibrary } from "../../store/libraryStore";
import { useSkillsHub } from "../../store/skillsHubStore";
import { teamRowsKey } from "../../lib/skillsHub";
import { useSolo } from "../../store/workModeStore";
import { useSettings } from "../../store/settingsStore";
import { pushToast } from "../../store/toastStore";
import { joinPath } from "../../lib/paths";
import { useKanban } from "../../store/kanbanStore";
import { useAllSkills } from "../../store/allSkillsStore";
import { useUi } from "../../store/uiStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { isSkillCard } from "../../lib/skillCards";

/**
 * UX language card 4 (GH #96): everything the Skills page reads, for one
 * workspace.
 *
 * Four reads, because the scopes genuinely live in four places: the repository
 * and the team library come from the rung-4 view, the branch and its queue from
 * the shared-library state, this Mac's own skills from the member's home, and
 * the skills that come with Ply from the app's own bundle (GH #106). They are
 * refetched on the same two events the Project panel listened to — a local queue
 * edit, and a refresh that brought a teammate's change — so a page left open
 * never shows a skill that is gone.
 *
 * Only the newest request may paint: a view is a `git pull` and, on a cold
 * cache, a `gh api` away, so an answer about a previous workspace can land
 * after a switch (the rule Settings → Team and the Project panel follow).
 *
 * And only while the Library is the workspace's visible mode. The host stays
 * mounted for every warmed workspace that has ever shown it (so no unsaved note
 * draft is lost), and eight hidden hosts each pulling on every refresh would be
 * eight `git pull`s nobody is looking at. It loads when it becomes visible.
 */
export interface SkillsData {
  input: SkillsInput | null;
  /** The repository view, for the paths and reasons the actions need. */
  view: ProjectSkillsView | null;
  library: LibraryStateLike | null;
  personal: PersonalSkills | null;
  loading: boolean;
  /**
   * How many times these facts have been read, counting from the first.
   *
   * GH #100: a skill's page reads the two `SKILL.md` itself — for its files, its
   * rendered text and the content ids `Keep both` is keyed by — and it stays
   * mounted while the member is in Code. This is the signal that says "read them
   * again": the same moments the rows are refreshed (becoming visible, a publish,
   * a refresh that brought a teammate's change) are the moments a copy may have
   * changed under the page.
   */
  generation: number;
  /**
   * Read it all again. A write into the checkout or the team clone emits no
   * event of its own — only the shared channel's publish does — so after an
   * Install, a Promote or a Replace the CopyState a row was drawn from is stale,
   * and its button would still say `Replace…` for a copy that now matches
   * (review 2). The Project panel reloaded after every write for the same
   * reason.
   */
  reload: () => void;
  /**
   * H4 Windows re-walk: the row says *Proposed upstream · pull request #n*
   * as soon as the proposal opened, before the re-read answers (which can
   * take seconds on Windows; the row stayed at *modified here*).
   */
  noteProposal?: (skill: string, proposal: { number: number | null; url: string }) => void;
  /**
   * GH #100: the `SKILL.md` of every copy in a duplicate pair, by row key.
   *
   * Read here rather than per row, because two things need the same bytes: the
   * list, to know whether `Keep both` has silenced a pair (the mute is keyed by
   * both copies' content ids), and the skill's page, to draw Compare. There are
   * as many reads as there are copies of a duplicated name, which is a handful by
   * construction — one name has to exist at two scopes before it is read at all.
   */
  pairTexts: Readonly<Record<string, string>>;
  /**
   * Decision §6 (group B): the duplicate pairs whose two copies are the same
   * whole tree, as `duplicatePairKey` spells them. Quiet like a pair `Keep both`
   * silenced — only the `Also in …` chip — until either copy changes.
   */
  identicalPairs: readonly string[];
  /**
   * GH #105: the branch's two copies of a skill whose copies disagree, by row
   * key — Claude's `SKILL.md` and Codex's, out of the mirror.
   *
   * Read here for the reason `pairTexts` is: the comparison is a fact about the
   * rows, the page draws it, and one read answers both. Only for the rows that
   * say they differ, which is a handful by construction.
   */
  driftTexts: Readonly<Record<string, { claude: string | null; codex: string | null }>>;
  /**
   * GH #106 review 1: why the skills that come with Ply reach nothing, when they
   * reach nothing. Drawn once under the `Comes with Ply` heading. `null` in the
   * ordinary case and when every one of them is switched off.
   */
  plyProblem: string | null;
  /** Skills hub H9: where the Plyloft switch was read (`PlySkillsView.place`). */
  plyPlace: PlyPlace | null;
  /**
   * Why the repository's read failed, from its last attempt; `null` once one
   * has answered. With no view yet the page has nothing to list at all, so it
   * draws this as its error block with `Try again` (`reload`) — a toast alone
   * left a blank page with `Filter 0 skills` on it.
   */
  readError: string | null;
}

export function useSkillsData(workspaceId: string, active: boolean): SkillsData {
  const [view, setView] = useState<ProjectSkillsView | null>(null);
  const [library, setLibrary] = useState<LibraryStateLike | null>(null);
  const [personal, setPersonal] = useState<PersonalSkills | null>(null);
  // GH #106: the skills that come with Ply. Read once with the other three, and
  // never per row — the bundle is the same from every workspace.
  const [ply, setPly] = useState<PlySkill[]>(EMPTY_PLY);
  // Skills hub H3a: linked copies, and this board's skill cards still open
  // (a plain array off the store, filtered in render — PATTERNS selector rule).
  const [links, setLinks] = useState<SkillLinkRow[]>(EMPTY_LINKS);
  // Skills hub H3b: unlinked copies that equal a team version (R-M).
  const [linkOffers, setLinkOffers] = useState<SkillLinkOffer[]>(EMPTY_OFFERS);
  // Skills hub H5 (R12): checkout skills whose two copies aren't aligned.
  const [twins, setTwins] = useState<SkillTwinRow[]>(EMPTY_TWINS);
  /** QoL 13.1: the checkout skills not committed (Ship it with a card). */
  const [uncommitted, setUncommitted] = useState<string[]>(EMPTY_NAMES);
  const boardCards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_CARDS);
  // Why they reach nothing, when they reach nothing (review 1): said once under
  // the section heading rather than left to the log.
  const [plyProblem, setPlyProblem] = useState<string | null>(null);
  // Skills hub H9: the workspace, repository and team the switch was read for.
  const [plyPlace, setPlyPlace] = useState<PlyPlace | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  /** Whether a view is on screen, for the one failure that is a toast: a
   *  re-read that failed under rows still showing (those rows are stale). */
  const hasView = useRef(false);
  const [generation, setGeneration] = useState(0);
  const [pairTexts, setPairTexts] = useState<Record<string, string>>(EMPTY_TEXTS);
  const [pairDigests, setPairDigests] = useState<Record<string, string | null>>(EMPTY_DIGESTS);
  const [driftTexts, setDriftTexts] = useState<Record<string, DriftPair>>(EMPTY_DRIFT);
  const request = useRef(new LatestRequest());
  const removedUpstream = useLibrary(
    (s) => s.byWorkspace[workspaceId]?.removedUpstream ?? EMPTY_REMOVED,
  );
  const silencedHere = useSettings((s) => s.settings.library.silencedDuplicates);
  // GH #106: which skills that come with Ply are switched off here. A plain
  // array off the store, like its neighbour: a selector that derived anything
  // would hand out a new reference on every settings read (docs/PATTERNS.md).
  const plyOff = useSettings((s) => s.settings.library.plySkillsOff);
  // OB-9 (onboarding §10 row 5): solo mode hides the Team scope — its section,
  // its `Also in Team` chips, `Promote to Team`. Presentation only: the read is
  // the same, and turning team on shows it all again.
  const solo = useSolo();

  const load = useCallback(async () => {
    const ticket = request.current.begin();
    setLoading(true);
    // Skills hub H3a: the checkout's linked copies. Additive: a read that
    // fails leaves the rows as they were, unlinked. H4 Mac walk: painted as
    // soon as it answers — the repository view can be a pull away, and the
    // row kept "up to date" for seconds after the copy had changed.
    const linkedRead = skillsHubLinks(workspaceId).then((value) => {
      if (request.current.isCurrent(ticket)) {
        setLinks(value?.links ?? EMPTY_LINKS);
        setLinkOffers(value?.offers ?? EMPTY_OFFERS);
        setTwins(value?.twins ?? EMPTY_TWINS);
        setUncommitted(value?.uncommitted ?? EMPTY_NAMES);
      }
      return value;
    });
    const [repository, shared, mine, plys, linked] = await Promise.allSettled([
      projectSkillsView(workspaceId),
      knowledgeProjectState(workspaceId),
      personalSkillsView(),
      // Skills hub H9: read for this workspace, so each row's switch says
      // which level decides here (workspace, a fork, the team, this Mac).
      plySkillsView(workspaceId),
      linkedRead,
    ]);
    if (!request.current.isCurrent(ticket)) return;
    if (linked.status === "rejected") {
      setLinks(EMPTY_LINKS);
      setLinkOffers(EMPTY_OFFERS);
      setTwins(EMPTY_TWINS);
      setUncommitted(EMPTY_NAMES);
    }
    if (repository.status === "fulfilled") {
      setView(repository.value);
      hasView.current = true;
      setReadError(null);
    } else {
      setReadError(String(repository.reason));
      // With nothing on screen the page's own error block says it; a toast too
      // would be the same news twice.
      if (hasView.current) {
        pushToast({
          kind: "error",
          title: "Couldn't read this repository's skills",
          details: String(repository.reason),
        });
      }
    }
    // The shared channel and this Mac's own folders are additive: a workspace
    // that shares nothing, and a Mac with no personal skills, are both
    // ordinary, and neither is worth a toast.
    setLibrary(shared.status === "fulfilled" ? shared.value : null);
    setPersonal(mine.status === "fulfilled" ? mine.value : null);
    // A build whose bundle could not be read answers empty, and the section is
    // then absent rather than drawn empty (BOARDS.md §3) — additive, like the
    // team layer, so it is not worth a toast either. A bundle that is there and
    // cannot be delivered is a fault, and the section says it (review 1).
    const plySkills = plys.status === "fulfilled" ? plys.value.skills : EMPTY_PLY;
    setPly(plySkills);
    setPlyPlace(plys.status === "fulfilled" ? (plys.value.place ?? null) : null);
    setPlyProblem(plys.status === "fulfilled" ? plys.value.problem : null);
    setLoading(false);

    // Then the duplicates' own files, which need the rows to know where they are.
    // A failure is silence, not a toast: a copy Ply cannot read is a pair with no
    // silence to check and a Compare that says so where the comparison would be.
    const rows =
      repository.status === "fulfilled"
        ? duplicateCopies(
            {
              repository: repository.value.skills,
              mirror: shared.status === "fulfilled" ? shared.value.branchSkillRows ?? [] : [],
              team: repository.value.team,
              promotePlugin: repository.value.promotePlugin,
              personal: mine.status === "fulfilled" ? mine.value.skills : [],
              ply: plySkills,
              shared: shared.status === "fulfilled" ? shared.value.shared : false,
              branch: null,
              branchReadOnly: false,
              branchSkills: [],
              pending: [],
              removedUpstream: EMPTY_REMOVED,
              nowMs: Date.now(),
              canPromote: false,
            },
            repository.value.cwd,
          )
        : [];
    const [texts, digests] = await Promise.all([
      readPairTexts(rows),
      readPairDigests(workspaceId, rows),
    ]);
    if (!request.current.isCurrent(ticket)) return;
    setPairTexts(texts);
    setPairDigests(digests);
    // GH #105: and the two copies of every skill whose branch copies disagree.
    const drifted = await readDriftTexts(
      repository.status === "fulfilled" && shared.status === "fulfilled"
        ? driftPairs({
            repository: repository.value.skills,
            mirror: shared.value.branchSkillRows ?? [],
            team: repository.value.team,
            personal: mine.status === "fulfilled" ? mine.value.skills : [],
            ply: plySkills,
            shared: shared.value.shared,
            branch: shared.value.branch,
            branchReadOnly: shared.value.readOnly,
            branchSkills: shared.value.branchSkills,
            pending: [],
            removedUpstream: EMPTY_REMOVED,
            nowMs: Date.now(),
            canPromote: false,
          })
        : [],
    );
    if (!request.current.isCurrent(ticket)) return;
    setDriftTexts(drifted);

    // A silenced pair whose name no longer exists at two scopes can never match
    // again, so its record is dead weight in settings.json — and would silence
    // the notice again for nothing if that name came back with the same bytes
    // (review 1). Pruned here, and **only when all three reads answered**: a
    // failed read makes every pair look gone, and pruning on that would throw
    // away a decision the member made.
    if (
      repository.status === "fulfilled" &&
      shared.status === "fulfilled" &&
      mine.status === "fulfilled"
    ) {
      const duplicates = crossScopeDuplicates({
        repository: repository.value.skills,
        mirror: shared.value.branchSkillRows ?? [],
        team: repository.value.team,
        personal: mine.value.skills,
        ply: plySkills,
      });
      // Which scopes this call may call dead (`JudgeableScopes`). `repository` is
      // never among them — settings.json is app-global while these duplicates are
      // one workspace's — and `team` only when the library is really there: a Mac
      // with no key, or a clone not synced yet, reads it empty, and every
      // `team|this-mac` pair would look dead for a reason that has nothing to do
      // with the duplicate (review 2).
      const judgeable: Scope[] = ["this-mac", "ply"];
      if (repository.value.configured && repository.value.hasClone) {
        judgeable.push("team");
      }
      // The outer read is the "anything to do at all?" guard, so the common case
      // costs no write. The decision itself is made again **inside** the mutation,
      // against the settings as they are when the queue runs it: computing it out
      // here and writing the result in there discarded whatever landed in between,
      // and a `Keep both` in flight was silently undone (review 2).
      const worthWriting =
        pruneSilencedDuplicates(
          useSettings.getState().settings.library.silencedDuplicates,
          duplicates,
          judgeable,
        ) !== null;
      if (worthWriting) {
        void useSettings
          .getState()
          .update((latest) => prunedSilencedIn(latest, duplicates, judgeable));
      }
    }
    // Last, and only for the request that was allowed to paint: `generation` is
    // the marker that says "every fact on this page has been read again", which
    // is what the skill page's own reads and its `textsRead` hang off. A bump
    // from a retired request would make it re-read for a workspace nobody is
    // looking at, and a bump before this read would say the texts had settled
    // when they had not.
    setGeneration((n) => n + 1);
  }, [workspaceId]);

  useEffect(() => {
    if (!active) return;
    void load();
    const offEdited = onSharedLibraryEdited((id) => {
      if (id === workspaceId) void load();
    });
    const offRefreshed = onWorkspaceDefinitionRefreshed((report) => {
      if (report.workspaceId === workspaceId) void load();
    });
    // H4 Mac walk: a change to a skill's files in the checkout (an edit, a
    // checkout or a pull) re-reads the page shortly after, instead of when
    // the member next comes back to the Library. Bursts are one read.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const offFiles = onFileChange((e) => {
      if (e.workspaceId !== workspaceId || !isSkillFilePath(e.path)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, SKILL_FILES_SETTLE_MS);
    });
    return () => {
      request.current.retireAll();
      if (timer) clearTimeout(timer);
      void offEdited.then((off) => off());
      void offRefreshed.then((off) => off());
      void offFiles.then((off) => off());
    };
  }, [workspaceId, load, active]);

  // Skills hub H8 (Mac re-walk): a link's state depends on another
  // workspace — the copy's origin — so the Library reads its links again
  // when that can have moved: a skill file changed in another workspace
  // (while this one has a copy linked to a workspace), All skills read this
  // workspace again (its page opening, Read again, the hourly sweep), All
  // skills closed back to this page, or a workspace was added or removed.
  // Each is one debounced read.
  const linksFromWorkspaces = useRef(false);
  linksFromWorkspaces.current = links.some((l) => l.originKind === "workspace" || l.originKind === "this-mac");
  const indexedHere = useAllSkills((s) => s.index.workspaces.find((w) => w.id === workspaceId));
  const allSkillsOpen = useUi((s) => s.allSkillsOpen);
  const workspaceIds = useWorkspaces((s) => s.workspaces.map((w) => w.id).join(","));
  const elsewhere = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRead = useRef(0);
  const readSoon = useCallback(() => {
    if (elsewhere.current) clearTimeout(elsewhere.current);
    elsewhere.current = setTimeout(() => {
      elsewhere.current = null;
      lastRead.current = Date.now();
      void load();
    }, SKILL_FILES_SETTLE_MS);
  }, [load]);
  useEffect(() => () => {
    if (elsewhere.current) clearTimeout(elsewhere.current);
  }, []);
  useEffect(() => {
    if (!active) return;
    const offFiles = onFileChange((e) => {
      if (e.workspaceId === workspaceId || !linksFromWorkspaces.current || !isSkillFilePath(e.path)) return;
      readSoon();
    });
    return () => void offFiles.then((off) => off());
  }, [workspaceId, active, readSoon]);
  const seen = useRef({ indexedHere, allSkillsOpen, workspaceIds });
  useEffect(() => {
    const was = seen.current;
    seen.current = { indexedHere, allSkillsOpen, workspaceIds };
    if (!active) return;
    // Never a loop: an index read that a read of ours caused moves it again
    // within moments, and that one is not read again.
    const indexMoved =
      was.indexedHere !== indexedHere && indexedHere !== undefined && Date.now() - lastRead.current > INDEX_RE_READ_GAP_MS;
    const backFromAllSkills = was.allSkillsOpen && !allSkillsOpen;
    if (indexMoved || backFromAllSkills || was.workspaceIds !== workspaceIds) readSoon();
  }, [indexedHere, allSkillsOpen, workspaceIds, active, readSoon]);

  // Skills hub H2 (Windows walk): leaving the team, rejoining, switching the
  // library off and a pull that moved the clone change the team rows — the
  // open page kept "In the team library 3" until the member switched views.
  // The pull record (`skills-hub://library`, the store) says when; a pull that
  // brought nothing leaves the key alone. Recorded while hidden too, so
  // becoming visible (which loads anyway) doesn't load twice.
  // H4 Windows re-walk: and every finished team read (Read it again), whose
  // pull record may not move although the rows' answers did.
  const teamKey = useSkillsHub((s) => `${teamRowsKey(s.team)}#${s.teamReads}`);
  const seenTeamKey = useRef(teamKey);
  useEffect(() => {
    if (seenTeamKey.current === teamKey) return;
    seenTeamKey.current = teamKey;
    if (active) void load();
  }, [teamKey, active, load]);

  // Skills hub H3a (Mac walk 2): a skill card that ships changes its linked
  // row — the board said "shipped" while the row still read "update
  // available" until the next load. The linked copies are read again when a
  // skill card of this board lands (recorded while hidden too, as above).
  const shippedSkills = shippedSkillCardsKey(boardCards);
  const seenShipped = useRef(shippedSkills);
  useEffect(() => {
    if (seenShipped.current === shippedSkills) return;
    seenShipped.current = shippedSkills;
    if (!active) return;
    void load();
    // H4 Windows re-walk: the board can say "shipped" a moment before the
    // checkout has the landed commit (a slow Windows checkout), and the row
    // kept "changed here and in the team library". One more read shortly
    // after catches it.
    const again = setTimeout(() => void load(), SHIP_SETTLE_MS);
    return () => clearTimeout(again);
  }, [shippedSkills, active, load]);

  const facts: Omit<SkillsInput, "silencedPairs"> | null = view
    ? {
        repository: view.skills,
        mirror: library?.branchSkillRows ?? [],
        team: solo ? [] : view.team,
        personal: personal?.skills ?? [],
        // GH #106: the skills that come with Ply. Empty on a build with no
        // bundle, and the section is then absent rather than drawn empty
        // (BOARDS.md §3).
        //
        // Each one's switch is derived here from the live settings rather than
        // taken from the read, for the reason `silencedPairs` below is: flicking
        // a toggle changes `settings.json`, and the row must follow it without a
        // reload of the bundle it cannot have changed.
        ply: ply.map((skill) => ({
          ...skill,
          on: plySkillOn(plyOff, skill.name),
          // H9: this Mac's level from the live settings too.
          switch: liveSwitch(skill.switch, plySkillOn(plyOff, skill.name)),
        })),
        plyPlace,
        shared: library?.shared ?? false,
        branch: library?.branch ?? null,
        branchReadOnly: library?.readOnly ?? false,
        branchSkills: library?.branchSkills ?? [],
        // GH #156: whether this Mac's Codex sessions get the branch's Codex
        // copies — what lights a branch-only Codex copy's chip.
        branchCodex: library?.branchCodex,
        // Group B §2 walks: a checkout copy only lagging behind the branch.
        checkoutBehind: library?.checkoutBehind,
        // Whether this Mac's Codex sessions get the team library's Codex half.
        teamCodex: solo ? null : view.teamCodex,
        pending: library?.pending ?? [],
        removedUpstream,
        // GH #144 review 1: read on every render, like `SkillDetail`'s, so a
        // removed-upstream row's age is as fresh as the paint rather than fixed
        // at the moment the refresh report arrived.
        nowMs: Date.now(),
        canPromote: solo ? false : view.canPromote,
        promotePlugin: view.promotePlugin,
        solo,
        // Skills hub H4 step 8 c: the team repo's refusal of this member, for
        // the rows' disabled Promote. Never in solo mode, never a caveat.
        promoteRefusal:
          !solo && !view.canPromote && view.promoteRefused ? view.promoteReason : null,
        // H4 Challenger step 13: and the caveat while Promote is offered.
        promoteCaveat: !solo && view.canPromote ? (view.promoteReason ?? null) : null,
        links,
        linkOffers,
        twins,
        uncommitted,
        skillCards: boardCards.filter(isSkillCard),
        // Skills hub H8 (R5): Copy to… from any Library row it can copy.
        copyTo: true,
      }
    : null;

  // Which pairs are quiet is a fact about the settings and the two copies' bytes,
  // so it is derived here on every read of either — pressing `Keep both` changes
  // the settings, and the row goes to rest without a reload of its own. Decision
  // §6: a pair whose two copies are the same whole tree is quiet too.
  const duplicates = facts ? crossScopeDuplicates(facts) : null;
  const identicalPairs = duplicates ? identicalPairKeys(duplicates, pairDigests) : EMPTY_KEYS;
  const input: SkillsInput | null =
    facts && duplicates
      ? {
          ...facts,
          identicalPairs,
          teamCopyCompared: shareComparisons(
            facts.personal.map((skill) => skill.name),
            pairDigests,
          ),
          silencedPairs: [
            ...new Set([
              ...silencedPairKeys(duplicates, pairTexts, silencedHere),
              ...identicalPairs,
            ]),
          ],
        }
      : null;

  return {
    input,
    view,
    library,
    personal,
    loading,
    generation,
    reload: () => void load(),
    noteProposal: (skill, proposal) =>
      setLinks((rows) => rows.map((row) => (row.skill === skill ? { ...row, proposal } : row))),
    pairTexts,
    identicalPairs,
    driftTexts,
    plyProblem,
    plyPlace,
    readError,
  };
}

/**
 * Every copy that is one half of a duplicate pair, with the directory it lives
 * in.
 *
 * Through `skillSections`, so "where does this scope's copy live" has one
 * definition — the rows' own `dir`, resolved to an absolute path the same way the
 * page resolves it.
 */
function duplicateCopies(
  facts: SkillsInput,
  cwd: string,
): { key: string; dir: string; dirs: string[] }[] {
  const out: { key: string; dir: string; dirs: string[] }[] = [];
  for (const section of skillSections(facts)) {
    for (const row of section.rows) {
      const dir = absoluteSkillDir(row, cwd);
      if (!row.duplicate || !dir) continue;
      // Decision §6: a repository copy in the checkout is every root it is in
      // (`.claude/skills` and `.agents/skills`), so "identical" means both.
      const checkout =
        row.scope === "repository" && !row.fromMirror
          ? facts.repository.find((skill) => skill.name === row.name)
          : undefined;
      // 1.174.2: a team copy is both its halves, for the same reason: the two
      // disagreeing have no digest, so the pair is never called identical.
      const team =
        row.scope === "team" ? facts.team.find((skill) => skill.name === row.name && skill.plugin === row.plugin) : undefined;
      const dirs = checkout?.roots.length
        ? checkout.roots.map((root) => joinPath(cwd, joinPath(root, row.name)))
        : team?.halves?.length
          ? team.halves
          : [dir];
      out.push({ key: row.key, dir, dirs });
    }
  }
  // What a share would write over, by its own key: two plugins can hold a
  // skill of this name, and their rows share a key.
  for (const skill of facts.personal) {
    const target = shareTarget(facts.team, skill.name, facts.promotePlugin);
    const dirs = target?.halves?.length ? target.halves : target?.dir ? [target.dir] : [];
    if (dirs.length > 0) out.push({ key: shareTargetKey(skill.name), dir: dirs[0], dirs });
  }
  return out;
}

/**
 * Decision §6: each copy's whole-tree digest, by row key (`skill_tree_digests`).
 * A failure is `null` for every copy — never identical — so a pair that could
 * not be read keeps its notice.
 */
async function readPairDigests(
  workspaceId: string,
  copies: { key: string; dirs: string[] }[],
): Promise<Record<string, string | null>> {
  if (copies.length === 0) return EMPTY_DIGESTS;
  try {
    const digests = await invoke<(string | null)[]>("skill_tree_digests", {
      workspaceId,
      groups: copies.map((copy) => copy.dirs),
    });
    return Object.fromEntries(copies.map((copy, i) => [copy.key, digests[i] ?? null]));
  } catch {
    return EMPTY_DIGESTS;
  }
}

/** Their `SKILL.md`, by row key. A copy Ply cannot read is simply absent. */
async function readPairTexts(
  copies: { key: string; dir: string }[],
): Promise<Record<string, string>> {
  if (copies.length === 0) return EMPTY_TEXTS;
  const read = await Promise.all(
    copies.map(async ({ key, dir }) => {
      try {
        return [key, await invoke<string>("fs_read_text_file", { path: joinPath(dir, "SKILL.md") })] as const;
      } catch {
        return null;
      }
    }),
  );
  const out: Record<string, string> = {};
  for (const entry of read) {
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

/** The two copies of one skill on the branch, as far as Ply could read them. */
type DriftPair = { claude: string | null; codex: string | null };

/** The rows whose branch copies disagree, with both directories. */
function driftPairs(facts: SkillsInput): { key: string; claudeDir: string; codexDir: string }[] {
  const out: { key: string; claudeDir: string; codexDir: string }[] = [];
  for (const section of skillSections(facts)) {
    for (const row of section.rows) {
      if (row.drift) {
        out.push({
          key: row.key,
          claudeDir: row.drift.claudeDir,
          codexDir: row.drift.codexDir,
        });
      }
    }
  }
  return out;
}

/** Their two `SKILL.md`, by row key. A copy Ply cannot read is `null`, and the
 *  comparison says so where the comparison would be. */
async function readDriftTexts(
  pairs: { key: string; claudeDir: string; codexDir: string }[],
): Promise<Record<string, DriftPair>> {
  if (pairs.length === 0) return EMPTY_DRIFT;
  const read = await Promise.all(
    pairs.map(async ({ key, claudeDir, codexDir }) => {
      const [claude, codex] = await Promise.all([
        readText(joinPath(claudeDir, "SKILL.md")),
        readText(joinPath(codexDir, "SKILL.md")),
      ]);
      return [key, { claude, codex }] as const;
    }),
  );
  return Object.fromEntries(read);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await invoke<string>("fs_read_text_file", { path });
  } catch {
    return null;
  }
}

/** Module-scoped, so the selector's fallback is the same reference every read
 *  (docs/PATTERNS.md). */
const EMPTY_REMOVED: SkillsInput["removedUpstream"] = [];
/** …and so a workspace with no duplicates never hands out a new object. */
const EMPTY_TEXTS: Record<string, string> = {};
const EMPTY_DIGESTS: Record<string, string | null> = {};
const EMPTY_KEYS: readonly string[] = [];
/** …and so a Mac with no bundled skills hands out one list, not a new one per
 *  read (GH #106). */
const EMPTY_PLY: PlySkill[] = [];
const EMPTY_LINKS: SkillLinkRow[] = [];

/** When the rows are read once more after a skill card shipped. */
const SHIP_SETTLE_MS = 1500;

/** How long a burst of file changes settles before the page reads again. */
const SKILL_FILES_SETTLE_MS = 400;
/** H8: an All skills read within this long of the Library's own is not a
 *  reason to read again. */
const INDEX_RE_READ_GAP_MS = 3000;

/** H4 Mac walk: a path inside a repository skill root (`.claude/skills/…`,
 *  `.agents/skills/…`), on either separator — the files a linked row is
 *  judged from. (The link records under `.atelier/` reach the page through
 *  a skill card landing.) */
export function isSkillFilePath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  // A card's own copy of the repository (`.plyloft-worktrees/<card>/…`) is
  // not the checkout: making a skill card wrote a whole tree of it, and each
  // file read the page again (H4 Windows walk).
  if (/(^|\/)\.(plyloft|atelier)-worktrees\//.test(p)) return false;
  return /(^|\/)\.claude\/skills\//.test(p) || /(^|\/)\.agents\/skills\//.test(p);
}
const EMPTY_OFFERS: SkillLinkOffer[] = [];
const EMPTY_TWINS: SkillTwinRow[] = [];
const EMPTY_NAMES: string[] = [];

/** The skill cards of a board that have shipped, as one key — it moves when
 *  one more lands. */
export function shippedSkillCardsKey(cards: readonly KanbanCard[]): string {
  return cards
    .filter((card) => card.kind?.type === "skill" && (card.shipStatus === "shipped" || card.reviewStatus === "merged"))
    .map((card) => card.id)
    .sort()
    .join("\u0000");
}
const EMPTY_CARDS: KanbanCard[] = [];
const EMPTY_DRIFT: Record<string, DriftPair> = {};
