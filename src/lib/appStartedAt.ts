// 1.171.0 B1 (owner D6): when this launch of Plyloft started — the time this
// module was first loaded, which is the window's first script. A merge of
// Plyloft's own that was due by a read from before it was owed while
// Plyloft was closed (`prStatus.ts::openPrStage`).
export const APP_STARTED_AT = Date.now();

/** 1.171.0 B1 (Challenger 1): how long after the launch a merge of
 *  Plyloft's own still counts as owed from before it — one look of the
 *  poller (`POLL_TICK_SECS` 15 s, a due read every 60 s) and its merge,
 *  with room to spare. Past it the card says what it says while open,
 *  whether or not a read changed anything on the board. */
export const LAUNCH_LOOK_MS = 90_000;
