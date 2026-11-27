// 1.173.0 (G1): Settings › Shipping — how a card's change leaves this Mac
// and goes live, in one place. 1.174.0 (DS2, P26; settings.html scenes 3, 4,
// 15) gathers the whole path of a card after the build, in the order things
// happen: Where cards go · Ship it · After shipping · Card branches ·
// Releases · How this goes live.
//
// Built on the Repository pages' shell (`RepositoryPage`) for its project
// rows — Cards go to, After a release, run, the default release (the
// repository's, or each area's within "areas") and the version files —
// published with Publish to <branch> where the repository shares its
// settings and saved here at once where it doesn't. Its draft is its own:
// Building and checking's rows never join its Review, nor these that page's.
// The Ship it and Card branches rows are this Mac's own (`workspaces.json`)
// and save as they change, whatever the repository allows. How this goes
// live is D2's sheet, opened from here.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  areasReleases,
  deployMapGet,
  openWebLink,
  projectConfigDetect,
  projectLocalOrigin,
  workspaceDefinitionBranches,
  type AreaRelease,
  type BranchChoices,
} from "../../ipc";
import {
  AFTER_SHIPPING,
  AREAS_BROKEN_HINT,
  CARD_BRANCHES,
  CHANGE_IN_AREAS,
  DEFAULT_RELEASE_LABEL,
  DELETE_CARD_BRANCHES_HINT,
  FIX_FAILING_CHECKS_HINT,
  GITHUB_DELETE_HEAD_BRANCHES,
  GITHUB_DELETES_OWN_BRANCH,
  GO_LIVE_OPEN,
  KEPT_AFTER_SHIPPING,
  KEPT_BRANCHES_SUB,
  RELEASES,
  RELEASES_PER_AREA_NOTE,
  FOLLOW_VALUE,
  SHIP_IT_SECTION,
  SHIPPING_LEDE,
  SHIPPING_TITLE,
  VERSION_FILES_AREAS_NOTE,
  WHERE_CARDS_GO,
  areasCardsGoHint,
  asReleaseKind,
  defaultReleaseChoices,
  followedReleaseKind,
  goLiveSummary,
  keptBranchesHint,
  releaseRowHint,
  showKeptLabel,
  takeShippingFind,
  handOffToShipping,
  withAreaReleaseKind,
  type GoLiveReading,
} from "../../lib/shippingPage";
import { GO_LIVE_TITLE } from "../../lib/goLive";
import { areaList, areaTitle } from "../../lib/areasPage";
import { IMPLICIT_AREA_ID } from "../../lib/areaPicker";
import { SHIPPING_ORDER, rowLabel } from "../../lib/repositoryPage";
import { FIX_CHECKS_NOT_ON_GITHUB, ONLY_ON_THIS_MAC } from "../../lib/putOnGithub";
import { useOnlyHere, usePutOnGithubPress } from "../PutOnGithubSheet";
import { usePutOnGithub } from "../../store/putOnGithubStore";
import { SHIP_VIA_CHOICES, SHIP_VIA_ROW_LABEL, shipViaChoice, shipViaHint, type ShipVia } from "../../lib/shipVia";
import { AUTO_FIX_DEFAULT_LABEL } from "../../lib/prAutoFix";
import { autoFixDefaultAsksHint } from "../../lib/builderPermissions";
import { KEPT_AFTER_SHIP, githubBranchSettingsUrl, githubRepoOf, keptBranches } from "../../lib/branchCleanup";
import { EMPTY_ARRAY } from "../../lib/empties";
import { linkDidNotOpen } from "../../lib/linkToast";
import { entryWords } from "../../lib/settingsNav";
import { machineWords } from "../../lib/platform";
import type { Scope } from "../../lib/uxScope";
import { useShipOffersPr } from "../../hooks/useDefaultReleaseKind";
import { useAreasView } from "../../store/areaStore";
import { useKanban } from "../../store/kanbanStore";
import { useSettings } from "../../store/settingsStore";
import { newCardBuilderVendor } from "../../lib/settingsShape";
import { pushToast } from "../../store/toastStore";
import { useUi } from "../../store/uiStore";
import { useReleaseScopes, useScopesReading } from "../../store/releaseScopeStore";
import { useWorkspaces } from "../../store/workspaceStore";
import { GoLiveSheet } from "../GoLiveSheet";
import { RepositoryPage, anchorOf, type RepositoryDraft } from "../RepositoryPage";
import { IntegrationBranchRow, InstallRow, ListRow, VersionFilesPage } from "../RepositorySettings";
import { CBtn, Group, MoreMenu, Row, Section, Select, Toggle } from "../ux";
import { pushErrorToast } from "../../lib/errorToast";

