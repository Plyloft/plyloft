//! H1 (1.173.0): the watchdog's decisions over an injected clock, the
//! marker's unclean-run detection, and the lines it writes.

use super::*;

const S: u64 = 1000;

/// A visible window that beat at t = 0, with the first probe already
/// posted and answered so only the window is in play.
fn visible_at_zero() -> Decider {
    let mut d = Decider::default();
    d.beat(0, 1_000_000, true);
    assert_eq!(d.tick(0), vec![Event::PostMainProbe]);
    d.probe_ran(0);
    d
}

/// Ticks every second over `from..=to` (seconds), answering each probe at
/// once; returns every event but the probes.
fn run(d: &mut Decider, from: u64, to: u64) -> Vec<(u64, Event)> {
    let mut out = Vec::new();
    for t in from..=to {
        for event in d.tick(t * S) {
            if event == Event::PostMainProbe {
                d.probe_ran(t * S);
            } else {
                out.push((t, event));
            }
        }
    }
    out
}

#[test]
fn beats_every_two_seconds_log_nothing() {
    let mut d = visible_at_zero();
    let mut events = Vec::new();
    for t in 1..=600 {
        if t % 2 == 0 {
            d.beat(t * S, 0, true);
        }
        events.extend(d.tick(t * S).into_iter().filter(|e| *e != Event::PostMainProbe));
        d.probe_ran(t * S);
    }
    assert!(events.is_empty(), "{events:?}");
}

#[test]
fn a_silent_window_logs_once_at_10_30_and_120_s_then_once_when_it_answers() {
    let mut d = visible_at_zero();
    let events = run(&mut d, 1, 200);
    assert_eq!(
        events,
        vec![
            (10, Event::WindowSilent { secs: 10 }),
            (30, Event::WindowSilent { secs: 30 }),
            (120, Event::WindowSilent { secs: 120 }),
        ],
        "one line per threshold, none in between or after"
    );
    d.beat(201 * S, 0, true);
    assert_eq!(run(&mut d, 202, 202), vec![(202, Event::WindowAnswered { after_secs: 201 })]);
    assert!(run(&mut d, 203, 210).is_empty(), "the answer is said once");
}

#[test]
fn a_short_silence_answers_without_reaching_the_next_threshold() {
    let mut d = visible_at_zero();
    assert_eq!(run(&mut d, 1, 15), vec![(10, Event::WindowSilent { secs: 10 })]);
    d.beat(15_500, 0, true);
    assert_eq!(run(&mut d, 16, 16), vec![(16, Event::WindowAnswered { after_secs: 15 })]);
    // A second freeze starts over at 10 s.
    let again = run(&mut d, 17, 26);
    assert_eq!(again, vec![(26, Event::WindowSilent { secs: 10 })]);
}

#[test]
fn a_beat_before_any_silence_was_logged_says_nothing() {
    let mut d = visible_at_zero();
    assert!(run(&mut d, 1, 9).is_empty());
    d.beat(9_500, 0, true);
    assert!(run(&mut d, 10, 18).is_empty());
}

#[test]
fn a_hidden_window_is_never_a_silence() {
    let mut d = Decider::default();
    d.beat(0, 0, false);
    // Hidden pages beat every 30 s, and may beat later still: no lines.
    let events = run(&mut d, 0, 300);
    assert!(events.is_empty(), "{events:?}");
}

#[test]
fn a_window_shown_again_counts_its_silence_from_the_moment_it_is_shown() {
    let mut d = Decider::default();
    d.beat(0, 0, false);
    // Closed: the OS hides it too.
    d.set_visible(0, false);
    assert!(run(&mut d, 0, 100).is_empty());
    // Shown again: the page's "hidden" from before is stale.
    assert!(d.set_visible(100 * S, true), "it just came on screen");
    assert!(run(&mut d, 101, 109).is_empty(), "not 100 s of silence at once");
    assert_eq!(run(&mut d, 110, 110), vec![(110, Event::WindowSilent { secs: 10 })]);
}

