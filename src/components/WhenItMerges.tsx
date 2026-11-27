import { useEffect, useState } from "react";
import { deployWhatChanges, openWebLink, type WhatRedeploys } from "../ipc";
import { GO_LIVE_LINK, WHEN_IT_MERGES, whenItMerges, type GoLiveRow } from "../lib/goLive";
import { useAreasView } from "../store/areaStore";
import { pushToast } from "../store/toastStore";
import { CBtn, Section, StatusLine } from "./ux";
import { linkDidNotOpen } from "../lib/linkToast";
import { GoLiveSheet } from "./GoLiveSheet";

/** The dot each row's text sits beside (colour on the dot only). */
const ROW_STATE = { updates: "done", too: "warn", checks: "empty" } as const;

/**
 * 1.173.0 (D2, scene 1): the Ship step's "When it merges" — the addresses
 * that update when the card's pull request merges, those that restart too
 * and why, and the GitHub checks that run first. Read from D1
 * (`deploy_what_changes`), never blocking: nothing is drawn while it reads,
 * when it fails, or when there is nothing to say.
 *
 * `version` changes when the card's changes may have (a new round, new
 * checks); the reading is asked again then.
 */
export function WhenItMerges({
  workspaceId,
  cardId,
  version,
}: {
  workspaceId: string;
  cardId: string;
  version: string;
}) {
  const [read, setRead] = useState<{ key: string; what: WhatRedeploys | null } | null>(null);
  const [goLive, setGoLive] = useState(false);
  const key = `${workspaceId}:${cardId}:${version}`;
  const areas = useAreasView(workspaceId)?.areas ?? [];
  useEffect(() => {
    let gone = false;
    deployWhatChanges(workspaceId, cardId)
      .then((what) => {
        if (!gone) setRead({ key, what });
      })
      .catch((e: unknown) => {
        // Never a failure on the Ship step: it ships the same.
        console.warn("deploy_what_changes failed", e);
        if (!gone) setRead({ key, what: null });
      });
    return () => {
      gone = true;
    };
  }, [workspaceId, cardId, key]);
  const view = read?.key === key ? whenItMerges(read.what, areas, Date.now()) : null;
  if (!view) return null;
  return (
    <div data-ply-when-it-merges="">
      <Section title={WHEN_IT_MERGES}>
        {/* 1.174.0 (C1, BCI-16): when Railway was read, under the title —
            not in the style of a count. */}
        {view.readAgo && (
          <p className="ux-card-muted" data-ply-when-read-ago="">
            {view.readAgo}
          </p>
        )}
        {view.rows.map((row) => (
          <WhenRow key={`${row.kind}:${row.title}`} row={row} />
        ))}
        {/* …and the whole picture, one quiet press away. */}
        <p className="ux-card-muted">
          <CBtn tone="quiet" size="sm" data-ply-when-go-live="" onClick={() => setGoLive(true)}>
            {GO_LIVE_LINK}
          </CBtn>
        </p>
      </Section>
      {goLive && <GoLiveSheet workspaceId={workspaceId} onClose={() => setGoLive(false)} />}
    </div>
  );
}

function WhenRow({ row }: { row: GoLiveRow }) {
  return (
    <div data-ply-when-row={row.kind}>
      <StatusLine state={ROW_STATE[row.kind]}>{row.title}</StatusLine>
      <p className="ux-card-muted">
        {row.detail}
        {row.guide && (
          <>
            {" "}
            <CBtn tone="quiet" size="sm" onClick={() => openGuide(row.guide!.url)}>
              {row.guide.label}
            </CBtn>
          </>
        )}
      </p>
    </div>
  );
}

/** The guide in the browser; a toast says where it is when it can't. */
export function openGuide(url: string) {
  void openWebLink(url).catch((e: unknown) =>
    pushToast(linkDidNotOpen(url, e)),
  );
}
