//! Compare (1.179.0), "Include my question": the member's messages read with
//! the answer of the same turn. Hand-built lines in the shapes measured on
//! Claude Code 2.1.332 and Codex 0.172.0 (invented text, fake ids and paths).

use super::*;
use crate::chat_transcript::fixtures::{assistant, interrupt, lines, prompt, result, turn_end};
use crate::compare::{claude_tail, codex_tail, tile_answer, AnswerKind, CompareAnswer, Parsed, TurnState};
use crate::terminal_sessions::{LiveConversation, SessionKind};
use serde_json::json;

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const PLAN_FEEDBACK: &str = include_str!("compare_fixtures/asks-claude-plan-feedback.jsonl");
const PASTED_THEN_TYPED: &str = include_str!("compare_fixtures/asks-claude-pasted-then-typed.jsonl");
const CODEX_STEER: &str = include_str!("compare_fixtures/asks-codex-steer.jsonl");

fn whole(text: &str) -> Parsed {
    claude_tail(text.as_bytes(), true)
}

fn codex(text: &str, whole: bool) -> Parsed {
    codex_tail(text.as_bytes(), whole)
}

fn ms(at: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(at).unwrap().timestamp_millis()
}

fn say(uuid: &str, id: &str, text: &str) -> Value {
    assistant(uuid, id, json!([{"type":"text","text":text}]), Some("end_turn"))
}

fn tool(uuid: &str, id: &str, tool_id: &str, name: &str, input: Value) -> Value {
    assistant(uuid, id, json!([{"type":"tool_use","id":tool_id,"name":name,"input":input}]), Some("tool_use"))
}

/// The messages of a known question, as (kind, text).
fn asked(asks: &Option<TurnAsks>) -> Vec<(AskKind, String)> {
    match asks {
        Some(TurnAsks::Known { messages, .. }) => messages.iter().map(|m| (m.kind, m.text.clone())).collect(),
        other => panic!("expected a known question, got {other:?}"),
    }
}

fn why(asks: &Option<TurnAsks>) -> Option<AsksUnknown> {
    match asks {
        Some(TurnAsks::Unknown { why }) => Some(*why),
        _ => None,
    }
}

/// A refusal of a tool call with a `toolDenialKind`, its text as given.
fn denied(uuid: &str, tool: &str, kind: &str, text: &str) -> Value {
    json!({"type":"user","uuid":uuid,"isSidechain":false,"toolDenialKind":kind,
           "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tool,"is_error":true,"content":text}]}})
}

const SAID_WORDS: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const STOP_WORDS: &str = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

fn queued(uuid: &str, text: &str, turn_index: Option<i64>) -> Value {
    let mut p = prompt(uuid, None, json!(text));
    p["promptSource"] = json!("queued");
    if let Some(t) = turn_index {
        p["turnPosition"] = json!({"promptIndex": t + 1, "turnIndex": t});
    }
    p
}

fn at_turn(mut p: Value, turn_index: i64) -> Value {
    p["turnPosition"] = json!({"promptIndex": turn_index, "turnIndex": turn_index});
    p
}

// ── Claude: what is read ─────────────────────────────────────────────────

#[test]
fn a_plain_claude_turn_carries_its_prompt_with_its_time() {
    let mut p = prompt("u1", None, json!("fix the footer"));
    p["timestamp"] = json!("2026-11-27T09:00:00.000Z");
    let parsed = whole(&lines(&[p, say("a1", "m1", "The footer is fixed."), turn_end("t1")]));
    let Some(TurnAsks::Known { messages, cut }) = &parsed.asks else { panic!("known") };
    assert_eq!(messages.len(), 1);
    assert_eq!((messages[0].kind, messages[0].text.as_str(), messages[0].at_ms), (AskKind::Prompt, "fix the footer", Some(ms("2026-11-27T09:00:00Z"))));
    assert!(!cut);
}

#[test]
fn a_plan_turn_carries_the_prompt_and_the_plan_menu_feedback_but_not_the_esc() {
    // v1, "Tell Claude what to change", v2, Esc on v2's menu (2.1.332's shape).
    let parsed = whole(PLAN_FEEDBACK);
    let found = parsed.found.as_ref().unwrap();
    assert_eq!((parsed.turn, found.kind, found.text.as_str()), (TurnState::Done, AnswerKind::Plan, "1. Add a heading.\n2. Test it."));
    assert_eq!(
        asked(&parsed.asks),
        vec![(AskKind::Prompt, "Plan a heading above the list.".into()), (AskKind::PlanFeedback, "Make it two steps only.".into())],
        "the request blob's copy of the prompt is no second message; the Note after the feedback is Claude's, not the member's"
    );
    let Some(TurnAsks::Known { messages, .. }) = &parsed.asks else { unreachable!() };
    assert_eq!(messages[1].at_ms, Some(ms("2026-11-27T10:31:00Z")), "the refusal's time");
}

#[test]
fn an_esc_refusal_adds_no_words() {
    let parsed = whole(&lines(&[
        prompt("u1", None, json!("plan it")),
        tool("a1", "m1", "toolu_01", "ExitPlanMode", json!({"plan":"1. Do A."})),
        denied("r1", "toolu_01", "user-rejected", STOP_WORDS),
        interrupt("u2", "m1"),
    ]));
    assert_eq!(parsed.found.as_ref().map(|f| f.kind), Some(AnswerKind::Plan));
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "plan it".into())]);
}

