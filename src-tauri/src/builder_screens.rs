//! 1.176.2 (A5F-01, review F4) and 1.176.3 phase 2: the live Builder
//! sessions no terminal of the window shows — when each last printed,
//! whether its process ended, and its screen — one read for them all
//! ([`builder_session_screens`]), for the quit guard and "Install when my
//! work is done". The window judges them (`src/lib/builderScreenState.ts`)
//! with the card terminal's own matchers (`src/lib/attention.ts`).
//!
//! Each session's screen is drawn as a terminal would: every byte the PTY
//! wrote fed in order to an emulated grid at the PTY's own size, as
//! `chat_screen.rs` does for a card chat. The grid is fed only when the
//! window reads (its poll, every 2 s with the window shown and 5 s hidden,
//! and a fresh read before a quit or the scheduled install): what the PTY
//! wrote since the last read, parsed off the PTY's reader thread, which is
//! unchanged. [`ScreenGrids::frame`] also keeps, per session, when the rows
//! above its composer last changed (review round 2, M3) — what an
//! unknown or idle-looking screen is judged on.
//!
//! The rows are the person's screen: they go to the window only, never to a
//! log or a file (the dev-only capture, `builder_screens_capture.rs`, is
//! the one writer, and it is not in a release build).
//!
//! Only reads: no PTY is written, resized, spawned or killed.

use crate::builder::{BuilderRegistry, CAPTURE_REPLAY_MAX};
use crate::pty::PtyRegistry;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// The grid's size before the PTY says its own (a Builder's spawn size,
/// `builder.rs` `spawn_with_capture(…, 120, 32, …)`).
const DEFAULT_ROWS: u16 = 32;
const DEFAULT_COLS: u16 = 120;
/// How many rows of each screen go to the window: the settled last rows
/// (trailing blanks cut). The window's matchers read the last 20, as the
/// card terminal's prompt scan does; ten more leave margin (review round 2,
/// F-c).
pub(crate) const SENT_ROWS: usize = 30;

/// What is read of one live session (`BuilderRegistry::screen_sources`).
pub(crate) struct ScreenSource {
    pub key: String,
    pub pty_id: String,
    pub vendor: String,
    pub capture: Arc<Mutex<Vec<u8>>>,
    pub last_output_at: i64,
}

/// One session's grid, and how many of its capture's bytes it was fed.
struct Grid {
    parser: vt100::Parser,
    fed: usize,
    /// 1.176.3 (review round 2, M3): the rows above the composer at the last
    /// read (`builder_screen_judge::content_rows`), and when they last
    /// differed — what an unknown or idle-looking screen's "still at work"
    /// is judged on, so an animated composer never counts.
    content: Vec<String>,
    content_changed_at: Option<i64>,
    /// When it was last read: a read after a long gap (the computer slept)
    /// counts as a change ([`READ_GAP_FRESH_MS`]).
    read_at: Option<i64>,
}

/// Review p2 (should-fix): a read this long after the previous one — far
/// beyond the window's 2 s / 5 s poll: the computer slept, or the window's
/// timers were held — counts the content as changed now (the safe side), so
/// a turn running at sleep is never read as hung by the first Cmd-Q after
/// waking.
const READ_GAP_FRESH_MS: i64 = 60_000;

/// One read of a session's screen (`ScreenGrids::frame`).
pub(crate) struct Frame {
    /// Every row of the grid, top to bottom, each trimmed at the end.
    pub rows: Vec<String>,
    /// (rows, cols).
    #[cfg_attr(not(all(feature = "test-bridge", debug_assertions)), allow(dead_code))]
    pub size: (u16, u16),
    /// (row, col), 0-based.
    #[cfg_attr(not(all(feature = "test-bridge", debug_assertions)), allow(dead_code))]
    pub cursor: (u16, u16),
    #[cfg_attr(not(all(feature = "test-bridge", debug_assertions)), allow(dead_code))]
    pub cursor_hidden: bool,
    #[cfg_attr(not(all(feature = "test-bridge", debug_assertions)), allow(dead_code))]
    pub alternate_screen: bool,
    /// When the rows above the composer last changed (this read's `now` when
    /// they changed now, or on a first read).
    pub content_changed_at: Option<i64>,
}

