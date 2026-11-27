//! A card's Plan with two AIs record: `<config>/projects/<ws>/cards/<card>/plan.json`,
//! beside `chat.json`, written atomically (Hard rule 3)
//! (`docs/plans/PLAN_WITH_TWO_AIS.md` §5).
//!
//! A file of its own, not a field of `chat.json`: an older Plyloft reads
//! `chat.json`, drops a field it doesn't know and writes the file back,
//! which would wipe every exchange; it never opens `plan.json`, so its chat
//! keeps working. The card's delete removes the card's whole folder, this
//! file with it.
//!
//! Schema `version` 1, `chat_store`'s rules: every field defaulted, a file
//! with no `version` reads as 1, a file from a newer Plyloft is read and
//! never written over. Every enum keeps an unknown value (`Other`), which
//! is shown and never started or resent.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::chat_store::{ChatVendor, Conversation};

pub(crate) const PLAN_SCHEMA_VERSION: u32 = 1;

/// The most exchanges a card keeps; the oldest go first, with their
/// session folders.
pub(crate) const MAX_EXCHANGES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExchangeStatus {
    Running,
    AwaitingMember,
    Paused,
    Accepted,
    Discarded,
    #[serde(other)]
    Other,
}

impl ExchangeStatus {
    /// Running or waiting for the member: the card's build waits (P1).
    pub(crate) fn open(self) -> bool {
        matches!(self, ExchangeStatus::Running | ExchangeStatus::AwaitingMember)
    }

    pub(crate) fn finished(self) -> bool {
        matches!(self, ExchangeStatus::Accepted | ExchangeStatus::Discarded | ExchangeStatus::Other)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PauseKind {
    Stopped,
    SignIn,
    UsageLimit,
    Trust,
    Screen,
    Failed,
    Quit,
    SessionEnded,
    Archived,
    Timeout,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pause {
    pub kind: PauseKind,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TurnRole {
    Propose,
    Critique,
    Revise,
    #[serde(other)]
    Other,
}

/// What a turn's last send was (§3 *Retry*).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SentKind {
    Full,
    Retry,
    Reseed,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Verdict {
    Ready,
    ChangesNeeded,
    /// The critique ended with no verdict line (read as "changes needed").
    None,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TurnOutcome {
    Answered,
    Interrupted,
    Failed,
    NoAnswer,
    Stopped,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Turn {
    pub n: u32,
    #[serde(default)]
    pub round: u32,
    pub role: TurnRole,
    pub vendor: ChatVendor,
    #[serde(default = "full")]
    pub sent: SentKind,
    #[serde(default)]
    pub sent_message_id: Option<String>,
    #[serde(default)]
    pub answer_message_id: Option<String>,
    /// The answer as relayed (the text after the turn's last tool call).
    #[serde(default)]
    pub answer: Option<String>,
    #[serde(default)]
    pub verdict: Option<Verdict>,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub outcome: Option<TurnOutcome>,
}

fn full() -> SentKind {
    SentKind::Full
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OutcomeKind {
    Accepted,
    Edited,
    Discarded,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub kind: OutcomeKind,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub at: i64,
}

/// One exchange: a proposer and a critic, by role (with one vendor ready,
/// both are that vendor, two sessions: Q5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Exchange {
    pub id: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    pub proposer: ChatVendor,
    pub critic: ChatVendor,
    #[serde(default)]
    pub ask: String,
    /// The chat attachments sent at Start.
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default = "two")]
    pub rounds_default: u32,
    #[serde(default = "three")]
    pub rounds_max: u32,
    /// Rounds run to their end (a revision, or a critique that said ready).
    #[serde(default)]
    pub rounds_done: u32,
    /// The rounds this run goes to before it waits for the member (the
    /// default, plus one for each Another round).
    #[serde(default = "two")]
    pub rounds_target: u32,
    /// The member's note for the round under way (Another round).
    #[serde(default)]
    pub note: Option<String>,
    pub status: ExchangeStatus,
    #[serde(default)]
    pub pause: Option<Pause>,
    #[serde(default)]
    pub turns: Vec<Turn>,
    #[serde(default)]
    pub proposer_conversation: Option<Conversation>,
    #[serde(default)]
    pub critic_conversation: Option<Conversation>,
    #[serde(default)]
    pub outcome: Option<Outcome>,
}

fn two() -> u32 {
    2
}

fn three() -> u32 {
    3
}

impl Exchange {
    /// The proposer's latest finished plan.
    pub(crate) fn latest_plan(&self) -> Option<&str> {
        self.turns
            .iter()
            .rev()
            .filter(|t| matches!(t.role, TurnRole::Propose | TurnRole::Revise))
            .filter(|t| t.outcome == Some(TurnOutcome::Answered))
            .find_map(|t| t.answer.as_deref())
    }

    /// The critic's latest finished critique.
    pub(crate) fn latest_critique(&self) -> Option<&str> {
        self.turns
            .iter()
            .rev()
            .filter(|t| t.role == TurnRole::Critique && t.outcome == Some(TurnOutcome::Answered))
            .find_map(|t| t.answer.as_deref())
    }

    /// Whether this Plyloft may start or resend anything for it: nothing
    /// unknown (a newer status, role, vendor or send kind) is ever resumed.
    pub(crate) fn known(&self) -> bool {
        self.status != ExchangeStatus::Other
            && self.proposer != ChatVendor::Other
            && self.critic != ChatVendor::Other
            && self.turns.iter().all(|t| t.role != TurnRole::Other && t.sent != SentKind::Other)
            && self.pause.as_ref().is_none_or(|p| p.kind != PauseKind::Other)
    }
}

/// `plan.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanFile {
    #[serde(default)]
    pub version: u32,
    /// Newest last.
    #[serde(default)]
    pub exchanges: Vec<Exchange>,
}

pub(crate) fn plan_path(card_dir: &Path) -> PathBuf {
    card_dir.join("plan.json")
}

/// Reads a card's `plan.json`: a missing file and a broken one each read
/// as no exchange (a broken one is logged, and written over only by a new
/// exchange). Returns whether it may be written back (false for a newer
/// version). A stored `running` reads as `paused{quit}`: no exchange runs
/// in a process that has just read its file (a crash, or a quit whose
/// cleanup didn't run).
pub(crate) fn load(path: &Path) -> (PlanFile, bool) {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("plan: read {}: {error}", path.display());
            }
            return (PlanFile { version: PLAN_SCHEMA_VERSION, ..Default::default() }, true);
        }
    };
    let mut file: PlanFile = match serde_json::from_str(&text) {
        Ok(file) => file,
        Err(error) => {
            log::warn!("plan: {} is not a plan record: {error}", path.display());
            return (PlanFile { version: PLAN_SCHEMA_VERSION, ..Default::default() }, true);
        }
    };
    if file.version > PLAN_SCHEMA_VERSION {
        return (file, false);
    }
    // v0 (no version) → v1: every field already defaulted.
    file.version = PLAN_SCHEMA_VERSION;
    for exchange in &mut file.exchanges {
        if exchange.status == ExchangeStatus::Running {
            exchange.status = ExchangeStatus::Paused;
            exchange.pause = Some(Pause { kind: PauseKind::Quit, reason: quit_reason(exchange) });
        }
    }
    (file, true)
}

