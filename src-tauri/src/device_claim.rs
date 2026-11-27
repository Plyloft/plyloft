//! 1.173.0 (C2): which computer took a card on a GitHub Issues board.
//!
//! The claim itself stays the issue's assignee (a GitHub login, GH #66). With
//! the same login on two Macs, that says nothing about *which* Mac builds the
//! card, so the claim also writes a hidden marker into the issue body:
//!
//! ```text
//! <!-- plyloft:claim device=<id> name="Mac mini" login=<login> at=<iso> -->
//! ```
//!
//! `device` is this computer's id *for that repository* (16 hex of
//! sha256(uuid, repo), [`repo_device_id`]), never the uuid; `name` is the
//! computer's Mac model, or its platform's word — never its own name
//! ([`shared_device_name`], through `account::model_label`, 1.175.0). Only a claim
//! ([`claim_on_issue`]), a take-over and a release ([`release_on_issue`])
//! change the marker; every body Plyloft rebuilds copies the one GitHub has
//! now ([`rebuilt_body`]).
//!
//! (AGENTS.md, Product boundaries, "Copies, areas and claims", owner
//! 2026-10-30.) The marker sits on a line of its own; writing, moving or
//! removing it leaves every other byte of the body as it was, the
//! `atelier:notes` / `atelier:knowledge` blocks included. Only a marker that
//! starts a line outside those blocks counts, the last one being live. It is
//! never part of the card's notes or of the issue text kept outside the
//! blocks (`github::parse_issue_body` leaves it out of `raw_remainder`).
//!
//! This computer's identity — a uuid and its name (ComputerName on a Mac,
//! `%COMPUTERNAME%` on Windows) — is kept in the local settings
//! (`settings.device`, [`crate::settings::SettingsStore::ensure_device`]) and
//! published here once at startup ([`set_this_device`]).

use serde::{Deserialize, Serialize};

const OPEN: &str = "<!-- plyloft:claim ";
const CLOSE: &str = "-->";

/// The marker read from an issue body, as a card keeps it (`gh_claim`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceClaim {
    /// The claiming computer's id (`settings.device.id`).
    pub device: String,
    /// Its name as the person sees it ("Mac mini"), quoted as it is.
    #[serde(default)]
    pub name: String,
    /// The GitHub login it claimed as; a different login is someone else's
    /// computer, and then the assignee decides, as before 1.173.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
    /// When it was taken (RFC 3339, UTC).
    #[serde(default)]
    pub at: String,
}

/// This computer, as the settings keep it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThisDevice {
    pub id: String,
    pub name: String,
}

static THIS_DEVICE: std::sync::RwLock<Option<ThisDevice>> = std::sync::RwLock::new(None);

#[cfg(test)]
thread_local! {
    static TEST_DEVICE: std::cell::RefCell<Option<ThisDevice>> = const { std::cell::RefCell::new(None) };
}

/// Publish this computer's identity (startup, and after its name changed).
pub fn set_this_device(device: ThisDevice) {
    if let Ok(mut slot) = THIS_DEVICE.write() {
        *slot = Some(device);
    }
}

/// This computer's identity; `None` before startup published it (and in a
/// test that set none), when nothing is written or removed.
pub fn this_device() -> Option<ThisDevice> {
    #[cfg(test)]
    {
        TEST_DEVICE.with(|d| d.borrow().clone())
    }
    #[cfg(not(test))]
    {
        THIS_DEVICE.read().ok().and_then(|d| d.clone())
    }
}

/// Tests: this thread's computer (`None`: unknown).
#[cfg(test)]
pub(crate) fn set_test_device(device: Option<ThisDevice>) {
    TEST_DEVICE.with(|d| *d.borrow_mut() = device);
}