#[test]
fn a_window_that_never_beats_is_said_once_30_s_after_start() {
    let mut d = Decider::default();
    let events = run(&mut d, 0, 200);
    assert_eq!(
        events,
        vec![(30, Event::WindowNeverAnswered { secs: 30 })],
        "the page gets 30 s to load, then one line, not one per threshold"
    );
    d.beat(201 * S, 0, true);
    assert_eq!(run(&mut d, 202, 202), vec![(202, Event::WindowAnswered { after_secs: 201 })]);
    // From its first beat, the normal thresholds.
    assert_eq!(run(&mut d, 203, 211), vec![(211, Event::WindowSilent { secs: 10 })]);
}

#[test]
fn a_page_that_loads_within_30_s_says_nothing() {
    let mut d = Decider::default();
    assert!(run(&mut d, 0, 29).is_empty());
    d.beat(29_500, 0, true);
    assert!(run(&mut d, 30, 38).is_empty());
}

#[test]
fn a_window_hidden_at_start_waits_for_its_first_beat_from_when_it_is_shown() {
    let mut d = Decider::default();
    d.set_visible(0, false);
    assert!(run(&mut d, 0, 100).is_empty(), "hidden: no silence");
    d.set_visible(100 * S, true);
    assert!(run(&mut d, 101, 129).is_empty(), "30 s from being shown");
    assert_eq!(run(&mut d, 130, 130), vec![(130, Event::WindowNeverAnswered { secs: 30 })]);
}

#[test]
fn the_os_and_the_page_both_have_to_say_visible() {
    // The OS hid it, but a late beat still says the page is visible: no
    // silence is counted.
    let mut d = visible_at_zero();
    d.set_visible(0, false);
    d.beat(1 * S, 0, true);
    assert!(!d.visible());
    assert!(run(&mut d, 2, 60).is_empty());
    // The OS shows it but the page says hidden (minimized, another space):
    // still no silence.
    let mut d = visible_at_zero();
    d.beat(1 * S, 0, false);
    assert!(!d.set_visible(1 * S, true), "the OS already said shown; nothing changed");
    assert!(!d.visible());
    assert!(run(&mut d, 2, 60).is_empty());
    // The page says visible again: counted from that beat.
    assert!(d.beat(61 * S, 0, true), "it just came on screen");
    assert_eq!(run(&mut d, 62, 71), vec![(71, Event::WindowSilent { secs: 10 })]);
}

#[test]
fn the_main_thread_is_probed_every_5_s_and_a_stall_is_logged_once() {
    let mut d = Decider::default();
    d.beat(0, 0, true);
    let mut posts = Vec::new();
    for t in 0..=20 {
        if t % 2 == 0 {
            d.beat(t * S, 0, true);
        }
        for event in d.tick(t * S) {
            assert_eq!(event, Event::PostMainProbe);
            posts.push(t);
            d.probe_ran(t * S);
        }
    }
    assert_eq!(posts, vec![0, 5, 10, 15, 20]);

    // t = 25: posted, and this one doesn't run. Beats keep coming (it's the
    // app, not the page, in this test).
    let mut events = Vec::new();
    for t in 21..=60 {
        if t % 2 == 0 {
            d.beat(t * S, 0, true);
        }
        events.extend(d.tick(t * S).into_iter().map(|e| (t, e)));
    }
    assert_eq!(
        events,
        vec![(25, Event::PostMainProbe), (30, Event::MainStalled { secs: 5 })],
        "no new probe while one is waiting; one line"
    );
    d.probe_ran(61 * S);
    for t in 62..=62 {
        d.beat(t * S, 0, true);
    }
    let after: Vec<_> = d.tick(62 * S);
    assert_eq!(after, vec![Event::MainAnswered { after_secs: 36 }, Event::PostMainProbe]);
}