#[test]
fn feedback_refusing_another_tool_is_the_member_s_words_too() {
    let parsed = whole(&lines(&[
        prompt("u1", None, json!("tidy the list")),
        tool("a1", "m1", "toolu_01", "Edit", json!({"file_path":"/Users/someone/notes-app/index.html"})),
        denied("r1", "toolu_01", "user-rejected", &format!("{SAID_WORDS}Leave the markup alone.")),
        say("a2", "m2", "Understood, markup left as is."),
        turn_end("t1"),
    ]));
    assert_eq!(
        asked(&parsed.asks),
        vec![(AskKind::Prompt, "tidy the list".into()), (AskKind::Feedback, "Leave the markup alone.".into())]
    );
}

#[test]
fn a_compare_paste_with_typed_words_after_it_is_one_raw_message() {
    // The window, not the read, takes the passed text out (against its passes).
    let parsed = whole(PASTED_THEN_TYPED);
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Agreed: one short heading."));
    assert_eq!(
        asked(&parsed.asks),
        vec![(AskKind::Prompt, "Here is Codex's review.\n\n From Codex:\nThe list needs a heading.\nAlso keep it short.".into())],
        "the paste wrapper unwrapped, the typed words before and after kept"
    );
}

#[test]
fn an_earlier_turn_s_answer_carries_that_turn_s_question() {
    let parsed = whole(&lines(&[
        prompt("u1", None, json!("one")),
        say("a1", "m1", "Answer one."),
        turn_end("t1"),
        prompt("u2", None, json!("two")),
        assistant("a2", "m2", json!([{"type":"text","text":"Half"}]), None),
        interrupt("u3", "m2"),
    ]));
    assert!(parsed.earlier);
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "one".into())], "never the stopped turn's prompt");
    assert_eq!(asked(&parsed.newest_asks), vec![(AskKind::Prompt, "two".into())]);
}

#[test]
fn an_image_alone_adds_no_message() {
    let parsed = whole(&lines(&[
        prompt("u1", None, json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}}])),
        say("a1", "m1", "A screenshot of a list."),
        turn_end("t1"),
    ]));
    assert_eq!(asked(&parsed.asks), Vec::<(AskKind, String)>::new(), "words only");
}

// ── Claude: the cases left out ───────────────────────────────────────────