/// 1.174.0 (E12, CH-5): the longest a read of this computer's name or
/// hardware id may take. A `scutil`, `ioreg` or `reg` that hangs is killed
/// then (and on app exit, through `worktrees::run_bounded`'s registry), and
/// the read gives nothing — so the settings keep what they had.
pub const READ_LIMIT: std::time::Duration = std::time::Duration::from_secs(2);

/// `cmd`'s stdout, trimmed, or `None` when it failed or took longer than
/// `limit`.
#[cfg_attr(not(any(target_os = "macos", windows, test)), allow(dead_code))]
fn read_bounded(cmd: &mut std::process::Command, label: &str, limit: std::time::Duration) -> Option<String> {
    match crate::worktrees::run_bounded(cmd, label, limit) {
        Ok(out) => Some(out),
        Err(e) => {
            log::warn!("device: {e}");
            None
        }
    }
}

/// 1.174.0 (E12, CH-5): this computer's identity, off the main thread, so a
/// slow `scutil`/`ioreg`/`reg` never holds the window back. Until it lands
/// [`this_device`] is `None` and the claim marker writes and removes
/// nothing. `ensure` is the store's [`crate::settings::SettingsStore::ensure_device`]
/// call; a test passes its own.
pub fn identify_in_background(ensure: impl FnOnce() + Send + 'static) -> std::io::Result<std::thread::JoinHandle<()>> {
    identify_with(&IDENTITY, ensure)
}

/// The identity thread's end, for [`identify_in_background`] and its test.
pub(crate) fn identify_with(
    settle: &'static Settle,
    ensure: impl FnOnce() + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let spawned = std::thread::Builder::new().name("device-identity".into()).spawn(move || {
        // Released when the thread ends, whatever happened in it (a panic too).
        let _released = Released(settle);
        ensure();
    });
    if spawned.is_err() {
        settle.release();
    }
    spawned
}

/// 1.174.0 (E12 round 1): the longest a claim waits for the identity at
/// startup — both reads at their limit, and a second for the save.
pub const WAIT_LIMIT: std::time::Duration =
    std::time::Duration::from_secs(2 * READ_LIMIT.as_secs() + 1);

/// Whether the identity thread has ended (or startup gave up on it).
pub(crate) struct Settle {
    done: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

impl Settle {
    pub(crate) const fn new() -> Self {
        Self { done: std::sync::Mutex::new(false), cv: std::sync::Condvar::new() }
    }

    pub(crate) fn release(&self) {
        if let Ok(mut done) = self.done.lock() {
            *done = true;
        }
        self.cv.notify_all();
    }

