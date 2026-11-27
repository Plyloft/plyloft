//! Compare (1.177.0): reading a tile's last finished answer, and the text
//! pasted into the other tile. Synthetic lines in the shapes the spike read
//! (`SPIKE-backend.md` §2, §6); no real transcript content.

use super::*;
use crate::chat_transcript::fixtures::{assistant, interrupt, lines, prompt, result, turn_end};
use crate::terminal_sessions::{record_start, reset_for_tests, serial_for_tests};
use serde_json::json;

fn whole(text: &str) -> Parsed {
    claude_tail(text.as_bytes(), true)
}

fn text_of(p: &Parsed) -> Option<&str> {
    p.found.as_ref().map(|f| f.text.as_str())
}

fn say(uuid: &str, id: &str, text: &str) -> Value {
    assistant(uuid, id, json!([{"type":"text","text":text}]), Some("end_turn"))
}

fn tool(uuid: &str, id: &str, tool_id: &str, name: &str, input: Value) -> Value {
    assistant(uuid, id, json!([{"type":"tool_use","id":tool_id,"name":name,"input":input}]), Some("tool_use"))
}

// ── Claude ───────────────────────────────────────────────────────────────

#[test]
fn a_claude_plain_answer_is_read_with_its_time() {
    let mut answer = say("a1", "m1", "The footer is fixed.");
    answer["timestamp"] = json!("2026-11-24T10:00:05.000Z");
    let p = whole(&lines(&[prompt("u1", None, json!("fix the footer")), answer, turn_end("t1")]));
    assert_eq!(p.turn, TurnState::Done);
    let found = p.found.unwrap();
    assert_eq!((found.text.as_str(), found.kind, found.cut), ("The footer is fixed.", AnswerKind::Text, false));
    assert_eq!(found.at_ms, Some(chrono::DateTime::parse_from_rfc3339("2026-11-24T10:00:05Z").unwrap().timestamp_millis()));
}

#[test]
fn a_claude_answer_is_the_text_after_the_turn_s_last_tool_call() {
    let p = whole(&lines(&[
        prompt("u1", None, json!("look")),
        say("a1", "m1", "Let me read the file."),
        tool("a2", "m1", "toolu_1", "Read", json!({"file_path":"/x"})),
        result("r1", "toolu_1", false),
        say("a3", "m2", "First paragraph."),
        say("a4", "m3", "Second paragraph."),
        turn_end("t1"),
    ]));
    assert_eq!(text_of(&p), Some("First paragraph.\n\nSecond paragraph."), "narration before the tool is left out");
}

#[test]
fn an_open_turn_gives_the_last_finished_answer_and_says_it_is_open() {
    let p = whole(&lines(&[
        prompt("u1", None, json!("one")),
        say("a1", "m1", "Answer one."),
        turn_end("t1"),
        prompt("u2", None, json!("two")),
        assistant("a2", "m2", json!([{"type":"text","text":"Working on it"}]), None),
    ]));
    assert_eq!(p.turn, TurnState::Open);
    assert_eq!(text_of(&p), Some("Answer one."));
    // Waiting on a tool: still open, still the last finished answer.
    let p = whole(&lines(&[
        prompt("u1", None, json!("one")),
        say("a1", "m1", "Answer one."),
        turn_end("t1"),
        prompt("u2", None, json!("two")),
        tool("a2", "m2", "toolu_2", "Bash", json!({"command":"ls"})),
    ]));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Open, Some("Answer one.")));
}

#[test]
fn an_interrupted_turn_has_no_answer_of_its_own() {
    let p = whole(&lines(&[
        prompt("u1", None, json!("one")),
        say("a1", "m1", "Answer one."),
        turn_end("t1"),
        prompt("u2", None, json!("two")),
        assistant("a2", "m2", json!([{"type":"text","text":"Half an ans"}]), None),
        interrupt("u3", "m2"),
    ]));
    assert_eq!(p.turn, TurnState::Done);
    assert_eq!(text_of(&p), Some("Answer one."), "never the half answer");
    // Nothing before it: no answer at all.
    let p = whole(&lines(&[prompt("u2", None, json!("two")), assistant("a2", "m2", json!([{"type":"text","text":"Half"}]), None), interrupt("u3", "m2")]));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, None));
}

#[test]
fn a_compaction_summary_and_sidechain_lines_are_not_answers() {
    let mut side = say("s1", "ms", "A subagent's own words.");
    side["isSidechain"] = json!(true);
    let p = whole(&lines(&[
        prompt("u1", None, json!("one")),
        say("a1", "m1", "Answer one."),
        turn_end("t1"),
        json!({"type":"system","subtype":"compact_boundary","uuid":"cb"}),
        json!({"type":"user","uuid":"cs","isCompactSummary":true,"message":{"role":"user","content":"Summary of the talk so far"}}),
        side,
    ]));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, Some("Answer one.")));
}

#[test]
fn nothing_sent_yet_is_no_turn_and_no_answer() {
    assert_eq!(whole(""), Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false, plan_refused_ms: None, plan_unread: false });
}

// Plan mode, MEASURED on Claude Code 2.1.331 (`MEASURE-planmode.md`): one
// content block per assistant entry, all `stop_reason: "tool_use"`; Claude
// writes the plan file, loads ExitPlanMode through ToolSearch, says one
// sentence, then calls `ExitPlanMode { plan, planFilePath }`; while the menu
// is up there is no tool_result for it and no `turn_duration`.

fn plan_turn() -> Vec<Value> {
    vec![
        prompt("u1", None, json!("plan the footer fix")),
        assistant("a0", "m0", json!([{"type":"thinking","thinking":"hm"}]), Some("tool_use")),
        tool("a1", "m1", "toolu_r", "Read", json!({"file_path":"/x"})),
        result("r1", "toolu_r", false),
        tool("a2", "m2", "toolu_w", "Write", json!({"file_path":"/h/.claude/plans/p.md","content":"## Plan"})),
        result("r2", "toolu_w", false),
        tool("a3", "m3", "toolu_s", "ToolSearch", json!({"query":"select:ExitPlanMode"})),
        result("r3", "toolu_s", false),
        assistant("a4", "m4", json!([{"type":"text","text":"Here is the plan for moving the footer."}]), Some("tool_use")),
        tool("a5", "m5", "toolu_p", "ExitPlanMode", json!({"plan":"## Plan\n1. Move the footer\n2. Test it","planFilePath":"/h/.claude/plans/p.md"})),
        json!({"type":"last-prompt","uuid":"lp"}),
        json!({"type":"cost-state","totalCostUSD":0.1}),
    ]
}

#[test]
fn a_plan_waiting_for_approval_is_the_answer_and_the_turn_is_open() {
    let p = whole(&lines(&plan_turn()));
    assert_eq!(p.turn, TurnState::Open, "the approval menu is up");
    assert!(p.plan_waits, "its ExitPlanMode has no result: the plan waits for the menu");
    let found = p.found.unwrap();
    assert_eq!((found.text.as_str(), found.kind), ("## Plan\n1. Move the footer\n2. Test it", AnswerKind::Plan), "never the narration before it");
}

#[test]
fn a_turn_still_open_after_its_plan_keeps_the_plan_as_the_answer() {
    // Unmeasured (after Approve): Claude goes on working in the same turn.
    let mut going = plan_turn();
    going.extend([result("r9", "toolu_p", false), say("a6", "m6", "Starting now."), tool("a7", "m7", "toolu_e", "Edit", json!({"file_path":"/x"}))]);
    let p = whole(&lines(&going));
    assert_eq!((p.turn, p.found.map(|f| f.kind)), (TurnState::Open, Some(AnswerKind::Plan)));
    assert!(!p.plan_waits, "F4: the menu was answered; the plan is the last finished answer of a turn that goes on");
    // Approved, nothing written after the result yet: the menu is gone too.
    let mut approved = plan_turn();
    approved.push(result("r9", "toolu_p", false));
    assert!(!whole(&lines(&approved)).plan_waits);
    // A permission question later in the same turn (Edit with no result).
    // `going` ends on an Edit with no result: a permission question later in the same turn.
    assert!(!whole(&lines(&going)).plan_waits, "an Edit waiting for its permission is no plan menu");
}

#[test]
fn a_plan_stays_the_answer_after_its_tool_result_approved_or_not() {
    let mut approved = plan_turn();
    approved.push(result("r2", "toolu_p", false));
    let p = whole(&lines(&approved));
    assert_eq!(p.found.as_ref().map(|f| f.kind), Some(AnswerKind::Plan));
    let mut kept = plan_turn();
    kept.push(result("r2", "toolu_p", true));
    let mut stop = interrupt("u9", "m2");
    stop["message"]["content"][0]["text"] = json!("[Request interrupted by user for tool use]");
    kept.push(stop);
    let p = whole(&lines(&kept));
    assert_eq!((p.turn, p.found.as_ref().map(|f| f.kind)), (TurnState::Done, Some(AnswerKind::Plan)));
    // Claude went on after the approval and finished: its final text.
    let mut built = approved.clone();
    built.extend([tool("a4", "m3", "toolu_e", "Edit", json!({"file_path":"/x"})), result("r3", "toolu_e", false), say("a5", "m4", "Done, footer moved."), turn_end("t1")]);
    let p = whole(&lines(&built));
    assert_eq!(p.found.map(|f| (f.text, f.kind)), Some(("Done, footer moved.".into(), AnswerKind::Text)));
}