#[test]
fn case_1_a_turn_whose_prompt_lies_before_the_tail_is_left_out() {
    let tail = lines(&[
        tool("a1", "m1", "toolu_01", "Read", json!({"file_path":"/x"})),
        result("r1", "toolu_01", false),
        say("a2", "m2", "Whole answer."),
        turn_end("t1"),
    ]);
    let parsed = claude_tail(tail.as_bytes(), false);
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Whole answer."));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::StartNotRead));
}

/// A Claude tile with a transcript and a plans folder (the shape
/// `compare_tests::plan_tile` builds).
fn plan_tile(dir: &std::path::Path, transcript: &[Value]) -> LiveConversation {
    let file = dir.join(format!("{SESSION}.jsonl"));
    std::fs::write(&file, lines(transcript)).unwrap();
    let plans = dir.join("plans");
    std::fs::create_dir_all(&plans).unwrap();
    LiveConversation { kind: SessionKind::Claude, id: Some(SESSION.into()), title: None, file: Some(file), pid_names_it: Some(true), newer_elsewhere: false, plans_dir: Some(plans) }
}

fn write_plan(l: &LiveConversation, text: &str, mtime_ms: i64) {
    let path = l.plans_dir.as_ref().unwrap().join(format!("p-of-{SESSION}.md"));
    std::fs::write(&path, text).unwrap();
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms as u64);
    std::fs::File::options().write(true).open(&path).unwrap().set_modified(at).unwrap();
}

fn stamped(mut entries: Vec<Value>, prefix: &str) -> Vec<Value> {
    for (i, e) in entries.iter_mut().enumerate() {
        e["timestamp"] = json!(format!("{prefix}{i}.000Z"));
    }
    entries
}

fn asks_of(got: &CompareAnswer) -> &Option<TurnAsks> {
    &got.turn_asks
}

#[test]
fn a_plan_file_answer_carries_the_open_turn_s_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let mut earlier = say("a0", "m0", "Earlier answer.");
    earlier["timestamp"] = json!("2026-11-27T09:00:00.000Z");
    let mut plan_prompt = prompt("u1", None, json!("plan the footer fix"));
    plan_prompt["permissionMode"] = json!("plan");
    let mut t = vec![prompt("u0", None, json!("zero")), earlier, turn_end("t0")];
    t.extend(stamped(
        vec![plan_prompt, tool("a1", "m1", "toolu_01", "Read", json!({"file_path":"/x"})), result("r1", "toolu_01", false)],
        "2026-11-27T09:45:5",
    ));
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, "# Plan\n1. Move the footer", ms("2026-11-27T09:45:57Z"));
    let got = tile_answer(Some(l));
    assert!(got.from_plan_file && got.plan_pending);
    assert_eq!(asked(asks_of(&got)), vec![(AskKind::Prompt, "plan the footer fix".into())], "the open turn's, not the earlier answer's");
    let shape = serde_json::to_value(&got).unwrap();
    assert_eq!(shape["turnAsks"]["status"], json!("known"));
    assert_eq!(shape["turnAsks"]["messages"][0]["kind"], json!("prompt"));
}

#[test]
fn case_2_a_plan_file_answer_whose_prompt_isn_t_in_the_tail_is_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let t = stamped(
        vec![tool("a1", "m1", "toolu_01", "Read", json!({"file_path":"/x"})), result("r1", "toolu_01", false)],
        "2026-11-27T09:45:5",
    );
    let l = plan_tile(dir.path(), &t);
    write_plan(&l, "# Plan", ms("2026-11-27T09:45:57Z"));
    let got = tile_answer(Some(l));
    assert_eq!(got.answer.as_deref(), Some("# Plan"));
    assert_eq!(why(asks_of(&got)), Some(AsksUnknown::StartNotRead));
}