    /// Wait at most `limit` for the release; true when it came. A wait that
    /// runs out releases it, so a stuck thread delays one claim, not each.
    pub(crate) fn wait(&self, limit: std::time::Duration) -> bool {
        let Ok(done) = self.done.lock() else { return false };
        let Ok((mut done, _)) = self.cv.wait_timeout_while(done, limit, |d| !*d) else { return false };
        let came = *done;
        *done = true;
        came
    }
}

struct Released(&'static Settle);

impl Drop for Released {
    fn drop(&mut self) {
        self.0.release();
    }
}

static IDENTITY: Settle = Settle::new();

/// 1.174.0 (E12 round 1): this computer's identity, waiting at most `limit`
/// for the startup thread that reads it — so a claim made in the first
/// seconds after launch is still this computer's.
#[cfg_attr(test, allow(dead_code))]
pub fn wait_this_device(limit: std::time::Duration) -> Option<ThisDevice> {
    IDENTITY.wait(limit);
    this_device()
}

/// The identity a claim acts on: waited for outside tests (a test sets its
/// own with [`set_test_device`]).
fn claim_device() -> Option<ThisDevice> {
    #[cfg(test)]
    {
        this_device()
    }
    #[cfg(not(test))]
    {
        wait_this_device(WAIT_LIMIT)
    }
}

/// This computer's name as the person sees it: `scutil --get ComputerName`
/// on a Mac, `%COMPUTERNAME%` on Windows. Empty when it can't be read (or
/// took longer than [`READ_LIMIT`]); the settings then keep the name read
/// before ([`crate::settings::device_name_or`]).
pub fn read_computer_name() -> String {
    #[cfg(target_os = "macos")]
    {
        read_bounded(
            crate::platform::new_command("/usr/sbin/scutil").args(["--get", "ComputerName"]),
            "scutil --get ComputerName",
            READ_LIMIT,
        )
        .unwrap_or_default()
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").map(|n| n.trim().to_string()).unwrap_or_default()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        String::new()
    }
}

/// The name this computer goes by on a shared issue:
/// [`crate::account::shared_name_of`] — `PLYLOFT_DEVICE_NAME` when set, else
/// the model `raw` contains or the platform's word, the same name C3's
/// shared-config commits carry — cleaned for the marker.
pub fn shared_device_name(raw: &str) -> String {
    clean_name(&crate::account::shared_name_of(raw))
}

/// A fingerprint of this computer's hardware, hashed: `IOPlatformUUID`
/// (`ioreg`) on a Mac, `MachineGuid` on Windows. When it changes under a kept
/// id (Migration Assistant, a restored backup), the id is made again, so two
/// computers never share one. Empty when it can't be read, or took longer
/// than [`READ_LIMIT`] (then the id stays).
pub fn read_hardware_id() -> String {
    #[cfg(target_os = "macos")]
    let raw = read_bounded(
        crate::platform::new_command("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]),
        "ioreg IOPlatformExpertDevice",
        READ_LIMIT,
    )
    .and_then(|out| value_after(&out, "\"IOPlatformUUID\""));
    #[cfg(windows)]
    let raw = read_bounded(
        crate::platform::new_command("reg").args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"]),
        "reg query MachineGuid",
        READ_LIMIT,
    )
    .and_then(|out| value_after(&out, "MachineGuid"));
    #[cfg(not(any(target_os = "macos", windows)))]
    let raw: Option<String> = None;
    raw.map(|r| hashed(&r, 32)).unwrap_or_default()
}

/// The value on the line naming `key`: `"IOPlatformUUID" = "ABC-…"` and
/// `    MachineGuid    REG_SZ    abc-…` alike.
pub(crate) fn value_after(text: &str, key: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains(key))?;
    let rest = &line[line.find(key)? + key.len()..];
    let rest = rest.trim().trim_start_matches('=').trim();
    let rest = rest.strip_prefix("REG_SZ").unwrap_or(rest).trim();
    let value = rest.trim_matches('"').trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn hashed(text: &str, hex_len: usize) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..hex_len].to_string()
}

/// The id a marker in `repo` carries for the computer `uuid`: never the
/// uuid itself, so one repository's issues can't be matched with
/// another's (16 hex of sha256(uuid, repo)).
pub fn repo_device_id(uuid: &str, repo: &str) -> String {
    hashed(&format!("{uuid}\n{}", repo.trim().to_ascii_lowercase()), 16)
}

/// This computer's id in `repo`'s markers; `None` while unknown.
pub fn this_id_for(repo: &str) -> Option<String> {
    claim_device().map(|d| repo_device_id(&d.id, repo))
}

/// A name that fits inside the quoted attribute and the HTML comment: no
/// quote, no angle bracket, no line break, no `--`. Trimmed; empty stays empty.
pub fn clean_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '"' => '\'',
            '<' | '>' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A bare attribute value (device, login, at): no whitespace, quote or `>`.
fn clean_token(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '"' | '<' | '>'))
        .collect::<String>()
        .replace("--", "-")
}

/// The marker's text, without a line break.
pub fn marker(claim: &DeviceClaim) -> String {
    let mut out = format!(
        "{OPEN}device={} name=\"{}\"",
        clean_token(&claim.device),
        clean_name(&claim.name)
    );
    if let Some(login) = claim.login.as_deref().map(clean_token).filter(|l| !l.is_empty()) {
        out.push_str(&format!(" login={login}"));
    }
    out.push_str(&format!(" at={} {CLOSE}", clean_token(&claim.at)));
    out
}