#[test]
fn the_plan_is_read_leniently_and_one_without_a_plan_is_skipped() {
    assert_eq!(exit_plan_mode_plan(&json!({"plan":"  P  "})), Some("P".into()));
    assert_eq!(exit_plan_mode_plan(&json!({"plan":{"text":"Nested"}})), Some("Nested".into()));
    assert_eq!(exit_plan_mode_plan(&json!({"plan":""})), None);
    assert_eq!(exit_plan_mode_plan(&json!({"other":"x"})), None);
    let p = whole(&lines(&[
        prompt("u0", None, json!("zero")),
        say("a0", "m0", "Earlier answer."),
        turn_end("t0"),
        prompt("u1", None, json!("plan")),
        tool("a1", "m1", "toolu_p", "ExitPlanMode", json!({})),
    ]));
    assert_eq!(text_of(&p), Some("Earlier answer."));
}

// ── The tail ─────────────────────────────────────────────────────────────

/// A reader over bytes in memory that records every size asked for.
fn memory(bytes: Vec<u8>, asked: &std::cell::RefCell<Vec<u64>>) -> impl FnMut(u64) -> Option<(Vec<u8>, bool)> + '_ {
    move |n| {
        asked.borrow_mut().push(n);
        // As `file_tail`: one byte more, so a tail that starts at a line start keeps that line.
        let take = (n as usize + 1).min(bytes.len());
        Some((bytes[bytes.len() - take..].to_vec(), take == bytes.len()))
    }
}

#[test]
fn a_tail_that_starts_mid_line_reads_from_the_next_line_and_a_half_last_line_waits() {
    let older = lines(&[prompt("u0", None, json!("zero")), say("a0", "m0", &"x".repeat(400)), turn_end("t0")]);
    let newer = lines(&[prompt("u1", None, json!("one")), say("a1", "m1", "The newest answer."), turn_end("t1")]);
    let half = r#"{"type":"assistant","uuid":"a9","message":{"id":"m9","content":[{"type":"te"#;
    let all = format!("{older}{newer}{half}");
    let asked = std::cell::RefCell::new(Vec::new());
    // The first look starts inside the long older answer.
    let first = (newer.len() + half.len() + 50) as u64;
    let p = read_tail(memory(all.into_bytes(), &asked), claude_tail, first, 10_000);
    assert_eq!(text_of(&p), Some("The newest answer."));
    assert_eq!(p.turn, TurnState::Done, "the half-written line is not read yet");
    assert_eq!(asked.borrow().len(), 1, "found in the first look");
}

#[test]
fn a_file_larger_than_the_bound_is_read_only_up_to_it() {
    // An old answer, then a long turn of tool calls past the bound, still running.
    let mut entries = vec![prompt("u0", None, json!("zero")), say("a0", "m0", "Old answer."), turn_end("t0"), prompt("u1", None, json!("one"))];
    for i in 0..200 {
        entries.push(tool(&format!("a{i}"), &format!("m{i}"), &format!("toolu_{i}"), "Bash", json!({"command": "y".repeat(200)})));
        entries.push(result(&format!("r{i}"), &format!("toolu_{i}"), false));
    }
    let all = lines(&entries).into_bytes();
    let max = 8_000u64;
    assert!(all.len() as u64 > max * 4);
    let asked = std::cell::RefCell::new(Vec::new());
    let p = read_tail(memory(all.clone(), &asked), claude_tail, 1_000, max);
    assert_eq!(*asked.borrow(), vec![1_000, 4_000, 8_000], "grows four times over, never past the bound");
    assert_eq!((p.turn, text_of(&p)), (TurnState::Open, None), "the old answer lies beyond the bound");
    // Within reach of a whole read, it is found.
    let asked = std::cell::RefCell::new(Vec::new());
    let p = read_tail(memory(all, &asked), claude_tail, 1_000, u64::MAX);
    assert_eq!(text_of(&p), Some("Old answer."));
    assert_eq!(READ_MAX, 4 * 1024 * 1024);
}

#[test]
fn a_tail_cut_inside_a_turn_trusts_only_text_after_a_tool_call_in_view() {
    // The tail begins after the prompt, before a tool call: the text after it is whole.
    let after_tool = lines(&[tool("a1", "m1", "toolu_1", "Read", json!({"file_path":"/x"})), result("r1", "toolu_1", false), say("a2", "m2", "Whole answer."), turn_end("t1")]);
    assert_eq!(text_of(&claude_tail(after_tool.as_bytes(), false)), Some("Whole answer."));
    // The tail begins inside the answer itself: maybe its second half only.
    let no_tool = lines(&[say("a2", "m2", "maybe the second half"), turn_end("t1")]);
    assert_eq!(text_of(&claude_tail(no_tool.as_bytes(), false)), None);
    assert_eq!(text_of(&claude_tail(no_tool.as_bytes(), true)), Some("maybe the second half"), "the whole file: nothing before it");
}

#[test]
fn a_long_answer_is_cut_at_16000_characters_with_the_relay_s_cut_line() {
    let long = "a".repeat(20_000);
    let p = whole(&lines(&[prompt("u1", None, json!("go")), say("a1", "m1", &long), turn_end("t1")]));
    let found = p.found.unwrap();
    assert!(found.cut);
    assert_eq!(found.text.chars().count(), RELAY_CAP);
    assert!(found.text.ends_with("[Plyloft cut this at 16,000 characters]"));
    let short = whole(&lines(&[prompt("u1", None, json!("go")), say("a1", "m1", "short"), turn_end("t1")]));
    assert!(!short.found.unwrap().cut);
    let codex = codex_tail(codex_lines(&[started("t1"), complete("t1", Some(&long))]).as_bytes(), true);
    assert!(codex.found.as_ref().unwrap().cut && codex.found.unwrap().text.chars().count() == RELAY_CAP);
}

// ── Codex ────────────────────────────────────────────────────────────────

fn codex_lines(entries: &[Value]) -> String {
    lines(entries)
}

fn started(turn: &str) -> Value {
    json!({"timestamp":"2026-11-24T10:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":turn,"collaboration_mode_kind":"default"}})
}

fn complete(turn: &str, last: Option<&str>) -> Value {
    json!({"timestamp":"2026-11-24T10:01:00.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":last,"duration_ms":1000}})
}

fn aborted(turn: &str) -> Value {
    json!({"timestamp":"2026-11-24T10:02:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":turn}})
}

fn codex_says(phase: &str, text: &str) -> Value {
    json!({"timestamp":"2026-11-24T10:00:30.000Z","type":"response_item","payload":{"type":"message","role":"assistant","phase":phase,
           "content":[{"type":"output_text","text":text}]}})
}

fn codex_user(text: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
}

#[test]
fn a_codex_answer_is_the_last_task_complete_message() {
    let p = codex_tail(
        codex_lines(&[
            json!({"type":"session_meta","payload":{"id":"c1","source":"cli"}}),
            started("t1"),
            codex_user("review this"),
            codex_says("commentary", "Looking."),
            codex_says("final_answer", "Final words."),
            complete("t1", Some("Final words.")),
        ])
        .as_bytes(),
        true,
    );
    assert_eq!(p.turn, TurnState::Done);
    let found = p.found.unwrap();
    assert_eq!((found.text.as_str(), found.kind), ("Final words.", AnswerKind::Text));
    assert_eq!(found.at_ms, Some(chrono::DateTime::parse_from_rfc3339("2026-11-24T10:01:00Z").unwrap().timestamp_millis()));
}

#[test]
fn a_codex_turn_without_a_last_message_falls_back_to_its_final_answer() {
    let p = codex_tail(codex_lines(&[started("t1"), codex_says("commentary", "Thinking aloud."), codex_says("final_answer", "The real answer."), complete("t1", None)]).as_bytes(), true);
    assert_eq!(text_of(&p), Some("The real answer."));
    // No turn markers at all: the last final answer.
    let p = codex_tail(codex_lines(&[codex_says("final_answer", "Unmarked.")]).as_bytes(), true);
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, Some("Unmarked.")));
}

#[test]
fn a_codex_open_turn_keeps_the_last_answer_and_an_aborted_turn_has_none() {
    let p = codex_tail(
        codex_lines(&[started("t1"), complete("t1", Some("First.")), started("t2"), codex_says("final_answer", "Not finished yet.")]).as_bytes(),
        true,
    );
    assert_eq!((p.turn, text_of(&p)), (TurnState::Open, Some("First.")));
    let p = codex_tail(
        codex_lines(&[started("t1"), complete("t1", Some("First.")), started("t2"), codex_says("final_answer", "Stopped."), aborted("t2")]).as_bytes(),
        true,
    );
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, Some("First.")));
    let p = codex_tail(codex_lines(&[json!({"type":"session_meta","payload":{"id":"c1"}})]).as_bytes(), true);
    assert_eq!(p, Parsed { turn: TurnState::None, found: None, earlier: false, last_entry_ms: None, planning: None, prompt_ms: None, plan_waits: false, plan_answered: false, plan_refused_ms: None, plan_unread: false });
}

// ── Which conversation ───────────────────────────────────────────────────

fn live(kind: SessionKind, id: Option<&str>, pid_names_it: Option<bool>) -> LiveConversation {
    LiveConversation { kind, id: id.map(str::to_string), title: Some("Footer".into()), file: None, pid_names_it, newer_elsewhere: false, plans_dir: None }
}

