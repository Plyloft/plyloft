//! `plan_exchange`: the protocol's pure rules (the line-up, the verdict,
//! the relay text, the rounds, the instructions, the argv's size), and the
//! driver end to end with fake CLIs — a bash `claude` that writes its
//! transcript in its own cwd's project folder (as Claude does), and a bash
//! `codex app-server` — for Claude and Codex, Claude twice and Codex twice
//! (Q5). No real Claude or Codex runs.

use super::*;

fn exchange(proposer: ChatVendor, critic: ChatVendor) -> Exchange {
    Exchange {
        id: "0123456789abcdef0123".into(),
        created_at: 0,
        updated_at: 0,
        proposer,
        critic,
        ask: "Keep the import small.".into(),
        attachment_ids: vec![],
        rounds_default: ROUNDS_DEFAULT,
        rounds_max: ROUNDS_MAX,
        rounds_done: 0,
        rounds_target: ROUNDS_DEFAULT,
        note: None,
        status: ExchangeStatus::Running,
        pause: None,
        turns: vec![],
        proposer_conversation: None,
        critic_conversation: None,
        outcome: None,
    }
}

fn answered(n: u32, round: u32, role: TurnRole, answer: &str, verdict: Option<Verdict>) -> Turn {
    Turn {
        n,
        round,
        role,
        vendor: ChatVendor::Claude,
        sent: SentKind::Full,
        sent_message_id: Some(format!("m{n}")),
        answer_message_id: Some(format!("a{n}")),
        answer: Some(answer.into()),
        verdict,
        started_at: 0,
        ended_at: Some(1),
        outcome: Some(TurnOutcome::Answered),
    }
}

#[test]
fn the_line_up_is_two_vendors_when_both_are_ready_and_one_vendor_twice_otherwise() {
    use ChatVendor::*;
    assert_eq!(lineup(Claude, true, true).unwrap(), (Claude, Codex));
    assert_eq!(lineup(Codex, true, true).unwrap(), (Codex, Claude), "the Builder vendor proposes");
    assert_eq!(lineup(Codex, true, false).unwrap(), (Claude, Claude), "only Claude: Claude twice");
    assert_eq!(lineup(Claude, false, true).unwrap(), (Codex, Codex), "only Codex: Codex twice");
    let none = lineup(Claude, false, false).unwrap_err();
    assert!(none.contains("Claude Code or Codex") && !none.contains("Mac") && !none.contains("Windows"), "{none}");
}

#[test]
fn the_verdict_is_the_last_line_in_any_dress_and_anything_else_is_none() {
    for ready in ["Verdict: ready", "verdict: READY.", "**Verdict: ready**", "`Verdict: ready`", "_Verdict: ready_", "x\n\nVerdict: ready\n\n"] {
        assert_eq!(verdict_of(ready), Verdict::Ready, "{ready:?}");
    }
    assert_eq!(verdict_of("1. Tests.\nVerdict: changes needed"), Verdict::ChangesNeeded);
    assert_eq!(verdict_of("Verdict: changes needed."), Verdict::ChangesNeeded);
    for none in ["", "Looks fine.", "Verdict: ready-ish", "Verdict: ready\nThanks!"] {
        assert_eq!(verdict_of(none), Verdict::None, "{none:?}");
    }
}

#[test]
fn the_relay_is_the_answer_after_the_last_tool_call_cut_at_its_cap() {
    let mut c = Conversation::new(ChatVendor::Claude, 0);
    let sent = ChatMessage::new("user", "plan it", 0);
    c.push(ChatMessage::new("assistant", "earlier turn", 0));
    c.push(sent.clone());
    c.push(ChatMessage::new("assistant", "I'll read the file first.", 0));
    c.push(ChatMessage::new("tool", "", 0));
    let a = ChatMessage::new("assistant", "## Goal", 0);
    let b = ChatMessage::new("assistant", "## Steps", 0);
    c.push(a);
    c.push(b.clone());
    let (text, last) = final_answer(&c, &sent.id).unwrap();
    assert_eq!(text, "## Goal\n\n## Steps", "narration before the tool is left out");
    assert_eq!(last, b.id);
    let mut long = Conversation::new(ChatVendor::Codex, 0);
    long.push(sent.clone());
    long.push(ChatMessage::new("assistant", "y".repeat(RELAY_CAP * 2), 0));
    let (text, _) = final_answer(&long, &sent.id).unwrap();
    assert_eq!(text.chars().count(), RELAY_CAP);
    assert!(text.ends_with("[Plyloft cut this at 16,000 characters]"));
    let mut empty = Conversation::new(ChatVendor::Codex, 0);
    empty.push(sent.clone());
    empty.push(ChatMessage::new("tool", "", 0));
    assert!(final_answer(&empty, &sent.id).is_none(), "no answer after the tool");
}

#[test]
fn rounds_run_to_two_stop_early_on_ready_and_another_round_goes_one_further() {
    let mut e = exchange(ChatVendor::Claude, ChatVendor::Codex);
    assert_eq!(next_step(&e), Next::Turn { round: 0, role: TurnRole::Propose });
    e.turns.push(answered(0, 0, TurnRole::Propose, "p0", None));
    assert_eq!(next_step(&e), Next::Turn { round: 1, role: TurnRole::Critique });
    e.turns.push(answered(1, 1, TurnRole::Critique, "c1", Some(Verdict::ChangesNeeded)));
    assert_eq!(next_step(&e), Next::Turn { round: 1, role: TurnRole::Revise });
    e.turns.push(answered(2, 1, TurnRole::Revise, "p1", None));
    e.turns.push(answered(3, 2, TurnRole::Critique, "c2", Some(Verdict::None)));
    assert_eq!(next_step(&e), Next::Turn { round: 2, role: TurnRole::Revise }, "no verdict reads as changes needed");
    e.turns.push(answered(4, 2, TurnRole::Revise, "p2", None));
    assert_eq!(next_step(&e), Next::AwaitMember, "5 turns by default");
    // Another round: one more critique and revision.
    e.rounds_done = 2;
    e.rounds_target = 3;
    assert_eq!(next_step(&e), Next::Turn { round: 3, role: TurnRole::Critique });
    // An early stop on ready in round 1: the driver sets the target to it.
    let mut early = exchange(ChatVendor::Claude, ChatVendor::Claude);
    early.turns.push(answered(0, 0, TurnRole::Propose, "p0", None));
    early.turns.push(answered(1, 1, TurnRole::Critique, "ok", Some(Verdict::Ready)));
    early.rounds_done = 1;
    early.rounds_target = 1;
    assert_eq!(next_step(&early), Next::AwaitMember);
    assert_eq!(early.latest_plan(), Some("p0"), "the proposer's plan stands");
    early.rounds_target = 2;
    assert_eq!(next_step(&early), Next::Turn { round: 2, role: TurnRole::Critique }, "another round critiques it again");
}

#[test]
fn each_side_gets_the_ask_once_and_the_other_s_answer_between_its_lines() {
    let mut e = exchange(ChatVendor::Claude, ChatVendor::Codex);
    let propose = turn_text(&e, 0, TurnRole::Propose, true);
    assert!(propose.starts_with("The member asks: Keep the import small."));
    assert!(propose.contains("Goal, What changes, Steps, Tests, Risks, Open questions"));
    e.turns.push(answered(0, 0, TurnRole::Propose, "## Goal\nImport", None));
    let critique = turn_text(&e, 1, TurnRole::Critique, true);
    assert!(critique.contains("Claude's plan, round 1 of 2:\n----- plan -----\n## Goal\nImport\n----- end of plan -----"));
    assert!(critique.contains("The member asks"), "the critic's first turn has the ask");
    assert!(critique.trim_end().ends_with("`Verdict: changes needed`."));
    e.turns.push(answered(1, 1, TurnRole::Critique, "1. Tests.\nVerdict: changes needed", Some(Verdict::ChangesNeeded)));
    let revise = turn_text(&e, 1, TurnRole::Revise, false);
    assert!(revise.starts_with("Codex's critique, round 1 of 2:\n----- critique -----\n1. Tests."));
    assert!(!revise.contains("The member asks"), "the ask goes only on a side's first turn");
    let second = turn_text(&e, 2, TurnRole::Critique, false);
    assert!(!second.contains("The member asks"));
    // Another round's note goes first, to both.
    e.rounds_target = 3;
    e.note = Some("Mind the CSV encoding.".into());
    assert!(turn_text(&e, 3, TurnRole::Critique, false).starts_with("The member adds: Mind the CSV encoding."));
    assert!(turn_text(&e, 3, TurnRole::Revise, false).contains("The member adds: Mind the CSV encoding."));
    assert!(!turn_text(&e, 2, TurnRole::Revise, false).contains("The member adds"), "only in its round");
    // The re-seed carries everything a fresh session needs.
    let reseed = reseed_text(&e, 2, TurnRole::Revise);
    assert!(reseed.contains("The member asks") && reseed.contains("----- plan -----") && reseed.contains("----- critique -----"));
    assert!(reseed.contains("round 2 of 3"));
}