/// The byte ranges of the notes and knowledge blocks, where a marker is text.
fn block_ranges(body: &str) -> Vec<std::ops::Range<usize>> {
    use crate::github::{KNOWLEDGE_CLOSE, KNOWLEDGE_OPEN, NOTES_CLOSE, NOTES_OPEN};
    let mut out = Vec::new();
    for (open, close) in [(NOTES_OPEN, NOTES_CLOSE), (KNOWLEDGE_OPEN, KNOWLEDGE_CLOSE)] {
        if let Some(s) = body.find(open) {
            if let Some(e) = body[s..].find(close) {
                out.push(s..s + e + close.len());
            }
        }
    }
    out
}

/// Every marker in `body`: one that starts a line, outside the notes and
/// knowledge blocks, in order. The last is the live one.
fn markers(body: &str) -> Vec<std::ops::Range<usize>> {
    let blocks = block_ranges(body);
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = body[from..].find(OPEN) {
        let start = from + found;
        let Some(close) = body[start + OPEN.len()..].find(CLOSE) else { break };
        let end = start + OPEN.len() + close + CLOSE.len();
        let line_start = start == 0 || body[..start].ends_with('\n');
        if line_start && !blocks.iter().any(|b| b.contains(&start)) {
            out.push(start..end);
        }
        from = end;
    }
    out
}

/// The claim in `body`: its last readable marker (one with a device).
pub fn parse(body: &str) -> Option<DeviceClaim> {
    let range = markers(body).pop()?;
    let inner = &body[range.start + OPEN.len()..range.end - CLOSE.len()];
    let mut claim = DeviceClaim { device: String::new(), name: String::new(), login: None, at: String::new() };
    let mut rest = inner.trim_start();
    while !rest.is_empty() {
        let Some(eq) = rest.find('=') else { break };
        let key = rest[..eq].trim();
        let after = &rest[eq + 1..];
        let (value, next) = if let Some(quoted) = after.strip_prefix('"') {
            match quoted.find('"') {
                Some(q) => (&quoted[..q], &quoted[q + 1..]),
                None => (quoted, ""),
            }
        } else {
            match after.find(char::is_whitespace) {
                Some(w) => (&after[..w], &after[w..]),
                None => (after, ""),
            }
        };
        match key {
            "device" => claim.device = value.to_string(),
            "name" => claim.name = value.to_string(),
            "login" => claim.login = Some(value.to_string()).filter(|l| !l.is_empty()),
            "at" => claim.at = value.to_string(),
            _ => {}
        }
        rest = next.trim_start();
    }
    (!claim.device.is_empty()).then_some(claim)
}

/// `body` with the marker at `range` and the one line break that set it
/// apart taken out.
fn cut(body: &str, range: std::ops::Range<usize>) -> String {
    let (before, after) = (&body[..range.start], &body[range.end..]);
    if let Some(rest) = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n')) {
        return format!("{before}{rest}");
    }
    let before = before
        .strip_suffix("\r\n")
        .or_else(|| before.strip_suffix('\n'))
        .unwrap_or(before);
    format!("{before}{after}")
}

/// `body` with every marker taken out — the inverse of adding one
/// ([`with_claim`]).
pub fn without_marker(body: &str) -> String {
    let mut out = body.to_string();
    for range in markers(body).into_iter().rev() {
        out = cut(&out, range);
    }
    out
}