#[test]
fn a_hidden_window_gives_the_main_thread_30_s_before_a_stall() {
    let mut d = Decider::default();
    d.beat(0, 0, false);
    assert_eq!(d.tick(0), vec![Event::PostMainProbe]);
    let mut events = Vec::new();
    for t in 1..=40 {
        events.extend(d.tick(t * S).into_iter().map(|e| (t, e)));
    }
    assert_eq!(events, vec![(30, Event::MainStalled { secs: 30 })]);
}

#[test]
fn a_probe_that_ran_in_time_says_nothing() {
    let mut d = visible_at_zero();
    d.tick(5 * S);
    d.probe_ran(6 * S);
    d.beat(6 * S, 0, true);
    assert!(d.tick(7 * S).is_empty());
}

#[test]
fn a_sleep_says_so_once_and_blames_nobody() {
    // Ten minutes asleep: the total clock moved 600 s, the awake clock 1 s.
    let mut d = visible_at_zero();
    assert!(run(&mut d, 1, 1).is_empty());
    d.beat(1 * S, 0, true);
    let events = d.tick_clocks(2 * S, 602 * S);
    assert_eq!(events.first(), Some(&Event::Slept { secs: 600 }));
    assert!(
        !events.iter().any(|e| e.is_warning()),
        "a sleep is no freeze: {events:?}"
    );
    let (level, line) = event_line(&Event::Slept { secs: 600 }, None).unwrap();
    assert_eq!((level, line.as_str()), (log::Level::Info, "watchdog: the computer slept for 600 s"));
    // From the wake, the normal thresholds.
    d.probe_ran(2 * S);
    let mut later = Vec::new();
    for t in 3..=12 {
        for event in d.tick_clocks(t * S, (600 + t) * S) {
            if event == Event::PostMainProbe {
                d.probe_ran(t * S);
            } else {
                later.push((t, event));
            }
        }
    }
    assert_eq!(later, vec![(12, Event::WindowSilent { secs: 10 })]);
}

#[test]
fn a_gap_while_awake_is_plyloft_starved_and_a_warning() {
    // The 2026-10-30 freezes: the computer was awake (both clocks moved
    // 600 s) but Plyloft wasn't scheduled. Not a sleep, not reset.
    let mut d = visible_at_zero();
    assert!(run(&mut d, 1, 1).is_empty());
    d.beat(1 * S, 0, true);
    let events = d.tick_clocks(601 * S, 601 * S);
    assert!(!events.iter().any(|e| matches!(e, Event::Slept { .. })), "{events:?}");
    assert_eq!(events.last(), Some(&Event::Starved { secs: 600 }), "after the silences it explains: {events:?}");
    assert!(events.contains(&Event::WindowSilent { secs: 120 }), "the window really didn't answer: {events:?}");
    let (level, line) = event_line(&Event::Starved { secs: 600 }, None).unwrap();
    assert_eq!(level, log::Level::Warn);
    assert_eq!(
        line,
        "watchdog: Plyloft itself could not run for 600 s (the system was too busy); memory: unknown"
    );
}

#[test]
fn a_short_gap_is_neither() {
    let mut d = visible_at_zero();
    d.beat(1 * S, 0, true);
    d.tick_clocks(1 * S, 1 * S);
    let events = d.tick_clocks(15 * S - 1, 15 * S + 13_000);
    assert!(
        !events.iter().any(|e| matches!(e, Event::Slept { .. } | Event::Starved { .. })),
        "14 s awake and 13 s asleep: {events:?}"
    );
}

#[test]
fn a_silence_already_logged_keeps_going_through_a_sleep() {
    let mut d = visible_at_zero();
    assert_eq!(run(&mut d, 1, 10), vec![(10, Event::WindowSilent { secs: 10 })]);
    // Asleep 600 s right after the 10 s line.
    let events = d.tick_clocks(11 * S, 611 * S);
    assert_eq!(events, vec![Event::Slept { secs: 600 }]);
    let mut later = Vec::new();
    for t in 12..=30 {
        later.extend(d.tick_clocks(t * S, (600 + t) * S).into_iter().filter(|e| *e != Event::PostMainProbe));
        d.probe_ran(t * S);
    }
    assert_eq!(later, vec![Event::WindowSilent { secs: 30 }], "the silence wasn't restarted");
}

