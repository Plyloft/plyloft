//! `chat`: the send text, the composer and screen matchers, the Claude argv
//! against the read-only profile, the raw attachment request, the wiring
//! into the delete and cleanup paths, and the registry's lifecycle driven by
//! fake CLIs (a bash `claude` that writes a transcript in the measured
//! shapes, draws its composer and reads bracketed pastes and Esc from its
//! terminal; a bash `codex app-server` that answers the JSON-RPC Plyloft
//! sends). No real Claude or Codex runs.

use super::*;

#[test]
fn every_claude_message_starts_with_one_space_and_carries_no_control() {
    assert_eq!(composer_text("hello"), " hello");
    assert_eq!(composer_text("!pwd > x"), " !pwd > x");
    assert_eq!(composer_text("/cost"), " /cost");
    assert_eq!(composer_text("--help"), " --help");
    assert_eq!(composer_text("&background"), " &background");
    assert_eq!(composer_text("\n!x"), " \n!x");
    assert_eq!(composer_text("\x1b[201~\r!cmd\r"), " [201~!cmd");
    assert_eq!(composer_text("tab\tand\nline"), " tab\tand\nline");
    assert_eq!(composer_text("del\u{7f} and c1\u{9b}x"), " del and c1x");
    assert_eq!(paste_bytes("!rm -rf"), b"\x1b[200~ !rm -rf\x1b[201~\r".to_vec());
    let hostile = paste_bytes("a\x1b[201~\r/clear\r");
    assert_eq!(hostile.iter().filter(|b| **b == 0x1b).count(), 2, "only the paste's own two ESCs");
    assert_eq!(hostile.iter().filter(|b| **b == b'\r').count(), 1, "only its own Enter");
}

/// 1.171.0 (E1): a chat that never chose a vendor opens on the card's
/// Builder; one the person chose, or an older file's only conversation,
/// keeps its own.
#[test]
fn a_chat_with_no_vendor_chosen_opens_on_the_preferred_one() {
    let file = |json: &str| serde_json::from_str::<crate::chat_store::CardChatFile>(json).unwrap();
    let empty = file("{}");
    assert_eq!(shown_vendor(&empty, Some(ChatVendor::Codex)), ChatVendor::Codex);
    assert_eq!(shown_vendor(&empty, None), ChatVendor::Claude, "as before without one");
    assert_eq!(shown_vendor(&empty, Some(ChatVendor::Other)), ChatVendor::Claude);
    let chosen = file(r#"{"activeVendor":"claude"}"#);
    assert_eq!(shown_vendor(&chosen, Some(ChatVendor::Codex)), ChatVendor::Claude, "the person's choice stays");
    let older = file(r#"{"conversations":[{"vendor":"claude","messages":[{"id":"m1","role":"user","text":"hi"}]}]}"#);
    assert_eq!(shown_vendor(&older, Some(ChatVendor::Codex)), ChatVendor::Claude, "its history opens");
    let untouched = file(r#"{"conversations":[{"vendor":"claude","messages":[]}]}"#);
    assert_eq!(shown_vendor(&untouched, Some(ChatVendor::Codex)), ChatVendor::Codex);
}

/// The chat's argv carries exactly the read-only profile v3 the reviews
/// prove (`read_only_provider`), whatever else it adds.
#[test]
fn the_claude_chat_argv_is_the_read_only_profile_plus_its_folders() {
    let model = crate::settings::ModelChoice::default();
    let review = crate::read_only_provider::read_only_argv_for(
        ply_collab::Provider::Claude,
        "x",
        Path::new("/tmp"),
        &model,
        false,
    );
    let profile = crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &review, false).unwrap();
    let dirs = vec![PathBuf::from("/a b/attachments"), PathBuf::from("/repo")];
    let chat = claude_chat_argv("11111111-2222-3333-4444-555555555555", false, &dirs, "be brief", Some("/cost"), &model);
    assert_eq!(
        crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &chat, false).unwrap(),
        profile,
        "same profile as a review"
    );
    assert!(!chat.iter().any(|a| a == "-p" || a == "--print"));
    assert!(crate::pty::refuse_print_mode("claude", &chat).is_ok());
    let add = chat.iter().position(|a| a == "--add-dir").unwrap();
    assert_eq!(&chat[add + 1..add + 3], &["/a b/attachments".to_string(), "/repo".to_string()]);
    // The prompt is last, after a flag that takes no value, with its space.
    assert_eq!(chat[chat.len() - 2], "--strict-mcp-config");
    assert_eq!(chat.last().unwrap(), " /cost");
    // A resume starts with no prompt: its message is pasted at the composer.
    let resumed = claude_chat_argv("u", true, &dirs, "be brief", None, &model);
    assert_eq!(&resumed[..2], &["--resume".to_string(), "u".to_string()]);
    assert_eq!(resumed.last().unwrap(), "--strict-mcp-config");
}

/// 1.168.1 (E1): a chat or plan lane runs on the model chosen for its
/// role — before, neither vendor's chat passed one. The read-only profile
/// is unchanged by it, and a blank choice passes nothing.
#[test]
fn chat_sessions_carry_the_chosen_model() {
    let dirs = vec![PathBuf::from("/repo")];
    let opus = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: None };
    let none = crate::settings::ModelChoice::default();
    let chat = claude_chat_argv("u", false, &dirs, "be brief", Some("hi"), &opus);
    let at = chat.iter().position(|a| a == "--model").expect("--model");
    assert_eq!(chat[at + 1], "opus");
    assert_eq!(chat[at - 1], "--strict-mcp-config", "after the flag that takes no value");
    assert_eq!(chat.last().unwrap(), " hi", "the prompt stays last");
    assert_eq!(
        crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &chat, false).unwrap(),
        crate::read_only_provider::restriction_argv_profile_for(
            ply_collab::Provider::Claude,
            &claude_chat_argv("u", false, &dirs, "be brief", Some("hi"), &none),
            false
        )
        .unwrap(),
    );
    let resumed = claude_chat_argv("u", true, &dirs, "be brief", None, &opus);
    assert_eq!(&resumed[resumed.len() - 2..], &["--model".to_string(), "opus".to_string()]);
    assert!(!claude_chat_argv("u", false, &dirs, "x", None, &none).iter().any(|a| a == "--model"));
    // 1.169.0 (A1): Claude's effort beside the model, the read-only profile unchanged.
    let high = crate::settings::ModelChoice { model: Some("opus".into()), reasoning: Some("high".into()) };
    let chat = claude_chat_argv("u", false, &dirs, "be brief", Some("hi"), &high);
    let at = chat.iter().position(|a| a == "--effort").expect("--effort");
    assert_eq!(chat[at + 1], "high");
    assert_eq!(chat.last().unwrap(), " hi");
    assert_eq!(
        crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &chat, false).unwrap(),
        crate::read_only_provider::restriction_argv_profile_for(
            ply_collab::Provider::Claude,
            &claude_chat_argv("u", false, &dirs, "be brief", Some("hi"), &none),
            false
        )
        .unwrap(),
    );

    let mut config = serde_json::Map::new();
    config.insert("mcp_servers.a.enabled".into(), serde_json::Value::Bool(false));
    let codex = crate::settings::ModelChoice { model: Some("gpt-6-astra".into()), reasoning: Some("low".into()) };
    let params = codex_thread_params_for(Path::new("/lane"), "be brief", &config, &codex);
    assert_eq!(params["model"], "gpt-6-astra");
    assert_eq!(params["config"]["model_reasoning_effort"], "low");
    assert_eq!(params["config"]["mcp_servers.a.enabled"], false);
    assert_eq!(params["sandbox"], "read-only");
    let plain = codex_thread_params_for(Path::new("/lane"), "be brief", &serde_json::Map::new(), &none);
    assert!(plain.get("model").is_none() && plain.get("config").is_none(), "{plain}");

    // The lanes' roles: Chat and the proposer build, the critic reviews.
    use crate::settings::AgentRole;
    assert_eq!(chat_lane_role(&Lane::Chat), AgentRole::Builder);
    assert_eq!(chat_lane_role(&Lane::Plan { exchange: "x".into(), role: PlanRole::Proposer }), AgentRole::Builder);
    assert_eq!(chat_lane_role(&Lane::Plan { exchange: "x".into(), role: PlanRole::Critic }), AgentRole::Challenger);
}

#[test]
fn each_vendor_is_told_what_it_can_do() {
    let context = ChatContext { title: "T\x1b[2J".into(), notes: "n".into(), project_dir: Some("/repo".into()), plan: None, pull_request: None };
    let claude = chat_instructions(ChatVendor::Claude, &context, Path::new("/att"));
    let codex = chat_instructions(ChatVendor::Codex, &context, Path::new("/att"));
    assert!(claude.contains("cannot run commands"));
    assert!(codex.contains("read-only commands"));
    assert!(!claude.contains('\x1b'), "no control character from a card's title");
    assert!(codex.contains("/repo") && codex.contains("/att"));
    assert!(!claude.contains("Its plan"), "no plan block without a plan");
}

