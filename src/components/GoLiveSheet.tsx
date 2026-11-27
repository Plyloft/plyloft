import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  areasReleases,
  deployMapGet,
  projectConfigGet,
  releaseScopes,
  PENDING_RELEASE_CHANGED,
  type AreaRelease,
  type ReleaseScope,
  type DeployMap,
  type ProjectConfig,
} from "../ipc";
import { RELEASE_KINDS } from "../lib/cardPage";
import {
  GO_LIVE_GUIDE_URL,
  GO_LIVE_LEDE,
  GO_LIVE_LEDE_ONE,
  GO_LIVE_READ_FAILED,
  GO_LIVE_READING,
  GO_LIVE_READS_WHEN,
  GO_LIVE_TITLE,
  READ_AGAIN,
  GO_LIVE_NOTHING,
  readAgoWords,
  releasesRow,
  goLiveBlocks,
  goLiveNothing,
  railwayLine,
  readAgainForUnderWay,
  rightNowLabel,
  releasesWords,
  type GoLiveBlock,
} from "../lib/goLive";
import { machineWords } from "../lib/platform";
import { chosenReleaseKind } from "../lib/shippingPage";
import { RELEASE_UNREAD, releaseLabel, releaseTarget, type ReleaseTarget } from "../lib/projectRelease";
import { useShip } from "../store/shipStore";
import { releaseCards, showRelease, useReleaseInputs } from "../store/projectRelease";
import { useAreasView } from "../store/areaStore";
import { useKanban } from "../store/kanbanStore";
import { useWorkspaces } from "../store/workspaceStore";
import { BacktickCode } from "./BacktickCode";
import { openGuide } from "./WhenItMerges";
import { CBtn, Footnote, Properties, Section, Sheet, StatusLine } from "./ux";

type Reading =
  | { kind: "reading" }
  | { kind: "read"; map: DeployMap }
  | { kind: "failed" };

/**
 * 1.173.0 (D2, scenes 2–3): Board ⋯ › How this goes live. One block per
 * area (two or more), else one for the workspace: where its cards go, what
 * changes online then, what builds from another branch, how a release is
 * made. Read only, from D1's map; *Read again* asks Railway again. With
 * nothing to read, one calm line — no warning, no setup asked. F2: each
 * block has its Release… (the area's ready cards, through the card's own
 * Release… or Ship batch); G1 opens it from Settings › Shipping too
 * (`beforeRelease` then closes Settings, so the release opens over the
 * Board), and its Releases line names the default kind chosen there.
 * 1.174.0 (DR5, release.html state 10): one column per area, in the order
 * things happen (Cards go to · Checks first · Then · Right now · Releases);
 * the Releases row says the last tag and what is new since (`release_scopes`)
 * with Release <Area>… beside it only when there is something to release,
 * or a release on its way with Show it — never a button that is off.
 */
