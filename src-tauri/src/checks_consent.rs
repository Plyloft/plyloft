//! 1.175.0 B2 (review SEC-4): this computer's OK for the two shared values
//! that run here with nobody watching — "Checks before shipping"
//! (`verifyPipeline`) and "After a release, run" (`installScript`).
//!
//! They are fields of the shared workspace definition, read live: a
//! teammate's change reached every computer's config at its next refresh and
//! ran at the next Finish and check or release. The setup command
//! (`worktreeSetup`, SL-4) and Try it's start command already ask per
//! computer; these two now do too, with the same rule.
//!
//! **The rule.** `worktree_setup.json` keeps what this computer allowed:
//! `approvedVerify` (a hash of the normalized pipeline, a Claude step's
//! arguments included, beside a readable copy for "Allowed on this Mac") and
//! `approvedInstall` (the script's path; its content is the repository's
//! code, as before). A value that reached this computer from the branch and
//! differs from what it allowed does not run: Finish and check leaves the
//! card with a [`ChecksHold`] ("The checks need your OK", one button,
//! *Allow and run*), a release finishes and its install step waits
//! ([`InstallWaiting`]).
//!
//! **What counts as allowed.**
//! - A change made on this computer (Settings, through
//!   `workspace_definition::edit_shared` or a page's Publish) allows itself.
//! - *Allow and run* allows the value the person was shown, and nothing
//!   newer ([`approve_checks`], [`approve_install`]).
//! - Neither field recorded yet (a `worktree_setup.json` from before
//!   1.175.0, or a project that never took a value from the branch): what
//!   this computer runs is its own or was in use before the update, so it
//!   runs. The record begins the first time a refresh brings a different
//!   value ([`before_repository_apply`]): the value in use until then is
//!   written down as the allowed one, and the new one asks. A new clone has
//!   nothing in use, so its first run asks.
//! - A project whose setup was never shared has no record, and never asks.
//!   Round 2 (G4): once a record exists it is enforced whatever the shared
//!   file says later — losing its project part, or being removed (another
//!   lane's *Stop sharing*, which should **keep** the record: the values
//!   this computer then holds as its own are still the ones it allowed, and
//!   a change made here allows itself).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::project_config::{ProjectConfig, ProjectConfigStore, VerifyKind};
use crate::worktree_setup::{load_settings, save_settings};

/// The frontend re-reads [`view`] on this (payload: the workspace id).
pub const CHANGED_EVENT: &str = "checks-consent://changed";

/// Allow and run on a value that is no longer the one that was shown.
pub const CHECKS_CHANGED_SINCE: &str =
    "The checks changed since you looked. Look at them again before allowing them.";
pub const INSTALL_CHANGED_SINCE: &str =
    "The install step changed since you looked. Look at it again before allowing it.";
/// The OK couldn't be written (`SettingConflictHost`'s sentence).
pub const NOT_RECORDED: &str = "Plyloft couldn\u{2019}t record your choice. Try again in a moment.";

/// One step of the checks, as the card lists it: a script's path, or a
/// Claude command ("/ppvp" and its arguments).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckStep {
    /// It starts a Claude session in the card's copy.
    #[serde(default)]
    pub claude: bool,
    /// The script's path, or the command's name with its slash.
    pub text: String,
    /// A Claude command's arguments, joined as they are sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
}

/// The checks this computer allowed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedVerify {
    /// [`pipeline_hash`] of the allowed pipeline.
    pub hash: String,
    /// Its steps in words, for "Allowed on this Mac". Empty: none allowed yet.
    #[serde(default)]
    pub steps: Vec<CheckStep>,
}

/// The install step this computer allowed: a path, or none yet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedInstall {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Who changed a value that now waits for this computer's OK, and when this
/// computer read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNote {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub who: Option<String>,
    pub at: i64,
}

/// A release that finished while its install step wasn't allowed here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallWaiting {
    /// The release's tag; none for a card shipped by a merge on this computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub at: i64,
}

/// On a card: its checks were asked for and didn't run, because this
/// computer hasn't allowed them. Cleared when a run of them starts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksHold {
    pub at: i64,
}