/// `body` carrying exactly `claim` (or no marker, with `None`). The live
/// marker is rewritten where it is and any others are taken out; a new one
/// goes on its own line at the end. Nothing else in the body changes.
pub fn with_claim(body: &str, claim: Option<&DeviceClaim>) -> String {
    let Some(claim) = claim else {
        return without_marker(body);
    };
    let text = marker(claim);
    let mut found = markers(body);
    if let Some(live) = found.pop() {
        let mut out = format!("{}{text}{}", &body[..live.start], &body[live.end..]);
        for range in found.into_iter().rev() {
            out = cut(&out, range);
        }
        return out;
    }
    if body.is_empty() {
        text
    } else if body.ends_with('\n') {
        format!("{body}{text}\n")
    } else {
        format!("{body}\n{text}")
    }
}

/// 1.175.0 (D2, TM-6): the card's copy of the repository is on this
/// computer — it records one. The marker says where the copy and its
/// commits are, not whether a session is open.
pub fn has_copy(card: &crate::kanban::KanbanCard) -> bool {
    card.worktree_path.as_deref().is_some_and(|p| !p.trim().is_empty())
}

/// D2 (TM-6): this computer's marker stays on `card`'s issue — the card
/// isn't Done or archived and its copy is here. Closing its session or
/// moving it back to Ready to start leaves the copy, so the marker stays;
/// it goes with the copy (Done, Archive, Delete, a copy deleted or put in
/// the Trash after the merge).
pub fn copy_is_here(card: &crate::kanban::KanbanCard) -> bool {
    !card.archived && card.column_id != crate::kanban::KanbanColumnId::Complete && has_copy(card)
}

/// Where a card that moved leaves this computer's marker behind: Done, and
/// Ready to start once its copy isn't here. A card In progress keeps it (a
/// start writes the marker before the copy exists).
fn left_on_move(card: &crate::kanban::KanbanCard) -> bool {
    use crate::kanban::KanbanColumnId;
    match card.column_id {
        KanbanColumnId::Complete => true,
        KanbanColumnId::Todo => !has_copy(card),
        _ => false,
    }
}

/// The marker a body rebuilt for `card` carries: the one GitHub has now
/// (`live`) — a rebuild never moves a claim — except this computer's own on
/// a card that left it behind ([`left_on_move`]), which goes in the same
/// write.
pub fn kept_on_rebuild(card: &crate::kanban::KanbanCard, live: Option<DeviceClaim>, repo: &str) -> Option<DeviceClaim> {
    match live {
        Some(c) if left_on_move(card) && is_this_device(&c, repo) => None,
        other => other,
    }
}

/// The issue body Plyloft writes for a card — its notes and knowledge
/// blocks and the text kept from GitHub — carrying `claim`.
pub fn card_issue_body(card: &crate::kanban::KanbanCard, claim: Option<&DeviceClaim>) -> String {
    let body = crate::github::build_issue_body(
        card.notes.as_deref(),
        card.knowledge.as_deref(),
        card.gh_raw_remainder.as_deref(),
    );
    with_claim(&body, claim)
}

/// A rebuild of `card`'s issue body from the marker GitHub has now (read
/// live). Errs when the issue can't be read: then nothing is written (no
/// guessed marker) and the caller leaves the card to Sync. Returns the body
/// and the marker it carries, for the card to record after the write.
pub fn rebuilt_body(
    repo: &str,
    number: u64,
    card: &crate::kanban::KanbanCard,
) -> Result<(String, Option<DeviceClaim>), String> {
    let issue = crate::github::issue_view(repo, number)?;
    // 1.175.0 (B3): a marker in a text whose last hand was outside the
    // repository is not a claim, and isn't copied into the rebuilt body.
    let live = crate::issue_text::claim_in(&issue.body, crate::issue_text::card_written_outside(card));
    let claim = kept_on_rebuild(card, live, repo);
    Ok((card_issue_body(card, claim.as_ref()), claim))
}

/// Whether `claim` names this computer in `repo`.
pub fn is_this_device(claim: &DeviceClaim, repo: &str) -> bool {
    this_id_for(repo).is_some_and(|id| id == claim.device)
}