#[test]
fn case_3_a_turn_started_by_a_command_is_left_out() {
    // A skill command that Claude answered.
    let parsed = whole(&lines(&[
        prompt("s1", None, json!("<command-message>review</command-message>\n<command-name>/review</command-name>")),
        say("s2", "m1", "Review done."),
        turn_end("t1"),
    ]));
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Review done."));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Command));
    // A `!` command Claude answered after.
    let parsed = whole(&lines(&[
        prompt("b1", None, json!("<bash-input>ls</bash-input>")),
        prompt("b2", None, json!("<bash-stdout>index.html</bash-stdout><bash-stderr></bash-stderr>")),
        say("b3", "m1", "One file."),
        turn_end("t1"),
    ]));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Command));
}

#[test]
fn case_4_a_prompt_that_isn_t_the_member_s_is_left_out() {
    // Measured (2.1.332): a background task's notification starts a turn.
    let mut note = prompt("n1", None, json!("<task-notification>The build finished.</task-notification>"));
    note["promptSource"] = json!("system");
    note["origin"] = json!({"kind":"task-notification"});
    let parsed = whole(&lines(&[note, say("a1", "m1", "The build passed."), turn_end("t1")]));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::NotTyped));
    // Typed, but from somewhere other than the member.
    let mut other = prompt("n1", None, json!("go on"));
    other["origin"] = json!({"kind":"hook"});
    assert_eq!(why(&whole(&lines(&[other, say("a1", "m1", "Done."), turn_end("t1")])).asks), Some(AsksUnknown::NotTyped));
    // No `promptSource` at all: a shape not known.
    let mut bare = prompt("n1", None, json!("go on"));
    bare.as_object_mut().unwrap().remove("promptSource");
    assert_eq!(why(&whole(&lines(&[bare, say("a1", "m1", "Done."), turn_end("t1")])).asks), Some(AsksUnknown::NotTyped));
}

#[test]
fn case_5_a_queued_prompt_joins_the_turn_only_when_the_transcript_shows_it() {
    let turn = |queued_prompt: Value, end_between: bool| {
        let mut t = vec![
            at_turn(prompt("u1", None, json!("rename the list")), 5),
            assistant("a1", "m1", json!([{"type":"text","text":"Renaming"}]), None),
        ];
        if end_between {
            t.push(turn_end("t0"));
        }
        t.extend([queued_prompt, say("a2", "m2", "Renamed, and the old name is gone."), turn_end("t1")]);
        whole(&lines(&t))
    };
    // Same turnIndex, no turn end between: one turn of two messages.
    let parsed = turn(queued("u2", "and drop the old name", Some(5)), false);
    assert_eq!(
        asked(&parsed.asks),
        vec![(AskKind::Prompt, "rename the list".into()), (AskKind::Queued, "and drop the old name".into())]
    );
    // Another turnIndex, none at all, or a turn end between: uncertain.
    assert_eq!(why(&turn(queued("u2", "and drop it", Some(6)), false).asks), Some(AsksUnknown::QueuedStart));
    assert_eq!(why(&turn(queued("u2", "and drop it", None), false).asks), Some(AsksUnknown::QueuedStart));
    assert_eq!(why(&turn(queued("u2", "and drop it", Some(5)), true).asks), Some(AsksUnknown::QueuedStart));
    // A queued prompt first in the file: the prompt it joined isn't there.
    let parsed = whole(&lines(&[queued("u2", "and drop it", Some(5)), say("a2", "m2", "Done."), turn_end("t1")]));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::QueuedStart));
}

