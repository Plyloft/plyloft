import { useEffect } from "react";
import { startSettingsSubscription, useSettings } from "../store/settingsStore";
import { useColorScheme } from "../hooks/useColorScheme";
import { useWorkspaces } from "../store/workspaceStore";
import { entryById, scopeLabelOf, type EntryId, type Scope } from "../lib/settingsNav";
import { RepositoryBuildRelease, RepositoryGeneral } from "./RepositorySettings";
import { AreasPage } from "./settings/AreasPage";
import { ShippingPage } from "./settings/ShippingPage";
import { AppearancePage, EditorTerminalsPage, NotificationsPage } from "./settings/ThisMacPages";
import { BuildsRunsPage } from "./settings/BuildsRunsPage";
import { DictationPage } from "./settings/DictationPage";
import { BoardPage } from "./settings/BoardPage";
import { WorktreesPage } from "./settings/WorktreesPage";
import { TeamPage } from "./settings/TeamPage";
import { PlanPage } from "./settings/PlanPage";
import type { AdoptionStatus } from "../lib/adoption";
import { ProfilePage } from "./settings/ProfilePage";
import { SetupPage } from "./settings/SetupPage";
import { DiagnosticsPage } from "./settings/DiagnosticsPage";
import { Group, Page, PageHeader, Row, ScopeLabelProvider, StatusLine } from "./ux";
import "../App.css";

/**
 * UX language cards 1, 2 and 8 (ADR 0004): **one page per navigation entry**,
 * and this file is the router that picks it.
 *
 * Card 1 gave every entry the new header with the old panel under it; card 2
 * rewrote the two Repository pages; card 8 (GH #103) rewrote the rest. So there
 * is nothing left here but the choice of page — no draft, no `Save` / `Discard`
 * footer, no `Field`. The This Mac pages save as they change and offer Undo
 * (`settings/useMacSettings.ts`, PATTERNS.md §5); the Repository pages edit in
 * place and publish (`RepositoryPage.tsx`). The three old panels that used to
 * sit under Advanced — Agents, Role bindings, Swarm templates — were retired
 * (GH #171, ADR 0001); a link to one lands on Claude and Codex, which says so
 * (`settingsNav.ts::RETIRED_LINKS`).
 *
 * C9 (UX-9.3): entries in groups; the merges became sections of one page,
 * or parts under one header (`MergedPage`). Launch A3 added Plan and retired
 * the Licence part, so Profile is one page again. 1.174.0 (DS1): the groups
 * are tasks — Look and feel, Cards, Project, Team, Setup and account —
 * Notifications is a page again, and the Board part is drawn on General.
 * Every page says its group's name above its title (`ScopeLabelProvider`),
 * and every section where its rows are kept (`Section scope`).
 *
 * The shell around it is `SettingsOverlay`.
 */
export function SettingsApp({
  entry,
  hiddenNote = null,
  boardSetByRepository = false,
  boardAdoption = null,
  boardReading = false,
}: {
  entry: EntryId;
  /** A link asked for something this page cannot show as asked, and landed
   *  here: a retired page, or a row the page does not draw. */
  hiddenNote?: string | null;
  /** The active repository's shared definition sets its board. */
  boardSetByRepository?: boolean;
  /** OB-8 review 2: the active workspace's adoption status (Board's
   *  "Kept on this Mac"). */
  boardAdoption?: AdoptionStatus | null;
  /** Where the active workspace's cards live is being read. */
  boardReading?: boolean;
}) {
  useColorScheme();
  const load = useSettings((s) => s.load);

  useEffect(() => {
    load().catch(() => {});
    startSettingsSubscription().catch(() => {});
  }, [load]);

  // QoL 1.168 G16, 1.174.0 (DS1, P27): the line above the title is the
  // page's group, and a page that edits the project names it — the active
  // workspace: "Cards · notes-app", "Project · notes-app".
  const activeName = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? null);
  const placed = scopeLabelOf(entry, activeName);
  return (
    <ScopeLabelProvider value={placed}>
      <EntryPage
        entry={entry}
        hiddenNote={hiddenNote}
        boardSetByRepository={boardSetByRepository}
        boardAdoption={boardAdoption}
        boardReading={boardReading}
      />
    </ScopeLabelProvider>
  );
}