/// What a claim from this computer does to the marker an issue carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimHere {
    /// Write this computer's marker unless another computer's is there.
    IfFree,
    /// *Take it over here*: write it over another computer's.
    TakeOver,
}

/// This computer as a marker names it in one repository.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerSelf {
    pub id: String,
    pub name: String,
}

/// The marker a claim from `me` (as `login`) leaves, given the one the
/// issue carries; `None` when it stays as it is. Another computer's marker is
/// replaced only on [`ClaimHere::TakeOver`] (*Start here too* leaves it); this
/// computer's own is rewritten only when its name or login changed, keeping
/// when it was taken.
pub fn next_claim(
    current: Option<&DeviceClaim>,
    me: &MarkerSelf,
    login: &str,
    how: ClaimHere,
    now: &str,
) -> Option<DeviceClaim> {
    let mine = |at: &str| DeviceClaim {
        device: me.id.clone(),
        name: clean_name(&me.name),
        login: Some(login.to_string()).filter(|l| !l.is_empty()),
        at: at.to_string(),
    };
    match current {
        None => Some(mine(now)),
        Some(c) if c.device == me.id => {
            let wanted = mine(if c.at.is_empty() { now } else { &c.at });
            (wanted != *c).then_some(wanted)
        }
        Some(_) if how == ClaimHere::TakeOver => Some(mine(now)),
        Some(_) => None,
    }
}

/// This computer as `repo`'s markers name it.
pub fn marker_self(repo: &str) -> Option<MarkerSelf> {
    claim_device().map(|d| MarkerSelf { id: repo_device_id(&d.id, repo), name: shared_device_name(&d.name) })
}

/// Now, as a marker's `at`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Write this computer's marker into the issue `known` was read from, as
/// `login`. A write reads the issue again first and decides from what
/// GitHub has then, so an edit since `known` (another Mac's take-over) is
/// never written over blindly; the window left is that read to the write.
/// Returns the marker the issue carries afterwards. Without a known computer
/// it writes nothing and returns what `known` has.
///
/// 1.175.0 (B3): `from_outside` — the last hand on the issue's text was
/// outside the repository (`issue_text::card_written_outside`). A marker in
/// it is then no computer's claim: this computer's goes on in its place.
///
/// 1.175.0 (round 2, finding 7): a marker left by somebody who is no longer
/// among the issue's assignees gives way too ([`left_behind`]). Since D2 a
/// member who moves a card back comes off the issue while their copy, and
/// so their marker, stays; the teammate who then takes the card would never
/// get a marker of their own, and their second computer would not know.
/// The marker of somebody still assigned is never replaced this way, nor
/// this login's own on another computer (that asks: *Take it over here*).
pub fn claim_on_issue(
    repo: &str,
    known: &crate::github::GhIssue,
    login: &str,
    how: ClaimHere,
    from_outside: bool,
) -> Result<Option<DeviceClaim>, String> {
    // Round 4 (T1): the card is wanted here again, so a release that was
    // kept while its board was held (`release_card`) no longer goes out.
    crate::github::forget_held_release(repo, known.number);
    let read = |issue: &crate::github::GhIssue| crate::issue_text::claim_in(&issue.body, from_outside);
    // What counts as somebody's claim: not one its owner left behind.
    let standing = |issue: &crate::github::GhIssue| read(issue).filter(|c| !left_behind(c, login, issue));
    let Some(me) = marker_self(repo) else {
        return Ok(read(known));
    };
    let now = now_iso();
    if next_claim(standing(known).as_ref(), &me, login, how, &now).is_none() {
        return Ok(read(known));
    }
    let fresh = crate::github::issue_view(repo, known.number)?;
    match next_claim(standing(&fresh).as_ref(), &me, login, how, &now) {
        None => Ok(read(&fresh)),
        Some(next) => {
            crate::github::issue_edit_body(repo, fresh.number, &with_claim(&fresh.body, Some(&next)))?;
            Ok(Some(next))
        }
    }
}