#[test]
fn only_a_conversation_known_for_sure_is_read() {
    use ConversationLink::{Ambiguous, Known};
    assert_eq!(link_of(&live(SessionKind::Codex, None, None), false), ConversationLink::Unstarted, "no Codex session yet");
    let mut candidates = live(SessionKind::Codex, None, None);
    candidates.newer_elsewhere = true;
    assert_eq!(link_of(&candidates, false), Ambiguous, "sessions it can't tell apart");
    assert_eq!(link_of(&live(SessionKind::Codex, Some("c"), None), false), Known);
    assert_eq!(link_of(&live(SessionKind::Claude, None, None), false), Ambiguous, "a --continue Claude not found yet");
    assert_eq!(link_of(&live(SessionKind::Claude, Some("s"), Some(true)), true), Known);
    assert_eq!(link_of(&live(SessionKind::Claude, Some("s"), Some(false)), false), Ambiguous, "moved since the look");
    assert_eq!(link_of(&live(SessionKind::Claude, Some("s"), None), false), Known, "the spawn id, on a Mac");
    assert_eq!(link_of(&live(SessionKind::Claude, Some("s"), None), true), Ambiguous, "unmeasured on Windows");

    let none = tile_answer(None);
    assert_eq!((none.vendor, none.conversation, none.turn, none.answer.clone()), (None, ConversationLink::None, TurnState::None, None));
    let unclaimed = tile_answer(Some(live(SessionKind::Codex, None, None)));
    assert_eq!((unclaimed.vendor, unclaimed.conversation, unclaimed.answer.clone()), (Some(Vendor::Codex), ConversationLink::Unstarted, None));
    let no_file = tile_answer(Some(live(SessionKind::Codex, Some("c"), None)));
    assert_eq!((no_file.conversation, no_file.turn, no_file.answer.clone()), (Known, TurnState::None, None));
    // The window's shape.
    assert_eq!(serde_json::to_value(&none).unwrap(), json!({"conversation":"none","turn":"none","cut":false,"fromEarlierTurn":false}));
}

#[test]
fn a_live_claude_tile_is_read_from_the_conversation_it_is_in_now() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let key = crate::terminal_sessions::claude_project_key(&cwd);
    record_start(config.path(), "ws", "pty-cmp", SessionKind::Claude, &cwd, Some("s-old".into())).unwrap();
    let write = |name: &str, text: String| {
        let path = claude.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    };
    write(&format!("projects/{key}/s-old.jsonl"), lines(&[prompt("u1", None, json!("old")), say("a1", "m1", "Old conversation's answer."), turn_end("t1")]));
    // `/clear` happened: Claude's per-process file names the new one.
    write("sessions/4242.json", json!({"pid":4242,"sessionId":"s-new"}).to_string());
    write(&format!("projects/{key}/s-new.jsonl"), lines(&[prompt("u2", None, json!("new")), say("a2", "m2", "New conversation's answer."), turn_end("t2")]));
    let got = tile_answer(crate::terminal_sessions::live_conversation("pty-cmp", Some(4242), &homes));
    assert_eq!((got.vendor, got.conversation, got.turn), (Some(Vendor::Claude), ConversationLink::Known, TurnState::Done));
    assert_eq!(got.answer.as_deref(), Some("New conversation's answer."), "never the stale id's");
    assert_eq!(got.chars, Some("New conversation's answer.".chars().count()));
    // Not a recorded tile: none.
    assert_eq!(crate::terminal_sessions::live_conversation("pty-shell", None, &homes), None);
    reset_for_tests();
}

#[test]
fn a_live_codex_tile_whose_session_is_not_claimed_reads_nothing() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let row = record_start(config.path(), "ws", "pty-cx", SessionKind::Codex, &cwd, None).unwrap();
    let read = || tile_answer(crate::terminal_sessions::live_conversation("pty-cx", None, &homes));
    let got = read();
    assert_eq!((got.vendor, got.conversation, got.answer.clone()), (Some(Vendor::Codex), ConversationLink::Unstarted, None), "no turn yet");
    // Two sessions began in the folder since: the tile can't tell which is its.
    let t0 = started_ms(config.path(), &row);
    rollout(codex.path(), "one", &cwd, t0 + 1_000, "x");
    rollout(codex.path(), "two", &cwd, t0 + 2_000, "y");
    let got = read();
    assert_eq!((got.conversation, got.answer.clone()), (ConversationLink::Ambiguous, None));
    reset_for_tests();
}

#[test]
fn debug_never_shows_the_answer() {
    let mut a = tile_answer(None);
    a.answer = Some("secret words".into());
    assert!(!format!("{a:?}").contains("secret"));
    let f = Found { text: "secret words".into(), kind: AnswerKind::Text, at_ms: None, cut: false };
    assert!(!format!("{f:?}").contains("secret"));
}

// ── The text to paste ────────────────────────────────────────────────────

fn parts(answer: &str, note: Option<&str>) -> PasteParts {
    PasteParts {
        lead: Some("Here is the other AI's answer.".into()),
        answer: answer.into(),
        note: note.map(str::to_string),
        from_label: "From Claude:".into(),
        note_label: Some("My note:".into()),
    }
}

#[test]
fn the_paste_is_cleaned_laid_out_and_starts_with_a_space() {
    let text = prepare_paste(&parts("/clear\x1b[201~ then\r\nrun \x1b[31mred\x07", Some("  check step 2\r\n")));
    assert_eq!(text, " Here is the other AI's answer.\n\nFrom Claude:\n/clear[201~ then\nrun [31mred\n\nMy note:\ncheck step 2");
    assert!(!text.contains('\x1b') && !text.contains('\r'));
    assert!(text.starts_with(' '), "a leading `!` or `/` is never a command");
    let bang = prepare_paste(&PasteParts { lead: None, answer: "!rm -rf x".into(), from_label: "".into(), ..Default::default() });
    assert_eq!(bang, " !rm -rf x");
}

#[test]
fn an_empty_or_blank_note_leaves_its_block_out() {
    let expect = " Here is the other AI's answer.\n\nFrom Claude:\nThe answer.";
    assert_eq!(prepare_paste(&parts("The answer.", None)), expect);
    assert_eq!(prepare_paste(&parts("The answer.", Some(""))), expect);
    assert_eq!(prepare_paste(&parts("The answer.", Some(" \n\t \r"))), expect);
}

#[test]
fn the_paste_is_at_most_16000_characters_the_answer_cut_first() {
    let text = prepare_paste(&parts(&"b".repeat(30_000), Some("Keep my note whole.")));
    assert_eq!(text.chars().count(), RELAY_CAP);
    assert!(text.ends_with("[Plyloft cut this at 16,000 characters]\n\nMy note:\nKeep my note whole."), "the note survives the cut");
    let fits = prepare_paste(&parts(&"b".repeat(100), Some("n")));
    assert!(!fits.contains("Plyloft cut"));
    // A note too long on its own: the whole is cut.
    let huge = prepare_paste(&parts("a", Some(&"n".repeat(20_000))));
    assert_eq!(huge.chars().count(), RELAY_CAP);
    assert!(huge.ends_with("[Plyloft cut this at 16,000 characters]"));
}

// ── Review round 1 ───────────────────────────────────────────────────────

fn earlier_of(p: &Parsed) -> bool {
    p.earlier
}

fn finished_turn() -> Vec<Value> {
    vec![prompt("u1", None, json!("one")), say("a1", "m1", "Answer one."), turn_end("t1")]
}

/// M1, measured shapes (reviewer, real files): a local command is a
/// non-`isMeta` user entry starting `<command-name>`, then its output as a
/// `<local-command-stdout>` user entry or `system/local_command`, never a
/// `turn_duration`; a `!` command likewise.
fn local_command(uuid: &str, name: &str) -> Vec<Value> {
    vec![
        json!({"type":"user","uuid":uuid,"isSidechain":false,"message":{"role":"user",
               "content":format!("<command-name>/{name}</command-name>\n            <command-message>{name}</command-message>\n            <command-args></command-args>")}}),
        json!({"type":"user","uuid":format!("{uuid}-out"),"isSidechain":false,"message":{"role":"user",
               "content":"<local-command-stdout>Set model to opus</local-command-stdout>"}}),
        json!({"type":"system","subtype":"local_command","uuid":format!("{uuid}-sys"),"content":"<command-name>/x</command-name>"}),
    ]
}

#[test]
fn a_local_command_after_a_finished_turn_is_no_turn_of_its_own() {
    let mut t = finished_turn();
    t.extend(local_command("c1", "model"));
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p), earlier_of(&p)), (TurnState::Done, Some("Answer one."), false));
    // `/rename`, as Plyloft types it, then `/config`.
    t.extend(local_command("c2", "rename My work"));
    t.extend(local_command("c3", "config"));
    assert_eq!(whole(&lines(&t)).turn, TurnState::Done);
}

#[test]
fn a_fresh_conversation_after_clear_reads_no_turn() {
    let p = whole(&lines(&local_command("c1", "clear")));
    assert_eq!((p.turn, text_of(&p)), (TurnState::None, None));
}