/// Plan with two AIs §3: a card's plan is told in a block of its own,
/// capped, beside its title and notes (never in their place), so a Chat
/// knows an accepted plan.
#[test]
fn a_card_s_plan_gets_its_own_capped_block_beside_title_and_notes() {
    let long = format!("## Goal\n{}", "x".repeat(PLAN_BLOCK_CAP * 2));
    let context = ChatContext { title: "Import".into(), notes: "Small.".into(), project_dir: None, plan: Some(long), pull_request: None };
    let text = chat_instructions(ChatVendor::Claude, &context, Path::new("/att"));
    assert!(text.contains("The card: Import") && text.contains("Its notes:\nSmall."));
    let block = text.split("Its plan, as the card holds it now:\n").nth(1).unwrap();
    assert!(block.starts_with("## Goal"));
    assert!(block.contains("[cut here]"));
    assert!(block.chars().count() < PLAN_BLOCK_CAP + 200, "capped at {PLAN_BLOCK_CAP}");
}

/// Q5: every per-lane name comes from the lane's role, never its vendor.
#[test]
fn plan_lanes_are_named_by_role_and_never_share_a_folder_or_session_key() {
    let registry = ChatRegistry::new(PathBuf::from("/cfg"));
    let proposer = ChatKey::plan("ws", "card", "0123456789abcdef-x", PlanRole::Proposer);
    let critic = ChatKey::plan("ws", "card", "0123456789abcdef-x", PlanRole::Critic);
    let chat = ChatKey::chat("ws", "card");
    let (p, c, ch) = (registry.lane_dir(&proposer).unwrap(), registry.lane_dir(&critic).unwrap(), registry.lane_dir(&chat).unwrap());
    assert_eq!(p, ch.join("plan-0123456789ab").join("proposer"));
    assert_eq!(c, ch.join("plan-0123456789ab").join("critic"));
    assert_eq!(codex_session_key(&chat), "chat:ws:card");
    assert_eq!(codex_session_key(&proposer), "plan:ws:card:0123456789abcdef-x:proposer");
    assert_eq!(codex_session_key(&critic), "plan:ws:card:0123456789abcdef-x:critic");
    assert!(registry.lane_dir(&ChatKey::plan("ws", "../x", "e", PlanRole::Critic)).is_err());
}

/// Plan with two AIs §3: one choke point for turn ends. Every `slot.status
/// =` assignment in `chat.rs` goes through `set_status`, but the allowed
/// few: `Slot::new`'s initial `Idle`, `take_proc`'s own, `set_status`'s
/// own, and the moves *into* `Working` (a send, `turn/started`), which end
/// no turn.
#[test]
fn every_status_change_goes_through_set_status() {
    let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/chat.rs")).unwrap();
    let code = &source[..source.find("#[cfg(test)]\n#[path = \"chat_tests.rs\"]").unwrap()];
    let mut found = Vec::new();
    for line in code.lines() {
        let line = line.trim();
        if line.starts_with("slot.status = ") {
            found.push(line.to_string());
        }
    }
    let allowed = ["slot.status = status;", "slot.status = ChatStatus::Working;"];
    let stray: Vec<&String> = found.iter().filter(|line| !allowed.contains(&line.as_str())).collect();
    assert!(stray.is_empty(), "status set outside set_status: {stray:?}");
    // `status: ChatStatus::Idle` in `Slot::new`, and exactly two `= status`:
    // `set_status` and `take_proc`.
    assert_eq!(found.iter().filter(|l| *l == "slot.status = status;").count(), 2, "{found:?}");
    assert!(code.contains("status: ChatStatus::Idle,"));
}

#[test]
fn codex_chats_turn_the_member_s_mcp_servers_off() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("config.toml"),
        "model = \"x\"\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n[mcp_servers.\"docs.internal\"]\nurl = \"http://x\"\n",
    )
    .unwrap();
    let config = codex_chat_config(home.path());
    assert_eq!(config.get("mcp_servers.github.enabled"), Some(&serde_json::Value::Bool(false)));
    assert_eq!(
        config.get("mcp_servers.\"docs.internal\".enabled"),
        Some(&serde_json::Value::Bool(false)),
        "a name with a dot is quoted: {config:?}"
    );
    assert!(codex_chat_config(&home.path().join("none")).keys().all(|k| k == "windows.sandbox"));
}

#[test]
fn the_raw_attachment_request_carries_its_card_and_name_in_headers() {
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert(HEADER_WORKSPACE, "ws-1".parse().unwrap());
    headers.insert(HEADER_CARD, "card-1".parse().unwrap());
    headers.insert(HEADER_NAME, "Quarterly%20plan%20%C3%A9.pdf".parse().unwrap());
    let body = tauri::ipc::InvokeBody::Raw(b"%PDF-1.7".to_vec());
    let (ws, card, name, bytes) = attachment_request(&headers, &body).unwrap();
    assert_eq!((ws.as_str(), card.as_str(), name.as_str()), ("ws-1", "card-1", "Quarterly plan é.pdf"));
    assert_eq!(bytes, b"%PDF-1.7");
    let json = tauri::ipc::InvokeBody::Json(serde_json::json!([1, 2, 3]));
    assert!(attachment_request(&headers, &json).unwrap_err().contains("raw request body"));
    headers.insert(HEADER_NAME, "evil%1B%5B2J.md".parse().unwrap());
    let (_, _, name, _) = attachment_request(&headers, &body).unwrap();
    assert!(chat_attachments::prepare(&name, b"x").unwrap_err().contains("control characters"));
    headers.remove(HEADER_CARD);
    assert!(attachment_request(&headers, &body).unwrap_err().contains(HEADER_CARD));
    assert!(percent_decode("%ZZ").is_err());
    assert!(percent_decode("%C3").is_err(), "half a character");
}

#[test]
fn a_transcript_prompt_takes_the_oldest_waiting_message_and_a_re_read_changes_nothing() {
    use crate::chat_transcript::fixtures::*;
    let mut conversation = chat_store::Conversation::new(ChatVendor::Claude, 0);
    let mine = ChatMessage::new("user", "Compare these", 0);
    conversation.push(mine.clone());
    // Sent, then the app quit before its echo was read: no source yet.
    let earlier = ChatMessage::new("user", "sent before the quit", 0);
    conversation.push(earlier.clone());
    let mut pending = VecDeque::from([Pending { id: mine.id.clone(), pasted_at: None }]);
    let transcript = lines(&[
        prompt("u1", None, serde_json::json!(" Compare these\n\nThe member attached these files. Read each one…")),
        assistant("a1", "msg_1", serde_json::json!([{"type":"text","text":"Done."}]), Some("end_turn")),
        turn_end("t1"),
        prompt("u2", None, serde_json::json!(" sent before the quit")),
        prompt("u3", None, serde_json::json!("typed in the terminal")),
    ]);
    let mut fold = ClaudeFold::default();
    fold.push_bytes(transcript.as_bytes());
    let changed = merge_claude(&mut conversation, &fold.take_dirty(), &mut pending);
    assert_eq!(changed.len(), 4);
    assert!(pending.is_empty());
    assert_eq!(conversation.messages[0].id, mine.id, "Plyloft's own message, now matched");
    assert_eq!(conversation.messages[0].text, "Compare these", "without the attachment block");
    assert_eq!(conversation.messages[0].source_id.as_deref(), Some("u1"));
    assert_eq!(conversation.messages[1].source_id.as_deref(), Some("u2"), "matched by its words, not doubled");
    assert_eq!(conversation.messages.iter().filter(|m| m.role == "user").count(), 3);
    // The same transcript read again (a resume reads it from the start).
    let mut again = ClaudeFold::default();
    again.push_bytes(transcript.as_bytes());
    assert!(merge_claude(&mut conversation, &again.take_dirty(), &mut VecDeque::new()).is_empty());
    assert_eq!(conversation.messages.len(), 4);
}

/// `(file, fn)` for each non-test function under `src` that calls a
/// worktree-removing function (`prune_worktree_at`, `remove_card_worktree_at`,
/// `worktrees::prune_merged_card_worktrees`, `worktrees::prune_pr_merged_card`)
/// and not `card_worktree_removed`; fails on a bare `verify_logs::remove_card(`.
fn functions_removing_a_worktree_without_the_hook(src: &Path) -> Vec<(String, String)> {
    const NEEDLES: [&str; 4] = [
        "prune_worktree_at(",
        "remove_card_worktree_at(",
        "worktrees::prune_merged_card_worktrees(",
        "worktrees::prune_pr_merged_card(",
    ];
    fn fn_name(line: &str) -> Option<String> {
        let line = line.trim_start();
        let line = line.strip_prefix("pub(crate) ").or_else(|| line.strip_prefix("pub ")).unwrap_or(line);
        let line = line.strip_prefix("async ").unwrap_or(line);
        let rest = line.strip_prefix("fn ")?;
        let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
        (!name.is_empty()).then_some(name)
    }
    let mut found = Vec::new();
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "tests.rs" {
                continue;
            }
            let mut text = std::fs::read_to_string(&path).unwrap();
            if let Some(cut) = text.find("#[cfg(test)]\nmod tests") {
                text.truncate(cut);
            }
            if name != "verify_logs.rs" {
                assert!(!text.contains("verify_logs::remove_card("), "{name} calls the logs-only remove_card");
            }
            let lines: Vec<&str> = text.lines().collect();
            let starts: Vec<(usize, String)> =
                lines.iter().enumerate().filter_map(|(i, line)| fn_name(line).map(|n| (i, n))).collect();
            for (index, (start, fname)) in starts.iter().enumerate() {
                let end = starts.get(index + 1).map_or(lines.len(), |(next, _)| *next);
                let body = lines[*start + 1..end].join("\n");
                let calls = NEEDLES.iter().any(|needle| body.contains(needle));
                if calls && !body.contains("card_worktree_removed(") {
                    found.push((name.clone(), fname.clone()));
                }
            }
        }
    }
    found
}