/// Round 2 (G5): read a record of an OK. Absent or `null`: none. Present
/// and not a record (a hand-edited or damaged file): **the record that
/// matches nothing** (`Default`: an empty hash, no path), which asks —
/// never "nothing recorded", which on an unshared project means allowed.
pub fn record_or_asks<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_value(value).unwrap_or_default()))
}

fn now_millis() -> i64 {
    crate::worktree_setup::now_millis()
}

// ── The values, normalized ──────────────────────────────────────────────

/// The pipeline a Finish and check would run: none when absent or empty.
pub fn pipeline_of(config: Option<&ProjectConfig>) -> Vec<VerifyKind> {
    config.and_then(|c| c.verify_pipeline.clone()).unwrap_or_default()
}

/// The install script a release would run: trimmed, none when empty.
pub fn install_of(config: Option<&ProjectConfig>) -> Option<String> {
    normalize_install(config.and_then(|c| c.install_script.as_deref()))
}

fn normalize_install(path: Option<&str>) -> Option<String> {
    path.map(str::trim).filter(|p| !p.is_empty()).map(str::to_string)
}

/// A Claude command's name as the runner sends it: one slash, trimmed.
fn slash_name(name: &str) -> String {
    format!("/{}", name.trim().trim_start_matches('/'))
}

/// The arguments the runner sends (it drops empty ones).
fn sent_args(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).filter(|a| !a.is_empty()).collect()
}

pub fn steps_of(pipeline: &[VerifyKind]) -> Vec<CheckStep> {
    pipeline
        .iter()
        .map(|step| match step {
            VerifyKind::Script { path } => CheckStep { claude: false, text: path.trim().to_string(), args: None },
            VerifyKind::SlashCommand { name, args } => {
                let args = sent_args(args);
                CheckStep {
                    claude: true,
                    text: slash_name(name),
                    args: (!args.is_empty()).then(|| args.join(" ")),
                }
            }
        })
        .collect()
}

