import { Fragment, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CBtn,
  Details,
  EmptyState,
  ErrorBlock,
  Group,
  PageHeader,
  SearchField,
  Section,
  StatusLine,
} from "../ux";
import { SkillRow } from "./SkillRow";
import { plainFailure } from "../../lib/plainError";
import type { Failure } from "../../lib/failure";
import { SkillDetail } from "./SkillDetail";
import { PromoteFlow, type PromoteChoice } from "./PromoteFlow";
import { ShareAskingFlow } from "./ShareAskingFlow";
import { AlignFlow, type AlignChoice } from "./AlignFlow";
import { ScriptApprovalFlow, type InstallSheet } from "./ScriptApprovalFlow";
import { LinkCompareFlow, type LinkCompareChoice } from "./LinkCompareFlow";
import { ThreeWayCompareFlow, type BothChangedChoice } from "./ThreeWayCompareFlow";
import { LinkDecisionFlow, type LinkDecision } from "./LinkDecisionFlow";
import { useInbox } from "../../store/inboxStore";
import type { SkillsData } from "./useSkillsData";
import {
  MAKE_ALL_BOTH_LABEL,
  PLY_RETRY_LABEL,
  SCOPE_NAV_LABEL,
  sectionCount,
  SECTION_TITLE,
  SKILLS_LEDE,
  THIS_MAC_NOTE,
  THIS_MAC_NOTE_SOLO,
  filterPlaceholder,
  plySectionProblem,
  absoluteSkillDir,
  duplicatePairKey,
  filterSkillRows,
  ignoredRootsLine,
  ignoredSkillRoots,
  makeAllBoth,
  linkAll,
  oneCliLine,
  scopeCounts,
  skillSections,
  unpublishConfirmBody,
  unpublishToastBody,
  alreadyCurrentToast,
  ALREADY_IN_TEAM_REASON,
  branchIdOf,
  branchReachOf,
  isAlignFirst,
  isSignInRefusal,
  publishToastBody,
  ShownBranchIds,
  type CompareAction,
  type ScopeFilter,
  type SkillMenuEntry,
  type SkillPageAction,
  type SkillRow as SkillRowModel,
} from "../../lib/librarySkills";
import { withSilenced, type DuplicateIdentity } from "../../lib/libraryMute";
import {
  readOnlyLine,
  skillFileMode,
  WRITABLE,
  type FileOpenMode,
} from "../../lib/readOnlyFile";
import { plySkillSwitchedIn } from "../../lib/plySkills";
import type { Scope } from "../../lib/uxScope";
import { skippedLines } from "../../lib/sharedLibrary";
import {
  asNotTheSameSkill,
  installToastBody,
  linkAndUpdateConfirmBody,
  promoteToastBody,
  replaceConfirmBody,
} from "../../lib/projectSkills";
import {
  LINK_ALL_LABEL,
  PROPOSE_UPSTREAM_LABEL,
  TAKE_UPSTREAM_LABEL,
  alignMadeBody,
  choiceLines,
  isScriptsWait,
  linkAllLine,
  linkMadeBody,
  openSkillCard as openSkillCardOf,
  proposedToastBody,
  skillCardReach,
  unloadableNotice,
} from "../../lib/skillCards";
import { askTheBuilder } from "./askTheBuilder";
import { ASK_BUILDER, bringBranchPrompt } from "../../lib/askBuilder";
import { carryNewerOn } from "../../lib/skillCards";
import { SHIP_WITH_CARD_LABEL } from "../../lib/librarySkills";
import { useKanban } from "../../store/kanbanStore";
import { showPlanRefusal } from "../../store/planPrompts";
import { ConfirmDialog } from "../ConfirmDialog";
import { TeamLibraryPullLine } from "../TeamLibraryPull";
// GH #215: the gitignored root's fix, the one Diagnostics and the Doctor offer.
import { useSkillRootIgnoreFix } from "../SkillRootIgnoreFix";
// GH #104: the Challenger's one suggested change, on its target's page.
import { ProposalBlock } from "./ProposalBlock";
// Group B decision §3: `New skill…`, in the repository, for both CLIs.
import { NewSkillFlow } from "./NewSkillFlow";
import { createdToast, newSkillIgnoredRoots } from "../../lib/newSkill";
import { proposalIsFor, proposalTarget } from "../../lib/proposals";
import { useProposal } from "../../store/proposalStore";
// GH #102: the errors that stay on this page until their condition is gone.
import { LibraryErrorBlocks } from "../errors/LibraryErrorBlocks";
import { skillsReadError } from "../../lib/uxError";
import {
  personalSkillPromote,
  personalSkillReveal,
  projectSkillCreate,
  skillsHubInstall,
  skillsHubInstallReview,
  skillsHubUpdate,
  skillsHubCompare,
  skillsHubCompare3,
  skillsHubKeepMine,
  skillsHubProposeUpstream,
  skillsHubRemovedChoice,
  skillsHubRenamedChoice,
  skillsHubLink,
  skillsHubAlign,
  skillsHubCarry,
  openWebLink,
  type Compare3,
  type LinkCompare,
  type PromotePullRequest,
  type KanbanCard,
  projectSkillPromote,
  projectSkillAlign,
  projectSkillPublish,
  projectSkillPublishReview,
  knowledgeProjectState,
  projectSkillsAvailableToBoth,
  projectSkillUnpublish,
  projectSkillUnpublishUndo,
  type SkillRemovalUndo,
  teamSkillRemove,
  workspaceDefinitionOpenPullRequest,
  plySkillPersonalize,
  plySkillSetting,
} from "../../ipc";
// Skills hub H9 (R9): Personalize, and a Plyloft skill's switch per level.
import { PersonalizeFlow } from "./PersonalizeFlow";
import type { WorkspaceChoice } from "./PlySwitchSection";
import { askOwnerSentence } from "../../lib/plySkillSwitch";
import { qualifiedSkillName, removeConfirmBody, removeToastBody } from "../../lib/teamSkills";
import { useEditor } from "../../store/editorStore";
import { openCardStep, openCenterMode } from "../../store/uiStore";
import { useLibrary } from "../../store/libraryStore";
import { useSettings } from "../../store/settingsStore";
import { useSetup } from "../../store/setupStore";
import { GH_SIGN_IN_ACTION } from "../../lib/ghTrouble";
import { useSolo } from "../../store/workModeStore";
import { pushToast, type Toast } from "../../store/toastStore";
import { openCopyTo, refreshAllSkillsFor, refreshAllSkillsLibraries } from "../../store/allSkillsStore";
import { MyLibrarySection, matchesFilter, useMyLibrarySkills } from "./MyLibrarySection";
import { ALSO_IN_MY_LIBRARY } from "../../lib/myLibrary";
import { machineWords, platformWord } from "../../lib/platform";
import { joinPath } from "../../lib/paths";
import { linkDidNotOpen } from "../../lib/linkToast";
import { pushErrorToast } from "../../lib/errorToast";

/**
 * UX language card 4 (GH #96; BOARDS.md §3, Board 2): the Library's Skills
 * page — title, lede, one filter over every scope, then the four sections in
 * order.
 *
 * **One scroll for every row.** The page is a `Page` (PATTERNS.md §2) and
 * nothing inside it scrolls on its own, at 34 rows or at 400: the defect #82's
 * Tier 4 found three times in one morning was a list that clipped.
 */
