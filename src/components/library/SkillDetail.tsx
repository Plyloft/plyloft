import { useEffect, useId, useMemo, useRef, useState } from "react";
import { HeldVersion } from "./HeldVersion";
import { useAllSkills } from "../../store/allSkillsStore";
import { usedIn, usedInLine } from "../../lib/allSkills";
import { invoke } from "@tauri-apps/api/core";
import {
  AvailabilityChips,
  BackLink,
  CBtn,
  Details,
  DuplicateChip,
  Group,
  MoreMenu,
  Row,
  RowValue,
  ScopeBadge,
  Section,
  StatusLine,
  Toggle,
  type MenuItem,
} from "../ux";
import { SkillCompare } from "./SkillCompare";
import { InlineMd } from "../InlineMd";
import {
  COMPARE_CHECKOUT_SIDE,
  COMPARE_THIS_SIDE,
  PLY_SWITCH_GROUP,
  PLY_SWITCH_HINT,
  PLY_SWITCH_LABEL,
  SCOPE_NAV_LABEL,
  SCOPE_PLACE,
  NO_CUT,
  compareActions,
  fileListCutLine,
  fileListShort,
  LISTED_DEPTH,
  LISTED_FILES,
  LISTED_FOLDERS,
  reachCompareActions,
  skillBody,
  skillPage,
  type CompareAction,
  type FileListCut,
  type SkillHistoryFacts,
  type SkillMenuEntry,
  type SkillPageAction,
  type SkillRow as SkillRowModel,
} from "../../lib/librarySkills";
import { contentId, isSilenced, type DuplicateIdentity, type SilencedDuplicate } from "../../lib/libraryMute";
import { SCOPE_BADGE, type Scope } from "../../lib/uxScope";
import { OPEN_IN_CODE, READ_IN_CODE } from "../../lib/readOnlyFile";
import { skillHistory } from "../../ipc";
import type { DirEntry } from "../../types";
import { LibraryErrorBlocks } from "../errors/LibraryErrorBlocks";
// GH #104: the Challenger's one suggested change, above this page's header.
import { ProposalBlock } from "./ProposalBlock";
import type { ProposalView } from "../../lib/proposals";
import { platformWord } from "../../lib/platform";
import { joinPath } from "../../lib/paths";
import { otherCopyOf } from "../../lib/skillOtherCopy";
import { useSolo } from "../../store/workModeStore";
import { PlySwitchSection, PlyVersionLines, type WorkspaceChoice } from "./PlySwitchSection";

/**
 * UX language card 5 (GH #100; BOARDS.md §4, Board 3 **as corrected**): a
 * skill's own page.
 *
 * `← Skills`, the scope badge, the mono name, the whole description, the fact
 * line, one primary action with the `⋯`, the duplicate notice with no winner and
 * `Compare` under it, `Its files`, `What it tells the agent` as reading text, and
 * `Details`.
 *
 * Everything the page *says* is decided by `lib/librarySkills.ts::skillPage`;
 * this file reads the files and draws. In particular `openInCode` remains the
 * one field that decides whether the editor is offered — for the primary button
 * and for the file rows alike. GH #96 review 1 found a second derivation here
 * that let the page open the **team clone**, which `TeamStore::sync` pulls
 * `--ff-only`: one ⌘S there would stop every later refresh.
 *
 * It reads its **own** directory — the file list, and the text the last section
 * renders. The two texts a duplicate needs are handed in (`pairText`,
 * `twinText`): the Library reads both halves of a pair once, because the row's
 * action in the list and the notice here are the same question — has `Keep both`
 * silenced this pair? — and one question gets one answer.
 */