/// A hash of what would run, a Claude command's arguments included (they
/// are the prompt of a session nobody watches). Two pipelines that run the
/// same things hash the same: a path's surrounding spaces, a command's
/// leading slash and empty arguments don't count.
pub fn pipeline_hash(pipeline: &[VerifyKind]) -> String {
    // Round 2 (G5): every field goes in with its length before it, so no
    // two pipelines share an encoding (a separator inside a path or an
    // argument can't be read as the end of one field and the start of another).
    fn field(hasher: &mut Sha256, bytes: &[u8]) {
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    let mut hasher = Sha256::new();
    hasher.update(b"plyloft-checks-v2");
    hasher.update((pipeline.len() as u64).to_be_bytes());
    for step in pipeline {
        match step {
            VerifyKind::Script { path } => {
                hasher.update([0u8]);
                field(&mut hasher, path.trim().as_bytes());
            }
            VerifyKind::SlashCommand { name, args } => {
                hasher.update([1u8]);
                field(&mut hasher, slash_name(name).as_bytes());
                let args = sent_args(args);
                hasher.update((args.len() as u64).to_be_bytes());
                for arg in args {
                    field(&mut hasher, arg.as_bytes());
                }
            }
        }
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn approved_of(pipeline: &[VerifyKind]) -> ApprovedVerify {
    ApprovedVerify { hash: pipeline_hash(pipeline), steps: steps_of(pipeline) }
}

/// The project's setup is shared: its values can come from the branch.
fn shared(store: &ProjectConfigStore, workspace_id: &str) -> bool {
    crate::workspace_definition::load_cache(store, workspace_id)
        .and_then(|cache| cache.definition)
        .is_some_and(|definition| definition.has_project())
}

// ── The gate ────────────────────────────────────────────────────────────

/// Round 2 (G4): **a record, once it exists, is enforced whatever the
/// shared file says now.** Round 1 asked only while the project's setup was
/// shared; a teammate could push changed checks (held), then push the shared
/// file without its project part: nothing is applied, this computer's config
/// keeps the value nobody allowed, "shared" turns false, and the gate was
/// off. What runs must equal what was allowed, or it asks.
///
/// Round 2 (G5): **no record on a shared project asks.** A refresh writes
/// the record down the first time it reads a shared setup
/// ([`before_repository_apply`]), so "no record" on a shared project means
/// no refresh has run on this build yet, or the record was lost: the first
/// run asks rather than run a value nobody here was shown. A project that
/// was never shared has no record and never asks.
fn checks_allowed_with(shared: bool, approved: Option<&ApprovedVerify>, pipeline: &[VerifyKind]) -> bool {
    if pipeline.is_empty() {
        return true;
    }
    match approved {
        Some(approved) => approved.hash == pipeline_hash(pipeline),
        None => !shared,
    }
}

fn install_allowed_with(shared: bool, approved: Option<&ApprovedInstall>, script: Option<&str>) -> bool {
    let Some(script) = normalize_install(script) else { return true };
    match approved {
        Some(approved) => approved.path.as_deref().map(str::trim) == Some(script.as_str()),
        None => !shared,
    }
}

/// The workspace's checks may run on this computer without asking.
pub fn checks_allowed(store: &ProjectConfigStore, workspace_id: &str) -> bool {
    checks_allowed_for(store, workspace_id, &pipeline_of(store.get(workspace_id).as_ref()))
}

/// Round 2 (G5): the same for **the pipeline a run is about to execute** —
/// the snapshot the caller holds, so what is checked is what runs (the store
/// can change between the two reads).
pub fn checks_allowed_for(store: &ProjectConfigStore, workspace_id: &str, pipeline: &[VerifyKind]) -> bool {
    let settings = load_settings(store, workspace_id);
    checks_allowed_with(shared(store, workspace_id), settings.approved_verify.as_ref(), pipeline)
}

/// The workspace's install step may run on this computer without asking.
pub fn install_allowed(store: &ProjectConfigStore, workspace_id: &str) -> bool {
    install_allowed_for(store, workspace_id, install_of(store.get(workspace_id).as_ref()).as_deref())
}

/// [`install_allowed`] for the script a release is about to start.
pub fn install_allowed_for(store: &ProjectConfigStore, workspace_id: &str, script: Option<&str>) -> bool {
    let settings = load_settings(store, workspace_id);
    install_allowed_with(shared(store, workspace_id), settings.approved_install.as_ref(), script)
}

/// A release is done and its install step is next: true when it must wait
/// for this computer's OK. The release is then remembered as waiting
/// ([`InstallWaiting`]); nothing is started. A project with no install step,
/// or an allowed one, is never held.
pub fn hold_install(store: &ProjectConfigStore, workspace_id: &str, tag: Option<&str>) -> bool {
    hold_install_of(store, workspace_id, tag, install_of(store.get(workspace_id).as_ref()).as_deref())
}

/// Round 2 (G5): [`hold_install`] for **the script the caller is about to
/// start** (its own snapshot of the config), so the path that is checked is
/// the path that runs.
pub fn hold_install_of(store: &ProjectConfigStore, workspace_id: &str, tag: Option<&str>, script: Option<&str>) -> bool {
    if install_allowed_for(store, workspace_id, script) {
        return false;
    }
    let mut settings = load_settings(store, workspace_id);
    settings.install_waiting = Some(InstallWaiting { tag: tag.map(str::to_string), at: now_millis() });
    if let Err(e) = save_settings(store, workspace_id, &settings) {
        // Held all the same: an install nobody allowed never starts.
        log::warn!("checks_consent: couldn't remember {workspace_id}'s waiting install step: {e}");
    }
    true
}

/// Why a release's own checks can't start here, or `None` when they may.
pub fn release_checks_refusal(store: &ProjectConfigStore, workspace_id: &str, pipeline: &[VerifyKind]) -> Option<String> {
    (!checks_allowed_for(store, workspace_id, pipeline)).then(|| {
        format!(
            "The release's checks couldn't start: this repository's checks changed and need your OK on {}. \
             Press Finish and check on a card, then Allow and run. Nothing was pushed.",
            crate::platform::THIS_MACHINE
        )
    })
}

// ── What moves the record ───────────────────────────────────────────────

/// A refresh is about to write the repository's values (`changed`, field
/// keys) over this computer's. The first time one of the two fields changes
/// that way, the value in use until now is written down as the allowed one —
/// it ran here before, or is this computer's own — so the update to 1.175.0
/// asks nothing and the new value does. Who changed it is kept for the
/// card's sentence (`author`, and when its commit was made; nobody on a
/// first read, which follows no edit).
pub fn before_repository_apply(
    store: &ProjectConfigStore,
    workspace_id: &str,
    local: Option<&ProjectConfig>,
    changed: &[&str],
    author: Option<&str>,
    changed_at_secs: Option<i64>,
    first_read: bool,
    shared_project: bool,
) -> Result<(), String> {
    let (verify, install) = (changed.contains(&"verifyPipeline"), changed.contains(&"installScript"));
    if !verify && !install && !shared_project {
        return Ok(());
    }
    let before = load_settings(store, workspace_id);
    let mut settings = before.clone();
    // When the commit that brought it was made; else when this computer read it.
    let at = changed_at_secs.map(|secs| secs.saturating_mul(1000)).unwrap_or_else(now_millis);
    let note = ChangeNote { who: author.filter(|_| !first_read).map(str::to_string), at };
    // Round 2 (G5): the record begins at the first refresh of a shared
    // setup, changed or not. On a computer that already followed it (the
    // update to 1.175.0: a value already in its cache is "what ran until
    // then"), with what it runs. On a first read (a new clone, or a setup
    // adopted now) with what it ran before the read when that differs from
    // the repository's — and with **nothing** when it is the same: a value
    // that merely equals what this computer detected was never shown to
    // anyone here as the repository's, so its first run asks.
    let nothing_ran = first_read;
    if settings.approved_verify.is_none() {
        let was = if nothing_ran && !verify { Vec::new() } else { pipeline_of(local) };
        settings.approved_verify = Some(approved_of(&was));
    }
    if settings.approved_install.is_none() {
        settings.approved_install = Some(ApprovedInstall { path: if nothing_ran && !install { None } else { install_of(local) } });
    }
    if verify {
        settings.verify_changed = Some(note.clone());
    }
    if install {
        settings.install_changed = Some(note);
    }
    if settings == before {
        return Ok(());
    }
    save_settings(store, workspace_id, &settings)
}

/// What this computer runs now, taken before a local edit so the edit's own
/// changes can be told from the rest ([`approve_own_edit`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InUse {
    pipeline: Vec<VerifyKind>,
    install: Option<String>,
}

pub fn in_use(store: &ProjectConfigStore, workspace_id: &str) -> InUse {
    let config = store.get(workspace_id);
    InUse { pipeline: pipeline_of(config.as_ref()), install: install_of(config.as_ref()) }
}

/// A change made on this computer allows itself: whichever of the two
/// values differs from `before` is now the allowed one. Best effort — a
/// write that fails leaves the edit asking once, never running unasked.
pub fn approve_own_edit(store: &ProjectConfigStore, workspace_id: &str, before: &InUse) {
    let now = in_use(store, workspace_id);
    approve_own(store, workspace_id, now.pipeline != before.pipeline, now.install != before.install);
}

/// [`in_use`] from the app's store, for `workspace_definition::edit_shared`.
pub fn in_use_of<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) -> Option<InUse> {
    use tauri::Manager;
    app.try_state::<ProjectConfigStore>().map(|store| in_use(&store, workspace_id))
}

/// [`approve_own_edit`] once a local edit was recorded — unless it was put
/// back (a read-only member's edit, refused with "ask for write access"):
/// an edit that didn't stand allows nothing.
pub fn approve_own_after<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    before: Option<&InUse>,
    refused: Option<&String>,
) {
    use tauri::Manager;
    if refused.is_some_and(|e| e.contains("ask for write access")) {
        return;
    }
    if let (Some(store), Some(before)) = (app.try_state::<ProjectConfigStore>(), before) {
        approve_own_edit(&store, workspace_id, before);
        emit_changed(app, workspace_id);
    }
}