#[test]
fn a_shell_command_is_no_turn_of_its_own() {
    let mut t = finished_turn();
    t.extend([
        prompt("b1", None, json!("<bash-input>git status</bash-input>")),
        prompt("b2", None, json!("<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>")),
    ]);
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, Some("Answer one.")));
}

#[test]
fn a_skill_command_with_an_answer_is_a_turn() {
    let mut t = finished_turn();
    t.push(prompt("s1", None, json!("<command-message>review</command-message>\n<command-name>/review</command-name>")));
    t.push(assistant("s2", "m9", json!([{"type":"text","text":"Reviewing"}]), None));
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Open, Some("Answer one.")));
    t.push(say("s3", "m9", "Review done."));
    t.push(turn_end("t9"));
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p)), (TurnState::Done, Some("Reviewing\nReview done.")));
}

#[test]
fn an_answer_from_an_earlier_turn_says_so_once_the_newest_ended_without_one() {
    // Stopped.
    let mut t = finished_turn();
    t.extend([prompt("u2", None, json!("two")), assistant("a2", "m2", json!([{"type":"text","text":"Half"}]), None), interrupt("u3", "m2")]);
    let p = whole(&lines(&t));
    assert_eq!((text_of(&p), earlier_of(&p)), (Some("Answer one."), true));
    // An API or usage-limit error.
    let mut err = assistant("a2", "m2", json!([{"type":"text","text":"API Error: usage limit reached"}]), None);
    err["isApiErrorMessage"] = json!(true);
    let mut t = finished_turn();
    t.extend([prompt("u2", None, json!("two")), err]);
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p), earlier_of(&p)), (TurnState::Done, Some("Answer one."), true));
    // Still working: the last finished answer, not "earlier".
    let mut t = finished_turn();
    t.extend([prompt("u2", None, json!("two"))]);
    assert!(!earlier_of(&whole(&lines(&t))));
    assert!(!earlier_of(&whole(&lines(&finished_turn()))));
    // Codex: aborted, and completed with no message.
    let p = codex_tail(codex_lines(&[started("t1"), complete("t1", Some("First.")), started("t2"), aborted("t2")]).as_bytes(), true);
    assert_eq!((text_of(&p), earlier_of(&p)), (Some("First."), true));
    let p = codex_tail(codex_lines(&[started("t1"), complete("t1", Some("First.")), started("t2"), complete("t2", None)]).as_bytes(), true);
    assert_eq!((text_of(&p), earlier_of(&p)), (Some("First."), true));
    let p = codex_tail(codex_lines(&[started("t1"), complete("t1", Some("First.")), started("t2")]).as_bytes(), true);
    assert!(!earlier_of(&p));
    let p = codex_tail(codex_lines(&[started("t1"), complete("t1", Some("First."))]).as_bytes(), true);
    assert!(!earlier_of(&p));
}

#[test]
fn a_partial_codex_tail_with_no_turn_marker_is_an_open_turn() {
    let calls = codex_lines(&[
        json!({"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","output":"x"}}),
    ]);
    assert_eq!(codex_tail(calls.as_bytes(), false).turn, TurnState::Open);
    assert_eq!(codex_tail(b"", false).turn, TurnState::None);
}

#[test]
fn a_file_tail_keeps_a_first_line_that_starts_exactly_at_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.jsonl");
    let older = lines(&[prompt("u0", None, json!("zero")), say("a0", "m0", "Old."), turn_end("t0")]);
    let newer = lines(&[prompt("u1", None, json!("one")), say("a1", "m1", "Newest."), turn_end("t1")]);
    std::fs::write(&path, format!("{older}{newer}")).unwrap();
    let n = newer.len() as u64;
    let p = read_tail(file_tail(&path), claude_tail, n, n);
    assert_eq!(text_of(&p), Some("Newest."), "the prompt line is kept, so the turn is whole");
    // The whole file: said so.
    let mut tail = file_tail(&path);
    let (bytes, whole) = tail(1 << 20).unwrap();
    assert!(whole && bytes.len() == older.len() + newer.len());
    assert!(!tail(10).unwrap().1);
    // A first look of nothing still grows.
    let p = read_tail(file_tail(&path), claude_tail, 0, 1 << 20);
    assert_eq!(text_of(&p), Some("Newest."));
}

#[test]
fn the_paste_drops_c1_bidi_and_zero_width_characters_and_turns_tabs_into_spaces() {
    let text = prepare_paste(&PasteParts {
        answer: "a\u{9b}31m\u{202e}b\u{2066}c\u{200b}d\u{feff}e\u{2028}f\u{2029}g\th\u{200e}".into(),
        from_label: "From:".into(),
        ..Default::default()
    });
    // Round 2: line and paragraph separators are new lines, a tab four spaces.
    assert_eq!(text, " From:\na31mbcde\nf\ng    h");
    // Joiners stay: emoji sequences and Persian/Indic text are written with them.
    let joined = prepare_paste(&PasteParts { answer: "👩\u{200d}💻 \u{645}\u{200c}\u{6cc}".into(), from_label: "F".into(), ..Default::default() });
    assert_eq!(joined, " F\n👩\u{200d}💻 \u{645}\u{200c}\u{6cc}");
}

#[test]
fn a_blank_answer_is_no_answer_and_pastes_nothing() {
    assert_eq!(prepare_paste(&parts("\x1b\u{200b}\n \t\r", Some("note"))), "");
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("rollout.jsonl");
    std::fs::write(&file, codex_lines(&[started("t1"), complete("t1", Some("\u{200b}\u{202e}\x1b"))])).unwrap();
    let mut l = live(SessionKind::Codex, Some("c"), None);
    l.file = Some(file);
    let got = tile_answer(Some(l));
    assert_eq!((got.conversation, got.turn, got.answer.clone(), got.chars), (ConversationLink::Known, TurnState::Done, None, None));
}

#[test]
fn a_conversation_written_elsewhere_is_ambiguous() {
    let mut l = live(SessionKind::Codex, Some("c"), None);
    l.newer_elsewhere = true;
    assert_eq!(link_of(&l, false), ConversationLink::Ambiguous);
    let mut l = live(SessionKind::Claude, Some("s"), None);
    l.newer_elsewhere = true;
    assert_eq!(link_of(&l, false), ConversationLink::Ambiguous);
    // With the per-process file naming it, Claude is known whatever else was written.
    let mut l = live(SessionKind::Claude, Some("s"), Some(true));
    l.newer_elsewhere = true;
    assert_eq!(link_of(&l, false), ConversationLink::Known);
}

// End to end, with a temporary Codex home.

fn rollout(home: &std::path::Path, id: &str, cwd: &str, started_ms: i64, answer: &str) -> std::path::PathBuf {
    let ts = chrono::DateTime::from_timestamp_millis(started_ms).unwrap().to_rfc3339();
    let path = home.join(format!("sessions/2026/11/24/rollout-x-{id}.jsonl"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(
        &path,
        codex_lines(&[
            json!({"type":"session_meta","payload":{"id":id,"cwd":cwd,"source":"cli","timestamp":ts}}),
            codex_user("question"),
            started("t1"),
            complete("t1", Some(answer)),
        ]),
    )
    .unwrap();
    path
}

fn set_mtime(path: &std::path::Path, ms: i64) {
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
    std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
}

fn started_ms(config: &std::path::Path, row: &str) -> i64 {
    crate::terminal_sessions::list(config, "ws").into_iter().find(|s| s.row.id == row).unwrap().row.started_at
}

#[test]
fn a_claimed_codex_rollout_is_read_and_another_one_written_in_its_folder_makes_it_ambiguous() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let other_folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let row = record_start(config.path(), "ws", "pty-cx", SessionKind::Codex, &cwd, None).unwrap();
    let t0 = started_ms(config.path(), &row);
    let own = rollout(codex.path(), "own", &cwd, t0 + 1_000, "Codex's answer.");
    let read = || tile_answer(crate::terminal_sessions::live_conversation("pty-cx", None, &homes));
    let got = read();
    assert_eq!((got.conversation, got.answer.as_deref()), (ConversationLink::Known, Some("Codex's answer.")), "claimed, then read");

    // Another folder's, or another running tile's: still known.
    let elsewhere = rollout(codex.path(), "elsewhere", &other_folder.path().to_string_lossy(), t0 + 2_000, "x");
    record_start(config.path(), "ws", "pty-cy", SessionKind::Codex, &cwd, Some("held".into())).unwrap();
    let held = rollout(codex.path(), "held", &cwd, t0 + 3_000, "x");
    assert_eq!(read().conversation, ConversationLink::Known);
    std::fs::remove_file(elsewhere).unwrap();
    std::fs::remove_file(held).unwrap();

    // (a) `/new` in the tile, or a `codex` run outside: a newer unclaimed one in the folder.
    let newer = rollout(codex.path(), "newer", &cwd, t0 + 4_000, "x");
    set_mtime(&newer, t0 + 4_000);
    set_mtime(&own, t0 + 9_000);
    let got = read();
    assert_eq!((got.conversation, got.answer.clone()), (ConversationLink::Ambiguous, None));
    std::fs::remove_file(newer).unwrap();
    assert_eq!(read().conversation, ConversationLink::Known);

    // (c) `/resume` of an older conversation: started before the tile, written after the tile's own.
    let older = rollout(codex.path(), "older", &cwd, t0 - 100_000, "x");
    set_mtime(&older, t0 + 10_000);
    assert_eq!(read().conversation, ConversationLink::Ambiguous);
    set_mtime(&older, t0 - 50_000);
    assert_eq!(read().conversation, ConversationLink::Known, "written before the tile started: not it");
    reset_for_tests();
}

#[test]
fn a_claude_tile_without_its_process_file_is_known_only_while_no_other_transcript_was_written() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let key = crate::terminal_sessions::claude_project_key(&cwd);
    let row = record_start(config.path(), "ws", "pty-cl", SessionKind::Claude, &cwd, Some("s-own".into())).unwrap();
    let t0 = started_ms(config.path(), &row);
    let dir = claude.path().join("projects").join(&key);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("s-own.jsonl"), lines(&finished_turn())).unwrap();
    let before = dir.join("s-before.jsonl");
    std::fs::write(&before, lines(&finished_turn())).unwrap();
    set_mtime(&before, t0 - 60_000);
    let link = || link_of(&crate::terminal_sessions::live_conversation("pty-cl", Some(999_999), &homes).unwrap(), false);
    assert_eq!(link(), ConversationLink::Known, "only its own, and one from before the tile");
    let after = dir.join("s-after.jsonl");
    std::fs::write(&after, lines(&finished_turn())).unwrap();
    set_mtime(&after, t0 + 5_000);
    assert_eq!(link(), ConversationLink::Ambiguous, "a /clear with no process file to say so, or another Claude");
    reset_for_tests();
}