/// Each session's grid, by PTY id (a session's key can move, its PTY not).
#[derive(Default)]
pub(crate) struct ScreenGrids(Mutex<HashMap<String, Grid>>);

/// One live session no terminal shows, with its screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionScreen {
    /// The session's key (`<card>` or `<card>#both-a|b`).
    pub key: String,
    pub vendor: String,
    /// When its PTY last printed (ms), stamped by the reader on every byte.
    pub last_output_at: Option<i64>,
    /// Its child has ended: neither at work nor waiting for anyone.
    pub exited: bool,
    /// The grid's settled last [`SENT_ROWS`] rows, top to bottom (none for
    /// an ended session). The person's screen: for the window only.
    pub rows: Vec<String>,
    /// When the rows above its composer last changed (ms), as seen by the
    /// reads; a first read counts as a change then. None for an ended one.
    pub content_changed_at: Option<i64>,
}

impl ScreenGrids {
    /// `source`'s screen now: its grid fed what the PTY wrote since the last
    /// read — on a first read, the capture's last [`CAPTURE_REPLAY_MAX`]
    /// bytes, as a terminal re-attaching replays it — with its cursor and
    /// the time its content (the rows above the composer) last changed,
    /// judged at `now` (epoch ms). `size` is the PTY's (rows, cols), when it
    /// can say.
    pub(crate) fn frame(&self, source: &ScreenSource, size: Option<(u16, u16)>, now: i64) -> Frame {
        let mut grids = self.0.lock();
        let (rows, cols) = size.unwrap_or((DEFAULT_ROWS, DEFAULT_COLS));
        let grid = grids.entry(source.pty_id.clone()).or_insert_with(|| Grid {
            parser: vt100::Parser::new(rows.max(1), cols.max(1), 0),
            fed: 0,
            content: Vec::new(),
            content_changed_at: None,
            read_at: None,
        });
        if size.is_some() && grid.parser.screen().size() != (rows, cols) {
            grid.parser.screen_mut().set_size(rows.max(1), cols.max(1));
        }
        let bytes: Vec<u8> = {
            let capture = source.capture.lock();
            let from = grid.fed.max(capture.len().saturating_sub(CAPTURE_REPLAY_MAX));
            let new = capture.get(from..).map(<[u8]>::to_vec).unwrap_or_default();
            grid.fed = capture.len();
            new
        };
        if !bytes.is_empty() {
            grid.parser.process(&bytes);
        }
        let screen = grid.parser.screen();
        let size = screen.size();
        let rows: Vec<String> = screen.rows(0, size.1).map(|row| row.replace('\u{a0}', " ").trim_end().to_string()).collect();
        let (cursor, cursor_hidden, alternate_screen) = (screen.cursor_position(), screen.hide_cursor(), screen.alternate_screen());
        let content = crate::builder_screen_judge::content_rows(&source.vendor, &rows);
        let after_a_gap = grid.read_at.is_some_and(|at| now - at > READ_GAP_FRESH_MS);
        grid.read_at = Some(now);
        if grid.content_changed_at.is_none() || after_a_gap || grid.content != content {
            grid.content = content.to_vec();
            grid.content_changed_at = Some(now);
        }
        Frame { rows, size, cursor, cursor_hidden, alternate_screen, content_changed_at: grid.content_changed_at }
    }

    /// Lets go of the grids of sessions no longer read.
    pub(crate) fn keep_only(&self, pty_ids: &HashSet<&str>) {
        self.0.lock().retain(|id, _| pty_ids.contains(id.as_str()));
    }
}