/// [`approve_own_edit`] for an edit whose changed fields are known (a
/// page's Publish): the value now in this computer's config is allowed.
pub fn approve_own(store: &ProjectConfigStore, workspace_id: &str, verify: bool, install: bool) {
    if !verify && !install {
        return;
    }
    let config = store.get(workspace_id);
    let mut settings = load_settings(store, workspace_id);
    if verify {
        settings.approved_verify = Some(approved_of(&pipeline_of(config.as_ref())));
        settings.verify_changed = None;
    }
    if install {
        settings.approved_install = Some(ApprovedInstall { path: install_of(config.as_ref()) });
        settings.install_changed = None;
        settings.install_waiting = None;
    }
    if let Err(e) = save_settings(store, workspace_id, &settings) {
        log::warn!("checks_consent: couldn't record {workspace_id}'s own change as allowed: {e}");
    }
}

/// Which of the two fields a page's draft changed from its base.
pub fn edited_fields(
    base: &serde_json::Map<String, serde_json::Value>,
    draft: &serde_json::Map<String, serde_json::Value>,
) -> (bool, bool) {
    let differs = |key: &str| base.get(key) != draft.get(key);
    (differs("verifyPipeline"), differs("installScript"))
}

/// *Allow and run* on the checks: only while they are still the ones the
/// person was shown (`shown_hash`), so an OK never lands on a newer value.
pub fn approve_checks(store: &ProjectConfigStore, workspace_id: &str, shown_hash: &str) -> Result<(), String> {
    let pipeline = pipeline_of(store.get(workspace_id).as_ref());
    if pipeline_hash(&pipeline) != shown_hash {
        return Err(CHECKS_CHANGED_SINCE.to_string());
    }
    let mut settings = load_settings(store, workspace_id);
    settings.approved_verify = Some(approved_of(&pipeline));
    settings.verify_changed = None;
    save_settings(store, workspace_id, &settings).map_err(|e| {
        log::warn!("checks_consent: approve_checks({workspace_id}): {e}");
        NOT_RECORDED.to_string()
    })
}