const NO_RELEASES: AreaRelease[] = [];
const VERSION_FILES_SUB = "version-files";

export function ShippingPage({
  workspaceId,
  cwd = "",
  hiddenNote = null,
  scope,
}: {
  workspaceId: string;
  /** The project folder, where Version files' picker opens. */
  cwd?: string;
  hiddenNote?: string | null;
  scope?: Scope;
}) {
  // What origin really offered (Cards go to's choices), and the branch a
  // workspace with none of its own falls back to on its first local save.
  const [discovery, setDiscovery] = useState<BranchChoices | null>(null);
  // What a scan of the repository found for After a release, run: the menu
  // never offers a script that doesn't exist. It reads and writes nothing.
  const [detected, setDetected] = useState<string | null>(null);
  // 1.175.0 F3 walk: read again once the project was put on GitHub (as
  // `useShipOffersPrReading` does), so Where cards go has its branches.
  const putCount = usePutOnGithub((s) => s.puts[workspaceId] ?? 0);
  useEffect(() => {
    let live = true;
    workspaceDefinitionBranches(workspaceId)
      .then((choices) => {
        if (live) setDiscovery(choices);
      })
      .catch((e) => {
        if (live) setDiscovery({ branches: [], defaultBranch: "", error: String(e), hasOrigin: false });
      });
    projectConfigDetect(workspaceId)
      .then((proposal) => {
        if (live) setDetected(proposal.config.installScript ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [workspaceId, putCount]);

  const back = entryWords("shipping").label;
  return (
    <RepositoryPage
      workspaceId={workspaceId}
      order={SHIPPING_ORDER}
      title={SHIPPING_TITLE}
      lede={machineWords(SHIPPING_LEDE)}
      hiddenNote={hiddenNote}
      scope={scope}
      fallbackBranch={discovery?.defaultBranch || null}
      subPages={{
        [VERSION_FILES_SUB]: {
          title: rowLabel("versionFiles"),
          lede: "The files whose version number is bumped together on every release. Plyloft found them by reading the repository; you can correct the list.",
          back,
        },
        [KEPT_BRANCHES_SUB]: {
          title: KEPT_AFTER_SHIPPING,
          lede: `${GITHUB_DELETES_OWN_BRANCH} ${GITHUB_DELETE_HEAD_BRANCHES}`,
          back,
        },
      }}
    >
      {(d) => {
        if (d.sub === VERSION_FILES_SUB)
          return <VersionFilesPage draft={d} cwd={cwd} workspaceId={workspaceId} onDetected={setDetected} />;
        if (d.sub === KEPT_BRANCHES_SUB) return <KeptBranchesPage workspaceId={workspaceId} />;
        return <ShippingBody d={d} workspaceId={workspaceId} discovery={discovery} detected={detected} />;
      }}
    </RepositoryPage>
  );
}

function ShippingBody({
  d,
  workspaceId,
  discovery,
  detected,
}: {
  d: RepositoryDraft;
  workspaceId: string;
  discovery: BranchChoices | null;
  detected: string | null;
}) {
  // G1 Challenger (6) of 1.170.0: the card's own reading of the project
  // (`CardOutcome.hasRemote`), so a GitHub Enterprise project reads as Ship
  // it does. null while it is read.
  const onGitHub = useShipOffersPr(workspaceId);
  // DS2 round 1: what Building and checking's shared Re-detect found for
  // these rows joins this page's draft, once.
  useEffect(() => {
    if (d.readOnly) return;
    // After the page's own effects: the draft takes an edit only once the
    // read that drew the rows has reached it. Refused, it waits for the next.
    const timer = window.setTimeout(() => {
      const find = takeShippingFind(workspaceId);
      if (!find) return;
      void d.setMany({ versionFiles: find.versionFiles, installScript: find.installScript }).then((ok) => {
        if (!ok) handOffToShipping(workspaceId, find);
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // Once, when the page has read the definition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
  return (
    <>
      <WhereCardsGo d={d} workspaceId={workspaceId} discovery={discovery} />
      <ShipIt workspaceId={workspaceId} onGitHub={onGitHub} />
      <Section title={AFTER_SHIPPING} scope="repository" shared={d.repo.shared}>
        <Group label={AFTER_SHIPPING}>
          <InstallRow draft={d} detected={detected} />
        </Group>
      </Section>
      <CardBranches workspaceId={workspaceId} d={d} />
      <Releases d={d} workspaceId={workspaceId} onGitHub={onGitHub} />
      <GoLive workspaceId={workspaceId} shared={d.repo.shared} />
    </>
  );
}

/** The areas the page draws (two or more ship on their own; one listed area
 *  is the whole repository's), and the branch each one's cards go to. */
function useAreaBranches(d: RepositoryDraft, workspaceId: string) {
  const view = useAreasView(workspaceId);
  const list = areaList(d.value("areas"));
  const workspaceBranch = view?.workspaceBranch || d.repo.branch;
  const branchOf = (id: string, own?: string | null) =>
    view?.areas.find((a) => a.id === id)?.branch ?? own ?? workspaceBranch;
  return { view, list, workspaceBranch, branchOf };
}

// ── Where cards go ──────────────────────────────────────────────────────

function WhereCardsGo({
  d,
  workspaceId,
  discovery,
}: {
  d: RepositoryDraft;
  workspaceId: string;
  discovery: BranchChoices | null;
}) {
  const { list, branchOf } = useAreaBranches(d, workspaceId);
  return (
    <Section title={WHERE_CARDS_GO} scope="repository" shared={d.repo.shared}>
      <Group label={WHERE_CARDS_GO}>
        {list.length >= 2 ? (
          // With areas, each area's cards go where the area says: a summary
          // here, the choice in Areas (P37).
          <Row
            kind="procedure"
            label={rowLabel("integrationBranch")}
            anchor={anchorOf("integrationBranch")}
            hint={areasCardsGoHint(list.map((a) => ({ name: areaTitle(a), branch: branchOf(a.id, a.targetBranch) })))}
            action={
              <CBtn onClick={() => useUi.getState().openSettingsSection("areas", { workspaceId })}>
                {CHANGE_IN_AREAS}
              </CBtn>
            }
          />
        ) : (
          <IntegrationBranchRow draft={d} discovery={discovery} />
        )}
      </Group>
    </Section>
  );
}

// ── Ship it ─────────────────────────────────────────────────────────────

function ShipIt({ workspaceId, onGitHub }: { workspaceId: string; onGitHub: boolean | null }) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const fixFailingChecks = ws?.fixFailingChecks ?? false;
  // 1.172.0 (A2): said while new cards' Builder asks before every change.
  // 1.175.0 F9 (I1): named for the AI that builds new cards.
  const newVendor = useSettings((s) => newCardBuilderVendor(s.settings.behavior));
  const asksHint = autoFixDefaultAsksHint(useSettings((s) => s.settings.behavior.builderPermissions), newVendor);
  return (
    <Section title={SHIP_IT_SECTION} scope="this-mac">
      <Group label={SHIP_IT_SECTION}>
        <ShipViaRow workspaceId={workspaceId} onGitHub={onGitHub} />
        {/* 1.175.0 F3: shown again, off, with why. */}
        <Row
          kind="toggle"
          label={AUTO_FIX_DEFAULT_LABEL}
          disabled={onGitHub === false}
          hint={
            onGitHub === false
              ? FIX_CHECKS_NOT_ON_GITHUB
              : fixFailingChecks && asksHint
                ? `${FIX_FAILING_CHECKS_HINT} ${asksHint}`
                : FIX_FAILING_CHECKS_HINT
          }
        >
          <Toggle
            disabled={onGitHub === false}
            checked={onGitHub === false ? false : fixFailingChecks}
            onChange={(next) =>
              change("fix failing checks by itself", () =>
                useWorkspaces.getState().setFixFailingChecks(workspaceId, next),
              )
            }
          />
        </Row>
      </Group>
    </Section>
  );
}

function change(what: string, job: () => Promise<void>) {
  void job().catch((e) => pushErrorToast(`Couldn't change ${what}`, e));
}

/** G1 (1.170.0): how this workspace's Ship it ships — on GitHub (the default
 *  where the project is on GitHub) or only on this Mac. Kept on this Mac
 *  (`workspaces.json`), not in the shared definition. 1.174.0 (DS2, SL-5):
 *  its line says when the merge happens; there is no "Merge when checks
 *  pass" row any more. */
function ShipViaRow({ workspaceId, onGitHub }: { workspaceId: string; onGitHub: boolean | null }) {
  const saved = shipViaChoice(useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.shipVia));
  const [value, setValue] = useState<ShipVia>(saved);
  useEffect(() => setValue(saved), [saved]);
  // X6 (G1 Windows walk): with no GitHub, Ship it merges here whatever was
  // chosen — the field says so and is off; the line under it says why.
  const noGitHub = onGitHub === false;
  // 1.175.0 F3: only on this computer (no remote at all) — Put it on GitHub….
  const onlyHere = useOnlyHere(workspaceId, onGitHub) === true;
  const project = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const press = usePutOnGithubPress(workspaceId, project);
  return (
    <Row
      kind="choice"
      label="How Ship it ships"
      hint={machineWords(onlyHere ? ONLY_ON_THIS_MAC : shipViaHint(value, onGitHub))}
      action={
        onlyHere ? (
          <CBtn data-ply-put-on-github="settings" onClick={press.onPress}>
            {press.label}
          </CBtn>
        ) : undefined
      }
    >
      <Select
        value={noGitHub ? "local" : value}
        disabled={noGitHub}
        options={SHIP_VIA_CHOICES}
        label={SHIP_VIA_ROW_LABEL}
        onChange={(next) => {
          const via = next as ShipVia;
          setValue(via);
          void useWorkspaces
            .getState()
            .setShipVia(workspaceId, via)
            .catch((e) => {
              setValue(saved);
              pushErrorToast("Couldn't change how Ship it ships", e);
            });
        }}
      />
    </Row>
  );
}

// ── Card branches ───────────────────────────────────────────────────────

function CardBranches({ workspaceId, d }: { workspaceId: string; d: RepositoryDraft }) {
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const deleteBranches = !(ws?.keepCardBranches ?? false);
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_ARRAY);
  const kept = keptBranches(cards);
  return (
    <Section title={CARD_BRANCHES} scope="this-mac">
      <Group label={CARD_BRANCHES}>
        <Row
          kind="toggle"
          label="Delete card branches when their trash expires"
          // DS2 round 1: with no kept branch, the GitHub half is said here.
          hint={kept.length > 0 ? DELETE_CARD_BRANCHES_HINT : `${DELETE_CARD_BRANCHES_HINT} ${GITHUB_DELETES_OWN_BRANCH}`}
        >
          <Toggle
            checked={deleteBranches}
            onChange={(next) =>
              change("deleting card branches", () => useWorkspaces.getState().setDeleteCardBranches(workspaceId, next))
            }
          />
        </Row>
        {/* SL-3: the branches the cleanup kept, moved here from Cards'
            copies — only when there are some. */}
        {kept.length > 0 && (
          <Row
            kind="procedure"
            label="Kept after shipping"
            hint={keptBranchesHint(kept.map((k) => ({ afterShip: k.label === KEPT_AFTER_SHIP })))}
            action={<CBtn onClick={() => d.openSub(KEPT_BRANCHES_SUB)}>{showKeptLabel(kept.length)}</CBtn>}
          />
        )}
      </Group>
    </Section>
  );
}

/** Kept after shipping's sub-page: one row per branch the cleanup kept, and
 *  GitHub's own setting for the branches Plyloft never touches. */
function KeptBranchesPage({ workspaceId }: { workspaceId: string }) {
  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards ?? EMPTY_ARRAY);
  const kept = keptBranches(cards);
  // A local board's repository is its GitHub origin, when it has one.
  const ws = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId));
  const boardRepo = ws?.githubOwnerRepo ?? null;
  const wsKnown = ws != null;
  const [originRepo, setOriginRepo] = useState<string | null>(null);
  useEffect(() => {
    if (!wsKnown || githubBranchSettingsUrl(boardRepo)) return;
    let gone = false;
    projectLocalOrigin(workspaceId)
      .then((o) => {
        if (!gone) setOriginRepo(o?.githubRepo ?? null);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [workspaceId, wsKnown, boardRepo]);
  const githubSettings = githubBranchSettingsUrl(githubRepoOf(boardRepo, originRepo));
  const openGithub = (url: string) => void openWebLink(url).catch((e) => pushToast(linkDidNotOpen(url, e)));
  return (
    <Section
      title={CARD_BRANCHES}
      scope="this-mac"
      count={`${kept.length}`}
      action={
        githubSettings ? (
          <CBtn tone="quiet" size="sm" onClick={() => openGithub(githubSettings)}>
            Open the repository's settings
          </CBtn>
        ) : undefined
      }
    >
      <Group label={KEPT_AFTER_SHIPPING}>
        {kept.length === 0 && <Row kind="value" label="No card branch is kept now." />}
        {kept.map((k) => (
          <Row
            key={k.cardId}
            kind="item"
            label={k.title}
            hint={k.label}
            more={
              <MoreMenu
                label={`More for ${k.branch}`}
                items={[{ label: "Copy the branch name", onSelect: () => copy(k.branch) }]}
              />
            }
          />
        ))}
      </Group>
    </Section>
  );
}

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ── Releases ────────────────────────────────────────────────────────────

function Releases({ d, workspaceId, onGitHub }: { d: RepositoryDraft; workspaceId: string; onGitHub: boolean | null }) {
  const { view, list, workspaceBranch, branchOf } = useAreaBranches(d, workspaceId);
  // 1.174.0 (A1, SL-1c): a kind not chosen follows How Ship it ships; the
  // menu says so ("Same as Ship it (Tag and push)"), and nothing is saved
  // until the person chooses.
  const shipVia = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.shipVia);
  const followed = followedReleaseKind(shipVia, onGitHub);
  // Owner: "Same as Ship it" first, saved as none, so picking any kind —
  // the one it gives too — saves it.
  const choices = defaultReleaseChoices(followed).map((c) => ({ ...c, label: machineWords(c.label) }));
  // null until the tags are read: the rows say nothing about them before.
  const [releases, setReleases] = useState<AreaRelease[] | null>(null);
  useEffect(() => {
    let live = true;
    areasReleases(workspaceId)
      .then((r) => live && setReleases(r ?? NO_RELEASES))
      .catch(() => live && setReleases(NO_RELEASES));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  // 1.174.0 (DR6, P37): when each area's last tag was made, from what the
  // Release sheet reads (shared, read once when the page opens).
  const scopes = useScopesReading(workspaceId).scopes;
  useEffect(() => {
    void useReleaseScopes.getState().read(workspaceId);
  }, [workspaceId]);
  const latestAt = (areaId: string | null, tag: string | null | undefined): number | null => {
    const sc = scopes?.find((x) => x.area === areaId) ?? (scopes?.length === 1 ? scopes[0] : undefined);
    return sc && tag && sc.sinceTag === tag ? sc.sinceAt : null;
  };
  const base = areaList(d.repo.values.areas);
  const editable = !d.readOnly && !d.frozen;
  const broken = !!view && (view.held || view.problem !== null);
  const perArea = list.length >= 2;
  const versionFiles = (
    <ListRow
      draft={d}
      field="versionFiles"
      sub={VERSION_FILES_SUB}
      hint={perArea ? (resting) => `${resting} ${VERSION_FILES_AREAS_NOTE}` : undefined}
    />
  );

  // No areas, or one (the whole repository's): one Default release row —
  // the definition's `releaseKind`, or the one area's own.
  if (!perArea) {
    const only = list[0];
    const implicit =
      releases === null
        ? ("reading" as const)
        : only
          ? releases.find((r) => r.id === only.id)
          : releases.find((r) => r.id === IMPLICIT_AREA_ID);
    const branch = only ? branchOf(only.id, only.targetBranch) : workspaceBranch;
    const field = only ? "areas" : "releaseKind";
    const chosen = asReleaseKind(only ? only.releaseKind : d.value("releaseKind"));
    const line = releaseRowHint(
      implicit,
      branch,
      latestAt(only ? only.id : null, implicit === "reading" ? null : implicit?.latestTag),
    );
    const marks = d.rowProps(
      field,
      only && broken ? AREAS_BROKEN_HINT : line,
    );
    const value = chosen ?? FOLLOW_VALUE;
    return (
      <Section title={RELEASES} scope="repository" shared={d.repo.shared}>
        <Group label={RELEASES}>
          <Row kind="choice" label="Default release" {...marks}>
            <Select
              value={value}
              options={choices}
              label={DEFAULT_RELEASE_LABEL}
              disabled={!editable || marks.disabled || (!!only && broken)}
              onChange={(next) =>
                void (only
                  ? d.set("areas", withAreaReleaseKind(list, only.id, asReleaseKind(next)))
                  : d.set("releaseKind", asReleaseKind(next)))
              }
            />
          </Row>
        </Group>
        {/* G1 walk: its own table, so its chevron doesn't push the release
            menus off the shared right edge. */}
        <Group label={rowLabel("versionFiles")}>{versionFiles}</Group>
      </Section>
    );
  }

  return (
    <Section title={RELEASES} scope="repository" shared={d.repo.shared}>
      <p className="ux-card-muted" data-ply-releases-note="">
        {RELEASES_PER_AREA_NOTE}
      </p>
      <Group label={RELEASES}>
        {list.map((area, index) => {
          const kind = asReleaseKind(area.releaseKind);
          const was = asReleaseKind(base.find((a) => a.id === area.id)?.releaseKind);
          const branch = branchOf(area.id, area.targetBranch);
          const name = areaTitle(area);
          // The field's marks, with this row's own line: a read-only Mac's
          // "set by …" line replaces it. A draft change marks the rows whose
          // kind changed; a change on its way (queued, in a pull request,
          // waiting for your choice) marks the first row, once.
          const marks = d.rowProps(
            "areas",
            broken
              ? AREAS_BROKEN_HINT
              : releaseRowHint(
                  releases === null ? "reading" : releases.find((r) => r.id === area.id),
                  branch,
                  latestAt(area.id, releases?.find((r) => r.id === area.id)?.latestTag),
                ),
          );
          const draftMark = marks.changed?.n !== undefined;
          return (
            <Row
              key={area.id || index}
              kind="choice"
              label={areaTitle(area)}
              anchor={index === 0 ? marks.anchor : undefined}
              hint={marks.hint}
              changed={draftMark ? (kind !== was ? marks.changed : undefined) : index === 0 ? marks.changed : undefined}
              readOnly={marks.readOnly}
            >
              <Select
                value={kind ?? FOLLOW_VALUE}
                options={choices}
                label={`${name}: default release`}
                disabled={!editable || broken || marks.disabled}
                onChange={(next) => void d.set("areas", withAreaReleaseKind(list, area.id, asReleaseKind(next)))}
              />
            </Row>
          );
        })}
      </Group>
      <Group label={rowLabel("versionFiles")}>{versionFiles}</Group>
    </Section>
  );
}

// ── How this goes live ──────────────────────────────────────────────────

function GoLive({ workspaceId, shared }: { workspaceId: string; shared: boolean }) {
  const [reading, setReading] = useState<GoLiveReading>({ kind: "reading" });
  const [open, setOpen] = useState(false);
  const turn = useRef(0);
  const read = useCallback(() => {
    const mine = ++turn.current;
    setReading({ kind: "reading" });
    deployMapGet(workspaceId, false)
      .then((map) => {
        if (turn.current === mine) setReading({ kind: "read", map });
      })
      .catch(() => {
        if (turn.current === mine) setReading({ kind: "failed" });
      });
  }, [workspaceId]);
  useEffect(() => {
    read();
    return () => {
      turn.current++;
    };
  }, [read]);
  return (
    <Section
      title={GO_LIVE_TITLE}
      // Read from the project (its files, Railway): the project's, as
      // shared as the rest of it.
      scope="repository"
      shared={shared}
    >
      {/* G2 Windows walk (tidy tables): one row — what it says, then Open
          in the same column and size as the page's other buttons; the mark
          stays at the head's right, as on every section. */}
      <Group label={GO_LIVE_TITLE}>
        <Row
          kind="procedure"
          label={<span data-ply-shipping-go-live={reading.kind}>{goLiveSummary(reading, Date.now())}</span>}
          action={
            <CBtn onClick={() => setOpen(true)} aria-haspopup="dialog">
              {GO_LIVE_OPEN}
            </CBtn>
          }
        />
      </Group>
      {open && (
        <GoLiveSheet
          workspaceId={workspaceId}
          onClose={() => {
            setOpen(false);
            read();
          }}
          beforeRelease={() => useUi.getState().setSettingsOverlayOpen(false)}
        />
      )}
    </Section>
  );
}