#[test]
fn case_6_a_refusal_in_a_shape_not_known_leaves_the_question_out() {
    let with = |refusal: Value| {
        whole(&lines(&[
            prompt("u1", None, json!("plan it")),
            tool("a1", "m1", "toolu_01", "ExitPlanMode", json!({"plan":"1. Do A."})),
            refusal,
            tool("a2", "m2", "toolu_02", "ExitPlanMode", json!({"plan":"1. Do B."})),
            denied("r2", "toolu_02", "user-rejected", STOP_WORDS),
            interrupt("u2", "m2"),
        ]))
    };
    // A new wording of "Tell Claude what to change".
    let parsed = with(denied("r1", "toolu_01", "user-rejected", "The user rejected the plan and wrote: shorter."));
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("1. Do B."), "the answer is not affected");
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::FeedbackUnread));
    // The known sentence, with nothing after it.
    assert_eq!(why(&with(denied("r1", "toolu_01", "user-rejected", SAID_WORDS)).asks), Some(AsksUnknown::FeedbackUnread));
    // Words after "the user said" under another kind of refusal.
    assert_eq!(
        why(&with(denied("r1", "toolu_01", "classifier", &format!("{SAID_WORDS}shorter"))).asks),
        Some(AsksUnknown::FeedbackUnread)
    );
    // Another kind of refusal with no words: a rule's, not the member's.
    assert_eq!(
        asked(&with(denied("r1", "toolu_01", "rule", "Denied by a permission rule.")).asks),
        vec![(AskKind::Prompt, "plan it".into())]
    );
}

#[test]
fn case_7_a_compaction_inside_the_turn_leaves_the_question_out() {
    let compaction = [
        json!({"type":"system","subtype":"compact_boundary","uuid":"cb"}),
        json!({"type":"user","uuid":"cs","isCompactSummary":true,"message":{"role":"user","content":"Summary of the talk so far"}}),
    ];
    let mut t = vec![prompt("u1", None, json!("long task")), tool("a1", "m1", "toolu_01", "Read", json!({"file_path":"/x"})), result("r1", "toolu_01", false)];
    t.extend(compaction.clone());
    t.extend([say("a2", "m2", "Finished the long task."), turn_end("t1")]);
    let parsed = whole(&lines(&t));
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Finished the long task."));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Compacted));
    // Before the turn's prompt: no matter.
    let mut t = compaction.to_vec();
    t.extend([prompt("u1", None, json!("next task")), say("a2", "m2", "Done."), turn_end("t1")]);
    assert_eq!(asked(&whole(&lines(&t)).asks), vec![(AskKind::Prompt, "next task".into())]);
}

// ── Codex ────────────────────────────────────────────────────────────────

fn started(turn: &str) -> Value {
    json!({"timestamp":"2026-11-27T12:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":turn}})
}

fn complete(turn: &str, last: Option<&str>) -> Value {
    json!({"timestamp":"2026-11-27T12:01:00.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":last}})
}

fn user_item(text: &str) -> Value {
    json!({"timestamp":"2026-11-27T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}})
}

fn user_event(text: &str) -> Value {
    json!({"timestamp":"2026-11-27T12:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":text,"images":[]}})
}

#[test]
fn a_codex_message_sent_while_the_turn_runs_is_part_of_its_question() {
    // Measured (0.172.0): the steer lands inside the same task_started …
    // task_complete as a second user item; the first turn's injected context
    // comes first and is not the member's; each message is also an event.
    let parsed = codex(CODEX_STEER, true);
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("The list has no heading. Add one."));
    assert_eq!(
        asked(&parsed.asks),
        vec![(AskKind::Prompt, "Review the list markup.".into()), (AskKind::Steer, "Check the heading too.".into())],
        "context skipped, each message once"
    );
    let Some(TurnAsks::Known { messages, .. }) = &parsed.asks else { unreachable!() };
    assert_eq!(messages[1].at_ms, Some(ms("2026-11-27T12:00:09Z")));
}

#[test]
fn a_codex_turn_recorded_only_as_events_reads_them() {
    let parsed = codex(&lines(&[started("t1"), user_event("older shape"), complete("t1", Some("Answer."))]), true);
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "older shape".into())]);
    // A message that looks like context but is recorded as the member's own is kept.
    let parsed = codex(
        &lines(&[started("t1"), user_item("<div> is the wrong tag"), user_event("<div> is the wrong tag"), complete("t1", Some("Answer."))]),
        true,
    );
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "<div> is the wrong tag".into())]);
    // The AGENTS.md block is context.
    let parsed = codex(
        &lines(&[started("t1"), user_item("# AGENTS.md instructions for /Users/someone/notes-app\n\nBe brief."), user_item("go"), complete("t1", Some("A."))]),
        true,
    );
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "go".into())]);
}