export function SkillsPage({
  workspaceId,
  cwd,
  data,
  controls,
  visible = true,
}: {
  workspaceId: string;
  cwd: string;
  /** This workspace's Library is what the window shows. */
  visible?: boolean;
  /** Read by the host, so one open is one fetch. */
  data: SkillsData;
  /** The narrow centre's page and scope choices, which sit under the lede. */
  controls?: ReactNode;
}) {
  const { input, view, library, personal, loading, generation, pairTexts, driftTexts, reload, plyPlace } =
    data;
  // GH #106 review 1: why the skills that come with Ply reach nothing, when they
  // reach nothing. Under that heading only, and only when there is a fault.
  const plyProblem = data.plyProblem;
  const state = useLibrary((s) => s.byWorkspace[workspaceId]);
  // OB-9 (§10 row 5): no Team scope in solo mode; a filter left on it shows all.
  const solo = useSolo();
  const chosenScope: ScopeFilter = state?.scope ?? "all";
  const scope: ScopeFilter = solo && chosenScope === "team" ? "all" : chosenScope;
  const filter = state?.filter ?? "";
  const openKey = state?.openSkill ?? null;
  const compare = state?.compare ?? null;
  const flow = state?.flow ?? null;
  const flowKey = flow?.key ?? null;
  /** A copy that would overwrite somebody's bytes, waiting to be asked about. */
  const [confirming, setConfirming] = useState<{
    row: SkillRowModel;
    what: "install" | "promote-to-team" | "promote-repository" | "promote-team";
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Publish-sheet walk: what the busy row's `⋯` press is doing, said on the
   *  row (`Reading its files…`, `Publishing…`). */
  const [busyLine, setBusyLine] = useState<string | null>(null);
  /** Skills hub H3a: a linked copy's 2-way Compare, while it is open. */
  const [linkCompare, setLinkCompare] = useState<{
    key: string;
    name: string;
    data: LinkCompare | null;
    error: string | null;
  } | null>(null);
  /** Skills hub H4 (R3): the 3-way Compare of a copy changed on both sides. */
  const [threeWay, setThreeWay] = useState<{
    key: string;
    name: string;
    data: Compare3 | null;
    error: string | null;
  } | null>(null);
  /** Skills hub H4 (R8): a removal or a rename upstream, being answered. */
  const [deciding, setDeciding] = useState<{
    row: SkillRowModel;
    kind: "removed" | "renamed";
    originWords: string;
    renamedTo: string | null;
    modified: boolean;
  } | null>(null);
  /**
   * Skills hub H6b (R15): the Install-time sheet this page opened, and what
   * its OK makes. Tied to the very flow it opened (`flow`), so the H6a sheet
   * opened from a row or the Inbox for the same skill is never read as it.
   */
  const [scriptsThen, setScriptsThen] = useState<{
    flow: NonNullable<typeof flow>;
    plugin: string;
    sheet: InstallSheet;
  } | null>(null);
  /** UX-9.5: a team skill waiting for `Remove from Team…` to be confirmed. */
  const [removing, setRemoving] = useState<SkillRowModel | null>(null);
  /** …and a repository skill waiting for `Remove from <branch>…`: it reaches
   *  every colleague, so it asks as the team's does. */
  const [unpublishing, setUnpublishing] = useState<SkillRowModel | null>(null);
  /** Group B §2 review 1: the branch's id of each skill as the row showed it
   *  when `Remove` or `Align` was opened — the base the change is judged by, so
   *  a refresh while the dialog is open cannot make a teammate's edit the base. */
  const shownIds = useRef(new ShownBranchIds());
  function openAlign(row: SkillRowModel) {
    shownIds.current.opened("align", row.key, branchIdOf(input, row.name));
    useLibrary.getState().setFlow(workspaceId, { kind: "align", key: row.key });
  }
  /** `Compare` opened (or closed) on a row: the version it shows is recorded
   *  now, for an `Align` or `Remove` pressed from inside it (review 2). */
  function setCompare(row: SkillRowModel | null, what?: "reach") {
    if (row) {
      shownIds.current.compareOpened(row.key, branchIdOf(input, row.name));
      useLibrary.getState().setCompare(workspaceId, row.key, what);
    } else {
      shownIds.current.compareClosed(null);
      useLibrary.getState().setCompare(workspaceId, null);
    }
  }
  // `Keep both` lives in settings.json, per Mac (ADR 0005). A plain array off
  // the store, not a derived object: a selector that built one would give a new
  // reference on every settings read (docs/PATTERNS.md).
  const silencedHere = useSettings((s) => s.settings.library.silencedDuplicates);
  // Round 2 (G3): what the Share page showed, by row, until its press is sent.
  const shownAsks = useRef<Record<string, string | null>>({});
  // 1.175.0 B1: the Share page names the team's repository.
  const teamRepo = useSettings((s) => s.settings.team?.teamRepo?.trim() || null);
  // GH #104: read, never derived here — one slice off the store, so a selector
  // cannot hand back a new object on every settings read (docs/PATTERNS.md).
  const proposal = useProposal((s) => s.byWorkspace[workspaceId]?.view) ?? null;
  const proposalBusy = useProposal((s) => s.byWorkspace[workspaceId]?.loading) ?? false;

  const sections = input ? skillSections(input) : [];
  // 1.174.0 (X3): My library, read-only, from All skills' index.
  const mineRows = useMyLibrarySkills();
  const counts = scopeCounts(sections, mineRows.length);
  const all = sections.flatMap((s) => s.rows);
  const open = all.find((r) => r.key === openKey) ?? null;
  /** The open skill's other copy, by row key, for the texts read once above. */
  const twinKey =
    open?.duplicate ? `${open.duplicate.other}:${open.name}` : null;
  // Decision §6: the open skill's two copies are the same whole tree, so its
  // page has no notice to show (the chip stays).
  const openIdentical =
    open?.duplicate != null &&
    data.identicalPairs.includes(duplicatePairKey(open.scope, open.duplicate.other, open.name));
  const inFlow = all.find((r) => r.key === flowKey) ?? null;
  const promoting = flow?.kind === "promote" ? inFlow : null;
  const aligning = flow?.kind === "align" ? inFlow : null;
  // Skills hub H6a: the *Needs your OK* sheet of a team skill.
  // H6b: the Install-time sheet this page opened, on a team row (Install) or
  // a linked repository row (Update, Take upstream).
  const installSheet = flow != null && scriptsThen?.flow === flow ? scriptsThen.sheet : null;
  const reviewing =
    flow?.kind === "scripts" && (inFlow?.scope === "team" || (installSheet && inFlow)) ? inFlow : null;
  // Owner, 2026-10-19: the scripts sheet before Publish to <branch>, opened
  // from the row or from a refused publish elsewhere (LocalBranchBlock).
  const publishing = flow?.kind === "publish" && inFlow?.scope === "repository" ? inFlow : null;
  const creating = flow?.kind === "new-skill";
  // Skills hub H9: Personalize, opened from a Plyloft skill's page.
  const personalizing = flow?.kind === "personalize" && inFlow?.scope === "ply" ? inFlow : null;
  /** Why the last `Create` was refused, in the backend's words (decision §3). */
  const [newSkillRefusal, setNewSkillRefusal] = useState<Failure | null>(null);
  const branch = library?.branch ?? "the integration branch";
  const ignoredRoots = ignoredSkillRoots(view?.skills ?? []);
  // GH #215: owned here, not by the section's block, so the outcome sentence
  // outlives the block: a fix that worked takes the roots — and the block —
  // away on the re-read it asks for, which is exactly when the note is news.
  const ignoreFix = useSkillRootIgnoreFix({ workspaceId, status: view, onChecked: reload });

  // ── The one action and the ⋯, per row ─────────────────────────────────

  async function run(
    key: string,
    what: string,
    work: () => Promise<void>,
    /** What to ask about, when the refusal is a Replace nobody asked for. */
    replaceable?: NonNullable<typeof confirming>,
  ) {
    setBusy(key);
    try {
      await work();
    } catch (cause) {
      // A copy Ply refused because the destination holds different bytes:
      // `project_skills::copy_into` rejects with the `NotTheSameSkill` value
      // and writes nothing. The CopyState the row was drawn from was read
      // before the press, so a race lands here too — and either way the way
      // out is the same one the Project panel offered: ask, then pass
      // `replace` (review 1).
      const refused = asNotTheSameSkill(cause);
      if (replaceable && refused) {
        setConfirming(replaceable);
        return;
      }
      const message = refused?.message ?? String((cause as Error)?.message ?? cause);
      // Skills hub H3a (Challenger): a skill whose scripts wait for this
      // Mac's OK is never put in a card — the toast opens the team row's
      // *Needs your OK* sheet the refusal names.
      const skill = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
      // H5 (Challenger): the toast's Align only where the row can align — by
      // card (`twins`) or on the shared branch (`drift`). A difference only
      // in this checkout, or a shared workspace whose branch copies agree,
      // has none: an Align there would open nothing.
      const alignable = all.find((r) => r.key === `repository:${skill}` && (r.twins || r.drift));
      // QoL 1.168 block 8 (A5): a refusal in plain words is the line; raw
      // text is put in plain words and waits behind Details.
      const said = plainFailure(message);
      pushToast({
        kind: "error",
        title: what,
        body: said.sentence,
        ...(said.details ? { details: said.details } : {}),
        // H4 Challenger step 13: a share git couldn't sign in for offers the
        // way out Settings › Team's sign-in row offers — Setup › GitHub, as
        // the team's account. An action toast stays until dismissed.
        action: isSignInRefusal(message)
          ? {
              label: GH_SIGN_IN_ACTION,
              onClick: () =>
                useSetup.getState().openSetup("rerun", "github", {
                  githubAccount: useSettings.getState().settings.team?.account?.trim() || null,
                }),
            }
          : isScriptsWait(message)
          ? {
              label: "Review",
              onClick: () =>
                useLibrary.getState().setFlow(workspaceId, { kind: "scripts", key: `team:${skill}` }),
            }
          : // Skills hub H5 (R12): a choice that waits for the two copies to
            // be one skill offers the Align it waits for.
            isAlignFirst(message) && alignable
            ? {
                label: "Align",
                onClick: () => {
                  setThreeWay(null);
                  setLinkCompare(null);
                  alignRow(alignable);
                },
              }
            : undefined,
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * One path becomes one editor tab — the page's only way into Code, for the
   * `⋯`, for `Edit in Code` and for the sub-page's file rows alike.
   *
   * GH #142: `mode` is what the tab is. It comes from `skillFileMode`, the one
   * rule, applied to the row the press came from — never re-derived here, and
   * never from the path, which is how #96 review 1's second derivation offered
   * to save into the team clone. A writable open is `WRITABLE` and says so.
   *
   * The path itself is Rust's: every scope's `dir` is read by the backend that
   * listed the skill (`personal_skills`, `team`, the mirror's manifest), and the
   * checkout's is the repo-relative root under `cwd`. The window composes the
   * file name onto it and invents nothing.
   */
  async function openInCode(path: string, mode: FileOpenMode) {
    const content = await invoke<string>("fs_read_text_file", { path });
    const opened = useEditor
      .getState()
      .open(
        workspaceId,
        path,
        content,
        mode.readOnly
          ? { place: mode.place, line: readOnlyLine(mode.place, library?.branch ?? null) }
          : null,
      );
    openCenterMode(workspaceId, "code");
    // GH #174 review 1: a dirty writable tab of this path came forward instead
    // of a reading view; the caller's `run` toasts why.
    if (!opened.opened) throw new Error(opened.reason);
  }

  /**
   * `Publish to <branch>` / `Update on <branch>`: the publish and its toast.
   * `scriptsOk`: the ids the scripts sheet's OK sent (owner, 2026-10-19).
   * Rejects with the backend's words, so the sheet can re-read on a refusal
   * that names scripts.
   */
  async function publishRow(row: SkillRowModel, scriptsOk?: string[]) {
    const done = await projectSkillPublish(workspaceId, row.name, scriptsOk);
    // Owner, 2026-10-19: the push runs before this returns, so the toast
    // says what it did. `queued` only when it truly waits (offline, a
    // retry) — the row says when it lands. A pull request or a refusal
    // already has the drain's own toast, and a second would replace it.
    const outcome = done?.outcome ?? "queued";
    if (outcome === "said") return;
    // Owner-fixes Windows walk: the branch already held it — nothing was
    // committed, and nothing waits, so it is not "queued".
    if (outcome === "current") {
      pushToast({ kind: "info", ...alreadyCurrentToast(row.name, branch) });
      return;
    }
    pushToast({
      kind: "info",
      title:
        outcome === "published" ? `Published ${row.name} to ${branch}` : `${row.name} is queued for ${branch}`,
      // GH #105: every copy this checkout has travels together, and a copy
      // on the branch this checkout does not have is left alone. Group B §2
      // walk: an unedited copy follows the edited one.
      body: publishToastBody(done?.follows),
    });
  }

  /** Owner, 2026-10-19 (R15): the scripts sheet before a publish that brings
   *  a new or changed script. `true`: it is open, and its OK publishes. */
  async function publishSheetFirst(row: SkillRowModel): Promise<boolean> {
    let review;
    try {
      review = await projectSkillPublishReview(workspaceId, row.name);
    } catch {
      // The publish's own refusal says why.
      return false;
    }
    if (!review) return false;
    openPublishSheet(row);
    return true;
  }

  /** `⋯` › Publish to <branch> / Update on <branch>. The row says what the
   *  press is doing while it reads and while it publishes (publish-sheet
   *  walk: a greyed `⋯` alone read as a press that did nothing). */
  async function publishFromMenu(row: SkillRowModel) {
    setBusyLine("Reading its files…");
    // Walk F4 (review): read now, not from the page's snapshot — an edit
    // made in Code or by an agent since the page loaded must still publish.
    const fresh = await knowledgeProjectState(workspaceId);
    if ((fresh.currentInCheckout ?? []).includes(row.name)) {
      pushToast({ kind: "info", ...alreadyCurrentToast(row.name, branch) });
      return;
    }
    // Owner, 2026-10-19 (R15): a publish that brings a new or changed
    // script reaches teammates with no card, so its files are shown
    // first; a text-only one goes straight away, as before.
    if (await publishSheetFirst(row)) return;
    setBusyLine("Publishing…");
    try {
      await publishRow(row);
    } catch (cause) {
      // The copy or the branch changed since the read: the sheet.
      if (isScriptsWait(errorWords(cause))) {
        openPublishSheet(row);
        return;
      }
      throw cause;
    }
  }

  function openPublishSheet(row: SkillRowModel) {
    useLibrary.getState().setFlow(workspaceId, { kind: "publish", key: row.key });
  }

  function onMenu(row: SkillRowModel, entry: SkillMenuEntry) {
    if (entry === "divider") return;
    // QoL block 13: the ways out of a git step (13.1, 13.2, 13.4).
    if (entry.id === "ship-with-card") {
      shipWithCard(row.name, row.key);
      return;
    }
    if (entry.id === "ask-builder") {
      askTheBuilder(workspaceId, cwd, entry.prompt);
      return;
    }
    if (entry.id === "open-card") {
      openCardStep(workspaceId, entry.cardId, "outcome");
      return;
    }
    // Skills hub H8 (R5): Copy to…, over All skills.
    if (entry.id === "copy-to") {
      if (row.scope === "repository") openCopyTo({ kind: "workspace", workspaceId, skill: row.name });
      else if (row.scope === "team") openCopyTo({ kind: "team", plugin: row.plugin ?? "", skill: row.name });
      else if (row.scope === "this-mac") openCopyTo({ kind: "thisMac", skill: row.name });
      return;
    }
    if (entry.id === "open-in-code") {
      const dir = absoluteSkillDir(row, cwd);
      if (!dir) return;
      const path = joinPath(dir, "SKILL.md");
      void run(row.key, "Couldn't open the skill in Code", () =>
        openInCode(path, skillFileMode(row)),
      );
      return;
    }
    if (entry.id === "publish-to-branch") {
      void run(row.key, "Couldn't publish the skill", async () => {
        try {
          await publishFromMenu(row);
        } finally {
          setBusyLine(null);
        }
      });
      return;
    }
    if (entry.id === "remove-from-branch") {
      // From the `⋯` and from Compare alike: asked first, then `unpublish`.
      shownIds.current.opened("remove", row.key, branchIdOf(input, row.name));
      setUnpublishing(row);
      return;
    }
    if (entry.id === "compare") {
      setCompare(row);
      return;
    }
    if (entry.id === "compare-reach") {
      setCompare(row, "reach");
      return;
    }
    if (entry.id === "compare-link") {
      compareLink(row);
      return;
    }
    if (entry.id === "compare3") {
      // Owner-fixes walk: Both changed's Compare with the library is the
      // 3-way one, from the `⋯` too.
      setLinkCompare(null);
      compareThree(row);
      return;
    }
    if (entry.id === "make-available-to-both") {
      void availableToBoth([row.name], row.key);
      return;
    }
    if (entry.id === "align") {
      // The choice is the question, so it is a flow, not a menu of two entries
      // (PATTERNS.md §6): `Align` opens it and the flow makes one commit.
      alignRow(row);
      return;
    }
    if (entry.id === "install") {
      if (entry.confirm) {
        setConfirming({ row, what: "install" });
        return;
      }
      void install(row, false);
      return;
    }
    if (entry.id === "remove-from-team") {
      // H4 step 8 c: shown off with GitHub's refusal; never pressed.
      if ("disabled" in entry) return;
      setRemoving(row);
      return;
    }
    if (entry.id === "promote-to-team") {
      // F4: shown off with its reason; never pressed.
      if ("disabled" in entry) return;
      // A personal skill never has this entry — it is read-only, and its one
      // action is the Promote flow, which asks where. Only a repository skill
      // gets here, and for it the destination is the team library.
      // 1.175.0 B1: a skill whose text asks to run things never goes at
      // once — the Share page says what it asks and whose OK this is.
      if (row.asks) {
        useLibrary.getState().setFlow(workspaceId, { kind: "promote", key: row.key });
        return;
      }
      if (entry.confirm) {
        setConfirming({ row, what: "promote-to-team" });
        return;
      }
      void promoteToTeam(row, false);
    }
  }

  /** B1: the Share page's press for a repository skill — the Replace
   *  question first when the team already holds another copy, as its menu
   *  entry would have asked. */
  function shareAsking(row: SkillRowModel) {
    useLibrary.getState().setFlow(workspaceId, null);
    // Round 2 (G3): the id of the text the page showed goes with the press;
    // this Mac's OK is recorded for those bytes only.
    shownAsks.current[row.key] = row.asksId ?? null;
    const replaces = row.menu.some((e) => typeof e === "object" && e.id === "promote-to-team" && "confirm" in e && e.confirm === true);
    if (replaces) setConfirming({ row, what: "promote-to-team" });
    else void promoteToTeam(row, false);
  }

  /**
   * Group B decision §3: `New skill…`'s `Create`. The backend writes the same
   * `SKILL.md` into `.claude/skills/<name>` and `.agents/skills/<name>` in the
   * checkout; then the page re-reads, the flow closes and Claude's copy opens in
   * Code, where the text is written (ADR 0005). A refusal stays in the flow,
   * which is where the member can act on it.
   */
  async function createSkill(name: string, description: string) {
    setBusy(NEW_SKILL_KEY);
    setNewSkillRefusal(null);
    try {
      const created = await projectSkillCreate(workspaceId, name, description);
      reload();
      useLibrary.getState().setFlow(workspaceId, null);
      pushToast({ kind: "info", ...createdToast(created.name), action: shipAction(created.name) });
      try {
        await openInCode(created.claudeFile, WRITABLE);
      } catch (cause) {
        pushErrorToast("Couldn't open the skill in Code", cause);
      }
    } catch (cause) {
      setNewSkillRefusal(plainFailure(cause));
    } finally {
      setBusy(null);
    }
  }

  /** `Remove from <branch>…`, once the member has said yes. */
  function unpublish(row: SkillRowModel) {
    const reach = branchReachOf(input, row.name);
    return run(row.key, "Couldn't remove the skill", async () => {
      const shown = shownIds.current.take("remove", row.key);
      await projectSkillUnpublish(workspaceId, row.name, shown);
      pushToast({
        kind: "info",
        title: `Removing ${row.name} from ${branch}`,
        // Every copy (GH #105): half a skill left on the branch goes on
        // being loaded by the CLI whose root still has it. Named from the
        // branch's own reach, so a Claude-only skill says Claude (walk F2).
        body: unpublishToastBody(reach),
        // 1.169.0 (C4): the removal waits 10 s on this Mac before it goes to
        // the branch (commands::SKILL_REMOVAL_UNDO); Undo takes it back.
        action: {
          label: "Undo",
          ttlMs: SKILL_REMOVAL_UNDO_MS,
          onClick: () => void undoUnpublish(row.name),
        },
      });
    });
  }

  /** C4: `Undo` on the removal's toast. */
  async function undoUnpublish(name: string) {
    try {
      const found = await projectSkillUnpublishUndo(workspaceId, name);
      reload();
      pushToast(undoRemovalToast(found, name, branch));
    } catch (cause) {
      const said = plainFailure(cause);
      pushToast({
        kind: "error",
        title: "Couldn't undo the removal",
        body: said.sentence,
        ...(said.details ? { details: said.details } : {}),
      });
    }
  }

  /** UX-9.5: what Settings › Team's `Remove from team` did, from the row. */
  function removeFromTeam(row: SkillRowModel) {
    const skill = { plugin: row.plugin ?? "", name: row.name };
    return run(row.key, "Couldn't remove the skill", async () => {
      const done = await teamSkillRemove(skill.plugin, skill.name);
      reload();
      // The counts that held it: the sidebar's All skills and Inbox, read here
      // from the clone (the Inbox's GitHub answers stay in their own cache).
      refreshAllSkillsLibraries();
      void useInbox.getState().refreshAfterChange();
      pushToast({
        kind: done.pushed ? "info" : "warn",
        title: `${qualifiedSkillName(skill)} removed from the team library`,
        body: removeToastBody(done),
      });
    });
  }

  function promoteToTeam(row: SkillRowModel, replace: boolean) {
    return run(
      row.key,
      "Couldn't share the skill",
      async () => {
        let done: Awaited<ReturnType<typeof projectSkillPromote>>;
        try {
          const shown = shownAsks.current[row.key] ?? null;
          delete shownAsks.current[row.key];
          done = await projectSkillPromote(workspaceId, row.name, replace, shown);
          reload();
        } catch (cause) {
          // H4 step 8 c (Challenger): a push GitHub refused as read-only is
          // remembered by the backend; read again, the row's Promote is off
          // with that reason instead of offered once more.
          reload();
          throw cause;
        }
        // Skills hub H4 (R7): never over a teammate's change — a pull request.
        if (done.pullRequest) {
          pullRequestToast(row.name, done.pullRequest);
          return;
        }
        refreshAllSkillsLibraries();
        pushToast({
          kind: "info",
          title: done.committed
            ? `${row.name} shared with the team`
            : `${row.name} was already in the team library`,
          body: promoteToastBody(done),
        });
      },
      replace ? undefined : { row, what: "promote-to-team" },
    );
  }

  /**
   * Skills hub H3a (R2, §14 Q1): Install makes a skill card — its one commit
   * holds both copies and the link record — and opens it at Ship. Only a
   * folder that is not a git repository is written straight into.
   */
  function install(row: SkillRowModel, replace: boolean) {
    const plugin = row.plugin ?? "";
    const perform = async (scriptsOk?: string[]) => {
      const done = await skillsHubInstall(workspaceId, plugin, row.name, replace, scriptsOk);
      reload();
      if (done.kind === "written") {
        // GH #227 review 1: the toast says what git answered for each root —
        // ignored, or no answer — before promising a card ships them.
        pushToast({
          kind: "info",
          title: `${row.name} installed`,
          body: installToastBody(done.copied),
        });
        return;
      }
      await openSkillCard(done.card);
    };
    return run(
      row.key,
      "Couldn't install the skill",
      async () => {
        if (await scriptsSheetFirst(row, "install", plugin, perform)) return;
        try {
          await perform();
        } catch (cause) {
          // H6b: the pull before the card brought a script: the sheet.
          if (isScriptsWait(errorWords(cause)) && (await scriptsSheetFirst(row, "install", plugin, perform))) return;
          throw cause;
        }
      },
      replace ? undefined : { row, what: "install" },
    );
  }

  /**
   * Skills hub H6b (R15 AC 1): before Install or Update writes a library
   * skill's files into the repository, the Install-time sheet — every file,
   * scripts first — when it brings a script or an extra file the repository
   * doesn't hold yet. `true`: the sheet is open, and its OK runs `perform`
   * with the scripts ids it showed. `false`: nothing to ask (or the sheet
   * couldn't be read — the action's own refusal then says why).
   */
  async function scriptsSheetFirst(
    row: SkillRowModel,
    verb: "install" | "update",
    plugin: string,
    perform: (scriptsOk?: string[]) => Promise<void>,
  ): Promise<boolean> {
    let review;
    try {
      review = await skillsHubInstallReview(workspaceId, plugin, row.name, verb);
    } catch {
      return false;
    }
    if (!review) return false;
    const opened = { kind: "scripts" as const, key: row.key };
    setScriptsThen({
      flow: opened,
      plugin,
      sheet: {
        workspaceId,
        verb,
        onConfirm: async (scriptsOk) => {
          try {
            await perform(scriptsOk);
          } catch (cause) {
            if (showPlanRefusal(cause)) return;
            throw new Error(errorWords(cause));
          }
        },
      },
    });
    useLibrary.getState().setFlow(workspaceId, opened);
    return true;
  }

  /** The skill card just made, and the toast that says who gets it and when
   *  (R18.4). QoL 13.4 (G12): the Library stays on screen — installing
   *  several skills keeps its place — and the toast's Open card, like the
   *  row's, opens the card at its Ship step. */
  async function openSkillCard(card: KanbanCard, body?: string) {
    await useKanban.getState().loadFromDisk(workspaceId, true);
    pushToast({
      kind: "info",
      title: `Card made: ${card.title}`,
      body: body ?? skillCardReach(card),
      action: { label: "Open card", onClick: () => openCardStep(workspaceId, card.id, "outcome") },
    });
  }

  /**
   * QoL 13.1 (G5): **Ship it with a card** — a skill card carrying the skill
   * as it is in the project folder, opened at its Ship step (shipping is
   * what was asked for). A card already carrying it is opened instead of a
   * second one.
   */
  function shipWithCard(name: string, key: string) {
    const open = openSkillCardOf(useKanban.getState().byWorkspace[workspaceId]?.cards ?? [], name);
    if (open) {
      openCardStep(workspaceId, open.id, "outcome");
      return;
    }
    void run(key, "Couldn't make the card", async () => {
      let card: KanbanCard;
      try {
        card = await skillsHubCarry(workspaceId, name);
      } catch (cause) {
        // Challenger (block 13): the target has a newer copy than the
        // folder's last commit — the card would revert it. The way out is
        // the Builder, bringing it here first.
        const words = errorWords(cause);
        const newer = carryNewerOn(words);
        if (newer === null) throw cause;
        pushToast({
          kind: "warn",
          title: `${name} wasn't put in a card`,
          body: `${newer} has a newer ${name}. Bring it into your project folder first, then ship it with a card. Nothing was changed.`,
          details: words,
          action: { label: ASK_BUILDER, onClick: () => askTheBuilder(workspaceId, cwd, bringBranchPrompt(newer, name)) },
        });
        return;
      }
      reload();
      await useKanban.getState().loadFromDisk(workspaceId, true);
      openCardStep(workspaceId, card.id, "outcome");
      pushToast({ kind: "info", title: `Card made: ${card.title}`, body: skillCardReach(card) });
    });
  }

  /** 13.1: the toast action every "it's in your project folder" toast
   *  carries. */
  function shipAction(name: string) {
    return { label: SHIP_WITH_CARD_LABEL, onClick: () => shipWithCard(name, `repository:${name}`) };
  }

  /**
   * Skills hub H3b (R-M): **Link** (one row) and **Link all** (the section) —
   * one skill card whose commit writes link records only, for copies that
   * already equal a version of the team library. Free on every plan (§9).
   * What it couldn't link is named, with why.
   */
  function link(names: string[], key: string) {
    void run(key, names.length > 1 ? "Couldn't link the skills" : "Couldn't link the skill", async () => {
      const done = await skillsHubLink(workspaceId, names);
      reload();
      // Challenger (H3b): one toast — a second one for the skipped skills
      // would replace the card's own (toasts show one at a time).
      await openSkillCard(done.card, linkMadeBody(done.card, done.skipped));
    });
  }

  /** Skills hub H3a: Update a linked copy. */
  function update(row: SkillRowModel) {
    const plugin = linkOf(row)?.plugin ?? "";
    const perform = async (scriptsOk?: string[]) => {
      const card = await skillsHubUpdate(workspaceId, row.name, false, scriptsOk);
      reload();
      await openSkillCard(card);
    };
    void run(row.key, "Couldn't update the skill", async () => {
      try {
        // H6b: a new or changed script waits for the Install-time sheet.
        if (await scriptsSheetFirst(row, "update", plugin, perform)) return;
        await perform();
      } catch (cause) {
        if (showPlanRefusal(cause)) return;
        if (isScriptsWait(errorWords(cause)) && (await scriptsSheetFirst(row, "update", plugin, perform))) return;
        throw cause;
      }
    });
  }

  /** Skills hub H4 (R7): a share that became a pull request in the team
   *  repository, with the way to it. */
  function pullRequestToast(name: string, pr: PromotePullRequest) {
    pushToast({
      kind: "info",
      title: `${name}: shared as a pull request`,
      body: pr.why,
      action: {
        label: "Open pull request",
        onClick: () => void openWebLink(pr.url).catch((e: unknown) => pushToast(linkDidNotOpen(pr.url, e))),
      },
    });
  }

  /** The linked copy a row is drawn from. */
  function linkOf(row: SkillRowModel) {
    return input?.links?.find((l) => l.skill === row.name) ?? null;
  }

  /** Skills hub H4 (R3): the 3-way Compare and its three choices. */
  function compareThree(row: SkillRowModel) {
    setThreeWay({ key: row.key, name: row.name, data: null, error: null });
    skillsHubCompare3(workspaceId, row.name).then(
      (data) => setThreeWay((now) => (now?.key === row.key ? { ...now, data } : now)),
      (cause) => {
        if (showPlanRefusal(cause)) {
          setThreeWay(null);
          return;
        }
        setThreeWay((now) =>
          now?.key === row.key ? { ...now, error: String((cause as Error)?.message ?? cause) } : now,
        );
      },
    );
  }

  /** Skills hub H4 (R3): Keep mine · Take upstream · Propose mine upstream. */
  function chooseForBoth(row: SkillRowModel, choice: BothChangedChoice) {
    const failed =
      choice === "keepMine"
        ? "Couldn't keep your version"
        : choice === "takeUpstream"
          ? "Couldn't take the library's version"
          : "Couldn't propose your version";
    void run(row.key, failed, async () => {
      try {
        if (choice === "propose") {
          const words = linkOf(row)?.originWords ?? "the team library";
          const done = await skillsHubProposeUpstream(workspaceId, row.name);
          data.noteProposal?.(row.name, { number: done.number, url: done.url });
          reload();
          setThreeWay(null);
          setLinkCompare(null);
          pushToast({
            kind: "info",
            title: `${row.name}: proposed to where it came from`,
            body: proposedToastBody(done, words),
            action: {
              label: "Open pull request",
              onClick: () => void openWebLink(done.url).catch((e: unknown) => pushToast(linkDidNotOpen(done.url, e))),
            },
          });
        } else {
          const perform = async (scriptsOk?: string[]) => {
            const card =
              choice === "keepMine"
                ? await skillsHubKeepMine(workspaceId, row.name)
                : await skillsHubUpdate(workspaceId, row.name, true, scriptsOk);
            reload();
            setThreeWay(null);
            setLinkCompare(null);
            await openSkillCard(card);
            void useInbox.getState().refresh();
          };
          // H6b: Take upstream writes the library's version — a new or
          // changed script waits for the Install-time sheet.
          const sheet = async () => {
            if (choice !== "takeUpstream") return false;
            const opened = await scriptsSheetFirst(row, "update", linkOf(row)?.plugin ?? "", perform);
            if (opened) {
              setThreeWay(null);
              setLinkCompare(null);
            }
            return opened;
          };
          if (await sheet()) return;
          try {
            await perform();
          } catch (cause) {
            if (isScriptsWait(errorWords(cause)) && (await sheet())) return;
            throw cause;
          }
          return;
        }
        void useInbox.getState().refresh();
      } catch (cause) {
        if (showPlanRefusal(cause)) return;
        throw cause;
      }
    });
  }

  /** Skills hub H4 (R8): Keep / Remove, Rename here / Keep the old name —
   *  each a card. Free on every plan. */
  function decide(row: SkillRowModel, decision: LinkDecision) {
    void run(row.key, "Couldn't make the card", async () => {
      const card =
        decision.kind === "removed"
          ? await skillsHubRemovedChoice(workspaceId, row.name, decision.choice)
          : await skillsHubRenamedChoice(workspaceId, row.name, decision.choice);
      reload();
      setDeciding(null);
      void useInbox.getState().refresh();
      await openSkillCard(card);
    });
  }

  function openDecision(row: SkillRowModel, kind: "removed" | "renamed") {
    const link = linkOf(row);
    setDeciding({
      row,
      kind,
      originWords: link?.originWords ?? "the team library",
      renamedTo: link?.renamedTo ?? null,
      modified: link?.modifiedHere ?? false,
    });
  }

  /** H4: the choices under a *Modified here* compare. */
  function modifiedChoices(row: SkillRowModel): LinkCompareChoice[] {
    const link = linkOf(row);
    if (link?.state !== "modifiedHere") return [];
    const lines = choiceLines(link.originWords);
    return [
      { id: "takeUpstream", label: TAKE_UPSTREAM_LABEL, hint: lines.takeUpstream },
      {
        id: "propose",
        label: PROPOSE_UPSTREAM_LABEL,
        hint: lines.propose,
        blocked: link.proposal
          ? "Already proposed: the pull request is open."
          : view?.canPromote
            ? null
            : (view?.promoteReason ?? machineWords("Plyloft can't change the team library from this Mac.")),
      },
    ];
  }

  /** Skills hub H3a: the 2-way Compare of a linked copy (free, read only). */
  function compareLink(row: SkillRowModel) {
    setLinkCompare({ key: row.key, name: row.name, data: null, error: null });
    skillsHubCompare(workspaceId, row.name).then(
      (data) => setLinkCompare((now) => (now?.key === row.key ? { ...now, data } : now)),
      (cause) =>
        setLinkCompare((now) =>
          now?.key === row.key ? { ...now, error: String((cause as Error)?.message ?? cause) } : now,
        ),
    );
  }

  /**
   * `Make available to both` · `Make all available to both` (GH #105).
   *
   * One call for the whole action, because the commit is one: the backend makes
   * the plan, carries what can travel and says what it skipped and why. The toast
   * names both halves — a bulk copy that quietly dropped three skills would look
   * like it had copied all of them — and `reload()` follows, as it does after
   * every write on this page, so the chips and the section line are drawn from
   * what the branch now has.
   */
  function availableToBoth(names: string[], key: string) {
    const failed = plural(
      names.length,
      "Couldn't make the skill available to both CLIs",
      "Couldn't make these skills available to both CLIs",
    );
    return run(key, failed, async () => {
      const done = await projectSkillsAvailableToBoth(workspaceId, names);
      reload();
      const where = done.branch ?? branch;
      if (done.queued.length === 0) {
        pushToast({
          kind: done.skipped.length > 0 ? "error" : "info",
          title:
            done.skipped.length > 0
              ? "Nothing could be made available to both"
              : "Already available to both",
          body:
            done.skipped.length > 0
              ? done.skipped.map((s) => `${s.name}: ${s.reason}`).join(" ")
              : `Claude and Codex already read ${plural(done.already.length, "this skill", `all ${done.already.length} of them`)} on ${where}.`,
        });
        return;
      }
      // The channel's own tense: the change is queued and applied here at once,
      // and it reaches the branch as one commit. Saying it had landed would be a
      // promise about a push that may still be waiting (offline, or a pull
      // request) — which the row's own state then reports.
      const carried = plural(
        done.queued.length,
        `${done.queued[0]}`,
        `${done.queued.length} skills`,
      );
      const skipped =
        done.skipped.length > 0
          ? ` ${done.skipped.length} skipped: ${done.skipped.map((s) => `${s.name} — ${s.reason}`).join(" ")}`
          : "";
      pushToast({
        kind: done.skipped.length > 0 ? "warn" : "info",
        title: `Making ${carried} available to Claude and Codex on ${where}`,
        body: `One commit on ${where}; other Macs get the second copy after their next refresh, and Codex reads it in a directory once that directory has it. Your project folder is untouched.${skipped}`,
      });
    });
  }

  /**
   * Skills hub H5 (R12): `Align` on a row. A workspace with no shared
   * channel aligns by card: one copy changed alone → the card at once, no
   * question; both changed → the flow asks which wins. A shared workspace
   * aligns on its branch (GH #105).
   */
  function alignRow(row: SkillRowModel) {
    if (row.twins?.state === "follows") {
      void alignByCard(row, null);
      return;
    }
    openAlign(row);
  }

  /** H5: the Align card — the losing copy becomes the winning one. */
  function alignByCard(row: SkillRowModel, choice: AlignChoice | null) {
    return run(row.key, "Couldn't align the two copies", async () => {
      const done = await skillsHubAlign(workspaceId, row.name, choice);
      reload();
      useLibrary.getState().setFlow(workspaceId, null);
      await openSkillCard(done.card, alignMadeBody(done.card, done.legacyNote));
    });
  }

  /** `Align`: the copy the member chose wins, in one commit (GH #105). */
  function align(row: SkillRowModel, choice: AlignChoice) {
    return run(row.key, "Couldn't align the two copies", async () => {
      const shown = shownIds.current.take("align", row.key);
      const done = await projectSkillAlign(workspaceId, row.name, choice, shown);
      reload();
      useLibrary.getState().setFlow(workspaceId, null);
      setCompare(null);
      pushToast({
        kind: "info",
        // F3/F9 (team walk): queued, not done — the row says when it lands.
        title: `${row.name}: alignment queued for ${done.branch ?? branch}`,
        body: `${choice === "claude" ? "Claude's" : "Codex's"} copy becomes the one Claude and Codex both get, in one commit, once it lands. The row says when. Your project folder is untouched.`,
      });
    });
  }

  function onAction(row: SkillRowModel) {
    const action = row.action;
    if (!action) return;
    switch (action.id) {
      case "compare":
        setCompare(row);
        return;
      case "compare-reach":
        setCompare(row, "reach");
        return;
      case "open-pull-request": {
        const number =
          row.transient?.kind === "pullRequest" ? row.transient.number : null;
        if (number == null) return;
        void run(row.key, `Couldn't open pull request #${number}`, () =>
          workspaceDefinitionOpenPullRequest(workspaceId, number),
        );
        return;
      }
      case "keep-on-this-mac":
        useLibrary.getState().keepOnThisMac(workspaceId, row.name);
        pushToast({
          kind: "info",
          title: `${row.name} stays on this Mac`,
          body: `It is gone from ${branch}; your copy here is untouched. Publish it again to give it back to everyone.`,
        });
        return;
      case "promote":
        useLibrary.getState().setFlow(workspaceId, { kind: "promote", key: row.key });
        return;
      case "install":
        if (action.confirm) setConfirming({ row, what: "install" });
        else void install(row, false);
        return;
      case "review-scripts":
        // Cold read 2026-10-19: a linked repository row offers the Review of
        // the team skill it is linked to — the sheet is the team row's.
        useLibrary
          .getState()
          .setFlow(workspaceId, { kind: "scripts", key: row.scope === "team" ? row.key : `team:${row.name}` });
        return;
      case "update":
        update(row);
        return;
      case "compare-link":
        compareLink(row);
        return;
      case "link":
        link([row.name], row.key);
        return;
      case "compare3":
        compareThree(row);
        return;
      case "removed-choice":
        openDecision(row, "removed");
        return;
      case "renamed-choice":
        openDecision(row, "renamed");
        return;
      case "align":
        alignRow(row);
        return;
      // QoL block 13: the ways out of a git step.
      case "ship-with-card":
        shipWithCard(row.name, row.key);
        return;
      case "ask-builder":
        if (action.prompt) askTheBuilder(workspaceId, cwd, action.prompt);
        return;
      case "open-card":
        if (action.cardId) openCardStep(workspaceId, action.cardId, "outcome");
        return;
    }
  }

  /**
   * The skill page's one primary button (GH #100, BOARDS.md §4).
   *
   * `Edit in Code` is the page's name for the `⋯`'s `Open in Code` and reaches
   * the editor through the same call; `Promote` and `Install` **are** the row's
   * own action, so they go through `onAction` — which is where the Replace
   * question lives. A second write path here is exactly how review 2's silent
   * no-op happened.
   */
  function onPrimary(row: SkillRowModel, action: SkillPageAction) {
    if (action.id === "edit-in-code") {
      const dir = absoluteSkillDir(row, cwd);
      // `openInCode` decided this button existed at all; the path is the same
      // one `Open in Code` uses — and so this open is writable by construction.
      // `Edit in Code` is offered for the checkout alone, and GH #142 did not
      // change that ("Board 3's `Edit in Code` stays checkout-only").
      if (!dir) return;
      void run(row.key, "Couldn't open the skill in Code", () =>
        openInCode(joinPath(dir, "SKILL.md"), WRITABLE),
      );
      return;
    }
    onAction(row);
  }

  /**
   * An action under Compare (BOARDS.md §4).
   *
   * Everything but `Keep both` resolves to the row's **own** menu entry or its
   * own action, so the confirm-then-`replace` path, the toasts and the `reload()`
   * after a write are one implementation, not two. `compareActions` derives its
   * list from the same menu, so an action can never be offered here that the row
   * does not have.
   */
  function onCompareAction(
    row: SkillRowModel,
    action: CompareAction,
    identity: DuplicateIdentity | null,
  ) {
    if (action.id === "keep-both") {
      if (!identity) return;
      void keepBoth(row, identity);
      return;
    }
    if (action.id === "promote") {
      useLibrary.getState().setFlow(workspaceId, { kind: "promote", key: row.key });
      return;
    }
    if (action.id === "align") {
      alignRow(row);
      return;
    }
    const entry = row.menu.find((e) => e !== "divider" && e.id === action.id);
    if (entry) onMenu(row, entry);
  }

  /**
   * `Keep both`: silence this notice on this Mac until either version changes.
   *
   * Through `useSettings.update`, which applies the change to the settings **as
   * they are when it runs** (`lib/settingsQueue.ts`) and writes the whole file
   * atomically in Rust: a theme change saved a moment earlier cannot be undone by
   * this, and this cannot be undone by the next one.
   */
  async function keepBoth(row: SkillRowModel, identity: DuplicateIdentity) {
    setBusy(row.key);
    try {
      await useSettings.getState().update((latest) => ({
        ...latest,
        library: {
          ...latest.library,
          silencedDuplicates: withSilenced(latest.library.silencedDuplicates, identity),
        },
      }));
      // The comparison has done its job; the page comes back to rest without it.
      setCompare(null);
      pushToast({
        kind: "info",
        title: `Both versions of ${row.name} kept`,
        body: machineWords(
          "The notice is quiet on this Mac until either version changes. The list " +
            `still shows ${row.duplicate?.chip ?? "the other scope"}.`,
        ),
      });
    } catch (cause) {
      pushErrorToast("Couldn't silence the notice", cause);
    } finally {
      setBusy(null);
    }
  }

  /**
   * GH #106: switch a skill that comes with Ply on or off, on this Mac.
   *
   * Through `useSettings.update` for the reason `keepBoth` is: the new list is
   * computed **inside** the mutation, from the settings as they are when its turn
   * comes, so a switch in flight and a theme saved a moment earlier cannot undo
   * each other (GH #100 review 2). Nothing else happens — no running session is
   * told and none is restarted; the next one Ply launches reads the new list.
   *
   * No toast on success: the switch is its own feedback, and the section says
   * what it means. No busy key either — a settings write is one file, and
   * greying the row would make a switch feel like a publish.
   */
  async function switchPly(row: SkillRowModel, on: boolean) {
    try {
      await useSettings.getState().update((latest) => plySkillSwitchedIn(latest, row.name, on));
    } catch (cause) {
      pushErrorToast(`Couldn't switch ${row.ply?.title ?? row.name} ${on ? "on" : "off"}`, cause);
    }
  }

  /**
   * Skills hub H9 (R9): this workspace's choice for a Plyloft skill — a field
   * of the shared definition (published to the integration branch, like any)
   * or this Mac's own for a workspace that shares none. Applies from the next
   * session; nothing running is told.
   */
  function plyWorkspace(row: SkillRowModel, choice: WorkspaceChoice) {
    void run(row.key, `Couldn't change ${row.ply?.title ?? row.name} in this workspace`, async () => {
      await plySkillSetting("workspace", workspaceId, row.name, choice === "follow" ? null : choice === "on");
      reload();
    });
  }

  /** H9: the team default — the owner's only; a member's press is answered
   *  with who decides (the backend's words). */
  function plyTeam(row: SkillRowModel, off: boolean) {
    void run(row.key, `Couldn't change ${row.ply?.title ?? row.name} for the team`, async () => {
      try {
        await plySkillSetting("team", workspaceId, row.name, off ? false : null);
      } catch (cause) {
        if (showPlanRefusal(cause)) return;
        throw cause;
      }
      reload();
      pushToast({
        kind: "info",
        title: off ? `${row.name} is off for the team` : `${row.name}: no team choice`,
        body: off
          ? "Every workspace without its own choice, on each teammate's Mac, stops getting Plyloft's copy from its next session, once that Mac has the team library's change."
          : "Each Mac's own switch decides again, from the next session.",
      });
    });
  }

  /** H9: **Personalize** — a skill card in this repository, or the team
   *  library (and, for the owner, the team default). */
  function personalize(row: SkillRowModel, target: "repository" | "team") {
    void run(row.key, `Couldn't personalize ${row.name}`, async () => {
      let done;
      try {
        done = await plySkillPersonalize(workspaceId, row.name, target);
      } catch (cause) {
        if (showPlanRefusal(cause)) return;
        throw cause;
      }
      useLibrary.getState().setFlow(workspaceId, null);
      reload();
      if (done.card) {
        await openSkillCard(done.card);
        return;
      }
      if (done.pullRequest) {
        pullRequestToast(row.name, done.pullRequest);
        return;
      }
      const team = plyPlace?.team?.name ?? "the team";
      if (done.teamSwitched) {
        pushToast({
          kind: "info",
          title: `Your ${row.name} is in ${team}'s library`,
          body: `Plyloft's ${row.name} is off for the team: team workspaces get yours instead, from their next session.`,
        });
        return;
      }
      // Challenger (H9): the owner whose team-default write failed hears
      // why and where to switch it, never "Only <themselves> can".
      if (done.teamSwitchProblem) {
        pushToast({
          kind: "warn",
          title: `Your ${row.name} is in ${team}'s library`,
          body: `Plyloft's ${row.name} is still on for the team: ${done.teamSwitchProblem} Switch it off under Where it's on.`,
        });
        return;
      }
      const owner = done.owner ?? (plyPlace?.team?.youOwn ? null : (plyPlace?.team?.owner ?? null));
      pushToast({
        kind: "info",
        title: `Your ${row.name} is in ${team}'s library`,
        body: owner
          ? `Only ${owner} can switch Plyloft's ${row.name} off for the team. Your fork reaches sessions next to it until then.`
          : `Sessions get your ${row.name} next to Plyloft's until the team default switches Plyloft's off.`,
        action: owner
          ? {
              label: `Ask ${owner}`,
              onClick: () => void navigator.clipboard?.writeText(askOwnerSentence(row.name, team)).catch(() => {}),
            }
          : undefined,
      });
    });
  }

  function promote(row: SkillRowModel, choice: PromoteChoice, replace = false) {
    return run(
      row.key,
      // The flow's own verb, for either place: with a team it says Share (the
      // repository's button too), solo mode keeps Promote.
      solo ? "Couldn't promote the skill" : "Couldn't share the skill",
      async () => {
      const done = await personalSkillPromote(workspaceId, row.name, choice, replace);
      reload();
      // All skills' rows, which the skill's page says too, without waiting for
      // the watcher's read (a folder git ignores, a workspace not warmed) or
      // the next pull of the team library.
      if (choice === "repository") refreshAllSkillsFor([workspaceId]);
      else if (!done.pullRequest) refreshAllSkillsLibraries();
      useLibrary.getState().setFlow(workspaceId, null);
      // Skills hub H4 (R7): never over a teammate's change — a pull request.
      if (done.pullRequest) {
        pullRequestToast(row.name, done.pullRequest);
        return;
      }
      pushToast({
        kind: "info",
        title:
          choice === "repository"
            ? `${row.name} is in this repository`
            : done.committed
              ? `${row.name} shared with the team`
              : `${row.name} was already in the team library`,
        body:
          choice === "repository"
            ? machineWords(
                "Written into both Claude's and Codex's skill folders in your project folder. Teammates get it once a card ships it. Your copy on this Mac is untouched.",
              )
            : machineWords(
                "Your team can read it now. Your copy on this Mac is untouched. To take it back, use Remove from Team…; it stays in the repository's history.",
              ),
        ...(choice === "repository" ? { action: shipAction(row.name) } : {}),
      });
      },
      replace
        ? undefined
        : {
            row,
            what: choice === "repository" ? "promote-repository" : "promote-team",
          },
    );
  }

  /**
   * GH #104: `Approve and publish` and `Dismiss`.
   *
   * The store does the write and clears the block; `reload()` follows an
   * approve, because the queue now carries a change and the row's transient
   * state is what says so (the same rule every other write on this page keeps).
   */
  async function approveProposal() {
    const done = await useProposal.getState().approve(workspaceId);
    if (!done) {
      pushErrorToast("Couldn't approve the change", useProposal.getState().byWorkspace[workspaceId]?.error ?? "");
      return;
    }
    reload();
    // SP-5: without a shared definition the change was committed (or published)
    // already, and the backend says what happened.
    const approved = useProposal.getState().byWorkspace[workspaceId]?.approved;
    pushToast(
      approved
        ? { kind: "info", title: approved.title, body: approved.body }
        : {
            kind: "info",
            title: `The change is queued for ${branch}`,
            body: "Everyone who opens this repository gets it once it lands; the row says when. Your project folder is untouched.",
          },
    );
  }

  async function dismissProposal() {
    const done = await useProposal.getState().dismiss(workspaceId);
    if (!done) {
      pushErrorToast("Couldn't dismiss the suggested skill change", useProposal.getState().byWorkspace[workspaceId]?.error ?? "");
    }
  }

  /**
   * GH #104: the proposal, when this page is the one showing it.
   *
   * The block belongs to its target's page (BOARDS.md §4 state C), and a skill's
   * own sub-page draws it above its header. But the Inbox item and the Ship step
   * both land on the **Skills page** (`openLibraryPage(ws, "skills")`), not on a
   * sub-page — Ply has no row key to open until the scopes have been read — so a
   * block drawn only on the sub-page would leave both of them arriving at a list
   * with nothing on it. Walking that path is what found it.
   *
   * The list and the skill's page are the two arms of one `body ?? (…)`, so they
   * are never on screen together: there is exactly one block either way, and
   * never two copies of one proposal on one scroll.
   */
  const listProposal =
    open == null && proposalIsFor(proposal, { page: "skills-list", scope }) ? proposal : null;
  // GH #271: on the list the block names its target and opens it.
  const listTarget = listProposal ? proposalTarget(listProposal, SECTION_TITLE) : null;
  const targetRow = listTarget ? (all.find((r) => r.key === listTarget.key) ?? null) : null;

  // ── The page ─────────────────────────────────────────────────────────
  //
  // One return, and the Replace question outside every branch of it. Review 2:
  // a refusal raised while the flow was showing set `confirming` and then had
  // nowhere to draw it — the flow's early return was above the dialog — so a
  // personal Promote onto a differing copy was a silent no-op. Whatever is on
  // screen, the question can be asked over it, and answering it leaves the
  // member where they were.

  const body = creating ? (
    <NewSkillFlow
      taken={{
        skills: view?.skills ?? [],
        unloadable: view?.unloadable ?? [],
        mirror: library?.branchSkillRows ?? [],
      }}
      branch={library?.branch ?? null}
      ignored={newSkillIgnoredRoots(view?.ignoredRoots ?? [])}
      unignore={ignoreFix}
      refusal={newSkillRefusal}
      busy={busy === NEW_SKILL_KEY}
      onCancel={() => {
        setNewSkillRefusal(null);
        useLibrary.getState().setFlow(workspaceId, null);
      }}
      onCreate={(name, description) => void createSkill(name, description)}
    />
  ) : aligning?.drift ? (
    <AlignFlow
      name={aligning.name}
      branch={library?.branch ?? null}
      lines={{
        claude: countLines(driftTexts[aligning.key]?.claude ?? null),
        codex: countLines(driftTexts[aligning.key]?.codex ?? null),
      }}
      busy={busy === aligning.key}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onAlign={(choice) => void align(aligning, choice)}
    />
  ) : aligning?.twins ? (
    <AlignFlow
      name={aligning.name}
      branch={null}
      mode="card"
      lines={{ claude: null, codex: null }}
      busy={busy === aligning.key}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onAlign={(choice) => void alignByCard(aligning, choice)}
    />
  ) : publishing ? (
    // Its OK publishes (whose own toast says so); Cancel publishes nothing.
    <ScriptApprovalFlow
      key={`publish:${publishing.key}`}
      plugin=""
      skill={publishing.name}
      install={{
        workspaceId,
        verb: "publish",
        branch,
        onConfirm: async (scriptsOk) => {
          await publishRow(publishing, scriptsOk);
          reload();
        },
      }}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onDone={() => {
        if (useLibrary.getState().byWorkspace[workspaceId]?.flow?.kind === "publish") {
          useLibrary.getState().setFlow(workspaceId, null);
        }
      }}
    />
  ) : reviewing && installSheet ? (
    // H6b: the Install-time sheet; its OK makes the card (whose own toast
    // says so), Cancel writes nothing.
    <ScriptApprovalFlow
      key={`install:${reviewing.key}`}
      plugin={scriptsThen?.plugin ?? ""}
      skill={reviewing.name}
      install={installSheet}
      onCancel={() => {
        setScriptsThen(null);
        useLibrary.getState().setFlow(workspaceId, null);
      }}
      onDone={() => {
        setScriptsThen(null);
        // The card's Ship step is open now; leave the flow only if it is
        // still this sheet's.
        if (useLibrary.getState().byWorkspace[workspaceId]?.flow === scriptsThen?.flow) {
          useLibrary.getState().setFlow(workspaceId, null);
        }
        void useInbox.getState().refresh();
      }}
    />
  ) : reviewing ? (
    <ScriptApprovalFlow
      plugin={
        reviewing.transient?.kind === "needsOk" ? reviewing.transient.plugin : (reviewing.plugin ?? "")
      }
      skill={reviewing.name}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onDone={(approved) => {
        useLibrary.getState().setFlow(workspaceId, null);
        reload();
        void useInbox.getState().refresh();
        if (approved) {
          pushToast({
            kind: "info",
            title: `${reviewing.name}: approved on ${machineWords("this Mac")}`,
            body: "New sessions get this version. Sessions already open keep what they have.",
          });
        }
      }}
    />
  ) : deciding ? (
    <LinkDecisionFlow
      name={deciding.row.name}
      originWords={deciding.originWords}
      kind={deciding.kind}
      renamedTo={deciding.renamedTo}
      modified={deciding.modified}
      copies={(deciding.row.claude ? 1 : 0) + (deciding.row.codex ? 1 : 0) || 2}
      busy={busy === deciding.row.key}
      onCancel={() => setDeciding(null)}
      onDecide={(decision) => decide(deciding.row, decision)}
    />
  ) : threeWay ? (
    <ThreeWayCompareFlow
      name={threeWay.name}
      compare={threeWay.data}
      error={threeWay.error}
      busy={busy === threeWay.key}
      onHide={() => setThreeWay(null)}
      onChoose={(choice) => {
        const row = all.find((r) => r.key === threeWay.key);
        if (row) chooseForBoth(row, choice);
      }}
    />
  ) : linkCompare ? (
    <LinkCompareFlow
      name={linkCompare.name}
      compare={linkCompare.data}
      error={linkCompare.error}
      onHide={() => setLinkCompare(null)}
      originWords={(() => {
        const row = all.find((r) => r.key === linkCompare.key);
        return (row && linkOf(row)?.originWords) || "the team library";
      })()}
      choices={(() => {
        const row = all.find((r) => r.key === linkCompare.key);
        return row ? modifiedChoices(row) : [];
      })()}
      busy={busy === linkCompare.key}
      onChoose={(id) => {
        const row = all.find((r) => r.key === linkCompare.key);
        if (row) chooseForBoth(row, id);
      }}
    />
  ) : personalizing ? (
    <PersonalizeFlow
      name={personalizing.name}
      title={personalizing.ply?.title ?? personalizing.name}
      place={plyPlace}
      solo={solo}
      busy={busy === personalizing.key}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onPersonalize={(target) => personalize(personalizing, target)}
    />
  ) : promoting && promoting.scope === "repository" && promoting.asks ? (
    <ShareAskingFlow
      name={promoting.name}
      asks={promoting.asks}
      teamRepo={teamRepo}
      note={promoting.promoteShares}
      refusal={promoting.shareRefusal}
      busy={busy === promoting.key}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onShare={() => shareAsking(promoting)}
    />
  ) : promoting ? (
    <PromoteFlow
      name={promoting.name}
      repository={library?.repository ?? null}
      teamReason={
        view?.canPromote
          ? promoting.teamCopy === "same"
            ? ALREADY_IN_TEAM_REASON
            : null
          : (view?.promoteReason ?? null)
      }
      teamShown={!solo}
      visible={visible}
      busy={busy === promoting.key}
      onCancel={() => useLibrary.getState().setFlow(workspaceId, null)}
      onPromote={(choice) => void promote(promoting, choice)}
    />
  ) : open ? (
    <SkillDetail
      row={{ ...open, dir: absoluteSkillDir(open, cwd) }}
      twin={twinOf(open, all)}
      twinText={twinKey ? (pairTexts[twinKey] ?? null) : null}
      pairText={pairTexts[open.key] ?? null}
      textsRead={generation > 0}
      workspaceId={workspaceId}
      silencedHere={silencedHere}
      identical={openIdentical}
      compareOpen={compare?.key === open.key ? compare.what : null}
      branch={library?.branch ?? null}
      driftText={driftTexts[open.key] ?? null}
      // `<scope>:<name>`, so a proposal about another copy of this name — the
      // personal one, the team's — is not drawn over this one (review 1, MINOR).
      proposal={
        proposalIsFor(proposal, { page: "skill", name: open.name, scope: open.scope })
          ? proposal
          : null
      }
      proposalBusy={proposalBusy}
      onProposalApprove={() => void approveProposal()}
      onProposalDismiss={() => void dismissProposal()}
      generation={generation}
      busy={busy === open.key}
      onBack={() => useLibrary.getState().openSkill(workspaceId, null)}
      onOpenFile={(path) =>
        void run(open.key, "Couldn't open the file in Code", () =>
          openInCode(path, skillFileMode(open)),
        )
      }
      onPrimary={(action) => onPrimary(open, action)}
      onMenu={(entry) => onMenu(open, entry)}
      onCompareOpen={(want, what) =>
        want ? setCompare(open, what === "reach" ? "reach" : undefined) : setCompare(null)
      }
      onCompareAction={(action, identity) => onCompareAction(open, action, identity)}
      onReveal={(dir) =>
        void run(open.key, `Couldn't show the folder in ${platformWord("fileManager")}`, () =>
          personalSkillReveal(dir),
        )
      }
      onSwitch={(on) => void switchPly(open, on)}
      onPlyWorkspace={(choice) => plyWorkspace(open, choice)}
      onPlyTeam={(off) => plyTeam(open, off)}
      onPersonalize={() => useLibrary.getState().setFlow(workspaceId, { kind: "personalize", key: open.key })}
    />
  ) : null;

  // The filter is "name or description, all scopes" (the card), and the field
  // says how many skills it is filtering — so a match outside the chosen scope
  // surfaces its section rather than being counted and hidden (review 1).
  const filtering = filter.trim() !== "";
  const shown =
    scope === "all" || filtering ? sections : sections.filter((s) => s.scope === scope);
  const matched = new Map(
    shown.map(({ scope: s, rows }) => [s, filterSkillRows(rows, filter)] as const),
  );
  // X3: My library shows under All, under its own scope, and to a filter.
  const mineShown = scope === "all" || scope === "my-library" || filtering;
  const mineMatched = mineShown ? mineRows.filter((r) => matchesFilter(r, filter)) : [];
  const repositoryNames = new Set(
    sections.find((s) => s.scope === "repository")?.rows.map((r) => r.name) ?? [],
  );
  const mineNames = new Set(mineRows.map((r) => r.name));
  const matches =
    [...matched.values()].reduce((n, rows) => n + rows.length, 0) + mineMatched.length;
  const outside =
    filtering && scope !== "all"
      ? matches -
        (scope === "my-library" ? mineMatched.length : (matched.get(scope as Scope)?.length ?? 0))
      : 0;
  // After the team library, before Comes with Plyloft — All skills' order.
  const mineAt = shown.findIndex((s) => s.scope !== "repository" && s.scope !== "team");
  // A filter that matches none of My library's skills empties it, as it does
  // every other section.
  const mineSection = mineShown && (!filtering || mineMatched.length > 0) ? (
    <MyLibrarySection
      rows={mineMatched}
      // Q2(a): once, under All with no filter, when this computer uses none.
      empty={scope === "all" && !filtering && mineRows.length === 0}
      repositoryNames={repositoryNames}
    />
  ) : null;

  return (
    <>
      {body ?? (
        <>
          {/* No badge: the four sections carry the scope, and one on the header
              would claim the page belonged to a single scope. */}
          <PageHeader title="Skills" lede={SKILLS_LEDE} />
          {/* GH #315: the page's own navigation (a narrow centre's switch and
              scope picker) sits straight under the lede, in the same place
              whatever notices the page carries — as Instructions draws it. */}
          {controls}
          <LibraryErrorBlocks workspaceId={workspaceId} />
          {/* GH #104: where the Inbox item and the Ship step's line land. A
              skill's own sub-page draws it above its header instead; the two are
              the arms of one return, so one proposal is one block. */}
          {listProposal && (
            <ProposalBlock
              view={listProposal}
              busy={proposalBusy}
              onApprove={() => void approveProposal()}
              onDismiss={() => void dismissProposal()}
              nowMs={Date.now()}
              target={
                listTarget ? {
                  name: listTarget.name,
                  scope: listTarget.scope,
                  onOpen: targetRow
                    ? () => useLibrary.getState().openSkill(workspaceId, targetRow.key)
                    : null,
                } : undefined
              }
              onPromote={
                targetRow?.action?.id === "promote"
                  ? () =>
                      useLibrary
                        .getState()
                        .setFlow(workspaceId, { kind: "promote", key: targetRow.key })
                  : undefined
              }
            />
          )}
          {library?.shared && library.readOnly && (
            <StatusLine state="empty">
              You can read this page. Changing what {branch} carries needs write
              access to {library.repository ?? "this repository"}.
            </StatusLine>
          )}
          {/* No filter over a read that failed: there is nothing to filter. */}
          {(input || loading) && (
            <div className="ux-library-filter">
              <SearchField
                value={filter}
                onChange={(next) => useLibrary.getState().setFilter(workspaceId, next)}
                placeholder={filterPlaceholder(counts.all)}
              />
              {/* Decision §3: the one way to start a skill here — in this
                  repository, for both CLIs. */}
              {view && (
                <CBtn
                  size="sm"
                  onClick={() => {
                    setNewSkillRefusal(null);
                    useLibrary
                      .getState()
                      .setFlow(workspaceId, { kind: "new-skill", key: NEW_SKILL_KEY });
                  }}
                >
                  New skill…
                </CBtn>
              )}
            </div>
          )}
          {loading && !input && (
            <EmptyState>Reading this repository, the team library and this Mac…</EmptyState>
          )}
          {/* The first read failed: nothing to list, so the page says why and
              offers the read again, rather than a filter over zero skills. */}
          {!loading && !input && data.readError != null && (
            <ErrorBlock
              error={skillsReadError(data.readError)}
              onAction={(id) => {
                if (id === "try-again") reload();
              }}
            />
          )}
          {/* The fix's outcome once the roots it un-ignored are gone, and the
              block that would have carried it with them. */}
          {ignoredRoots.length === 0 && ignoreFix.note && (
            <StatusLine state="empty">{ignoreFix.note}</StatusLine>
          )}
          {outside > 0 && (
            <StatusLine state="empty">
              Filtering every scope — {outside}{" "}
              {outside === 1 ? "match is" : "matches are"} outside{" "}
              {SCOPE_NAV_LABEL[scope]}.
            </StatusLine>
          )}
          {shown.map(({ scope: sectionScope, rows }, at) => {
            const rowsHere = matched.get(sectionScope) ?? [];
            // A section with nothing in it is absent, not drawn empty: a build
            // with no bundled skills has no `Comes with Ply` at all (GH #106),
            // and a filter that empties a section has said so by emptying it.
            const drawn = rowsHere.length === 0 ? null : (
              <Section
                key={sectionScope}
                title={SECTION_TITLE[sectionScope]}
                count={sectionCount(rowsHere.length, sectionScope)}
              >
                <SectionNote
                  scope={sectionScope}
                  rows={rows}
                  filtering={filtering}
                  busy={busy === SECTION_BUSY}
                  plyProblem={plyProblem}
                  onRetry={reload}
                  loading={loading}
                  onMakeAll={(names) => void availableToBoth(names, SECTION_BUSY)}
                  linkBusy={busy === LINK_ALL_BUSY}
                  onLinkAll={(names) => link(names, LINK_ALL_BUSY)}
                  solo={solo}
                />
                {sectionScope === "repository" && ignoredRoots.length > 0 && (
                  <IgnoredRootsFix roots={ignoredRoots} fix={ignoreFix} />
                )}
                <Group label={SECTION_TITLE[sectionScope]}>
                  {rowsHere.map((row) => (
                    <SkillRow
                      key={row.key}
                      row={row}
                      onOpen={() => useLibrary.getState().openSkill(workspaceId, row.key)}
                      onAction={() => onAction(row)}
                      onMenu={(entry) => onMenu(row, entry)}
                      onSwitch={(on) => void switchPly(row, on)}
                      busy={busy === row.key}
                      busyLine={busy === row.key ? busyLine : null}
                      also={sectionScope === "repository" && mineNames.has(row.name) ? ALSO_IN_MY_LIBRARY : null}
                    />
                  ))}
                </Group>
              </Section>
            );
            // X3: My library sits after the team library (Q1 a).
            return at === mineAt ? (
              <Fragment key={sectionScope}>
                {mineSection}
                {drawn}
              </Fragment>
            ) : (
              drawn
            );
          })}
          {mineAt === -1 && mineSection}
          {input && counts.all > 0 && filtering && matches === 0 && (
            <EmptyState>No skill's name or description mentions “{filter}”.</EmptyState>
          )}
          {input && counts.all === 0 && !loading && (
            <EmptyState>
              No skills here yet. A skill in this repository reaches everyone who
              opens it; one on this Mac is yours alone.
            </EmptyState>
          )}
          {/* What looks like a skill and is loaded by neither CLI, and what the
              branch carries that Plyloft will not copy. The Project panel said both;
              silence about them reads as Plyloft not seeing the file. */}
          {/* H4 Mac walk (P-D2): plain words; the path and the OS error
              under Details. */}
          {view?.unloadable.map((skill) => {
            const notice = unloadableNotice(skill);
            return (
              <div key={`${skill.root}:${skill.name}`}>
                <StatusLine state="empty">{notice.sentence}</StatusLine>
                {notice.details && (
                  <Details>
                    <pre className="ux-output">{notice.details}</pre>
                  </Details>
                )}
              </div>
            );
          })}
          {skippedLines(library, "skill").map((line) => (
            <StatusLine key={line} state="empty">
              {line}
            </StatusLine>
          ))}
          {personal?.errors.map((error) => (
            <StatusLine key={error} state="empty">
              {error}
            </StatusLine>
          ))}
          {view?.errors.map((error) => (
            <StatusLine key={error} state="aborted">
              {error}
            </StatusLine>
          ))}
        </>
      )}
      {/* Over whatever is showing: the list, the flow, a comparison or a
          skill's page. Answering it leaves that where it was — Cancel drops the
          Replace and nothing else, and a Replace that goes through closes the
          flow from inside `promote`. */}
      {removing && (
        <ConfirmDialog
          title={`Remove ${qualifiedSkillName({ plugin: removing.plugin ?? "", name: removing.name })} from the team?`}
          body={removeConfirmBody({ plugin: removing.plugin ?? "", name: removing.name })}
          confirmLabel="Remove from team"
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const row = removing;
            setRemoving(null);
            void removeFromTeam(row);
          }}
        />
      )}
      {ignoreFix.sheet}
      {unpublishing && (
        <ConfirmDialog
          title={`Remove ${unpublishing.name} from ${branch}?`}
          body={unpublishConfirmBody(unpublishing.name, branch, branchReachOf(input, unpublishing.name))}
          confirmLabel={`Remove from ${branch}`}
          destructive
          onCancel={() => setUnpublishing(null)}
          onConfirm={() => {
            const row = unpublishing;
            setUnpublishing(null);
            void unpublish(row);
          }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={
            confirming.what === "install"
              ? `Link and update ${confirming.row.name}?`
              : `Replace ${confirming.row.name}?`
          }
          body={
            confirming.what === "install"
              ? linkAndUpdateConfirmBody(confirming.row.name)
              : replaceConfirmBody(
                  confirming.what === "promote-repository" ? "install" : "promote",
                  confirming.row.name,
                  // Walk follow-ups 2026-10-19 (Challenger): the copy Replace
                  // shares, when it isn't this checkout's.
                  confirming.what === "promote-to-team" ? confirming.row.promoteShares : null,
                )
          }
          confirmLabel={confirming.what === "install" ? "Link and update" : "Replace"}
          destructive
          onCancel={() => {
            delete shownAsks.current[confirming.row.key];
            setConfirming(null);
          }}
          onConfirm={() => {
            const asked = confirming;
            setConfirming(null);
            if (asked.what === "install") void install(asked.row, true);
            else if (asked.what === "promote-to-team") void promoteToTeam(asked.row, true);
            else if (asked.what === "promote-repository") {
              void promote(asked.row, "repository", true);
            } else void promote(asked.row, "team", true);
          }}
        />
      )}
    </>
  );
}

/** The line under a section heading, once. */
function SectionNote({
  scope,
  rows,
  filtering,
  busy,
  plyProblem,
  onRetry,
  loading,
  onMakeAll,
  linkBusy,
  onLinkAll,
  solo,
}: {
  /** OB-9: no team, so the lead names none. */
  solo: boolean;
  scope: Scope;
  rows: SkillRowModel[];
  /** A filter is on, so the heading counts matches and not the section. */
  filtering: boolean;
  busy: boolean;
  /** GH #106: why `Comes with Ply` reaches nothing, when it reaches nothing. */
  plyProblem: string | null;
  /** Read the page's facts again — for `Comes with Ply`, the retry its fault names. */
  onRetry: () => void;
  /** A read is running, which is what `Try again` would start. */
  loading: boolean;
  /** GH #105: carry every one of them over, in one commit. */
  onMakeAll: (names: string[]) => void;
  /** Skills hub H3b: a Link all is running. */
  linkBusy: boolean;
  /** Skills hub H3b (R-M): link every copy that equals a team version, in
   *  one card. */
  onLinkAll: (names: string[]) => void;
}) {
  // GH #106 review 1: the section says what happened, once, rather than leaving a
  // member with four rows that quietly reach no session. It is the whole section's
  // fault and not one row's, so it sits here and not on a row; and it is drawn
  // whether or not a filter is on, because it is not a count.
  if (scope === "ply") {
    return plyProblem ? (
      <>
        <StatusLine state="aborted">{plySectionProblem(plyProblem)}</StatusLine>
        <div className="ux-section-note-action">
          <CBtn size="sm" tone="strong" disabled={loading} onClick={onRetry}>
            {PLY_RETRY_LABEL}
          </CBtn>
        </div>
      </>
    ) : null;
  }
  if (scope === "this-mac") {
    return <p className="ux-section-note">{machineWords(solo ? THIS_MAC_NOTE_SOLO : THIS_MAC_NOTE)}</p>;
  }
  // Skills hub H2 (R1, R16): the team library is pulled in the background;
  // when it last was, or why it is not current.
  if (scope === "team") return <TeamLibraryPullLine asNote />;
  if (scope !== "repository") return null;
  // "All 34 reach Claude only." is about the whole section, and the heading
  // beside it counts matches while a filter is on — two numbers on one basis or
  // none (review 1). The sentence waits until the filter is cleared.
  if (filtering) return null;
  // Skills hub H3b (R-M): every copy that equals a team version, linked in
  // one card. The rows' own Link stays; this is the one press for all.
  const toLink = linkAll(rows);
  const linkNote = toLink.length > 0 && (
    <>
      <p className="ux-section-note">{linkAllLine(toLink.length)}</p>
      <div className="ux-section-note-action">
        <CBtn size="sm" tone="strong" disabled={linkBusy} onClick={() => onLinkAll(toLink)}>
          {LINK_ALL_LABEL}
        </CBtn>
      </div>
    </>
  );
  const line = oneCliLine(rows);
  if (!line) return linkNote || null;
  // GH #105: the button offers exactly the rows whose own `⋯` offers it — so a
  // read-only collaborator gets the sentence and no button, and a section whose
  // skills are not on the branch yet gets the sentence and nothing to press.
  const names = makeAllBoth(rows);
  return (
    <>
      <p className="ux-section-note">{machineWords(line)}</p>
      {names.length > 0 && (
        <div className="ux-section-note-action">
          <CBtn size="sm" tone="strong" disabled={busy} onClick={() => onMakeAll(names)}>
            {MAKE_ALL_BOTH_LABEL}
          </CBtn>
        </div>
      )}
      {linkNote}
    </>
  );
}

/**
 * GH #215: `Un-ignore` for the roots git ignores, where the rows say so.
 *
 * The same hook Settings › Diagnostics and the Dependency Doctor use, so the
 * press only reads the plan, the confirmation shows the exact lines and file,
 * and nothing is written until it is confirmed. The page owns the hook (and
 * draws its sheet), so its outcome survives this block going away.
 */
function IgnoredRootsFix({
  roots,
  fix,
}: {
  roots: string[];
  fix: ReturnType<typeof useSkillRootIgnoreFix>;
}) {
  return (
    <>
      <p className="ux-section-note">{machineWords(ignoredRootsLine(roots))}</p>
      {fix.note && <StatusLine state="empty">{fix.note}</StatusLine>}
      <div className="ux-section-note-action">
        <CBtn size="sm" tone="strong" disabled={fix.busy} onClick={fix.start}>
          {fix.busy ? "Looking…" : "Let Git see it"}
        </CBtn>
      </div>
    </>
  );
}

/** `1 skill` / `3 skills`, without stitching an `s` onto a sentence. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** How long a copy is, for the Align flow's hints. `null` stays `null`: a copy
 *  Ply could not read has no length, and the hint simply has one fact fewer. */
function countLines(text: string | null): number | null {
  if (text == null) return null;
  if (text === "") return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

/** C4: how long a removal waits for Undo — `commands::SKILL_REMOVAL_UNDO`. */
const SKILL_REMOVAL_UNDO_MS = 10_000;

/** C4 (Challenger): what the removal's Undo says, for what it found. */
function undoRemovalToast(found: SkillRemovalUndo, name: string, branch: string): Omit<Toast, "id" | "createdAt"> {
  switch (found) {
    case "withdrawn":
      return { kind: "info", title: `Kept ${name} on ${branch}` };
    case "restored":
      return {
        kind: "info",
        title: `Kept ${name} on ${branch}`,
        body: `Your change to it is waiting to publish again, as before you removed it.`,
      };
    case "replaced":
      return {
        kind: "info",
        title: `Nothing to undo for ${name}`,
        body: `A newer change to it is waiting to publish to ${branch}.`,
      };
    case "noLibrary":
      return {
        kind: "warn",
        title: `Couldn't undo the removal of ${name}`,
        body: machineWords(`This project's shared library isn't set up on this Mac any more.`),
      };
    case "notQueued":
      return {
        kind: "warn",
        title: `${name} was already removed from ${branch}`,
        body: `Your project folder still has it: Publish to ${branch} brings it back.`,
      };
  }
}

/**
 * The busy key of the section's own action.
 *
 * Not a row key: `Make all available to both` is one action about the whole
 * section, and hanging it on the first row's key would disable that row's button
 * and nothing else while every skill was being carried over.
 */
const SECTION_BUSY = "section:make-all-both";
/** Skills hub H3b: the busy key of the section's **Link all**. */
const LINK_ALL_BUSY = "section:link-all";
/** The `New skill…` flow's key and busy key: there is no row yet. */
const NEW_SKILL_KEY = "new-skill";

/**
 * The other scope's copy of the same name.
 *
 * `plugin` comes with it, because the notice's sentence names how the team's copy
 * reaches the agents (`<plugin>:<name>`) and only the team's row knows the
 * plugin. Its **text** does not come from here: the Library read both halves of
 * every duplicate pair once (`useSkillsData.pairTexts`), so the row's action and
 * the page's notice are answering from the same bytes.
 */
function twinOf(
  row: SkillRowModel,
  all: SkillRowModel[],
): { scope: Scope; plugin: string | null } | null {
  const other = row.duplicate?.other;
  if (!other) return null;
  const twin = all.find((r) => r.name === row.name && r.scope === other);
  if (!twin) return null;
  return { scope: other, plugin: twin.plugin };
}

/** A refusal in the backend's words: a `NotTheSameSkill` value, an Error, or the string a command rejects with. */
function errorWords(cause: unknown): string {
  return asNotTheSameSkill(cause)?.message ?? String((cause as Error)?.message ?? cause);
}