/// The settled last `n` rows: trailing blank rows cut, then the last `n`.
fn settled_tail(mut rows: Vec<String>, n: usize) -> Vec<String> {
    while rows.last().is_some_and(|row| row.trim().is_empty()) {
        rows.pop();
    }
    let from = rows.len().saturating_sub(n);
    rows.split_off(from)
}

/// The screens of `sources` at `now`, each with whether its child has
/// ended, sorted by key. An ended session's screen is not drawn.
pub(crate) fn read_screens(
    grids: &ScreenGrids,
    sources: &[ScreenSource],
    size: impl Fn(&str) -> Option<(u16, u16)>,
    exited: impl Fn(&str) -> bool,
    now: i64,
) -> Vec<SessionScreen> {
    grids.keep_only(&sources.iter().map(|s| s.pty_id.as_str()).collect());
    let mut out: Vec<SessionScreen> = sources
        .iter()
        .map(|s| {
            let exited = exited(&s.pty_id);
            let (rows, content_changed_at) = if exited {
                (Vec::new(), None)
            } else {
                let frame = grids.frame(s, size(&s.pty_id), now);
                (settled_tail(frame.rows, SENT_ROWS), frame.content_changed_at)
            };
            SessionScreen {
                key: s.key.clone(),
                vendor: s.vendor.clone(),
                last_output_at: (s.last_output_at > 0).then_some(s.last_output_at),
                exited,
                rows,
                content_changed_at,
            }
        })
        .collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// Review F4: a session whose child has ended asks nobody anything, whatever
/// its last screen showed. Intakes are the intake registry's.
pub(crate) fn retain_live_blocks(
    blocks: &mut Vec<crate::builder::SessionBlock>,
    pty_of: impl Fn(&str) -> Option<String>,
    exited: impl Fn(&str) -> bool,
) {
    blocks.retain(|b| b.intake || pty_of(&b.key).is_none_or(|pty| !exited(&pty)));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// 1.176.2 (A5F-01), 1.176.3 phase 2: every live Builder session but those
/// the window's terminals show (`observed`, their keys): when it last
/// printed, whether its process ended, and its screen's last rows with
/// when the rows above its composer last changed. One call for them all.
/// The grids are fed and drawn on a blocking worker (review round 2, F-b),
/// never on the main thread nor the PTY's reader.
#[tauri::command]
pub async fn builder_session_screens(app: AppHandle, observed: Vec<String>) -> Result<Vec<SessionScreen>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let registry = app.state::<BuilderRegistry>();
        let pty = app.state::<PtyRegistry>();
        let skip: HashSet<String> = observed.into_iter().collect();
        let sources = registry.screen_sources(&skip);
        read_screens(&registry.screens, &sources, |id| pty.screen_size(id), |id| pty.exited(id), now_ms())
    })
    .await
    .map_err(|e| format!("builder screens: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(key: &str, pty: &str, capture: &Arc<Mutex<Vec<u8>>>, at: i64) -> ScreenSource {
        ScreenSource { key: key.into(), pty_id: pty.into(), vendor: "codex".into(), capture: capture.clone(), last_output_at: at }
    }

    /// Codex 0.154's composer redrawn in place (`tileHeaderStatus.test.ts`
    /// CODEX_STARFIELD): the grid shows the last frame, not the byte stream.
    #[test]
    fn a_screen_redrawn_in_place_reads_as_its_last_frame() {
        let capture = Arc::new(Mutex::new(Vec::new()));
        let grids = ScreenGrids::default();
        capture.lock().extend_from_slice(b"\x1b[2J\x1b[H\xe2\x80\xa2 Working (2s \xe2\x80\xa2 esc to interrupt)\r\n\r\n\xe2\x80\xba Ask Codex to do anything\r\n");
        let first = read_screens(&grids, &[source("c1", "p1", &capture, 5)], |_| Some((10, 60)), |_| false, 1_000);
        assert_eq!(first[0].rows, vec!["• Working (2s • esc to interrupt)", "", "› Ask Codex to do anything"]);
        assert_eq!(first[0].last_output_at, Some(5));
        assert_eq!(first[0].content_changed_at, Some(1_000));
        // The turn ends: Codex erases its status row and animates its composer.
        capture.lock().extend_from_slice(b"\x1b[1;1H\x1b[2K\x1b[3;1H\x1b[2K\xe2\x80\xba\xc2\xb7    .   \xc2\xb7");
        let second = read_screens(&grids, &[source("c1", "p1", &capture, 9)], |_| Some((10, 60)), |_| false, 2_000);
        assert_eq!(second[0].rows, vec!["", "", "›·    .   ·"]);
        assert_eq!(second[0].content_changed_at, Some(2_000), "the status row went: the content changed");
        // Fed only what is new: a fresh grid fed it all draws the same.
        let fresh = read_screens(&ScreenGrids::default(), &[source("c1", "p1", &capture, 9)], |_| Some((10, 60)), |_| false, 2_000);
        assert_eq!(fresh[0].rows, second[0].rows);
    }

    /// 1.176.3 phase 2 (review round 2, F-c): the window gets the settled
    /// last rows only — trailing blanks cut, at most [`SENT_ROWS`].
    #[test]
    fn the_window_gets_the_settled_last_rows() {
        let capture = Arc::new(Mutex::new(Vec::new()));
        let mut bytes = Vec::new();
        for n in 1..=45 {
            bytes.extend_from_slice(format!("row {n}\r\n").as_bytes());
        }
        capture.lock().extend_from_slice(&bytes);
        let read = read_screens(&ScreenGrids::default(), &[source("c1", "p1", &capture, 5)], |_| Some((60, 40)), |_| false, 1);
        assert_eq!(read[0].rows.len(), SENT_ROWS);
        assert_eq!(read[0].rows.first().map(String::as_str), Some("row 16"));
        assert_eq!(read[0].rows.last().map(String::as_str), Some("row 45"));
    }

    /// 1.176.3 (review round 2, M3): the content clock moves when the rows
    /// above the composer change, not when only the composer animates.
    #[test]
    fn only_a_change_above_the_composer_moves_the_content_clock() {
        let capture = Arc::new(Mutex::new(Vec::new()));
        let grids = ScreenGrids::default();
        let src = source("c1", "p1", &capture, 5);
        capture.lock().extend_from_slice(b"\x1b[2J\x1b[H\xe2\x80\xa2 Done.\r\n\r\n\xe2\x80\xba\xc2\xb7    .   \xc2\xb7\r\n");
        let first = grids.frame(&src, Some((10, 60)), 1_000);
        assert_eq!(first.content_changed_at, Some(1_000));
        assert_eq!(first.size, (10, 60));
        // The composer animates: the clock stays.
        capture.lock().extend_from_slice(b"\x1b[3;1H\x1b[2K\xe2\x80\xba .  \xc2\xb7   .");
        let animated = grids.frame(&src, Some((10, 60)), 2_000);
        assert_eq!(animated.rows[2], "› .  ·   .");
        assert_eq!(animated.content_changed_at, Some(1_000));
        assert_eq!(animated.cursor, (2, 10));
        // A new transcript row above it: the clock moves.
        capture.lock().extend_from_slice(b"\x1b[2;1HMore.");
        assert_eq!(grids.frame(&src, Some((10, 60)), 3_000).content_changed_at, Some(3_000));
    }

    /// Review p2 (should-fix): the first read after the computer slept
    /// counts the content as changed then, whatever it shows.
    #[test]
    fn a_read_after_a_long_gap_counts_as_a_change() {
        let capture = Arc::new(Mutex::new(b"\xe2\x80\xa2 Working (2s \xe2\x80\xa2 esc to interrupt)\r\n".to_vec()));
        let grids = ScreenGrids::default();
        let src = source("c1", "p1", &capture, 5);
        assert_eq!(grids.frame(&src, Some((10, 60)), 1_000).content_changed_at, Some(1_000));
        assert_eq!(grids.frame(&src, Some((10, 60)), 3_000).content_changed_at, Some(1_000));
        // Reads within the gap: the clock stays.
        let edge = 3_000 + READ_GAP_FRESH_MS;
        assert_eq!(grids.frame(&src, Some((10, 60)), edge).content_changed_at, Some(1_000));
        // Over it: a change now.
        let woke = edge + READ_GAP_FRESH_MS + 1;
        assert_eq!(grids.frame(&src, Some((10, 60)), woke).content_changed_at, Some(woke));
    }

    #[test]
    fn an_ended_session_has_no_screen_and_its_grid_goes() {
        let capture = Arc::new(Mutex::new(b"\xe2\x80\xba 1. Trust and continue\r\n".to_vec()));
        let grids = ScreenGrids::default();
        read_screens(&grids, &[source("c1", "p1", &capture, 5)], |_| None, |_| false, 1);
        assert_eq!(grids.0.lock().len(), 1);
        let ended = read_screens(&grids, &[source("c1", "p1", &capture, 5)], |_| None, |_| true, 2);
        assert!(ended[0].exited);
        assert!(ended[0].rows.is_empty());
        assert_eq!(ended[0].content_changed_at, None);
        read_screens(&grids, &[], |_| None, |_| false, 3);
        assert!(grids.0.lock().is_empty());
        // A stamp never set is no time.
        let unset = read_screens(&grids, &[source("c1", "p1", &capture, 0)], |_| None, |_| false, 4);
        assert_eq!(unset[0].last_output_at, None);
    }

    #[test]
    fn each_session_says_when_it_printed_and_whether_it_ended_sorted_by_key() {
        let capture = Arc::new(Mutex::new(b"anything".to_vec()));
        let read = read_screens(
            &ScreenGrids::default(),
            &[source("c2", "p2", &capture, 0), source("c1", "p1", &capture, 7)],
            |_| None,
            |pty| pty == "p2",
            9,
        );
        assert_eq!(
            read,
            vec![
                SessionScreen {
                    key: "c1".into(),
                    vendor: "codex".into(),
                    last_output_at: Some(7),
                    exited: false,
                    rows: vec!["anything".into()],
                    content_changed_at: Some(9),
                },
                SessionScreen {
                    key: "c2".into(),
                    vendor: "codex".into(),
                    last_output_at: None,
                    exited: true,
                    rows: vec![],
                    content_changed_at: None,
                },
            ]
        );
        // What the window receives: camelCase, the rows with it.
        let json = serde_json::to_value(&read[0]).unwrap();
        assert_eq!(json["lastOutputAt"], 7);
        assert_eq!(json["contentChangedAt"], 9);
        assert_eq!(json["rows"][0], "anything");
    }

    /// Review F4: a session whose child ended at its trust question, Bypass
    /// warning or usage limit waits for nobody; a live one still does.
    #[test]
    fn an_ended_session_s_block_is_dropped() {
        use crate::builder::{SessionBlock, SessionBlockKind};
        let block = |key: &str, intake: bool| SessionBlock {
            key: key.into(),
            workspace_id: "ws".into(),
            vendor: "claude".into(),
            intake,
            kind: SessionBlockKind::Trust,
            resets_at: None,
            account: None,
        };
        let mut blocks = vec![block("dead", false), block("live", false), block("intake", true)];
        retain_live_blocks(&mut blocks, |key| Some(format!("pty-{key}")), |pty| pty == "pty-dead" || pty == "pty-intake");
        assert_eq!(blocks.iter().map(|b| b.key.as_str()).collect::<Vec<_>>(), vec!["live", "intake"]);
    }
}