#[test]
fn a_codex_earlier_turn_s_answer_carries_its_own_question() {
    let parsed = codex(
        &lines(&[
            started("t1"),
            user_item("first"),
            complete("t1", Some("First answer.")),
            started("t2"),
            user_item("second"),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2"}}),
        ]),
        true,
    );
    assert!(parsed.earlier);
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "first".into())]);
}

#[test]
fn case_8_a_codex_turn_whose_start_isn_t_read_is_left_out() {
    // A partial tail inside the turn: its task_started lies before it.
    let parsed = codex(&lines(&[user_item("late part"), complete("t1", Some("Answer."))]), false);
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Answer."));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::StartNotRead));
    // A whole rollout with no turn markers.
    let parsed = codex(
        &lines(&[user_item("hi"), json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Unmarked."}]}})]),
        true,
    );
    assert_eq!(parsed.found.as_ref().map(|f| f.text.as_str()), Some("Unmarked."));
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::StartNotRead));
}

#[test]
fn case_9_a_codex_user_message_of_an_unknown_shape_is_left_out() {
    let odd = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"go"},{"type":"input_tool_call","name":"x"}]}});
    let parsed = codex(&lines(&[started("t1"), odd, complete("t1", Some("Answer."))]), true);
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::UnknownMessage));
    // An image beside the words is fine: words only.
    let pic = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"look"},{"type":"input_image","image_url":"data:image/png;base64,QUJD"}]}});
    let parsed = codex(&lines(&[started("t1"), pic, complete("t1", Some("Answer."))]), true);
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "look".into())]);
    // A review writes its own messages.
    let review = json!({"type":"event_msg","payload":{"type":"entered_review_mode"}});
    let parsed = codex(&lines(&[started("t1"), review, user_item("review this"), complete("t1", Some("Answer."))]), true);
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Command));
}

#[test]
fn case_10_a_codex_compaction_inside_the_turn_is_left_out() {
    let compacted = json!({"type":"compacted","payload":{"message":"summary"}});
    let parsed = codex(&lines(&[started("t1"), user_item("go"), compacted, complete("t1", Some("Answer."))]), true);
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Compacted));
    let event = json!({"type":"event_msg","payload":{"type":"context_compacted"}});
    let parsed = codex(&lines(&[started("t1"), user_item("go"), event, complete("t1", Some("Answer."))]), true);
    assert_eq!(why(&parsed.asks), Some(AsksUnknown::Compacted));
    // In an earlier turn: no matter.
    let parsed = codex(
        &lines(&[started("t0"), json!({"type":"compacted","payload":{"message":"s"}}), complete("t0", Some("Old.")), started("t1"), user_item("go"), complete("t1", Some("New."))]),
        true,
    );
    assert_eq!(asked(&parsed.asks), vec![(AskKind::Prompt, "go".into())]);
}

// ── The cap, the shape, and nothing leaked ───────────────────────────────

fn ask(text: &str) -> Ask {
    Ask { text: text.into(), at_ms: None, kind: AskKind::Prompt }
}

#[test]
fn the_messages_are_capped_together_at_16000_characters() {
    let TurnAsks::Known { messages, cut } = known(vec![ask(&"a".repeat(20_000))]) else { unreachable!() };
    assert!(cut);
    assert_eq!(messages[0].text.chars().count(), RELAY_CAP);
    let TurnAsks::Known { messages, cut } = known(vec![ask(&"a".repeat(10_000)), ask(&"b".repeat(10_000)), ask("c")]) else { unreachable!() };
    assert!(cut);
    assert_eq!(messages.len(), 2, "nothing past the cap");
    assert_eq!(messages[1].text.chars().count(), 6_000);
    let TurnAsks::Known { messages, cut } = known(vec![ask(&"a".repeat(8_000)), ask(&"b".repeat(8_000))]) else { unreachable!() };
    assert!(!cut && messages.len() == 2, "exactly the cap is whole");
    // Through the read.
    let parsed = whole(&lines(&[prompt("u1", None, json!("q".repeat(17_000))), say("a1", "m1", "Short."), turn_end("t1")]));
    assert!(matches!(&parsed.asks, Some(TurnAsks::Known { cut: true, .. })));
}