/// Q5: with one vendor, each side names the other as a separate session
/// of it, never as another vendor.
#[test]
fn with_one_vendor_the_sides_name_each_other_as_separate_sessions() {
    let e = exchange(ChatVendor::Claude, ChatVendor::Claude);
    let context = ChatContext { title: "Import".into(), notes: String::new(), project_dir: None, plan: None, pull_request: None };
    let proposer = lane_instructions(&e, PlanRole::Proposer, &context, Path::new("/att"));
    let critic = lane_instructions(&e, PlanRole::Critic, &context, Path::new("/att"));
    assert!(proposer.contains("another AI, a second, separate Claude session"), "{proposer}");
    assert!(proposer.contains("the other Claude session critiques it"));
    assert!(critic.contains("another AI, a separate Claude session, wrote"));
    assert!(critic.contains("the other Claude session revises it"));
    let mut plan = e.clone();
    plan.turns.push(answered(0, 0, TurnRole::Propose, "p", None));
    assert!(turn_text(&plan, 1, TurnRole::Critique, true).contains("The other Claude session's plan, round 1 of 2"));
    let two = exchange(ChatVendor::Codex, ChatVendor::Claude);
    let critic = lane_instructions(&two, PlanRole::Critic, &context, Path::new("/att"));
    assert!(critic.contains("another AI, Codex, wrote") && critic.contains("Codex revises it"));
    // At most 8,000 characters, the role paragraph kept.
    let huge = ChatContext { title: "T".into(), notes: "n".repeat(20_000), project_dir: None, plan: Some("p".repeat(20_000)), pull_request: None };
    let capped = lane_instructions(&two, PlanRole::Proposer, &huge, Path::new("/att"));
    assert!(capped.chars().count() <= INSTRUCTIONS_CAP);
    assert!(capped.contains("In this conversation you write the plan"));
}

/// B3: a plan lane's Claude starts with no positional prompt, and its argv
/// with the longest inputs stays under 16,000 characters (Windows' 32,767
/// command line through the npm shim).
#[test]
fn the_plan_lane_argv_has_no_prompt_and_stays_short_with_the_longest_inputs() {
    let e = exchange(ChatVendor::Claude, ChatVendor::Codex);
    let long_dir = PathBuf::from(format!("/{}", "d".repeat(200)));
    let huge = ChatContext {
        title: "T".repeat(500),
        notes: "n".repeat(20_000),
        project_dir: Some(long_dir.clone()),
        plan: Some("p".repeat(20_000)),
        pull_request: None,
    };
    let instructions = lane_instructions(&e, PlanRole::Proposer, &huge, &long_dir);
    // Challenger: the cut takes the card's words, never the folders' lines
    // (a Codex session finds the project only by them).
    assert!(instructions.chars().count() <= INSTRUCTIONS_CAP);
    assert!(instructions.contains(&format!("The project's files are in: {}", long_dir.display())), "{instructions}");
    assert!(instructions.contains("The member's attachments are in: "));
    assert!(instructions.contains("[cut here]"));
    assert!(instructions.ends_with("The member decides at the end.\n"), "the role paragraph whole");
    let argv = chat::claude_chat_argv(
        "11111111-2222-3333-4444-555555555555",
        false,
        &[long_dir.clone(), long_dir.clone(), long_dir.clone()],
        &instructions,
        None,
        &crate::settings::ModelChoice::default(),
    );
    let total: usize = argv.iter().map(|a| a.chars().count() + 1).sum();
    assert!(total < 16_000, "argv is {total} characters");
    assert_eq!(argv.last().unwrap(), "--strict-mcp-config", "no positional prompt");
    let model = crate::settings::ModelChoice::default();
    let review = crate::read_only_provider::read_only_argv_for(ply_collab::Provider::Claude, "x", Path::new("/tmp"), &model, false);
    assert_eq!(
        crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &argv, false).unwrap(),
        crate::read_only_provider::restriction_argv_profile_for(ply_collab::Provider::Claude, &review, false).unwrap(),
        "the read-only profile of the reviews"
    );
    assert!(crate::pty::refuse_print_mode("claude", &argv).is_ok());
}

#[test]
fn a_relay_point_needs_a_reliable_end_and_an_idle_composer() {
    let view = |close: TurnClose, idle: bool, quiet: u64| LaneView {
        live: true,
        vendor: ChatVendor::Claude,
        status: ChatStatus::Ready,
        reason: None,
        attention: None,
        turn_close: close,
        composer_idle: idle,
        quiet_for: Duration::from_millis(quiet),
        codex_turn: None,
        conversation: Conversation::new(ChatVendor::Claude, 0),
        pty_id: None,
        reseeded: false,
    };
    let stuck = Duration::from_secs(10);
    assert!(relay_point(&view(TurnClose::Ended, true, 0), stuck));
    assert!(relay_point(&view(TurnClose::Stuck, true, 0), stuck));
    assert!(!relay_point(&view(TurnClose::Ended, false, 99_000), stuck), "the composer must be idle");
    assert!(!relay_point(&view(TurnClose::Open, true, 99_000), stuck));
    assert!(!relay_point(&view(TurnClose::Settled, true, 3_000), stuck), "a settle alone is no relay point");
    assert!(relay_point(&view(TurnClose::Settled, true, 10_000), stuck), "a settle and the stuck closer's quiet");
}

#[test]
fn a_stop_reason_names_its_pause() {
    use crate::claude_session as cs;
    assert_eq!(kind_of(cs::FOLDER_TRUST_REFUSAL), PauseKind::Trust);
    assert_eq!(kind_of(cs::USAGE_LIMIT), PauseKind::UsageLimit);
    assert_eq!(kind_of(cs::NOT_LOGGED_IN), PauseKind::SignIn);
    assert_eq!(kind_of(cs::API_KEY_QUESTION), PauseKind::Screen);
    assert_eq!(kind_of("Claude stopped (exit code 3)."), PauseKind::Failed);
}

/// A `chat.json` is byte for byte what it was: the new message fields are
/// never written there.
#[test]
fn chat_json_never_carries_the_plan_fields() {
    let message = ChatMessage::new("user", "hi", 1);
    let text = serde_json::to_string(&message).unwrap();
    assert!(!text.contains("relayOf") && !text.contains("\"turn\""), "{text}");
    let mut relay = message.clone();
    relay.relay_of = Some("a1".into());
    relay.turn = Some(3);
    let text = serde_json::to_string(&relay).unwrap();
    assert!(text.contains("\"relayOf\":\"a1\"") && text.contains("\"turn\":3"));
}

/// The wiring other paths need, read from the source: the build guard on
/// the shared start path (P1), the intake guard, the view-only PTY
/// refusals, the quit order, and the deletes.
#[test]
fn the_guards_and_the_cleanup_are_wired() {
    let source = |file: &str| std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file)).unwrap();
    let body = |file: &str, name: &str| {
        let text = source(file);
        let start = text.find(&format!("fn {name}")).unwrap_or_else(|| panic!("fn {name} in {file}"));
        let rest = &text[start..];
        rest[..rest.find("\n}\n").unwrap_or(rest.len())].to_string()
    };
    assert!(body("commands.rs", "advance_card_to_in_progress_staged<").contains("build_refusal("));
    // P1 on the hand move too (the Board falls back to it when a start is
    // refused): never a way round the build guard.
    assert!(body("commands.rs", "kanban_card_patch<").contains("build_refusal("));
    assert!(body("commands.rs", "intake_start(").contains("intake_refusal("));
    for command in ["pty_write(", "pty_resize(", "pty_kill("] {
        assert!(body("commands.rs", command).contains("refuse_plan_pty("), "{command}");
    }
    let delete = body("commands.rs", "finish_card_delete(");
    let plans = delete.find("PlanExchanges>()").expect("plans forgotten on delete");
    let chats = delete.find("ChatRegistry>().forget_card(").unwrap();
    assert!(plans < chats, "the plans first: nothing written after the folder goes");
    assert!(body("commands.rs", "workspace_delete(").contains("plans.forget_workspace(&id)"));
    let exit = body("lib.rs", "run_exit_cleanup(");
    let interrupt = exit.find("plans.interrupt_active()").expect("exchanges paused on quit");
    let kill = exit.find("state::<chat::ChatRegistry>").unwrap();
    assert!(interrupt < kill, "paused{{quit}} before the sessions end");
}