/// *Allow and run* on the install step: only while its path is the one shown.
/// Returns the release that was waiting for it, if one was.
pub fn approve_install(
    store: &ProjectConfigStore,
    workspace_id: &str,
    shown_path: &str,
) -> Result<Option<InstallWaiting>, String> {
    let script = install_of(store.get(workspace_id).as_ref());
    if script.as_deref() != Some(shown_path.trim()) || shown_path.trim().is_empty() {
        return Err(INSTALL_CHANGED_SINCE.to_string());
    }
    let mut settings = load_settings(store, workspace_id);
    let waiting = settings.install_waiting.take();
    settings.approved_install = Some(ApprovedInstall { path: script });
    settings.install_changed = None;
    save_settings(store, workspace_id, &settings).map_err(|e| {
        log::warn!("checks_consent: approve_install({workspace_id}): {e}");
        NOT_RECORDED.to_string()
    })?;
    Ok(waiting)
}

// ── What the window reads ───────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksView {
    /// The checks don't run on this computer until allowed.
    pub needs_ok: bool,
    /// Nothing was allowed here before: one list, "haven't run on this Mac".
    pub first_time: bool,
    pub approved: Vec<CheckStep>,
    pub current: Vec<CheckStep>,
    /// [`pipeline_hash`] of `current`, handed back by *Allow and run*.
    pub hash: String,
    pub who: Option<String>,
    pub changed_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallView {
    pub needs_ok: bool,
    /// Round 2 (G5): nothing was allowed here before — nobody "changed" it.
    pub first_time: bool,
    pub approved: Option<String>,
    pub current: Option<String>,
    pub who: Option<String>,
    pub changed_at: Option<i64>,
    /// A release finished and its install step waits for the OK.
    pub waiting: Option<InstallWaiting>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentView {
    pub checks: ChecksView,
    pub install: InstallView,
}

pub fn view(store: &ProjectConfigStore, workspace_id: &str) -> ConsentView {
    let settings = load_settings(store, workspace_id);
    let config = store.get(workspace_id);
    let shared = shared(store, workspace_id);
    let pipeline = pipeline_of(config.as_ref());
    let script = install_of(config.as_ref());
    let checks_ok = checks_allowed_with(shared, settings.approved_verify.as_ref(), &pipeline);
    let install_ok = install_allowed_with(shared, settings.approved_install.as_ref(), script.as_deref());
    let approved_steps = settings.approved_verify.as_ref().map(|a| a.steps.clone()).unwrap_or_default();
    let approved_path = settings.approved_install.as_ref().and_then(|a| a.path.clone());
    ConsentView {
        checks: ChecksView {
            needs_ok: !checks_ok,
            first_time: approved_steps.is_empty(),
            approved: approved_steps,
            current: steps_of(&pipeline),
            hash: pipeline_hash(&pipeline),
            who: settings.verify_changed.as_ref().filter(|_| !checks_ok).and_then(|n| n.who.clone()),
            changed_at: settings.verify_changed.as_ref().filter(|_| !checks_ok).map(|n| n.at),
        },
        install: InstallView {
            needs_ok: !install_ok,
            first_time: approved_path.is_none(),
            approved: approved_path,
            current: script,
            who: settings.install_changed.as_ref().filter(|_| !install_ok).and_then(|n| n.who.clone()),
            changed_at: settings.install_changed.as_ref().filter(|_| !install_ok).map(|n| n.at),
            // A waiting release is said only while its step still needs the OK.
            waiting: settings.install_waiting.clone().filter(|_| !install_ok),
        },
    }
}

fn emit_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, workspace_id: &str) {
    use tauri::Emitter;
    let _ = app.emit(CHANGED_EVENT, workspace_id);
}