/// The paths that end or remove a card, its worktree or its workspace call
/// into the chat (read from the source, as `intake`'s own wiring test does).
#[test]
fn deletes_and_worktree_removals_reach_the_chat() {
    let source = |file: &str| std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file)).unwrap();
    let body = |file: &str, name: &str| {
        let text = source(file);
        let start = text.find(&format!("fn {name}(")).unwrap_or_else(|| panic!("fn {name} in {file}"));
        let rest = &text[start..];
        rest[..rest.find("\n}\n").unwrap_or(rest.len())].to_string()
    };
    assert!(body("commands.rs", "finish_card_delete").contains("ChatRegistry>().forget_card("));
    assert!(body("commands.rs", "workspace_delete").contains("forget_workspace(&id)"));
    assert!(body("verify_logs.rs", "card_worktree_removed").contains("crate::chat::end_card_session("));
    assert!(body("commands.rs", "finish_card_delete_at").contains("card_worktree_removed("));
    assert!(source("lib.rs").contains("install_global()"));
    // Every function that removes a card's worktree reaches the hook (or is
    // one of the few whose caller does, named below), and the logs-only
    // `remove_card` is called nowhere else. Every source file, subfolders
    // included, outside the tests.
    let missing = functions_removing_a_worktree_without_the_hook(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"));
    let allowed = [
        // `finish_card_delete_at` calls the hook first, then this.
        ("commands.rs", "dispose_deleted_card_worktree"),
        // The rollback of a lane worktree created a moment before: no chat
        // ever read it.
        ("commands.rs", "build_both_prepare"),
        // The other build's worktree on delete: `finish_card_delete` calls
        // the hook for both lanes' keys.
        ("build_both.rs", "prune_leftover_variant"),
        // The tests' helper (no product caller).
        ("worktrees.rs", "prune_for_card"),
        // Skills hub H3a: the rollback of a skill card's worktree created a
        // moment before, when the card could not be made — no chat ever read it.
        ("skill_card.rs", "discard_worktree"),
        // Ship's prune that keeps a held copy: its callers (Land, the ship
        // backfill) call the hook, as they did around `prune_worktree_at`.
        ("kept_copy.rs", "prune_or_keep"),
        // 1.173.0 A2/A3: a copy without a card has no card chat to end —
        // `throw_away` refuses a copy a card owns (`IS_A_CARD_REFUSAL`), and a
        // `cardId` is cleared only when that card is not on the board
        // (`release_stranded`), so a card's worktree never goes this way.
        ("copies.rs", "throw_away"),
    ];
    let unexpected: Vec<&(String, String)> =
        missing.iter().filter(|(file, name)| !allowed.iter().any(|(f, n)| file == f && name == n)).collect();
    assert!(unexpected.is_empty(), "these remove a worktree without card_worktree_removed: {unexpected:?}");
    // The scan sees what it is meant to: each named exception is found.
    for (file, name) in allowed {
        assert!(missing.iter().any(|(f, n)| f == file && n == name), "the scan missed {file}::{name}");
    }
    let exit = body("lib.rs", "run_exit_cleanup");
    let chats = exit.find("state::<chat::ChatRegistry>").expect("chats in the exit cleanup");
    let ptys = exit.find("try_state::<pty::PtyRegistry>() {\n        registry.kill_all()").expect("ptys");
    assert!(chats < ptys, "chats end before the PTYs");
    assert!(exit.contains("chat_extract::kill_active()"));
}

// ── The registry, with fake CLIs ─────────────────────────────────────

#[cfg(unix)]
mod live {
    use super::*;
    use crate::chat_extract::test_files;
    use serde_json::Value;
    use std::os::unix::fs::PermissionsExt;

    type Events = Arc<Mutex<Vec<(String, Value)>>>;

    struct Rig {
        root: tempfile::TempDir,
        config: PathBuf,
        claude_config: PathBuf,
        log: PathBuf,
        registry: ChatRegistry,
        events: Events,
        pty: crate::pty::PtyRegistry,
        app: tauri::App<tauri::test::MockRuntime>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.registry.kill_all();
            self.pty.kill_all();
        }
    }

    fn init_env() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(crate::shell_env::init);
    }

    fn write_script(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// A fake `claude`: parses the chat argv, writes its transcript where
    /// Claude would, draws its composer (idle, or working with "esc to
    /// interrupt"), answers a positional prompt and each bracketed paste
    /// (+CR). By the message's words: SLOW opens a turn an Esc interrupts;
    /// WORKING draws Claude's working line over an empty composer whose
    /// footer doesn't say a turn runs, writes nothing for 3 s, then the
    /// idle composer (no end entry); DIE writes a partial answer and exits at once; NOEND answers with no end-of-turn entry; DROP is never written; PERM
    /// waits on a tool with Claude's permission dialog drawn. A `--resume`
    /// of a session with no transcript fails as Claude does; with
    /// `limit-on-resume` beside the projects, a resume draws the usage-limit
    /// menu instead of its composer. Builtins and absolute paths only.
    fn fake_claude(projects: &Path, log: &Path) -> String {
        format!(
            r#"#!/bin/bash
proj='{projects}'
log='{log}'
sid=""; resume=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid="$2"; shift 2;;
    --resume) sid="$2"; resume=1; shift 2;;
    --restricted|--strict-mcp-config) shift;;
    --add-dir) shift; while [ $# -gt 0 ] && [ "${{1#--}}" = "$1" ] && [ -d "$1" ]; do echo "add-dir $1" >> "$log"; shift; done;;
    --*) shift 2;;
    *) prompt="$1"; shift;;
  esac
done
echo "pid $$" >> "$log"
echo "start sid=$sid resume=$resume prompt=[$prompt]" >> "$log"
t="$proj/$sid.jsonl"
if [ -n "$resume" ] && [ ! -f "$t" ]; then echo "No conversation found with session ID: $sid"; exit 1; fi
R='────────────────────────────────────────'
# A full paint from the top, rows placed by cursor moves, the cursor left in
# the composer; done_footer repaints the footer only (the spinner row stays).
paint() {{ printf '\033[2J\033[H\033[1;1H%s\033[3;1H%s\033[4;1H%s\033[5;1H❯ \033[6;1H%s\033[7;1H  %s\033[5;3H' "$1" "$2" "$R" "$R" "$3"; }}
idle() {{ paint "⏺ Answer" "✻ Worked for 1s · done" "? for shortcuts"; }}
busy() {{ paint "❯ working" "✶ Herding… (1s)" "⏵⏵ don't ask on · esc to interrupt"; }}
done_footer() {{ printf '\033[7;1H\033[2K  ⏵⏵ don'"'"'t ask on (shift+tab to cycle)\033[5;3H'; }}
esc() {{ local s="$1"; s="${{s//\\/\\\\}}"; s="${{s//\"/\\\"}}"; s="${{s//$'\n'/\\n}}"; s="${{s//$'\r'/}}"; printf '%s' "$s"; }}
n=0; working=0; cur=""
reply() {{
  n=$((n+1))
  local e
  e=$(esc "$1")
  printf 'msg[%s]\n' "$e" >> "$log"
  case "$1" in *DROP*) idle; return;; esac
  # As `/clear` would: Claude goes on in another transcript.
  case "$1" in *SWITCH*) sid="switched-$$"; t="$proj/$sid.jsonl";; esac
  printf '{{"type":"user","uuid":"u-%s-%s","promptSource":"typed","message":{{"role":"user","content":"%s"}}}}\n' $$ $n "$e" >> "$t"
  case "$1" in
    *SLOW*) cur="m-$$-$n"
      printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"%s","model":"fake","content":[{{"type":"text","text":"Thinking"}}],"stop_reason":null}}}}\n' $$ $n "$cur" >> "$t"
      working=1; busy;;
    *PERM*) cur="m-$$-$n"
      printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"%s","model":"fake","content":[{{"type":"tool_use","id":"toolu-%s","name":"Read","input":{{"file_path":"/etc/hosts"}}}}],"stop_reason":"tool_use"}}}}\n' $$ $n "$cur" $n >> "$t"
      working=1; perm=1
      printf '\033[2J\033[H\033[1;1H Read file\033[2;1H Do you want to proceed?\033[3;1H ❯ 1. Yes\033[4;1H   2. No, and tell Claude what to do differently (esc)';;
    *WORKING*) paint "❯ WORKING" "✢ Quantumizing… (1m 1s · ↓ 4.4k tokens)" "paste again to expand"
      ( /bin/sleep 3; idle ) &;;
    *DIE*) printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"m-%s-%s","model":"fake","content":[{{"type":"text","text":"Half an"}}],"stop_reason":null}}}}\n' $$ $n $$ $n >> "$t"
      exit 3;;
    *PICK*) printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"m-%s-%s","model":"fake","content":[{{"type":"text","text":"Answer %s"}}],"stop_reason":"end_turn"}}}}\n' $$ $n $$ $n $n >> "$t"
      printf '{{"type":"system","subtype":"turn_duration","uuid":"t-%s-%s","durationMs":5}}\n' $$ $n >> "$t"
      printf '\033[2J\033[H\033[1;1H Select model\033[3;1H ❯ 1. Default (recommended)\033[4;1H   2. Opus\033[6;1H Enter to confirm · Esc to exit';;
    *STUCK*) printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"m-%s-%s","model":"fake","content":[{{"type":"text","text":"half"}}],"stop_reason":null}}}}\n' $$ $n $$ $n >> "$t"
      idle;;
    *NOEND*) printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"m-%s-%s","model":"fake","content":[{{"type":"text","text":"Answer %s"}}],"stop_reason":"end_turn"}}}}\n' $$ $n $$ $n $n >> "$t"
      idle;;
    *) printf '{{"type":"assistant","uuid":"a-%s-%s","message":{{"id":"m-%s-%s","model":"fake","content":[{{"type":"text","text":"Answer %s"}}],"stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":4}}}}}}\n' $$ $n $$ $n $n >> "$t"
      printf '{{"type":"system","subtype":"turn_duration","uuid":"t-%s-%s","durationMs":5}}\n' $$ $n >> "$t"
      busy; done_footer;;
  esac
}}
if [ -n "$resume" ] && [ -f "$proj/../limit-on-resume" ]; then
  printf "\033[2J\033[H\033[1;1H  You've hit your limit · resets 3pm\033[3;1H  ❯ 1. Stop and wait for limit to reset\033[4;1H    2. Upgrade your plan"