/// Windows path length (§3, §9 step 17): a plan side's folder adds
/// `plan-<12 hex>` and the role to the card's chat folder, so it stays at
/// 101 characters inside the profile for a workspace uuid and a usual card
/// id, and Claude's transcript for it (`<home>/.claude/projects/<the
/// folder's path as one name>/<uuid>.jsonl`) stays under MAX_PATH.
#[test]
fn a_plan_side_s_folder_and_its_claude_transcript_stay_short() {
    let config = PathBuf::from("CONFIG");
    let chats = chat::ChatRegistry::new(config.clone());
    let ws = "7072ea28-1b35-4967-8ea7-25356541abd0";
    let longest = |card: &str| {
        [PlanRole::Proposer, PlanRole::Critic]
            .iter()
            .map(|role| {
                let dir = chats.lane_dir(&ChatKey::plan(ws, card, "17afd76566cb0123456789abcdef", *role)).unwrap();
                dir.strip_prefix(&config).unwrap().to_string_lossy().chars().count()
            })
            .max()
            .unwrap()
    };
    assert_eq!(longest("card-mvataxlq-0"), 101, "inside the profile folder");
    // On this machine, with its own profile and home folders.
    let (profile, home) = if cfg!(windows) {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| r"C:\Users\example\AppData\Roaming".into());
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\example".into());
        (format!(r"{appdata}\com.mbadv.ply.test"), home)
    } else {
        (r"C:\Users\example\AppData\Roaming\com.mbadv.ply.test".to_string(), r"C:\Users\example".to_string())
    };
    let lane = profile.chars().count() + 1 + longest("card-mvataxlq-0");
    let transcript = home.chars().count() + r"\.claude\projects\".len() + lane + 1 + 36 + ".jsonl".len();
    assert!(lane < 200, "the folder is {lane} characters");
    assert!(transcript < 260, "Claude's transcript is {transcript} characters");
    // A 20-character Windows user name (the most a local account has) still fits.
    let user = home.rsplit('\\').next().unwrap_or("").chars().count();
    let longer = 2 * 20usize.saturating_sub(user);
    assert!(transcript + longer < 260, "with a 20-character user name: {}", transcript + longer);
}

// ── The driver, with fake CLIs ───────────────────────────────────────

/// The fakes are node scripts (`plan_exchange_fakes/`), so the driver's
/// tests run on the Mac and on Windows alike: Claude's through a real PTY
/// (ConPTY on Windows: the bracketed paste, the CR, the Esc), Codex's App
/// Server on pipes.
mod live {
    use super::*;

    type Events = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    struct TestEnv {
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        kanban: Arc<crate::kanban::KanbanStore>,
        chats: chat::ChatRegistry,
        pty: crate::pty::PtyRegistry,
        ready: Mutex<(bool, bool)>,
        project: PathBuf,
        events: Events,
        /// A send refused with these words (a Claude never at its prompt).
        refuse_send: Mutex<Option<String>>,
    }

    impl PlanEnv for TestEnv {
        fn card(&self, workspace_id: &str, card_id: &str) -> Result<KanbanCard, String> {
            self.kanban.get_card(workspace_id, card_id)
        }
        fn context(&self, workspace_id: &str, card_id: &str) -> Result<ChatContext, String> {
            let card = self.kanban.get_card(workspace_id, card_id)?;
            Ok(ChatContext {
                title: card.title,
                notes: card.notes.unwrap_or_default(),
                project_dir: Some(self.project.clone()),
                plan: card.dispatch_prompt,
                pull_request: None,
            })
        }
        fn send(&self, key: &ChatKey, send: PlanSend) -> Result<ChatMessage, String> {
            if let Some(words) = self.refuse_send.lock().clone() {
                return Err(words);
            }
            self.chats.plan_send(&self.app, &self.pty, key, send)
        }
        fn apply(
            &self,
            workspace_id: &str,
            card_id: &str,
            text: &str,
            edited: bool,
            record: IntakeRecord,
            attachments: Vec<CardAttachment>,
        ) -> Result<KanbanCard, String> {
            self.kanban.apply_two_ai_plan(workspace_id, card_id, text, edited, record, attachments)
        }
        fn vendor_ready(&self, vendor: ChatVendor) -> bool {
            let (claude, codex) = *self.ready.lock();
            match vendor {
                ChatVendor::Claude => claude,
                ChatVendor::Codex => codex,
                ChatVendor::Other => false,
            }
        }
        fn emit(&self, event: &str, payload: serde_json::Value) {
            self.events.lock().push((event.to_string(), payload));
        }
    }