#[test]
fn a_hidden_window_tolerates_a_longer_gap() {
    let mut d = Decider::default();
    d.beat(0, 0, false);
    d.tick(0);
    d.probe_ran(0);
    let events = d.tick(40 * S);
    assert!(!events.iter().any(|e| matches!(e, Event::Starved { .. })), "App Nap stretches a hidden app's timers");
    assert!(d.tick(101 * S).contains(&Event::Starved { secs: 61 }));
}

#[test]
fn a_window_just_shown_judges_the_hidden_gap_by_the_hidden_limit() {
    // Hidden, ticking every 5 s; App Nap stretches one gap to 40 s, and the
    // window is shown during it. Not starved: the gap began hidden.
    let mut d = Decider::default();
    d.beat(0, 0, false);
    d.set_visible(0, false);
    d.tick(0);
    d.probe_ran(0);
    d.set_visible(40 * S, true);
    let events = d.tick(40 * S);
    assert!(!events.iter().any(|e| matches!(e, Event::Starved { .. })), "{events:?}");
    // Visible at both ends again: the 15 s limit.
    d.probe_ran(40 * S);
    d.beat(40 * S, 0, true);
    assert!(d.tick(56 * S).contains(&Event::Starved { secs: 16 }));
}

#[test]
fn quitting_stops_the_probes_and_every_line() {
    // The exit cleanup holds the main thread: no "has not run" before
    // "exit: cleanup done".
    let mut d = visible_at_zero();
    d.tick(5 * S);
    d.quit();
    for t in 6..=200 {
        assert!(d.tick(t * S).is_empty(), "t = {t}");
    }
}

// The marker.

#[test]
fn a_marker_without_ended_at_is_an_unclean_run() {
    let marker = RunMarker {
        started_at: 1_000,
        last_beat_at: Some(5_000),
        last_memory: Some(MemoryFacts { total_bytes: 16, available_bytes: 1, low: true, ..Default::default() }),
        ended_at: None,
    };
    let prev = previous_unclean(Some(&marker)).expect("unclean");
    assert_eq!(prev.started_at, 1_000);
    assert_eq!(prev.last_beat_at, Some(5_000));
    assert!(prev.last_memory.unwrap().low);
}

#[test]
fn a_marker_with_ended_at_or_no_marker_says_nothing() {
    let clean = RunMarker { started_at: 1_000, ended_at: Some(9_000), ..Default::default() };
    assert_eq!(previous_unclean(Some(&clean)), None);
    assert_eq!(previous_unclean(None), None, "a first run, or one before 1.173.0");
}