export function SkillDetail({
  row,
  twin,
  twinText,
  pairText,
  textsRead,
  workspaceId,
  silencedHere,
  identical = false,
  compareOpen,
  branch,
  driftText,
  proposal,
  proposalBusy,
  onProposalApprove,
  onProposalDismiss,
  generation,
  busy,
  onBack,
  onOpenFile,
  onPrimary,
  onMenu,
  onCompareOpen,
  onCompareAction,
  onReveal,
  onSwitch,
  onPlyWorkspace,
  onPlyTeam,
  onPersonalize,
}: {
  /** The row, with `dir` already absolute. */
  row: SkillRowModel;
  /** The other scope's copy of this name: which scope, and its team plugin. */
  twin: { scope: Scope; plugin: string | null } | null;
  /**
   * The other copy's `SKILL.md`, read once by the Library for both halves of the
   * duplicate (`useSkillsData.pairTexts`). `null` when there is no other copy, or
   * when Ply could not read it.
   */
  twinText: string | null;
  /**
   * This copy's `SKILL.md` **from that same read**, when it is one half of a
   * pair. The mute's key is built from it rather than from this page's own read,
   * so the row's action and this page's notice can never disagree about whether
   * `Keep both` still holds. `null` outside a pair, or when unread.
   */
  pairText: string | null;
  /** Those reads have answered, however they answered. */
  textsRead: boolean;
  workspaceId: string;
  /** What `Keep both` has silenced on this Mac (`settings.library`). */
  silencedHere: readonly SilencedDuplicate[];
  /**
   * Decision §6 (group B): this copy and its twin are the same whole tree
   * (`useSkillsData.identicalPairs`) — quiet like a `Keep both`, until either
   * copy changes.
   */
  identical?: boolean;
  /** Which comparison is showing, if either (GH #105: two pairs of files). */
  compareOpen: "duplicate" | "reach" | null;
  /** The integration branch, for the drift notice's sentence. */
  branch: string | null;
  /**
   * GH #105: the branch's two copies of this skill, read once by the Library
   * (`useSkillsData.driftTexts`) when the row says they disagree. `null` outside
   * that case; a side Ply could not read is `null` and the comparison says so.
   */
  driftText: { claude: string | null; codex: string | null } | null;
  /**
   * GH #104 (BOARDS.md §4 state C): the Challenger's improvement proposal about
   * **this** skill, or `null`. Decided by `proposals::proposalIsFor` in the
   * page above, so one proposal is drawn in exactly one place.
   */
  proposal: ProposalView | null;
  proposalBusy: boolean;
  onProposalApprove: () => void;
  onProposalDismiss: () => void;
  /**
   * Bumped every time the Library has read its facts again — on becoming the
   * visible mode, on a publish, on a refresh that brought a teammate's change.
   *
   * The two `SKILL.md` are read again with it, and that is what makes `Keep both`
   * end by itself: `Edit in Code` leaves this page mounted, so without it a copy
   * edited in the editor would still hash to what it hashed to when the button
   * was pressed, and the notice would stay quiet about the very edit it is meant
   * to report.
   */
  generation: number;
  busy: boolean;
  onBack: () => void;
  /**
   * Opens one of its files in Code.
   *
   * GH #142: for every scope now, not only a `openInCode` row — the page decides
   * from the same row whether that tab is writable or a reading view
   * (`skillFileMode`), so this stays one call with one path.
   */
  onOpenFile: (path: string) => void;
  onPrimary: (action: SkillPageAction) => void;
  onMenu: (entry: SkillMenuEntry) => void;
  onCompareOpen: (open: boolean, what?: "duplicate" | "reach") => void;
  /** `identity` is the mute's key, and is present only once both copies are
   *  read — which is the only state in which the actions are drawn. */
  onCompareAction: (action: CompareAction, identity: DuplicateIdentity | null) => void;
  onReveal: (dir: string) => void;
  /** GH #106: a Ply skill's switch. Never called for another scope. */
  onSwitch: (on: boolean) => void;
  /** Skills hub H9 (R9): this workspace's choice for a Plyloft skill. */
  onPlyWorkspace?: (choice: WorkspaceChoice) => void;
  /** …the team default (`true`: off for the team). */
  onPlyTeam?: (off: boolean) => void;
  /** …and Personalize. */
  onPersonalize?: () => void;
}) {
  // GH #96 review 1's blocker, unchanged: the one fact for a tab Code may
  // **save**. GH #142's other half — whether a row that is not savable still
  // opens, as a reading view — is `skillFileMode`, applied by the page that
  // turns a path into a tab, so this file goes on deciding nothing.
  const openable = row.openInCode;
  // Walk F5: solo mode has no team library, so the page names none.
  const solo = useSolo();
  const [files, setFiles] = useState<FileFact[] | null>(null);
  /** What kept the file list from being the whole tree, if anything. */
  const [filesCut, setFilesCut] = useState<FileListCut>(NO_CUT);
  const [body, setBody] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SkillHistoryFacts | null>(null);
  const noticeId = useId();
  const driftId = useId();

  const dir = row.dir;
  // Team walk 2026-10-01 (F4): a checkout skill's other CLI's copy, listed
  // under Its files so a pair that disagrees can be made to match from here.
  const other =
    row.scope === "repository" && row.openInCode && !row.fromMirror
      ? otherCopyOf(dir, row.name)
      : null;
  const otherDir = other?.dir ?? null;
  const [otherFiles, setOtherFiles] = useState<FileFact[] | null>(null);
  /** Which skill the state on screen belongs to. */
  const showing = useRef<string | null>(null);

  // Its own directory: the file list, and the text `What it tells the agent`
  // renders. The **other** copy is not read here — the Library read both halves
  // of the pair once, for the row's action and for this page alike.
  useEffect(() => {
    let cancelled = false;
    // Blanked only when this is a **different** skill. A re-read of the same one
    // (a `generation` bump) replaces the values in place: clearing them would
    // flash an empty page every time the member came back from Code.
    if (showing.current !== dir) {
      showing.current = dir;
      setFiles(null);
      setFilesCut(NO_CUT);
      setBody(null);
      setHtml(null);
      setError(null);
    }
    if (!dir) return;
    void (async () => {
      const mine = await readSkillDir(dir);
      if (cancelled) return;
      setFiles(mine.files);
      setFilesCut(mine.cut);
      setBody(mine.text);
      setError(mine.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [dir, generation]);

  useEffect(() => {
    let cancelled = false;
    setOtherFiles(null);
    if (!otherDir) return;
    // Absent is the usual answer (one CLI's copy only): nothing is listed.
    void readSkillDir(otherDir).then((read) => {
      if (!cancelled) setOtherFiles(read.files);
    });
    return () => {
      cancelled = true;
    };
  }, [otherDir, generation]);

  // Who last changed it, and when — from the branch history, in Rust, read-only.
  // A scope with no repository behind it answers with every field empty, and the
  // fact line then leaves that part out rather than inventing it.
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Same rule as the file read: another skill's answer must not be shown as
    // this one's, and a re-read of the same skill must not blank the fact line.
    const key = `${workspaceId}\u0000${row.scope}\u0000${row.name}`;
    if (askedFor.current !== key) {
      askedFor.current = key;
      setHistory(null);
    }
    void skillHistory(workspaceId, row.scope, row.name, row.plugin)
      .then((found) => {
        if (!cancelled) setHistory(found);
      })
      .catch(() => {
        // Not an error the page shows: the fact line simply has one item fewer.
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, row.scope, row.name, row.plugin, generation]);

  // The rendered text, never code (BOARDS.md §4), with the frontmatter off.
  // Lazily, so the markdown chunk stays out of the main bundle.
  useEffect(() => {
    let cancelled = false;
    if (body == null) {
      setHtml(null);
      return;
    }
    void import("../../lib/markdown")
      .then(({ renderMarkdown }) => {
        if (!cancelled) setHtml(renderMarkdown(skillBody(body)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [body]);

  /** The mute's key: this pair, this name, the content id of each copy. */
  const identity: DuplicateIdentity | null = useMemo(() => {
    if (!row.duplicate || pairText == null || twinText == null) return null;
    return {
      here: row.scope,
      there: row.duplicate.other,
      name: row.name,
      hereContent: contentId(pairText),
      thereContent: contentId(twinText),
    };
  }, [row.duplicate, row.scope, row.name, pairText, twinText]);

  const silenced = identical || (identity != null && isSilenced(silencedHere, identity));
  // How far Ply has got with the two copies of a duplicated name. `pending` keeps
  // the notice away while the answer is unknown — a notice that appears and then
  // vanishes said something untrue for a moment — and `missing` replaces it with
  // the sentence that says Ply cannot tell whether they still match, because its
  // one action needs both content ids (review 1).
  const copies: "pending" | "read" | "missing" = !row.duplicate
    ? "read"
    : !textsRead
      ? "pending"
      : pairText != null && twinText != null
        ? "read"
        : "missing";
  // 1.174.2: where All skills says this personal skill is used, in its words.
  const hubRows = useAllSkills((s) => s.rows);
  const hubNames = useAllSkills((s) => s.names);
  const hubTeam = useAllSkills((s) => s.index.team?.repo ?? null);
  const hubMyLibrary = useAllSkills((s) => s.index.myLibrary?.repo ?? null);
  const usedInWords = useMemo(() => {
    if (row.scope !== "this-mac") return null;
    const hub = hubRows.find((candidate) => candidate.key === `thisMac:${row.name}`);
    if (!hub) return null;
    const used = usedIn(hub, hubNames, hubTeam, hubMyLibrary);
    return used.count > 0 ? usedInLine(hub, used) : null;
  }, [row.scope, row.name, hubRows, hubNames, hubTeam, hubMyLibrary]);
  const page = skillPage({
    row,
    usedIn: usedInWords,
    files: files?.length ?? null,
    filesMore: fileListShort(filesCut),
    history,
    // The **other** side's plugin; this side's is on the row (review 1), so a
    // pair where both arrive inside a plugin qualifies both names.
    plugin: twin?.plugin ?? null,
    silenced,
    branch,
    copies,
    nowMs: Date.now(),
    solo,
  });
  const notice = page.notice;
  const cutLine = fileListCutLine(filesCut);
  // Which comparison is on screen — the one its notice's Compare would open.
  const duplicateShown = compareOpen === "duplicate" && row.duplicate != null && twin != null;
  const reachShown = compareOpen === "reach" && row.drift != null;
  const primary = page.primary;

  const menuItems: MenuItem[] = page.menu.map((entry) =>
    entry === "divider"
      ? "divider"
      : {
          label: entry.label,
          danger: "danger" in entry ? entry.danger : undefined,
          // F4: an entry shown off, with its reason under it.
          disabled: "disabled" in entry ? entry.disabled : undefined,
          hint: "hint" in entry ? entry.hint : undefined,
          onSelect: () => onMenu(entry),
        },
  );

  return (
    <>
      <BackLink label="Skills" onClick={onBack} />
      {/* "A block above the header" (BOARDS.md §4 state C) — above it, because
          it is about this file and not about the page's own state. */}
      {proposal && (
        <ProposalBlock
          view={proposal}
          busy={proposalBusy}
          onApprove={onProposalApprove}
          onDismiss={onProposalDismiss}
          nowMs={Date.now()}
        />
      )}
      <header className="ux-page-header">
        <ScopeBadge scope={row.scope} />
        {/* GH #106, BOARDS.md §6: a Plyloft skill's name is "a plain title (not
            mono)". It is the `SKILL.md`'s own heading — a sentence, which mono
            would read as a path. */}
        <h1 className={row.ply ? "ux-skill-name ux-skill-name--plain" : "ux-skill-name"}>
          {row.ply?.title ?? row.name}
        </h1>
        <p className="ux-page-lede">{row.description}</p>
        <div className="ux-skill-facts">
          {/* §6 asks a Plyloft skill's fact line for both availability chips rather
              than the one `Reaches …` chip the other scopes' pages carry: these
              skills reach both CLIs, and the two chips are how the sections say
              so everywhere else. */}
          {row.ply ? (
            <AvailabilityChips claude={row.claude} codex={row.codex} />
          ) : (
            page.reach && <span className="cchip ux-avail-chip ux-fact-chip">{page.reach}</span>
          )}
          {page.facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
        {/* Skills hub H9 (R9; mockup 7): Personalize, beside the version. */}
        {row.ply && onPersonalize && (
          <div className="ux-skill-facts">
            <CBtn size="sm" tone="strong" disabled={busy} onClick={onPersonalize}>
              Personalize…
            </CBtn>
          </div>
        )}
      </header>
      {row.ply && <PlyVersionLines changes={row.ply.changes} />}
      {/* GH #102: the fast-forward refusal that names this skill. */}
      <LibraryErrorBlocks workspaceId={workspaceId} name={row.name} scope={row.scope} />
      {page.status && <StatusLine state="empty">{page.status}</StatusLine>}
      {/* What is happening to it right now (BOARDS.md §3 "Transient states"). The
          page said nothing about this before review 1, so a skill removed on the
          branch showed `Edit in Code` and no word about the removal. */}
      {page.transient && (
        <StatusLine state={page.transient.state}>{page.transient.line}</StatusLine>
      )}
      {/* Round 2 (G3): a held skill's page shows the version sessions use. */}
      {row.transient?.kind === "needsOk" && <HeldVersion plugin={row.transient.plugin} skill={row.name} />}
      {page.duplicateUnknown && (
        <StatusLine state="empty">{page.duplicateUnknown}</StatusLine>
      )}
      {/* What the row said under its hint — two copies that disagree, a root git
          ignores, the name Codex uses — is not dropped by opening the skill. */}
      {row.notes.map((note) => (
        <StatusLine key={note} state="empty">
          <InlineMd text={note} links={false} />
        </StatusLine>
      ))}
      {error && (
        <StatusLine state="aborted">
          Plyloft could not read this skill's files. Nothing was changed. {error}
        </StatusLine>
      )}
      {notice && (
        <div className="ux-notice">
          <div className="ux-notice-head">
            <DuplicateChip>{notice.chip}</DuplicateChip>
          </div>
          <p id={noticeId} className="ux-notice-text">
            {notice.sentence}
          </p>
          {/* GH #312: once the comparison is open, Compare would do nothing —
              and a button that cannot do anything is not offered (PATTERNS.md
              §3); `Hide` sits on the comparison's own heading. */}
          {!duplicateShown && (
            <div className="ux-notice-actions">
              {/* The notice's one action (BOARDS.md §4). It is described by the
                  sentence above it, so a reader who reaches the button first still
                  hears what the two copies are. Putting the comparison away is the
                  comparison's own control: once `Keep both` has silenced the
                  notice, this block is gone and that one is not. */}
              <CBtn
                tone="strong"
                size="sm"
                aria-describedby={noticeId}
                onClick={() => onCompareOpen(true)}
              >
                Compare
              </CBtn>
            </div>
          )}
        </div>
      )}
      {/* GH #105: the branch's own two copies disagree. Its own notice, because
          it is its own fact and its own pair of files — a skill can be both a
          duplicate of another scope's and out of step with itself. */}
      {page.reachNotice && (
        <div className="ux-notice">
          <div className="ux-notice-head">
            <DuplicateChip>{page.reachNotice.chip}</DuplicateChip>
          </div>
          <p id={driftId} className="ux-notice-text">
            {page.reachNotice.sentence}
          </p>
          {!reachShown && (
            <div className="ux-notice-actions">
              <CBtn
                tone="strong"
                size="sm"
                aria-describedby={driftId}
                onClick={() => onCompareOpen(true, "reach")}
              >
                Compare
              </CBtn>
            </div>
          )}
        </div>
      )}
      {(primary || menuItems.length > 0) && (
        <div className="ux-skill-actions">
          {primary && (
            <CBtn tone="accent" disabled={busy} onClick={() => onPrimary(primary)}>
              {primary.label}
            </CBtn>
          )}
          {menuItems.length > 0 && (
            // Inert with the primary: every entry here is a write or an open
            // that goes through the same busy key.
            <MoreMenu items={menuItems} label={`More for ${row.name}`} disabled={busy} />
          )}
          {page.beside && <span className="ux-skill-beside">{page.beside}</span>}
        </div>
      )}
      {duplicateShown && twin && row.duplicate && (
        <SkillCompare
          name={row.name}
          left={{
            // The board's own words for the copy whose page this is
            // (`Repository · in use here · 84 lines`); the other side keeps its
            // scope's meaning, as the board gives it.
            label: SCOPE_NAV_LABEL[row.scope],
            // Walk follow-ups 2026-10-19: the working copy, said so when a
            // Promote here shares the branch's instead (the note under it).
            meaning: row.promoteShares ? COMPARE_CHECKOUT_SIDE : COMPARE_THIS_SIDE,
            place: SCOPE_PLACE[row.scope],
            text: pairText,
          }}
          note={row.promoteShares && identity ? row.promoteShares : null}
          right={{
            label: SCOPE_NAV_LABEL[twin.scope],
            meaning: SCOPE_BADGE[twin.scope].meaning,
            place: SCOPE_PLACE[twin.scope],
            text: twinText,
          }}
          error={
            textsRead && (pairText == null || twinText == null)
              ? "Plyloft could not read one of the two SKILL.md from here."
              : null
          }
          actions={identity ? compareActions(row) : []}
          busy={busy}
          onAction={(action) => onCompareAction(action, identity)}
          onHide={() => onCompareOpen(false)}
        />
      )}
      {/* GH #105: the same view for the branch's Claude and Codex copies. The
          two sides are named by the root each CLI reads, so the summary sentence
          says "2 lines only in .claude/skills" rather than "on the left" — under
          760 px of column the groups stack and there is no left. */}
      {reachShown && (
        <SkillCompare
          name={row.name}
          left={{
            label: "Claude",
            meaning: `.claude/skills/${row.name}`,
            place: "in .claude/skills",
            text: driftText?.claude ?? null,
          }}
          right={{
            label: "Codex",
            meaning: `.agents/skills/${row.name}`,
            place: "in .agents/skills",
            text: driftText?.codex ?? null,
          }}
          error={
            driftText && (driftText.claude == null || driftText.codex == null)
              ? `Plyloft could not read both copies out of ${branch ?? "the integration branch"}.`
              : null
          }
          actions={reachCompareActions(row)}
          busy={busy}
          onAction={(action) => onCompareAction(action, null)}
          onHide={() => onCompareOpen(false, "reach")}
        />
      )}
      {/* GH #106, BOARDS.md §6: the switch, in its own group, above the text it
          decides. Per Mac and not per workspace, which the hint says in words —
          so it is offered even where the repository is read-only: nothing here
          is published, and nobody else is affected. */}
      {/* Skills hub H9 (R9): the three levels, where a workspace was read. */}
      {row.ply?.switch && row.ply.place && onPlyWorkspace && onPlyTeam && (
        <PlySwitchSection
          name={row.name}
          sw={row.ply.switch}
          place={row.ply.place}
          busy={busy}
          onWorkspace={onPlyWorkspace}
          onTeam={onPlyTeam}
          onMac={onSwitch}
        />
      )}
      {row.ply && !(row.ply.switch && row.ply.place && onPlyWorkspace && onPlyTeam) && (
        <Section title={PLY_SWITCH_GROUP}>
          <Group label={PLY_SWITCH_GROUP}>
            <Row
              kind="toggle"
              label={PLY_SWITCH_LABEL}
              hint={PLY_SWITCH_HINT}
            >
              {/* Named and described by the row through `RowContext`, whose ids
                  are `useId`s — every warmed workspace keeps its own host
                  mounted, so two of these can be in the document at once. */}
              <Toggle checked={row.ply.on} onChange={onSwitch} />
            </Row>
          </Group>
        </Section>
      )}
      {/* Not on a Plyloft skill's page: §6 lists the switch, the rendered text and
          `Details`, and there is nothing to open — the one file is the app's. */}
      {!row.ply && files && files.length > 0 && (
        <Section
          title="Its files"
          count={
            fileListShort(filesCut)
              ? `${files.length + (otherFiles?.length ?? 0)}+`
              : files.length + (otherFiles?.length ?? 0)
          }
        >
          {cutLine && <StatusLine state="empty">{cutLine}</StatusLine>}
          <Group label="Its files">
            {[
              ...files.map((file) => ({
                key: file.name,
                label: file.name,
                hint: file.lines != null ? lineWords(file.lines) : undefined,
                // GH #142: every file of every scope opens; what differs is
                // whether the tab can be saved. `dir` is the guard that is
                // left — without it there is no path, and without a path
                // there was nothing to list either.
                path: dir ? joinPath(dir, file.name) : null,
              })),
              // F4: the other CLI's copy in the checkout, under the same rule —
              // listed only for a row `openable` already says may be saved.
              ...(other && otherDir
                ? (otherFiles ?? []).map((file) => ({
                    key: `other:${file.name}`,
                    label: `${other.root}/${row.name}/${file.name}`,
                    hint:
                      file.lines != null
                        ? `${other.owner}'s copy · ${lineWords(file.lines)}`
                        : `${other.owner}'s copy`,
                    path: joinPath(otherDir, file.name),
                  }))
                : []),
            ].map((item) => (
              <Row
                key={item.key}
                kind="value"
                mono
                label={item.label}
                hint={item.hint}
                onOpen={item.path ? () => onOpenFile(item.path!) : undefined}
              >
                <RowValue>{openable ? OPEN_IN_CODE : READ_IN_CODE}</RowValue>
              </Row>
            ))}
          </Group>
        </Section>
      )}
      {html != null && (
        <Section title="What it tells the agent">
          {/* Sanitized by `renderMarkdown` (DOMPurify) before it gets here. */}
          <div className="ux-reading" dangerouslySetInnerHTML={{ __html: html }} />
          {page.readingFooter && <p className="ux-reading-footer">{page.readingFooter}</p>}
        </Section>
      )}
      {(dir || page.detailsLine) && (
        <Details>
          {dir && <div className="ux-details-line">{dir}</div>}
          {page.detailsLine && <div className="ux-details-line">{page.detailsLine}</div>}
          {page.reveal && dir && (
            <div className="ux-details-action">
              <CBtn tone="quiet" size="sm" onClick={() => onReveal(dir)}>
                {platformWord("reveal")}
              </CBtn>
            </div>
          )}
        </Details>
      )}
    </>
  );
}

/** One file of a skill, with its length when Ply could read it as text. */
interface FileFact {
  name: string;
  /** `null` for a file Ply did not read (too big, or not text). */
  lines: number | null;
}

/** `84 lines` — the board's hint, minus the part Ply cannot know. */
function lineWords(lines: number): string {
  return lines === 1 ? "1 line" : `${lines} lines`;
}

/** Files Ply reads to count their lines: enough for a skill, not a source tree. */
const COUNTED_FILES = 12;
/** …and only while they plausibly are text. A `SKILL.md` is a few KB. */
const COUNTED_BYTES = 128 * 1024;
/**
 * Its files with their lengths, and its own `SKILL.md`.
 *
 * The whole tree, because that is what a Publish, an Install or a Promote
 * carries (`project_skills::read_tree`): a skill's `scripts/` and `references/`
 * are its files as much as `SKILL.md` is, and a list of the top folder alone
 * counted fewer files than travel. Hidden files are listed for the same reason
 * — the tree copy carries them. Each is named by its path under the skill
 * (`scripts/run.sh`), `/`-separated as the tree copy names it, and opened
 * through `joinPath`. Bounded (`LISTED_DEPTH`, `LISTED_FILES`,
 * `LISTED_FOLDERS`), and `cut` says what kept it short.
 *
 * A symlink is never followed and never listed: `fs_list_dir` marks it
 * (`isSymlink`) from the entry's own metadata, and the tree copy refuses one
 * outright, so it is counted in `cut.links` for the page to say so instead.
 *
 * The listing survives a failed text read: a directory with no readable
 * `SKILL.md` is a real state (a half-written skill, a permission), and hiding its
 * file list would leave the member the error alone to work from. A folder under
 * it that cannot be listed leaves the rest of the list standing.
 */
async function readSkillDir(dir: string): Promise<{
  files: FileFact[] | null;
  cut: FileListCut;
  text: string | null;
  error: string | null;
}> {
  let listed: { rel: string; size: number }[];
  let cut: FileListCut;
  try {
    ({ files: listed, cut } = await listTree(dir));
  } catch (cause) {
    return { files: null, cut: NO_CUT, text: null, error: String(cause) };
  }
  let text: string | null = null;
  let error: string | null = null;
  try {
    text = await invoke<string>("fs_read_text_file", { path: joinPath(dir, "SKILL.md") });
  } catch (cause) {
    error = String(cause);
  }
  const files: FileFact[] = [];
  let counted = 0;
  for (const file of listed) {
    if (file.rel === "SKILL.md") {
      files.push({ name: file.rel, lines: text == null ? null : countLines(text) });
      continue;
    }
    const readable = counted < COUNTED_FILES && file.size <= COUNTED_BYTES;
    if (readable) counted += 1;
    files.push({
      name: file.rel,
      lines: readable ? await countFileLines(joinPath(dir, file.rel)) : null,
    });
  }
  return { files, cut, text, error };
}

/**
 * Every file under `dir`, one depth at a time: a folder's own files before any
 * subfolder's, and each depth's folders listed together. Only the top folder's
 * listing may throw: without it there is no list at all.
 */
async function listTree(
  dir: string,
): Promise<{ files: { rel: string; size: number }[]; cut: FileListCut }> {
  const files: { rel: string; size: number }[] = [];
  const cut: FileListCut = { ...NO_CUT };
  let level = [{ at: dir, prefix: "" }];
  let depth = 0;
  let opened = 0;
  while (level.length > 0) {
    const listed = await Promise.all(
      level.map((folder) =>
        invoke<DirEntry[]>("fs_list_dir", { path: folder.at, includeHidden: true }).then(
          (entries) => ({ folder, entries, cause: null as unknown }),
          (cause: unknown) => ({ folder, entries: null, cause }),
        ),
      ),
    );
    const next: { at: string; prefix: string }[] = [];
    for (const { folder, entries, cause } of listed) {
      if (!entries) {
        if (depth === 0) throw cause;
        cut.unreadable += 1;
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymlink) {
          cut.links += 1;
          continue;
        }
        if (entry.isDir) {
          next.push({ at: joinPath(folder.at, entry.name), prefix: `${folder.prefix}${entry.name}/` });
          continue;
        }
        if (files.length >= LISTED_FILES) {
          cut.files = true;
          continue;
        }
        files.push({ rel: folder.prefix + entry.name, size: entry.size });
      }
    }
    depth += 1;
    if (next.length === 0) break;
    if (files.length >= LISTED_FILES) {
      cut.files = true;
      break;
    }
    if (depth > LISTED_DEPTH) {
      cut.depth = true;
      break;
    }
    const room = LISTED_FOLDERS - opened;
    if (next.length > room) {
      cut.folders = true;
      next.length = room;
    }
    opened += next.length;
    level = next;
  }
  return { files, cut };
}

async function countFileLines(path: string): Promise<number | null> {
  try {
    return countLines(await invoke<string>("fs_read_text_file", { path }));
  } catch {
    // A file that is not text has no line count, and that is not an error worth
    // a sentence: its row simply has no hint.
    return null;
  }
}

/** Lines as an editor counts them: a trailing newline ends the last line. */
function countLines(text: string): number {
  if (text === "") return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}