elif [ -n "$prompt" ]; then
  reply "$prompt"
else
  idle
fi
/bin/stty raw -echo 2>/dev/null
while IFS= read -r -s -n1 -d '' c; do
  if [ "$c" = $'\e' ]; then
    if [ "$working" = 1 ]; then
      printf '{{"type":"user","uuid":"i-%s-%s","interruptedMessageId":"%s","message":{{"role":"user","content":[{{"type":"text","text":"[Request interrupted by user]"}}]}}}}\n' $$ $n "$cur" >> "$t"
      echo "interrupted" >> "$log"
      working=0
      if [ "$perm" = 1 ]; then idle; else done_footer; fi
      perm=0; continue
    fi
    IFS= read -r -s -n5 -d '' rest
    if [ "$rest" = "[200~" ]; then
      buf=""
      while IFS= read -r -s -n1 -d '' p; do
        if [ "$p" = $'\e' ]; then
          IFS= read -r -s -n5 -d '' end
          [ "$end" = "[201~" ] && break
          buf="$buf$p$end"
        else
          buf="$buf$p"
        fi
      done
      IFS= read -r -s -n1 -d '' cr
      reply "$buf"
    fi
  fi
done
"#,
            projects = projects.display(),
            log = log.display(),
        )
    }

    /// A fake `codex app-server` speaking the requests Plyloft sends. A
    /// turn whose text says SLOW waits for `turn/interrupt`; ASKME first
    /// sends a server request (an approval) and logs the reply.
    fn fake_codex(log: &Path) -> String {
        format!(
            r#"#!/bin/bash
log='{log}'
[ "$1" = "app-server" ] || exit 9
echo "pid $$" >> "$log"
k=0; working=""
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
  id=$(printf '%s' "$line" | /usr/bin/sed -n 's/^.*"id":\([0-9][0-9]*\).*$/\1/p')
  client=$(printf '%s' "$line" | /usr/bin/sed -n 's/^.*"clientUserMessageId":"\([^"]*\)".*$/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{"userAgent":"fake"}}}}\n' "$id";;
    *'"method":"thread/start"'*) printf '{{"id":%s,"result":{{"thread":{{"id":"thr-1"}}}}}}\n' "$id";;
    *'"method":"thread/resume"'*)
      case "$line" in
        *thr-1*) printf '{{"id":%s,"result":{{"thread":{{"id":"thr-1"}}}}}}\n' "$id";;
        *) printf '{{"id":%s,"error":{{"code":-1,"message":"no such thread"}}}}\n' "$id";;
      esac;;
    *'"method":"turn/start"'*)
      k=$((k+1)); t="$$-$k"
      printf '{{"id":%s,"result":{{"turn":{{"id":"turn-%s","status":"inProgress","items":[]}}}}}}\n' "$id" "$t"
      printf '{{"method":"turn/started","params":{{"threadId":"thr-1","turn":{{"id":"turn-%s"}}}}}}\n' "$t"
      printf '{{"method":"item/completed","params":{{"item":{{"id":"user-%s","type":"userMessage","clientId":"%s","content":[]}}}}}}\n' "$t" "$client"
      case "$line" in
        *ASKME*) printf '{{"id":"req-%s","method":"item/commandExecution/requestApproval","params":{{"itemId":"cmd-%s"}}}}\n' "$t" "$t";;
      esac
      case "$line" in
        *SLOW*) printf '{{"method":"item/agentMessage/delta","params":{{"itemId":"agent-%s","delta":"Ans"}}}}\n' "$t"
          working="turn-$t";;
        *) printf '{{"method":"item/started","params":{{"item":{{"id":"cmd-%s","type":"commandExecution","command":"rg TODO"}}}}}}\n' "$t"
          printf '{{"method":"item/completed","params":{{"item":{{"id":"cmd-%s","type":"commandExecution","command":"rg TODO","status":"completed","exitCode":0}}}}}}\n' "$t"
          printf '{{"method":"item/agentMessage/delta","params":{{"itemId":"agent-%s","delta":"Ans"}}}}\n' "$t"
          printf '{{"method":"item/agentMessage/delta","params":{{"itemId":"agent-%s","delta":"wer"}}}}\n' "$t"
          printf '{{"method":"item/completed","params":{{"item":{{"id":"agent-%s","type":"agentMessage","text":"Answer %s"}}}}}}\n' "$t" "$k"
          printf '{{"method":"thread/tokenUsage/updated","params":{{"threadId":"thr-1","turnId":"turn-%s","tokenUsage":{{"total":{{"inputTokens":%s0,"cachedInputTokens":5,"outputTokens":%s,"reasoningOutputTokens":1,"totalTokens":99,"cacheWriteInputTokens":7}},"last":{{"inputTokens":1,"cachedInputTokens":0,"outputTokens":1,"reasoningOutputTokens":0,"totalTokens":2}}}}}}}}\n' "$t" "$k" "$k"
          printf '{{"method":"turn/completed","params":{{"threadId":"thr-1","turn":{{"id":"turn-%s","status":"completed"}}}}}}\n' "$t";;
      esac;;
    *'"method":"turn/interrupt"'*)
      printf '{{"id":%s,"result":{{}}}}\n' "$id"
      printf '{{"method":"turn/completed","params":{{"threadId":"thr-1","turn":{{"id":"%s","status":"interrupted"}}}}}}\n' "$working"
      working="";;
  esac