export function GoLiveSheet({
  workspaceId,
  onClose,
  beforeRelease,
}: {
  workspaceId: string;
  onClose: () => void;
  beforeRelease?: () => void;
}) {
  const name = useWorkspaces((s) => s.workspaces.find((w) => w.id === workspaceId)?.name ?? "");
  const view = useAreasView(workspaceId);
  const [reading, setReading] = useState<Reading>({ kind: "reading" });
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [releases, setReleases] = useState<AreaRelease[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const turn = useRef(0);

  const read = useCallback(
    (refresh: boolean) => {
      const mine = ++turn.current;
      setReading({ kind: "reading" });
      deployMapGet(workspaceId, refresh)
        .then((map) => {
          if (turn.current !== mine) return;
          setReading({ kind: "read", map });
          // A cached reading taken while a deploy was under way is old news:
          // ask Railway again, once, as the sheet opens.
          if (!refresh && readAgainForUnderWay(map, Date.now())) read(true);
        })
        .catch((e: unknown) => {
          console.warn("deploy_map_get failed", e);
          if (turn.current === mine) setReading({ kind: "failed" });
        });
    },
    [workspaceId],
  );

  useEffect(() => {
    read(false);
    let gone = false;
    projectConfigGet(workspaceId)
      .then((c) => {
        if (!gone) setConfig(c);
      })
      .catch(() => {});
    return () => {
      gone = true;
      turn.current++;
    };
  }, [workspaceId, read]);

  const manyAreas = (view?.areas.length ?? 0) >= 2;
  // B4's tags: for each area, for the one area a project may list, and (G1)
  // for the implicit area — the latest strict vX.Y.Z tag.
  useEffect(() => {
    let gone = false;
    areasReleases(workspaceId)
      .then((r) => {
        if (!gone) setReleases(r);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [workspaceId]);
  // 1.174.0 (DR5): what each area's next release would carry (DR1), for the
  // Releases row; until it is read (or when it can't be) B4's words stand.
  const [scopes, setScopes] = useState<ReleaseScope[] | null>(null);
  const scopeTurn = useRef(0);
  // DR5 round 1: read again on Read again, and when the workspace's release
  // record changes (a release starts, moves on or ends).
  const readScopes = useCallback(() => {
    const mine = ++scopeTurn.current;
    releaseScopes(workspaceId)
      .then((r) => {
        if (scopeTurn.current === mine) setScopes(r);
      })
      .catch((e: unknown) => console.warn("release_scopes failed", e));
  }, [workspaceId]);
  useEffect(() => {
    readScopes();
    let stop: (() => void) | null = null;
    let gone = false;
    void listen<string>(PENDING_RELEASE_CHANGED, (event) => {
      if (event.payload === workspaceId) readScopes();
    })
      .then((unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      gone = true;
      scopeTurn.current++;
      stop?.();
    };
  }, [workspaceId, readScopes]);
  const scopeOf = (b: GoLiveBlock): ReleaseScope | undefined =>
    scopes?.find((sc) => sc.area === b.areaId) ?? (b.areaId === null && scopes?.length === 1 ? scopes[0] : undefined);

  const cards = useKanban((s) => s.byWorkspace[workspaceId]?.cards);
  const entries = (cards ?? []).flatMap((c) => c.shipHistory ?? []);
  const kindLabel = (kind: string) => machineWords(RELEASE_KINDS.find((k) => k.value === kind)?.label ?? kind);
  const map = reading.kind === "read" ? reading.map : null;
  const blocks =
    reading.kind === "read"
      ? goLiveBlocks({
          map,
          areas: view?.areas ?? [],
          branch: view?.workspaceBranch ?? config?.targetBranch ?? "main",
          releasesFor: (area) =>
            releasesWords({
              entries,
              area,
              release: area
                ? releases.find((r) => r.id === area.id)
                : releases.length === 1
                  ? releases[0]
                  : undefined,
              kindLabel,
              chosen: chosenReleaseKind(view, area),
            }),
        })
      : [];
  const line = map ? railwayLine(map.railway, map.railwayFiles ?? false) : null;
  // F2: each block's ready cards (B4's groups), and its Release….
  const releaseInputs = useReleaseInputs(workspaceId, true);
  const targetOf = (b: GoLiveBlock): ReleaseTarget =>
    releaseTarget(releaseInputs, b.areaId === null ? null : { id: b.areaId, name: b.name ?? b.areaId });
  // DR5 round 1: the ready cards are the scope's when it is read (one
  // source for the count and the press), else B4's.
  // 1.174.0 (DR3): Release <Area>… and Show it open the Release sheet on
  // the block's area, with its ready cards ticked (none is fine: the
  // release carries what is on the branch since the last tag).
  const release = (areaId: string | null, cardIds: readonly string[]) => {
    onClose();
    beforeRelease?.();
    releaseCards(workspaceId, cardIds, areaId);
  };
  const show = (areaId: string | null) => {
    onClose();
    beforeRelease?.();
    showRelease(workspaceId, areaId);
  };

  return (
    <Sheet
      title={name ? `${GO_LIVE_TITLE} · ${name}` : GO_LIVE_TITLE}
      lede={manyAreas ? GO_LIVE_LEDE : GO_LIVE_LEDE_ONE}
      size="wide"
      onClose={onClose}
      initialFocusRef={closeRef}
      actions={
        <CBtn ref={closeRef} onClick={onClose}>
          Close
        </CBtn>
      }
    >
      <div className="ux-go-live" data-ply-go-live={reading.kind}>
        {reading.kind === "reading" && <StatusLine state="running">{GO_LIVE_READING}</StatusLine>}
        {reading.kind === "failed" && (
          <p className="ux-card-muted">
            {GO_LIVE_READ_FAILED}{" "}
            <CBtn
              tone="quiet"
              size="sm"
              onClick={() => {
                read(true);
                readScopes();
              }}
            >
              {READ_AGAIN}
            </CBtn>
          </p>
        )}
        {/* Several areas and nothing to read: the calm line once, above. */}
        {reading.kind === "read" && manyAreas && goLiveNothing(map) && (
          <p className="ux-card-muted" data-ply-go-live-nothing="">
            {GO_LIVE_NOTHING}
          </p>
        )}
        {blocks.map((b) => (
          <Block
            key={b.areaId ?? "workspace"}
            block={b}
            target={targetOf(b)}
            scope={scopeOf(b)}
            onRelease={(cardIds) => release(b.areaId, cardIds)}
            onShow={() => show(b.areaId)}
            readAt={map?.railway.readAt}
          />
        ))}
        {reading.kind === "read" &&
          (line ? (
            <p className="ux-card-muted" data-ply-go-live-railway="">
              <BacktickCode text={machineWords(line.text)} />
              {line.readAgain && (
                <>
                  {" · "}
                  <CBtn
              tone="quiet"
              size="sm"
              onClick={() => {
                read(true);
                readScopes();
              }}
            >
                    {READ_AGAIN}
                  </CBtn>
                </>
              )}
            </p>
          ) : (
            <Footnote>{GO_LIVE_READS_WHEN}</Footnote>
          ))}
        {reading.kind === "read" && (
          <p className="ux-card-muted">
            <CBtn tone="quiet" size="sm" onClick={() => openGuide(GO_LIVE_GUIDE_URL)}>
              How a change goes live
            </CBtn>
          </p>
        )}
      </div>
    </Sheet>
  );
}

function Block({
  block,
  target,
  scope,
  onRelease,
  onShow,
  readAt,
}: {
  block: GoLiveBlock;
  target: ReleaseTarget;
  /** What the area's next release would carry; undefined until read. */
  scope: ReleaseScope | undefined;
  /** The ready cards to release (none: what is on the branch). */
  onRelease: (cardIds: readonly string[]) => void;
  onShow: () => void;
  /** When Railway was read: "read 4 min ago". */
  readAt: number | null | undefined;
}) {
  const now = Date.now();
  const key = block.areaId ?? "workspace";
  // 1.174.0 (DR5, state 10): one column, in the order things happen; the
  // reading's age is the section's count ("Site · read just now"), and
  // the Right now label stays plain when there is a section to carry it.
  const ago = readAgoWords(readAt, now)?.replace(/^read from Railway /, "read ") ?? null;
  // One source for the count and the press: the scope's ready cards once read.
  const readyIds = scope ? scope.readyCardIds : target.cardIds;
  const row = releasesRow(scope, readyIds.length, now, block.releases);
  // No button that is off (P28): Release <Area>… only when there is
  // something to release, Show it while a release is on its way. A refused
  // area, or the ready cards unread, says so in words.
  const unread = !scope && target.off === RELEASE_UNREAD;
  const releases = (
    <div className="ux-go-live-releases" data-ply-go-live-releases={key}>
      {row.running ? <StatusLine state="running">{row.words}</StatusLine> : <span>{row.words}</span>}
      {row.act === "release" && (
        <CBtn size="sm" onClick={() => onRelease(readyIds)} data-ply-go-live-release={key}>
          {releaseLabel(target.name)}
        </CBtn>
      )}
      {row.act === "show" && (
        <CBtn size="sm" onClick={onShow} data-ply-go-live-show={key}>
          Show it
        </CBtn>
      )}
      {unread && (
        <>
          <span className="ux-card-muted" data-ply-go-live-release-off={key}>
            {target.off}
          </span>
          {/* The ready cards couldn't be read: ask the list again. */}
          <CBtn tone="quiet" size="sm" onClick={() => void useShip.getState().refreshPendingCount()}>
            {READ_AGAIN}
          </CBtn>
        </>
      )}
    </div>
  );
  const items = [
    { label: "Cards go to", value: block.cardsGo },
    ...(block.checks ? [{ label: "Checks first", value: block.checks }] : []),
    { label: "Then", value: block.then },
    ...block.earlier.map((e) => ({ label: e.label, value: e.addresses })),
    // 1.173.0 walk: whether each service is up, in words beside its dot.
    ...(block.now.length
      ? [
          {
            label: block.name ? "Right now" : rightNowLabel(readAt, now),
            value: (
              <div data-ply-go-live-now={key}>
                {block.now.map((n) => (
                  <StatusLine key={n.key} state={n.dot}>
                    {`${n.address} · ${n.words}`}
                  </StatusLine>
                ))}
              </div>
            ),
          },
        ]
      : []),
    { label: "Releases", value: releases },
  ];
  return (
    <div data-ply-go-live-block={key}>
      {block.name ? (
        <Section title={block.name} count={block.now.length && ago ? `· ${ago}` : undefined} countInline>
          <Properties items={items} />
        </Section>
      ) : (
        <Properties items={items} />
      )}
    </div>
  );
}