    struct Rig {
        root: tempfile::TempDir,
        config: PathBuf,
        claude_config: PathBuf,
        log: PathBuf,
        chats: chat::ChatRegistry,
        plans: PlanExchanges,
        env: Arc<TestEnv>,
        kanban: Arc<crate::kanban::KanbanStore>,
        _app: tauri::App<tauri::test::MockRuntime>,
        /// Held for the rig's life, as the setup tests' harness does: a
        /// parallel test may swap the cached PATH for one without `node`
        /// (the full suite did, on the Mac), and the fakes' launch reads it
        /// (Windows resolves the shim's `node.exe` through it at spawn).
        _env: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            self.plans.interrupt_active();
            self.chats.kill_all();
            self.env.pty.kill_all();
        }
    }

    fn init_env() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(crate::shell_env::init);
    }

    /// A JSON string literal for a path, to put into a fake's source.
    fn js_string(path: &Path) -> String {
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    }

    /// The `node` the fakes run on, from Plyloft's own PATH.
    fn node() -> String {
        let path = crate::shell_env::get().path.clone();
        crate::shell_env::resolve_program("node", &path)
            .expect("node is needed on PATH for the fake claude and codex of these tests")
    }

    /// Installs the fake CLI `name` (a node script from
    /// `plan_exchange_fakes/`, `__ROOT__` and `__LOG__` filled in) and
    /// returns the program to start. On unix a shell wrapper that execs
    /// node (the pid stays node's); on Windows an npm-style `.cmd` shim,
    /// which `platform::launch_argv` turns into `node.exe <script>` as it
    /// does for an npm-installed Claude or Codex, so the fake runs straight
    /// under ConPTY (Claude) or on pipes (Codex), with no cmd.exe between.
    fn install_fake(root: &Path, log: &Path, name: &str, source: &str) -> PathBuf {
        let script = root.join(format!("{name}.js"));
        let body = source.replace("__ROOT__", &js_string(root)).replace("__LOG__", &js_string(log));
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let program = root.join(name);
            let quote = |p: &str| format!("'{}'", p.replace('\'', "'\\''"));
            let wrapper = format!("#!/bin/sh\nexec {} {} \"$@\"\n", quote(&node()), quote(&script.to_string_lossy()));
            std::fs::write(&program, wrapper).unwrap();
            let mut permissions = std::fs::metadata(&program).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&program, permissions).unwrap();
            program
        }
        #[cfg(windows)]
        {
            let _ = node();
            let program = root.join(format!("{name}.cmd"));
            let shim = format!("@ECHO off\r\nSET \"_prog=node\"\r\nendLocal & \"%_prog%\"  \"%dp0%\\{name}.js\" %*\r\n");
            std::fs::write(&program, shim).unwrap();
            program
        }
    }

    const FAKE_CLAUDE: &str = include_str!("plan_exchange_fakes/fake_claude.js");
    const FAKE_CODEX: &str = include_str!("plan_exchange_fakes/fake_codex.js");
    const FAKE_CLAUDE_TRUST: &str = include_str!("plan_exchange_fakes/fake_claude_trust.js");

    fn rig_with(chat_limits: chat::ChatLimits, ready: (bool, bool)) -> Rig {
        rig_full(chat_limits, ready, PlanLimits { poll: Duration::from_millis(40), prompt_retry: Duration::from_millis(200), ..PlanLimits::default() })
    }

    fn rig_full(chat_limits: chat::ChatLimits, ready: (bool, bool), plan_limits: PlanLimits) -> Rig {
        let guard = crate::shell_env::lock_for_test();
        init_env();
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let claude_config = root.path().join("claude-config");
        std::fs::create_dir_all(claude_config.join("projects")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        let codex_home = root.path().join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        let log = root.path().join("cli.log");
        let claude = install_fake(root.path(), &log, "fake-claude", FAKE_CLAUDE);
        let codex = install_fake(root.path(), &log, "fake-codex", FAKE_CODEX);
        let chats = chat::ChatRegistry::with(
            config.clone(),
            chat_limits,
            chat::ChatOverrides {
                claude: Some(claude.to_string_lossy().into_owned()),
                codex: Some(codex.to_string_lossy().into_owned()),
                claude_config: Some(claude_config.clone()),
                codex_home: Some(codex_home),
                ..chat::ChatOverrides::default()
            },
        );
        let events: Events = Arc::default();
        let sink = events.clone();
        chats.set_emitter(Arc::new(move |event: &str, payload: serde_json::Value| sink.lock().push((event.to_string(), payload))));
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let kanban = Arc::new(crate::kanban::KanbanStore::new(config.clone()).unwrap());
        let project = root.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let env = Arc::new(TestEnv {
            app: app.handle().clone(),
            kanban: kanban.clone(),
            chats: chats.clone(),
            pty: crate::pty::PtyRegistry::default(),
            ready: Mutex::new(ready),
            project,
            events,
            refuse_send: Mutex::new(None),
        });
        let plans = PlanExchanges::with(chats.clone(), env.clone(), plan_limits);
        Rig { root, config, claude_config, log, chats, plans, env, kanban, _app: app, _env: guard }
    }

    fn limits() -> chat::ChatLimits {
        chat::ChatLimits {
            echo_timeout: Duration::from_secs(5),
            turn_settle: Duration::from_millis(400),
            screen_settle: Duration::from_millis(600),
            menu_settle: Duration::from_millis(200),
            stuck_turn: Duration::from_millis(800),
            ..chat::ChatLimits::default()
        }
    }

    fn rig(ready: (bool, bool)) -> Rig {
        rig_with(limits(), ready)
    }

    fn card(rig: &Rig, id: &str) {
        let card = KanbanCard::new(id.into(), "ws".into(), format!("Import {id}"), Some("Small.".into()), KanbanColumnId::Todo);
        rig.kanban.create_card("ws", card).unwrap();
    }

    fn log(rig: &Rig) -> String {
        std::fs::read_to_string(&rig.log).unwrap_or_default()
    }

    fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(40);
        while !ready() {
            assert!(Instant::now() < until, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn wait_status(rig: &Rig, card: &str, status: ExchangeStatus) -> Exchange {
        wait_for(&format!("{status:?}"), || rig.plans.status_of("ws", card).is_some_and(|(s, _)| s == status));
        rig.plans.latest("ws", card).unwrap()
    }

    fn pids(rig: &Rig, who: &str) -> Vec<i32> {
        log(rig)
            .lines()
            .filter_map(|l| l.strip_prefix(&format!("{who} ")))
            .filter(|l| l.contains(" start"))
            .filter_map(|l| l.split_whitespace().next()?.parse().ok())
            .collect()
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks whether the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A pid that can't be opened, or whose process has an exit code, is gone.
    #[cfg(windows)]
    fn alive(pid: i32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a query-only handle, closed below.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        // SAFETY: `h` is an open process handle, closed once.
        unsafe {
            let running = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
            CloseHandle(h);
            running
        }
    }

    fn gone(pid: i32) -> bool {
        let until = Instant::now() + Duration::from_secs(8);
        loop {
            if !alive(pid) {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn user_texts(conversation: &Option<Conversation>) -> Vec<String> {
        conversation.as_ref().unwrap().messages.iter().filter(|m| m.role == "user").map(|m| m.text.clone()).collect()
    }

    /// Claude proposes, Codex critiques: the default two rounds (5 turns),
    /// each relay sent once after the sender's turn closed, the ask and
    /// the files on each side's first turn only; then Use this plan writes
    /// the card, copies the chat file and ends both sessions.
    #[test]
    fn claude_and_codex_run_two_rounds_and_use_this_plan_writes_the_card() {
        let rig = rig((true, true));
        card(&rig, "c1");
        let att = rig.chats.attachment_add("ws", "c1", "shot one.png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let chat_before = std::fs::read(rig.config.join("projects/ws/cards/c1/chat.json")).unwrap();
        let started = rig.plans.start("ws", "c1", ChatVendor::Claude, "Keep it small.", &[att.id.clone()]).unwrap();
        let current = started.current.unwrap();
        assert_eq!((current.proposer, current.critic), (ChatVendor::Claude, ChatVendor::Codex));
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        let roles: Vec<TurnRole> = done.turns.iter().map(|t| t.role).collect();
        assert_eq!(
            roles,
            vec![TurnRole::Propose, TurnRole::Critique, TurnRole::Revise, TurnRole::Critique, TurnRole::Revise],
            "5 turns by default"
        );
        assert!(done.turns.iter().all(|t| t.outcome == Some(TurnOutcome::Answered)));
        assert_eq!(done.turns[1].verdict, Some(Verdict::ChangesNeeded));
        assert_eq!(done.rounds_done, 2);
        assert!(done.turns[0].answer.as_deref().unwrap().starts_with("## Goal\nPlan 1 by"), "the text after the tool call");
        assert!(!done.turns[0].answer.as_deref().unwrap().contains("read the files"), "narration left out");
        // What each side received.
        let proposer = user_texts(&done.proposer_conversation);
        let critic = user_texts(&done.critic_conversation);
        assert_eq!(proposer.len(), 3);
        assert_eq!(critic.len(), 2);
        assert!(proposer[0].starts_with("The member asks: Keep it small."));
        assert!(!proposer[1].contains("The member asks"), "the ask on the first turn only");
        assert!(critic[0].contains("The member asks") && critic[0].contains("Claude's plan, round 1 of 2:\n----- plan -----"));
        assert!(!critic[1].contains("The member asks"));
        assert!(proposer[1].starts_with("Codex's critique, round 1 of 2:\n----- critique -----\n1. Tests are missing."));
        let cli = log(&rig);
        assert!(!cli.contains("positional"), "the plan Claude starts with no prompt: {cli}");
        assert_eq!(cli.matches("The member attached these files").count(), 1, "the chat file once, to Claude's first message");
        assert_eq!(cli.lines().filter(|l| l.contains("\"localImage\"")).count(), 1, "and once to Codex's first turn");
        // Codex's thread: read-only, never asks, its own folder and key.
        let start: serde_json::Value = serde_json::from_str(
            cli.lines().find(|l| l.contains("\"thread/start\"")).unwrap().splitn(3, ' ').nth(2).unwrap(),
        )
        .unwrap();
        assert_eq!(start["params"]["sandbox"], "read-only");
        assert_eq!(start["params"]["approvalPolicy"], "never");
        let critic_dir = Path::new("ws").join("c1").join(chat::plan_folder_name(&done.id)).join("critic");
        assert!(Path::new(start["params"]["cwd"].as_str().unwrap()).ends_with(critic_dir));
        assert!(start["params"]["developerInstructions"].as_str().unwrap().contains("you critique a plan that another AI, Claude, wrote"));
        let proposer_dir = rig.chats.lane_dir(&ChatKey::plan("ws", "c1", &done.id, PlanRole::Proposer)).unwrap();
        assert_eq!(done.proposer_conversation.as_ref().unwrap().session_dir.as_deref(), Some(proposer_dir.to_string_lossy().as_ref()));
        // Events: the plan's own, never the Chat's. The state event is
        // emitted just after the status lands, so wait for it (a known flake).
        wait_for("the awaitingMember state event", || {
            rig.env.events.lock().iter().any(|(e, p)| e == STATE_EVENT && p["current"]["status"] == "awaitingMember")
        });
        let events = rig.env.events.lock().clone();
        assert!(events.iter().any(|(e, p)| e == chat::PLAN_MESSAGES_EVENT && p["role"] == "critic"));
        assert!(events.iter().any(|(e, p)| e == STATE_EVENT && p["current"]["status"] == "awaitingMember"));
        assert!(!events.iter().any(|(e, _)| e == chat::MESSAGES_EVENT), "no chat://messages from a plan lane");
        assert_eq!(std::fs::read(rig.config.join("projects/ws/cards/c1/chat.json")).unwrap(), chat_before, "chat.json unchanged");
        // The build waits for it (P1); an intake too.
        assert_eq!(rig.plans.build_refusal("ws", "c1").as_deref(), Some(BUILD_WAITS));
        assert!(rig.plans.intake_refusal("ws", "c1").is_some());
        // Use this plan.
        let pids_before: Vec<i32> = pids(&rig, "claude").into_iter().chain(pids(&rig, "codex")).collect();
        let card = rig.plans.accept("ws", "c1", None).unwrap();
        assert_eq!(card.dispatch_prompt.as_deref(), done.latest_plan());
        assert_eq!(card.intake_status, IntakeStatus::Ready);
        let record = card.intake_history.last().unwrap();
        assert_eq!(record.vendor.as_deref(), Some("claude"));
        assert_eq!(record.two_ais, Some(TwoAisRecord { critic: "codex".into(), rounds: 2, exchange_id: done.id.clone() }));
        assert_eq!(card.attachments.len(), 1, "the chat file copied to the card (Q4)");
        assert_eq!(card.attachments[0].display_name, "shot one.png");
        assert!(Path::new(&card.attachments[0].stored_path).is_file());
        assert!(crate::kanban::card_dispatch_prompt(&card).contains(&card.attachments[0].stored_path));
        assert_eq!(rig.plans.status_of("ws", "c1").unwrap().0, ExchangeStatus::Accepted);
        assert_eq!(rig.plans.build_refusal("ws", "c1"), None, "the build may start now");
        for pid in pids_before {
            assert!(gone(pid), "both sessions ended at Accept");
        }
        // Earlier plans keep it; a second Start can run.
        let snap = rig.plans.snapshot("ws", "c1").unwrap();
        assert!(snap.current.is_none() && snap.earlier.len() == 1);
        let disk = std::fs::read_to_string(rig.config.join("projects/ws/cards/c1/plan.json")).unwrap();
        assert!(disk.contains("\"status\": \"accepted\""));
    }

    /// Q5: with Codex not ready, Claude proposes and critiques — two
    /// sessions in two folders, with two session ids and two transcripts,
    /// neither following the other's. A ready verdict in round 1 stops the
    /// exchange early (3 turns); Discard writes nothing and the card stays
    /// in To do (Q6).
    #[test]
    fn claude_twice_runs_two_separate_sessions_and_stops_early_on_ready() {
        let rig = rig((true, false));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("ready"), "").unwrap();
        let started = rig.plans.start("ws", "c1", ChatVendor::Codex, "", &[]).unwrap();
        let current = started.current.unwrap();
        assert_eq!((current.proposer, current.critic), (ChatVendor::Claude, ChatVendor::Claude), "the ready vendor, twice");
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        assert_eq!(done.turns.len(), 2, "early stop: propose, critique (ready), no revision");
        assert_eq!(done.turns[1].verdict, Some(Verdict::Ready));
        assert_eq!((done.rounds_done, done.rounds_target), (1, 1));
        let p = done.proposer_conversation.as_ref().unwrap();
        let c = done.critic_conversation.as_ref().unwrap();
        assert_ne!(p.session_id, c.session_id, "two Claude session ids");
        assert_ne!(p.session_dir, c.session_dir, "two folders");
        assert!(Path::new(p.session_dir.as_deref().unwrap()).ends_with("proposer"));
        assert!(Path::new(c.session_dir.as_deref().unwrap()).ends_with("critic"));
        let transcripts: Vec<PathBuf> = [&p.session_id, &c.session_id]
            .iter()
            .map(|id| crate::claude_session::find_transcript(&rig.claude_config, id.as_deref().unwrap()).unwrap())
            .collect();
        assert_ne!(transcripts[0].parent(), transcripts[1].parent(), "two project folders");
        // Each conversation holds only its own session's messages.
        assert_eq!(p.messages.iter().filter(|m| m.role == "user").count(), 1);
        assert_eq!(c.messages.iter().filter(|m| m.role == "user").count(), 1);
        assert!(c.messages.iter().any(|m| m.role == "assistant" && m.text.contains("Verdict: ready")));
        assert!(!p.messages.iter().any(|m| m.text.contains("Verdict")), "the proposer never took the critic's answer as its own");
        let critic_message = &user_texts(&done.critic_conversation)[0];
        assert!(critic_message.contains("The other Claude session's plan, round 1 of 2"));
        assert_eq!(pids(&rig, "claude").len(), 2);
        assert!(pids(&rig, "codex").is_empty());
        // Discard.
        rig.plans.discard("ws", "c1").unwrap();
        let card = rig.kanban.get_card("ws", "c1").unwrap();
        assert_eq!(card.column_id, KanbanColumnId::Todo);
        assert_eq!(card.dispatch_prompt, None);
        assert!(card.intake_history.is_empty());
        assert_eq!(rig.plans.status_of("ws", "c1").unwrap().0, ExchangeStatus::Discarded);
    }

    /// Q5 for Codex: two App Servers, keyed `:proposer` and `:critic`, each
    /// in its own folder.
    #[test]
    fn codex_twice_runs_two_app_servers_with_their_own_keys_and_folders() {
        let rig = rig((false, true));
        card(&rig, "c1");
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        assert_eq!((done.proposer, done.critic), (ChatVendor::Codex, ChatVendor::Codex));
        assert_eq!(done.turns.len(), 5);
        let cli = log(&rig);
        let starts: Vec<&str> = cli.lines().filter(|l| l.contains(" start cwd=")).collect();
        assert_eq!(starts.len(), 2, "{cli}");
        let sep = std::path::MAIN_SEPARATOR;
        assert!(starts.iter().any(|l| l.ends_with(&format!("{sep}proposer"))) && starts.iter().any(|l| l.ends_with(&format!("{sep}critic"))));
        let p = done.proposer_conversation.as_ref().unwrap();
        let c = done.critic_conversation.as_ref().unwrap();
        assert_ne!(p.session_id, c.session_id, "two threads");
        assert!(rig.chats.lane_view(&ChatKey::plan("ws", "c1", &done.id, PlanRole::Proposer)).unwrap().live);
        assert_eq!(chat::codex_session_key(&ChatKey::plan("ws", "c1", &done.id, PlanRole::Critic)), format!("plan:ws:c1:{}:critic", done.id));
    }

    /// The 16,000-character relay (§9 step 12): a plan cut at its cap is
    /// pasted into the other Claude's composer whole, as one bracketed
    /// paste, and submitted once by the CR after it — through ConPTY on
    /// Windows, where the session also started with no prompt on its
    /// command line.
    #[test]
    fn a_16000_character_relay_arrives_whole_as_one_paste_and_is_submitted_once() {
        let rig = rig((true, false));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("long"), "").unwrap();
        std::fs::write(rig.root.path().join("ready"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        let plan = done.turns[0].answer.as_deref().unwrap();
        assert_eq!(plan.chars().count(), RELAY_CAP, "the plan cut at its cap");
        let relay = &user_texts(&done.critic_conversation)[0];
        assert!(relay.contains(plan), "the relay carries the whole plan");
        let pastes: Vec<String> = std::fs::read_dir(rig.root.path().join("pastes"))
            .unwrap()
            .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
            .filter(|text| text.contains("----- plan -----"))
            .collect();
        assert_eq!(pastes.len(), 1, "the relay was submitted once");
        assert_eq!(pastes[0], chat::composer_text(relay), "what the critic's composer got is the relay, byte for byte");
        assert!(pastes[0].chars().count() > RELAY_CAP);
        assert!(!log(&rig).contains("positional"), "no prompt on the command line");
        assert_eq!(done.turns[1].verdict, Some(Verdict::Ready));
    }

    /// Stop during a turn pauses it (the partial answer never relayed);
    /// Retry on the live session sends the short retry, and the turn's
    /// message stays in the transcript once.
    #[test]
    fn stop_pauses_and_retry_asks_again_without_doubling_the_message() {
        let rig = rig((true, true));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_for("the slow turn", || log(&rig).contains("msg["));
        wait_for("the open turn", || {
            rig.plans.latest("ws", "c1").and_then(|e| e.proposer_conversation).is_some_and(|c| c.messages.iter().any(|m| m.role == "assistant"))
        });
        std::thread::sleep(Duration::from_millis(300));
        rig.plans.stop("ws", "c1").unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert_eq!(paused.pause.as_ref().unwrap().kind, PauseKind::Stopped);
        assert_eq!(paused.pause.as_ref().unwrap().reason, "You stopped Claude's plan.");
        assert_eq!(paused.turns[0].outcome, Some(TurnOutcome::Stopped));
        assert_eq!(paused.latest_plan(), None, "the partial answer is never a plan");
        wait_for("the Esc", || log(&rig).contains("interrupted"));
        assert_eq!(rig.plans.build_refusal("ws", "c1"), None, "a paused exchange holds no build");
        assert!(rig.chats.reservation().is_none(), "the slots went back");
        std::fs::remove_file(rig.root.path().join("slow")).unwrap();
        rig.plans.retry("ws", "c1").unwrap();
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        assert_eq!(done.turns[0].sent, SentKind::Retry);
        let proposer = user_texts(&done.proposer_conversation);
        assert_eq!(proposer[1], RETRY_TEXT, "a short retry, not the whole message again");
        assert_eq!(log(&rig).matches("Write the plan with these headings").count(), 1, "the turn's message once");
        assert!(done.turns[0].answer.as_deref().unwrap().contains("Retried plan"));
    }

    /// A Claude that writes no `turn_duration` at all: every turn is
    /// relayed once settle-closed with an idle, still composer for the
    /// stuck interval — never before, and never waited on for ever.
    #[test]
    fn a_claude_with_no_turn_end_entries_is_relayed_after_the_stuck_interval() {
        let rig = rig((true, false));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("noend"), "").unwrap();
        std::fs::write(rig.root.path().join("ready"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let first_answer = Instant::now();
        wait_for("the first answer", || {
            rig.plans.latest("ws", "c1").and_then(|e| e.proposer_conversation).is_some_and(|c| c.messages.iter().any(|m| m.role == "assistant" && m.text.starts_with("## Goal")))
        });
        let seen = Instant::now();
        wait_for("the relay", || log(&rig).contains("----- plan -----"));
        let relayed = Instant::now();
        assert!(relayed.duration_since(seen) >= Duration::from_millis(700), "not before the stuck interval");
        let _ = first_answer;
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        assert_eq!(done.turns.len(), 2);
    }

    /// P2 and P3: one running exchange at a time (the other card is named);
    /// the card's Chat waits while its exchange runs; Start waits for the
    /// card's Chat while it answers.
    #[test]
    fn one_exchange_at_a_time_and_the_card_s_chat_first() {
        let rig = rig((true, true));
        card(&rig, "c1");
        card(&rig, "c2");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let refused = rig.plans.start("ws", "c2", ChatVendor::Claude, "", &[]).unwrap_err();
        assert_eq!(refused, "Two AIs are planning \"Import c1\" now. Try again when they finish.");
        let context = ChatContext { title: "x".into(), notes: String::new(), project_dir: None, plan: None, pull_request: None };
        let chat = rig.chats.send(&rig.env.app, &rig.env.pty, "ws", "c1", context.clone(), "hello", &[]).unwrap_err();
        assert_eq!(chat, chat::PLANNING_NOW);
        assert_eq!(rig.chats.reservation().map(|r| r.1).as_deref(), Some("c1"));
        rig.plans.stop("ws", "c1").unwrap();
        wait_status(&rig, "c1", ExchangeStatus::Paused);
        // c2's Chat answers (slow): Start there waits for it.
        rig.chats.open("ws", "c2", ChatVendor::Claude).unwrap();
        rig.chats.send(&rig.env.app, &rig.env.pty, "ws", "c2", context, "SLOW hello", &[]).unwrap();
        wait_for("c2's chat answering", || rig.chats.chat_answering("ws", "c2"));
        assert_eq!(rig.plans.start("ws", "c2", ChatVendor::Claude, "", &[]).unwrap_err(), CHAT_FIRST);
    }

    /// Quit: the running exchange is saved `paused{quit}` before its
    /// sessions end, no process is left, and the next read says so.
    #[test]
    fn quit_saves_the_exchange_paused_and_leaves_no_process() {
        let rig = rig((true, true));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_for("the slow turn", || log(&rig).contains("msg["));
        rig.plans.interrupt_active();
        rig.chats.kill_all();
        for pid in pids(&rig, "claude") {
            assert!(gone(pid), "no orphan after quit");
        }
        std::thread::sleep(Duration::from_millis(300));
        let disk: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(rig.config.join("projects/ws/cards/c1/plan.json")).unwrap()).unwrap();
        let exchange = &disk["exchanges"][0];
        assert_eq!(exchange["status"], "paused");
        assert_eq!(exchange["pause"]["kind"], "quit");
        assert_eq!(exchange["pause"]["reason"], "Plyloft quit while Claude was writing the plan.");
        assert!(exchange["turns"][0]["outcome"].is_null(), "not marked failed");
        assert!(rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).is_err(), "nothing starts after quit");
    }

    /// After a relaunch nothing is loaded: the open cards are read from
    /// every card's `plan.json` — a waiting, a paused (a quit) and no
    /// finished one — and a change after is seen from memory.
    #[test]
    fn the_open_cards_are_read_from_disk_after_a_relaunch() {
        let rig = rig((true, true));
        for id in ["c1", "c2", "c3"] {
            card(&rig, id);
        }
        let save = |card: &str, status: ExchangeStatus| {
            let mut e = super::exchange(ChatVendor::Claude, ChatVendor::Codex);
            e.id = format!("ex-{card}");
            e.status = status;
            e.rounds_done = 1;
            let file = PlanFile { version: plan_store::PLAN_SCHEMA_VERSION, exchanges: vec![e] };
            plan_store::save(&rig.config.join(format!("projects/ws/cards/{card}/plan.json")), &file).unwrap();
        };
        save("c1", ExchangeStatus::AwaitingMember);
        // Saved running by a Plyloft that died: read as paused{quit}.
        save("c2", ExchangeStatus::Running);
        save("c3", ExchangeStatus::Accepted);
        let open = rig.plans.open_cards();
        let seen: Vec<(&str, ExchangeStatus)> = open.iter().map(|o| (o.card_id.as_str(), o.status)).collect();
        assert_eq!(seen, vec![("c1", ExchangeStatus::AwaitingMember), ("c2", ExchangeStatus::Paused)]);
        assert_eq!(open[1].pause.as_ref().map(|p| p.kind), Some(PauseKind::Quit));
        assert_eq!(open[0].exchange_id, "ex-c1");
        rig.plans.discard("ws", "c1").unwrap();
        let after: Vec<String> = rig.plans.open_cards().into_iter().map(|o| o.card_id).collect();
        assert_eq!(after, vec!["c2".to_string()], "a discard is seen without reading the disk again");
    }

    /// A deleted card takes its plans with it: the sessions end, `plan.json`
    /// and the `plan-*` folders go, and nothing is written afterwards.
    #[test]
    fn a_deleted_card_takes_its_exchange_and_writes_nothing_after() {
        let rig = rig((true, true));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        let started = rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let id = started.current.unwrap().id;
        wait_for("the slow turn", || log(&rig).contains("msg["));
        let card_dir = rig.config.join("projects/ws/cards/c1");
        let plan_dir = rig.chats.plan_dir("ws", "c1", &id).unwrap();
        assert!(card_dir.join("plan.json").is_file() && plan_dir.is_dir());
        rig.plans.forget_card("ws", "c1");
        rig.chats.forget_card("ws", "c1");
        for pid in pids(&rig, "claude") {
            assert!(gone(pid));
        }
        std::thread::sleep(Duration::from_millis(500));
        assert!(!card_dir.exists(), "plan.json and chat.json gone");
        assert!(!plan_dir.exists(), "the plan-* folder gone");
        assert!(rig.chats.reservation().is_none());
    }

    /// A card archived during an exchange pauses before its next turn; Retry
    /// and Accept are refused while it stays archived.
    #[test]
    fn an_archived_card_pauses_before_the_next_turn() {
        let rig = rig((true, true));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_for("the slow turn", || log(&rig).contains("msg["));
        rig.kanban.archive_card("ws", "c1", false).unwrap();
        std::fs::remove_file(rig.root.path().join("slow")).unwrap();
        // The turn under way can't finish (the fake waits for Esc): stop it.
        rig.plans.stop("ws", "c1").unwrap();
        wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert!(rig.plans.retry("ws", "c1").unwrap_err().contains("archived"));
        assert!(rig.plans.accept("ws", "c1", Some("mine")).unwrap_err().contains("archived"));
    }

    /// A fresh Claude session (its transcript gone before a resume) gets the
    /// re-seed in place of the retry, with the ask, the latest plan and
    /// critique, recorded `reseed`.
    #[test]
    fn a_claude_session_back_fresh_gets_the_re_seed() {
        let rig = rig((true, false));
        card(&rig, "c1");
        rig.plans.start("ws", "c1", ChatVendor::Claude, "Mind the CSV.", &[]).unwrap();
        wait_for("the critique answered", || {
            rig.plans.latest("ws", "c1").is_some_and(|e| e.turns.len() == 3 && e.turns[1].outcome == Some(TurnOutcome::Answered))
        });
        // The revision runs slow; stop it there.
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        wait_for("the revision under way", || log(&rig).matches("msg[").count() >= 3);
        std::thread::sleep(Duration::from_millis(300));
        rig.plans.stop("ws", "c1").unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert_eq!(paused.pause.unwrap().reason, "You stopped Claude's revision.");
        std::fs::remove_file(rig.root.path().join("slow")).unwrap();
        // The proposer's session ends and its transcript goes.
        let proposer = ChatKey::plan("ws", "c1", &paused.id, PlanRole::Proposer);
        rig.chats.plan_end(&proposer);
        let sid = paused.proposer_conversation.as_ref().unwrap().session_id.clone().unwrap();
        std::fs::remove_file(crate::claude_session::find_transcript(&rig.claude_config, &sid).unwrap()).unwrap();
        rig.plans.retry("ws", "c1").unwrap();
        let done = wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        assert_eq!(done.turns[2].sent, SentKind::Reseed);
        let sent = user_texts(&done.proposer_conversation);
        let reseed = sent.iter().find(|t| t.contains("Plyloft restarted")).expect("the re-seed was sent");
        assert!(reseed.contains("Mind the CSV") && reseed.contains("----- plan -----") && reseed.contains("----- critique -----"));
        assert!(!sent.iter().any(|t| t == RETRY_TEXT), "no retry to a session that lost its context");
        assert_ne!(done.proposer_conversation.as_ref().unwrap().session_id.as_deref(), Some(sid.as_str()), "a new session id");
        assert!(done.proposer_conversation.unwrap().messages.iter().any(|m| m.role == "notice" && m.text.contains("Claude started a new session")));
    }

    /// The same for Codex: `thread/resume` fails into `thread/start`, and
    /// the re-seed goes in place of the retry.
    #[test]
    fn a_codex_session_back_fresh_gets_the_re_seed() {
        let rig = rig((true, true));
        card(&rig, "c1");
        rig.plans.start("ws", "c1", ChatVendor::Claude, "Mind the CSV.", &[]).unwrap();
        // Stop at the critique (Codex slow), after Claude's plan.
        std::fs::write(rig.root.path().join("codex-slow"), "").unwrap();
        wait_for("the critique under way", || rig.plans.latest("ws", "c1").is_some_and(|e| e.turns.len() == 2 && e.turns[1].sent_message_id.is_some()));
        std::thread::sleep(Duration::from_millis(300));
        rig.plans.stop("ws", "c1").unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert_eq!(paused.pause.unwrap().reason, "You stopped Codex's critique.");
        std::fs::remove_file(rig.root.path().join("codex-slow")).unwrap();
        // Codex comes back with no thread: re-seeded on Retry.
        wait_for("Codex's thread", || std::fs::read_dir(rig.root.path().join("threads")).is_ok_and(|mut d| d.next().is_some()));
        for entry in std::fs::read_dir(rig.root.path().join("threads")).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        let critic = ChatKey::plan("ws", "c1", &paused.id, PlanRole::Critic);
        rig.chats.plan_end(&critic);
        rig.plans.retry("ws", "c1").unwrap();
        wait_for("the re-seeded critique", || rig.plans.latest("ws", "c1").is_some_and(|e| e.turns.len() > 2));
        let after = rig.plans.latest("ws", "c1").unwrap();
        assert_eq!(after.turns[1].sent, SentKind::Reseed);
        let critic_texts = user_texts(&after.critic_conversation);
        let reseed = critic_texts.last().unwrap();
        assert!(reseed.contains("Plyloft restarted this conversation") && reseed.contains("Mind the CSV") && reseed.contains("----- plan -----"), "{reseed}");
        assert!(after.critic_conversation.unwrap().messages.iter().any(|m| m.role == "notice" && m.text.contains("Codex started a new session")));
        wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
    }

    /// The view-only terminal: a plan lane's PTY is known as such (the IPC
    /// refuses it), while the driver's own pastes reached it.
    #[test]
    fn a_plan_lane_s_terminal_is_view_only_for_the_ipc_only() {
        let rig = rig((true, false));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        let id = rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap().current.unwrap().id;
        wait_for("the slow turn", || log(&rig).contains("msg["));
        let view = rig.chats.lane_view(&ChatKey::plan("ws", "c1", &id, PlanRole::Proposer)).unwrap();
        let pty_id = view.pty_id.unwrap();
        assert!(rig.chats.is_plan_pty(&pty_id), "the IPC pty_write / resize / kill refuse it");
        assert!(log(&rig).contains("msg[ Write the plan"), "the driver's paste reached it");
        assert!(rig.env.pty.write(&pty_id, b"").is_ok(), "the registry's own write path is open to Plyloft");
        assert!(!rig.chats.is_plan_pty("not-a-pty"));
        // The running exchange's lanes are never swept, even past the idle limit.
        rig.chats.sweep_idle();
        assert!(rig.chats.lane_view(&ChatKey::plan("ws", "c1", &id, PlanRole::Proposer)).unwrap().live);
    }

    /// Another round goes up to three, then is refused; its note reaches
    /// both sides.
    #[test]
    fn another_round_runs_once_more_with_the_note_and_three_is_the_most() {
        let rig = rig((true, true));
        card(&rig, "c1");
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_status(&rig, "c1", ExchangeStatus::AwaitingMember);
        rig.plans.more("ws", "c1", Some("Mind the encoding.")).unwrap();
        let done = wait_for_turns(&rig, 7);
        assert_eq!(done.rounds_done, 3);
        assert!(user_texts(&done.critic_conversation).last().unwrap().starts_with("The member adds: Mind the encoding."));
        assert!(user_texts(&done.proposer_conversation).last().unwrap().contains("The member adds: Mind the encoding."));
        assert_eq!(rig.plans.more("ws", "c1", None).unwrap_err(), "Three rounds is the most.");
    }

    /// A run's end (the member's turn, a pause) is one step: whoever reads
    /// the exchange waiting or paused never finds the run still set or its
    /// slots still held, so Another round and Retry pressed that moment go
    /// through (the VM's race, e3c3f359).
    #[test]
    fn a_run_s_end_never_shows_waiting_or_paused_with_the_run_or_its_slots_held() {
        let rig = rig((true, true));
        card(&rig, "c1");
        let sample = |until: ExchangeStatus| {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let (status, running, reserved) = rig.plans.run_view("ws", "c1").unwrap();
                if status != ExchangeStatus::Running {
                    assert!(!running && !reserved, "{status:?} with the run set {running}, its slots held {reserved}");
                }
                if status == until {
                    return;
                }
                assert!(Instant::now() < deadline, "no {until:?}: {status:?}");
                std::thread::yield_now();
            }
        };
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        sample(ExchangeStatus::AwaitingMember);
        rig.plans.more("ws", "c1", None).expect("Another round, the moment the rounds ended");
        sample(ExchangeStatus::AwaitingMember);
        // A pause (Stop) ends the run the same way, and Retry goes at once.
        rig.plans.discard("ws", "c1").unwrap();
        std::fs::write(rig.root.path().join("slow"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_for("the slow turn", || log(&rig).contains("msg["));
        rig.plans.stop("ws", "c1").unwrap();
        sample(ExchangeStatus::Paused);
        rig.plans.retry("ws", "c1").expect("Retry, the moment it paused");
    }

    fn wait_for_turns(rig: &Rig, turns: usize) -> Exchange {
        wait_for("the turns", || {
            rig.plans.latest("ws", "c1").is_some_and(|e| e.turns.len() == turns && e.status == ExchangeStatus::AwaitingMember)
        });
        rig.plans.latest("ws", "c1").unwrap()
    }

    /// Claude's trust question pauses the exchange, and nothing is written
    /// to the PTY.
    #[test]
    fn the_trust_question_pauses_and_is_never_answered() {
        let rig = rig_with(chat::ChatLimits { trust_confirm: Duration::from_millis(500), ..limits() }, (true, false));
        install_fake(rig.root.path(), &rig.log, "fake-claude", FAKE_CLAUDE_TRUST);
        card(&rig, "c1");
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert_eq!(paused.pause.as_ref().unwrap().kind, PauseKind::Trust);
        let typed = std::fs::read_to_string(rig.log.with_extension("log.typed")).unwrap_or_default();
        assert!(typed.is_empty(), "nothing was typed into the trust question: {typed:?}");
    }

    /// Challenger: a Retry's turn net counts from the Retry. A paused turn
    /// from long ago (a quit last week) whose receiver isn't at its prompt
    /// waits for it, never times out at once.
    #[test]
    fn a_retry_counts_the_turn_s_net_from_the_retry() {
        let rig = rig((true, true));
        card(&rig, "c1");
        let mut old = super::exchange(ChatVendor::Claude, ChatVendor::Codex);
        old.status = ExchangeStatus::Paused;
        old.pause = Some(Pause { kind: PauseKind::Quit, reason: "Plyloft quit while Claude was writing the plan.".into() });
        old.proposer_conversation = Some(Conversation::new(ChatVendor::Claude, 1));
        old.critic_conversation = Some(Conversation::new(ChatVendor::Codex, 1));
        old.turns.push(Turn {
            n: 0,
            round: 0,
            role: TurnRole::Propose,
            vendor: ChatVendor::Claude,
            sent: SentKind::Full,
            sent_message_id: None,
            answer_message_id: None,
            answer: None,
            verdict: None,
            started_at: 1,
            ended_at: None,
            outcome: None,
        });
        let file = plan_store::PlanFile { version: plan_store::PLAN_SCHEMA_VERSION, exchanges: vec![old] };
        plan_store::save(&rig.config.join("projects/ws/cards/c1/plan.json"), &file).unwrap();
        *rig.env.refuse_send.lock() =
            Some("Claude isn't at its prompt right now (its screen shows something else); nothing was sent.".into());
        rig.plans.retry("ws", "c1").unwrap();
        wait_for("the wait for the prompt", || rig.plans.snapshot("ws", "c1").is_ok_and(|s| s.waiting_for_prompt));
        std::thread::sleep(Duration::from_millis(500));
        let (status, pause) = rig.plans.status_of("ws", "c1").unwrap();
        assert_eq!(status, ExchangeStatus::Running, "still waiting, not timed out: {pause:?}");
        rig.plans.stop("ws", "c1").unwrap();
        wait_status(&rig, "c1", ExchangeStatus::Paused);
    }

    /// Challenger: a turn that sits Ready but never reaches a relay point (a
    /// settled Claude whose composer never comes back idle) is held by the
    /// turn's net like a running one, and pauses.
    #[test]
    fn a_settled_turn_that_never_reaches_a_relay_point_is_held_by_the_net() {
        let rig = rig_full(
            limits(),
            (true, false),
            PlanLimits { turn_net: Duration::from_secs(3), poll: Duration::from_millis(40), prompt_retry: Duration::from_millis(200) },
        );
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("noend"), "").unwrap();
        std::fs::write(rig.root.path().join("stuckfooter"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        let pause = paused.pause.unwrap();
        assert_eq!(pause.kind, PauseKind::Timeout, "{}", pause.reason);
        assert!(pause.reason.contains("took more than"), "{}", pause.reason);
        assert!(rig.chats.reservation().is_none(), "the slots went back");
    }

    /// Challenger: a Claude that waits on a screen of its own (a menu, a
    /// survey) while the other side answers isn't waited on for the turn's
    /// 20 minutes when its turn comes: its session ends, and the exchange
    /// pauses at once, with nothing typed into the menu.
    #[test]
    fn a_receiver_waiting_on_its_own_screen_pauses_the_exchange_at_once() {
        let rig = rig((true, true));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("codex-delay"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        // Claude's plan is relayed; while Codex critiques, Claude's screen
        // shows a menu.
        wait_for("the critique under way", || {
            rig.plans.latest("ws", "c1").is_some_and(|e| e.turns.len() == 2 && e.turns[0].outcome == Some(TurnOutcome::Answered))
        });
        std::fs::write(rig.root.path().join("menu"), "").unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        let pause = paused.pause.unwrap();
        assert_eq!(pause.kind, PauseKind::Screen, "{}", pause.reason);
        assert_eq!(paused.turns.len(), 3, "the revision never went");
        assert_eq!(log(&rig).matches("msg[").count(), 1, "nothing pasted into the menu");
    }

    /// Challenger: a card whose build starts under a running exchange (a
    /// GitHub board's reconcile moves it, a Builder is recorded) pauses
    /// before its next turn; Retry and Accept are refused.
    #[test]
    fn a_card_that_left_to_do_pauses_before_the_next_turn() {
        let rig = rig_with(chat::ChatLimits { stuck_turn: Duration::from_secs(3), ..limits() }, (true, false));
        card(&rig, "c1");
        std::fs::write(rig.root.path().join("noend"), "").unwrap();
        rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap();
        wait_for("the first answer", || {
            rig.plans
                .latest("ws", "c1")
                .and_then(|e| e.proposer_conversation)
                .is_some_and(|c| c.messages.iter().any(|m| m.role == "assistant" && m.text.starts_with("## Goal")))
        });
        rig.kanban
            .patch_card(
                "ws",
                "c1",
                crate::kanban::CardPatch { column_id: Some(KanbanColumnId::InProgress), ..Default::default() },
                None,
            )
            .unwrap();
        let paused = wait_status(&rig, "c1", ExchangeStatus::Paused);
        assert_eq!(paused.pause.as_ref().unwrap().reason, BUILD_LEFT);
        assert_eq!(log(&rig).matches("----- plan -----").count(), 0, "no critique was sent");
        assert_eq!(rig.plans.retry("ws", "c1").unwrap_err(), crate::kanban::TWO_AI_BUILD_STARTED);
        assert!(rig.chats.reservation().is_none());
    }

    /// The offer rule's backend half: a card past To do, an archived card
    /// and a card with no ready vendor are refused; Free reads no gate.
    #[test]
    fn start_is_refused_off_the_offer_rule_and_with_no_vendor_ready() {
        let rig = rig((false, false));
        card(&rig, "c1");
        assert!(rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap_err().contains("Claude Code or Codex"));
        *rig.env.ready.lock() = (true, true);
        rig.kanban.archive_card("ws", "c1", false).unwrap();
        assert!(rig.plans.start("ws", "c1", ChatVendor::Claude, "", &[]).unwrap_err().contains("archived"));
        let mut started = KanbanCard::new("c2".into(), "ws".into(), "Built".into(), None, KanbanColumnId::InProgress);
        started.column_id = KanbanColumnId::InProgress;
        rig.kanban.create_card("ws", started).unwrap();
        assert!(rig.plans.start("ws", "c2", ChatVendor::Claude, "", &[]).unwrap_err().contains("hasn't been built"));
        assert!(rig.chats.reservation().is_none(), "a refused Start reserves nothing");
    }

    /// Challenger on a pull request: a pull request's card is never planned
    /// by two AIs — even one sitting in To do with no Builder record.
    #[test]
    fn a_pull_request_card_is_never_offered_a_plan_with_two_ais() {
        let rig = rig((true, true));
        let view = serde_json::json!({
            "number": 12, "title": "Add the retry", "url": "https://github.com/o/r/pull/12",
            "state": "OPEN", "author": { "login": "octo" }, "body": "",
            "baseRefName": "main", "headRefName": "retry", "headRefOid": "1111111111111111111111111111111111111111",
            "isCrossRepository": false,
        })
        .to_string();
        let facts = crate::pr_review::parse_pr_view(&view).unwrap();
        let mut pr = KanbanCard::new("c3".into(), "ws".into(), "Review".into(), None, KanbanColumnId::Todo);
        pr.pr_review = Some(crate::pr_review::new_review(&facts, "o/r", &facts.head_sha, true, None, 1));
        rig.kanban.create_card("ws", pr).unwrap();
        assert_eq!(rig.plans.start("ws", "c3", ChatVendor::Claude, "", &[]).unwrap_err(), PR_CARD_REFUSAL);
        assert!(rig.chats.reservation().is_none(), "a refused Start reserves nothing");
    }
}