// ── Review round 2 ───────────────────────────────────────────────────────

/// Plyloft's own Codex card intake: a Codex TUI in the project folder
/// (`source: cli`) whose first prompt carries the intake marker.
fn intake_rollout(home: &std::path::Path, id: &str, cwd: &str, started_ms: i64) -> std::path::PathBuf {
    let ts = chrono::DateTime::from_timestamp_millis(started_ms).unwrap().to_rfc3339();
    let path = home.join(format!("sessions/2026/11/24/rollout-x-{id}.jsonl"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let first = format!("instructions…\n\n{}\n\n---\n\nCard title: x", crate::intake::codex_intake_marker("intake-1"));
    std::fs::write(
        &path,
        codex_lines(&[
            json!({"type":"session_meta","payload":{"id":id,"cwd":cwd,"source":"cli","originator":"codex-tui","timestamp":ts}}),
            codex_user(&first),
            started("t1"),
            complete("t1", Some("```json\n{}\n```")),
        ]),
    )
    .unwrap();
    path
}

#[test]
fn plyloft_s_own_codex_intake_is_never_a_tile_s_conversation() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let row = record_start(config.path(), "ws", "pty-in", SessionKind::Codex, &cwd, None).unwrap();
    let t0 = started_ms(config.path(), &row);
    let read = || crate::terminal_sessions::live_conversation("pty-in", None, &homes).unwrap();
    // The intake, alone: never claimed, and the tile hasn't begun.
    intake_rollout(codex.path(), "intake", &cwd, t0 + 1_000);
    let got = read();
    assert_eq!(got.id, None, "codex_claim never takes the intake's");
    assert_eq!(tile_answer(Some(got)).conversation, ConversationLink::Unstarted);
    // The tile's own first turn: claimed (the only candidate), and known though the intake runs on.
    rollout(codex.path(), "own", &cwd, t0 + 2_000, "Codex's answer.");
    let got = read();
    assert_eq!(got.id.as_deref(), Some("own"));
    let answer = tile_answer(Some(got));
    assert_eq!((answer.conversation, answer.answer.as_deref()), (ConversationLink::Known, Some("Codex's answer.")));
    // An intake started after the tile's own and written later: still known.
    let later = intake_rollout(codex.path(), "intake-2", &cwd, t0 + 3_000);
    set_mtime(&later, t0 + 60_000);
    assert_eq!(tile_answer(Some(read())).conversation, ConversationLink::Known);
    reset_for_tests();
}

#[test]
fn an_unclaimed_tile_whose_folder_has_an_older_conversation_written_since_is_ambiguous() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let row = record_start(config.path(), "ws", "pty-rs", SessionKind::Codex, &cwd, None).unwrap();
    let t0 = started_ms(config.path(), &row);
    // The tile's first action was `/resume` of an older conversation.
    let older = rollout(codex.path(), "older", &cwd, t0 - 100_000, "x");
    set_mtime(&older, t0 + 5_000);
    let got = tile_answer(crate::terminal_sessions::live_conversation("pty-rs", None, &homes));
    assert_eq!((got.conversation, got.answer.clone()), (ConversationLink::Ambiguous, None));
    // Last written before the tile started: not it.
    set_mtime(&older, t0 - 50_000);
    let got = tile_answer(crate::terminal_sessions::live_conversation("pty-rs", None, &homes));
    assert_eq!(got.conversation, ConversationLink::Unstarted);
    reset_for_tests();
}

#[test]
fn a_tile_whose_first_turn_reads_the_intake_marker_is_still_claimed() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let codex = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: None, codex: Some(codex.path().to_path_buf()) };
    let folder = tempfile::tempdir().unwrap();
    let cwd = folder.path().to_string_lossy().to_string();
    let row = record_start(config.path(), "ws", "pty-gr", SessionKind::Codex, &cwd, None).unwrap();
    let t0 = started_ms(config.path(), &row);
    // Working on Plyloft itself: the tile's first turn greps intake.rs, so a
    // tool's output (not a user message) holds the marker's words.
    let ts = chrono::DateTime::from_timestamp_millis(t0 + 1_000).unwrap().to_rfc3339();
    let own = codex.path().join("sessions/2026/11/24/rollout-x-own.jsonl");
    std::fs::create_dir_all(own.parent().unwrap()).unwrap();
    std::fs::write(
        &own,
        codex_lines(&[
            json!({"type":"session_meta","payload":{"id":"own","cwd":cwd,"source":"cli","timestamp":ts}}),
            codex_user("grep the intake marker"),
            started("t1"),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1",
                   "output":"intake.rs:775:const CODEX_INTAKE_MARKER: &str = \"Plyloft intake session: \";"}}),
            complete("t1", Some("Found it.")),
        ]),
    )
    .unwrap();
    let got = crate::terminal_sessions::live_conversation("pty-gr", None, &homes).unwrap();
    assert_eq!(got.id.as_deref(), Some("own"), "claimed: the marker is in a tool's output");
    assert_eq!(tile_answer(Some(got)).answer.as_deref(), Some("Found it."));
    assert!(!crate::intake::rollout_is_intake(&own));
    assert!(crate::intake::rollout_is_intake(&intake_rollout(codex.path(), "intake", &cwd, t0 + 2_000)), "the intake's user message");
    reset_for_tests();
}

// ── Plan mode, measured live (Claude Code 2.1.331) ───────────────────────
// While the approval menu is up the transcript is not flushed: it ends
// before the plan's Write and the ExitPlanMode entry. On disk meanwhile:
// the plan file Claude wrote, `<claude config>/plans/<slug>-of-<session>.md`.

const SESSION: &str = "00000000-0000-4000-8000-000000000001";

/// A Claude tile in plan mode: a transcript as it stands on disk, and its
/// plans folder.
fn plan_tile(dir: &std::path::Path, transcript: &[Value]) -> LiveConversation {
    let file = dir.join(format!("{SESSION}.jsonl"));
    std::fs::write(&file, lines(transcript)).unwrap();
    let plans = dir.join("plans");
    std::fs::create_dir_all(&plans).unwrap();
    let mut l = live(SessionKind::Claude, Some(SESSION), Some(true));
    l.file = Some(file);
    l.plans_dir = Some(plans);
    l
}

/// The transcript while the menu is up: the turn's tools so far, the last
/// one a ToolSearch with its result; nothing after.
fn menu_up(with_earlier_answer: bool) -> Vec<Value> {
    let mut t = Vec::new();
    if with_earlier_answer {
        let mut a = say("a0", "m0", "Earlier answer.");
        a["timestamp"] = json!("2026-11-24T21:00:00.000Z");
        t.extend([prompt("u0", None, json!("zero")), a, turn_end("t0")]);
    }
    t.extend(stamped(
        vec![
            in_mode(prompt("u1", None, json!("plan the footer fix")), "plan"),
            tool("a1", "m1", "toolu_r", "Read", json!({"file_path":"/x"})),
            result("r1", "toolu_r", false),
            tool("a2", "m2", "toolu_s", "ToolSearch", json!({"query":"select:ExitPlanMode"})),
            result("r2", "toolu_s", false),
        ],
        "2026-11-24T21:45:5",
    ));
    t
}

/// A prompt as Claude writes it in a permission mode (measured on the
/// walks' transcripts: top-level `permissionMode`, `"plan"` or `"default"`).
fn in_mode(mut prompt: Value, mode: &str) -> Value {
    prompt["permissionMode"] = json!(mode);
    prompt
}

/// Entries stamped `<prefix>0Z`, `<prefix>1Z`… as Claude stamps every line.
fn stamped(mut entries: Vec<Value>, prefix: &str) -> Vec<Value> {
    for (i, e) in entries.iter_mut().enumerate() {
        e["timestamp"] = json!(format!("{prefix}{i}.000Z"));
    }
    entries
}

fn write_plan(l: &LiveConversation, name: &str, text: &str, mtime_ms: i64) {
    let path = l.plans_dir.as_ref().unwrap().join(name);
    std::fs::write(&path, text).unwrap();
    set_mtime(&path, mtime_ms);
}