function EntryPage({
  entry,
  hiddenNote,
  boardSetByRepository,
  boardAdoption,
  boardReading,
}: {
  entry: EntryId;
  hiddenNote: string | null;
  boardSetByRepository: boolean;
  boardAdoption: AdoptionStatus | null;
  boardReading: boolean;
}) {
  const activeWs = useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId));
  const scope = entryById(entry).scope;
  const page = { scope, hiddenNote };

  switch (entry) {
    // ── Look and feel ────────────────────────────────────────────────────
    case "appearance":
      return <AppearancePage key={entry} {...page} />;
    case "editor-terminals":
      return <EditorTerminalsPage key={entry} {...page} />;
    case "notifications":
      return <NotificationsPage key={entry} {...page} />;
    case "dictation":
      return <DictationPage key={entry} {...page} />;

    // ── Cards ────────────────────────────────────────────────────────────
    case "claude-codex":
      return <BuildsRunsPage key={entry} {...page} />;

    // ── The project's pages (card 2: they own their header and publish bar;
    //    with no shared definition they say they are this Mac's own) ───────
    case "general":
      return activeWs ? (
        <RepositoryGeneral
          key={activeWs.id}
          workspaceId={activeWs.id}
          {...page}
          // A row of the Board part may be about to appear (a link landing on it).
          boardUnread={boardReading && !boardAdoption}
          board={
            <BoardPage
              scope={scope}
              workspaceId={activeWs.id}
              setByRepository={boardSetByRepository}
              adoption={boardAdoption}
              reading={boardReading}
            />
          }
        />
      ) : (
        <NoWorkspace
          entry={entry}
          {...page}
          what="see what it is called and where its cards come from"
        />
      );
    case "build-release":
      return activeWs ? (
        <RepositoryBuildRelease
          key={activeWs.id}
          workspaceId={activeWs.id}
          cwd={activeWs.cwd}
          {...page}
        />
      ) : (
        <NoWorkspace entry={entry} {...page} what="configure how it builds and ships" />
      );
    // 1.173.0 G1: how a card's change leaves this Mac and goes live.
    case "shipping":
      return activeWs ? (
        <ShippingPage key={activeWs.id} workspaceId={activeWs.id} cwd={activeWs.cwd} {...page} />
      ) : (
        <NoWorkspace entry={entry} {...page} what="see how its cards ship and go live" />
      );
    // 1.173.0 B5: one repository, several products.
    case "areas":
      return activeWs ? (
        <AreasPage key={activeWs.id} workspaceId={activeWs.id} {...page} />
      ) : (
        <NoWorkspace entry={entry} {...page} what="set up the parts of it that ship on their own" />
      );
    case "board-worktrees":
      return activeWs ? (
        <WorktreesPage key={activeWs.id} {...page} workspaceId={activeWs.id} />
      ) : (
        <NoWorkspace entry={entry} {...page} what="see its cards' copies" />
      );

    // ── Team ─────────────────────────────────────────────────────────────
    case "team-workspaces":
      return <TeamPage key={entry} {...page} />;

    // ── Setup and account ────────────────────────────────────────────────
    case "setup":
      return <SetupPage key={entry} {...page} />;
    case "diagnostics":
      return <DiagnosticsPage key={entry} {...page} />;
    case "plan":
      return <PlanPage key={entry} {...page} />;
    case "profile-licence":
      return <ProfilePage key={entry} {...page} />;
  }
}

/** A page about one workspace, with none open. */
function NoWorkspace({
  entry,
  scope,
  hiddenNote,
  what,
}: {
  entry: EntryId;
  scope: Scope;
  hiddenNote: string | null;
  what: string;
}) {
  const e = entryById(entry);
  return (
    <Page>
      <PageHeader
        scope={scope}
        title={e.label}
        lede={e.lede}
        status={hiddenNote && <StatusLine state="empty">{hiddenNote}</StatusLine>}
      />
      <Group>
        <Row kind="value" label="No workspace is open" hint={`Open one to ${what}.`} />
      </Group>
    </Page>
  );
}