// ── Commands ────────────────────────────────────────────────────────────

/// What this computer allowed and what the repository has now, for the
/// card's Now, the install sheet and the two Settings rows.
///
/// A card marked as waiting for the checks' OK when they no longer need one
/// (a teammate put the allowed checks back) loses the mark here: nothing
/// runs by itself, the card just stops saying it waits. Round 3: except the
/// builds of a card built by both, whose checks never wait for a press.
#[tauri::command]
pub fn checks_consent_view(
    app: tauri::AppHandle,
    store: tauri::State<'_, ProjectConfigStore>,
    kanban: tauri::State<'_, crate::kanban::KanbanStore>,
    workspace_id: String,
) -> ConsentView {
    let view = view(&store, &workspace_id);
    if !view.checks.needs_ok {
        let released = release_stale_holds(&kanban, &workspace_id);
        // Round 3: a card built by both keeps "waiting" on its builds, where
        // nothing offers Allow and run once the mark is gone and the
        // comparison would wait for ever. Their checks are the allowed ones
        // again, and a build's checks always start by themselves: they start.
        let waiting = kanban.load(&workspace_id).map(|cards| crate::build_both::cards_with_waiting_lanes(&cards));
        let restarted: usize = waiting
            .unwrap_or_default()
            .iter()
            .map(|id| crate::build_both::restart_waiting_lanes(&app, &workspace_id, id))
            .sum();
        if released > 0 || restarted > 0 {
            crate::kanban::emit_kanban_changed(&app, &workspace_id);
        }
    }
    // The same for a release remembered as waiting for an install step that
    // no longer needs an OK: its Inbox row goes.
    if !view.install.needs_ok {
        forget_stale_waiting(&store, &workspace_id);
    }
    view
}

pub(crate) fn forget_stale_waiting(store: &ProjectConfigStore, workspace_id: &str) {
    let mut settings = load_settings(store, workspace_id);
    if settings.install_waiting.take().is_some() {
        if let Err(e) = save_settings(store, workspace_id, &settings) {
            log::warn!("checks_consent: couldn't forget {workspace_id}'s waiting install step: {e}");
        }
    }
}