/// Round 2 (finding 7): `claim` names a login that is neither the claimant's
/// (`login`) nor among the issue's assignees — its owner left the card. A
/// marker with no login (an older one) is never called left behind.
fn left_behind(claim: &DeviceClaim, login: &str, issue: &crate::github::GhIssue) -> bool {
    claim.login.as_deref().map(str::trim).filter(|l| !l.is_empty()).is_some_and(|owner| {
        !owner.eq_ignore_ascii_case(login)
            && !crate::github::assignee_logins(issue).iter().any(|a| a.eq_ignore_ascii_case(owner))
    })
}

/// Take this computer's marker out of issue `number` (Done, Archive, Delete,
/// a copy that went; 1.175.0 D2: no longer a closed session or a Move back
/// that keeps the copy), read live. Another computer's is left. Returns the
/// marker the issue carries afterwards.
pub fn release_on_issue(repo: &str, number: u64) -> Result<Option<DeviceClaim>, String> {
    let issue = crate::github::issue_view(repo, number)?;
    let current = parse(&issue.body);
    match &current {
        Some(c) if is_this_device(c, repo) => {
            crate::github::issue_edit_body(repo, number, &without_marker(&issue.body))?;
            Ok(None)
        }
        _ => Ok(current),
    }
}

/// [`release_on_issue`] for a card whose last-read marker names this
/// computer, recorded on the card. Best-effort: a failure is logged, and the
/// next claim from anywhere rewrites the marker anyway.
///
/// 1.175.0 (round 4, T1): refused because the card's board was opened from
/// its last saved copy and GitHub hasn't been read since, the release is
/// kept and sent after that read (`github_sync::send_held_writes`) — it is
/// asked once, so the refusal used to leave this computer's name on the
/// issue for good.
pub fn release_card(
    store: &crate::kanban::KanbanStore,
    repo: &str,
    workspace_id: &str,
    card: &crate::kanban::KanbanCard,
) {
    let (Some(number), Some(claim)) = (card.gh_issue_number, card.gh_claim.as_ref()) else {
        return;
    };
    if !is_this_device(claim, repo) {
        return;
    }
    match release_on_issue(repo, number) {
        Ok(after) => {
            if let Err(e) = store.set_gh_claim(workspace_id, &card.id, after, this_id_for(repo).as_deref()) {
                log::warn!("device claim: recording #{number}'s release failed: {e}");
            }
        }
        Err(e) if crate::github::is_held_refusal(&e) => {
            log::info!("device claim: releasing {repo}#{number} waits for the first read of its restored board");
            crate::github::queue_held_write(repo, crate::github::HeldWrite::ReleaseClaim { number });
        }
        Err(e) => log::warn!("device claim: releasing {repo}#{number} failed: {e}"),
    }
}

/// 1.173.0 (C2), 1.175.0 (D2): a card moved to Done, or to Ready to start
/// with no copy left here (a drag, Move back, Done), no longer says it is
/// being built on this computer.
pub fn release_on_move(store: &crate::kanban::KanbanStore, repo: &str, workspace_id: &str, card_id: &str) {
    if let Ok(card) = store.get_card(workspace_id, card_id) {
        if left_on_move(&card) {
            release_card(store, repo, workspace_id, &card);
        }
    }
}

/// D2 (TM-6): [`release_card`] unless the card's copy is still on this
/// computer ([`copy_is_here`]) — what *Close the Builder session* and Stop
/// during the start ask, and what a copy that went (deleted, or found
/// missing) asks.
pub fn release_unless_copy_here(
    store: &crate::kanban::KanbanStore,
    repo: &str,
    workspace_id: &str,
    card: &crate::kanban::KanbanCard,
) {
    if !copy_is_here(card) {
        release_card(store, repo, workspace_id, card);
    }
}

#[cfg(test)]
#[path = "device_claim_tests.rs"]
mod tests;