fn ms(at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(at).unwrap().timestamp_millis()
}

#[test]
fn while_the_plan_menu_is_up_the_plan_file_is_the_answer() {
    let dir = tempfile::tempdir().unwrap();
    let l = plan_tile(dir.path(), &menu_up(true));
    let at = ms("2026-11-24T21:45:57Z");
    write_plan(&l, &format!("plan-in-at-most-lexical-ritchie-of-{SESSION}.md"), "# Plan\n1. Move the footer\n", at);
    let got = tile_answer(Some(l));
    assert_eq!((got.conversation, got.turn), (ConversationLink::Known, TurnState::Open));
    assert_eq!((got.answer.as_deref(), got.answer_kind), (Some("# Plan\n1. Move the footer"), Some(AnswerKind::Plan)));
    assert_eq!((got.finished_at_ms, got.from_earlier_turn, got.cut), (Some(at), false, false));
    assert!(got.from_plan_file);
    assert!(got.plan_pending, "the plan file read while the menu is up is the open turn's own plan");
    assert_eq!(serde_json::to_value(&got).unwrap()["planPending"], json!(true));
}

#[test]
fn a_plan_file_older_than_the_last_finished_answer_is_not_the_answer() {
    let dir = tempfile::tempdir().unwrap();
    let l = plan_tile(dir.path(), &menu_up(true));
    write_plan(&l, &format!("old-plan-of-{SESSION}.md"), "# Old plan", ms("2026-11-24T20:00:00Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Open, Some("Earlier answer."), Some(AnswerKind::Text)));
    assert!(!got.from_plan_file);
}

#[test]
fn another_session_s_plan_file_is_ignored_and_a_blank_one_is_none() {
    let dir = tempfile::tempdir().unwrap();
    let l = plan_tile(dir.path(), &menu_up(false));
    write_plan(&l, "plan-of-11111111-2222-3333-4444-555555555555.md", "# Someone else's", ms("2026-11-24T21:45:57Z"));
    let got = tile_answer(Some(l.clone()));
    assert_eq!((got.turn, got.answer.clone()), (TurnState::Open, None));
    write_plan(&l, &format!("blank-of-{SESSION}.md"), "\n \u{200b}\t\n", ms("2026-11-24T21:45:58Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.turn, got.answer.clone(), got.from_plan_file), (TurnState::Open, None, false));
}

#[test]
fn after_the_flush_the_transcript_s_plan_wins() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(false);
    let mut exit = tool("a3", "m3", "toolu_p", "ExitPlanMode", json!({"plan":"# Plan from the transcript","planFilePath":"/p.md"}));
    exit["timestamp"] = json!("2026-11-24T21:45:57.769Z");
    t.extend([exit, result("r3", "toolu_p", true), interrupt("u9", "m3")]);
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan file", ms("2026-11-24T21:50:00Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Done, Some("# Plan from the transcript"), Some(AnswerKind::Plan)));
    assert!(!got.from_plan_file);
    assert!(!got.plan_pending, "a finished turn's plan waits for nothing");
}

#[test]
fn a_live_claude_tile_s_plans_folder_is_claude_s_own() {
    let _serial = serial_for_tests();
    reset_for_tests();
    let config = tempfile::tempdir().unwrap();
    let claude = tempfile::tempdir().unwrap();
    let homes = CliHomes { claude: Some(claude.path().to_path_buf()), codex: None };
    record_start(config.path(), "ws", "pty-pl", SessionKind::Claude, "/p", Some(SESSION.into())).unwrap();
    let got = crate::terminal_sessions::live_conversation("pty-pl", None, &homes).unwrap();
    assert_eq!(got.plans_dir, Some(claude.path().join("plans")));
    reset_for_tests();
}

#[test]
fn a_plan_file_edited_in_a_later_open_turn_doesn_t_replace_its_finished_answer() {
    let dir = tempfile::tempdir().unwrap();
    // The plan turn ended (approved, built, answered), then a new turn edits the plan file.
    let mut t = menu_up(false);
    let mut done = say("a5", "m5", "Built it.");
    done["timestamp"] = json!("2026-11-24T21:50:00.000Z");
    t.extend([done, turn_end("t1")]);
    t.extend(stamped(
        vec![
            in_mode(prompt("u2", None, json!("adjust the plan")), "default"),
            tool("a6", "m6", "toolu_e", "Edit", json!({"file_path":"/h/.claude/plans/p.md"})),
            result("r6", "toolu_e", false),
        ],
        "2026-11-24T21:55:0",
    ));
    let l = plan_tile(dir.path(), &t);
    // Edited at :55:01, before the tool result Claude stamped :55:02 and flushed.
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Half-edited plan", ms("2026-11-24T21:55:01.500Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Open, Some("Built it."), Some(AnswerKind::Text)));
    assert!(!got.from_plan_file);
}

#[test]
fn no_plan_file_matches_an_empty_session_id() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(format!("p-of-{SESSION}.md")), "# Plan").unwrap();
    assert!(plan_file_answer(dir.path(), "", i64::MIN, i64::MIN).is_none());
    assert!(plan_file_answer(dir.path(), SESSION, i64::MIN, i64::MIN).is_some());
}

// Walk 6 (measured live): how far Claude flushes before the menu varies — the
// plan's Write and its result, stamped just after the file's mtime, can be on
// disk while the menu is up.

#[test]
fn a_planning_turn_with_its_plan_write_flushed_still_offers_the_plan_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(false);
    t.extend(stamped(
        vec![
            tool("a3", "m3", "toolu_w", "Write", json!({"file_path":"/h/.claude/plans/p.md","content":"# Plan"})),
            result("r3", "toolu_w", false),
        ],
        "2026-11-24T21:45:5",
    ));
    // Written at :50.5, before the Write's own entries were stamped.
    let at = ms("2026-11-24T21:45:50.500Z");
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan", at);
    let got = tile_answer(Some(l));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Open, Some("# Plan"), Some(AnswerKind::Plan)));
    assert!(got.from_plan_file);
    assert!(got.plan_pending, "R2-M1: the steps Claude flushes after the file before its menu don't end the wait");
}

#[test]
fn a_turn_whose_prompt_isn_t_in_the_tail_uses_the_plan_file_only_when_nothing_newer_is_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    // The prompt lies before what was read: only the turn's last steps.
    let t = stamped(
        vec![tool("a1", "m1", "toolu_r", "Read", json!({"file_path":"/x"})), result("r1", "toolu_r", false)],
        "2026-11-24T21:45:5",
    );
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan", ms("2026-11-24T21:45:50.500Z"));
    assert_eq!(tile_answer(Some(l.clone())).answer, None, "an entry newer than the plan file is on disk");
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan", ms("2026-11-24T21:45:57Z"));
    assert_eq!(tile_answer(Some(l)).answer.as_deref(), Some("# Plan"));
}

#[test]
fn an_open_turn_typed_outside_plan_mode_never_offers_the_plan_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(true);
    let i = t.iter().position(|e| e["uuid"] == "u1").unwrap();
    t[i]["permissionMode"] = json!("default");
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan", ms("2026-11-24T21:45:57Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.answer.as_deref(), got.from_plan_file), (Some("Earlier answer."), false));
}

#[test]
fn an_abandoned_plan_file_from_before_this_planning_turn_is_not_offered() {
    let dir = tempfile::tempdir().unwrap();
    // Earlier answer at 21:00, this planning turn's prompt at 21:45:50; the
    // plan file was last written at 21:30, by an earlier planning turn.
    let l = plan_tile(dir.path(), &menu_up(true));
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Abandoned plan", ms("2026-11-24T21:30:00Z"));
    let got = tile_answer(Some(l.clone()));
    assert_eq!((got.answer.as_deref(), got.from_plan_file), (Some("Earlier answer."), false));
    // Rewritten in this turn: offered.
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# This plan", ms("2026-11-24T21:45:52.500Z"));
    assert_eq!(tile_answer(Some(l)).answer.as_deref(), Some("# This plan"));
}

#[test]
fn a_turn_that_entered_plan_mode_is_a_planning_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(true);
    let i = t.iter().position(|e| e["uuid"] == "u1").unwrap();
    t[i]["permissionMode"] = json!("default");
    let mut enter = tool("a9", "m9", "toolu_ep", "EnterPlanMode", json!({}));
    enter["timestamp"] = json!("2026-11-24T21:45:55.000Z");
    t.push(enter);
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan", ms("2026-11-24T21:45:56Z"));
    let got = tile_answer(Some(l));
    assert_eq!((got.answer.as_deref(), got.from_plan_file), (Some("# Plan"), true));
}

// F1, real (Windows walk 2026-11-25, Claude Code 2.1.332): Send, then Esc in
// Claude's tile before any output. Claude put the text back in its box; its
// transcript ends on that user entry with nothing after it — no answer, no
// interruption marker. The backend can only say "open"; the window's live
// screen decides that it isn't running (`compareView.openTurnStale`).
#[test]
fn a_prompt_taken_back_by_esc_leaves_the_turn_open_with_the_last_answer() {
    let bytes = include_bytes!("compare_fixtures/win-send-esc-tail.jsonl");
    let p = claude_tail(bytes, false);
    assert_eq!(p.turn, TurnState::Open);
    assert!(!p.plan_waits);
    let found = p.found.unwrap();
    assert!(found.text.starts_with("Noted: Codex says"), "the last finished answer stays on offer");
    assert_eq!(found.at_ms, Some(ms("2026-11-25T08:20:46.050Z")));
}