#[test]
fn the_window_s_shape_is_stable() {
    let known = TurnAsks::Known { messages: vec![Ask { text: "hi".into(), at_ms: Some(5), kind: AskKind::PlanFeedback }, ask("x")], cut: false };
    assert_eq!(
        serde_json::to_value(&known).unwrap(),
        json!({"status":"known","messages":[{"text":"hi","atMs":5,"kind":"plan-feedback"},{"text":"x","kind":"prompt"}],"cut":false})
    );
    assert_eq!(serde_json::to_value(TurnAsks::Unknown { why: AsksUnknown::StartNotRead }).unwrap(), json!({"status":"unknown","why":"start-not-read"}));
    for why in [
        AsksUnknown::StartNotRead,
        AsksUnknown::Command,
        AsksUnknown::NotTyped,
        AsksUnknown::QueuedStart,
        AsksUnknown::FeedbackUnread,
        AsksUnknown::Compacted,
        AsksUnknown::UnknownMessage,
    ] {
        assert_eq!(serde_json::to_value(why).unwrap(), json!(why.as_str()), "the log's word is the window's");
    }
    for (kind, word) in [(AskKind::Queued, "queued"), (AskKind::Steer, "steer"), (AskKind::Feedback, "feedback")] {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(word));
    }
    // No answer, no question.
    assert!(serde_json::to_value(tile_answer(None)).unwrap().get("turnAsks").is_none());
}

#[test]
fn debug_and_the_log_s_fact_never_show_a_message() {
    let secret = "my secret words";
    let asks = known(vec![ask(secret), Ask { text: secret.into(), at_ms: Some(1), kind: AskKind::Steer }]);
    assert!(!format!("{asks:?}").contains("secret"));
    assert_eq!(asks.fact(), format!("known(2, {})", secret.len() * 2));
    assert!(!format!("{:?}", ask(secret)).contains("secret"));
    assert_eq!(TurnAsks::Unknown { why: AsksUnknown::QueuedStart }.fact(), "unknown(queued-start)");
    // Through what the read gives, and what the window gets.
    let parsed = whole(&lines(&[prompt("u1", None, json!(secret)), say("a1", "m1", "Fine."), turn_end("t1")]));
    assert!(parsed.asks.is_some());
    assert!(!format!("{parsed:?}").contains("secret"));
    let mut answer = tile_answer(None);
    answer.turn_asks = parsed.asks.clone();
    assert!(!format!("{answer:?}").contains("secret"));
}

#[test]
fn the_refusal_s_words_are_read_in_the_measured_shapes_only() {
    let feedback = |s: &str| RefusalWords::Feedback(s.into());
    assert!(refusal_words(&format!("{SAID_WORDS}Make it shorter.")) == feedback("Make it shorter."));
    assert!(
        refusal_words(&format!("{SAID_WORDS}Make it shorter.\n\nNote: The user's next message may contain a correction.")) == feedback("Make it shorter."),
        "Claude's note after the words is not theirs"
    );
    assert!(refusal_words(&format!("{SAID_WORDS}One.\n\nTwo.")) == feedback("One.\n\nTwo."), "the member's own blank lines stay");
    assert!(refusal_words(STOP_WORDS) == RefusalWords::Stopped);
    assert!(refusal_words(SAID_WORDS) == RefusalWords::Unread);
    assert!(refusal_words("Something new.") == RefusalWords::Unread);
}