/// "Plyloft quit while Codex was critiquing."
pub(crate) fn quit_reason(exchange: &Exchange) -> String {
    match exchange.turns.last() {
        Some(turn) if turn.outcome.is_none() => format!(
            "Plyloft quit while {} was {}.",
            turn.vendor.label(),
            match turn.role {
                TurnRole::Propose => "writing the plan",
                TurnRole::Critique => "critiquing",
                TurnRole::Revise => "revising the plan",
                TurnRole::Other => "answering",
            }
        ),
        _ => "Plyloft quit during this plan.".to_string(),
    }
}

/// Writes `file` atomically, as the current version.
pub(crate) fn save(path: &Path, file: &PlanFile) -> Result<(), String> {
    let mut file = file.clone();
    file.version = PLAN_SCHEMA_VERSION;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    crate::atomic::write_atomic_json(path, &file)
}

/// Keeps the newest [`MAX_EXCHANGES`]; returns the ids of those dropped,
/// whose session folders the caller removes.
pub(crate) fn cap(file: &mut PlanFile) -> Vec<String> {
    let mut dropped = Vec::new();
    while file.exchanges.len() > MAX_EXCHANGES {
        // Never the open one: the oldest finished or paused goes.
        let Some(index) = file.exchanges.iter().position(|e| !e.status.open()) else { break };
        dropped.push(file.exchanges.remove(index).id);
    }
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(id: &str, status: ExchangeStatus) -> Exchange {
        Exchange {
            id: id.into(),
            created_at: 0,
            updated_at: 0,
            proposer: ChatVendor::Claude,
            critic: ChatVendor::Codex,
            ask: String::new(),
            attachment_ids: vec![],
            rounds_default: 2,
            rounds_max: 3,
            rounds_done: 0,
            rounds_target: 2,
            note: None,
            status,
            pause: None,
            turns: vec![],
            proposer_conversation: None,
            critic_conversation: None,
            outcome: None,
        }
    }

    #[test]
    fn a_v0_file_reads_and_is_written_back_as_v1_and_a_running_one_reads_paused_quit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.json");
        std::fs::write(
            &path,
            r#"{"exchanges":[{"id":"e1","proposer":"claude","critic":"claude","status":"running",
                "turns":[{"n":0,"role":"critique","vendor":"claude"}],"someFutureField":1}]}"#,
        )
        .unwrap();
        let (file, writable) = load(&path);
        assert!(writable);
        assert_eq!(file.version, 1);
        let e = &file.exchanges[0];
        assert_eq!((e.rounds_default, e.rounds_max, e.rounds_target), (2, 3, 2));
        assert_eq!(e.status, ExchangeStatus::Paused, "a stored running reads as paused");
        assert_eq!(e.pause.as_ref().unwrap().kind, PauseKind::Quit);
        assert_eq!(e.pause.as_ref().unwrap().reason, "Plyloft quit while Claude was critiquing.");
        assert_eq!(e.turns[0].sent, SentKind::Full);
        save(&path, &file).unwrap();
        let disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(disk["version"], 1);
        assert_eq!(disk["exchanges"][0]["status"], "paused");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "atomic: no temp file left");
    }

    #[test]
    fn a_file_from_a_newer_plyloft_is_read_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.json");
        std::fs::write(&path, r#"{"version":4,"exchanges":[{"id":"e","proposer":"gemini","critic":"codex","status":"thinking"}]}"#)
            .unwrap();
        let (file, writable) = load(&path);
        assert!(!writable);
        assert_eq!(file.exchanges[0].proposer, ChatVendor::Other);
        assert_eq!(file.exchanges[0].status, ExchangeStatus::Other);
        assert!(!file.exchanges[0].known());
    }

    #[test]
    fn a_missing_file_and_a_broken_file_read_as_no_exchange() {
        let dir = tempfile::tempdir().unwrap();
        let (file, writable) = load(&dir.path().join("none.json"));
        assert!(writable && file.exchanges.is_empty());
        std::fs::write(dir.path().join("bad.json"), "{not json").unwrap();
        let (file, writable) = load(&dir.path().join("bad.json"));
        assert!(writable && file.exchanges.is_empty());
    }

    #[test]
    fn unknown_status_role_kind_and_sent_values_are_kept_and_never_resumed() {
        let raw = r#"{"version":1,"exchanges":[
            {"id":"a","proposer":"claude","critic":"codex","status":"paused","pause":{"kind":"meteor","reason":"x"}},
            {"id":"b","proposer":"claude","critic":"codex","status":"paused","turns":[{"n":0,"role":"summarise","vendor":"claude"}]},
            {"id":"c","proposer":"claude","critic":"codex","status":"paused","turns":[{"n":0,"role":"propose","vendor":"claude","sent":"teleport","verdict":"maybe","outcome":"vanished"}]},
            {"id":"d","proposer":"claude","critic":"codex","status":"paused"}]}"#;
        let file: PlanFile = serde_json::from_str(raw).unwrap();
        assert_eq!(file.exchanges[0].pause.as_ref().unwrap().kind, PauseKind::Other);
        assert_eq!(file.exchanges[1].turns[0].role, TurnRole::Other);
        let c = &file.exchanges[2].turns[0];
        assert_eq!((c.sent, c.verdict, c.outcome), (SentKind::Other, Some(Verdict::Other), Some(TurnOutcome::Other)));
        let known: Vec<bool> = file.exchanges.iter().map(Exchange::known).collect();
        assert_eq!(known, vec![false, false, false, true]);
    }

    #[test]
    fn the_cap_drops_the_oldest_finished_exchanges_never_the_open_one() {
        let mut file = PlanFile::default();
        file.exchanges.push(exchange("open", ExchangeStatus::AwaitingMember));
        for n in 0..MAX_EXCHANGES + 1 {
            file.exchanges.push(exchange(&format!("e{n}"), ExchangeStatus::Discarded));
        }
        let dropped = cap(&mut file);
        assert_eq!(dropped, vec!["e0".to_string(), "e1".to_string()]);
        assert_eq!(file.exchanges.len(), MAX_EXCHANGES);
        assert_eq!(file.exchanges[0].id, "open");
    }

    #[test]
    fn the_latest_plan_and_critique_are_the_last_answered_ones() {
        let mut e = exchange("e", ExchangeStatus::Running);
        let turn = |n, role, answer: Option<&str>, outcome| Turn {
            n,
            round: n,
            role,
            vendor: ChatVendor::Claude,
            sent: SentKind::Full,
            sent_message_id: None,
            answer_message_id: None,
            answer: answer.map(str::to_string),
            verdict: None,
            started_at: 0,
            ended_at: None,
            outcome,
        };
        e.turns.push(turn(0, TurnRole::Propose, Some("plan 1"), Some(TurnOutcome::Answered)));
        e.turns.push(turn(1, TurnRole::Critique, Some("crit 1"), Some(TurnOutcome::Answered)));
        e.turns.push(turn(2, TurnRole::Revise, Some("half"), Some(TurnOutcome::Stopped)));
        assert_eq!(e.latest_plan(), Some("plan 1"), "a stopped revision is never the plan");
        assert_eq!(e.latest_critique(), Some("crit 1"));
    }
}