#[test]
fn a_marker_with_only_started_at_loads_and_is_unclean() {
    // Backward-compatible shape: fields added later default.
    let marker: RunMarker = serde_json::from_str(r#"{"started_at": 1761818400000}"#).unwrap();
    assert_eq!(marker.last_beat_at, None);
    assert_eq!(marker.ended_at, None);
    let prev = previous_unclean(Some(&marker)).unwrap();
    assert!(startup_line(&prev).ends_with("no answer from the window was recorded"));
}

#[test]
fn an_empty_marker_loads_and_says_nothing() {
    let marker: RunMarker = serde_json::from_str("{}").unwrap();
    assert_eq!(previous_unclean(Some(&marker)), None);
}

#[test]
fn a_marker_ignores_fields_it_does_not_know() {
    let marker: RunMarker =
        serde_json::from_str(r#"{"started_at": 1, "ended_at": 2, "from_the_future": true}"#).unwrap();
    assert_eq!(marker.ended_at, Some(2));
}

#[test]
fn the_marker_round_trips_with_its_own_keys() {
    let marker = RunMarker { started_at: 1, last_beat_at: Some(2), last_memory: None, ended_at: None };
    let json = serde_json::to_value(&marker).unwrap();
    assert!(json.get("started_at").is_some() && json.get("last_beat_at").is_some());
    let back: RunMarker = serde_json::from_value(json).unwrap();
    assert_eq!(back, marker);
}

#[test]
fn the_marker_is_written_at_most_once_a_minute() {
    let mut urgent = MARKER_URGENT_PER_FREEZE;
    assert!(marker_due(true, false, &mut urgent, None, 0), "the first write");
    assert!(!marker_due(false, false, &mut urgent, None, 0), "nothing changed");
    assert!(!marker_due(true, false, &mut urgent, Some(0), 59_999));
    assert!(marker_due(true, false, &mut urgent, Some(0), 60_000));
    assert_eq!(urgent, MARKER_URGENT_PER_FREEZE, "routine writes spend nothing");
}

#[test]
fn a_warning_writes_the_marker_at_once_three_times_per_freeze() {
    let mut urgent = MARKER_URGENT_PER_FREEZE;
    for i in 0..3 {
        assert!(marker_due(true, true, &mut urgent, Some(0), 1_000 + i), "warning {i}");
    }
    assert!(!marker_due(true, true, &mut urgent, Some(1_002), 2_000), "the fourth waits for the minute");
    assert!(marker_due(true, true, &mut urgent, Some(1_002), 61_002), "…and is then routine");
    assert!(Event::WindowAnswered { after_secs: 40 }.ends_a_freeze() && Event::Slept { secs: 60 }.ends_a_freeze());
    for e in [
        Event::WindowSilent { secs: 10 },
        Event::WindowNeverAnswered { secs: 30 },
        Event::MainStalled { secs: 5 },
        Event::Starved { secs: 20 },
    ] {
        assert!(e.is_warning(), "{e:?}");
    }
    assert!(!Event::Slept { secs: 60 }.is_warning());
}

#[test]
fn the_startup_line_names_both_times_and_the_memory() {
    let prev = PreviousRun {
        started_at: 1_761_818_400_000,
        last_beat_at: Some(1_761_825_720_000),
        last_memory: Some(crate::memory_facts::from_windows(16 << 30, 1 << 30, 24 << 30, 8 << 30, None)),
    };
    let line = startup_line(&prev);
    assert_eq!(
        line,
        format!(
            "startup: the last run (since {}) did not end cleanly; the window last answered at {}; last memory: available 1.0 GB of 16.0 GB, page file 1.0 GB (estimated) (low)",
            when(1_761_818_400_000),
            when(1_761_825_720_000)
        )
    );
}

#[test]
fn the_card_s_log_lines() {
    let (level, line) = event_line(&Event::WindowSilent { secs: 10 }, None).unwrap();
    assert_eq!(level, log::Level::Warn);
    assert!(line.starts_with("watchdog: the window has not answered for 10 s; memory: "), "{line}");
    let (level, line) = event_line(&Event::WindowAnswered { after_secs: 42 }, None).unwrap();
    assert_eq!(level, log::Level::Info);
    assert_eq!(line, "watchdog: the window answered again after 42 s");
    let (level, _) = event_line(&Event::MainStalled { secs: 5 }, None).unwrap();
    assert_eq!(level, log::Level::Warn);
    assert!(event_line(&Event::PostMainProbe, None).is_none());
    let (level, line) = event_line(&Event::WindowNeverAnswered { secs: 30 }, None).unwrap();
    assert_eq!(level, log::Level::Warn);
    assert!(line.starts_with("watchdog: the window has not answered since Plyloft started"), "{line}");
}

// The record Diagnostics reads.

#[test]
fn a_freeze_is_one_episode_that_grows_and_ends() {
    let mut record = Record::default();
    let memory = MemoryFacts { total_bytes: 16, available_bytes: 1, low: true, ..Default::default() };
    record.apply(&Event::WindowSilent { secs: 10 }, 100_000, Some(&memory));
    record.apply(&Event::WindowSilent { secs: 30 }, 120_000, None);
    record.apply(&Event::WindowAnswered { after_secs: 40 }, 130_000, None);
    let status = record.status();
    assert_eq!(status.episodes.len(), 1);
    let e = &status.episodes[0];
    assert_eq!((e.kind, e.at, e.secs, e.over), (EpisodeKind::Window, 90_000, 40, true));
    assert_eq!(e.memory.as_ref(), Some(&memory), "the memory when it was first logged");
}

#[test]
fn window_and_app_freezes_are_kept_apart_and_bounded() {
    let mut record = Record::default();
    record.apply(&Event::MainStalled { secs: 5 }, 10_000, None);
    record.apply(&Event::WindowSilent { secs: 10 }, 12_000, None);
    record.apply(&Event::MainAnswered { after_secs: 8 }, 13_000, None);
    let status = record.status();
    assert_eq!(status.episodes.len(), 2);
    assert!(status.episodes[0].over && status.episodes[0].kind == EpisodeKind::App);
    assert!(!status.episodes[1].over);
    record.apply(&Event::WindowAnswered { after_secs: 3 }, 0, None);
    for i in 0..30 {
        record.apply(&Event::MainStalled { secs: 5 }, i, None);
        record.apply(&Event::MainAnswered { after_secs: 6 }, i, None);
    }
    assert_eq!(record.status().episodes.len(), EPISODES_MAX);
    for i in 0..50 {
        record.line(0, &format!("line {i}"));
    }
    let lines = record.status().lines;
    assert_eq!(lines.len(), LINES_MAX);
    assert!(lines.last().unwrap().ends_with("line 49"));
}

#[test]
fn an_answer_with_no_silence_before_it_keeps_nothing() {
    let mut record = Record::default();
    record.apply(&Event::WindowAnswered { after_secs: 3 }, 0, None);
    record.apply(&Event::Slept { secs: 600 }, 0, None);
    assert!(record.status().episodes.is_empty(), "a sleep is no freeze");
}

#[test]
fn a_starved_plyloft_is_its_own_episode_and_over() {
    let mut record = Record::default();
    let memory = MemoryFacts { total_bytes: 16, available_bytes: 1, low: true, ..Default::default() };
    record.apply(&Event::WindowSilent { secs: 10 }, 100_000, None);
    record.apply(&Event::Starved { secs: 40 }, 100_000, Some(&memory));
    let status = record.status();
    assert_eq!(status.episodes.len(), 2);
    let e = &status.episodes[1];
    assert_eq!((e.kind, e.at, e.secs, e.over), (EpisodeKind::Busy, 60_000, 40, true));
    assert_eq!(e.memory.as_ref(), Some(&memory));
    assert_eq!(serde_json::to_value(e).unwrap()["kind"], "busy");
    // The window's own silence is still open, and its answer closes it.
    record.apply(&Event::WindowAnswered { after_secs: 45 }, 105_000, None);
    assert!(record.status().episodes[0].over);
}

#[test]
fn a_window_that_never_answered_is_a_window_episode_from_start() {
    let mut record = Record::default();
    record.apply(&Event::WindowNeverAnswered { secs: 30 }, 1_030_000, None);
    let e = &record.status().episodes[0];
    assert_eq!((e.kind, e.at, e.over), (EpisodeKind::Window, 1_000_000, false));
}

#[test]
fn the_status_is_camel_case_for_the_frontend() {
    let mut record = Record::default();
    record.apply(&Event::WindowSilent { secs: 10 }, 20_000, None);
    let json = serde_json::to_value(record.status()).unwrap();
    assert!(json.get("startedAt").is_some() && json.get("previousRun").is_some());
    assert_eq!(json["episodes"][0]["kind"], "window");
}