// Review M2: during the work a later write to the plan file (an edit before
// approval, a re-save) is newer than the ExitPlanMode entry but older than
// what was flushed after it: it is no plan waiting for its menu.
#[test]
fn a_plan_file_rewritten_while_claude_works_is_not_pending() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(false);
    let mut exit = tool("a3", "m3", "toolu_p", "ExitPlanMode", json!({"plan":"# Plan from the transcript","planFilePath":"/p.md"}));
    exit["timestamp"] = json!("2026-11-24T21:46:00.000Z");
    let mut res = result("r3", "toolu_p", false);
    res["timestamp"] = json!("2026-11-24T21:46:10.000Z");
    let mut edit = tool("a4", "m4", "toolu_e", "Edit", json!({"file_path":"/x"}));
    edit["timestamp"] = json!("2026-11-24T21:46:20.000Z");
    t.extend([exit, res, edit]);
    let l = plan_tile(dir.path(), &t);
    // Written after the ExitPlanMode, before the Edit was flushed.
    write_plan(&l, &format!("p-of-{SESSION}.md"), "# Plan file", ms("2026-11-24T21:46:05Z"));
    let got = tile_answer(Some(l.clone()));
    assert_eq!((got.turn, got.answer_kind), (TurnState::Open, Some(AnswerKind::Plan)));
    assert!(!got.plan_pending, "the Edit waiting for permission is no plan menu");
    // The menu answered and nothing after it yet: still not pending.
    let mut answered = menu_up(false);
    let mut exit = tool("a3", "m3", "toolu_p", "ExitPlanMode", json!({"plan":"# Plan","planFilePath":"/p.md"}));
    exit["timestamp"] = json!("2026-11-24T21:46:00.000Z");
    let mut res = result("r3", "toolu_p", false);
    res["timestamp"] = json!("2026-11-24T21:46:10.000Z");
    answered.extend([exit.clone(), res]);
    let l2 = plan_tile(dir.path(), &answered);
    write_plan(&l2, &format!("p-of-{SESSION}.md"), "# Plan file", ms("2026-11-24T21:46:30Z"));
    assert!(!tile_answer(Some(l2)).plan_pending);
    // The ExitPlanMode on disk with no result (the menu up): pending.
    let mut up = menu_up(false);
    up.push(exit);
    let l3 = plan_tile(dir.path(), &up);
    write_plan(&l3, &format!("p-of-{SESSION}.md"), "# Plan file", ms("2026-11-24T21:46:30Z"));
    assert!(tile_answer(Some(l3)).plan_pending);
}

// ── B1: the plan after a write that lands late (Claude Code 2.1.332) ─────
// Measured: when Claude writes the plan file and calls ExitPlanMode in one
// message and the write's result lands after the ExitPlanMode, its
// `input.plan` is the file as it was before that write. The fixtures are
// built by hand in that shape (invented plans, fake ids and paths).

const STALE_AFTER_FEEDBACK: &str = include_str!("compare_fixtures/plan-stale-after-feedback.jsonl");
const STALE_ACROSS_TURNS: &str = include_str!("compare_fixtures/plan-stale-across-turns.jsonl");
const PLAN_V0: &str = "1. Do X.\n2. Do Y.";
const PLAN_V1: &str = "1. Do A.\n2. Do B.\n3. Do C.";
const PLAN_V2: &str = "1. Do A.\n2. Do B.";

fn entries(text: &str) -> Vec<Value> {
    text.lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// Where the fixture line whose uuid ends in `n` is.
fn line_of(t: &[Value], n: u32) -> usize {
    let uuid = format!("00000000-0000-4000-8000-{n:012}");
    t.iter().position(|e| e["uuid"] == uuid.as_str()).unwrap()
}

/// An ExitPlanMode refused on its menu: with the member's words ("Tell
/// Claude what to change"), or by Esc.
fn refused(uuid: &str, tool: &str, feedback: Option<&str>) -> Value {
    let text = match feedback {
        Some(words) => format!("The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\n{words}"),
        None => "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.".to_string(),
    };
    json!({"type":"user","uuid":uuid,"isSidechain":false,"toolDenialKind":"user-rejected",
           "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tool,"is_error":true,"content":text}]}})
}

fn plan_of(p: &Parsed) -> Option<(&str, AnswerKind)> {
    p.found.as_ref().map(|f| (f.text.as_str(), f.kind))
}

#[test]
fn a_stale_plan_after_feedback_is_rebuilt_from_the_plan_file_s_edit() {
    let p = whole(STALE_AFTER_FEEDBACK);
    assert_eq!(p.turn, TurnState::Done, "Esc on the second menu");
    assert_eq!(plan_of(&p), Some((PLAN_V2, AnswerKind::Plan)), "never the first plan the ExitPlanMode still carries");
    assert_eq!(p.found.as_ref().unwrap().at_ms, Some(ms("2026-11-27T10:24:49Z")), "the second ExitPlanMode's time");
    assert!(!p.plan_unread && !p.earlier);
    // The first ExitPlanMode had no plan at all: rebuilt from its Write.
    let i = line_of(&entries(STALE_AFTER_FEEDBACK), 18);
    let mut first = entries(STALE_AFTER_FEEDBACK)[..=i].to_vec();
    first.push(interrupt("u9", "msg_02"));
    assert_eq!(plan_of(&whole(&lines(&first))), Some((PLAN_V1, AnswerKind::Plan)));
    // End to end: the window gets the second plan, and no reason.
    let dir = tempfile::tempdir().unwrap();
    let got = tile_answer(Some(plan_tile(dir.path(), &entries(STALE_AFTER_FEEDBACK))));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Done, Some(PLAN_V2), Some(AnswerKind::Plan)));
    assert!(!got.plan_unread && !got.plan_pending);
    assert_eq!(serde_json::to_value(&got).unwrap().get("planUnread"), None);
}

#[test]
fn a_first_plan_carrying_the_previous_turn_s_plan_is_the_one_its_write_wrote() {
    let p = whole(STALE_ACROSS_TURNS);
    assert_eq!((p.turn, plan_of(&p), p.earlier), (TurnState::Done, Some((PLAN_V1, AnswerKind::Plan)), false));
    // The earlier turn alone (its write's result first): its own plan, as before.
    let t = entries(STALE_ACROSS_TURNS);
    let earlier = &t[..=line_of(&t, 36)];
    assert_eq!(plan_of(&whole(&lines(earlier))), Some((PLAN_V0, AnswerKind::Plan)));
}

#[test]
fn a_plan_file_write_whose_result_comes_first_leaves_the_exit_plan_mode_s_plan() {
    // The good shape (every plan of the Mac captures): the Edit's result
    // before the ExitPlanMode, whose plan is then the file after it.
    let mut t = entries(STALE_AFTER_FEEDBACK);
    let edit_result = t.remove(line_of(&t, 21));
    let exit = line_of(&t, 20);
    t.insert(exit, edit_result);
    t[exit + 1]["message"]["content"][0]["input"]["plan"] = json!("1. Do A.\n2. Do B, as shown.");
    let p = whole(&lines(&t));
    assert_eq!(plan_of(&p), Some(("1. Do A.\n2. Do B, as shown.", AnswerKind::Plan)), "input.plan, unchanged");
}

#[test]
fn a_plan_file_write_that_can_t_be_read_offers_no_plan_and_says_why() {
    // An Edit whose old text isn't in the file it reports.
    let mut t = finished_turn();
    t.extend(entries(STALE_AFTER_FEEDBACK));
    let i = line_of(&t, 21);
    t[i]["toolUseResult"]["originalFile"] = json!("1. Do Z.");
    let p = whole(&lines(&t));
    assert_eq!((p.turn, text_of(&p), p.plan_unread), (TurnState::Done, None, true), "neither the stale plan nor the earlier answer");
    let dir = tempfile::tempdir().unwrap();
    let got = tile_answer(Some(plan_tile(dir.path(), &t)));
    assert_eq!((got.turn, got.answer.clone(), got.from_earlier_turn, got.plan_unread), (TurnState::Done, None, false, true));
    assert_eq!(serde_json::to_value(&got).unwrap()["planUnread"], json!(true));
    // A Write whose result never reached the file.
    let mut t = entries(STALE_ACROSS_TURNS);
    t.remove(line_of(&t, 44));
    let p = whole(&lines(&t));
    assert_eq!((text_of(&p), p.plan_unread), (None, true), "never the earlier turn's plan");
    // A Write that failed.
    let mut t = entries(STALE_ACROSS_TURNS);
    let i = line_of(&t, 44);
    t[i]["message"]["content"][0]["is_error"] = json!(true);
    assert_eq!((text_of(&whole(&lines(&t))), whole(&lines(&t)).plan_unread), (None, true));
}

#[test]
fn no_plan_file_write_since_the_last_exit_plan_mode_keeps_its_plan() {
    // Nothing changed the file between the two menus: the second
    // ExitPlanMode's own plan is right.
    let mut t = entries(STALE_AFTER_FEEDBACK);
    t.remove(line_of(&t, 21));
    t.remove(line_of(&t, 19));
    assert_eq!(plan_of(&whole(&lines(&t))), Some((PLAN_V1, AnswerKind::Plan)));
    // An Edit of another file is no write of the plan.
    let mut t = entries(STALE_AFTER_FEEDBACK);
    let i = line_of(&t, 19);
    t[i]["message"]["content"][0]["input"]["file_path"] = json!("/Users/someone/notes-app/index.html");
    assert_eq!(plan_of(&whole(&lines(&t))), Some((PLAN_V1, AnswerKind::Plan)));
}

#[test]
fn a_plan_less_last_exit_plan_mode_no_longer_falls_back_to_an_older_one() {
    let mut t = finished_turn();
    t.extend([
        in_mode(prompt("u2", None, json!("plan it")), "plan"),
        tool("a2", "m2", "toolu_p1", "ExitPlanMode", json!({"plan": PLAN_V1})),
        refused("r2", "toolu_p1", Some("Make it two steps only.")),
        tool("a3", "m3", "toolu_p2", "ExitPlanMode", json!({})),
        refused("r3", "toolu_p2", None),
        interrupt("u9", "m3"),
    ]);
    let p = whole(&lines(&t));
    assert_ne!(text_of(&p), Some(PLAN_V1), "the turn's last ExitPlanMode is the last one, readable or not");
    assert_eq!((text_of(&p), p.earlier), (Some("Answer one."), true));
}

#[test]
fn the_second_plan_s_menu_is_pending_like_the_first() {
    // Measured (Mac, 2.1.332): on the second plan's menu the transcript ends
    // with the first plan's ExitPlanMode and its refusal with feedback; the
    // plan file was rewritten after that refusal.
    let dir = tempfile::tempdir().unwrap();
    let mut t = menu_up(false);
    t.extend(stamped(
        vec![
            tool("a3", "m3", "toolu_w", "Write", json!({"file_path":"/h/.claude/plans/p.md","content":PLAN_V1})),
            tool("a4", "m3", "toolu_p", "ExitPlanMode", json!({"plan":PLAN_V1,"planFilePath":"/h/.claude/plans/p.md"})),
            result("r3", "toolu_w", false),
            refused("r4", "toolu_p", Some("Make it two steps only.")),
        ],
        "2026-11-24T21:46:0",
    ));
    let p = whole(&lines(&t));
    assert_eq!((p.turn, p.plan_answered, p.plan_refused_ms), (TurnState::Open, true, Some(ms("2026-11-24T21:46:03Z"))));
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, &format!("p-of-{SESSION}.md"), PLAN_V2, ms("2026-11-24T21:46:07Z"));
    let got = tile_answer(Some(l.clone()));
    assert_eq!((got.turn, got.answer.as_deref(), got.answer_kind), (TurnState::Open, Some(PLAN_V2), Some(AnswerKind::Plan)));
    assert!(got.from_plan_file);
    assert!(got.plan_pending, "the second menu waits as the first did");
    // A plan file written before that refusal is no second plan's menu.
    write_plan(&l, &format!("p-of-{SESSION}.md"), PLAN_V2, ms("2026-11-24T21:46:02.500Z"));
    let got = tile_answer(Some(l));
    assert!(got.from_plan_file && !got.plan_pending);
    // Refused without feedback and still open (no interrupt yet on disk): no
    // second menu follows, nothing is pending.
    let mut esc = t.clone();
    let last = esc.len() - 1;
    esc[last] = refused("r4", "toolu_p", None);
    esc[last]["timestamp"] = json!("2026-11-24T21:46:03.000Z");
    assert_eq!(whole(&lines(&esc)).plan_refused_ms, None);
    // The first menu, as before: no ExitPlanMode on disk, the plan file newer.
    let dir = tempfile::tempdir().unwrap();
    let l = plan_tile(dir.path(), &menu_up(false));
    write_plan(&l, &format!("p-of-{SESSION}.md"), PLAN_V1, ms("2026-11-24T21:45:57Z"));
    let got = tile_answer(Some(l));
    assert!(got.from_plan_file && got.plan_pending);
}