/// Take `checks_hold` off every card of the workspace; how many had it.
pub(crate) fn release_stale_holds(kanban: &crate::kanban::KanbanStore, workspace_id: &str) -> usize {
    let held: Vec<String> = kanban
        .load(workspace_id)
        .map(|cards| cards.into_iter().filter(|c| c.checks_hold.is_some()).map(|c| c.id).collect())
        .unwrap_or_default();
    held.iter()
        .filter(|id| {
            kanban
                .with_card(workspace_id, id, |card| {
                    card.checks_hold = None;
                    Ok(())
                })
                .is_ok()
        })
        .count()
}

/// **Allow and run** on a card: the checks the person was shown are allowed
/// on this computer from now on, then they run on every card of the
/// workspace that was waiting for them (this one first).
#[tauri::command]
pub async fn checks_allow_and_run(
    app: tauri::AppHandle,
    workspace_id: String,
    card_id: String,
    hash: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        crate::drain::guard_dispatch(&app.state::<crate::drain::DrainCoordinator>(), "verify")?;
        approve_checks(&app.state::<ProjectConfigStore>(), &workspace_id, &hash)?;
        emit_changed(&app, &workspace_id);
        let kanban = app.state::<crate::kanban::KanbanStore>();
        let mut waiting: Vec<String> = kanban
            .load(&workspace_id)
            .map(|cards| cards.into_iter().filter(|c| c.checks_hold.is_some() && !c.archived).map(|c| c.id).collect())
            .unwrap_or_default();
        waiting.retain(|id| *id != card_id);
        waiting.insert(0, card_id.clone());
        let mut first = Ok(());
        for id in waiting {
            // Round 2 (G5): a card built by both — its waiting builds'
            // checks start again, not a check of the card itself.
            if crate::build_both::restart_waiting_lanes(&app, &workspace_id, &id) > 0 {
                let _ = kanban.with_card(&workspace_id, &id, |card| {
                    card.checks_hold = None;
                    Ok(())
                });
                crate::kanban::emit_kanban_changed(&app, &workspace_id);
                continue;
            }
            let started = app.state::<crate::card_execution::CardExecutionGate>().enqueue_verify(
                app.clone(),
                &app.state::<crate::verify::VerifyRegistry>(),
                &kanban,
                &app.state::<crate::workspace::WorkspaceStore>(),
                &app.state::<crate::agents::AgentRegistry>(),
                &app.state::<crate::swarms::SwarmRegistry>(),
                crate::verify::VerifyRequest { workspace_id: workspace_id.clone(), card_id: id.clone(), post_outcome_issue: false },
            );
            match started {
                Ok(_) => {}
                Err(e) if id == card_id => first = Err(e),
                Err(e) => log::warn!("checks_consent: {id}: allowed, but its checks didn't start: {e}"),
            }
        }
        first
    })
    .await
    .map_err(|e| format!("allow-and-run worker failed: {e}"))?
}

/// **Allow and run** on the install step: the path the person was shown is
/// allowed on this computer from now on, and the step runs for the release
/// that was waiting. Returns what started, in words.
#[tauri::command]
pub async fn install_allow_and_run(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let store = app.state::<ProjectConfigStore>();
        let waiting = approve_install(&store, &workspace_id, &path)?;
        emit_changed(&app, &workspace_id);
        let workspaces = app.state::<crate::workspace::WorkspaceStore>();
        match waiting.as_ref().and_then(|w| w.tag.as_deref()) {
            // A release: its own guard (this computer's target is at the tag).
            Some(tag) => crate::ship::run_release_install(&app.state::<crate::ship::ShipRegistry>(), &workspaces, &store, &workspace_id, tag),
            // A card shipped by a merge here, or nothing waiting: the script itself.
            None => {
                let snap = workspaces.snapshot();
                let ws = snap
                    .workspaces
                    .iter()
                    .find(|w| w.id == workspace_id)
                    .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
                let root = crate::ship::resolve_workspace_repo_root(&ws.cwd)?;
                crate::ship::spawn_install_script(&root, path.trim())?;
                Ok(format!("The install step started in the background ({}).", path.trim()))
            }
        }
    })
    .await
    .map_err(|e| format!("install worker failed: {e}"))?
}

#[cfg(test)]
#[path = "checks_consent_tests.rs"]
mod tests;