done
"#,
            log = log.display(),
        )
    }

    fn test_limits() -> ChatLimits {
        ChatLimits {
            echo_timeout: Duration::from_secs(1),
            turn_settle: Duration::from_millis(400),
            screen_settle: Duration::from_millis(600),
            // Shorter than `screen_settle`, as in production (1.5 s, 20 s).
            menu_settle: Duration::from_millis(200),
            stuck_turn: Duration::from_secs(1),
            ..ChatLimits::default()
        }
    }

    fn rig_with(limits: ChatLimits, claude_body: Option<&str>) -> Rig {
        init_env();
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("Application Support").join("com.test");
        let claude_config = root.path().join("claude-config");
        let projects = claude_config.join("projects").join("-fake");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let codex_home = root.path().join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(codex_home.join("config.toml"), "[mcp_servers.github]\ncommand = \"gh-mcp\"\n").unwrap();
        let log = root.path().join("cli.log");
        let claude = root.path().join("fake-claude");
        let body = claude_body.map(str::to_string).unwrap_or_else(|| fake_claude(&projects, &log));
        write_script(&claude, &body);
        let codex = root.path().join("fake-codex");
        write_script(&codex, &fake_codex(&log));
        let registry = ChatRegistry::with(
            config.clone(),
            limits,
            ChatOverrides {
                claude: Some(claude.to_string_lossy().into_owned()),
                codex: Some(codex.to_string_lossy().into_owned()),
                claude_config: Some(claude_config.clone()),
                codex_home: Some(codex_home),
                ..ChatOverrides::default()
            },
        );
        let events: Events = Arc::default();
        let sink = events.clone();
        registry.set_emitter(Arc::new(move |event: &str, payload: Value| sink.lock().push((event.to_string(), payload))));
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        Rig { root, config, claude_config, log, registry, events, pty: crate::pty::PtyRegistry::default(), app }
    }

    fn rig() -> Rig {
        rig_with(test_limits(), None)
    }

    fn context(rig: &Rig) -> ChatContext {
        let project = rig.config.parent().unwrap().join("project");
        std::fs::create_dir_all(&project).unwrap();
        ChatContext { title: "Plan the import".into(), notes: "Keep it small.".into(), project_dir: Some(project), plan: None, pull_request: None }
    }

    fn send(rig: &Rig, card: &str, text: &str, attachments: &[String]) -> Result<ChatMessage, String> {
        rig.registry.send(rig.app.handle(), &rig.pty, "ws", card, context(rig), text, attachments)
    }

    fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(20);
        while !ready() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_status(rig: &Rig, card: &str, status: ChatStatus) {
        wait_for(&format!("{status:?}"), || rig.registry.status_of("ws", card).0 == status);
    }

    /// Ready, and the composer drawn (a paste is accepted).
    fn wait_ready(rig: &Rig, card: &str) {
        wait_status(rig, card, ChatStatus::Ready);
        std::thread::sleep(Duration::from_millis(100));
    }

    fn snapshot(rig: &Rig, card: &str) -> ChatSnapshot {
        rig.registry.messages("ws", card, None, None).unwrap()
    }

    fn roles(snapshot: &ChatSnapshot) -> Vec<String> {
        snapshot.messages.iter().map(|m| m.role.clone()).collect()
    }

    fn log(rig: &Rig) -> String {
        std::fs::read_to_string(&rig.log).unwrap_or_default()
    }

    fn pids(rig: &Rig) -> Vec<i32> {
        log(rig)
            .lines()
            .filter_map(|line| line.strip_prefix("pid "))
            .filter_map(|pid| pid.trim().parse().ok())
            .collect()
    }

    fn gone(pid: i32) -> bool {
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            // SAFETY: signal 0 only asks whether the process exists.
            if unsafe { libc::kill(pid, 0) } == -1 {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_claude_chat_sends_answers_interrupts_suspends_resumes_and_dies_with_the_app() {
        let rig = rig();
        let opened = rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        assert_eq!(opened.status, ChatStatus::Idle);
        assert!(pids(&rig).is_empty(), "opening starts nothing");

        // First message: the session starts with it as its prompt.
        let first = send(&rig, "card-1", "hello there", &[]).unwrap();
        wait_ready(&rig, "card-1");
        assert!(log(&rig).contains("prompt=[ hello there]"), "{}", log(&rig));
        let chat = snapshot(&rig, "card-1");
        assert_eq!(roles(&chat), vec!["user", "assistant"]);
        assert_eq!(chat.messages[0].id, first.id);
        assert_eq!(chat.messages[0].text, "hello there");
        assert!(chat.messages[0].source_id.is_some(), "matched to the transcript's prompt");
        assert_eq!(chat.messages[1].text, "Answer 1");
        assert_eq!((chat.usage.input_tokens, chat.usage.output_tokens), (3, 4));
        let pty_id = chat.pty_id.clone().unwrap();
        // "Show terminal" is interactive: the member's keystrokes go through.
        assert!(rig.pty.write(&pty_id, b"").is_ok());
        // A resize reaches the chat's screen grid.
        rig.pty.resize(&pty_id, 100, 30).unwrap();
        assert_eq!(rig.registry.screen_size_of("ws", "card-1"), Some((30, 100)));
        let first_paint = rig.registry.screen_snapshot("ws", "card-1").unwrap().unwrap();
        assert_eq!(first_paint.pty_id, pty_id);
        assert!(first_paint.formatted.contains("❯"), "the first paint carries the composer");

        // Next ones are pasted at the idle composer, always after a space.
        send(&rig, "card-1", "/cost please", &[]).unwrap();
        wait_for("the second answer", || snapshot(&rig, "card-1").messages.len() == 4);
        wait_ready(&rig, "card-1");
        assert!(log(&rig).contains("msg[ /cost please]"), "{}", log(&rig));
        send(&rig, "card-1", "x\x1b[201~\r!pwd\r", &[]).unwrap();
        wait_for("the third answer", || snapshot(&rig, "card-1").messages.len() == 6);
        assert!(log(&rig).contains("msg[ x[201~!pwd]"), "no control reached Claude: {}", log(&rig));
        wait_ready(&rig, "card-1");

        // A slow turn: no send while it works; Stop is Esc, once.
        send(&rig, "card-1", "SLOW essay", &[]).unwrap();
        wait_for("the partial answer", || snapshot(&rig, "card-1").messages.len() == 8);
        wait_for("the open turn", || rig.registry.slot("ws", "card-1").unwrap().lock().turn_open);
        assert!(send(&rig, "card-1", "too soon", &[]).unwrap_err().contains("still answering"));
        rig.registry.interrupt("ws", "card-1").unwrap();
        rig.registry.interrupt("ws", "card-1").unwrap();
        wait_ready(&rig, "card-1");
        assert_eq!(snapshot(&rig, "card-1").messages.last().unwrap().role, "interrupted");
        assert_eq!(log(&rig).matches("interrupted").count(), 1, "two Stops, one Esc");
        // The stopped answer is saved finished (Windows walk of 567616d4: a
        // vendor switch read it back as still streaming).
        let partial = snapshot(&rig, "card-1").messages.iter().rev().find(|m| m.role == "assistant").unwrap().clone();
        assert!(partial.done, "the stopped answer is finished");
        let disk: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(rig.config.join("projects/ws/cards/card-1/chat.json")).unwrap(),
        )
        .unwrap();
        let saved = disk["conversations"][0]["messages"].as_array().unwrap().iter().find(|m| m["id"] == partial.id.as_str()).unwrap();
        assert_eq!(saved["done"], true, "saved done in chat.json: {saved}");
        rig.registry.interrupt("ws", "card-1").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(log(&rig).matches("interrupted").count(), 1, "no Esc on an idle composer");

        // Close suspends: the process goes, the history stays.
        let first_pid = pids(&rig)[0];
        rig.registry.close("ws", "card-1").unwrap();
        assert!(gone(first_pid), "the CLI is gone after close");

        // The next send resumes the same session, with no prompt, and the
        // message is pasted at the composer.
        send(&rig, "card-1", "after the pause", &[]).unwrap();
        wait_for("the resumed answer", || {
            snapshot(&rig, "card-1").messages.last().is_some_and(|m| m.role == "assistant" && m.done && m.text.starts_with("Answer"))
                && rig.registry.status_of("ws", "card-1").0 == ChatStatus::Ready
        });
        assert!(log(&rig).contains("resume=1 prompt=[]"), "{}", log(&rig));
        assert!(log(&rig).contains("msg[ after the pause]"));
        let chat = snapshot(&rig, "card-1");
        assert_eq!(chat.messages.iter().filter(|m| m.role == "user").count(), 5, "{:?}", roles(&chat));
        assert_eq!(chat.messages.iter().filter(|m| m.role == "user" && m.source_id.is_none()).count(), 0);

        let on_disk = std::fs::read_to_string(rig.config.join("projects/ws/cards/card-1/chat.json")).unwrap();
        let on_disk: Value = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(on_disk["version"], 1);
        assert_eq!(on_disk["activeVendor"], "claude");

        // Quit: every chat process ends, none starts after.
        let second_pid = *pids(&rig).last().unwrap();
        rig.registry.kill_all();
        assert!(gone(second_pid), "no orphan after quit");
        assert!(send(&rig, "card-1", "after quit", &[]).is_err());
        let events = rig.events.lock();
        assert!(events.iter().any(|(event, payload)| event == STATE_EVENT && payload["status"] == "working"));
        assert!(events.iter().any(|(event, payload)| event == MESSAGES_EVENT && payload["cardId"] == "card-1"));
    }

    #[test]
    fn a_resumed_session_that_meets_a_limit_menu_stops_and_never_gets_the_message() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "one", &[]).unwrap();
        wait_ready(&rig, "card-1");
        rig.registry.close("ws", "card-1").unwrap();
        std::fs::write(rig.claude_config.join("projects/limit-on-resume"), "").unwrap();
        let lost = send(&rig, "card-1", "two", &[]).unwrap();
        wait_status(&rig, "card-1", ChatStatus::Stopped);
        let (_, reason) = rig.registry.status_of("ws", "card-1");
        assert_eq!(reason.as_deref(), Some(crate::claude_session::USAGE_LIMIT));
        assert!(!log(&rig).contains("msg[ two]"), "the menu never got a paste: {}", log(&rig));
        let chat = snapshot(&rig, "card-1");
        assert!(chat.messages.iter().any(|m| m.id == lost.id && m.is_error), "marked not sent");
        assert!(gone(*pids(&rig).last().unwrap()));
    }

    #[test]
    fn a_turn_with_no_end_entry_settles_and_a_paste_never_echoed_is_reported() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "NOEND hi", &[]).unwrap();
        wait_ready(&rig, "card-1");
        assert!(snapshot(&rig, "card-1").messages.last().unwrap().done);
        let dropped = send(&rig, "card-1", "DROP this", &[]).unwrap();
        wait_for("the echo timeout", || {
            snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "notice" && m.text.contains("didn't take"))
        });
        wait_ready(&rig, "card-1");
        assert!(snapshot(&rig, "card-1").messages.iter().any(|m| m.id == dropped.id && m.is_error));
    }

    #[test]
    fn a_permission_dialog_on_a_waiting_tool_asks_for_the_terminal() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "PERM read it", &[]).unwrap();
        // The first notice is the permission one: the dialog's `❯ 1. Yes`
        // is no generic menu, though the menu settle is the shorter.
        wait_for("the attention", || rig.registry.attention_of("ws", "card-1").is_some());
        let attention = rig.registry.attention_of("ws", "card-1").unwrap();
        assert!(attention.contains("asks for permission to use Read"), "{attention}");
        assert_eq!(rig.registry.status_of("ws", "card-1").0, ChatStatus::Working);
        rig.registry.interrupt("ws", "card-1").unwrap();
        wait_ready(&rig, "card-1");
        assert_eq!(rig.registry.attention_of("ws", "card-1"), None);
    }

    /// `/clear` (or `/resume`) typed in Claude's terminal moves it to
    /// another transcript: the chat follows it; and a turn the transcript
    /// leaves open while Claude sits at its idle composer is closed.
    #[test]
    fn the_chat_follows_a_switched_transcript_and_closes_a_stuck_turn() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "one", &[]).unwrap();
        wait_ready(&rig, "card-1");
        let first = rig.registry.session_id_of("ws", "card-1").unwrap();
        let switched = send(&rig, "card-1", "SWITCH now", &[]).unwrap();
        wait_for("the switch", || {
            rig.registry.session_id_of("ws", "card-1").is_some_and(|id| id.starts_with("switched-"))
        });
        assert_ne!(rig.registry.session_id_of("ws", "card-1").unwrap(), first);
        wait_ready(&rig, "card-1");
        let chat = snapshot(&rig, "card-1");
        assert!(chat.messages.iter().any(|m| m.role == "notice" && m.text.contains("moved to another conversation")));
        assert!(chat.messages.iter().any(|m| m.id == switched.id && m.source_id.is_some()), "its echo found in the new transcript");
        let at = chat.messages.iter().position(|m| m.id == switched.id).unwrap();
        assert!(chat.messages[at..].iter().any(|m| m.role == "assistant" && m.done));

        send(&rig, "card-1", "STUCK please", &[]).unwrap();
        wait_for("the stuck turn closed", || {
            snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "notice" && m.text.contains("without saying it had finished"))
        });
        wait_ready(&rig, "card-1");
    }

    /// Ready is the transcript's to say; a menu on the screen (a model
    /// picker the member opened) still keeps Plyloft's paste out, and asks
    /// for the terminal.
    #[test]
    fn a_menu_on_screen_after_a_finished_turn_refuses_the_paste_and_asks_for_the_terminal() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "PICK a model", &[]).unwrap();
        wait_ready(&rig, "card-1");
        wait_for("the menu's attention", || {
            rig.registry.attention_of("ws", "card-1").is_some_and(|a| a.contains("menu"))
        });
        let refused = send(&rig, "card-1", "next", &[]).unwrap_err();
        assert!(refused.contains("isn't at its prompt"), "{refused}");
        assert!(!log(&rig).contains("msg[ next]"), "the menu never got a paste");
        assert!(snapshot(&rig, "card-1").messages.iter().all(|m| m.text != "next"), "nothing recorded");
    }

    /// A session ended mid-answer (a switch to the other vendor) saves the
    /// answer finished: no "Writing…" for it during a later turn.
    #[test]
    fn a_switch_mid_answer_saves_the_answer_finished() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "SLOW essay", &[]).unwrap();
        wait_for("the open turn", || rig.registry.slot("ws", "card-1").unwrap().lock().turn_open);
        wait_for("the partial answer", || snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "assistant"));
        let partial = snapshot(&rig, "card-1").messages.iter().find(|m| m.role == "assistant").unwrap().id.clone();
        rig.registry.open("ws", "card-1", ChatVendor::Codex).unwrap();
        let disk: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(rig.config.join("projects/ws/cards/card-1/chat.json")).unwrap(),
        )
        .unwrap();
        let claude = disk["conversations"].as_array().unwrap().iter().find(|c| c["vendor"] == "claude").unwrap();
        let saved = claude["messages"].as_array().unwrap().iter().find(|m| m["id"] == partial.as_str()).unwrap();
        assert_eq!(saved["done"], true, "saved finished by the switch: {saved}");
        let events = rig.events.lock();
        assert!(
            events.iter().any(|(event, payload)| event == MESSAGES_EVENT
                && payload["vendor"] == "claude"
                && payload["messages"].as_array().unwrap().iter().any(|m| m["id"] == partial.as_str() && m["done"] == true)),
            "the finished answer is emitted"
        );
    }

    /// Claude's working line above an empty composer, the grid still and
    /// the transcript quiet past `stuck_turn` (2.1.300 writes a long answer
    /// only at its end): the turn is not closed, and no send is pasted into
    /// it; once the line goes and the composer is idle, it is.
    #[test]
    fn a_still_working_line_keeps_the_turn_open_until_it_goes() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "WORKING on rivers", &[]).unwrap();
        wait_for("the open turn", || rig.registry.slot("ws", "card-1").unwrap().lock().turn_open);
        // Past `stuck_turn` (1 s) with the line drawn and nothing written.
        std::thread::sleep(Duration::from_millis(2000));
        assert_eq!(rig.registry.status_of("ws", "card-1").0, ChatStatus::Working, "the turn still runs");
        assert!(
            !snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "notice"),
            "no stuck-turn notice while Claude works"
        );
        let refused = send(&rig, "card-1", "meanwhile", &[]).unwrap_err();
        assert!(refused.contains("still answering"), "{refused}");
        // The line goes, the idle composer stays: the turn is closed.
        wait_for("the stuck turn closed", || {
            snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "notice" && m.text.contains("without saying it had finished"))
        });
        wait_ready(&rig, "card-1");
        assert!(!log(&rig).contains("msg[ meanwhile]"), "nothing was pasted mid-turn: {}", log(&rig));
    }

    /// A session that ended mid-turn left its transcript with a message
    /// never answered. The resume's catch-up closes that turn silently:
    /// the resumed message is pasted at once, and no stuck-turn notice
    /// lands in the new turn (Windows walk of 3f159198).
    #[test]
    fn a_turn_an_earlier_session_left_open_is_closed_silently_on_resume() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "hello there", &[]).unwrap();
        wait_ready(&rig, "card-1");
        let sid = rig.registry.session_id_of("ws", "card-1").unwrap();
        rig.registry.close("ws", "card-1").unwrap();
        // The earlier session's last record: a prompt with no answer.
        let transcript = rig.claude_config.join("projects/-fake").join(format!("{sid}.jsonl"));
        let mut record = std::fs::read_to_string(&transcript).unwrap();
        record.push_str("{\"type\":\"user\",\"uuid\":\"u-old-forests\",\"promptSource\":\"typed\",\"message\":{\"role\":\"user\",\"content\":\" Write a 2000-word essay about forests.\"}}\n");
        std::fs::write(&transcript, record).unwrap();

        let resumed = send(&rig, "card-1", "rivers please", &[]).unwrap();
        wait_for("the resumed answer", || {
            let chat = snapshot(&rig, "card-1");
            chat.messages.last().is_some_and(|m| m.role == "assistant" && m.done)
                && chat.messages.iter().any(|m| m.id == resumed.id && m.source_id.is_some())
        });
        wait_ready(&rig, "card-1");
        let chat = snapshot(&rig, "card-1");
        assert!(
            !chat.messages.iter().any(|m| m.role == "notice" && m.text.contains("without saying it had finished")),
            "no stuck-turn notice: {:?}",
            roles(&chat)
        );
        assert_eq!(chat.messages.last().unwrap().role, "assistant", "{:?}", roles(&chat));
        assert!(log(&rig).contains("msg[ rivers please]"));
    }

    /// Claude exiting mid-answer: the stop finishes the answer, and the
    /// last `chat://messages` carrying it says so (the poll's merge copy,
    /// still streaming, is never sent after the finished one).
    #[test]
    fn an_answer_cut_by_claude_s_exit_is_last_emitted_finished() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "DIE now", &[]).unwrap();
        wait_status(&rig, "card-1", ChatStatus::Stopped);
        wait_for("the partial answer", || snapshot(&rig, "card-1").messages.iter().any(|m| m.role == "assistant"));
        let answer = snapshot(&rig, "card-1").messages.iter().find(|m| m.role == "assistant").unwrap().id.clone();
        let events = rig.events.lock();
        let last = events
            .iter()
            .filter(|(event, _)| event == MESSAGES_EVENT)
            .flat_map(|(_, payload)| payload["messages"].as_array().cloned().unwrap_or_default())
            .filter(|m| m["id"] == answer.as_str())
            .last()
            .expect("the answer was emitted");
        assert_eq!(last["done"], true, "the last copy sent is finished: {last}");
    }

    /// A split repaint (ConPTY) erasing the menu's chevron row for a poll
    /// doesn't take the notice away.
    #[test]
    fn a_menu_notice_survives_a_poll_with_the_chevron_row_erased() {
        let body = "#!/bin/bash\n\
printf '\\033[2J\\033[H\\033[1;1H Select model\\033[3;1H ❯ 1. Default\\033[4;1H   2. Opus'\n\
/bin/sleep 1\n\
i=0\n\
while [ $i -lt 4 ]; do\n\
  printf '\\033[3;1H\\033[2K'; /bin/sleep 0.3\n\
  printf '\\033[3;1H ❯ 1. Default'; /bin/sleep 0.5; i=$((i + 1))\n\
done\n\
while IFS= read -r line; do :; done\n";
        let limits = ChatLimits { menu_settle: Duration::from_millis(400), ..test_limits() };
        let rig = rig_with(limits, Some(body));
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        let _ = send(&rig, "card-1", "hello", &[]);
        wait_for("the menu's notice", || rig.registry.attention_of("ws", "card-1").is_some_and(|a| a.contains("menu")));
        let until = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < until {
            let attention = rig.registry.attention_of("ws", "card-1");
            assert!(attention.as_deref().is_some_and(|a| a.contains("menu")), "the notice went away on a split repaint: {attention:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A resume reads the transcript again, where the stopped answer is
    /// still partial: during the resumed turn it stays finished.
    #[test]
    fn a_resume_rereading_a_stopped_answer_keeps_it_finished() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "SLOW essay", &[]).unwrap();
        wait_for("the open turn", || rig.registry.slot("ws", "card-1").unwrap().lock().turn_open);
        rig.registry.interrupt("ws", "card-1").unwrap();
        wait_ready(&rig, "card-1");
        let stopped = snapshot(&rig, "card-1").messages.iter().find(|m| m.role == "assistant").unwrap().id.clone();
        rig.registry.close("ws", "card-1").unwrap();
        send(&rig, "card-1", "SLOW again", &[]).unwrap();
        wait_for("the resumed turn's partial answer", || {
            snapshot(&rig, "card-1").messages.iter().filter(|m| m.role == "assistant").count() == 2
        });
        assert_eq!(rig.registry.status_of("ws", "card-1").0, ChatStatus::Working, "read while the turn runs");
        let chat = snapshot(&rig, "card-1");
        assert!(chat.messages.iter().find(|m| m.id == stopped).unwrap().done, "the stopped answer stays finished");
        assert!(!chat.messages.iter().rev().find(|m| m.role == "assistant").unwrap().done, "the new one streams");
        rig.registry.interrupt("ws", "card-1").unwrap();
        wait_ready(&rig, "card-1");
    }

    /// Once said, a menu's notice stays while the menu is drawn: the
    /// member's arrow keys redraw it, and the notice must not come and go.
    #[test]
    fn a_menu_notice_stays_while_the_member_moves_through_the_menu() {
        let body = "#!/bin/bash\n\
printf '\\033[2J\\033[H\\033[1;1H Select model\\033[3;1H ❯ 1. Default\\033[4;1H   2. Opus'\n\
/bin/sleep 1\n\
i=0\n\
while [ $i -lt 30 ]; do\n\
  if [ $((i % 2)) = 0 ]; then printf '\\033[3;1H\\033[2K   1. Default\\033[4;1H\\033[2K ❯ 2. Opus'; else printf '\\033[3;1H\\033[2K ❯ 1. Default\\033[4;1H\\033[2K   2. Opus'; fi\n\
  /bin/sleep 0.1; i=$((i + 1))\n\
done\n\
while IFS= read -r line; do :; done\n";
        let limits = ChatLimits { menu_settle: Duration::from_millis(400), ..test_limits() };
        let rig = rig_with(limits, Some(body));
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        let _ = send(&rig, "card-1", "hello", &[]);
        wait_for("the menu's notice", || rig.registry.attention_of("ws", "card-1").is_some_and(|a| a.contains("menu")));
        // The flips run for 3 s after the first second; sample 2 s of them.
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            let attention = rig.registry.attention_of("ws", "card-1");
            assert!(attention.as_deref().is_some_and(|a| a.contains("menu")), "the notice went away on a redraw: {attention:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A menu opened in Claude's terminal is said at once, not after the
    /// startup net's settle (Windows walk of 567616d4: "Claude is ready."
    /// for 15 s with `/model` open, `screen_settle` being 20 s).
    #[test]
    fn a_menu_is_said_after_its_own_short_settle_not_the_screen_settle() {
        let limits = ChatLimits {
            screen_settle: Duration::from_secs(120),
            menu_settle: Duration::from_millis(300),
            ..test_limits()
        };
        let rig = rig_with(limits, None);
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "PICK a model", &[]).unwrap();
        wait_ready(&rig, "card-1");
        let until = Instant::now() + Duration::from_secs(5);
        while !rig.registry.attention_of("ws", "card-1").is_some_and(|a| a.contains("menu")) {
            assert!(Instant::now() < until, "the menu was never said within 5 s");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(rig.registry.status_of("ws", "card-1").0, ChatStatus::Ready);
    }

    /// A `chat.json` written before stopped answers were saved finished
    /// (an answer left `"done": false`, no turn running) reads as finished,
    /// from `chat_messages` and from `chat_open`.
    #[test]
    fn an_answer_left_streaming_in_an_older_chat_json_reads_finished() {
        let rig = rig();
        let dir = rig.config.join("projects/ws/cards/card-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("chat.json"),
            r##"{"version":1,"activeVendor":"claude","conversations":[{"vendor":"claude","messages":[
                {"id":"u1","role":"user","text":"essay","done":true},
                {"id":"a1","role":"assistant","text":"# From SCCS to Git","done":false},
                {"id":"i1","role":"interrupted","text":"","done":true}]}]}"##,
        )
        .unwrap();
        let read = snapshot(&rig, "card-1");
        assert!(read.messages.iter().find(|m| m.id == "a1").unwrap().done, "chat_messages: finished");
        let opened = rig.registry.open("ws", "card-1", ChatVendor::Codex).unwrap();
        assert!(opened.messages.is_empty());
        let back = rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        let answer = back.messages.iter().find(|m| m.id == "a1").unwrap();
        assert!(answer.done, "chat_open after a vendor switch: finished");
        assert_eq!(answer.text, "# From SCCS to Git");
    }

    #[test]
    fn a_chat_whose_transcript_is_gone_goes_on_in_a_new_session_and_says_so() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        send(&rig, "card-1", "remember banana", &[]).unwrap();
        wait_ready(&rig, "card-1");
        rig.registry.close("ws", "card-1").unwrap();
        for entry in std::fs::read_dir(rig.claude_config.join("projects/-fake")).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        send(&rig, "card-1", "what fruit?", &[]).unwrap();
        wait_for("the new session's answer", || {
            snapshot(&rig, "card-1").messages.iter().filter(|m| m.role == "assistant").count() == 2
        });
        assert!(!log(&rig).contains("resume=1"), "no --resume of a session with no transcript");
        let chat = snapshot(&rig, "card-1");
        assert!(chat.messages.iter().any(|m| m.role == "notice" && m.text.contains("starts afresh")));
        assert_eq!(chat.messages.iter().filter(|m| m.role == "user").count(), 2, "the history is kept");
    }

    #[test]
    fn claude_s_trust_question_stops_the_chat_and_is_never_answered() {
        // Drawn as Claude Code does, the chevron on the first choice: the
        // trust path's, never the generic menu notice (its settle is shorter).
        let trust = "#!/bin/bash\nprintf 'Quick safety check: Is this a project you created or one you trust?\\n ❯ 1. Yes, I trust this folder\\n   2. No, exit\\n\\n Enter to confirm · Esc to cancel\\n'\nwhile IFS= read -r line; do echo \"$line\" >> /dev/null; done\n";
        let limits = ChatLimits { trust_confirm: Duration::from_millis(1500), ..test_limits() };
        let rig = rig_with(limits, Some(trust));
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        let first = send(&rig, "card-1", "hello", &[]).unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        while rig.registry.status_of("ws", "card-1").0 != ChatStatus::Stopped {
            assert!(Instant::now() < until, "timed out waiting for Stopped");
            let attention = rig.registry.attention_of("ws", "card-1");
            assert!(!attention.as_deref().is_some_and(|a| a.contains("menu")), "no menu notice for the trust question: {attention:?}");
            std::thread::sleep(Duration::from_millis(20));
        }
        let (_, reason) = rig.registry.status_of("ws", "card-1");
        assert_eq!(reason.as_deref(), Some(crate::claude_session::FOLDER_TRUST_REFUSAL));
        assert_eq!(rig.registry.live_count(), 0, "the session was ended, not answered");
        let chat = snapshot(&rig, "card-1");
        assert!(chat.messages.iter().any(|m| m.id == first.id && m.is_error), "the first prompt is marked not sent");
    }

    #[test]
    fn a_codex_chat_gets_local_image_only_for_images_and_resumes_its_thread() {
        let rig = rig();
        rig.registry.open("ws", "card-2", ChatVendor::Codex).unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        let image = rig.registry.attachment_add("ws", "card-2", "shot one.png", &png).unwrap();
        let pdf = rig.registry.attachment_add("ws", "card-2", "spec.pdf", &test_files::pdf(&["Spec words"])).unwrap();
        let sent = send(&rig, "card-2", "compare", &[image.id.clone(), pdf.id.clone()]).unwrap();
        wait_status(&rig, "card-2", ChatStatus::Ready);
        let chat = snapshot(&rig, "card-2");
        assert_eq!(roles(&chat), vec!["user", "tool", "assistant"], "{:?}", chat.messages);
        assert_eq!(chat.messages[0].id, sent.id);
        assert!(chat.messages[0].source_id.as_deref().is_some_and(|id| id.starts_with("user-")), "matched by clientId");
        assert_eq!(chat.messages[1].tool.as_ref().unwrap().outcome, "done");
        assert_eq!(chat.messages[2].text, "Answer 1");
        // Uncached input (10 - 5), cache reads 5, cache writes not Codex's.
        assert_eq!(
            (chat.usage.input_tokens, chat.usage.cache_read_tokens, chat.usage.output_tokens, chat.usage.cache_creation_tokens),
            (5, 5, 1, 0)
        );

        let sent_log = log(&rig);
        let thread_start: Value =
            serde_json::from_str(sent_log.lines().find(|l| l.contains("\"thread/start\"")).unwrap()).unwrap();
        assert_eq!(thread_start["params"]["sandbox"], "read-only");
        assert_eq!(thread_start["params"]["approvalPolicy"], "never");
        assert_eq!(thread_start["params"]["config"]["mcp_servers.github.enabled"], false);
        let cwd = thread_start["params"]["cwd"].as_str().unwrap();
        assert!(cwd.ends_with("claude-sessions/chats/ws/card-2"), "the card's plain chat folder: {cwd}");
        let instructions = thread_start["params"]["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains("Plan the import") && instructions.contains("project"));
        let turn: Value = serde_json::from_str(sent_log.lines().find(|l| l.contains("\"turn/start\"")).unwrap()).unwrap();
        assert_eq!(turn["params"]["approvalPolicy"], "never");
        assert_eq!(turn["params"]["sandboxPolicy"], serde_json::json!({"type":"readOnly","networkAccess":false}));
        assert_eq!(turn["params"]["clientUserMessageId"], sent.id);
        let input = turn["params"]["input"].as_array().unwrap();
        assert_eq!(input.len(), 2);
        assert_eq!(input[1]["type"], "localImage");
        assert!(input[1]["path"].as_str().unwrap().ends_with("shot-one.png"));
        assert!(input[0]["text"].as_str().unwrap().contains("Spec words"), "the PDF goes as its text");

        // A server request is refused, and said.
        send(&rig, "card-2", "ASKME please", &[]).unwrap();
        wait_status(&rig, "card-2", ChatStatus::Ready);
        wait_for("the refusal", || log(&rig).lines().any(|l| l.contains("\"req-") && l.contains("\"error\"")));
        assert!(snapshot(&rig, "card-2").messages.iter().any(|m| m.role == "notice" && m.text.contains("refused")));

        // Stop before the turn's id arrives is sent with it.
        send(&rig, "card-2", "SLOW one", &[]).unwrap();
        rig.registry.interrupt("ws", "card-2").unwrap();
        wait_status(&rig, "card-2", ChatStatus::Ready);
        assert_eq!(snapshot(&rig, "card-2").messages.last().unwrap().role, "interrupted");

        // Close, then the next send resumes thr-1.
        let pid = pids(&rig)[0];
        rig.registry.close("ws", "card-2").unwrap();
        assert!(gone(pid));
        send(&rig, "card-2", "again", &[]).unwrap();
        wait_for("the resumed answer", || {
            rig.registry.status_of("ws", "card-2").0 == ChatStatus::Ready
                && snapshot(&rig, "card-2").messages.last().is_some_and(|m| m.role == "assistant" && m.done)
        });
        assert!(log(&rig).contains("\"thread/resume\""));
        let last = *pids(&rig).last().unwrap();
        rig.registry.kill_all();
        assert!(gone(last), "no Codex left after quit");
        assert!(rig.registry.inner.codex.start_with("x", rig.root.path(), "/bin/sh", Arc::new(|_, _, _| {})).is_err(),
            "no App Server after quit");
    }

    #[test]
    fn a_full_house_suspends_the_least_recently_used_ready_chat_and_idle_ones_sleep() {
        let rig = rig_with(ChatLimits { max_live: 1, idle_after: Duration::ZERO, ..test_limits() }, None);
        for card in ["card-a", "card-b"] {
            rig.registry.open("ws", card, ChatVendor::Claude).unwrap();
        }
        send(&rig, "card-a", "one", &[]).unwrap();
        wait_ready(&rig, "card-a");
        send(&rig, "card-b", "two", &[]).unwrap();
        wait_ready(&rig, "card-b");
        assert_eq!(rig.registry.status_of("ws", "card-a").0, ChatStatus::Idle, "made room");
        assert_eq!(rig.registry.live_count(), 1);
        let pids = pids(&rig);
        assert!(gone(pids[0]));
        rig.registry.sweep_idle();
        assert_eq!(rig.registry.status_of("ws", "card-b").0, ChatStatus::Idle);
        assert_eq!(rig.registry.live_count(), 0);
        assert!(gone(pids[1]));
        assert_eq!(rig.registry.open("ws", "card-b", ChatVendor::Codex).unwrap().vendor, ChatVendor::Codex);
        assert_eq!(rig.registry.messages("ws", "card-b", Some(ChatVendor::Claude), None).unwrap().messages.len(), 2);
    }

    #[test]
    fn a_deleted_card_takes_its_chat_session_record_and_attachments_with_it() {
        let rig = rig();
        rig.registry.open("ws", "card-1", ChatVendor::Claude).unwrap();
        let note = rig.registry.attachment_add("ws", "card-1", "../../notes.md", b"# notes").unwrap();
        assert_eq!(note.name, "notes.md", "a name with folders is only its last part");
        send(&rig, "card-1", "read my notes", &[note.id.clone()]).unwrap();
        wait_ready(&rig, "card-1");
        assert!(log(&rig).contains("The member attached these files"), "{}", log(&rig));
        let card_dir = rig.config.join("projects/ws/cards/card-1");
        let session_dir = chat_dir(&rig.config, "ws", "card-1").unwrap();
        assert!(card_dir.join("attachments").join(&note.stored_name).is_file());
        assert!(session_dir.is_dir());
        assert!(!session_dir.join(".git").exists(), "a plain folder");
        let pid = pids(&rig)[0];
        rig.registry.forget_card("ws", "card-1");
        assert!(gone(pid), "its session ended");
        assert!(!card_dir.exists());
        assert!(!session_dir.exists());
        assert!(rig.registry.attachment_add("ws", "card-1", "late.md", b"x").is_err(), "nothing stored for it again");
        assert!(rig.registry.messages("ws", "card-1", None, None).is_err());
        assert!(!card_dir.exists());
    }

    #[test]
    fn a_deleted_workspace_takes_every_card_chat_with_it() {
        let rig = rig();
        for card in ["card-a", "card-b"] {
            rig.registry.open("ws", card, ChatVendor::Claude).unwrap();
            rig.registry.attachment_add("ws", card, "n.md", b"# n").unwrap();
        }
        send(&rig, "card-a", "hi", &[]).unwrap();
        wait_ready(&rig, "card-a");
        let pid = pids(&rig)[0];
        rig.registry.forget_workspace("ws").join().unwrap();
        assert!(gone(pid));
        assert!(!rig.config.join("projects/ws/cards").exists());
        assert!(!crate::claude_session::sessions_root(&rig.config).join("chats/ws").exists());
        assert!(rig.registry.open("ws", "card-c", ChatVendor::Claude).is_err());
    }

    #[test]
    fn an_attachment_is_removed_with_its_files_and_the_card_s_cap_holds() {
        let rig = rig();
        let docx = test_files::docx("<w:p><w:r><w:t>Brief</w:t></w:r></w:p>");
        let att = rig.registry.attachment_add("ws", "card-1", "brief.docx", &docx).unwrap();
        let dir = rig.config.join("projects/ws/cards/card-1/attachments");
        assert!(att.text_path(&dir).unwrap().is_file());
        rig.registry.attachment_remove("ws", "card-1", &att.id).unwrap();
        assert!(rig.registry.attachment_list("ws", "card-1").unwrap().is_empty());
        assert!(!att.path(&dir).exists());
        assert!(!att.text_path(&dir).unwrap().exists());
        assert!(rig.registry.attachment_add("ws", "card-1", "x.exe", b"MZ").is_err());
        assert!(rig.registry.attachment_add("ws", "../evil", "x.md", b"x").is_err(), "ids stay path components");
        assert!(rig.registry.attachment_add("ws", "card-1", "bad\nname.md", b"x").unwrap_err().contains("control"));
        // The cap is checked when the file is written: parallel adds never
        // go past it.
        let threads: Vec<_> = (0..chat_attachments::MAX_ATTACHMENTS_PER_CARD + 5)
            .map(|n| {
                let registry = rig.registry.clone();
                std::thread::spawn(move || registry.attachment_add("ws", "card-1", &format!("n{n}.md"), b"x").is_ok())
            })
            .collect();
        let added = threads.into_iter().map(|t| t.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(added, chat_attachments::MAX_ATTACHMENTS_PER_CARD);
        assert_eq!(rig.registry.attachment_list("ws", "card-1").unwrap().len(), chat_attachments::MAX_ATTACHMENTS_PER_CARD);
    }
}