// ── The plan file is tied to the session, never guessed from a folder ────
// Measured (2.1.332): a session's first ExitPlanMode can come with an empty
// input (no `plan`, no `planFilePath`); every later one names the same file,
// `<claude config>/plans/<slug>-of-<session id>.md`. A project's own
// `docs/plans/*.md` written in the same span is not that file.

const ROADMAP_PATH: &str = "/Users/someone/notes-app/docs/plans/roadmap.md";
const ROADMAP: &str = "# Roadmap\n1. Ship the list.";

/// The first plan of `STALE_AFTER_FEEDBACK` (its Write's result after its
/// ExitPlanMode), ended by Esc, with an empty ExitPlanMode input; its Write
/// goes to `path` with `content` when given.
fn first_plan_with_empty_input(write: Option<(&str, &str)>) -> Vec<Value> {
    let t = entries(STALE_AFTER_FEEDBACK);
    let mut t = t[..=line_of(&t, 18)].to_vec();
    let exit = line_of(&t, 15);
    t[exit]["message"]["content"][0]["input"] = json!({});
    if let Some((path, content)) = write {
        let w = line_of(&t, 14);
        t[w]["message"]["content"][0]["input"] = json!({"file_path": path, "content": content});
        let r = line_of(&t, 16);
        t[r]["toolUseResult"]["filePath"] = json!(path);
        t[r]["toolUseResult"]["content"] = json!(content);
    }
    t.push(interrupt("u9", "msg_02"));
    t
}

#[test]
fn a_project_plans_folder_write_is_never_offered_as_a_plan_less_exit_plan_mode_s_plan() {
    let mut t = finished_turn();
    t.extend(first_plan_with_empty_input(Some((ROADMAP_PATH, ROADMAP))));
    let p = whole(&lines(&t));
    assert_ne!(text_of(&p), Some(ROADMAP));
    // As a plan-less ExitPlanMode with no write of its plan: the turn has no
    // answer of its own, the earlier one stands.
    assert_eq!((p.turn, text_of(&p), p.earlier, p.plan_unread), (TurnState::Done, Some("Answer one."), true, false));
    let alone = whole(&lines(&first_plan_with_empty_input(Some((ROADMAP_PATH, ROADMAP)))));
    assert_eq!((text_of(&alone), alone.plan_unread), (None, false));
}

#[test]
fn a_plan_less_exit_plan_mode_is_rebuilt_from_the_session_s_own_plan_file() {
    // Rule (b): `plans/<slug>-of-<session id>.md`, the fixture's own file.
    let p = whole(&lines(&first_plan_with_empty_input(None)));
    assert_eq!(plan_of(&p), Some((PLAN_V1, AnswerKind::Plan)));
    // Named for another session: not this one's plan.
    let other = "/Users/someone/.claude/plans/tidy-the-list-of-00000000-0000-4000-8000-000000000002.md";
    let p = whole(&lines(&first_plan_with_empty_input(Some((other, PLAN_V1)))));
    assert_eq!((text_of(&p), p.plan_unread), (None, false));
    // No session id on the entries: nothing ties the file to the session.
    let mut t = first_plan_with_empty_input(None);
    for e in &mut t {
        if let Some(map) = e.as_object_mut() {
            map.remove("sessionId");
        }
    }
    assert_eq!(text_of(&whole(&lines(&t))), None);
}

#[test]
fn a_plan_less_exit_plan_mode_is_rebuilt_from_the_file_a_later_exit_plan_mode_names() {
    // Rule (a): the file name doesn't end in the session id, but a later
    // turn's ExitPlanMode names it.
    let path = "/Users/someone/.claude/plans/tidy-the-list.md";
    let first = first_plan_with_empty_input(Some((path, PLAN_V1)));
    assert_eq!(text_of(&whole(&lines(&first))), None, "alone, nothing ties it to the session");
    let mut t = first;
    t.extend([
        in_mode(prompt("u5", None, json!("Plan it again.")), "plan"),
        tool("a5", "m5", "toolu_p5", "ExitPlanMode", json!({"planFilePath": path})),
        refused("r5", "toolu_p5", None),
        interrupt("u6", "m5"),
    ]);
    let p = whole(&lines(&t));
    assert_eq!((plan_of(&p), p.earlier), (Some((PLAN_V1, AnswerKind::Plan)), true));
}

#[test]
fn the_plan_file_s_write_wins_over_a_later_write_to_a_project_plans_folder() {
    let base = entries(STALE_AFTER_FEEDBACK);
    let mut t = base[..=line_of(&base, 18)].to_vec();
    let w = line_of(&t, 14);
    t.insert(w + 1, tool("a9", "msg_09", "toolu_09", "Write", json!({"file_path": ROADMAP_PATH, "content": ROADMAP})));
    let r = line_of(&t, 16);
    t.insert(r + 1, result("r9", "toolu_09", false));
    t.push(interrupt("u9", "msg_02"));
    assert_eq!(plan_of(&whole(&lines(&t))), Some((PLAN_V1, AnswerKind::Plan)), "the ExitPlanMode names its file");
    // The same with an empty input: the session's file still wins.
    let exit = line_of(&t, 15);
    t[exit]["message"]["content"][0]["input"] = json!({});
    assert_eq!(plan_of(&whole(&lines(&t))), Some((PLAN_V1, AnswerKind::Plan)), "rule (b)");
}
